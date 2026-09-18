/**
 * Find a blog's real, reachable sitemap.
 *
 * Order of attack:
 *   1. robots.txt `Sitemap:` directives — authoritative, and what Google
 *      itself reads. Yoast, RankMath and Shopify all write one.
 *   2. Platform-typical fallbacks, in likelihood order.
 *
 * A candidate only counts if it returns HTTP 200 with an XML-ish content type
 * AND a body whose root element is <urlset> or <sitemapindex>. Many hosts
 * serve a themed 200 HTML "not found" page for unknown paths, and submitting
 * one of those to Search Console creates a permanently-errored sitemap entry
 * on the property that a human then has to remove.
 *
 * Existing code elsewhere in the repo guesses a path and never checks the
 * response is XML (seo/scanner.ts tries only /sitemap.xml; the llms-txt route
 * hardcodes /sitemap.xml for Shopify and /sitemap_index.xml for WordPress).
 * Those are harvesting URLs for our own use, where a wrong guess costs
 * nothing. Submitting to Google is different.
 */

const FETCH_TIMEOUT_MS = 8000;
const USER_AGENT = "NetgridIndexNowBot/1.0 (+https://netgrid.app)";

const WP_CANDIDATES = ["/sitemap_index.xml", "/wp-sitemap.xml", "/sitemap.xml"];
const SHOPIFY_CANDIDATES = ["/sitemap.xml"];

export interface SitemapAttempt {
  url: string;
  status: number | null;
  ok: boolean;
  reason?: string;
}

export interface SitemapDiscovery {
  /** Absolute URL of a verified sitemap, or null when none was found. */
  sitemapUrl: string | null;
  /** Every candidate tried, in order — goes into the failure record. */
  attempts: SitemapAttempt[];
}

async function checkCandidate(url: string): Promise<SitemapAttempt> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      return { url, status: res.status, ok: false, reason: `HTTP ${res.status}` };
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const body = (await res.text().catch(() => "")).slice(0, 4000);

    if (!/xml/.test(contentType)) {
      return {
        url,
        status: 200,
        ok: false,
        reason: `content-type "${contentType || "(none)"}" is not XML`,
      };
    }
    if (!/<(urlset|sitemapindex)\b/i.test(body)) {
      return {
        url,
        status: 200,
        ok: false,
        reason: "root element is neither <urlset> nor <sitemapindex>",
      };
    }
    return { url, status: 200, ok: true };
  } catch (err) {
    return {
      url,
      status: null,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Pull `Sitemap:` directives out of robots.txt. Case-insensitive per RFC. */
async function sitemapsFromRobots(origin: string): Promise<string[]> {
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status !== 200) return [];
    const body = await res.text();
    const out: string[] = [];
    for (const line of body.split(/\r?\n/)) {
      const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
      if (!m) continue;
      try {
        out.push(new URL(m[1], origin).toString());
      } catch {
        // malformed directive — ignore
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * `host` must be a bare hostname (use canonicalHost from indexnow-key.ts).
 */
export async function discoverSitemap(
  host: string,
  platform: "wordpress" | "shopify",
): Promise<SitemapDiscovery> {
  const origin = `https://${host}`;
  const attempts: SitemapAttempt[] = [];

  const fromRobots = await sitemapsFromRobots(origin);
  const fallbacks = platform === "shopify" ? SHOPIFY_CANDIDATES : WP_CANDIDATES;
  const candidates = [
    ...fromRobots,
    ...fallbacks.map((p) => `${origin}${p}`),
  ].filter((u, i, arr) => arr.indexOf(u) === i);

  for (const candidate of candidates) {
    const attempt = await checkCandidate(candidate);
    attempts.push(attempt);
    if (attempt.ok) return { sitemapUrl: candidate, attempts };
  }

  return { sitemapUrl: null, attempts };
}
