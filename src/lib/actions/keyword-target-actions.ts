"use server";

import { revalidatePath } from "next/cache";
import { and, asc, eq, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { blogs, blogKeywordTargets } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/helpers";
import { topActiveClientKeywordsWithMeta } from "@/lib/content/client-keywords";
import {
  buildKeywordTargetTitle,
  isEligibleKeywordTarget,
  normalizeTargetKeyword,
} from "@/lib/content/keyword-targeting";

export type BlogKeywordTarget = typeof blogKeywordTargets.$inferSelect;

/** Cap on how many of a client's top-ranked keywords become ledger candidates. */
const CANDIDATE_LIMIT = 40;

export interface BuildResult {
  blogId: string;
  city: string | null;
  targeted: boolean;
  candidatesConsidered: number;
  eligible: number;
  upserted: number;
  message: string;
}

/**
 * Distinct assigned cities across the whole network — input to the
 * keyword/city collision filter (a keyword that already names a city, its
 * own or another blog's, is not a sane target; see keyword-targeting.ts).
 */
async function knownCities(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ city: blogs.city })
    .from(blogs)
    .where(isNotNull(blogs.city));
  return rows.map((r) => r.city).filter((c): c is string => Boolean(c));
}

/**
 * Build (or refresh) one blog's keyword-target ledger from its client's
 * scraped keywords. No-ops when the blog has no city — that IS the feature's
 * on/off switch (see docs/local-keyword-content-plan.md). A rebuild only ever
 * touches ranking/title metadata: a target already
 * generating/generated/failed/skipped keeps its status untouched, since that
 * column is deliberately absent from the upsert's `set`.
 */
export async function buildKeywordTargetsForBlogInternal(blogId: string): Promise<BuildResult> {
  const [blog] = await db
    .select({ id: blogs.id, clientId: blogs.clientId, city: blogs.city })
    .from(blogs)
    .where(eq(blogs.id, blogId))
    .limit(1);

  if (!blog) {
    return {
      blogId, city: null, targeted: false,
      candidatesConsidered: 0, eligible: 0, upserted: 0,
      message: "Blog not found.",
    };
  }

  const city = blog.city;
  if (!city) {
    return {
      blogId, city: null, targeted: false,
      candidatesConsidered: 0, eligible: 0, upserted: 0,
      message: "No city assigned — this blog stays on ordinary topic ideation.",
    };
  }

  const [candidates, cities] = await Promise.all([
    topActiveClientKeywordsWithMeta(blog.clientId, CANDIDATE_LIMIT),
    knownCities(),
  ]);

  const eligible = candidates.filter((c) => isEligibleKeywordTarget(c.keyword, cities));

  if (eligible.length === 0) {
    return {
      blogId, city, targeted: true,
      candidatesConsidered: candidates.length, eligible: 0, upserted: 0,
      message:
        candidates.length === 0
          ? "This client has no active scraped keywords yet."
          : "Every scraped keyword was filtered out (navigational, or already names a city).",
    };
  }

  const now = new Date();
  const rows = eligible.map((c, index) => ({
    blogId: blog.id,
    clientId: blog.clientId,
    keyword: normalizeTargetKeyword(c.keyword),
    city,
    topicTitle: buildKeywordTargetTitle(c.keyword, city),
    // Rank snapshot at build time — lower is better. Real search volume once
    // DataForSEO lands; the Autocomplete popularity proxy until then (the
    // candidates arrive pre-sorted by topActiveClientKeywordsWithMeta).
    priority: index,
    keywordSource: c.source,
    searchVolume: c.searchVolume,
    updatedAt: now,
  }));

  const upserted = await db
    .insert(blogKeywordTargets)
    .values(rows)
    .onConflictDoUpdate({
      target: [blogKeywordTargets.blogId, blogKeywordTargets.keyword, blogKeywordTargets.city],
      set: {
        topicTitle: sql`excluded.topic_title`,
        priority: sql`excluded.priority`,
        keywordSource: sql`excluded.keyword_source`,
        searchVolume: sql`excluded.search_volume`,
        updatedAt: now,
      },
    })
    .returning({ id: blogKeywordTargets.id });

  return {
    blogId, city, targeted: true,
    candidatesConsidered: candidates.length,
    eligible: eligible.length,
    upserted: upserted.length,
    message: `${upserted.length} keyword target${upserted.length === 1 ? "" : "s"} up to date for ${city}.`,
  };
}

/** Admin-triggered on-demand rebuild for one blog (e.g. after assigning a city). */
export async function buildKeywordTargetsForBlog(blogId: string): Promise<BuildResult> {
  await requireAdmin();
  const result = await buildKeywordTargetsForBlogInternal(blogId);
  revalidatePath(`/blogs/${blogId}`);
  return result;
}

/**
 * Rebuild every active, city-bearing blog's ledger. Called by the
 * refresh-keywords cron right after the scrape (see
 * /api/cron/refresh-keywords) so new keywords automatically become new
 * targets. Never throws — a failing blog is recorded and skipped so one bad
 * blog can't stall the run.
 */
export async function rebuildAllKeywordTargetsInternal(): Promise<{
  blogsProcessed: number;
  blogsTargeted: number;
  targetsUpserted: number;
  failed: Array<{ blogId: string; error: string }>;
}> {
  const rows = await db
    .select({ id: blogs.id })
    .from(blogs)
    .where(and(isNotNull(blogs.city), eq(blogs.status, "active")));

  let blogsTargeted = 0;
  let targetsUpserted = 0;
  const failed: Array<{ blogId: string; error: string }> = [];

  for (const { id } of rows) {
    try {
      const result = await buildKeywordTargetsForBlogInternal(id);
      if (result.targeted) blogsTargeted++;
      targetsUpserted += result.upserted;
    } catch (err) {
      failed.push({
        blogId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { blogsProcessed: rows.length, blogsTargeted, targetsUpserted, failed };
}

// ─── Claim / lifecycle (called by runGenerateAndPublish) ────────────────────

export interface ClaimedKeywordTarget {
  id: string;
  keyword: string;
  city: string;
  topicTitle: string;
}

/**
 * Claim the best pending keyword target for a blog — marks it 'generating'
 * and returns it, or undefined when there's nothing to claim (no city, or
 * every target already generating/generated/failed/skipped; see
 * buildKeywordTargetsForBlogInternal for how rows get here).
 *
 * Every sibling blog of a client builds its ledger from the SAME client-wide
 * ranked keyword pool (client_keywords, see topActiveClientKeywordsWithMeta),
 * so every sibling's own #1-priority pending row tends to be the identical
 * keyword — the only thing that differed was the city templated into the
 * title. Left unchecked, a client running many sibling blogs converges on
 * the same handful of topics network-wide. So: prefer this blog's best
 * pending row whose keyword no OTHER blog of the same client is currently
 * generating or has already generated (cross-sibling reservation) — this
 * spreads the network across the pool instead of every sibling picking the
 * same top keyword. Only once every one of this blog's pending keywords is
 * already reserved by a sibling (the pool has cycled through the whole
 * client) does it fall back to this blog's plain best pending row regardless
 * of sibling reservation — i.e. rotate through the ranked pool, wrap back to
 * #1 once exhausted, rather than starving a blog of new content forever.
 *
 * Select-then-conditional-update rather than a single locking statement:
 * each blog belongs to exactly one auto-publish shard (shardForBlog), so two
 * processes never race to claim the same BLOG's rows — the status='pending'
 * re-check on the update is a defensive guard, not a correctness
 * requirement. Two SIBLING blogs claiming in the same tick (different
 * shards) could in principle both compute the same "free" keyword before
 * either transitions to 'generating' — an accepted, rare race, not the
 * systemic every-sibling-picks-#1 problem this fixes. Never throws — a
 * lookup failure just means this post falls back to ordinary ideation, same
 * as "no city" or "ledger drained".
 */
export async function claimKeywordTargetForBlog(
  blogId: string,
): Promise<ClaimedKeywordTarget | undefined> {
  try {
    const pendingRows = await db
      .select({
        id: blogKeywordTargets.id,
        keyword: blogKeywordTargets.keyword,
        clientId: blogKeywordTargets.clientId,
      })
      .from(blogKeywordTargets)
      .where(and(eq(blogKeywordTargets.blogId, blogId), eq(blogKeywordTargets.status, "pending")))
      .orderBy(asc(blogKeywordTargets.priority));
    if (pendingRows.length === 0) return undefined;

    const clientId = pendingRows[0].clientId;
    const reservedRows = await db
      .selectDistinct({ keyword: blogKeywordTargets.keyword })
      .from(blogKeywordTargets)
      .where(
        and(
          eq(blogKeywordTargets.clientId, clientId),
          ne(blogKeywordTargets.blogId, blogId),
          inArray(blogKeywordTargets.status, ["generating", "generated"]),
        ),
      );
    const reserved = new Set(reservedRows.map((r) => r.keyword));

    const free = pendingRows.find((r) => !reserved.has(r.keyword));
    const chosen = free ?? pendingRows[0];

    const [claimed] = await db
      .update(blogKeywordTargets)
      .set({ status: "generating", updatedAt: new Date() })
      .where(and(eq(blogKeywordTargets.id, chosen.id), eq(blogKeywordTargets.status, "pending")))
      .returning({
        id: blogKeywordTargets.id,
        keyword: blogKeywordTargets.keyword,
        city: blogKeywordTargets.city,
        topicTitle: blogKeywordTargets.topicTitle,
      });
    return claimed;
  } catch (err) {
    console.warn(
      `[keyword-target] claim failed for blog ${blogId}:`,
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}

/** Mark a claimed target generated — the post actually targeted its keyword and published. */
export async function markKeywordTargetGenerated(
  id: string,
  generatedPostId: string,
): Promise<void> {
  try {
    await db
      .update(blogKeywordTargets)
      .set({
        status: "generated",
        generatedPostId,
        failureReason: null,
        generatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(blogKeywordTargets.id, id));
  } catch (err) {
    console.warn(
      `[keyword-target] failed to mark ${id} generated:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Mark a claimed target failed — either generation/publish itself failed, or
 * the run fell back to a generic re-ideated topic (so this keyword was never
 * actually covered). Either way the row goes back into the pool for a future
 * run rather than sitting stuck 'generating' forever.
 */
export async function markKeywordTargetFailed(id: string, reason: string): Promise<void> {
  try {
    await db
      .update(blogKeywordTargets)
      .set({ status: "failed", failureReason: reason.slice(0, 2000), updatedAt: new Date() })
      .where(eq(blogKeywordTargets.id, id));
  } catch (err) {
    console.warn(
      `[keyword-target] failed to mark ${id} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Hand a claimed target straight back to the pool, untouched (T08).
 *
 * Used when the run that claimed it never actually started work — today the
 * only such case is losing the day-slot race in runGenerateAndPublish, where
 * a concurrent sweep already owns this blog's publishing slot for the UTC
 * day. Nothing was generated, so the keyword was not covered and the row
 * deserves its priority position back.
 *
 * 'pending', NOT 'failed': claimKeywordTargetForBlog only ever selects
 * status='pending', so 'failed' is terminal and would silently drain the
 * ledger. Draining the existing failed backlog is T10's job — this function
 * only avoids adding to it.
 *
 * The status='generating' guard makes this a no-op if something else already
 * resolved the row — never throws, the caller is on a publish hot path.
 */
export async function releaseKeywordTargetClaim(
  id: string,
  reason: string,
): Promise<void> {
  try {
    await db
      .update(blogKeywordTargets)
      .set({
        status: "pending",
        failureReason: reason.slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(blogKeywordTargets.id, id),
          eq(blogKeywordTargets.status, "generating"),
        ),
      );
  } catch (err) {
    console.warn(
      `[keyword-target] failed to release ${id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Time-based reaper for ledger rows abandoned in 'generating' by a process
 * that died mid-run (Render restart, deploy during a sweep, OOM) (T08).
 *
 * Age is the only signal available: generated_post_id is not written until
 * the post actually publishes (markKeywordTargetGenerated), so there is no
 * link back to the generated_posts row to join against. A claim is only ever
 * held for the ~25-35s of one generation, and the route that drives it is
 * capped at maxDuration=600s, so the default 30-minute threshold is 3x the
 * longest legitimate lifetime.
 *
 * Back to 'pending' for the same reason as releaseKeywordTargetClaim.
 * Idempotent: the age predicate is re-evaluated per statement, so all four
 * auto-publish shards can run this concurrently without double-counting
 * anything that matters. Returns how many rows were released.
 */
export async function releaseStuckKeywordTargets(
  thresholdMinutes = 30,
): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - thresholdMinutes * 60_000);
    const rows = await db
      .update(blogKeywordTargets)
      .set({
        status: "pending",
        failureReason: `Reaped after ${thresholdMinutes}m stuck in 'generating' — the run that claimed it never finished`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(blogKeywordTargets.status, "generating"),
          lt(blogKeywordTargets.updatedAt, cutoff),
        ),
      )
      .returning({ id: blogKeywordTargets.id });
    return rows.length;
  } catch (err) {
    console.warn(
      "[keyword-target] stuck-target reap failed:",
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}
