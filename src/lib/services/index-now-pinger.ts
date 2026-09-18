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
 * IndexNow requires a shared secret ("key", 8-128 chars of [a-zA-Z0-9-]) to
 * prove you control the host, published as a plain-text file whose body IS the
 * key. The file's DIRECTORY scopes what it authorises: a key at
 * /uploads/KEY.txt authorises /uploads/** and nothing else. Post permalinks
 * are at the root, so the key file must be at the root.
 *
 * Each blog has its OWN key (blogs.indexnow_key), minted and deployed by
 * index-now-deployer. There is deliberately no network-wide key: the key file
 * is public at a guessable URL on every domain we operate, so a shared key
 * would make network membership testable with one unauthenticated GET. The
 * INDEXNOW_KEY env var is no longer read — delete it from Render.
 *
 * --- What this module does NOT do ---
 *
 * - Does NOT ping Google. Google does not support IndexNow, and its
 *   unauthenticated sitemap ping endpoint was retired in 2023. The Google path
 *   is Search Console sitemaps.submit — see
 *   src/lib/services/indexing-onboarding.ts.
 * - Does NOT support Shopify. Shopify cannot host a spec-compliant key file at
 *   a path covering /blogs/* article URLs; those blogs are sitemap-only.
 * - Does NOT host the key file. That is index-now-deployer's job.
 * - Does NOT batch across multiple URLs. We submit one URL per publish; the
 *   batch endpoint is overkill for the network's publish rate.
 */

import type { blogs as blogsTable } from "@/lib/db/schema";
import { ensureIndexNowKeyDeployed } from "@/lib/services/index-now-deployer";
import { recordIndexEvent } from "@/lib/services/index-events";
import { toCanonicalUrl } from "@/lib/services/canonical-url";

type Blog = typeof blogsTable.$inferSelect;

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const PING_TIMEOUT_MS = 8000;

export interface IndexNowPingResult {
  ok: boolean;
  status: number | null;
  /** HTTP body excerpt on failure, undefined on success. */
  error?: string;
}

/**
 * POST one freshly-published URL to IndexNow.
 *
 * `key` and `keyLocation` are REQUIRED — there is no env fallback and no
 * derivation. Deriving keyLocation here is what let the old code ping with a
 * location nobody had ever verified. The caller gets both from
 * ensureIndexNowKeyDeployed, which only returns after fetching the file and
 * confirming it is 200 / text/* / body === key.
 *
 * Never throws. 8-second timeout so a hanging endpoint cannot slow the
 * auto-publish shard.
 */
export async function pingIndexNow(
  postUrl: string,
  opts: { key: string; keyLocation: string },
): Promise<IndexNowPingResult> {
  let url: URL;
  try {
    url = new URL(postUrl);
  } catch {
    return { ok: false, status: null, error: `invalid postUrl: ${postUrl}` };
  }

  const body = {
    host: url.host,
    key: opts.key,
    keyLocation: opts.keyLocation,
    urlList: [postUrl],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        // IndexNow doesn't require an auth header, but a User-Agent helps some
        // engines (Yandex in particular) log the source for debugging.
        "User-Agent": "NetgridIndexNowBot/1.0 (+https://netgrid.app)",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (res.status === 200 || res.status === 202) {
      // 200: accepted. 202: accepted, key validation still pending.
      return { ok: true, status: res.status };
    }

    // 400 = malformed request (bad JSON, missing fields).
    // 403 = key invalid: file not found at keyLocation, or found but its body
    //       is not the key.
    // 422 = URLs don't belong to the host, or are outside the key file's
    //       directory, or the key doesn't match the schema.
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
 * Fire-and-forget wrapper used by the publish path. Ensures the key file is
 * deployed AND verified on the blog's own domain, then pings.
 *
 * Never propagates errors — the publish has already succeeded; this is pure
 * best-effort search-engine notification. Every terminal state writes an
 * index_ping_events row so failure is queryable rather than lost in a
 * container's stdout.
 *
 * `postId` is the generated_posts row id, used only for event attribution.
 */
export function pingIndexNowFireAndForget(
  blog: Blog,
  postUrl: string,
  postId?: string | null,
): void {
  (async () => {
    const canonicalPostUrl = toCanonicalUrl(postUrl, blog.domain);

    if (process.env.INDEXNOW_DISABLED === "1") {
      await recordIndexEvent({
        blogId: blog.id,
        postId,
        channel: "indexnow",
        outcome: "skipped",
        targetUrl: canonicalPostUrl,
        error: "INDEXNOW_DISABLED=1",
      });
      return;
    }

    // Deploys + verifies on cache miss; a cache hit is a Map lookup. Returns
    // BOTH the key and its verified location — never re-derive the key from
    // the `blog` row here, which was read before the deployer may have minted
    // and persisted one. Doing so would mint a SECOND key, overwriting the one
    // the site is actually serving, and every ping would then 403. The
    // deployer records its own skipped/failed events, so we stay quiet on a
    // null.
    const deployed = await ensureIndexNowKeyDeployed(blog);
    if (!deployed) return;
    const { key, keyLocation } = deployed;

    const r = await pingIndexNow(canonicalPostUrl, { key, keyLocation });

    await recordIndexEvent({
      blogId: blog.id,
      postId,
      channel: "indexnow",
      outcome: r.ok ? "ok" : "failed",
      targetUrl: canonicalPostUrl,
      keyLocation,
      httpStatus: r.status,
      error: r.ok ? null : (r.error ?? "unknown"),
    });

    if (!r.ok) {
      console.warn(
        `[indexnow] FAILED for ${blog.domain} (status=${r.status}): ${r.error?.slice(0, 200) ?? "unknown"}`,
      );
    }
  })().catch(async (err) => {
    console.error(`[indexnow] unexpected throw for ${blog.domain}:`, err);
    await recordIndexEvent({
      blogId: blog.id,
      postId,
      channel: "indexnow",
      outcome: "failed",
      targetUrl: postUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
