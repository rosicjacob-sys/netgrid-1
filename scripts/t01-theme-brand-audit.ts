/**
 * T01 §7.5 — network-wide audit for Shopify theme double-branding. READ ONLY.
 *
 * For every ACTIVE Shopify blog that has blogs.brand_name set, fetch one
 * recently-published live page and inspect its <title> for a trailing
 * en/em-dash theme suffix that repeats the brand we already wrote into
 * global.title_tag. Such stores must have brand_name nulled (SOP §4, §8.5)
 * until the theme.liquid suffix is removed, otherwise the rendered title reads
 * "Keyword | Brand – Brand" and overruns the 580px audit ceiling.
 *
 * Writes NOTHING to the database or any platform: only HTTP GETs.
 * Emits a JSON report to .t01-theme-audit.json for the follow-up fix script.
 *
 * Usage:
 *   npx cross-env NODE_OPTIONS=--dns-result-order=ipv4first tsx scripts/t01-theme-brand-audit.ts
 * Options (env): LIMIT=600  CONCURRENCY=8
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { measureTitlePx, TITLE_MAX_PX } from "../src/lib/seo/text-width";

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error("DATABASE_URL is not set");
const sql = neon(dbUrl);

const LIMIT = Number(process.env.LIMIT || 600);
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const REPORT = ".t01-theme-audit.json";

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&#8211;|&ndash;/gi, "–")
    .replace(/&#8212;|&mdash;/gi, "—")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Loose compare: ignore case, spacing and hyphens ("Lac-Beauport" == "Lacbeauport"). */
function loose(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Trailing " – X" / " — X" suffix appended by the theme (our separator is "|"). */
const THEME_SUFFIX = /[\s\u00a0]*[–—][^–—]*$/;

/** Returns the offending theme suffix, or "" when the title is clean. */
function themeSuffixRepeatingBrand(title: string, brand: string): string {
  const m = title.match(THEME_SUFFIX);
  if (!m) return "";
  const suffix = m[0].replace(/^[\s\u00a0]*[–—][\s\u00a0]*/, "").trim();
  if (!suffix) return "";
  const b = loose(brand);
  // Drop a trailing "(PC)"-style marker before comparing.
  const suffixBrand = loose(suffix.replace(/\([^)]*\)\s*$/, ""));
  if (!b || !suffixBrand) return "";
  return suffixBrand.includes(b) || b.includes(suffixBrand) ? suffix : "";
}

type Row = {
  blog_id: string;
  domain: string;
  brand_name: string;
  external_post_url: string;
};

type Finding = {
  blogId: string;
  domain: string;
  brand: string;
  url: string;
  title: string;
  titlePx: number;
  themeSuffix: string;
  overCeiling: boolean;
  hasRedditToken: boolean;
  status: "double-branded" | "clean" | "unreachable";
  note?: string;
};

async function checkOne(r: Row): Promise<Finding> {
  const base: Finding = {
    blogId: r.blog_id,
    domain: r.domain,
    brand: r.brand_name,
    url: r.external_post_url,
    title: "",
    titlePx: 0,
    themeSuffix: "",
    overCeiling: false,
    hasRedditToken: false,
    status: "unreachable",
  };
  try {
    const res = await fetch(r.external_post_url, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (compatible; NetGridAudit/1.0)" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { ...base, note: `HTTP ${res.status}` };
    const html = await res.text();
    const title = decode(
      (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1] || "",
    );
    const suffix = themeSuffixRepeatingBrand(title, r.brand_name);
    const px = measureTitlePx(title);
    return {
      ...base,
      title,
      titlePx: Math.round(px),
      themeSuffix: suffix,
      overCeiling: px > TITLE_MAX_PX,
      hasRedditToken: /\breddit\b/i.test(title),
      status: suffix ? "double-branded" : "clean",
    };
  } catch (e) {
    return { ...base, note: (e as Error).message.slice(0, 80) };
  }
}

async function main() {
  // One most-recent published page per branded, active Shopify blog.
  const rows = (await sql`
    SELECT DISTINCT ON (b.id)
           b.id AS blog_id, b.domain, b.brand_name, gp.external_post_url
    FROM blogs b
    JOIN generated_posts gp ON gp.blog_id = b.id
    WHERE b.platform = 'shopify'
      AND b.status = 'active'
      AND b.brand_name IS NOT NULL AND btrim(b.brand_name) <> ''
      AND gp.status = 'published'
      AND gp.external_post_url IS NOT NULL
    ORDER BY b.id, gp.published_at DESC
    LIMIT ${LIMIT}`) as unknown as Row[];

  console.log(
    `Auditing ${rows.length} branded active Shopify blog(s), concurrency ${CONCURRENCY}\n`,
  );

  const findings: Finding[] = [];
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    findings.push(...(await Promise.all(batch.map(checkOne))));
    const done = Math.min(i + CONCURRENCY, rows.length);
    const db = findings.filter((f) => f.status === "double-branded").length;
    process.stdout.write(
      `\r  checked ${done}/${rows.length} — double-branded so far: ${db}   `,
    );
  }
  console.log("\n");

  const doubled = findings.filter((f) => f.status === "double-branded");
  const clean = findings.filter((f) => f.status === "clean");
  const unreachable = findings.filter((f) => f.status === "unreachable");
  const tokened = findings.filter((f) => f.hasRedditToken);
  const over = findings.filter((f) => f.overCeiling);

  console.log("===== SUMMARY =====");
  console.log(`blogs audited      : ${findings.length}`);
  console.log(`double-branded     : ${doubled.length}`);
  console.log(`clean              : ${clean.length}`);
  console.log(`unreachable        : ${unreachable.length}`);
  console.log(`reddit token       : ${tokened.length}   (must be 0)`);
  console.log(`title over ${TITLE_MAX_PX}px  : ${over.length}`);

  if (doubled.length) {
    const avg = doubled.reduce((a, f) => a + f.titlePx, 0) / doubled.length;
    console.log(
      `\navg double-branded title width: ${avg.toFixed(0)}px (ceiling ${TITLE_MAX_PX}px)`,
    );
    console.log("\nWorst 10 offenders:");
    for (const f of [...doubled].sort((a, b) => b.titlePx - a.titlePx).slice(0, 10)) {
      console.log(`  ${f.titlePx}px  ${f.domain}  suffix="${f.themeSuffix}"`);
    }
  }
  if (tokened.length) {
    console.log("\n!! PAGES STILL CARRYING THE REDDIT TOKEN:");
    for (const f of tokened) console.log(`  ${f.domain} — ${f.title}`);
  }
  if (unreachable.length) {
    console.log("\nUnreachable (EXCLUDED from the fix list):");
    for (const f of unreachable.slice(0, 15)) {
      console.log(`  ${f.domain} — ${f.note}`);
    }
    if (unreachable.length > 15) {
      console.log(`  ...and ${unreachable.length - 15} more`);
    }
  }

  writeFileSync(
    REPORT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        ceilingPx: TITLE_MAX_PX,
        counts: {
          audited: findings.length,
          doubleBranded: doubled.length,
          clean: clean.length,
          unreachable: unreachable.length,
          redditToken: tokened.length,
          overCeiling: over.length,
        },
        // Only CONFIRMED double-branded blogs are candidates for the fix.
        fixCandidates: doubled.map((f) => ({
          blogId: f.blogId,
          domain: f.domain,
          brand: f.brand,
          titlePx: f.titlePx,
          themeSuffix: f.themeSuffix,
          title: f.title,
        })),
        all: findings,
      },
      null,
      2,
    ),
  );
  console.log(`\nReport written to ${REPORT} (${doubled.length} fix candidate(s))`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
