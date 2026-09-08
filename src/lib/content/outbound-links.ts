// Outbound money-link policy: how netgrid links from a published article to a
// client's destination.
//
// Until T02, CTA buttons and in-body money links pointed at
// {NEXT_PUBLIC_APP_URL}/r/{postId} — one shared host embedded in the HTML of
// every site in the network — and carried a hash-randomized `rel` that
// nofollowed the client's own paid placement 5 times out of 6. Both are gone.
// Links now go DIRECTLY to the client, tagged with UTM parameters that the
// client's own GA4 / Shopify analytics already understand.
//
// Kept dependency-free (no "server-only", no db import, no content-generator
// import) so the generator, the server actions, the backfills and the unit
// tests can all import it. Mirrors the constraint documented in cta-target.ts.
/**
* `rel` for a COMMERCIAL link — the CTA button and the in-body money link.
* These are paid placements, so "sponsored" is the honest, Google-documented
* declaration. It passes no ranking credit (neither did the "nofollow" it
* replaces) but it is not a spam signal and it keeps the network out of
* undisclosed-paid-link territory.
*
* "noopener" is the security requirement for target="_blank".
* "noreferrer" is deliberately ABSENT: stripping the Referer header would hide
* the publishing site from the client's analytics, which is precisely the
* attribution we are trying to restore. The old pool's
* "noopener noreferrer nofollow" value did exactly that on 1 blog in 6.
*/
export const COMMERCIAL_LINK_REL = "sponsored noopener";
/**
* `rel` for an EDITORIAL outbound citation — the news references the model is
* told to weave into non-peptide articles. Not a paid placement, so no
* "sponsored"; just the target="_blank" security attribute.
*/
export const EDITORIAL_LINK_REL = "noopener";
/** Where on the page the tagged link sits — becomes utm_medium. */
export type UtmMedium = "cta_button" | "body_link" | "homepage_cta";
/** Fixed campaign name, so every netgrid-sourced click groups together in GA4. */
export const UTM_CAMPAIGN = "netgrid_content";
/**
* Normalize a stored blog domain into a bare lowercase host usable as
* utm_source. blogs.domain is stored inconsistently (with or without scheme,
* with or without a trailing slash), so strip scheme, "www.", any path/query,
* and trailing slashes. Returns null when nothing usable is left.
 */
export function utmSourceFromDomain(
    domain: string | null | undefined,
): string | null {
    const host = (domain ?? "")
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/[/?#].*$/, "")
        .replace(/\/+$/, "");
    return host || null;
}
export interface UtmOptions {
    /** The PUBLISHING site's domain (blogs.domain) — becomes utm_source. */
    blogDomain?: string | null;
    /** Placement of the link — becomes utm_medium. */
    medium: UtmMedium;
    /**
     * generated_posts.id — becomes utm_content. Carrying the same UUID the old
     * link_events.post_id used means a client-exported GA4 report still joins
     * back to netgrid's own rows.
     */
    postId?: string | null;
    /** Overrides UTM_CAMPAIGN when a client wants their own campaign name. */
    campaign?: string | null;
}
/**
 * Append netgrid's UTM parameters to a destination URL.
 *
 *  - Never overwrites a utm_* parameter the destination already carries: a
 *    client-entered CTA URL may already be tagged, and theirs wins.
 *  - Preserves existing query parameters and the fragment.
 *  - Returns non-http(s) and unparseable input untouched, so callers can pass a
 *    raw value straight through without a second guard.
 *  - Returns a PLAIN URL string. HTML-escape it at the point of serialization
 *    (see safeAttrUrl in content-generator.ts) — the "&" separators are not
 *    valid raw inside an HTML attribute.
 */
export function withUtm(rawUrl: string, opts: UtmOptions): string {
    const raw = (rawUrl ?? "").trim();
    if (!/^https?:\/\//i.test(raw)) return raw;
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return raw;
    }
    const source = utmSourceFromDomain(opts.blogDomain) ?? "netgrid";
    const campaign = opts.campaign?.trim() || UTM_CAMPAIGN;
    const params: Array<[string, string]> = [
        ["utm_source", source],
        ["utm_medium", opts.medium],
        ["utm_campaign", campaign],
    ];
    if (opts.postId) params.push(["utm_content", opts.postId]);
    for (const [key, value] of params) {
        if (!u.searchParams.has(key)) u.searchParams.set(key, value);
    }
    return u.toString();
}
/**
* Remove every utm_* parameter from a URL. Used when comparing a live href
* against a client's raw destination (the reverse backfill must recognise an
* already-repaired link and skip it rather than double-tagging).
*/
export function stripUtm(rawUrl: string): string {
    const raw = (rawUrl ?? "").trim();
    if (!/^https?:\/\//i.test(raw)) return raw;
    try {
        const u = new URL(raw);
        for (const key of [...u.searchParams.keys()]) {
            if (key.toLowerCase().startsWith("utm_")) u.searchParams.delete(key);
        }
        return u.toString();
    } catch {
        return raw;
    }
}