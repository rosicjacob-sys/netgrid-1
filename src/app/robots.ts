import type { MetadataRoute } from "next";

// Static — the rules never vary per request, so Next can emit a plain file.
export const dynamic = "force-static";

/**
 * /robots.txt for the netgrid control plane.
 *
 * Nothing on this host should ever appear in a search index, but two paths in
 * particular are the reason this file exists (T02): /r/{postId} and
 * /api/track/px/{postId} are referenced from the published HTML of every client
 * site, which makes them crawler-discoverable from ~1,500 external domains and
 * turns a single Render hostname into a machine-readable roster of the network.
 *
 * This is a MITIGATION, not the fix. Disallow stops a compliant crawler from
 * FETCHING these URLs; it does not remove the netgrid href from the client's
 * page, and a disallowed URL can still be indexed as a URL-only entry when
 * enough pages link to it. The fix is the rest of T02 — direct links plus the
 * reverse backfill. Keep this file afterwards regardless.
 *
 * No middleware change is needed: the matcher in src/middleware.ts excludes
 * paths ending in ".txt", so /robots.txt never enters withAuth and is served
 * anonymously.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        disallow: ["/r/", "/api/"],
      },
    ],
  };
}
