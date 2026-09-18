"use server";

import { db } from "@/lib/db";
import { blogs, postVerifications } from "@/lib/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/helpers";
import { fetchRecentPosts } from "@/lib/services/platform-client";
import {
  computeOnSchedule,
  countPostsInWindow,
  expectedPostsPerWeek,
  fetchCountForBlog,
  maxDaysBetweenPosts,
} from "@/lib/cron/cadence";
import { runPostVerificationSweep } from "@/lib/cron/post-verification";

// NOTE: this module is "use server", so every export must be an async
// function — Next.js turns them into callable server actions. The cadence
// maths and the sweep itself therefore live in plain modules under
// src/lib/cron/ and are imported here. Do not re-export the sweep's
// interfaces from this file; import them from @/lib/cron/post-verification.

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

/**
 * Verify ONE blog on demand (admin UI / debugging). Uses exactly the same
 * maths as the sweep — same cadence source, same rolling-window count — so a
 * manual check can never disagree with the scheduled one.
 */
export async function verifyBlogPosts(blogId: string) {
  await requireAdmin();

  const [blog] = await db.select().from(blogs).where(eq(blogs.id, blogId)).limit(1);
  if (!blog) throw new Error("Blog not found");

  const now = new Date();
  const expected = expectedPostsPerWeek(blog);
  const posts = await fetchRecentPosts(blog, fetchCountForBlog(expected));
  const latestPost = posts[0];
  const latestPostDate = latestPost?.publishedAt ?? null;
  const daysSinceLastPost = latestPostDate
    ? Math.ceil((now.getTime() - latestPostDate.getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const postsInPeriod = countPostsInWindow(posts, now);
  const maxGap = maxDaysBetweenPosts(blog);
  const onSchedule = computeOnSchedule(blog, daysSinceLastPost, maxGap, now);
  const alertTriggered = !onSchedule;

  const [verification] = await db.insert(postVerifications).values({
    blogId: blog.id,
    clientId: blog.clientId,
    checkType: "manual",
    latestPostDate,
    latestPostTitle: latestPost?.title || null,
    latestPostUrl: latestPost?.url || null,
    postsInPeriod,
    expectedPosts: expected,
    onSchedule,
    daysSinceLastPost,
    alertTriggered,
    checkedAt: now,
  }).returning();

  // Only lastPostTitle. blogs.lastPostVerifiedAt means "when did WE last
  // publish" — it is the auto-publish priority key and is written by the
  // publish path alone. A verification must not advance it.
  if (latestPost?.title && latestPost.title !== blog.lastPostTitle) {
    await db.update(blogs).set({
      lastPostTitle: latestPost.title,
      updatedAt: now,
    }).where(eq(blogs.id, blogId));
  }

  revalidatePath(`/blogs/${blogId}`);
  return verification;
}

/**
 * Admin-callable wrapper for the post-verification sweep. Same code path as
 * the cron, but auth-gated and revalidating /posts so the table updates once
 * the job finishes.
 *
 * Defaults to a SINGLE shard covering the whole network. From a browser
 * request that will usually exceed the sweep's own budget on a 1,500-blog
 * network and return partial coverage — which is correct and safe (the
 * unreached blogs sort first next run). Pass a shard explicitly to check one
 * quarter of the network, or a small `limit` to spot-check.
 */
export async function runPostVerificationNow(options?: {
  shardIndex?: number;
  shardCount?: number;
  limit?: number;
  concurrency?: number;
}) {
  await requireAdmin();
  const result = await runPostVerificationSweep({
    ...options,
    checkType: "manual",
    // Never prune from an ad-hoc admin run; the scheduled shard 0 owns it.
    prune: false,
  });
  revalidatePath("/posts");
  return result;
}
