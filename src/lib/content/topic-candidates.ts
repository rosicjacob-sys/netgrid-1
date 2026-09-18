// No `import "server-only"` here on purpose — same reasoning as
// src/lib/content/client-keywords.ts: every consumer is a "use server" action
// file or the server-side content generator, and the real `server-only`
// package throws under plain Node, which breaks the standalone tsx scripts in
// src/lib/db/ (e.g. backfill-covered-queries.ts, which imports this module).
//
// This module is the demand grounding for topic ideation. ideateTopic used to
// invent both the subject and the post's keywords with no volume, difficulty
// or SERP data in the prompt at all; it now selects an ANGLE over the ranked,
// already-filtered candidate list this module produces.
import { db } from "@/lib/db";
import { blogs, blogCoveredQueries, clientKeywords } from "@/lib/db/schema";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { normalizeQueryKey } from "@/lib/content/topic-similarity";

/** One demand-validated query a blog could write about. */
export interface TopicCandidate {
  /** The query text, shown to the model verbatim and copied back verbatim. */
  query: string;
  /** Monthly search volume when a volume-bearing source populated it, else null. */
  demand: number | null;
  /** Keyword difficulty 0-100 when known (DataForSEO rows only), else null. */
  difficulty: number | null;
  /** client_keywords.source, e.g. "google_autocomplete" | "dataforseo". */
  source: string;
  /**
   * 0-based position in the client's ranked pool — the only demand proxy we
   * have for volume-less Autocomplete rows.
   */
  rank: number;
}

export interface IdeationCandidateSet {
  /** Candidates this blog has NOT already covered, best first, capped. */
  candidates: TopicCandidate[];
  /** Titles this blog already published, newest first — the similarity corpus. */
  coveredTopics: string[];
  /** Size of the client's ranked pool before covered-query filtering. */
  totalPool: number;
  /** How many distinct queries this blog has already covered. */
  coveredCount: number;
}

/** How deep into the client's ranked pool we look before filtering. */
const POOL_LIMIT = 200;
/** How many candidates the model is shown. 24 rows ≈ 400 prompt tokens. */
const CANDIDATE_LIMIT = 24;
/** How much of the blog's own title history feeds the similarity check. */
const COVERED_TOPIC_LIMIT = 300;

/**
 * The client's ranked query pool.
 *
 * ── THIS IS THE T09 SEAM ──────────────────────────────────────────────────
 * T09 (demand-validated keyword ranking) replaces THIS FUNCTION BODY and
 * nothing else. The contract it must honour:
 *   - return at most `limit` rows, BEST FIRST
 *   - `demand` is monthly search volume or null when genuinely unknown
 *   - `difficulty` is 0-100 or null
 *   - `rank` is the 0-based index in the returned order
 * Until then this reproduces the ordering every existing consumer already
 * uses — see activeClientKeywordRows in src/lib/content/client-keywords.ts —
 * and additionally surfaces the keyword_difficulty column that
 * topActiveClientKeywords throws away.
 */
export async function rankedQueriesForClient(
  clientId: string,
  limit = POOL_LIMIT,
): Promise<TopicCandidate[]> {
  const rows = await db
    .select({
      keyword: clientKeywords.keyword,
      searchVolume: clientKeywords.searchVolume,
      keywordDifficulty: clientKeywords.keywordDifficulty,
      source: clientKeywords.source,
    })
    .from(clientKeywords)
    .where(
      and(
        eq(clientKeywords.clientId, clientId),
        eq(clientKeywords.isActive, true),
      ),
    )
    .orderBy(
      sql`${clientKeywords.searchVolume} desc nulls last`,
      desc(clientKeywords.hitCount),
      asc(clientKeywords.bestPosition),
    )
    .limit(limit);

  return rows.map((r, i) => ({
    query: r.keyword,
    demand: r.searchVolume,
    difficulty: r.keywordDifficulty,
    source: r.source,
    rank: i,
  }));
}

/**
 * Everything ideation needs to pick a subject for one blog: the queries it has
 * NOT covered yet (best first), plus every title it HAS published.
 *
 * Ordering rule: queries no sibling blog of the same client has covered come
 * first, then sibling-covered ones. Siblings share one client-wide keyword
 * pool, so without this every sibling converges on the same #1 query — the
 * same problem claimKeywordTargetForBlog solves for the local-keyword ledger.
 * Sibling coverage DEPRIORITISES, it never removes: a client with more blogs
 * than queries must still publish.
 *
 * NEVER THROWS. On any DB failure it returns an empty set, which ideateTopic
 * reads as "this client has no pool" and handles per
 * IDEATION_REQUIRE_CANDIDATES — a database hiccup must not stop the network
 * from publishing.
 */
export async function getIdeationCandidatesForBlog(
  blogId: string,
  limit = CANDIDATE_LIMIT,
): Promise<IdeationCandidateSet> {
  const empty: IdeationCandidateSet = {
    candidates: [],
    coveredTopics: [],
    totalPool: 0,
    coveredCount: 0,
  };

  try {
    const [blog] = await db
      .select({ clientId: blogs.clientId })
      .from(blogs)
      .where(eq(blogs.id, blogId))
      .limit(1);
    if (!blog) return empty;

    const [pool, ownCovered, siblingCovered] = await Promise.all([
      rankedQueriesForClient(blog.clientId),
      db
        .select({
          queryNorm: blogCoveredQueries.queryNorm,
          topic: blogCoveredQueries.topic,
        })
        .from(blogCoveredQueries)
        .where(eq(blogCoveredQueries.blogId, blogId))
        .orderBy(desc(blogCoveredQueries.coveredAt))
        .limit(COVERED_TOPIC_LIMIT),
      db
        .selectDistinct({ queryNorm: blogCoveredQueries.queryNorm })
        .from(blogCoveredQueries)
        .where(
          and(
            eq(blogCoveredQueries.clientId, blog.clientId),
            ne(blogCoveredQueries.blogId, blogId),
          ),
        ),
    ]);

    const ownKeys = new Set(ownCovered.map((r) => r.queryNorm));
    const siblingKeys = new Set(siblingCovered.map((r) => r.queryNorm));

    const fresh: TopicCandidate[] = [];
    const siblingUsed: TopicCandidate[] = [];
    for (const c of pool) {
      const key = normalizeQueryKey(c.query);
      if (!key || ownKeys.has(key)) continue;
      if (siblingKeys.has(key)) siblingUsed.push(c);
      else fresh.push(c);
    }

    return {
      candidates: [...fresh, ...siblingUsed].slice(0, limit),
      coveredTopics: ownCovered.map((r) => r.topic).filter(Boolean),
      totalPool: pool.length,
      coveredCount: ownKeys.size,
    };
  } catch (err) {
    console.warn(
      `[topic-candidates] candidate lookup failed for blog ${blogId}:`,
      err instanceof Error ? err.message : err,
    );
    return empty;
  }
}

/**
 * Record that a blog has now covered a query. Idempotent on
 * (blog_id, query_norm).
 *
 * NEVER THROWS — bookkeeping must not fail a post that already went live. A
 * lost row costs one possible future duplicate, which the similarity check
 * still catches; a thrown error would fail an already-published post.
 */
export async function recordCoveredQuery(input: {
  blogId: string;
  clientId: string;
  query: string;
  topic: string;
  generatedPostId?: string;
  source?: "ideation" | "ledger" | "backfill";
}): Promise<void> {
  const query = input.query.trim();
  const topic = input.topic.trim();
  if (!query || !topic) return;
  const queryNorm = normalizeQueryKey(query);
  if (!queryNorm) return;

  try {
    await db
      .insert(blogCoveredQueries)
      .values({
        blogId: input.blogId,
        clientId: input.clientId,
        query: query.slice(0, 255),
        queryNorm: queryNorm.slice(0, 255),
        topic: topic.slice(0, 500),
        generatedPostId: input.generatedPostId ?? null,
        source: input.source ?? "ideation",
      })
      .onConflictDoNothing({
        target: [blogCoveredQueries.blogId, blogCoveredQueries.queryNorm],
      });
  } catch (err) {
    console.warn(
      `[topic-candidates] failed to record covered query "${queryNorm}" for blog ${input.blogId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Has this blog already covered this query? Used by the local-keyword ledger
 * path, which claims a pre-templated title and previously bypassed every
 * duplicate check. Fail-safe to false — an unavailable lookup must not block a
 * legitimate post.
 */
export async function isQueryCoveredByBlog(
  blogId: string,
  query: string,
): Promise<boolean> {
  const key = normalizeQueryKey(query);
  if (!key) return false;
  try {
    const [hit] = await db
      .select({ id: blogCoveredQueries.id })
      .from(blogCoveredQueries)
      .where(
        and(
          eq(blogCoveredQueries.blogId, blogId),
          eq(blogCoveredQueries.queryNorm, key),
        ),
      )
      .limit(1);
    return Boolean(hit);
  } catch {
    return false;
  }
}
