/**
 * IndexNow push pinger — notify Bing, Yandex, Seznam, Naver, Yep, and
 * DuckDuckGo the moment a post goes live, instead of waiting for them to
 * re-crawl the sitemap. One implementation, six engines.
 *
 *   IndexNow protocol:    https://www.indexnow.org/
 *   Per-engine submission via a single endpoint at api.indexnow.org.
 *
 * --- Key + key file ---
 *
 * IndexNow requires a shared secret ("key", 8-128 hex chars) to prove you
 * control the host. The key must be reachable as a plain-text file on the
 * same host as the URLs you submit:
 *
 *      https://blog.example.com/{key}.txt   →   {key}
 *
 * At our scale we use ONE key across the whole network (set via the
 * INDEXNOW_KEY env var). Each blog's key file is served by the per-platform
 * adapter — for WordPress, a tiny MU-plugin (see docs/indexnow/wp-mu-plugin.php);
 * for Shopify, see the deployment notes below.
 *
 * The keyLocation we submit per ping is the URL where THIS blog hosts the
 * key file — derived from the blog's externalPostUrl host.
 *
 * --- What this module does NOT do ---
 *
 * - Does NOT ping Google. Google does not support IndexNow. The Google path
 *   is the Search Console integration in src/lib/services/gsc-client.ts:
 *   sitemaps.submit runs once per property at onboarding (gsc-verifier.ts),
 *   and index coverage is read back per URL by gsc-index-coverage.ts. Google
 *   has no push-on-publish equivalent to IndexNow, so there is deliberately
 *   nothing to call from this module's publish path.
 * - Does NOT host the key file. That's per-platform deployment (MU-plugin
 *   on WP, Page/redirect on Shopify).
 * - Does NOT batch across multiple URLs. We submit one URL per publish; the
 *   batch endpoint is overkill for ~21 publishes/hour spread across 4 shards.
 */

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/**
 * Default path component for the key file (so we don't hardcode it inside
 * the URL derivation). Operators can override per-site via the MU-plugin's
 * `netgrid_indexnow_key_path` option if they prefer a custom path.
 */
const DEFAULT_KEY_FILE_EXT = "txt";

export interface IndexNowPingResult {
  ok: boolean;
  status: number | null;
  /** HTTP body excerpt on failure, undefined on success. */
  error?: string;
}

/**
 * Derive the per-site key-file URL (the `keyLocation` field in the IndexNow
 * payload). IndexNow requires keyLocation to be on the same host as the
 * URLs being submitted, so we build it from the post URL's host.
 *
 *   postUrl  = https://blog.example.com/posts/foo
 *   key      = abc123...
 *   →        https://blog.example.com/abc123....txt
 */
function buildKeyLocation(postUrl: string, key: string): string {
  const u = new URL(postUrl);
  return `${u.origin}/${key}.${DEFAULT_KEY_FILE_EXT}`;
}

/**
 * Ping IndexNow with a single freshly-published URL. Fire-and-forget from
 * the publish path — the publish must NOT block on this. The promise never
 * throws; failures are returned in the result + logged.
 *
 *   - No-ops (returns { ok: true, status: null }) when INDEXNOW_KEY is
 *     unset, so the publish path can call it unconditionally.
 *   - keyLocation is auto-derived from postUrl unless one is provided
 *     (override via INDEXNOW_KEY_LOCATION_PATTERN for unusual setups).
 *   - 8-second timeout so a hanging Bing endpoint can't slow auto-publish.
 */
export async function pingIndexNow(
  postUrl: string,
  opts: { key?: string; keyLocation?: string } = {},
): Promise<IndexNowPingResult> {
  const key = opts.key ?? process.env.INDEXNOW_KEY?.trim();
  if (!key) {
    // Not configured — soft no-op so callers don't need to gate.
    return { ok: true, status: null };
  }

  let url: URL;
  try {
    url = new URL(postUrl);
  } catch {
    return { ok: false, status: null, error: `invalid postUrl: ${postUrl}` };
  }

  const keyLocation = opts.keyLocation ?? buildKeyLocation(postUrl, key);

  const body = {
    host: url.host,
    key,
    keyLocation,
    urlList: [postUrl],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        // IndexNow doesn't require an auth header, but a User-Agent helps
        // some engines (Yandex in particular) log the source for debugging.
        "User-Agent": "NetgridIndexNowBot/1.0 (+https://netgrid.app)",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (res.status === 200 || res.status === 202) {
      // 200: accepted. 202: accepted but queued (Bing).
      return { ok: true, status: res.status };
    }

    // 400 = malformed request (bad JSON, missing fields).
    // 403 = key file not found at keyLocation — operator hasn't deployed it.
    // 422 = URLs don't belong to host, or schema mismatch.
    // 429 = too many requests — back off.
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      error: text.slice(0, 200) || `HTTP ${res.status}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget wrapper used by the publish path. Auto-deploys the key
 * file on the blog's domain (via WP REST API / Shopify Admin API) before
 * pinging, so there's no manual per-site setup. The deploy is cached in
 * memory per blog id, so subsequent publishes hit a cache and ping straight
 * away.
 *
 * Never propagates errors — the publish has already succeeded; this is
 * pure best-effort search-engine notification.
 *
 * Accepts the full Blog row so the deployer can authenticate to the
 * platform. Pass the freshly-published row from runGenerateAndPublish.
 */
import type { blogs as blogsTable } from "@/lib/db/schema";
import { ensureIndexNowKeyDeployed } from "@/lib/services/index-now-deployer";
import { toCanonicalUrl } from "@/lib/services/canonical-url";
import {
  recordPipelineError,
  bumpCounter,
  trackBackground,
} from "@/lib/services/run-telemetry";
type Blog = typeof blogsTable.$inferSelect;

export function pingIndexNowFireAndForget(
  blog: Blog,
  postUrl: string,
): void {
  const task = (async () => {
    const canonicalPostUrl = toCanonicalUrl(postUrl, blog.domain);

    if (!process.env.INDEXNOW_KEY?.trim()) {
      recordPipelineError({
        site: "index-now-pinger.ping",
        code: "INDEXNOW_KEY_MISSING",
        severity: "error",
        message: `SKIP for ${blog.domain} — INDEXNOW_KEY env var is not set`,
        blogId: blog.id,
        context: { domain: blog.domain },
      });
      bumpCounter("indexNowRejected");
      return;
    }

    const platformKeyLocation = await ensureIndexNowKeyDeployed(blog);
    if (!platformKeyLocation) {
      recordPipelineError({
        site: "index-now-pinger.deploy",
        code: "INDEXNOW_DEPLOY_FAILED",
        severity: "error",
        message: `SKIP for ${blog.domain} — key-file deploy returned null`,
        blogId: blog.id,
        context: { domain: blog.domain, platform: blog.platform },
      });
      bumpCounter("indexNowRejected");
      return;
    }

    const canonicalKeyLocation = toCanonicalUrl(platformKeyLocation, blog.domain);

    const r = await pingIndexNow(canonicalPostUrl, {
      keyLocation: canonicalKeyLocation,
    });
    if (!r.ok) {
      recordPipelineError({
        site: "index-now-pinger.ping",
        code: "INDEXNOW_REJECTED",
        severity: "error",
        message:
          `FAILED for ${blog.domain} (status=${r.status}): ` +
          `${r.error?.slice(0, 200) ?? "unknown"}` +
          (r.status === 403
            ? ` | 403 means the key file isn't reachable at ${canonicalKeyLocation}`
            : ""),
        blogId: blog.id,
        context: {
          domain: blog.domain,
          status: r.status,
          keyLocation: canonicalKeyLocation,
          platformKeyLocation,
          postUrl: canonicalPostUrl,
        },
      });
      bumpCounter("indexNowRejected");
    }
  })().catch((err) => {
    recordPipelineError({
      site: "index-now-pinger.ping",
      code: "INDEXNOW_THREW",
      severity: "error",
      message: `unexpected throw for ${blog.domain}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      blogId: blog.id,
      context: { domain: blog.domain },
    });
    bumpCounter("indexNowRejected");
  });

  // Register with the current cron run so runWithTelemetry waits (bounded
  // by TELEMETRY_BACKGROUND_WAIT_MS) before flushing. No-op outside a run,
  // so the manual-publish path is unchanged: still genuinely detached.
  trackBackground(task);
}
