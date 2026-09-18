"use server";

import { revalidatePath } from "next/cache";
import { asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { activityLog, clientKeywords, clients } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/helpers";
import { resolveNicheConfig } from "@/lib/content/niche-config-db";
import { scrapeKeywords, type ScrapedKeyword } from "@/lib/services/keyword-scraper";
import {
  resolveScrapeLocalesForClient,
  type ScrapeLocale,
} from "@/lib/content/keyword-locale";
import { shardForBlog as shardForId } from "@/lib/cron/sharding";

export type ClientKeyword = typeof clientKeywords.$inferSelect;

/** Cap on keywords stored per client per scrape (top-ranked kept). */
const STORE_LIMIT = 300;

// ─── Refresh-cron tuning ─────────────────────────────────────────────────────
// Read once at module load — Render runs a long-lived Node process, the same
// assumption MAX_BLOGS_PER_CRON_RUN makes. Change one of these and redeploy
// the WEB service (cron services have their own env sets and cannot reach
// these).

/** Read a bounded integer from env or an opts override. */
function envInt(
  raw: string | number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Clients one cron tick may scrape, per shard. */
const REFRESH_MAX_CLIENTS = envInt(process.env.KEYWORD_REFRESH_MAX_CLIENTS, 25, 1, 500);

/**
 * Wall-clock budget for the scrape phase. Must leave room inside the route's
 * maxDuration for the reaper and the ledger rebuild that follow it, and inside
 * cron/invoke.sh's curl --max-time (CRON_MAX_TIME).
 */
const REFRESH_TIME_BUDGET_MS = envInt(
  process.env.KEYWORD_REFRESH_TIME_BUDGET_MS,
  210_000,
  10_000,
  540_000,
);

/** A client is a candidate only once its last ATTEMPT is this old. */
const REFRESH_MIN_AGE_HOURS = envInt(process.env.KEYWORD_REFRESH_MIN_AGE_HOURS, 144, 1, 2160);

/**
 * Shard membership is a SHA1 of the client UUID and Postgres cannot compute it
 * (no pgcrypto), so the shard filter runs in JS over an over-fetched candidate
 * window.
 */
const CANDIDATE_OVERFETCH = 4;
const CANDIDATE_HARD_CAP = 2000;

/** Consecutive empty scrapes before a non-blocked client is escalated. */
const SCRAPE_ALERT_AFTER_FAILURES = 2;

/** Split a free-text seed field (newlines and/or commas) into clean terms. */
function parseSeeds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(/[\n,]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

/** What one client's scrape produced, across all of its locales. */
interface MultiLocaleScrape {
  keywords: ScrapedKeyword[];
  queriesAttempted: number;
  queriesFailed: number;
  /** True only when EVERY locale was blocked — never a real empty result. */
  blocked: boolean;
  failureReasons: string[];
}

/**
 * Scrape every locale a client needs and merge the results into ONE ranked
 * list.
 *
 * client_keywords is unique on (client_id, keyword) — there is no locale
 * dimension in the pool — so a term surfaced by two locales must be merged
 * rather than written twice: hitCount SUMS (it surfaced in more queries
 * overall) and bestPosition takes the MINIMUM (the best rank anyone saw). That
 * preserves the ordering contract topActiveClientKeywordsWithMeta depends on.
 *
 * Locales run sequentially, not concurrently: scrapeKeywords already runs
 * KEYWORD_SCRAPE_CONCURRENCY requests in parallel internally, and stacking
 * four of those would quadruple the burst rate against a single Render egress
 * IP — the thing most likely to get the source blocked.
 */
async function scrapeAcrossLocales(
  seeds: string[],
  locales: ScrapeLocale[],
): Promise<MultiLocaleScrape> {
  const merged = new Map<string, ScrapedKeyword>();
  const reasons = new Set<string>();
  let queriesAttempted = 0;
  let queriesFailed = 0;
  let localesBlocked = 0;

  for (const locale of locales) {
    const res = await scrapeKeywords(seeds, { ...locale, limit: STORE_LIMIT });
    queriesAttempted += res.queriesAttempted;
    queriesFailed += res.queriesFailed;
    if (res.blocked) localesBlocked++;
    for (const reason of res.failureReasons) {
      reasons.add(`${locale.lang}-${locale.country}: ${reason}`);
    }
    for (const k of res.keywords) {
      const prev = merged.get(k.keyword);
      if (prev) {
        prev.hitCount += k.hitCount;
        if (k.bestPosition < prev.bestPosition) prev.bestPosition = k.bestPosition;
      } else {
        merged.set(k.keyword, { ...k });
      }
    }
  }

  const keywords = Array.from(merged.values())
    .sort(
      (a, b) =>
        b.hitCount - a.hitCount ||
        a.bestPosition - b.bestPosition ||
        a.keyword.length - b.keyword.length,
    )
    .slice(0, STORE_LIMIT);

  return {
    keywords,
    queriesAttempted,
    queriesFailed,
    blocked: locales.length > 0 && localesBlocked === locales.length,
    failureReasons: Array.from(reasons).slice(0, 6),
  };
}

/**
 * Upsert one client's scraped keywords. Shared by the admin action and the
 * cron path so their conflict contracts can never diverge.
 *
 * Two columns are deliberately NOT overwritten:
 *   is_active — the operator toggle (unchanged behaviour), and
 *   source    — when the existing row is 'dataforseo'. The old unconditional
 *               `excluded.source` downgraded every paid, difficulty-bearing
 *               row back to 'google_autocomplete' on each weekly cron, while
 *               leaving its search_volume / keyword_difficulty intact — so
 *               anything filtering on source='dataforseo' (T09) found nothing.
 *
 * Inside ON CONFLICT DO UPDATE, "client_keywords"."source" refers to the
 * EXISTING row and excluded.source to the proposed one, which is what makes
 * the CASE a one-way ratchet: Autocomplete may write provenance onto a row
 * that has none, but never take it away from a paid one.
 */
async function upsertScrapedKeywords(
  clientId: string,
  scraped: ScrapedKeyword[],
): Promise<number> {
  if (scraped.length === 0) return 0;
  const now = new Date();
  const rows = await db
    .insert(clientKeywords)
    .values(
      scraped.map((k) => ({
        clientId,
        keyword: k.keyword,
        source: k.source,
        hitCount: k.hitCount,
        bestPosition: k.bestPosition,
        fetchedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [clientKeywords.clientId, clientKeywords.keyword],
      set: {
        hitCount: sql`excluded.hit_count`,
        bestPosition: sql`excluded.best_position`,
        source: sql`case when ${clientKeywords.source} = 'dataforseo' then ${clientKeywords.source} else excluded.source end`,
        fetchedAt: sql`excluded.fetched_at`,
        updatedAt: now,
      },
    })
    .returning({ id: clientKeywords.id });
  return rows.length;
}

// ─── scrapeClientKeywords ─────────────────────────────────────────────────────

/**
 * Discover keywords for a client and upsert them into client_keywords. Seeds
 * come from the client's niche key-topics plus its manual seed field. Existing
 * rows are refreshed in place (their active toggle is preserved). Fail-safe:
 * a scraper that returns nothing leaves existing rows untouched.
 */
export async function scrapeClientKeywords(clientId: string): Promise<{
  success: boolean;
  inserted: number;
  total: number;
  message: string;
}> {
  const session = await requireAdmin();

  const [client] = await db
    .select({
      id: clients.id,
      niche: clients.niche,
      keywordSeeds: clients.keywordSeeds,
      languageMode: clients.languageMode,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) return { success: false, inserted: 0, total: 0, message: "Client not found." };

  // Seeds: niche key-topics + manual seeds.
  const nicheConfig = await resolveNicheConfig(client.niche).catch(() => undefined);
  const nicheTopics = nicheConfig?.keyTopics ?? [];
  const manualSeeds = parseSeeds(client.keywordSeeds);
  const seeds = Array.from(new Set([...manualSeeds, ...nicheTopics.map((t) => t.toLowerCase())]));

  if (seeds.length === 0) {
    return {
      success: false,
      inserted: 0,
      total: 0,
      message: "No seeds — add manual seeds or set a niche with key topics first.",
    };
  }

  const locales = await resolveScrapeLocalesForClient({
    clientId,
    languageMode: client.languageMode,
    niche: client.niche,
  });
  const scrape = await scrapeAcrossLocales(seeds, locales);

  if (scrape.keywords.length === 0) {
    return {
      success: false,
      inserted: 0,
      total: await countClientKeywords(clientId),
      message: scrape.blocked
        ? `Autocomplete rejected every request (${scrape.failureReasons.join("; ") || "no detail"}). Existing keywords were left untouched — retry later or use the DataForSEO pull.`
        : "The scraper returned no keywords (seeds too narrow for these locales).",
    };
  }

  const inserted = await upsertScrapedKeywords(clientId, scrape.keywords);

  await db.insert(activityLog).values({
    userId: session.user.id,
    clientId,
    action: "keywords.scraped",
    entityType: "client",
    entityId: clientId,
    details: {
      seeds: seeds.length,
      found: scrape.keywords.length,
      locales: locales.map((l) => `${l.lang}-${l.country}`),
      queriesAttempted: scrape.queriesAttempted,
      queriesFailed: scrape.queriesFailed,
    },
  });

  revalidatePath(`/clients/${clientId}`);
  const localeLabel = locales.map((l) => `${l.lang}-${l.country}`).join(", ");
  return {
    success: true,
    inserted,
    total: await countClientKeywords(clientId),
    message: `Scraped ${scrape.keywords.length} keyword${scrape.keywords.length === 1 ? "" : "s"} from ${seeds.length} seed${seeds.length === 1 ? "" : "s"} across ${localeLabel}.`,
  };
}

async function countClientKeywords(clientId: string): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`count(*)` })
    .from(clientKeywords)
    .where(eq(clientKeywords.clientId, clientId));
  return Number(row?.c ?? 0);
}

// ─── reads + toggles ──────────────────────────────────────────────────────────

/** All keywords for a client, best-ranked first. */
export async function listClientKeywords(clientId: string): Promise<ClientKeyword[]> {
  await requireAdmin();
  return db
    .select()
    .from(clientKeywords)
    .where(eq(clientKeywords.clientId, clientId))
    .orderBy(
      // Volume when a volume-bearing source is used; else the autocomplete proxy.
      sql`${clientKeywords.searchVolume} desc nulls last`,
      desc(clientKeywords.hitCount),
      asc(clientKeywords.bestPosition),
    );
}

/** Toggle whether a keyword is fed into generation. */
export async function setClientKeywordActive(
  id: string,
  isActive: boolean,
): Promise<ClientKeyword> {
  await requireAdmin();
  const [updated] = await db
    .update(clientKeywords)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(clientKeywords.id, id))
    .returning();
  if (!updated) throw new Error("Keyword not found.");
  revalidatePath(`/clients/${updated.clientId}`);
  return updated;
}

/** Remove a keyword from a client's set. */
export async function deleteClientKeyword(id: string): Promise<void> {
  await requireAdmin();
  const [deleted] = await db
    .delete(clientKeywords)
    .where(eq(clientKeywords.id, id))
    .returning({ clientId: clientKeywords.clientId });
  if (deleted) revalidatePath(`/clients/${deleted.clientId}`);
}

/** Remove several keywords at once (multi-select batch delete). */
export async function deleteClientKeywords(
  ids: string[],
): Promise<{ success: boolean; deleted: number; message: string }> {
  await requireAdmin();
  if (ids.length === 0) return { success: true, deleted: 0, message: "Nothing selected." };
  const deleted = await db
    .delete(clientKeywords)
    .where(inArray(clientKeywords.id, ids))
    .returning({ clientId: clientKeywords.clientId });
  const clientId = deleted[0]?.clientId;
  if (clientId) revalidatePath(`/clients/${clientId}`);
  return {
    success: true,
    deleted: deleted.length,
    message: `Deleted ${deleted.length} keyword${deleted.length === 1 ? "" : "s"}.`,
  };
}

/** Save a client's manual seed terms (used by the next scrape). */
export async function updateClientKeywordSeeds(
  clientId: string,
  seeds: string,
): Promise<{ success: boolean; message: string }> {
  await requireAdmin();
  const clean = seeds.trim();
  await db
    .update(clients)
    .set({ keywordSeeds: clean || null, updatedAt: new Date() })
    .where(eq(clients.id, clientId));
  revalidatePath(`/clients/${clientId}`);
  return { success: true, message: clean ? "Seeds saved." : "Seeds cleared." };
}

// ─── cron: refresh one shard of stale clients ────────────────────────────────

export interface KeywordRefreshSummary {
  shardIndex: number;
  shardCount: number;
  /** Stale, seeded candidates visible to this run BEFORE the shard filter. */
  staleCandidates: number;
  /** How many of those belong to this shard. */
  candidatesInShard: number;
  /** Clients this run actually attempted (excludes seedless skips). */
  clientsProcessed: number;
  clientsScraped: number;
  /** Clients whose every query failed — a block, not an empty result. */
  clientsBlocked: number;
  keywordsFound: number;
  queriesAttempted: number;
  queriesFailed: number;
  /** Clients that stored keywords — the ledger rebuild is scoped to these. */
  clientIdsScraped: string[];
  /** True when the run stopped on the client cap or the time budget. */
  budgetExhausted: boolean;
  durationMs: number;
}

/**
 * Re-scrape keywords for ONE SHARD's worth of stale, seeded clients.
 *
 * Called by /api/cron/refresh-keywords, which is deployed as four parallel
 * hourly cron services (render.yaml) exactly like auto-publish. The old
 * version looped over EVERY client in one unordered pass — at ~12 s per seeded
 * client that is ~5 hours for a 1,500-client network, so the request never
 * returned, clients late in the scan never refreshed, and the ledger rebuild
 * that runs after it never executed at all.
 *
 * Three bounds now make every run finish:
 *   1. staleness — only clients whose last ATTEMPT is older than
 *      KEYWORD_REFRESH_MIN_AGE_HOURS are candidates. This is the resume
 *      cursor: it lives in clients.keywords_refresh_attempted_at, so a run
 *      that dies halfway leaves the rest still stale for the next tick. A
 *      stored cursor would drift the moment a client is inserted or deleted.
 *   2. shard — each client belongs to exactly one shard, so the four services
 *      are disjoint and never scrape the same client twice.
 *   3. cap + time budget — whichever comes first.
 *
 * The attempt stamp is written BEFORE the scrape. A client that hangs or
 * crashes the run must go to the BACK of the queue; stamping afterwards would
 * pin it at the head forever and starve the whole shard behind it.
 *
 * Never throws — a failing client is recorded and skipped.
 */
export async function refreshAllClientKeywordsInternal(
  opts: {
    shardIndex?: number;
    shardCount?: number;
    /** Override KEYWORD_REFRESH_MAX_CLIENTS for this run (?limit= on the route). */
    maxClients?: number;
    /** Override KEYWORD_REFRESH_TIME_BUDGET_MS for this run. */
    timeBudgetMs?: number;
  } = {},
): Promise<KeywordRefreshSummary> {
  const startedAt = Date.now();
  const shardCount =
    Number.isInteger(opts.shardCount) && (opts.shardCount as number) > 0
      ? (opts.shardCount as number)
      : 1;
  const shardIndex =
    Number.isInteger(opts.shardIndex) &&
    (opts.shardIndex as number) >= 0 &&
    (opts.shardIndex as number) < shardCount
      ? (opts.shardIndex as number)
      : 0;
  const maxClients = envInt(opts.maxClients, REFRESH_MAX_CLIENTS, 1, 500);
  const timeBudgetMs = envInt(opts.timeBudgetMs, REFRESH_TIME_BUDGET_MS, 10_000, 540_000);
  const staleCutoff = new Date(startedAt - REFRESH_MIN_AGE_HOURS * 3_600_000);

  const candidates = await db
    .select({
      id: clients.id,
      niche: clients.niche,
      keywordSeeds: clients.keywordSeeds,
    })
    .from(clients)
    .where(
      or(
        isNull(clients.keywordsRefreshAttemptedAt),
        lt(clients.keywordsRefreshAttemptedAt, staleCutoff),
      ),
    )
    .orderBy(
      sql`${clients.keywordsRefreshAttemptedAt} asc nulls first`,
      asc(clients.id),
    )
    .limit(Math.min(maxClients * shardCount * CANDIDATE_OVERFETCH, CANDIDATE_HARD_CAP));

  const mine = candidates.filter((c) => shardForId(c.id, shardCount) === shardIndex);

  let clientsProcessed = 0;
  let clientsScraped = 0;
  let clientsBlocked = 0;
  let keywordsFound = 0;
  let queriesAttempted = 0;
  let queriesFailed = 0;
  let budgetExhausted = false;
  const clientIdsScraped: string[] = [];

  for (const c of mine) {
    if (clientsProcessed >= maxClients || Date.now() - startedAt >= timeBudgetMs) {
      budgetExhausted = true;
      break;
    }

    const hasSeeds = parseSeeds(c.keywordSeeds).length > 0 || Boolean(c.niche?.trim());
    // Stamp seedless clients too, so they cannot sit at the head of the stale
    // queue forever and starve seeded clients behind them.
    await stampRefreshAttempt(c.id);
    if (!hasSeeds) continue;

    clientsProcessed++;
    try {
      const res = await scrapeClientKeywordsInternal(c.id);
      queriesAttempted += res.queriesAttempted;
      queriesFailed += res.queriesFailed;
      if (res.scraped > 0) {
        clientsScraped++;
        keywordsFound += res.scraped;
        clientIdsScraped.push(c.id);
        await db
          .update(clients)
          .set({ keywordsRefreshedAt: new Date(), keywordsRefreshFailures: 0 })
          .where(eq(clients.id, c.id));
      } else {
        if (res.blocked) clientsBlocked++;
        await recordScrapeFailure(c.id, res.blocked, res.failureReasons);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[refresh-keywords] client ${c.id} failed:`, message);
      await recordScrapeFailure(c.id, false, [message]);
    }
  }

  return {
    shardIndex,
    shardCount,
    staleCandidates: candidates.length,
    candidatesInShard: mine.length,
    clientsProcessed,
    clientsScraped,
    clientsBlocked,
    keywordsFound,
    queriesAttempted,
    queriesFailed,
    clientIdsScraped,
    budgetExhausted,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Advance a client's fairness cursor. Deliberately does NOT touch
 * clients.updated_at — that column is operator-facing ("last edited") and a
 * background scrape must not make every client look freshly edited every week.
 */
async function stampRefreshAttempt(clientId: string): Promise<void> {
  try {
    await db
      .update(clients)
      .set({ keywordsRefreshAttemptedAt: new Date() })
      .where(eq(clients.id, clientId));
  } catch (err) {
    console.warn(
      `[refresh-keywords] could not stamp attempt for client ${clientId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Count a failed/empty scrape and escalate when it matters.
 *
 * A BLOCKED scrape is escalated immediately: it means Autocomplete refused
 * every request, which is a source-level incident, not a property of this
 * client's seeds. A merely-empty scrape is escalated only once it repeats
 * (SCRAPE_ALERT_AFTER_FAILURES), because a brand-new client with two obscure
 * seeds legitimately returns nothing on its first pass.
 *
 * Escalation = console.error with a greppable ALERT prefix + an activity_log
 * row. The point is that the event EXISTS at all instead of vanishing into a
 * `return { scraped: 0 }`.
 */
async function recordScrapeFailure(
  clientId: string,
  blocked: boolean,
  reasons: string[],
): Promise<void> {
  try {
    const [row] = await db
      .update(clients)
      .set({ keywordsRefreshFailures: sql`${clients.keywordsRefreshFailures} + 1` })
      .where(eq(clients.id, clientId))
      .returning({ failures: clients.keywordsRefreshFailures });

    const failures = row?.failures ?? 1;
    if (!blocked && failures < SCRAPE_ALERT_AFTER_FAILURES) return;

    console.error(
      `[refresh-keywords] ALERT client ${clientId} — ` +
        `${blocked ? "scrape BLOCKED (every request rejected)" : "scrape returned nothing"}; ` +
        `consecutive failures: ${failures}; ` +
        `reasons: ${reasons.join("; ") || "none reported"}`,
    );

    await db.insert(activityLog).values({
      userId: null,
      clientId,
      action: blocked ? "keywords.scrape_blocked" : "keywords.scrape_empty",
      entityType: "client",
      entityId: clientId,
      details: { blocked, consecutiveFailures: failures, reasons },
    });
  } catch (err) {
    console.warn(
      `[refresh-keywords] could not record scrape failure for ${clientId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Cron-internal scrape for one client — same discovery + upsert as
 * scrapeClientKeywords but without the admin guard or path revalidation (runs
 * under the cron's CRON_SECRET auth), and reporting enough telemetry for the
 * caller to tell a block from an empty result.
 */
async function scrapeClientKeywordsInternal(clientId: string): Promise<{
  scraped: number;
  blocked: boolean;
  queriesAttempted: number;
  queriesFailed: number;
  failureReasons: string[];
}> {
  const empty = {
    scraped: 0,
    blocked: false,
    queriesAttempted: 0,
    queriesFailed: 0,
    failureReasons: [] as string[],
  };

  const [client] = await db
    .select({
      niche: clients.niche,
      keywordSeeds: clients.keywordSeeds,
      languageMode: clients.languageMode,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!client) return empty;

  const nicheConfig = await resolveNicheConfig(client.niche).catch(() => undefined);
  const nicheTopics = nicheConfig?.keyTopics ?? [];
  const seeds = Array.from(
    new Set([...parseSeeds(client.keywordSeeds), ...nicheTopics.map((t) => t.toLowerCase())]),
  );
  if (seeds.length === 0) return empty;

  const locales = await resolveScrapeLocalesForClient({
    clientId,
    languageMode: client.languageMode,
    niche: client.niche,
  });
  const scrape = await scrapeAcrossLocales(seeds, locales);

  if (scrape.keywords.length === 0) {
    return {
      scraped: 0,
      blocked: scrape.blocked,
      queriesAttempted: scrape.queriesAttempted,
      queriesFailed: scrape.queriesFailed,
      failureReasons: scrape.failureReasons,
    };
  }

  await upsertScrapedKeywords(clientId, scrape.keywords);
  return {
    scraped: scrape.keywords.length,
    blocked: false,
    queriesAttempted: scrape.queriesAttempted,
    queriesFailed: scrape.queriesFailed,
    failureReasons: scrape.failureReasons,
  };
}
