"use server";

import { db } from "@/lib/db";
import { blogs, postVerifications } from "@/lib/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/helpers";
import { fetchRecentPosts } from "@/lib/services/platform-client";
import { normalizePostingPlan, postsPerWeek } from "@/lib/posting-plan";

type BlogRow = typeof blogs.$inferSelect;

/**
 * Total expected posts per 7-day window, read from the SAME canonical field
 * the auto-publish cron schedules against (blogs.posting_plan). Returns 0
 * when the blog has no schedule, which makes maxDaysBetweenPosts() return 0
 * and computeOnSchedule() return true — an unscheduled blog is never flagged
 * "behind" here. It is reported instead as `unscheduled_blogs`, a critical
 * item in /api/notifications, because "no schedule" is a configuration fault
 * and not a missed post.
 */
function expectedPostsPerWeek(blog: BlogRow): number {
  return postsPerWeek(normalizePostingPlan(blog.postingPlan));
}

/**
 * Max acceptable gap (in days) between consecutive posts before we flag the
 * blog as "off schedule". 0 means no schedule is configured (always on time).
 * Adds 1 day of grace so a near-miss isn't immediately flagged.
 */
function maxDaysBetweenPosts(blog: BlogRow): number {
  const epw = expectedPostsPerWeek(blog);
  if (epw <= 0) return 0;
  return Math.ceil(7 / epw) + 1;
}

/**
 * Decide whether a blog is "on schedule" (true) or "behind" (false).
 *
 *   maxGap === 0  → no schedule configured → always on time.
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
 *     daysSinceLastPost === null  → no posts at all → behind
 *     daysSinceLastPost <= maxGap → on schedule
 *     else                        → behind
 *
 * Once we publish our own first post, the live site shows it as the
 * latest, so daysSinceLastPost reflects OUR cadence from then on.
 */
function computeOnSchedule(
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

export async function getPostVerifications(params?: {
  blogId?: string;
  clientId?: string;
  onSchedule?: boolean;
  page?: number;
  pageSize?: number;
}) {
  await requireAdmin();
  const { blogId, clientId, onSchedule, page = 1, pageSize = 25 } = params || {};

  const conditions = [];
  if (blogId) conditions.push(eq(postVerifications.blogId, blogId));
  if (clientId) conditions.push(eq(postVerifications.clientId, clientId));
  if (onSchedule !== undefined) conditions.push(eq(postVerifications.onSchedule, onSchedule));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [records, [{ count }]] = await Promise.all([
    db.select({
      verification: postVerifications,
      blogDomain: blogs.domain,
    })
      .from(postVerifications)
      .innerJoin(blogs, eq(postVerifications.blogId, blogs.id))
      .where(where)
      .orderBy(desc(postVerifications.checkedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ count: sql<number>`count(*)::int` })
      .from(postVerifications)
      .where(where),
  ]);

  return { records, total: count, page, pageSize };
}

export async function verifyBlogPosts(blogId: string) {
  await requireAdmin();

  const [blog] = await db.select().from(blogs).where(eq(blogs.id, blogId)).limit(1);
  if (!blog) throw new Error("Blog not found");

  const posts = await fetchRecentPosts(blog, 5);

  const latestPost = posts[0];
  const latestPostDate = latestPost?.publishedAt ?? null;
  const daysSinceLastPost = latestPostDate
    ? Math.ceil((Date.now() - latestPostDate.getTime()) / (1000 * 60 * 60 * 24))
    : null;

  const expected = expectedPostsPerWeek(blog);
  const maxGap = maxDaysBetweenPosts(blog);
  const onSchedule = computeOnSchedule(blog, daysSinceLastPost, maxGap);
  const alertTriggered = !onSchedule;

  const [verification] = await db.insert(postVerifications).values({
    blogId: blog.id,
    clientId: blog.clientId,
    checkType: "manual",
    latestPostDate,
    latestPostTitle: latestPost?.title || null,
    latestPostUrl: latestPost?.url || null,
    postsInPeriod: posts.length,
    expectedPosts: expected,
    onSchedule,
    daysSinceLastPost,
    alertTriggered,
  }).returning();

  await db.update(blogs).set({
    lastPostVerifiedAt: new Date(),
    lastPostTitle: latestPost?.title || blog.lastPostTitle,
    updatedAt: new Date(),
  }).where(eq(blogs.id, blogId));

  return verification;
}

/**
 * Admin-callable wrapper for the post-verification sweep. Same logic as the
 * cron, but auth-gated and revalidates the /posts page so the table updates
 * once the job finishes.
 */
export async function runPostVerificationNow() {
  await requireAdmin();
  const result = await runPostVerificationCron();
  revalidatePath("/posts");
  return result;
}

// Called by cron job
export async function runPostVerificationCron() {
  const activeBlogs = await db.select().from(blogs).where(eq(blogs.status, "active"));

  let verified = 0;
  let alerts = 0;

  for (const blog of activeBlogs) {
    const hasWp = blog.wpUrl && blog.wpUsername && blog.wpAppPassword;
    // Shopify supports two auth modes; either is sufficient.
    const shopifyMode = blog.shopifyAuthMode ?? "client_credentials";
    const hasShopify =
      blog.shopifyStoreUrl &&
      (shopifyMode === "legacy_token"
        ? Boolean(blog.shopifyAdminApiToken)
        : Boolean(blog.shopifyClientId && blog.shopifyClientSecret));
    if (blog.platform === "wordpress" && !hasWp) continue;
    if (blog.platform === "shopify" && !hasShopify) continue;

    try {
      const posts = await fetchRecentPosts(blog, 5);
      const latestPost = posts[0];
      const latestPostDate = latestPost?.publishedAt ?? null;
      const daysSinceLastPost = latestPostDate
        ? Math.ceil((Date.now() - latestPostDate.getTime()) / (1000 * 60 * 60 * 24))
        : null;

      const expected = expectedPostsPerWeek(blog);
      const maxGap = maxDaysBetweenPosts(blog);
      const onSchedule = computeOnSchedule(blog, daysSinceLastPost, maxGap);
      const alertTriggered = !onSchedule;
      if (alertTriggered) alerts++;

      await db.insert(postVerifications).values({
        blogId: blog.id,
        clientId: blog.clientId,
        checkType: "scheduled",
        latestPostDate,
        latestPostTitle: latestPost?.title || null,
        latestPostUrl: latestPost?.url || null,
        postsInPeriod: posts.length,
        expectedPosts: expected,
        onSchedule,
        daysSinceLastPost,
        alertTriggered,
      });

      await db.update(blogs).set({
        lastPostVerifiedAt: new Date(),
        lastPostTitle: latestPost?.title || blog.lastPostTitle,
      }).where(eq(blogs.id, blog.id));

      verified++;
    } catch (error) {
      console.error(`Post verification failed for ${blog.domain}:`, error);
    }
  }

  return { verified, alerts, total: activeBlogs.length };
}
