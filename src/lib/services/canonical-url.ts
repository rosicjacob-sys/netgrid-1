/**
 * Rewrite a platform-internal URL onto the blog's canonical (customer-facing)
 * domain. Shared by the IndexNow pinger and the semantic-linking engine —
 * anything that emits a URL for an external consumer (a search engine, a
 * reader clicking an internal link) must go through here.
 *
 * Required because:
 *
 *   - Shopify's Admin API returns URLs on `xyz.myshopify.com`. Bing's
 *     IndexNow rejects `.myshopify.com` URLs with a 422 ("not related to your
 *     site verified through keylocation") — it wants the merchant's custom
 *     domain — and an internal link to that host splits crawl equity away from
 *     the canonical storefront.
 *   - Self-hosted WP often runs on an IP+port (`http://1.2.3.4:8080/...`).
 *     IndexNow refuses IPs outright — domains only.
 *
 * The blog row already stores the canonical domain (`blogs.domain`). We swap
 * the host of the platform URL for it and force https://.
 *
 * If `canonicalDomain` looks broken (IP, port leftover, no TLD), the original
 * URL is returned unchanged so the caller surfaces a clearer error than a
 * silent host mismatch.
 *
 * This module imports nothing, deliberately: the linking engine needs it, and
 * importing index-now-pinger.ts would drag in index-now-deployer.ts ->
 * wp-client.ts + shopify-client.ts for a 20-line string helper.
 */
export function toCanonicalUrl(
  platformUrl: string,
  canonicalDomain: string,
): string {
  if (!canonicalDomain) return platformUrl;
  const cleanDomain = canonicalDomain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  if (
    !cleanDomain ||
    /^[\d.]+$/.test(cleanDomain) ||
    cleanDomain.includes(":") ||
    !cleanDomain.includes(".")
  ) {
    return platformUrl;
  }
  try {
    const u = new URL(platformUrl);
    u.protocol = "https:";
    u.host = cleanDomain;
    // The `host` setter parses its value as host[:port] and LEAVES THE
    // EXISTING PORT when the value carries none, so a self-hosted WP URL like
    // http://1.2.3.4:8080/x became https://example.com:8080/x — still broken
    // for IndexNow and still a broken internal link. Clearing it explicitly is
    // the whole point of the function: the output must be on the canonical
    // domain, on https, on the default port.
    u.port = "";
    return u.toString();
  } catch {
    return platformUrl;
  }
}
