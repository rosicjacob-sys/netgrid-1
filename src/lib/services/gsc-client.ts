/**
 * Google Search Console client — service-account auth plus the four API
 * surfaces NetGrid needs. Nothing here touches the database; persistence lives
 * in gsc-sync.ts and gsc-index-coverage.ts.
 *
 *   searchconsole.searchanalytics.query   clicks / impressions / position
 *   searchconsole.urlInspection.index     per-URL index coverage
 *   searchconsole.sitemaps.submit         one-shot sitemap ping at onboarding
 *   siteVerification.webResource.*        claiming ownership of a property
 *
 * Design mirrors dataforseo/client.ts: a typed error class, bounded retries
 * with jittered exponential backoff, no retry on an error that will fail
 * again, and no unhandled throw escaping into a request path.
 *
 * QUOTAS (developers.google.com/webmaster-tools/limits):
 *
 *   searchanalytics.query   per-site    1,200 QPM
 *                           per-project 40,000 QPM, 30,000,000 QPD
 *   urlInspection.index     per-site    2,000 QPD, 600 QPM
 *                           per-project 10,000 QPD, 15,000 QPM   <-- BINDING
 *   sites.* / sitemaps.*    per-site    100 QPM
 *                           per-project 1,000,000 QPD, 100,000 QPM
 *
 * At 1,500 properties the search-analytics side is effectively unmetered
 * (~1,500 calls/day against a 30M/day project cap). The 10,000/day PROJECT cap
 * on URL Inspection is the only real constraint in the whole subsystem — see
 * gsc-index-coverage.ts for the sampling budget that respects it.
 */

import { google } from "googleapis";

/**
 * webmasters = read + write Search Console (the searchconsole v1 API still
 * uses the legacy "webmasters" scope string). siteverification = the ability
 * to claim ownership of a property, which is what makes 1,500 properties
 * possible without a human in the Search Console UI.
 */
const SCOPES = [
  "https://www.googleapis.com/auth/webmasters",
  "https://www.googleapis.com/auth/siteverification",
];

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

/** googleapis exports the JWT class as a value; derive the type from it so we
 * don't need google-auth-library as a direct dependency. */
type GscJwt = InstanceType<typeof google.auth.JWT>;

export class GscError extends Error {
  constructor(
    message: string,
    /** HTTP status Google returned, when there was one. */
    readonly status?: number,
    /** Google's machine-readable reason, e.g. "quotaExceeded", "forbidden". */
    readonly reason?: string,
  ) {
    super(message);
    this.name = "GscError";
  }
}

/**
 * True when the service account is configured. EVERY entry point in this
 * subsystem checks this first and no-ops when false, so an un-configured
 * environment (local dev, a preview deploy) runs the crons harmlessly.
 */
export function gscConfigured(): boolean {
  return Boolean(
    process.env.GSC_SERVICE_ACCOUNT_EMAIL?.trim() &&
      process.env.GSC_SERVICE_ACCOUNT_PRIVATE_KEY?.trim(),
  );
}

let _auth: GscJwt | undefined;

/**
 * Lazily build the service-account JWT, cached in process memory. Token
 * refresh is handled inside google-auth-library, so one instance per process
 * is correct and avoids re-parsing the PEM on every call.
 *
 * Render environment variables are single-line, so the PEM arrives either with
 * escaped newlines ("-----BEGIN PRIVATE KEY-----\nMIIEv...") or base64-encoded.
 * Both are accepted — a PEM that still has literal \n sequences is the single
 * most common cause of "error:1E08010C:DECODER routines::unsupported".
 */
export function gscAuth(): GscJwt {
  if (_auth) return _auth;
  const email = process.env.GSC_SERVICE_ACCOUNT_EMAIL?.trim();
  const raw = process.env.GSC_SERVICE_ACCOUNT_PRIVATE_KEY?.trim();
  if (!email || !raw) {
    throw new GscError(
      "GSC_SERVICE_ACCOUNT_EMAIL and GSC_SERVICE_ACCOUNT_PRIVATE_KEY must both be set",
    );
  }
  const key = raw.includes("-----BEGIN")
    ? raw.replace(/\\n/g, "\n")
    : Buffer.from(raw, "base64").toString("utf8");
  _auth = new google.auth.JWT({ email, key, scopes: SCOPES });
  return _auth;
}

function searchConsole() {
  return google.searchconsole({ version: "v1", auth: gscAuth() });
}

function siteVerification() {
  return google.siteVerification({ version: "v1", auth: gscAuth() });
}

// ─── Error handling + retry ──────────────────────────────────────────────────

interface GaxiosLikeError {
  code?: number | string;
  message?: string;
  response?: { status?: number };
  errors?: Array<{ reason?: string; message?: string }>;
}

/** Flatten gaxios' several error shapes into one GscError. */
function normalizeError(err: unknown, context: string): GscError {
  const e = (err ?? {}) as GaxiosLikeError;
  const rawStatus = e.response?.status ?? e.code;
  const status =
    typeof rawStatus === "number"
      ? rawStatus
      : Number.isFinite(Number(rawStatus))
        ? Number(rawStatus)
        : undefined;
  const reason = e.errors?.[0]?.reason;
  const message = e.errors?.[0]?.message ?? e.message ?? String(err);
  return new GscError(`${context}: ${message}`, status, reason);
}

/** 429 = quota or rate limit; 500/503 = transient upstream. Nothing else is
 * worth retrying — a 403 or 404 will fail identically forever. */
function retryable(status?: number): boolean {
  return status === 429 || status === 500 || status === 503;
}

/** Exponential backoff from a 1s base, plus up to 30% jitter. Same curve as
 * dataforseo/client.ts so operators only have one shape to reason about. */
function backoffMs(attempt: number): number {
  const base = BASE_BACKOFF_MS * 2 ** attempt;
  return base + Math.random() * base * 0.3;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(context: string, fn: () => Promise<T>): Promise<T> {
  let last: GscError | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = normalizeError(err, context);
      if (!retryable(last.status) || attempt === MAX_RETRIES) throw last;
      await sleep(backoffMs(attempt));
    }
  }
  throw last ?? new GscError(`${context}: retries exhausted`);
}

/** True when Google refused because a daily quota is spent, as opposed to a
 * momentary rate limit. Callers use this to STOP a batch rather than burn the
 * remaining runtime on calls that cannot succeed today. */
export function isQuotaExhausted(err: unknown): boolean {
  if (!(err instanceof GscError)) return false;
  return (
    err.reason === "quotaExceeded" ||
    err.reason === "dailyLimitExceeded" ||
    (err.status === 429 && !err.reason)
  );
}

// ─── Property identifiers ────────────────────────────────────────────────────

/**
 * Search Console property identifiers.
 *
 *   Domain property      sc-domain:example.com   DNS TXT verified. Covers www
 *                                                and non-www, http and https,
 *                                                and every subdomain.
 *   URL-prefix property  https://example.com/    META/FILE verified. Covers
 *                                                exactly that scheme + host.
 *
 * blogs.domain is a bare, lower-cased hostname — validators/blog.ts rejects a
 * scheme and blog-actions lower-cases it — so both forms are a pure string
 * build with no parsing or normalisation needed.
 */
export function domainProperty(domain: string): string {
  return `sc-domain:${domain.replace(/^www\./, "")}`;
}

export function urlPrefixProperty(domain: string): string {
  return `https://${domain}/`;
}

// ─── Search analytics ────────────────────────────────────────────────────────

export interface SearchAnalyticsRow {
  /** YYYY-MM-DD in America/Los_Angeles — Search Console's reporting timezone. */
  date: string;
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  /** Average SERP position, fractional (e.g. 13.47). */
  position: number;
}

export interface SearchAnalyticsPage {
  rows: SearchAnalyticsRow[];
  /** True when Google filled the page — call again with startRow += ROW_LIMIT. */
  hasMore: boolean;
}

/** Google's hard maximum for one searchanalytics.query response. */
export const SEARCH_ANALYTICS_ROW_LIMIT = 25000;

/**
 * One page of (date, query, page) performance rows.
 *
 * dataState:
 *   "final"  settled data only. Correct for the historical backfill — the
 *            numbers will never change again, so one pass is enough.
 *   "all"    include the most recent, still-being-revised days. Correct for
 *            the daily trailing window, which is re-pulled and upserted every
 *            run so the estimates converge on the final values.
 *
 * Note that rows whose query Google anonymises are omitted entirely, not
 * returned with a blank query. Fleet impression totals from this endpoint will
 * therefore always be slightly lower than the un-dimensioned totals in the
 * Search Console UI. That is expected and is not a bug in this code.
 */
export async function querySearchAnalytics(opts: {
  siteUrl: string;
  startDate: string;
  endDate: string;
  startRow?: number;
  dataState?: "final" | "all";
}): Promise<SearchAnalyticsPage> {
  const startRow = opts.startRow ?? 0;
  const res = await withRetry(
    `searchanalytics.query ${opts.siteUrl} ${opts.startDate}..${opts.endDate} @${startRow}`,
    () =>
      searchConsole().searchanalytics.query({
        siteUrl: opts.siteUrl,
        requestBody: {
          startDate: opts.startDate,
          endDate: opts.endDate,
          dimensions: ["date", "query", "page"],
          type: "web",
          rowLimit: SEARCH_ANALYTICS_ROW_LIMIT,
          startRow,
          dataState: opts.dataState ?? "final",
        },
      }),
  );

  const raw = res.data.rows ?? [];
  const rows: SearchAnalyticsRow[] = [];
  for (const r of raw) {
    const [date, query, page] = r.keys ?? [];
    if (!date || query == null || !page) continue;
    rows.push({
      date,
      query,
      page,
      clicks: Math.round(r.clicks ?? 0),
      impressions: Math.round(r.impressions ?? 0),
      position: r.position ?? 0,
    });
  }
  return { rows, hasMore: raw.length >= SEARCH_ANALYTICS_ROW_LIMIT };
}

// ─── URL inspection ──────────────────────────────────────────────────────────

export interface UrlInspectionResult {
  verdict: string | null;
  coverageState: string | null;
  robotsTxtState: string | null;
  indexingState: string | null;
  pageFetchState: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  /** RFC3339 string from Google, or null if never crawled. */
  lastCrawlTime: string | null;
  raw: unknown;
}

/**
 * Inspect one URL. The URL must belong to the property, and the service
 * account must be an OWNER or full user of it (a restricted user gets a 403).
 *
 * Costs one unit against the 10,000/day per-project URL Inspection quota.
 * Every field below arrives in the same response, so storing all of them costs
 * nothing extra — never make a second call to fill one of them in.
 */
export async function inspectUrl(
  siteUrl: string,
  inspectionUrl: string,
): Promise<UrlInspectionResult> {
  const res = await withRetry(`urlInspection.index.inspect ${inspectionUrl}`, () =>
    searchConsole().urlInspection.index.inspect({
      requestBody: { siteUrl, inspectionUrl, languageCode: "en-US" },
    }),
  );
  const r = res.data.inspectionResult?.indexStatusResult ?? {};
  return {
    verdict: r.verdict ?? null,
    coverageState: r.coverageState ?? null,
    robotsTxtState: r.robotsTxtState ?? null,
    indexingState: r.indexingState ?? null,
    pageFetchState: r.pageFetchState ?? null,
    googleCanonical: r.googleCanonical ?? null,
    userCanonical: r.userCanonical ?? null,
    lastCrawlTime: r.lastCrawlTime ?? null,
    raw: res.data.inspectionResult ?? null,
  };
}

// ─── Sites + sitemaps ────────────────────────────────────────────────────────

/** Register a property against the service account. Requires the account to
 * already be a verified owner (see verifyOwnership). */
export async function addSite(siteUrl: string): Promise<void> {
  await withRetry(`sites.add ${siteUrl}`, () => searchConsole().sites.add({ siteUrl }));
}

/** feedpath is the ABSOLUTE sitemap URL, e.g. https://example.com/sitemap.xml */
export async function submitSitemap(siteUrl: string, feedpath: string): Promise<void> {
  await withRetry(`sitemaps.submit ${feedpath}`, () =>
    searchConsole().sitemaps.submit({ siteUrl, feedpath }),
  );
}

export interface SitemapStatus {
  path: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  warnings?: string;
  errors?: string;
}

/**
 * Read back a sitemap's processing state (T15).
 *
 * submitSitemap only proves Google ACCEPTED the call; this proves the entry is
 * actually on the property. Returns null when Search Console does not know
 * this sitemap (404) or the call fails — the caller treats that as "submitted
 * but unconfirmed", not as a failure, because the submit itself succeeded.
 */
export async function getSitemapStatus(
  siteUrl: string,
  feedpath: string,
): Promise<SitemapStatus | null> {
  try {
    const res = await withRetry(`sitemaps.get ${feedpath}`, () =>
      searchConsole().sitemaps.get({ siteUrl, feedpath }),
    );
    const data = res.data as SitemapStatus | undefined;
    return data ?? null;
  } catch {
    return null;
  }
}

/** Every property this service account can see. Used by the ownership
 * reconciliation check. */
export async function listSites(): Promise<
  Array<{ siteUrl: string; permissionLevel: string }>
> {
  const res = await withRetry("sites.list", () => searchConsole().sites.list());
  return (res.data.siteEntry ?? []).map((s) => ({
    siteUrl: s.siteUrl ?? "",
    permissionLevel: s.permissionLevel ?? "unknown",
  }));
}

// ─── Site verification ───────────────────────────────────────────────────────

export type GscVerificationMethod = "DNS_TXT" | "META" | "FILE";

/**
 * The Site Verification API addresses a DNS-verified domain and a
 * file/meta-verified URL prefix differently:
 *   DNS_TXT -> { type: "INET_DOMAIN", identifier: "example.com" }
 *   META    -> { type: "SITE",        identifier: "https://example.com/" }
 */
function verificationSite(domain: string, method: GscVerificationMethod) {
  return method === "DNS_TXT"
    ? { type: "INET_DOMAIN", identifier: domain.replace(/^www\./, "") }
    : { type: "SITE", identifier: urlPrefixProperty(domain) };
}

/**
 * Ask Google for the ownership token to place on the site. Cheap, idempotent,
 * and stable for a given (service account, site, method) triple — calling it
 * twice returns the same token, so it is safe to call on every retry.
 *
 *   DNS_TXT  "google-site-verification=XXXX"   TXT value for the apex record
 *   META     '<meta name="google-site-verification" content="XXXX" />'
 *   FILE     "googleXXXX.html"                 filename (unusable here — the
 *                                              HTML-file method has no
 *                                              keyLocation field, and neither
 *                                              platform client can write to a
 *                                              document root)
 */
export async function getVerificationToken(
  domain: string,
  method: GscVerificationMethod,
): Promise<string> {
  const res = await withRetry(`siteVerification.getToken ${domain} ${method}`, () =>
    siteVerification().webResource.getToken({
      requestBody: {
        site: verificationSite(domain, method),
        verificationMethod: method,
      },
    }),
  );
  const token = res.data.token;
  if (!token) {
    throw new GscError(`siteVerification.getToken returned no token for ${domain}`);
  }
  return token;
}

/**
 * Tell Google to fetch the token you placed and, on success, record this
 * service account as a verified OWNER.
 *
 * Throws GscError with status 400 when the token is not visible yet. For
 * DNS_TXT that is the EXPECTED steady state until an operator publishes the
 * record — it is not a bug and must not be logged as an error. The caller
 * translates it into a "pending_dns" outcome and retries on the next cron run.
 */
export async function verifyOwnership(
  domain: string,
  method: GscVerificationMethod,
): Promise<void> {
  await withRetry(`siteVerification.insert ${domain} ${method}`, () =>
    siteVerification().webResource.insert({
      verificationMethod: method,
      requestBody: { site: verificationSite(domain, method) },
    }),
  );
}
