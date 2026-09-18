/**
 * One-shot backfill of blog_covered_queries from existing history.
 *
 * T11 replaced ideation's 24-title dedup window with a permanent per-blog
 * covered-query table. Without this, every live blog starts with an empty
 * history and re-covers subjects it already published.
 *
 * Sources, in priority order (first writer wins per (blog, query_norm)):
 *   1. blog_keyword_targets rows with status='generated' — the keyword is the
 *      covered query and topic_title is the covered title. Exact.
 *   2. generated_posts with status='published' — no query was recorded before
 *      T11, so keywords[0] (ideation's own primary keyword) is the proxy.
 *      Written with source='backfill' so it is distinguishable.
 *
 * Idempotent: every insert is ON CONFLICT DO NOTHING against the
 * (blog_id, query_norm) unique index. Re-running is safe and cheap.
 *
 * Usage (from project root, DATABASE_URL required):
 *   npm run db:backfill-covered-queries
 *   npm run db:backfill-covered-queries -- --dry-run
 */
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { db } from "./index";
import { blogCoveredQueries, blogKeywordTargets, generatedPosts } from "./schema";
import { normalizeQueryKey } from "../content/topic-similarity";

const DRY_RUN = process.argv.includes("--dry-run");

interface Pending {
  blogId: string;
  clientId: string;
  query: string;
  queryNorm: string;
  topic: string;
  generatedPostId: string | null;
  source: "ledger" | "backfill";
  coveredAt: Date;
}

/** First non-empty string in a generated_posts.keywords jsonb value. */
function firstKeyword(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  for (const k of raw) {
    const s = String(k ?? "").trim();
    if (s) return s;
  }
  return null;
}

async function main(): Promise<void> {
  const pending: Pending[] = [];
  const seen = new Set<string>();
  const push = (p: Pending) => {
    const dedupeKey = `${p.blogId}::${p.queryNorm}`;
    if (!p.queryNorm || !p.topic || seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    pending.push(p);
  };

  // ── 1. Ledger rows that actually shipped ────────────────────────────────
  const ledger = await db
    .select({
      blogId: blogKeywordTargets.blogId,
      clientId: blogKeywordTargets.clientId,
      keyword: blogKeywordTargets.keyword,
      topicTitle: blogKeywordTargets.topicTitle,
      generatedPostId: blogKeywordTargets.generatedPostId,
      generatedAt: blogKeywordTargets.generatedAt,
      createdAt: blogKeywordTargets.createdAt,
    })
    .from(blogKeywordTargets)
    .where(eq(blogKeywordTargets.status, "generated"))
    .orderBy(asc(blogKeywordTargets.createdAt));

  for (const r of ledger) {
    push({
      blogId: r.blogId,
      clientId: r.clientId,
      query: r.keyword.slice(0, 255),
      queryNorm: normalizeQueryKey(r.keyword).slice(0, 255),
      topic: r.topicTitle.slice(0, 500),
      generatedPostId: r.generatedPostId,
      source: "ledger",
      coveredAt: r.generatedAt ?? r.createdAt,
    });
  }
  console.log(`[backfill] ledger rows considered: ${ledger.length}`);

  // ── 2. Published posts ──────────────────────────────────────────────────
  const posts = await db
    .select({
      id: generatedPosts.id,
      blogId: generatedPosts.blogId,
      clientId: generatedPosts.clientId,
      topic: generatedPosts.topic,
      title: generatedPosts.title,
      keywords: generatedPosts.keywords,
      publishedAt: generatedPosts.publishedAt,
      createdAt: generatedPosts.createdAt,
    })
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.status, "published"),
        isNotNull(generatedPosts.topic),
      ),
    )
    .orderBy(asc(generatedPosts.createdAt));

  let noKeyword = 0;
  for (const p of posts) {
    const kw = firstKeyword(p.keywords);
    if (!kw) {
      noKeyword++;
      continue;
    }
    push({
      blogId: p.blogId,
      clientId: p.clientId,
      query: kw.slice(0, 255),
      queryNorm: normalizeQueryKey(kw).slice(0, 255),
      topic: (p.title || p.topic).slice(0, 500),
      generatedPostId: p.id,
      source: "backfill",
      coveredAt: p.publishedAt ?? p.createdAt,
    });
  }
  console.log(
    `[backfill] published posts considered: ${posts.length} (${noKeyword} had no usable keyword)`,
  );
  console.log(`[backfill] distinct (blog, query) rows to write: ${pending.length}`);

  if (DRY_RUN) {
    for (const p of pending.slice(0, 20)) {
      console.log(`  ${p.blogId}  ${p.source.padEnd(8)}  ${p.queryNorm}`);
    }
    console.log("[backfill] --dry-run: nothing written.");
    return;
  }

  // neon-http has no interactive transactions; chunk the inserts instead.
  const CHUNK = 200;
  let written = 0;
  for (let i = 0; i < pending.length; i += CHUNK) {
    const slice = pending.slice(i, i + CHUNK);
    const inserted = await db
      .insert(blogCoveredQueries)
      .values(slice)
      .onConflictDoNothing({
        target: [blogCoveredQueries.blogId, blogCoveredQueries.queryNorm],
      })
      .returning({ id: blogCoveredQueries.id });
    written += inserted.length;
    console.log(`[backfill] ${i + slice.length}/${pending.length} processed, ${written} inserted`);
  }

  console.log(`[backfill] done — ${written} coverage row(s) inserted.`);
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
