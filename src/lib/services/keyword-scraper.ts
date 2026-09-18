import "server-only";
import { recordPipelineError } from "@/lib/services/run-telemetry";

// Keyword discovery via Google Autocomplete.
//
// Free, no API key, no search volume — great for long-tail / intent discovery
// (the "alphabet soup" technique). Each seed is queried on its own and with an
// appended letter a–z, and Google returns suggestions in rough popularity order,
// so a term's best position across queries plus how many seed queries surfaced
// it (hitCount) form a usable popularity proxy when no real volume is available.
//
// The provider is deliberately isolated behind ScrapedKeyword[] so a
// volume-bearing source (Bing Webmaster, DataForSEO) can be added later without
// touching the storage/binding layers.

export interface ScrapedKeyword {
  keyword: string;
  /** How many distinct seed queries surfaced this term (popularity proxy). */
  hitCount: number;
  /** Best (lowest) suggestion position seen across queries; lower = better. */
  bestPosition: number;
  source: "google_autocomplete";
}

export interface ScrapeOptions {
  /** UI language, e.g. "en" | "fr". */
  lang?: string;
  /** Geo, e.g. "us" | "ca". */
  country?: string;
  /** Append a–z to each seed for long-tail expansion. Default true. */
  alphabetSoup?: boolean;
  /** Max seeds actually queried (guards the request budget). Default 12. */
  maxSeeds?: number;
  /** Max keywords returned after aggregation. Default 300. */
  limit?: number;
  /**
   * Hard cap on HTTP requests issued by this call. Defaults to
   * KEYWORD_SCRAPE_MAX_QUERIES (160). The old code had no cap and always
   * issued maxSeeds x 27 = 324 requests per client, which is what made a
   * whole-network refresh take hours (T10 §1.1).
   */
  maxQueries?: number;
}

/**
 * Outcome of one scrapeKeywords() call — the keywords PLUS why they might be
 * missing. The old signature returned a bare ScrapedKeyword[], which made a
 * total block indistinguishable from "these seeds have no suggestions": both
 * were []. Callers must branch on `blocked` before deciding that a client
 * legitimately has no keywords.
 */
export interface ScrapeResult {
  keywords: ScrapedKeyword[];
  queriesAttempted: number;
  queriesSucceeded: number;
  queriesFailed: number;
  /**
   * True when at least one query ran and EVERY query failed. That is a block
   * or an outage, never a real empty result.
   */
  blocked: boolean;
  /** Up to 3 distinct failure reasons with counts, for logs and alerts. */
  failureReasons: string[];
}

const AUTOCOMPLETE_URL = "https://suggestqueries.google.com/complete/search";
const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

/**
 * Per-request timeout. Node's fetch has no default body timeout, so a hung
 * response used to occupy one of the concurrency slots indefinitely. Same
 * pattern as dataforseo/client.ts, shorter because autocomplete is a
 * sub-second endpoint when it is healthy at all.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Honest, self-identifying UA with a contact URL. Do NOT replace this with a
 * spoofed browser string: evading the endpoint's bot detection is out of
 * bounds, and it would make the next block silent instead of reported. The
 * answer to volume is DataForSEO on a budget, not a disguise.
 */
const USER_AGENT =
  process.env.KEYWORD_SCRAPE_USER_AGENT ||
  "netgrid-keyword-bot/2.0 (+https://netgrid-16f6.onrender.com)";

/** Read a bounded integer from the environment, falling back on anything odd. */
function envInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Concurrency for the many small suggest requests. */
function scrapeConcurrency(): number {
  return envInt(process.env.KEYWORD_SCRAPE_CONCURRENCY, 6, 1, 16);
}

/** Default hard request budget for one scrapeKeywords() call. */
function defaultMaxQueries(): number {
  return envInt(process.env.KEYWORD_SCRAPE_MAX_QUERIES, 160, 1, 2000);
}

/** One query's outcome — success carries suggestions, failure carries a reason. */
type AutocompleteOutcome =
  | { ok: true; suggestions: string[] }
  | { ok: false; reason: string };

/**
 * One Google Autocomplete query. Never throws. Every failure mode is reported
 * with a distinct reason string so the caller can tell a block (http_429 /
 * unparseable_body en masse) from an outage (timeout, network_error) from a
 * real empty result (ok: true, suggestions: []). The old version collapsed all
 * four into [], which is why a network-wide block produced a cron response of
 * "0 keywords found" and no log line above warn.
 */
async function autocomplete(
  query: string,
  lang: string,
  country: string,
): Promise<AutocompleteOutcome> {
  const url =
    `${AUTOCOMPLETE_URL}?client=chrome` +
    `&q=${encodeURIComponent(query)}` +
    `&hl=${encodeURIComponent(lang)}` +
    `&gl=${encodeURIComponent(country)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/javascript, */*",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      // A 429/403 across every query means the Render egress IP is blocked,
      // not that these keywords have no suggestions. Only meaningful as a
      // rate, hence warn.
      recordPipelineError({
        site: "keyword-scraper.autocomplete",
        code: "AUTOCOMPLETE_HTTP",
        severity: "warn",
        message: `Google Autocomplete returned ${res.status}`,
        context: { status: res.status, query, lang, country },
      });
      return { ok: false, reason: `http_${res.status}` };
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      // A 200 carrying HTML is Google's "unusual traffic" interstitial — the
      // single most important signal that we are being rate limited.
      return { ok: false, reason: "unparseable_body" };
    }
    // Chrome client shape: [query, [suggestions...], ...].
    if (Array.isArray(data) && Array.isArray(data[1])) {
      return { ok: true, suggestions: (data[1] as unknown[]).map((s) => String(s)) };
    }
    return { ok: false, reason: "unexpected_payload_shape" };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const reason = name === "AbortError" ? "timeout" : "network_error";
    recordPipelineError({
      site: "keyword-scraper.autocomplete",
      code: "AUTOCOMPLETE_FAILED",
      severity: "warn",
      message: `Google Autocomplete request ${reason}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      context: { query, lang, country, reason },
    });
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The query list for one scrape, bounded by maxQueries.
 *
 * Bare seeds first, then "seed + letter" INTERLEAVED across seeds (every seed
 * gets "a", then every seed gets "b", …). The previous code emitted seed #1's
 * whole a–z run before touching seed #2, so any budget cut would have fully
 * expanded the first few seeds and ignored the rest entirely. Interleaving
 * makes a truncated budget degrade evenly across all of a client's seeds.
 */
export function buildQueryList(
  seeds: string[],
  alphabetSoup: boolean,
  maxQueries: number,
): string[] {
  const queries = seeds.slice(0, maxQueries);
  if (!alphabetSoup) return queries;
  for (const letter of LETTERS) {
    for (const seed of seeds) {
      if (queries.length >= maxQueries) return queries;
      queries.push(`${seed} ${letter}`);
    }
  }
  return queries;
}

/** Run async tasks with a small fixed concurrency cap. */
async function pooled<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, run),
  );
  return out;
}

/** Normalize a suggestion/seed for dedupe + storage. */
function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Expand seeds into a de-duplicated, popularity-ranked keyword list via Google
 * Autocomplete. Seeds themselves are not emitted unless Google echoes them.
 *
 * Fail-safe but no longer silent: individual query failures are skipped and
 * counted, and when EVERY query fails the result is flagged `blocked` so the
 * caller can alert instead of quietly keeping stale rows.
 */
export async function scrapeKeywords(
  seeds: string[],
  opts: ScrapeOptions = {},
): Promise<ScrapeResult> {
  const lang = opts.lang?.trim() || "en";
  const country = opts.country?.trim() || "us";
  const alphabetSoup = opts.alphabetSoup !== false;
  const maxSeeds = opts.maxSeeds ?? 12;
  const limit = opts.limit ?? 300;
  const maxQueries = opts.maxQueries ?? defaultMaxQueries();

  const empty: ScrapeResult = {
    keywords: [],
    queriesAttempted: 0,
    queriesSucceeded: 0,
    queriesFailed: 0,
    blocked: false,
    failureReasons: [],
  };

  const cleanSeeds = Array.from(
    new Set(seeds.map(normalize).filter(Boolean)),
  ).slice(0, maxSeeds);
  if (cleanSeeds.length === 0) return empty;

  const queries = buildQueryList(cleanSeeds, alphabetSoup, maxQueries);
  if (queries.length === 0) return empty;

  const results = await pooled(
    queries,
    (q) => autocomplete(q, lang, country),
    scrapeConcurrency(),
  );

  // Aggregate: hitCount = number of queries surfacing the term; bestPosition =
  // lowest index it appeared at across queries.
  const agg = new Map<string, { hitCount: number; bestPosition: number }>();
  const reasons = new Map<string, number>();
  let queriesSucceeded = 0;

  for (const outcome of results) {
    if (!outcome.ok) {
      reasons.set(outcome.reason, (reasons.get(outcome.reason) ?? 0) + 1);
      continue;
    }
    queriesSucceeded++;
    outcome.suggestions.forEach((raw, idx) => {
      const kw = normalize(raw);
      if (!kw || kw.length > 200) return;
      const prev = agg.get(kw);
      if (prev) {
        prev.hitCount += 1;
        if (idx < prev.bestPosition) prev.bestPosition = idx;
      } else {
        agg.set(kw, { hitCount: 1, bestPosition: idx });
      }
    });
  }

  const keywords = Array.from(agg.entries())
    .map(([keyword, v]) => ({
      keyword,
      hitCount: v.hitCount,
      bestPosition: v.bestPosition,
      source: "google_autocomplete" as const,
    }))
    .sort(
      (a, b) =>
        b.hitCount - a.hitCount ||
        a.bestPosition - b.bestPosition ||
        a.keyword.length - b.keyword.length,
    )
    .slice(0, limit);

  return {
    keywords,
    queriesAttempted: queries.length,
    queriesSucceeded,
    queriesFailed: queries.length - queriesSucceeded,
    blocked: queriesSucceeded === 0,
    failureReasons: Array.from(reasons.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([reason, n]) => `${reason} x${n}`),
  };
}
