"use server";

import { db } from "@/lib/db";
import { blogs, generatedPosts } from "@/lib/db/schema";
import { and, asc, eq, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import { verifyLiveMeta } from "@/lib/services/wp-meta-verify";
import { backfillPostSeo, type PlatformBlog } from "@/lib/services/platform-client";

/**
 * lib/actions/yoast-meta-backfill-actions.ts
 *
 * Re-push and verify SEO meta for WordPress posts that were published while
 * updateYoastMeta was a no-op (T14).
 *
 * The run measures BEFORE it writes: every post's live <head> is fetched and
 * compared to the stored meta first, so `missingBefore` is a real count of
 * posts that were silently shipped without meta - not an assumption.
 *
 * Idempotent. Safe to re-run: posts already verified are skipped unless
 * includeVerified is set.
 */

export interface YoastBackfillOptions {
  /** Restrict to one blog. Omit to sweep every eligible Yoast WordPress blog. */
  blogId?: string;
  /** Max posts to touch per blog (default 500). */
  limit?: number;
  /** Max blogs per run (default 25 - keeps the run inside maxDuration). */
  blogLimit?: number;
  /** Measure only; make no writes at all. */
  dryRun?: boolean;
  /** Re-check posts already recorded as verified (default false). */
  includeVerified?: boolean;
  /**
   * Only sweep blogs where the netgrid-seo-bridge MU-plugin is installed
   * (default true).
   *
   * On a blog without the bridge every post burns a live fetch plus a REST
   * write, comes back stillBroken, and stays in the candidate set because
   * seo_meta_verified = false - so the next run does it all again. Pass false
   * only when you are deliberately measuring un-bridged blogs with dryRun.
   */
  requireBridge?: boolean;
}

export interface YoastBackfillBlogResult {
  blogId: string;
  domain: string;
  bridgeInstalled: boolean;
  checked: number;
  /** Live page already carried the right meta - nothing to do. */
  alreadyCorrect: number;
  /** Live page did NOT carry our meta before we touched it. */
  missingBefore: number;
  /** Was missing, is now verified live. */
  repaired: number;
  /** Was missing, still missing after the re-push. */
  stillBroken: number;
  /** Could not fetch the live page, so we could not judge. */
  unreachable: number;
}

export interface YoastBackfillResult {
  dryRun: boolean;
  blogsProcessed: number;
  /** Blogs skipped because the bridge is not installed on them. */
  blogsSkippedNoBridge: number;
  totals: {
    checked: number;
    alreadyCorrect: number;
    missingBefore: number;
    repaired: number;
    stillBroken: number;
    unreachable: number;
  };
  blogs: YoastBackfillBlogResult[];
}

/** Politeness delay between posts on the same site. */
const PER_POST_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function backfillYoastMeta(
  options: YoastBackfillOptions = {},
): Promise<YoastBackfillResult> {
  const {
    blogId,
    limit = 500,
    blogLimit = 25,
    dryRun = false,
    includeVerified = false,
    requireBridge = true,
  } = options;

  const blogConditions: (SQL | undefined)[] = [
    eq(blogs.platform, "wordpress"),
    eq(blogs.seoPlugin, "yoast"),
    isNotNull(blogs.wpUrl),
  ];
  if (blogId) blogConditions.push(eq(blogs.id, blogId));
  if (requireBridge) blogConditions.push(isNotNull(blogs.seoBridgeVersion));

  const blogRows = await db
    .select()
    .from(blogs)
    .where(and(...blogConditions))
    .orderBy(asc(blogs.domain))
    .limit(blogLimit);

  // Reported so an operator can tell "nothing to do" from "the rollout has not
  // reached these sites yet".
  let blogsSkippedNoBridge = 0;
  if (requireBridge) {
    const unbridged = await db
      .select({ id: blogs.id })
      .from(blogs)
      .where(
        and(
          eq(blogs.platform, "wordpress"),
          eq(blogs.seoPlugin, "yoast"),
          isNotNull(blogs.wpUrl),
          isNull(blogs.seoBridgeVersion),
          ...(blogId ? [eq(blogs.id, blogId)] : []),
        ),
      );
    blogsSkippedNoBridge = unbridged.length;
  }

  const results: YoastBackfillBlogResult[] = [];
  const totals = {
    checked: 0,
    alreadyCorrect: 0,
    missingBefore: 0,
    repaired: 0,
    stillBroken: 0,
    unreachable: 0,
  };

  for (const blog of blogRows) {
    const platformBlog: PlatformBlog = {
      platform: blog.platform,
      wpUrl: blog.wpUrl,
      wpUsername: blog.wpUsername,
      wpAppPassword: blog.wpAppPassword,
      seoPlugin: blog.seoPlugin,
    };

    const blogResult: YoastBackfillBlogResult = {
      blogId: blog.id,
      domain: blog.domain,
      bridgeInstalled: blog.seoBridgeVersion !== null,
      checked: 0,
      alreadyCorrect: 0,
      missingBefore: 0,
      repaired: 0,
      stillBroken: 0,
      unreachable: 0,
    };

    const postConditions: (SQL | undefined)[] = [
      eq(generatedPosts.blogId, blog.id),
      eq(generatedPosts.status, "published"),
      isNotNull(generatedPosts.externalPostId),
      isNotNull(generatedPosts.externalPostUrl),
    ];
    if (!includeVerified) {
      postConditions.push(
        or(
          isNull(generatedPosts.seoMetaVerified),
          eq(generatedPosts.seoMetaVerified, false),
        ),
      );
    }

    const posts = await db
      .select({
        id: generatedPosts.id,
        externalPostId: generatedPosts.externalPostId,
        externalPostUrl: generatedPosts.externalPostUrl,
        metaTitle: generatedPosts.metaTitle,
        metaDescription: generatedPosts.metaDescription,
        keywords: generatedPosts.keywords,
      })
      .from(generatedPosts)
      .where(and(...postConditions))
      .orderBy(asc(generatedPosts.publishedAt))
      .limit(limit);

    for (const post of posts) {
      const postUrl = post.externalPostUrl;
      const externalPostId = post.externalPostId;
      if (!postUrl || !externalPostId) continue;

      const wantTitle = post.metaTitle?.trim() || undefined;
      const wantDescription = post.metaDescription?.trim() || undefined;
      if (!wantTitle && !wantDescription) continue;

      blogResult.checked++;

      // 1. MEASURE FIRST. What does the live page show right now, before we
      //    touch anything? This is the number that answers "how many posts
      //    were silently shipped without meta".
      const before = await verifyLiveMeta(postUrl, {
        title: wantTitle,
        description: wantDescription,
      });

      if (before.verified === true) {
        blogResult.alreadyCorrect++;
        if (!dryRun) {
          await db
            .update(generatedPosts)
            .set({
              seoMetaVerified: true,
              seoMetaVerifiedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(generatedPosts.id, post.id));
        }
        await sleep(PER_POST_DELAY_MS);
        continue;
      }

      if (before.verified === null) {
        blogResult.unreachable++;
        await sleep(PER_POST_DELAY_MS);
        continue;
      }

      blogResult.missingBefore++;
      if (dryRun) {
        await sleep(PER_POST_DELAY_MS);
        continue;
      }

      // 2. Re-push through the ordinary SEO path, which now writes the correct
      //    _yoast_wpseo_* keys and verifies afterwards.
      const focusKeyword = Array.isArray(post.keywords)
        ? (post.keywords as unknown[]).find(
            (k): k is string => typeof k === "string",
          )
        : undefined;

      const push = await backfillPostSeo(platformBlog, externalPostId, {
        metaTitle: wantTitle,
        metaDescription: wantDescription,
        focusKeyword,
        postUrl,
      });

      const verified = push.success ? push.seoMetaVerified ?? null : false;
      if (verified === true) blogResult.repaired++;
      else if (verified === null) blogResult.unreachable++;
      else blogResult.stillBroken++;

      await db
        .update(generatedPosts)
        .set({
          seoMetaVerified: verified,
          seoMetaVerifiedAt: verified === null ? null : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(generatedPosts.id, post.id));

      if (verified !== true) {
        console.error(
          `[yoast-backfill] ${blog.domain} post ${externalPostId} still not live: ` +
            `${push.seoMetaMessage ?? push.message}`,
        );
      }

      await sleep(PER_POST_DELAY_MS);
    }

    totals.checked += blogResult.checked;
    totals.alreadyCorrect += blogResult.alreadyCorrect;
    totals.missingBefore += blogResult.missingBefore;
    totals.repaired += blogResult.repaired;
    totals.stillBroken += blogResult.stillBroken;
    totals.unreachable += blogResult.unreachable;
    results.push(blogResult);
  }

  return {
    dryRun,
    blogsProcessed: results.length,
    blogsSkippedNoBridge,
    totals,
    blogs: results,
  };
}
