/**
 * Search Console performance sync — pulls searchanalytics.query for every
 * verified property and upserts into search_performance.
 *
 * Two modes, same machinery:
 *
 *   daily     A short trailing window (default 5 days) with dataState "all",
 *             re-pulled every run. Google keeps revising the most recent ~3
 *             days after first publishing them, so a plain INSERT would leave
 *             the network permanently under-counting. Upserting a trailing
 *             window converges on the final numbers.
 *
 *   backfill  The 16-month historical window with dataState "final", walked in
 *             30-day chunks oldest-first so a timeout loses at most one chunk
 *             and a re-run resumes. Stamps blogs.gscBackfilledAt on completion.
 *
 * Search Console retains 16 months and no more. A month not pulled before it
 * ages out is gone permanently — which is why the backfill is a day-one task,
 * not a nice-to-have.
 */

import crypto from "crypto";
import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { blogs as blogsTable, searchPerformance } from "@/lib/db/schema";
import { sendGenericEmail } from "@/lib/services/email";
import {
  gscConfigured,
  querySearchAnalytics,
  SEARCH_ANALYTICS_ROW_LIMIT,
  type SearchAnalyticsRow,
} from "@/lib/services/gsc-client";

/** Rows per INSERT statement. Postgres caps a statement at 65,535 bind
 * parameters and each row here binds 9, so 500 rows = 4,500 parameters with a
 * wide margin. Same constant and same reasoning as the bulk blog import. */
const UPSERT_CHUNK = 500;

/** Hard stop on pagination for one window: 8 x 25,000 = 200,000 rows. A blog
 * that hits this is either enormous or the window is wrong; either way, stop
 * rather than loop. */
const MAX_PAGES_PER_WINDOW = 8;

// ─── Date helpers ────────────────────────────────────────────────────────────

/**
 * "Today" as Search Console means it.
 *
 * Search Console reports in America/Los_Angeles, NOT UTC. Between 00:00 and
 * ~08:00 UTC the server's UTC date is a day Google has not opened yet, and
 * asking for it returns zero rows with a 200 — a silent, self-inflicted data
 * gap that looks exactly like "this site has no traffic".
 *
 * en-CA formats as YYYY-MM-DD, which is precisely the API's date format.
 */
export function gscToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Shift a YYYY-MM-DD string by whole days. Anchored to UTC midnight so the
 * host's local timezone and DST can never move the result. */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── Row identity ────────────────────────────────────────────────────────────

export const MAX_QUERY_LEN = 500;
export const MAX_PAGE_LEN = 2048;

/**
 * Uniqueness key for a (query, page) pair within one (blog, date).
 *
 * The natural key is (blog_id, date, query, page), but a btree index entry
 * cannot exceed ~2,704 bytes and query + page in UTF-8 can. A natural unique
 * index would work for months and then abort an entire 500-row upsert batch
 * the first time one long URL arrives. Hashing pins the key at 64 bytes.
 *
 * MUST be fed the already-truncated values so the hash always describes what is
 * actually stored — see upsertRows.
 */
export function rowHash(query: string, page: string): string {
  return crypto.createHash("sha256").update(`${query}\u0000${page}`).digest("hex");
}

// ─── Sharding + concurrency ──────────────────────────────────────────────────

/**
 * Deterministic shard assignment, mirroring shardForBlog in
 * content-generation-actions.ts.
 *
 * Duplicated rather than imported: that file carries "use server", and Next.js
 * only permits async function exports from such a module, so a synchronous
 * helper cannot be re-exported from it.
 *
 * Uses SHA1 bytes 16-23, distinct from preferredHourForBlog (bytes 0-7) and
 * from the publish shard (bytes 8-15), so a blog's GSC sync slot is
 * uncorrelated with both. That is intentional — these are independent concerns
 * and correlating them would cluster load.
 */
export function gscShardForBlog(blogId: string, shardCount: number): number {
  if (shardCount <= 1) return 0;
  const hex = crypto.createHash("sha1").update(blogId).digest("hex").slice(16, 24);
  return parseInt(hex, 16) % shardCount;
}

/**
 * Bounded-concurrency map. Results are written at their input index rather than
 * pushed, so the returned array is in input order.
 */
async function runInParallel<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(concurrency, items.length)) },
      () => worker(),
    ),
  );
  return results;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

interface SyncTarget {
  id: string;
  clientId: string;
  domain: string;
  gscSiteUrl: string;
}

/**
 * Upsert one page of API rows. Conflict target is the unique index
 * (blog_id, date, row_hash); on conflict every metric is overwritten with the
 * incoming value, which is exactly what a re-pull of a revised day should do.
 * query and page are refreshed too so a truncation-length change repairs itself.
 */
async function upsertRows(blog: SyncTarget, rows: SearchAnalyticsRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const now = new Date();
    await db
      .insert(searchPerformance)
      .values(
        chunk.map((r) => {
          const query = r.query.slice(0, MAX_QUERY_LEN);
          const page = r.page.slice(0, MAX_PAGE_LEN);
          return {
            blogId: blog.id,
            clientId: blog.clientId,
            date: r.date,
            query,
            page,
            rowHash: rowHash(query, page),
            clicks: r.clicks,
            impressions: r.impressions,
            // Drizzle maps numeric to string on the way in and out.
            position: r.position.toFixed(2),
          };
        }),
      )
      .onConflictDoUpdate({
        target: [
          searchPerformance.blogId,
          searchPerformance.date,
          searchPerformance.rowHash,
        ],
        set: {
          clicks: sql`excluded.clicks`,
          impressions: sql`excluded.impressions`,
          position: sql`excluded.position`,
          query: sql`excluded.query`,
          page: sql`excluded.page`,
          clientId: sql`excluded.client_id`,
          updatedAt: now,
        },
      });
  }
}

// ─── The pull ────────────────────────────────────────────────────────────────

/** Pull and persist one date window, paginating until Google stops filling
 * pages. Each page is committed before the next is requested, so a mid-window
 * timeout keeps everything already written. */
async function syncWindow(
  blog: SyncTarget,
  startDate: string,
  endDate: string,
  dataState: "final" | "all",
): Promise<{ rows: number; requests: number }> {
  let startRow = 0;
  let rows = 0;
  let requests = 0;
  for (let page = 0; page < MAX_PAGES_PER_WINDOW; page++) {
    const res = await querySearchAnalytics({
      siteUrl: blog.gscSiteUrl,
      startDate,
      endDate,
      startRow,
      dataState,
    });
    requests++;
    if (res.rows.length > 0) {
      await upsertRows(blog, res.rows);
      rows += res.rows.length;
    }
    if (!res.hasMore) break;
    startRow += SEARCH_ANALYTICS_ROW_LIMIT;
  }
  return { rows, requests };
}

/** Daily trailing window. endDate is yesterday (Pacific) because today is
 * always partial; dataState "all" deliberately accepts the unsettled tail and
 * relies on tomorrow's upsert to correct it. */
async function syncBlogDaily(
  blog: SyncTarget,
  days: number,
): Promise<{ rows: number; requests: number; startDate: string; endDate: string }> {
  const endDate = shiftDate(gscToday(), -1);
  const startDate = shiftDate(endDate, -(days - 1));
  const r = await syncWindow(blog, startDate, endDate, "all");
  return { ...r, startDate, endDate };
}

/** 16 months, walked oldest-first in 30-day windows with settled data only.
 * ~17 windows per blog, so ~17 API calls — trivial against the 30M/day project
 * quota, but real wall-clock time, which is why the route caps the batch. */
async function backfillBlog(
  blog: SyncTarget,
  months: number,
): Promise<{ rows: number; requests: number; startDate: string; endDate: string }> {
  const endDate = shiftDate(gscToday(), -3);
  const startDate = shiftDate(endDate, -Math.round(months * 30.44));
  let rows = 0;
  let requests = 0;
  let cursor = startDate;
  while (cursor <= endDate) {
    const candidate = shiftDate(cursor, 29);
    const windowEnd = candidate > endDate ? endDate : candidate;
    const r = await syncWindow(blog, cursor, windowEnd, "final");
    rows += r.rows;
    requests += r.requests;
    cursor = shiftDate(windowEnd, 1);
  }
  return { rows, requests, startDate, endDate };
}

// ─── The runner ──────────────────────────────────────────────────────────────

export interface GscSyncOptions {
  shardIndex?: number;
  shardCount?: number;
  /** Max blogs this run. 0 means "do not sync" — used by the alert-only cron. */
  limit?: number;
  /** Trailing window length in days for the daily pull. Default 5. */
  days?: number;
  backfill?: boolean;
  months?: number;
  blogId?: string;
  concurrency?: number;
}

export interface BlogSyncOutcome {
  blogId: string;
  domain: string;
  status: "synced" | "failed";
  rows?: number;
  requests?: number;
  startDate?: string;
  endDate?: string;
  message?: string;
}

export interface GscSyncSummary {
  mode: "daily" | "backfill";
  configured: boolean;
  shardIndex: number;
  shardCount: number;
  considered: number;
  synced: number;
  failed: number;
  rowsUpserted: number;
  apiRequests: number;
  /** Backfill mode only: blogs in THIS shard still awaiting a backfill after
   *  this run. Poll until it reaches 0. */
  remainingBackfill?: number;
  totalDurationMs: number;
  results: BlogSyncOutcome[];
}

export async function runGscSync(opts: GscSyncOptions = {}): Promise<GscSyncSummary> {
  const startedAt = Date.now();
  const shardCount = Math.max(1, opts.shardCount ?? 1);
  const shardIndex = Math.min(Math.max(0, opts.shardIndex ?? 0), shardCount - 1);
  const backfill = opts.backfill === true;
  const limit = opts.limit ?? (backfill ? 25 : 500);
  const days = Math.max(1, opts.days ?? 5);
  const months = Math.min(16, Math.max(1, opts.months ?? 16));
  const concurrency = Math.max(
    1,
    Math.min(10, opts.concurrency ?? (Number(process.env.GSC_SYNC_CONCURRENCY ?? 5) || 5)),
  );

  const base: GscSyncSummary = {
    mode: backfill ? "backfill" : "daily",
    configured: gscConfigured(),
    shardIndex,
    shardCount,
    considered: 0,
    synced: 0,
    failed: 0,
    rowsUpserted: 0,
    apiRequests: 0,
    totalDurationMs: 0,
    results: [],
  };

  // Soft no-op so the cron container gets a 200 and Render does not mark the
  // job failed on an environment that simply has no service account.
  if (!base.configured || limit <= 0) {
    return { ...base, totalDurationMs: Date.now() - startedAt };
  }

  const conds: SQL[] = [
    eq(blogsTable.status, "active"),
    isNotNull(blogsTable.gscVerifiedAt),
    isNotNull(blogsTable.gscSiteUrl),
  ];
  if (backfill) conds.push(isNull(blogsTable.gscBackfilledAt));
  if (opts.blogId) conds.push(eq(blogsTable.id, opts.blogId));

  // Never-synced blogs first, then least-recently-synced. A shard that cannot
  // finish its whole set inside maxDuration simply resumes where it left off on
  // the next run — the ordering makes the backlog self-draining rather than
  // starving the tail.
  const rows = await db
    .select({
      id: blogsTable.id,
      clientId: blogsTable.clientId,
      domain: blogsTable.domain,
      gscSiteUrl: blogsTable.gscSiteUrl,
    })
    .from(blogsTable)
    .where(and(...conds))
    .orderBy(sql`${blogsTable.gscLastSyncedAt} ASC NULLS FIRST`);

  // Narrow away the nullable column the schema still declares.
  const targets: SyncTarget[] = rows.flatMap((r) =>
    r.gscSiteUrl
      ? [{ id: r.id, clientId: r.clientId, domain: r.domain, gscSiteUrl: r.gscSiteUrl }]
      : [],
  );

  // Shard in JS after the fetch, exactly as runAutoPublishCron does. The
  // candidate row is four small columns, so pulling all ~1,500 and discarding
  // 3/4 costs less than a round trip.
  const mine =
    shardCount > 1
      ? targets.filter((b) => gscShardForBlog(b.id, shardCount) === shardIndex)
      : targets;
  const batch = mine.slice(0, limit);

  if (shardCount > 1) {
    console.info(
      `[gsc-sync] shard ${shardIndex + 1}/${shardCount} — ` +
        `${mine.length} of ${targets.length} verified blogs assigned to this shard, ` +
        `processing ${batch.length}`,
    );
  }

  const outcomes = await runInParallel(
    batch,
    concurrency,
    async (blog): Promise<BlogSyncOutcome> => {
      try {
        const r = backfill
          ? await backfillBlog(blog, months)
          : await syncBlogDaily(blog, days);
        const now = new Date();
        await db
          .update(blogsTable)
          .set(
            backfill
              ? { gscBackfilledAt: now, gscLastSyncedAt: now, updatedAt: now }
              : { gscLastSyncedAt: now, updatedAt: now },
          )
          .where(eq(blogsTable.id, blog.id));
        return {
          blogId: blog.id,
          domain: blog.domain,
          status: "synced",
          rows: r.rows,
          requests: r.requests,
          startDate: r.startDate,
          endDate: r.endDate,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[gsc-sync] FAILED ${blog.domain}: ${message.slice(0, 200)}`);
        return { blogId: blog.id, domain: blog.domain, status: "failed", message };
      }
    },
  );

  const synced = outcomes.filter((o) => o.status === "synced").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  const rowsUpserted = outcomes.reduce((n, o) => n + (o.rows ?? 0), 0);
  const apiRequests = outcomes.reduce((n, o) => n + (o.requests ?? 0), 0);
  const totalDurationMs = Date.now() - startedAt;

  console.info(
    `[gsc-sync] ${base.mode} batch complete in ${totalDurationMs}ms — ` +
      `synced=${synced} failed=${failed} rows=${rowsUpserted} apiRequests=${apiRequests} ` +
      `(shard=${shardIndex}/${shardCount}, limit=${limit}, concurrency=${concurrency})`,
  );

  return {
    ...base,
    considered: batch.length,
    synced,
    failed,
    rowsUpserted,
    apiRequests,
    ...(backfill ? { remainingBackfill: Math.max(0, mine.length - synced) } : {}),
    totalDurationMs,
    results: outcomes,
  };
}

// ─── The alert ───────────────────────────────────────────────────────────────

export interface SuppressedBlogRow {
  blogId: string;
  domain: string;
  clientName: string;
  publishedPosts: number;
  impressions28d: number;
  clicks28d: number;
  verifiedAt: string;
}

/**
 * THE alert this whole task exists to make possible.
 *
 * A blog with a real archive and effectively no impressions is not
 * "underperforming". It is absent from the index or algorithmically suppressed,
 * and no amount of content tuning, meta rewriting or internal linking will
 * change that. It needs a different investigation entirely, and until now the
 * platform had no way to tell the two apart.
 *
 * Threshold: more than 30 published posts and fewer than 10 total impressions
 * across 28 days. Ten impressions in four weeks is below what a single
 * accidental brand search produces.
 *
 * Two guards keep it honest — without them this fires on every healthy site:
 *   - the property must have been verified at least 28 days ago, otherwise the
 *     28-day window extends back past the point where we could see anything;
 *   - the property must have synced within the last 3 days, so a broken cron
 *     reads as a broken cron and not as 1,500 suppressed sites.
 */
export async function findSuppressedBlogs(): Promise<SuppressedBlogRow[]> {
  const result = await db.execute(sql`
    SELECT
      b.id::text                                AS blog_id,
      b.domain                                  AS domain,
      c.name                                    AS client_name,
      p.published_posts                         AS published_posts,
      COALESCE(s.impressions_28d, 0)            AS impressions_28d,
      COALESCE(s.clicks_28d, 0)                 AS clicks_28d,
      to_char(b.gsc_verified_at, 'YYYY-MM-DD')  AS verified_at
    FROM blogs b
    JOIN clients c ON c.id = b.client_id
    JOIN LATERAL (
      SELECT count(*)::int AS published_posts
      FROM generated_posts gp
      WHERE gp.blog_id = b.id
        AND gp.status = 'published'
    ) p ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(sum(sp.impressions), 0)::bigint AS impressions_28d,
        COALESCE(sum(sp.clicks), 0)::bigint      AS clicks_28d
      FROM search_performance sp
      WHERE sp.blog_id = b.id
        AND sp.date >= (CURRENT_DATE - INTERVAL '28 days')
    ) s ON TRUE
    WHERE b.status = 'active'
      AND b.gsc_verified_at IS NOT NULL
      AND b.gsc_verified_at <= now() - INTERVAL '28 days'
      AND b.gsc_last_synced_at IS NOT NULL
      AND b.gsc_last_synced_at >= now() - INTERVAL '3 days'
      AND p.published_posts > 30
      AND COALESCE(s.impressions_28d, 0) < 10
    ORDER BY p.published_posts DESC, b.domain ASC
  `);

  // The neon-http driver returns { rows }, but tolerate a bare array the same
  // way the migration runner does.
  const raw = (Array.isArray(result) ? result : result.rows) as Array<
    Record<string, unknown>
  >;
  return raw.map((r) => ({
    blogId: String(r.blog_id),
    domain: String(r.domain),
    clientName: String(r.client_name),
    publishedPosts: Number(r.published_posts),
    impressions28d: Number(r.impressions_28d),
    clicks28d: Number(r.clicks_28d),
    verifiedAt: String(r.verified_at),
  }));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Email the suppressed list to the operator inbox. Never throws — the caller is
 * a cron route and the JSON summary is the real deliverable; email is a
 * convenience. Returns why it did not send when it did not.
 */
export async function sendSuppressedBlogsAlert(
  rows: SuppressedBlogRow[],
): Promise<{ sent: boolean; message?: string }> {
  const to = process.env.GSC_ALERT_EMAIL?.trim();
  if (!to) return { sent: false, message: "GSC_ALERT_EMAIL is not set" };
  if (rows.length === 0) return { sent: false, message: "no suppressed blogs" };

  const body = rows
    .map(
      (r) =>
        `<tr>` +
        `<td>${escapeHtml(r.domain)}</td>` +
        `<td>${escapeHtml(r.clientName)}</td>` +
        `<td align="right">${r.publishedPosts}</td>` +
        `<td align="right">${r.impressions28d}</td>` +
        `<td align="right">${r.clicks28d}</td>` +
        `<td>${escapeHtml(r.verifiedAt)}</td>` +
        `</tr>`,
    )
    .join("");

  const html =
    `<div style="font-family: sans-serif; max-width: 760px;">` +
    `<h2 style="color:#111;">${rows.length} blog(s) look suppressed or unindexed</h2>` +
    `<p>Each of these has more than 30 published posts and fewer than 10 Search Console ` +
    `impressions over the last 28 days. That is an indexing or suppression problem, not a ` +
    `content-tuning problem — check index_coverage for these blogs before changing anything else.</p>` +
    `<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;font-size:13px;">` +
    `<thead><tr>` +
    `<th align="left">Domain</th><th align="left">Client</th><th>Posts</th>` +
    `<th>Impr. 28d</th><th>Clicks 28d</th><th align="left">Verified</th>` +
    `</tr></thead><tbody>${body}</tbody></table></div>`;

  try {
    await sendGenericEmail(
      to,
      `NetGrid: ${rows.length} suppressed or unindexed blog(s)`,
      html,
    );
    return { sent: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[gsc-sync] alert email failed: ${message.slice(0, 200)}`);
    return { sent: false, message };
  }
}
