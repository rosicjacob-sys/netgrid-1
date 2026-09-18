/**
 * lib/services/wp-meta-verify.ts
 *
 * Post-write verification for WordPress SEO meta.
 *
 * WordPress returns HTTP 200 for a /wp/v2/posts write carrying meta keys it
 * does not recognise: WP_REST_Meta_Fields::update_value() iterates over
 * REGISTERED meta and never looks at the rest of the request body, and the
 * `meta` argument's validator only checks that the value is an array. A 2xx is
 * therefore NOT evidence a meta value was stored - and a stored value is still
 * not evidence the SEO plugin renders it (Yoast renders from its own indexable
 * cache, which can be stale).
 *
 * The only trustworthy signal is the live page's <head>. This module fetches it
 * and compares.
 *
 * Mirrors the verify-after-write pattern already used by wp-seo-injector.ts,
 * which re-reads the post body to confirm the JSON-LD block survived
 * WordPress's content filter.
 */

import axios from "axios";
import * as cheerio from "cheerio";
import { CRAWLER_DEFAULTS } from "@/lib/constants";

export interface LiveMetaSnapshot {
  title: string | null;
  description: string | null;
}

export interface MetaVerification {
  /**
   * true  - the live <head> matches what we wrote.
   * false - the page was fetched and does NOT match: the write did not land.
   * null  - the page could not be fetched, so we know nothing either way.
   */
  verified: boolean | null;
  reason: string;
  observed: LiveMetaSnapshot;
  attempts: number;
}

/**
 * Delay BEFORE each attempt. The first is immediate; the retries exist because
 * full-page caches (LiteSpeed, WP Rocket, Cloudflare) can serve a stale copy
 * for a few seconds after a post is updated.
 */
const VERIFY_DELAYS_MS = [0, 2500, 6000];

/** Longest prefix of the description we require to match, in characters. */
const DESCRIPTION_PREFIX_CHARS = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Parse <title> and <meta name="description"> out of a rendered page. */
export function readHeadMeta(html: string): LiveMetaSnapshot {
  const $ = cheerio.load(html);

  // Prefer the head-scoped nodes; fall back to a document-wide lookup for
  // pages whose markup confuses the parser. An SVG <title> in the body is the
  // reason we do not start with the document-wide selector.
  const rawTitle =
    $("head > title").first().text() || $("title").first().text();
  const rawDescription =
    $('head > meta[name="description"]').attr("content") ??
    $('meta[name="description"]').attr("content");

  return {
    title: rawTitle.replace(/\s+/g, " ").trim() || null,
    description: (rawDescription ?? "").replace(/\s+/g, " ").trim() || null,
  };
}

/**
 * A theme or CDN may append a site-name suffix to the <title>, so a prefix
 * match counts. We do NOT accept a suffix match - that would let the theme's
 * default "Post Title - Site Name" pass when our title happens to be the post
 * title.
 */
export function titleMatches(observed: string | null, expected: string): boolean {
  const o = normalize(observed);
  const e = normalize(expected);
  if (!o || !e) return false;
  return o === e || o.startsWith(e);
}

/**
 * WordPress and some SEO plugins truncate very long descriptions, so we accept
 * a match on the first DESCRIPTION_PREFIX_CHARS normalized characters.
 */
export function descriptionMatches(
  observed: string | null,
  expected: string,
): boolean {
  const o = normalize(observed);
  const e = normalize(expected);
  if (!o || !e) return false;
  return o === e || o.startsWith(e.slice(0, DESCRIPTION_PREFIX_CHARS));
}

/** Raw GET of a public page. Returns the HTML body, or null if unreachable. */
async function fetchPageHtml(
  url: string,
  bustCache: boolean,
): Promise<string | null> {
  const target = bustCache
    ? `${url}${url.includes("?") ? "&" : "?"}netgrid_verify=${Date.now()}`
    : url;
  try {
    const res = await axios.get<string>(target, {
      timeout: CRAWLER_DEFAULTS.requestTimeoutMs,
      headers: {
        "User-Agent": CRAWLER_DEFAULTS.userAgent,
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
      maxRedirects: 3,
      // Keep the body a string - axios would otherwise try to JSON.parse
      // anything served with a JSON-ish content type.
      responseType: "text",
      transformResponse: [(data) => data],
      validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 300 && typeof res.data === "string") {
      return res.data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch the live post and confirm the meta we just wrote is what the page
 * actually renders.
 *
 * Cost: one HTTP GET on the happy path (the first attempt has no delay and
 * normally succeeds). A failure costs three GETs and ~8.5s of wall clock -
 * acceptable inside the auto-publish route, which runs at maxDuration = 600.
 *
 * The tri-state return matters. Many NetGrid destinations are password-walled
 * or WAF-protected. Collapsing "unreachable" into "failed" would flood the
 * network with false alarms; collapsing it into "verified" would recreate the
 * bug this module exists to catch. null is the honest third answer, and the DB
 * column is a nullable boolean for the same reason.
 */
export async function verifyLiveMeta(
  postUrl: string,
  expected: { title?: string; description?: string },
): Promise<MetaVerification> {
  const wantTitle = expected.title?.trim();
  const wantDescription = expected.description?.trim();

  let observed: LiveMetaSnapshot = { title: null, description: null };
  let everFetched = false;

  for (let attempt = 0; attempt < VERIFY_DELAYS_MS.length; attempt++) {
    if (VERIFY_DELAYS_MS[attempt] > 0) {
      await sleep(VERIFY_DELAYS_MS[attempt]);
    }
    const html = await fetchPageHtml(postUrl, attempt > 0);
    if (html === null) continue;
    everFetched = true;
    observed = readHeadMeta(html);

    const titleOk = !wantTitle || titleMatches(observed.title, wantTitle);
    const descriptionOk =
      !wantDescription || descriptionMatches(observed.description, wantDescription);

    if (titleOk && descriptionOk) {
      return {
        verified: true,
        reason: "live head matches the meta we wrote",
        observed,
        attempts: attempt + 1,
      };
    }
  }

  if (!everFetched) {
    return {
      verified: null,
      reason: "could not fetch the live page (blocked, offline, or not public)",
      observed,
      attempts: VERIFY_DELAYS_MS.length,
    };
  }

  const mismatches: string[] = [];
  if (wantTitle && !titleMatches(observed.title, wantTitle)) {
    mismatches.push(
      `title is ${JSON.stringify(observed.title)}, expected ${JSON.stringify(wantTitle)}`,
    );
  }
  if (wantDescription && !descriptionMatches(observed.description, wantDescription)) {
    mismatches.push(
      `description is ${JSON.stringify(observed.description)}, expected ${JSON.stringify(wantDescription)}`,
    );
  }

  return {
    verified: false,
    reason: mismatches.join("; ") || "live head did not match",
    observed,
    attempts: VERIFY_DELAYS_MS.length,
  };
}
