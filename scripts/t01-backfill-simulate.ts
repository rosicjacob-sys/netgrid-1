/**
 * T01 §6.3 LOCAL DRY RUN — absolutely no writes, no platform calls.
 *
 * Reproduces what backfillBlogSeo WOULD compute, entirely offline: reads the
 * stored meta from the DB (SELECT only) and runs the repo's real
 * normalizeMetaTitle / normalizeMetaDescription against each row, exactly as
 * seo-backfill-actions.ts:155-167 does — including the blog's brand_name.
 *
 * Unlike hitting /api/cron/seo-backfill?dryRun=1, this makes ZERO requests to
 * Shopify/WordPress and touches nothing in production. It answers: how many
 * posts change, on how many blogs, and does the result come out clean?
 *
 * READ ONLY. Emits .t01-backfill-simulation.json
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import {
  normalizeMetaTitle,
  normalizeMetaDescription,
} from "../src/lib/services/content-generator";
import {
  measureTitlePx,
  measureDescriptionPx,
  TITLE_MAX_PX,
  DESC_MAX_PX,
} from "../src/lib/seo/text-width";

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error("DATABASE_URL is not set");
const sql = neon(dbUrl);

const TOKEN = "(^|[^a-z])reddit([^a-z]|$)";

type Row = {
  id: string;
  blog_id: string;
  domain: string;
  brand_name: string | null;
  meta_title: string | null;
  meta_description: string | null;
  title: string | null;
  excerpt: string | null;
};

async function main() {
  const rows = (await sql`
    SELECT gp.id, gp.blog_id, b.domain, b.brand_name,
           gp.meta_title, gp.meta_description, gp.title, gp.excerpt
    FROM generated_posts gp
    JOIN blogs b ON b.id = gp.blog_id
    WHERE gp.status = 'published'
      AND gp.external_post_id IS NOT NULL
      AND (gp.meta_title ~* ${TOKEN} OR gp.meta_description ~* ${TOKEN})
    ORDER BY b.domain, gp.published_at DESC`) as unknown as Row[];

  console.log(`Simulating backfill for ${rows.length} affected post(s)\n`);

  let titleChanged = 0;
  let descChanged = 0;
  let stillDirty = 0;
  let titleOver = 0;
  let descOver = 0;
  let brandGained = 0;
  let emptyTitle = 0;
  const blogs = new Set<string>();
  const samples: Record<string, string>[] = [];

  for (const r of rows) {
    blogs.add(r.domain);

    const newTitle = normalizeMetaTitle(
      r.meta_title,
      r.title ?? "",
      undefined,
      r.brand_name,
    );
    const newDesc = normalizeMetaDescription(r.meta_description, r.excerpt ?? "");

    if (newTitle !== (r.meta_title ?? "")) titleChanged++;
    if (newDesc !== (r.meta_description ?? "")) descChanged++;

    const re = /\breddit\b/i;
    if (re.test(newTitle) || re.test(newDesc)) {
      stillDirty++;
      if (samples.length < 200) {
        samples.push({
          kind: "STILL-DIRTY",
          domain: r.domain,
          before: r.meta_title ?? "",
          after: newTitle,
        });
      }
    }

    const tPx = measureTitlePx(newTitle);
    const dPx = measureDescriptionPx(newDesc);
    if (tPx > TITLE_MAX_PX) titleOver++;
    if (dPx > DESC_MAX_PX) descOver++;
    if (!newTitle.trim()) emptyTitle++;
    if (r.brand_name && newTitle.includes(`| ${r.brand_name}`)) brandGained++;

    if (samples.length < 12) {
      samples.push({
        kind: "SAMPLE",
        domain: r.domain,
        brand: r.brand_name ?? "(none)",
        before: r.meta_title ?? "",
        after: newTitle,
        afterPx: String(Math.round(tPx)),
      });
    }
  }

  console.log("===== SIMULATION RESULT (nothing was written) =====");
  console.log(`affected posts            : ${rows.length}`);
  console.log(`distinct blogs            : ${blogs.size}`);
  console.log(`meta_title would change   : ${titleChanged}`);
  console.log(`meta_desc would change    : ${descChanged}`);
  console.log(`STILL carrying token after: ${stillDirty}   (must be 0)`);
  console.log(`title over ${TITLE_MAX_PX}px after   : ${titleOver}   (must be 0)`);
  console.log(`desc over ${DESC_MAX_PX}px after    : ${descOver}   (must be 0)`);
  console.log(`would gain "| brand"      : ${brandGained}`);
  console.log(`would become EMPTY title  : ${emptyTitle}   (must be 0)`);

  console.log("\n----- before/after samples -----");
  for (const s of samples.filter((x) => x.kind === "SAMPLE")) {
    console.log(`\n${s.domain}  brand=${s.brand}`);
    console.log(`  before: ${JSON.stringify(s.before)}`);
    console.log(`  after : ${JSON.stringify(s.after)}  (${s.afterPx}px)`);
  }

  const bad = samples.filter((x) => x.kind === "STILL-DIRTY");
  if (bad.length) {
    console.log("\n!!! ROWS THAT WOULD REMAIN DIRTY:");
    for (const s of bad.slice(0, 20)) {
      console.log(`  ${s.domain}: ${JSON.stringify(s.before)} -> ${JSON.stringify(s.after)}`);
    }
  }

  writeFileSync(
    ".t01-backfill-simulation.json",
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note: "LOCAL SIMULATION ONLY — no DB or platform writes were performed.",
        counts: {
          affectedPosts: rows.length,
          distinctBlogs: blogs.size,
          titleWouldChange: titleChanged,
          descWouldChange: descChanged,
          stillDirtyAfter: stillDirty,
          titleOverCeiling: titleOver,
          descOverCeiling: descOver,
          wouldGainBrand: brandGained,
          wouldBecomeEmpty: emptyTitle,
        },
        affectedDomains: [...blogs].sort(),
        samples,
      },
      null,
      2,
    ),
  );
  console.log("\nWrote .t01-backfill-simulation.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
