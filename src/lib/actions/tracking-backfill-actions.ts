"use server";

import { db } from "@/lib/db";
import { blogs, clients, generatedPosts } from "@/lib/db/schema";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/helpers";
import {
  backfillPostSeo,
  fetchLivePostBody,
  resolveShopifyBlogId,
  type PlatformBlog,
} from "@/lib/services/platform-client";
import {
  ctaRedirectUrl,
  blogCtaRedirectUrl,
} from "@/lib/services/link-tracker";
import { effectiveCtaDestination } from "@/lib/content/cta-target";
import { COMMERCIAL_LINK_REL, withUtm } from "@/lib/content/outbound-links";

export interface TrackingRemovalResult {
  blogId: string;
  platform: string;
  /** Published posts considered this run (capped by `limit`). */
  total: number;
  /** Posts whose live body was rewritten. */
  updated: number;
  /** Already clean — nothing to change. */
  skipped: number;
  failed: number;
  /** Posts beyond this run's cap; re-run to process them. */
  remaining: number;
  /** Anchors repointed from a netgrid redirect to the client destination. */
  linksRepointed: number;
  /** Tracking-pixel <img> tags stripped. */
  pixelsRemoved: number;
  /** Posts still carrying a redirect link because no destination resolved. */
  unresolved: number;
  /** True when nothing was written (dry run). */
  dryRun: boolean;
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Escape a URL for a double-quoted HTML attribute (UTMs introduce "&"). */
function safeAttrUrl(url: string): string {
  return url
    .replace(/&/g, "&amp;")
    .replace(/"/g, "%22")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
}

/**
 * Any netgrid tracking-pixel <img>, whatever host, attribute order or style
 * survived the CMS. Matched on the /api/track/px/ path rather than on the exact
 * emitted string, because WordPress and Shopify both reorder and strip
 * attributes on save. Covers the per-post and the blog-level pixel.
 *
 * Built fresh per call: a /g regex carries lastIndex, and reusing one across
 * .test()/.replace() is the classic footgun (see shopify-theme-client.ts).
 */
function pixelImgRe(): RegExp {
  return /<img\b[^>]*\bsrc\s*=\s*["'][^"']*\/api\/track\/px\/[^"']*["'][^>]*>\s*/gi;
}

/**
 * Repoint every <a> whose href is `redirectUrl` at the client destination, and
 * force its rel to the commercial-link policy.
 *
 * Operates on the whole opening tag so the rel is REPLACED rather than
 * duplicated, and so an anchor that carried no rel gets one. Placement is
 * inferred from the inline style netgrid itself emitted (buildCtaHtml always
 * writes `display:inline-block` on the button), so the UTM medium matches what
 * new posts emit. A theme that stripped inline styles degrades to "body_link",
 * which is a labelling imprecision, not a bug.
 */
function repointTrackedAnchors(
  html: string,
  redirectUrl: string,
  destination: string,
  postId: string,
  blogDomain: string | null,
): { html: string; count: number } {
  const hrefRe = new RegExp(
    `href\\s*=\\s*(["'])${escapeRegExp(redirectUrl)}\\1`,
    "i",
  );
  const relRe = /\srel\s*=\s*(["'])[^"']*\1/i;
  let count = 0;
  const out = html.replace(/<a\b[^>]*>/gi, (tag) => {
    if (!hrefRe.test(tag)) return tag;
    count++;
    const isButton = /display\s*:\s*inline-block/i.test(tag);
    const href = safeAttrUrl(
      withUtm(destination, {
        blogDomain,
        medium: isButton ? "cta_button" : "body_link",
        postId,
      }),
    );
    let next = tag.replace(hrefRe, (_m, q) => `href=${q}${href}${q}`);
    next = relRe.test(next)
      ? next.replace(relRe, (_m, q) => ` rel=${q}${COMMERCIAL_LINK_REL}${q}`)
      : next.replace(/^<a\b/i, `<a rel="${COMMERCIAL_LINK_REL}"`);
    return next;
  });
  return { html: out, count };
}

/**
 * Remove netgrid's shared-host tracking from a blog's already-published posts
 * (T02 — the inverse of the old backfillBlogTracking):
 *   - repoint every /r/{postId} (and /r/blog/{blogId}) anchor back at the
 *     client's own destination, UTM-tagged, rel="sponsored noopener"
 *   - strip every /api/track/px/ pixel <img>
 *
 * Reads each post's LIVE body from the platform and only writes when something
 * changed, so it is safe to re-run and safe to interleave with publishing.
 * Processes up to `limit` posts (newest first) per run; `remaining` reports how
 * many are left. Pass { dryRun: true } to count without writing anything.
 */
export async function removeBlogTracking(
  blogId: string,
  options: { limit?: number; dryRun?: boolean } = {},
): Promise<TrackingRemovalResult> {
  await requireAdmin();
  const limit = Math.min(200, Math.max(1, options.limit ?? 60));
  const dryRun = options.dryRun ?? false;

  const [blog] = await db.select().from(blogs).where(eq(blogs.id, blogId)).limit(1);
  if (!blog) throw new Error(`Blog ${blogId} not found`);

  const platformBlog: PlatformBlog = {
    platform: blog.platform,
    wpUrl: blog.wpUrl,
    wpUsername: blog.wpUsername,
    wpAppPassword: blog.wpAppPassword,
    seoPlugin: blog.seoPlugin,
    shopifyAuthMode: blog.shopifyAuthMode,
    shopifyStoreUrl: blog.shopifyStoreUrl,
    shopifyAdminApiToken: blog.shopifyAdminApiToken,
    shopifyClientId: blog.shopifyClientId,
    shopifyClientSecret: blog.shopifyClientSecret,
    shopifyBlogHandle: blog.shopifyBlogHandle,
  };

  // The destination each /r/ link resolved to at click time. Mirrors
  // link-tracker.resolvePostRedirect, which selects clients.ctaUrl with NO
  // ctaEnabled gate — so we don't gate either, or a client who toggled the CTA
  // off after publishing would have their live links left stranded on the
  // netgrid redirect.
  const [client] = await db
    .select({ niche: clients.niche, ctaUrl: clients.ctaUrl })
    .from(clients)
    .where(eq(clients.id, blog.clientId))
    .limit(1);
  const destination = effectiveCtaDestination({
    niche: client?.niche,
    blogDomain: blog.domain,
    ctaUrl: client?.ctaUrl,
  });

  // Resolve the Shopify blog id ONCE for the whole run (no-op for WP).
  const shopifyCtx = await resolveShopifyBlogId(platformBlog);
  const shopifyBlogId = shopifyCtx?.blogId;

  // Fetch one more than the cap so we can tell whether any remain.
  const rows = await db
    .select({ id: generatedPosts.id, externalPostId: generatedPosts.externalPostId })
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.blogId, blogId),
        eq(generatedPosts.status, "published"),
        isNotNull(generatedPosts.externalPostId),
      ),
    )
    .orderBy(desc(generatedPosts.publishedAt))
    .limit(limit + 1);

  const remaining = Math.max(0, rows.length - limit);
  const batch = rows.slice(0, limit);

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let linksRepointed = 0;
  let pixelsRemoved = 0;
  let unresolved = 0;

  for (const row of batch) {
    const externalPostId = row.externalPostId;
    if (!externalPostId) {
      skipped++;
      continue;
    }
    try {
      const body = await fetchLivePostBody(platformBlog, externalPostId, shopifyBlogId);
      if (body === null) {
        failed++;
        continue;
      }

      let next = body;
      let repointed = 0;
      if (destination) {
        for (const redirectUrl of [ctaRedirectUrl(row.id), blogCtaRedirectUrl(blogId)]) {
          const r = repointTrackedAnchors(
            next,
            redirectUrl,
            destination,
            row.id,
            blog.domain,
          );
          next = r.html;
          repointed += r.count;
        }
      } else if (next.includes(`/r/${row.id}`)) {
        // A tracked link exists but there is nowhere to send it. Leave the
        // live markup alone — a broken link is worse than a tracked one — and
        // report it so an operator can set the client's CTA URL and re-run.
        unresolved++;
      }

      const pixelMatches = next.match(pixelImgRe());
      if (pixelMatches) {
        next = next.replace(pixelImgRe(), "");
        pixelsRemoved += pixelMatches.length;
      }

      if (next === body) {
        skipped++;
        continue;
      }

      if (dryRun) {
        updated++;
        linksRepointed += repointed;
        continue;
      }

      const push = await backfillPostSeo(
        platformBlog,
        externalPostId,
        { bodyHtml: next },
        shopifyBlogId,
      );
      if (!push.success) {
        failed++;
        continue;
      }

      await db
        .update(generatedPosts)
        .set({ body: next, updatedAt: new Date() })
        .where(eq(generatedPosts.id, row.id));
      updated++;
      linksRepointed += repointed;
    } catch {
      failed++;
    }
  }

  return {
    blogId,
    platform: blog.platform ?? "wordpress",
    total: batch.length,
    updated,
    skipped,
    failed,
    remaining,
    linksRepointed,
    pixelsRemoved,
    unresolved,
    dryRun,
  };
}