import { blogs } from "@/lib/db/schema";
import { normalizePostingPlan, postsPerWeek } from "@/lib/posting-plan";

/** A blog row as selected from the `blogs` table. */
export type BlogRow = typeof blogs.$inferSelect;

/** Rolling window that `post_verifications.posts_in_period` is measured over. */
export const ROLLING_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Does this blog have usable publishing credentials for its platform?
 * Moved verbatim from content-generation-actions.ts so the publisher and the
 * verifier apply the same gate.
 */
export function blogHasCredentials(blog: BlogRow): boolean {
  if (blog.platform === "shopify") {
    if (!blog.shopifyStoreUrl) return false;
    // Two auth modes:
    //   legacy_token       — needs shopifyAdminApiToken
    //   client_credentials — needs shopifyClientId + shopifyClientSecret
    // Default to client_credentials when the column is null (matches the DB default).
    const mode = blog.shopifyAuthMode ?? "client_credentials";
    if (mode === "legacy_token") return Boolean(blog.shopifyAdminApiToken);
    return Boolean(blog.shopifyClientId && blog.shopifyClientSecret);
  }
  return Boolean(blog.wpUrl && blog.wpUsername && blog.wpAppPassword);
}

/**
 * Total expected posts per 7-day window, read from blogs.posting_plan — the
 * SAME field the auto-publish cron schedules against (T17). Returns 0 only
 * when the blog has no schedule at all, which is a configuration defect
 * surfaced as `unscheduled_blogs` in /api/notifications, not a healthy state.
 *
 * A monitor that measures a different schedule from the one the publisher
 * honours measures nothing. Before T17 this read blogs.posts_per_day, a
 * column no code path ever wrote, so it returned 0 for every blog configured
 * through posting_frequency — and 0 makes maxDaysBetweenPosts() return 0,
 * which makes computeOnSchedule() return true unconditionally. Those blogs
 * could never be flagged behind, however long they had been silent.
 */
export function expectedPostsPerWeek(blog: BlogRow): number {
  return postsPerWeek(normalizePostingPlan(blog.postingPlan));
}

/**
 * Max acceptable gap (in days) between consecutive posts before we flag the
 * blog as "off schedule". 0 means no schedule is configured (always on time).
 * Adds 1 day of grace so a near-miss isn't immediately flagged.
 */
export function maxDaysBetweenPosts(blog: BlogRow): number {
  const epw = expectedPostsPerWeek(blog);
  if (epw <= 0) return 0;
  return Math.ceil(7 / epw) + 1;
}

/**
 * Decide whether a blog is "on schedule" (true) or "behind" (false).
 *
 *   maxGap === 0  -> no schedule configured -> always on time. An
 *                    unscheduled blog is a T17 notification, not a missed
 *                    post, and double-reporting it here would be noise.
 *
 *   NEW-BLOG GRACE (checked FIRST, before any live-post logic):
 *     If WE added this blog within one cadence window (createdAt age
 *     <= maxGap), it's "on schedule" regardless of the live site's
 *     post state. We haven't had a chance to publish on our cadence
 *     yet. This covers two cases:
 *       (a) a fresh blog with no posts at all, and
 *       (b) a fresh blog on a store that already had an OLD post
 *           (e.g. a Shopify article from weeks ago) — that pre-
 *           existing content shouldn't make a just-onboarded blog
 *           look behind.
 *
 *   Past the grace window, judge by the latest LIVE post:
 *     daysSinceLastPost === null  -> no posts at all -> behind
 *     daysSinceLastPost <= maxGap -> on schedule
 *     else                        -> behind
 */
export function computeOnSchedule(
  blog: BlogRow,
  daysSinceLastPost: number | null,
  maxGap: number,
  now: Date = new Date(),
): boolean {
  if (maxGap === 0) return true;

  // New-blog grace — based on when WE onboarded the blog, NOT on the
  // live site's post history.
  if (blog.createdAt) {
    const ageDays = Math.ceil(
      (now.getTime() - blog.createdAt.getTime()) / (1000 * 60 * 60 * 24),
    );
    if (ageDays <= maxGap) return true;
  }

  // Past grace: a stale or missing live post means behind.
  if (daysSinceLastPost === null) return false;
  return daysSinceLastPost <= maxGap;
}

/**
 * TRUE rolling-window count: how many of the live posts we pulled were
 * published inside the last `windowDays`. This is what
 * post_verifications.posts_in_period is supposed to hold so that the stored
 * (posts_in_period, expected_posts) pair is actually comparable — the old
 * code stored `posts.length`, i.e. "how many rows the platform handed back,
 * capped at 5", which is not a count over any period, yet the admin table
 * renders the pair as a fraction.
 *
 * Posts with a null publishedAt (drafts / scheduled entries a platform may
 * return) are not counted.
 */
export function countPostsInWindow(
  posts: { publishedAt: Date | null }[],
  now: Date = new Date(),
  windowDays: number = ROLLING_WINDOW_DAYS,
): number {
  const cutoff = now.getTime() - windowDays * DAY_MS;
  let n = 0;
  for (const p of posts) {
    if (p.publishedAt && p.publishedAt.getTime() >= cutoff) n++;
  }
  return n;
}

/**
 * How many live posts to pull so that a full 7-day window fits inside the
 * response. Both platform clients return newest-first, so we need at least
 * as many rows as the blog could plausibly have published in the window,
 * plus headroom for over-cadence blogs and for pre-existing content.
 *
 *   expected 0  (no cadence)     -> 10
 *   expected 3  (Mon/Wed/Fri)    -> 10
 *   expected 7  (daily)          -> 16
 *   expected 14 (2/day)          -> 26
 *   expected 50+                 -> 50 (hard ceiling)
 *
 * The ceiling of 50 is well inside both platforms' limits (WP REST per_page
 * max 100; Shopify articles.json limit max 250) and costs one request either
 * way — only the response body grows.
 */
export function fetchCountForBlog(expectedPerWeek: number): number {
  const needed = Math.ceil(expectedPerWeek * 1.5) + 5;
  return Math.max(10, Math.min(50, needed));
}
