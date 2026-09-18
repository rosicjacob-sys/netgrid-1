import { db } from "@/lib/db";
import { blogs, postVerifications } from "@/lib/db/schema";
import { asc, eq, sql } from "drizzle-orm";
import { fetchRecentPosts } from "@/lib/services/platform-client";
import { logActivity } from "@/lib/services/activity-logger";
import { sendGenericEmail } from "@/lib/services/email";
import { shardForBlog } from "@/lib/cron/sharding";
import {
  blogHasCredentials,
  computeOnSchedule,
  countPostsInWindow,
  expectedPostsPerWeek,
  fetchCountForBlog,
  maxDaysBetweenPosts,
  type BlogRow,
} from "@/lib/cron/cadence";

/**
 * Post-verification sweep.
 *
 * Confirms, against each client's LIVE site, that posts are actually
 * appearing on the cadence we sold. This is the only monitor in the platform
 * that looks at the outside world rather than at our own counters, so it is
 * the only one that can catch "we believe we published; the platform
 * silently dropped it".
 *
 * ── Why it is sharded ──────────────────────────────────────────────
 * Every blog costs at least one live HTTPS request (WordPress) or two
 * (Shopify: listBlogs + articles). At ~1,500 active blogs a sequential
 * sweep needs 12-40 minutes and cannot finish inside any host's request
 * timeout. The previous implementation was exactly that sweep, under
 * `curl --max-time 660 --retry 3`: it never finished, and because curl
 * classifies a timeout as transient, it was retried up to three more times
 * while the abandoned handler kept running — four overlapping sweeps
 * hammering the same client sites and writing duplicate rows.
 *
 * ── How no blog gets starved ───────────────────────────────────────
 * Candidates are ordered by max(post_verifications.checked_at) ASC NULLS
 * FIRST. Anything a run could not reach is older than everything it did
 * reach, so it is at the front of the next run. No cursor column, nothing
 * to reset, and blogs never verified at all sort first of all. The old
 * loop had no ORDER BY, always started at index 0 and always died partway
 * through, so the tail of the heap order was never verified — not late,
 * never — and the admin table hides blogs with no verification row.
 */

/** Rows per multi-row INSERT. Neon's HTTP driver is one round trip per
 *  statement, so batching is the difference between ~2 and ~750 calls. */
const INSERT_CHUNK = 200;

/** Cap on how many entries of each list we keep in the API response and in
 *  the persisted summary — a 1,500-entry array helps nobody. */
const LIST_CAP_RESPONSE = 100;
const LIST_CAP_PERSISTED = 50;

function clampInt(value: unknown, min: number, max: number, def: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return def;
  return Math.max(min, Math.min(max, n));
}

export interface PostVerificationOptions {
  shardIndex?: number;
  shardCount?: number;
  /** Hard cap on blogs attempted this run (per shard). Safety valve. */
  limit?: number;
  concurrency?: number;
  /** Stop dispatching new blogs once this much wall clock has elapsed. */
  budgetMs?: number;
  /** Run the retention prune. Defaults to true on shard 0 only, so four
   *  concurrent shards don't issue four concurrent DELETEs. */
  prune?: boolean;
  checkType?: "scheduled" | "manual";
}

export interface VerificationFailure {
  blogId: string;
  domain: string;
  error: string;
}

export interface BehindBlog {
  blogId: string;
  clientId: string;
  domain: string;
  daysSinceLastPost: number | null;
  postsInPeriod: number;
  expectedPosts: number;
}

export interface PostVerificationResult {
  shardIndex: number;
  shardCount: number;
  concurrency: number;
  /** Active blogs assigned to this shard. */
  shardBlogs: number;
  /** Shard blogs with usable credentials — the coverage denominator. */
  eligible: number;
  skippedNoCredentials: number;
  /** Eligible blogs with NO cadence configured: they can never be due,
   *  which is a configuration defect, not a healthy state (see T17). */
  noCadence: number;
  attempted: number;
  verified: number;
  failed: number;
  deferred: number;
  overLimit: number;
  behind: number;
  /** Verified blogs whose 7-day live count is under their weekly target. */
  shortfall: number;
  truncatedWindows: number;
  coveragePct: number;
  pruned: number;
  durationMs: number;
  alertReasons: string[];
  failures: VerificationFailure[];
  behindBlogs: BehindBlog[];
}

/**
 * Bounded-parallelism map that preserves input order in the output.
 * (The variant in src/app/api/cron/seo-scan/route.ts pushes results as they
 * finish and therefore scrambles order; we index instead, because the caller
 * folds outcomes back against the input list.)
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const width = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

export async function runPostVerificationSweep(
  options: PostVerificationOptions = {},
): Promise<PostVerificationResult> {
  const startedAt = Date.now();
  // One timestamp for the whole run: it makes a sweep groupable in SQL and
  // keeps daysSinceLastPost consistent across the run.
  const runAt = new Date();

  const shardCount = clampInt(options.shardCount, 1, 64, 1);
  const shardIndex = clampInt(options.shardIndex, 0, shardCount - 1, 0);
  const concurrency = clampInt(
    options.concurrency ?? process.env.POST_VERIFICATION_CONCURRENCY,
    1,
    20,
    6,
  );
  const limit = clampInt(
    options.limit ?? process.env.POST_VERIFICATION_LIMIT,
    1,
    5000,
    600,
  );
  const budgetMs = clampInt(
    options.budgetMs ?? process.env.POST_VERIFICATION_BUDGET_MS,
    30_000,
    900_000,
    240_000,
  );
  const checkType = options.checkType ?? "scheduled";
  const shouldPrune = options.prune ?? shardIndex === 0;

  // ── 1. Candidates, least-recently-verified FIRST. ──────────────────
  const lastChecked = db
    .select({
      blogId: postVerifications.blogId,
      lastCheckedAt: sql<string | null>`max(${postVerifications.checkedAt})`.as(
        "last_checked_at",
      ),
    })
    .from(postVerifications)
    .groupBy(postVerifications.blogId)
    .as("last_checked");

  const candidates = await db
    .select({ blog: blogs, lastCheckedAt: lastChecked.lastCheckedAt })
    .from(blogs)
    .leftJoin(lastChecked, eq(lastChecked.blogId, blogs.id))
    .where(eq(blogs.status, "active"))
    .orderBy(sql`${lastChecked.lastCheckedAt} asc nulls first`, asc(blogs.id));

  // ── 2. Shard, then credential filter. ──────────────────────────────
  // Blogs without credentials are NOT counted against coverage: we cannot
  // verify them and that is a separate (already visible) defect.
  const shardRows =
    shardCount <= 1
      ? candidates
      : candidates.filter(
          (r) => shardForBlog(r.blog.id, shardCount) === shardIndex,
        );

  const eligible: BlogRow[] = [];
  let skippedNoCredentials = 0;
  let noCadence = 0;
  for (const { blog } of shardRows) {
    if (!blogHasCredentials(blog)) {
      skippedNoCredentials++;
      continue;
    }
    if (expectedPostsPerWeek(blog) === 0) noCadence++;
    eligible.push(blog);
  }

  const batch = eligible.slice(0, limit);
  const overLimit = eligible.length - batch.length;

  // ── 3. Fetch live post lists under concurrency AND a wall clock. ───
  type Outcome =
    | {
        kind: "verified";
        blog: BlogRow;
        row: typeof postVerifications.$inferInsert;
        latestTitle: string | null;
        behind: boolean;
        short: boolean;
        truncated: boolean;
        daysSinceLastPost: number | null;
        postsInPeriod: number;
        expectedPosts: number;
      }
    | { kind: "failed"; blogId: string; domain: string; error: string }
    | { kind: "deferred" };

  const outcomes = await mapWithConcurrency<BlogRow, Outcome>(
    batch,
    concurrency,
    async (blog) => {
      // Budget guard: stop DISPATCHING, don't abandon work in flight.
      if (Date.now() - startedAt > budgetMs) return { kind: "deferred" };

      const expectedPosts = expectedPostsPerWeek(blog);
      const fetchCount = fetchCountForBlog(expectedPosts);

      try {
        const posts = await fetchRecentPosts(blog, fetchCount);
        const latestPost = posts[0];
        const latestPostDate = latestPost?.publishedAt ?? null;
        const daysSinceLastPost = latestPostDate
          ? Math.ceil(
              (runAt.getTime() - latestPostDate.getTime()) /
                (1000 * 60 * 60 * 24),
            )
          : null;
        const postsInPeriod = countPostsInWindow(posts, runAt);
        // Every row we pulled falls inside the window AND we hit the fetch
        // ceiling => the true count is >= postsInPeriod. Only reachable on a
        // blog publishing far ABOVE cadence, so it can never mask a
        // shortfall — but we record it so the number isn't quietly wrong.
        const truncated =
          posts.length >= fetchCount && postsInPeriod === posts.length;
        const maxGap = maxDaysBetweenPosts(blog);
        const onSchedule = computeOnSchedule(
          blog,
          daysSinceLastPost,
          maxGap,
          runAt,
        );

        return {
          kind: "verified",
          blog,
          latestTitle: latestPost?.title || null,
          behind: !onSchedule,
          short: expectedPosts > 0 && postsInPeriod < expectedPosts,
          truncated,
          daysSinceLastPost,
          postsInPeriod,
          expectedPosts,
          row: {
            blogId: blog.id,
            clientId: blog.clientId,
            checkType,
            latestPostDate,
            latestPostTitle: latestPost?.title || null,
            latestPostUrl: latestPost?.url || null,
            postsInPeriod,
            expectedPosts,
            onSchedule,
            daysSinceLastPost,
            alertTriggered: !onSchedule,
            checkedAt: runAt,
          },
        };
      } catch (error) {
        // No post_verifications row on failure — deliberately, so a transient
        // network blip cannot flip a healthy blog to "Behind" in the admin
        // table and in the client's monthly PDF. The blog is counted against
        // coverage instead, and named in the persisted run summary.
        return {
          kind: "failed",
          blogId: blog.id,
          domain: blog.domain,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  // ── 4. Fold, then write in batches. ────────────────────────────────
  const rowsToInsert: (typeof postVerifications.$inferInsert)[] = [];
  const titleUpdates: { blogId: string; title: string }[] = [];
  const failures: VerificationFailure[] = [];
  const behindBlogs: BehindBlog[] = [];
  let verified = 0;
  let deferred = 0;
  let shortfall = 0;
  let truncatedWindows = 0;

  for (const outcome of outcomes) {
    if (outcome.kind === "deferred") {
      deferred++;
      continue;
    }
    if (outcome.kind === "failed") {
      failures.push({
        blogId: outcome.blogId,
        domain: outcome.domain,
        error: outcome.error,
      });
      continue;
    }
    verified++;
    rowsToInsert.push(outcome.row);
    if (outcome.truncated) truncatedWindows++;
    if (outcome.short) shortfall++;
    if (
      outcome.latestTitle &&
      outcome.latestTitle !== outcome.blog.lastPostTitle
    ) {
      titleUpdates.push({ blogId: outcome.blog.id, title: outcome.latestTitle });
    }
    if (outcome.behind) {
      behindBlogs.push({
        blogId: outcome.blog.id,
        clientId: outcome.blog.clientId,
        domain: outcome.blog.domain,
        daysSinceLastPost: outcome.daysSinceLastPost,
        postsInPeriod: outcome.postsInPeriod,
        expectedPosts: outcome.expectedPosts,
      });
    }
  }

  for (let i = 0; i < rowsToInsert.length; i += INSERT_CHUNK) {
    await db
      .insert(postVerifications)
      .values(rowsToInsert.slice(i, i + INSERT_CHUNK));
  }

  // blogs.lastPostTitle is the ONLY blog column this sweep still writes, and
  // only when the live title actually changed (so a steady-state run issues
  // zero UPDATEs).
  //
  // blogs.lastPostVerifiedAt is deliberately NOT written any more. That
  // column is the auto-publish priority key ("most overdue first") and the
  // publish path is its only correct writer. Stamping it here on every blog
  // every 6h flattens that ordering into noise — and the damage is only
  // partial today because the sweep reaches only part of the network.
  // Fixing coverage would have made it total.
  for (const u of titleUpdates) {
    await db
      .update(blogs)
      .set({ lastPostTitle: u.title })
      .where(eq(blogs.id, u.blogId));
  }

  const pruned = shouldPrune ? await prunePostVerifications() : 0;

  // ── 5. Coverage, alert evaluation, persistence. ────────────────────
  const coveragePct =
    eligible.length === 0
      ? 100
      : Math.round((verified / eligible.length) * 1000) / 10;

  const minCoveragePct = clampInt(
    process.env.POST_VERIFICATION_MIN_COVERAGE_PCT,
    0,
    100,
    90,
  );
  const behindAlertMin = clampInt(
    process.env.POST_VERIFICATION_BEHIND_ALERT,
    1,
    100_000,
    10,
  );
  const silentDays = clampInt(
    process.env.POST_VERIFICATION_SILENT_DAYS,
    2,
    365,
    14,
  );

  // daysSinceLastPost === null means the live site has NO posts at all,
  // which is the worst case — treat it as infinitely stale, not as unknown.
  const silent = behindBlogs.filter(
    (b) => (b.daysSinceLastPost ?? Number.POSITIVE_INFINITY) >= silentDays,
  );

  const alertReasons: string[] = [];
  if (coveragePct < minCoveragePct) {
    alertReasons.push(
      `coverage ${coveragePct}% below ${minCoveragePct}% — ` +
        `${verified}/${eligible.length} eligible blogs verified ` +
        `(${failures.length} failed, ${deferred} deferred, ${overLimit} over limit)`,
    );
  }
  if (behindBlogs.length >= behindAlertMin) {
    alertReasons.push(`${behindBlogs.length} blog(s) behind schedule`);
  }
  if (silent.length > 0) {
    alertReasons.push(
      `${silent.length} blog(s) with no live post for ${silentDays}+ days: ` +
        silent.slice(0, 10).map((b) => b.domain).join(", "),
    );
  }

  const durationMs = Date.now() - startedAt;

  const result: PostVerificationResult = {
    shardIndex,
    shardCount,
    concurrency,
    shardBlogs: shardRows.length,
    eligible: eligible.length,
    skippedNoCredentials,
    noCadence,
    attempted: batch.length,
    verified,
    failed: failures.length,
    deferred,
    overLimit,
    behind: behindBlogs.length,
    shortfall,
    truncatedWindows,
    coveragePct,
    pruned,
    durationMs,
    alertReasons,
    failures: failures.slice(0, LIST_CAP_RESPONSE),
    behindBlogs: behindBlogs.slice(0, LIST_CAP_RESPONSE),
  };

  console.info(
    `[post-verification] shard ${shardIndex + 1}/${shardCount} — ` +
      `verified=${verified} failed=${failures.length} deferred=${deferred} ` +
      `behind=${behindBlogs.length} shortfall=${shortfall} ` +
      `noCadence=${noCadence} coverage=${coveragePct}% pruned=${pruned} ` +
      `in ${durationMs}ms`,
  );

  // Persist the run. Render's log buffer is not a monitoring system: this row
  // is what makes "was the network covered last night?" answerable a week
  // later. logActivity swallows its own errors, so this can never fail the
  // sweep.
  await logActivity({
    action: "post_verification_run",
    entityType: "cron",
    details: {
      ...result,
      failures: failures.slice(0, LIST_CAP_PERSISTED),
      behindBlogs: behindBlogs.slice(0, LIST_CAP_PERSISTED),
      failuresTruncated: failures.length > LIST_CAP_PERSISTED,
      behindTruncated: behindBlogs.length > LIST_CAP_PERSISTED,
    },
  });

  if (alertReasons.length > 0) {
    console.error(
      `[post-verification] ALERT shard ${shardIndex + 1}/${shardCount}: ` +
        alertReasons.join(" | "),
    );
    await sendCoverageAlert(
      shardIndex,
      shardCount,
      alertReasons,
      failures,
      behindBlogs,
    );
  }

  return result;
}

/**
 * Retention sweep for post_verifications.
 *
 * At full coverage the table gains 1,500 rows x 4 runs/day = 6,000 rows/day
 * (~2.2M/year). Two readers degrade as it grows: the admin table pulls the
 * newest 2,000 rows and dedupes in JS, and the client report counts DISTINCT
 * on-schedule blogs over a period.
 *
 * The EXISTS clause guarantees a blog's MOST RECENT row is never deleted, no
 * matter how old it is — so a blog that stopped being verified keeps its last
 * known state instead of vanishing from the dashboard. The LIMIT keeps each
 * DELETE bounded; at the default 5,000 rows per run x 4 runs/day the sweep
 * removes 20,000/day against an ingest of 6,000/day, so any backlog drains.
 */
async function prunePostVerifications(): Promise<number> {
  const retentionDays = clampInt(
    process.env.POST_VERIFICATION_RETENTION_DAYS,
    7,
    3650,
    30,
  );
  const batchSize = clampInt(
    process.env.POST_VERIFICATION_PRUNE_BATCH,
    100,
    100_000,
    5_000,
  );

  try {
    const res = await db.execute<{ id: string }>(sql`
      WITH doomed AS (
        SELECT pv.id
        FROM post_verifications pv
        WHERE pv.checked_at < now() - make_interval(days => ${retentionDays}::int)
          AND EXISTS (
            SELECT 1
            FROM post_verifications newer
            WHERE newer.blog_id = pv.blog_id
              AND newer.checked_at > pv.checked_at
          )
        LIMIT ${batchSize}
      )
      DELETE FROM post_verifications p
      USING doomed d
      WHERE p.id = d.id
      RETURNING p.id
    `);
    // Drizzle's neon-http driver returns { rows: [...] } here, not the array
    // directly.
    const rows = Array.isArray(res)
      ? res
      : ((res as unknown as { rows?: { id: string }[] }).rows ?? []);
    return rows.length;
  } catch (error) {
    // Housekeeping must never fail the sweep.
    console.error("[post-verification] prune failed:", error);
    return 0;
  }
}

/**
 * Ops alert. Sends only when ALERT_EMAIL_TO and RESEND_API_KEY are both set
 * on the WEB service; otherwise the console.error in the caller plus the
 * activity_log row are the record. Never throws.
 */
async function sendCoverageAlert(
  shardIndex: number,
  shardCount: number,
  reasons: string[],
  failures: VerificationFailure[],
  behindBlogs: BehindBlog[],
): Promise<void> {
  const to = process.env.ALERT_EMAIL_TO;
  if (!to || !process.env.RESEND_API_KEY) {
    console.error(
      "[post-verification] alert not emailed — set ALERT_EMAIL_TO and " +
        "RESEND_API_KEY on the netgrid web service",
    );
    return;
  }

  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const lines: string[] = [];
  lines.push("<h2>Post-verification alert</h2>");
  lines.push("<p><b>Shard " + (shardIndex + 1) + " of " + shardCount + "</b></p>");
  lines.push("<ul>");
  for (const r of reasons) lines.push("<li>" + esc(r) + "</li>");
  lines.push("</ul>");

  lines.push("<h3>Behind schedule (" + behindBlogs.length + ")</h3><pre>");
  for (const b of behindBlogs.slice(0, 40)) {
    lines.push(
      esc(b.domain) +
        " — " +
        (b.daysSinceLastPost ?? "no live posts") +
        "d since last live post, " +
        b.postsInPeriod +
        "/" +
        b.expectedPosts +
        " in 7d",
    );
  }
  lines.push("</pre>");

  lines.push("<h3>Fetch failures (" + failures.length + ")</h3><pre>");
  for (const f of failures.slice(0, 40)) {
    lines.push(esc(f.domain) + " — " + esc(f.error));
  }
  lines.push("</pre>");

  try {
    await sendGenericEmail(
      to,
      "[NETGRID] post-verification shard " +
        (shardIndex + 1) +
        "/" +
        shardCount +
        " unhealthy",
      '<div style="font-family:sans-serif;font-size:14px">' +
        lines.join("\n") +
        "</div>",
    );
  } catch (error) {
    // An alert that fails must never fail the sweep.
    console.error("[post-verification] alert email failed:", error);
  }
}
