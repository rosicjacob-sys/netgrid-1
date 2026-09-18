/**
 * Local keyword-targeted content — end-to-end smoke test.
 *
 * Exercises the full pipeline from docs/local-keyword-content-plan.md against
 * a REAL database (and, with --live, a real Claude/DeepSeek call) using
 * disposable fixture data — a client/blog/keywords all named and domained so
 * they can never be mistaken for real data, cleaned up automatically when
 * the run finishes.
 *
 * This exists because the PRs that built this feature (#116-#119) were
 * developed in a sandbox with no DATABASE_URL and no ANTHROPIC_API_KEY —
 * every check that didn't need live infrastructure was run (pure-function
 * tests, tsc, eslint), but the actual Drizzle queries, the claim/lifecycle
 * transitions, and — with --live — a real model call through the new
 * LOCAL_TARGETING_DIRECTIVE and the meta title/description guarantee, were
 * never run against anything real. This script is that missing check.
 *
 * Usage (from project root, DATABASE_URL required):
 *   npx tsx src/lib/db/verify-local-targeting.ts
 *   npx tsx src/lib/db/verify-local-targeting.ts --live   (see cost note below)
 *   npx tsx src/lib/db/verify-local-targeting.ts --keep   (skip cleanup)
 *
 * --live cost note: generateContent's word band is a GLOBAL constant
 * (1000-2000 words regardless of any option passed here), so this is one
 * real ~1000-2000 word article generation — a few cents on DeepSeek, more on
 * Claude. It also triggers the (unrelated, untouched-by-this-feature) image
 * pipeline; that pipeline already degrades gracefully with no image API key
 * configured (ships without images rather than failing), so --live works
 * fine with ONLY ANTHROPIC_API_KEY or DEEPSEEK_API_KEY set. Without --live,
 * this script makes no external API calls and costs nothing — it only
 * exercises the database layer (schema, builder, claim, lifecycle,
 * placeholder interpolation).
 *
 * Cleanup: deletes the fixture client, which cascades (ON DELETE CASCADE) to
 * its blog, keyword targets, and scraped keywords. Pass --keep to leave the
 * fixture in place for manual inspection; the client/blog ids are printed
 * either way.
 */

import { eq } from "drizzle-orm";
import { db } from "./index";
import { clients, blogs, clientKeywords, blogKeywordTargets, generatedPosts } from "./schema";
import {
  buildKeywordTargetsForBlogInternal,
  claimKeywordTargetForBlog,
  markKeywordTargetFailed,
  markKeywordTargetGenerated,
} from "../actions/keyword-target-actions";
import {
  interpolatePromptPlaceholders,
  hasPlaceholders,
} from "../content/prompt-placeholders";
import { deriveBrandName } from "../content/brand";
import { generateContent } from "../services/content-generator";
import {
  measureTitlePx,
  measureDescriptionPx,
  TITLE_MAX_PX,
  DESC_MAX_PX,
} from "../seo/text-width";

const LIVE = process.argv.includes("--live");
const KEEP = process.argv.includes("--keep");

const FIXTURE_CLIENT_NAME = "__local_targeting_smoke_test__";
const FIXTURE_DOMAIN = "zzz-local-targeting-smoketest.invalid"; // .invalid: IANA-reserved, never a real domain
const FIXTURE_CITY = "Smoketestville";
const FIXTURE_BRAND = "Smoketest Widgets"; // exercises the meta-title brand suffix
const FIXTURE_KEYWORDS = [
  "buy smoketest widgets",
  "smoketest widgets for sale",
  "smoketest widget dosage chart", // informational-shaped — should NOT get a "buy" framing
];

interface CheckResult {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
}
const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string) {
  results.push({ name, status: ok ? "PASS" : "FAIL", detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name} — ${detail}`);
}
function skip(name: string, detail: string) {
  results.push({ name, status: "SKIP", detail });
  console.log(`  [SKIP] ${name} — ${detail}`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is not set. Run with:\n  DATABASE_URL=postgres://... npx tsx src/lib/db/verify-local-targeting.ts",
    );
    process.exit(1);
  }

  console.log(`Local keyword-targeting smoke test${LIVE ? " (--live: will call the model + spend real API credit)" : ""}\n`);

  // blogs.domain is unique — clean up any stale fixture a previous --keep
  // run left behind before creating a fresh one, so re-runs never fail on
  // a collision with our own leftover data.
  const [stale] = await db
    .select({ clientId: blogs.clientId })
    .from(blogs)
    .where(eq(blogs.domain, FIXTURE_DOMAIN))
    .limit(1);
  if (stale) {
    await db.delete(clients).where(eq(clients.id, stale.clientId));
    console.log("Removed a stale fixture from a previous --keep run.\n");
  }

  // ── Fixture setup ──────────────────────────────────────────────────────
  const [client] = await db
    .insert(clients)
    .values({ name: FIXTURE_CLIENT_NAME })
    .returning({ id: clients.id });
  console.log(`Fixture client: ${client.id}`);

  const [blog] = await db
    .insert(blogs)
    .values({
      clientId: client.id,
      domain: FIXTURE_DOMAIN,
      city: FIXTURE_CITY,
      brandName: FIXTURE_BRAND,
      status: "setup", // never "active" — must never be picked up by the real auto-publish cron
    })
    .returning({ id: blogs.id, domain: blogs.domain });
  console.log(`Fixture blog: ${blog.id} (${blog.domain}, city=${FIXTURE_CITY})\n`);

  try {
    const now = new Date();
    await db.insert(clientKeywords).values(
      FIXTURE_KEYWORDS.map((keyword, i) => ({
        clientId: client.id,
        keyword,
        source: "google_autocomplete",
        hitCount: FIXTURE_KEYWORDS.length - i,
        bestPosition: i + 1,
        fetchedAt: now,
      })),
    );

    // A real generated_posts row so markKeywordTargetGenerated's FK
    // (generatedPostId -> generated_posts.id) has something real to point
    // at — a fabricated UUID would just throw a foreign-key violation.
    const [fixturePost] = await db
      .insert(generatedPosts)
      .values({ blogId: blog.id, clientId: client.id, topic: "smoke test fixture post" })
      .returning({ id: generatedPosts.id });

    // ── 1. Builder against a real Postgres ───────────────────────────────
    console.log("1. Target builder");
    const build1 = await buildKeywordTargetsForBlogInternal(blog.id);
    record(
      "builder targets the blog and upserts every eligible keyword",
      build1.targeted && build1.upserted === FIXTURE_KEYWORDS.length,
      `targeted=${build1.targeted} upserted=${build1.upserted}/${FIXTURE_KEYWORDS.length} (${build1.message})`,
    );

    const build2 = await buildKeywordTargetsForBlogInternal(blog.id);
    const rowCountAfterRebuild = await db
      .select({ id: blogKeywordTargets.id })
      .from(blogKeywordTargets)
      .where(eq(blogKeywordTargets.blogId, blog.id));
    record(
      "rebuild is idempotent — no duplicate rows",
      build2.upserted === FIXTURE_KEYWORDS.length &&
        rowCountAfterRebuild.length === FIXTURE_KEYWORDS.length,
      `second build upserted=${build2.upserted}, total rows in ledger=${rowCountAfterRebuild.length}`,
    );

    // ── 2. Claim / lifecycle transitions ─────────────────────────────────
    console.log("\n2. Claim + lifecycle");
    const claimA = await claimKeywordTargetForBlog(blog.id);
    record(
      "claim returns the best-priority pending row",
      Boolean(claimA),
      claimA ? `claimed "${claimA.keyword}"` : "claim returned undefined",
    );

    const claimB = await claimKeywordTargetForBlog(blog.id);
    record(
      "second claim returns a DIFFERENT row (first is no longer pending)",
      Boolean(claimB) && claimB?.id !== claimA?.id,
      claimB ? `claimed "${claimB.keyword}" (id ${claimB.id})` : "claim returned undefined",
    );

    if (claimA) {
      await markKeywordTargetFailed(claimA.id, "smoke test — intentional failure");
      const [rowA] = await db
        .select({
          status: blogKeywordTargets.status,
          failureReason: blogKeywordTargets.failureReason,
          attempts: blogKeywordTargets.attempts,
          nextRetryAt: blogKeywordTargets.nextRetryAt,
        })
        .from(blogKeywordTargets)
        .where(eq(blogKeywordTargets.id, claimA.id));
      // T10: a single failure no longer buries the row in 'failed' forever.
      // It is requeued to 'pending' with a cool-off, and only dead-letters to
      // 'failed' once it has burned KEYWORD_TARGET_MAX_ATTEMPTS attempts.
      record(
        "markKeywordTargetFailed requeues to 'pending' with a cool-off",
        rowA?.status === "pending" &&
          rowA?.attempts === 1 &&
          rowA?.nextRetryAt instanceof Date &&
          Boolean(rowA?.failureReason),
        `status=${rowA?.status} attempts=${rowA?.attempts} nextRetryAt=${rowA?.nextRetryAt?.toISOString() ?? "null"}`,
      );
    }

    const claimC = await claimKeywordTargetForBlog(blog.id);
    record(
      "third claim skips the requeued row (cool-off not elapsed) and takes the next one",
      Boolean(claimC) && claimC?.id !== claimA?.id && claimC?.id !== claimB?.id,
      claimC ? `claimed "${claimC.keyword}"` : "claim returned undefined",
    );

    if (claimB) {
      await markKeywordTargetGenerated(claimB.id, fixturePost.id);
      const [rowB] = await db
        .select({ status: blogKeywordTargets.status, generatedPostId: blogKeywordTargets.generatedPostId })
        .from(blogKeywordTargets)
        .where(eq(blogKeywordTargets.id, claimB.id));
      record(
        "markKeywordTargetGenerated sets status + post id",
        rowB?.status === "generated" && Boolean(rowB?.generatedPostId),
        `status=${rowB?.status} generatedPostId=${rowB?.generatedPostId}`,
      );
    }

    const claimD = await claimKeywordTargetForBlog(blog.id);
    record(
      "ledger drained — fourth claim returns nothing (A=requeued but cooling off, B=generated, C=generating)",
      claimD === undefined,
      claimD ? `unexpectedly claimed "${claimD.keyword}"` : "undefined, as expected",
    );

    // ── 2b. Cross-sibling reservation ─────────────────────────────────────
    // A second blog on the SAME client, building its ledger from the same
    // client-wide keyword pool — this is exactly the "every sibling ranks
    // the same list and picks the same #1" scenario the reservation fix
    // addresses. At this point on the first blog: claimA's keyword is
    // 'failed' (not reserved — a failed attempt didn't cover the topic),
    // claimB's is 'generated' (reserved), claimC's is 'generating'
    // (reserved).
    console.log("\n2b. Cross-sibling keyword reservation");
    const [siblingBlog] = await db
      .insert(blogs)
      .values({
        clientId: client.id,
        domain: `sibling-${FIXTURE_DOMAIN}`,
        city: `${FIXTURE_CITY} Sibling`,
        status: "setup",
      })
      .returning({ id: blogs.id, domain: blogs.domain });
    console.log(`Fixture sibling blog: ${siblingBlog.id} (${siblingBlog.domain})`);

    const siblingBuild = await buildKeywordTargetsForBlogInternal(siblingBlog.id);
    record(
      "sibling builder upserts the same client-wide keyword pool",
      siblingBuild.targeted && siblingBuild.upserted === FIXTURE_KEYWORDS.length,
      `targeted=${siblingBuild.targeted} upserted=${siblingBuild.upserted}/${FIXTURE_KEYWORDS.length}`,
    );

    const reservedKeywords = new Set([claimB?.keyword, claimC?.keyword].filter(Boolean));
    const siblingClaim1 = await claimKeywordTargetForBlog(siblingBlog.id);
    record(
      "sibling claim avoids a keyword reserved (generating/generated) on another blog",
      Boolean(siblingClaim1) && !reservedKeywords.has(siblingClaim1?.keyword),
      siblingClaim1
        ? `sibling claimed "${siblingClaim1.keyword}" (reserved elsewhere: ${[...reservedKeywords].join(", ")})`
        : "claim returned undefined",
    );
    record(
      "sibling claim picked the one keyword that's free network-wide (the failed one)",
      siblingClaim1?.keyword === claimA?.keyword,
      `expected "${claimA?.keyword}", got "${siblingClaim1?.keyword}"`,
    );

    // Every remaining pending row on the sibling is now reserved elsewhere
    // in the client (the two rows matching claimB/claimC's keywords) — the
    // next claim must not return undefined just because nothing is "free";
    // it should wrap around and reuse the best-priority one anyway.
    const siblingClaim2 = await claimKeywordTargetForBlog(siblingBlog.id);
    record(
      "pool exhausted network-wide — claim wraps around instead of starving the sibling",
      Boolean(siblingClaim2),
      siblingClaim2
        ? `claimed "${siblingClaim2.keyword}" despite it being reserved elsewhere — wrapped around`
        : "unexpectedly undefined",
    );

    // ── 3. Custom-prompt placeholder interpolation ───────────────────────
    console.log("\n3. Placeholder interpolation");
    record(
      "hasPlaceholders is false for a plain prompt (the no-op path)",
      !hasPlaceholders("Write about our products."),
      "confirmed no {token} detected",
    );

    const derivedBrand = deriveBrandName(blog.domain);
    const template =
      "Generate a seo rich topic about {keyword} in {city} for {brand} at {domain}, also {typo}.";
    const interpolated = await interpolatePromptPlaceholders(
      template,
      {
        clientId: client.id,
        domain: blog.domain,
        city: FIXTURE_CITY,
        region: null,
        countryCode: null,
        niche: null,
      },
      claimC ? { keyword: claimC.keyword } : undefined,
      derivedBrand,
    );
    const keywordOk = claimC ? interpolated.includes(claimC.keyword) : true;
    const cityOk = interpolated.includes(FIXTURE_CITY);
    const domainOk = interpolated.includes(blog.domain);
    const typoLiteral = interpolated.includes("{typo}");
    record(
      "{keyword}/{city}/{domain} resolve, unknown {typo} stays literal",
      keywordOk && cityOk && domainOk && typoLiteral,
      `"${interpolated}"`,
    );

    // ── 4. Live generation (opt-in) ──────────────────────────────────────
    console.log("\n4. Live generation");
    if (!LIVE) {
      skip("real model call + meta title/description guarantee", "pass --live to run this (costs real API credit)");
    } else if (!process.env.ANTHROPIC_API_KEY) {
      skip("real model call + meta title/description guarantee", "ANTHROPIC_API_KEY not set — generateContent requires it even when DeepSeek serves the actual call");
    } else if (!claimC) {
      skip("real model call + meta title/description guarantee", "no claimed target available from step 2");
    } else {
      console.log(`  Generating a real article targeting "${claimC.keyword}" in ${FIXTURE_CITY}... (this takes a while and spends real API credit)`);
      try {
        const content = await generateContent({
          topic: claimC.topicTitle,
          keywords: [claimC.keyword],
          wordCount: 1000,
          tone: "professional",
          niche: undefined,
          seoOptimized: true,
          blogSeed: blog.id,
          brandName: FIXTURE_BRAND,
          localTarget: {
            keyword: claimC.keyword,
            city: FIXTURE_CITY,
            brandName: derivedBrand,
          },
        });

        const metaTitleLower = content.metaTitle.toLowerCase();
        const metaDescLower = content.metaDescription.toLowerCase();
        const keywordLower = claimC.keyword.toLowerCase();
        const cityLower = FIXTURE_CITY.toLowerCase();

        record(
          "meta title contains keyword + city",
          metaTitleLower.includes(keywordLower) && metaTitleLower.includes(cityLower),
          `metaTitle="${content.metaTitle}"`,
        );
        record(
          "meta description contains keyword + city",
          metaDescLower.includes(keywordLower) && metaDescLower.includes(cityLower),
          `metaDescription="${content.metaDescription}"`,
        );
        record(
          "meta title and description carry NO 'reddit' token (T01)",
          !/\breddit\b/i.test(content.metaTitle) &&
            !/\breddit\b/i.test(content.metaDescription),
          `metaTitle="${content.metaTitle}" metaDescription="${content.metaDescription}"`,
        );
        record(
          "meta title fits the audit pixel ceiling",
          measureTitlePx(content.metaTitle) <= TITLE_MAX_PX,
          `${measureTitlePx(content.metaTitle).toFixed(0)}px (ceiling ${TITLE_MAX_PX}px)`,
        );
        record(
          "meta description fits the audit pixel ceiling",
          measureDescriptionPx(content.metaDescription) <= DESC_MAX_PX,
          `${measureDescriptionPx(content.metaDescription).toFixed(0)}px (ceiling ${DESC_MAX_PX}px)`,
        );
        console.log(`  Article title: "${content.title}" (${content.wordCount} words, $${content.costUsd.toFixed(4)})`);

        await markKeywordTargetGenerated(claimC.id, fixturePost.id);
      } catch (err) {
        record(
          "real model call completes",
          false,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  } finally {
    // ── Cleanup ─────────────────────────────────────────────────────────
    if (KEEP) {
      console.log(
        `\n--keep passed — fixture left in place. Clean up later with:\n  DELETE FROM clients WHERE id = '${client.id}';  -- cascades blog + keywords + targets`,
      );
    } else {
      await db.delete(clients).where(eq(clients.id, client.id));
      console.log("\nFixture cleaned up (cascade-deleted client -> blog -> keywords -> targets).");
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
  if (failed > 0) {
    console.log("\nFailed checks:");
    for (const r of results.filter((x) => x.status === "FAIL")) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
