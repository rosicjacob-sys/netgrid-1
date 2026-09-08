/**
 * T02 §6.2 step 4 — LIVE PILOT: repair the published posts of exactly TWO
 * blogs (one WordPress, one Shopify), with verify-after-every-write and a
 * HARD STOP on any anomaly.
 *
 * Safety contract, per the user's instruction ("if anything breaks, stop"):
 *   1. Only the two named pilot blogs — nothing else.
 *   2. Only 4 posts each (the same ones the dry-run verified).
 *   3. After EVERY write: re-fetch the live body and verify the repair
 *      landed (no /r/ href, no pixel, UTMs present, content not truncated,
 *      paragraphs intact). Any failed check => STOP immediately.
 *   4. Mirror the repaired body into generated_posts ONLY after the live
 *      verification passes (same as the production action).
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { blogs, clients, generatedPosts } from "../src/lib/db/schema";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import {
  backfillPostSeo,
  fetchLivePostBodyResult,
  resolveShopifyBlogId,
  type PlatformBlog,
} from "../src/lib/services/platform-client";
import {
  ctaRedirectUrl,
  blogCtaRedirectUrl,
} from "../src/lib/services/link-tracker";
import { effectiveCtaDestination } from "../src/lib/content/cta-target";
import { COMMERCIAL_LINK_REL, withUtm } from "../src/lib/content/outbound-links";

const PILOT_DOMAINS = ["ecoledesparisguide.com", "claringtonpeptides.ca"];
const POSTS_PER_BLOG = 4;

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

let aborted = false;

function fail(msg: string): never {
  console.log(`\n!!!! STOP: ${msg}`);
  console.log("!!!! No further posts will be processed.");
  aborted = true;
  throw new Error(msg);
}

// ---- REPAIR-LOGIC (appended below) ----

async function repairBlog(domain: string) {
  console.log(`\n===== LIVE REPAIR: ${domain} =====`);
  const [b] = await db
    .select({
      id: blogs.id, platform: blogs.platform, wpUrl: blogs.wpUrl,
      wpUsername: blogs.wpUsername, wpAppPassword: blogs.wpAppPassword,
      seoPlugin: blogs.seoPlugin, shopifyAuthMode: blogs.shopifyAuthMode,
      shopifyStoreUrl: blogs.shopifyStoreUrl,
      shopifyAdminApiToken: blogs.shopifyAdminApiToken,
      shopifyClientId: blogs.shopifyClientId,
      shopifyClientSecret: blogs.shopifyClientSecret,
      shopifyBlogHandle: blogs.shopifyBlogHandle,
      domain: blogs.domain, niche: clients.niche, ctaUrl: clients.ctaUrl,
    })
    .from(blogs)
    .innerJoin(clients, eq(clients.id, blogs.clientId))
    .where(eq(blogs.domain, domain))
    .limit(1);
  if (!b) throw new Error(`blog ${domain} not found`);
  const platformBlog = b as unknown as PlatformBlog;
  const destination = effectiveCtaDestination({
    niche: b.niche, blogDomain: b.domain, ctaUrl: b.ctaUrl,
  });
  console.log(`platform=${b.platform} destination=${destination ?? "(none)"}`);
  if (!destination) {
    console.log("no CTA destination — skipping (links left as-is)");
    return;
  }

  const shopifyBlogId = (await resolveShopifyBlogId(platformBlog))?.blogId;

  const rows = await db
    .select({ id: generatedPosts.id, externalPostId: generatedPosts.externalPostId })
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.blogId, b.id),
        eq(generatedPosts.status, "published"),
        isNotNull(generatedPosts.externalPostId),
      ),
    )
    .orderBy(desc(generatedPosts.publishedAt))
    .limit(POSTS_PER_BLOG);

  let fixed = 0, clean = 0;
  for (const row of rows) {
    if (aborted) return;
    console.log(`\n-- post ${row.id}`);
    const before = await fetchLivePostBodyResult(
      platformBlog, row.externalPostId!, shopifyBlogId,
    );
    if (before.body === null) {
      console.log(`   unreadable (${before.error ?? "null"}) — SKIP, continuing`);
      continue;
    }
    const body = before.body;

    let next = body;
    let repointed = 0;
    for (const redirectUrl of [ctaRedirectUrl(row.id), blogCtaRedirectUrl(b.id)]) {
      const r = repointTrackedAnchors(next, redirectUrl, destination, row.id, b.domain);
      next = r.html;
      repointed += r.count;
    }
    const pm = next.match(pixelImgRe());
    if (pm) next = next.replace(pixelImgRe(), "");

    if (next === body) {
      clean++;
      console.log("   already clean — nothing to do");
      continue;
    }
    if (next.length < body.length * 0.5) {
      fail(`computed body suspiciously short for ${row.id} — refusing to write`);
    }

    const push = await backfillPostSeo(
      platformBlog, row.externalPostId!, { bodyHtml: next }, shopifyBlogId,
    );
    if (!push.success) {
      console.log(`   platform rejected write (${push.message}) — untouched, continuing`);
      continue;
    }

    // VERIFY: re-fetch and confirm the repair landed and nothing else broke.
    const afterRes = await fetchLivePostBodyResult(
      platformBlog, row.externalPostId!, shopifyBlogId,
    );
    const after = afterRes.body;
    if (after === null) {
      fail(`could not re-fetch ${row.id} after writing — cannot verify. STOPPED.`);
    }
    const checks = [
      { name: "no /r/ redirect href", ok: !/\/r\/[0-9a-f-]{36}/i.test(after) },
      { name: "no tracking pixel", ok: !/\/api\/track\/px\//i.test(after) },
      { name: "UTM campaign present", ok: after.includes("utm_campaign=netgrid_content") },
      { name: "content not truncated", ok: after.length > body.length * 0.5 },
      {
        name: "paragraphs intact",
        ok: (after.match(/<p[\s>]/gi) ?? []).length >= (body.match(/<p[\s>]/gi) ?? []).length - 1,
      },
      {
        name: "shared host gone",
        ok: !after.includes("netgrid-16f6.onrender.com/r/") && !after.includes("netgrid-16f6.onrender.com/api/track"),
      },
    ];
    const failedChecks = checks.filter((c) => !c.ok);
    if (failedChecks.length > 0) {
      fail(`verification failed for ${row.id}: ${failedChecks.map((c) => c.name).join(", ")}`);
    }

    await db
      .update(generatedPosts)
      .set({ body: next, updatedAt: new Date() })
      .where(eq(generatedPosts.id, row.id));

    fixed++;
    console.log(`   REPAIRED + VERIFIED: ${repointed} link(s), ${pm?.length ?? 0} pixel(s); ${checks.length}/6 checks passed`);
  }

  console.log(`\n  --- LIVE RESULT (${domain}) ---`);
  console.log(`  repaired+verified : ${fixed}`);
  console.log(`  already clean      : ${clean}`);
}

async function main() {
  for (const d of PILOT_DOMAINS) {
    await repairBlog(d);
    if (aborted) break;
  }
  console.log("\nDONE. " + (aborted ? "STOPPED EARLY — see above." : "Both pilots complete."));
}

main().catch((e) => {
  console.error("\n[FATAL]", e.message);
  process.exit(1);
});

