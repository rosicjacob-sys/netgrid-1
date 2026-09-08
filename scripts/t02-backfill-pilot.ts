/**
 * T02 §6.2 step 3 — DRY-RUN PILOT of the reverse backfill.
 *
 * Runs the exact removeBlogTracking logic on ONE WordPress and ONE Shopify
 * blog, in dryRun mode: fetches each post's live body from the platform,
 * computes the repair (repoint /r/ hrefs to the client's destination with
 * UTMs, strip /api/track/px/ pixels), and reports counters — while WRITING
 * NOTHING: no platform write, no DB write.
 *
 * requireAdmin() is omitted: standalone supervised script, not a UI action.
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { blogs, clients, generatedPosts } from "../src/lib/db/schema";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import {
  fetchLivePostBody,
  resolveShopifyBlogId,
  type PlatformBlog,
} from "../src/lib/services/platform-client";
import {
  ctaRedirectUrl,
  blogCtaRedirectUrl,
} from "../src/lib/services/link-tracker";
import { effectiveCtaDestination } from "../src/lib/content/cta-target";
import { COMMERCIAL_LINK_REL, withUtm } from "../src/lib/content/outbound-links";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function safeAttrUrl(url: string): string {
  return url
    .replace(/&/g, "&amp;")
    .replace(/"/g, "%22")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
}
function pixelImgRe(): RegExp {
  return /<img\b[^>]*\bsrc\s*=\s*["'][^"']*\/api\/track\/px\/[^"']*["'][^>]*>\s*/gi;
}
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

// ---- PILOT-LOGIC (appended below) ----

async function pilot(platform: "wordpress" | "shopify") {
  const [cand] = await db
    .select({ id: blogs.id, domain: blogs.domain })
    .from(blogs)
    .innerJoin(clients, eq(clients.id, blogs.clientId))
    .innerJoin(generatedPosts, eq(generatedPosts.blogId, blogs.id))
    .where(
      and(
        eq(blogs.platform, platform),
        eq(blogs.status, "active"),
        eq(generatedPosts.status, "published"),
        isNotNull(generatedPosts.externalPostId),
        sql`${generatedPosts.body} LIKE '%/api/track/px/%'`,
        isNotNull(clients.ctaUrl),
      ),
    )
    .limit(1);
  if (!cand) {
    console.log(`\n[${platform}] no affected active blog found`);
    return;
  }
  console.log(`\n===== PILOT (${platform}): ${cand.domain} =====`);

  const [b] = await db
    .select({
      platform: blogs.platform, wpUrl: blogs.wpUrl, wpUsername: blogs.wpUsername,
      wpAppPassword: blogs.wpAppPassword, seoPlugin: blogs.seoPlugin,
      shopifyAuthMode: blogs.shopifyAuthMode, shopifyStoreUrl: blogs.shopifyStoreUrl,
      shopifyAdminApiToken: blogs.shopifyAdminApiToken,
      shopifyClientId: blogs.shopifyClientId, shopifyClientSecret: blogs.shopifyClientSecret,
      shopifyBlogHandle: blogs.shopifyBlogHandle,
      domain: blogs.domain, niche: clients.niche, ctaUrl: clients.ctaUrl,
    })
    .from(blogs)
    .innerJoin(clients, eq(clients.id, blogs.clientId))
    .where(eq(blogs.id, cand.id))
    .limit(1);
  const platformBlog = b as unknown as PlatformBlog;
  const destination = effectiveCtaDestination({
    niche: b.niche,
    blogDomain: b.domain,
    ctaUrl: b.ctaUrl,
  });
  console.log(`destination=${destination ?? "(none)"}`);

  const shopifyBlogId = (await resolveShopifyBlogId(platformBlog))?.blogId;

  const rows = await db
    .select({ id: generatedPosts.id, externalPostId: generatedPosts.externalPostId })
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.blogId, cand.id),
        eq(generatedPosts.status, "published"),
        isNotNull(generatedPosts.externalPostId),
      ),
    )
    .orderBy(desc(generatedPosts.publishedAt))
    .limit(4);
  console.log(`sampling ${rows.length} recent published posts (dry-run)\n`);

  let wouldUpdate = 0, alreadyClean = 0, links = 0, pixels = 0, failed = 0;
  for (const row of rows) {
    const body = await fetchLivePostBody(platformBlog, row.externalPostId!, shopifyBlogId);
    if (body === null) {
      failed++;
      console.log(`  [fail]      ${row.id} — live body unreadable`);
      continue;
    }
    let next = body;
    let repointed = 0;
    if (destination) {
      for (const redirectUrl of [ctaRedirectUrl(row.id), blogCtaRedirectUrl(cand.id)]) {
        const r = repointTrackedAnchors(next, redirectUrl, destination, row.id, b.domain);
        next = r.html;
        repointed += r.count;
      }
    }
    const pm = next.match(pixelImgRe());
    if (pm) {
      next = next.replace(pixelImgRe(), "");
      pixels += pm.length;
    }
    if (next === body) {
      alreadyClean++;
      console.log(`  [clean]     ${row.id}`);
      continue;
    }
    wouldUpdate++;
    links += repointed;
    console.log(`  [WOULD FIX] ${row.id} — ${repointed} link(s), ${pm?.length ?? 0} pixel(s)`);
    const before = body.match(/<a\b[^>]*netgrid-16f6[^>]*>/i)?.[0];
    const after = next.match(/<a\b[^>]*utm_campaign=netgrid_content[^>]*>/i)?.[0];
    if (before) console.log(`    before: ${before.slice(0, 140)}`);
    if (after) console.log(`    after : ${after.slice(0, 240)}`);
  }

  console.log(`\n  --- DRY RUN RESULT (${platform}: ${cand.domain}) ---`);
  console.log(`  sampled         : ${rows.length}`);
  console.log(`  would update    : ${wouldUpdate}`);
  console.log(`  already clean   : ${alreadyClean}`);
  console.log(`  failed          : ${failed}`);
  console.log(`  links repointed : ${links}`);
  console.log(`  pixels removed  : ${pixels}`);
  console.log(`  *** NOTHING WAS WRITTEN ***`);
}

async function main() {
  await pilot("wordpress");
  await pilot("shopify");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

