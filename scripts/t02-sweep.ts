/**
 * T02 §6 — NETWORK SWEEP of the reverse backfill, with the pilot's safety
 * contract preserved:
 *
 *   - verify-after-every-write (6 checks), HARD STOP on any failure
 *   - only writes when the live body actually changes (idempotent; safe to
 *     re-run, so this script can be interrupted and restarted freely)
 *   - time budget per invocation (STOP_AFTER_MINUTES, default 5) so each run
 *     is short and supervised; progress is appended to .t02-sweep-progress.json
 *   - per Shopify blog processed, also swaps the theme block v2 -> v3
 *     (removes the site-wide head beacon); idempotent
 *   - reads credentials from the blogs table; writes nothing else
 *
 * Usage: npx cross-env NODE_OPTIONS=--dns-result-order=ipv4first tsx scripts/t02-sweep.ts
 *   STOP_AFTER_MINUTES=5  POSTS_PER_BLOG=60  MAX_BLOGS=0(all)
 */
import "dotenv/config";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { db } from "../src/lib/db";
import { blogs, clients, generatedPosts } from "../src/lib/db/schema";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import {
  backfillPostSeo,
  buildShopifyCreds,
  fetchLivePostBodyResult,
  resolveShopifyBlogId,
  type PlatformBlog,
} from "../src/lib/services/platform-client";
import { injectSeoMetaTags } from "../src/lib/services/shopify-theme-client";
import {
  ctaRedirectUrl,
  blogCtaRedirectUrl,
  getAppBaseUrl,
} from "../src/lib/services/link-tracker";
import { effectiveCtaDestination } from "../src/lib/content/cta-target";
import { COMMERCIAL_LINK_REL, withUtm } from "../src/lib/content/outbound-links";

const BUDGET_MS = Number(process.env.STOP_AFTER_MINUTES ?? 5) * 60_000;
const POSTS_PER_BLOG = Number(process.env.POSTS_PER_BLOG ?? 60);
const MAX_BLOGS = Number(process.env.MAX_BLOGS ?? 0);
const PROGRESS = ".t02-sweep-progress.json";
const START = Date.now();

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

function loadDone(): Set<string> {
  if (!existsSync(PROGRESS)) return new Set();
  try {
    const lines = readFileSync(PROGRESS, "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    const last = new Map<string, number>();
    for (const l of lines) {
      try {
        const r = JSON.parse(l) as { domain: string; more?: number };
        last.set(r.domain, r.more ?? 0);
      } catch {
        /* ignore malformed line */
      }
    }
    // A blog is "done" only when its LAST record shows nothing left over.
    // Blogs cut off mid-run by the time budget (more > 0) are re-processed —
    // already-fixed posts simply read back clean (idempotent).
    return new Set([...last.entries()].filter(([, m]) => m === 0).map(([d]) => d));
  } catch {
    return new Set();
  }
}
function record(entry: Record<string, unknown>) {
  appendFileSync(PROGRESS, JSON.stringify(entry) + "\n");
}

let hardStop = false;

/** Retry a DB read a few times — Neon's HTTP driver occasionally drops a
 *  connection, and one transient error should not kill a 9-hour sweep. */
async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const wait = 2000 * i;
      console.log(`  [retry ${i}/${tries}] ${label} failed (${(e as Error).message?.slice(0, 60)}) — waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// ---- SWEEP-LOGIC (appended below) ----

async function repairPost(
  platformBlog: PlatformBlog,
  shopifyBlogId: string | undefined,
  postId: string,
  externalPostId: string,
  destination: string,
  blogDomain: string | null,
  blogId: string,
): Promise<"fixed" | "clean" | "failed" | "rejected"> {
  const before = await fetchLivePostBodyResult(platformBlog, externalPostId, shopifyBlogId);
  if (before.body === null) return "failed";
  const body = before.body;

  let next = body;
  let repointed = 0;
  for (const redirectUrl of [ctaRedirectUrl(postId), blogCtaRedirectUrl(blogId)]) {
    const r = repointTrackedAnchors(next, redirectUrl, destination, postId, blogDomain);
    next = r.html;
    repointed += r.count;
  }
  const pm = next.match(pixelImgRe());
  if (pm) next = next.replace(pixelImgRe(), "");
  // Also strip the pixel URL as a RAW string anywhere it survives outside an
  // <img> tag — WordPress SEO plugins bake it into their JSON-LD "image"
  // array (found live on ecoledesparisanalyse.ca). Replacing the full URL
  // string keeps the JSON valid ("image":[""]).
  for (const raw of [
    `${getAppBaseUrl()}/api/track/px/${postId}`,
    `${getAppBaseUrl()}/api/track/px/blog/`,
  ]) {
    while (next.includes(raw)) next = next.replace(raw, "");
  }
  if (next === body) return "clean";
  if (next.length < body.length * 0.5) {
    hardStop = true;
    console.log(`  !!!!! HARD STOP: computed body suspiciously short for ${postId}`);
    return "failed";
  }

  const push = await backfillPostSeo(platformBlog, externalPostId, { bodyHtml: next }, shopifyBlogId);
  if (!push.success) return "rejected";

  // VERIFY: re-fetch and confirm. Retry the read — a transient timeout/rate
  // limit right after a write is not a verification failure, and the write
  // itself is idempotent-safe to re-check later (found live on
  // portarthurpeptides.ca: write landed, first re-read timed out).
  let after: string | null = null;
  for (let i = 1; i <= 3 && after === null; i++) {
    after = (await fetchLivePostBodyResult(platformBlog, externalPostId, shopifyBlogId)).body;
    if (after === null) await new Promise((r) => setTimeout(r, 3000 * i));
  }
  if (after === null) {
    hardStop = true;
    console.log(`  !!!!! HARD STOP: could not re-fetch ${postId} after write (3 attempts)`);
    return "failed";
  }
  const strictOk =
    !after.includes("netgrid-16f6.onrender.com/r/") &&
    !after.includes("netgrid-16f6.onrender.com/api/track") &&
    after.length > body.length * 0.5 &&
    (after.match(/<p[\s>]/gi) ?? []).length >= (body.match(/<p[\s>]/gi) ?? []).length - 1;
  if (!strictOk) {
    hardStop = true;
    console.log(
      `  !!!!! HARD STOP: verification failed for ${postId} ` +
        `(host=${after.includes("netgrid-16f6.onrender.com/")}, ` +
        `truncated=${after.length <= body.length * 0.5})`,
    );
    return "failed";
  }

  await withRetry(
    () =>
      db
        .update(generatedPosts)
        .set({ body: next, updatedAt: new Date() })
        .where(eq(generatedPosts.id, postId)),
    `DB mirror for ${postId}`,
  );
  console.log(`    fixed ${postId} (${repointed} links, ${pm?.length ?? 0} pixels)`);
  return "fixed";
}

async function main() {
  const done = loadDone();
  console.log(`budget=${BUDGET_MS / 60000}min  posts/blog=${POSTS_PER_BLOG}  already-done=${done.size}`);

  const affected = await db
    .select({
      id: blogs.id, domain: blogs.domain, platform: blogs.platform,
      wpUrl: blogs.wpUrl, wpUsername: blogs.wpUsername, wpAppPassword: blogs.wpAppPassword,
      seoPlugin: blogs.seoPlugin, shopifyAuthMode: blogs.shopifyAuthMode,
      shopifyStoreUrl: blogs.shopifyStoreUrl, shopifyAdminApiToken: blogs.shopifyAdminApiToken,
      shopifyClientId: blogs.shopifyClientId, shopifyClientSecret: blogs.shopifyClientSecret,
      shopifyBlogHandle: blogs.shopifyBlogHandle,
      niche: clients.niche, ctaUrl: clients.ctaUrl,
      n: sql<number>`count(*)`,
    })
    .from(blogs)
    .innerJoin(clients, eq(clients.id, blogs.clientId))
    .innerJoin(
      generatedPosts,
      and(
        eq(generatedPosts.blogId, blogs.id),
        eq(generatedPosts.status, "published"),
        isNotNull(generatedPosts.externalPostId),
      ),
    )
    .where(
      and(
        eq(blogs.status, "active"),
        sql`(${generatedPosts.body} LIKE '%/api/track/px/%' OR ${generatedPosts.body} LIKE '%/r/' || ${generatedPosts.id}::text || '%')`,
      ),
    )
    .groupBy(
      blogs.id, blogs.domain, blogs.platform, blogs.wpUrl, blogs.wpUsername,
      blogs.wpAppPassword, blogs.seoPlugin, blogs.shopifyAuthMode, blogs.shopifyStoreUrl,
      blogs.shopifyAdminApiToken, blogs.shopifyClientId, blogs.shopifyClientSecret,
      blogs.shopifyBlogHandle, clients.niche, clients.ctaUrl,
    )
    .orderBy(sql`count(*) DESC`);

  const todo = affected.filter((b) => !done.has(b.domain));
  console.log(`affected blogs: ${affected.length}  remaining: ${todo.length}\n`);
  if (todo.length === 0 && affected.length > 0) {
    appendFileSync(".t02-sweep-complete", new Date().toISOString() + "\n");
    console.log("ALL AFFECTED BLOGS PROCESSED. SWEEP COMPLETE.");
    return;
  }

  let blogsDone = 0;
  for (const b of todo) {
    if (hardStop) break;
    if (Date.now() - START > BUDGET_MS) { console.log("\n[budget reached — resume by re-running]"); break; }
    if (MAX_BLOGS > 0 && blogsDone >= MAX_BLOGS) break;

    try {
      await processBlog(b);
      blogsDone++;
    } catch (e) {
      // Transient network/platform error (e.g. a 15s timeout). The blog is NOT
      // recorded in the progress file, so a later pass retries it; every post
      // write is atomic, so there is no partial state to clean up.
      console.log(`  [transient error on ${b.domain}] ${(e as Error).message?.slice(0, 90)} — skipping to next blog (will retry on a later pass)`);
    }
  }

  console.log(
    `\nSWEEP RUN DONE. blogs this run: ${blogsDone}  hardStop: ${hardStop}` +
    (hardStop ? "  !!! INVESTIGATE BEFORE RE-RUNNING !!!" : "  re-run to continue."),
  );
  if (hardStop) process.exit(2);
}

type AffectedBlog = {
  id: string; domain: string; platform: string;
  wpUrl: string | null; wpUsername: string | null; wpAppPassword: string | null;
  seoPlugin: string | null; shopifyAuthMode: string | null;
  shopifyStoreUrl: string | null; shopifyAdminApiToken: string | null;
  shopifyClientId: string | null; shopifyClientSecret: string | null;
  shopifyBlogHandle: string | null;
  niche: string | null; ctaUrl: string | null; n: number;
};

async function processBlog(b: AffectedBlog) {
    console.log(`\n== ${b.domain} (${b.platform}, ~${b.n} affected posts) ==`);
    const platformBlog = b as unknown as PlatformBlog;
    const destination = effectiveCtaDestination({
      niche: b.niche, blogDomain: b.domain, ctaUrl: b.ctaUrl,
    });

    let fixed = 0, clean = 0, failed = 0, rejected = 0, processed = 0;
    const shopifyBlogId = (await resolveShopifyBlogId(platformBlog))?.blogId;

    if (destination) {
      const rows = await withRetry(
        () =>
          db
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
            .limit(POSTS_PER_BLOG),
        `posts query for ${b.domain}`,
      );

      for (const row of rows) {
        if (hardStop) break;
        if (Date.now() - START > BUDGET_MS) break;
        const r = await repairPost(
          platformBlog, shopifyBlogId, row.id, row.externalPostId!, destination, b.domain, b.id,
        );
        processed++;
        if (r === "fixed") fixed++;
        else if (r === "clean") clean++;
        else if (r === "rejected") rejected++;
        else if (r === "failed") failed++;
      }
    } else {
      console.log("  no CTA destination — posts left as-is (unresolved)");
    }

    // Theme block swap (Shopify): removes the site-wide head beacon. Idempotent.
    let theme = "n/a";
    if (b.platform === "shopify" && !hardStop) {
      const blogRow = (
        await withRetry(
          () => db.select().from(blogs).where(eq(blogs.id, b.id)).limit(1),
          `blog row for theme swap (${b.domain})`,
        )
      )[0];
      const built = buildShopifyCreds(blogRow);
      if (built.ok) {
        const res = await injectSeoMetaTags(built.creds);
        theme = res.action ?? (res.success ? "ok" : `fail: ${res.message.slice(0, 40)}`);
      } else {
        theme = `creds: ${built.message.slice(0, 40)}`;
      }
    }

    console.log(
      `  => processed=${processed} fixed=${fixed} clean=${clean} rejected=${rejected} failed=${failed} theme=${theme}`,
    );
    record({
      at: new Date().toISOString(), domain: b.domain, platform: b.platform,
      processed, fixed, clean, rejected, failed, theme,
      more: Number(b.n) > processed ? Number(b.n) - processed : 0,
    });
}

main().catch((e) => {
  console.error("[FATAL]", e.message);
  process.exit(1);
});


