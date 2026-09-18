// Semantic (cosine-similarity) linking engine.
//
// Embeds each published post's title + body into a pgvector column, then finds
// the most contextually-similar OTHER posts on the SAME blog and links them
// together — an internal-linking SEO win that keyword matching misses.
//
// Links are applied two ways (per product decision):
//   1. A "Related posts" block injected into the live post body (works on any
//      WordPress or Shopify theme, no theme edits needed).
//   2. A custom.netgrid_related_posts JSON metafield on Shopify (for themes /
//      tooling that want the structured list).
//
// Everything here is best-effort: callers (publish hook, cron, webhook) invoke
// it fire-and-forget and it never throws into their path.

import { db } from "@/lib/db";
import { blogs, generatedPosts } from "@/lib/db/schema";
import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import * as platform from "@/lib/services/platform-client";
import type { PlatformBlog } from "@/lib/services/platform-client";
import {
  embeddingsConfigured,
  getEmbeddingProvider,
} from "@/lib/services/embeddings-client";
import { toCanonicalUrl } from "@/lib/services/canonical-url";

// ─── Config (env-overridable) ────────────────────────────────────────────────

// Hybrid score = alpha * sparse(full-text) + (1 - alpha) * dense(cosine).
// A candidate must exceed `threshold` on that blended 0-1 score to be linked.
// Note the threshold lives on the *hybrid* scale (default 0.55), which is a
// different distribution from a pure-cosine cutoff.

/** Minimum blended hybrid score a candidate must exceed to be linked. */
function threshold(): number {
  const v = Number(process.env.SEMANTIC_LINK_THRESHOLD);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.55;
}

/** Weight on the sparse (full-text) signal; dense gets (1 - alpha). */
function alpha(): number {
  const v = Number(process.env.SEMANTIC_LINK_ALPHA);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.3;
}

/** Max related posts to link per article. */
function maxLinks(): number {
  const v = Number(process.env.SEMANTIC_LINK_MAX);
  return Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), 10) : 5;
}

/**
 * Postgres text-search configuration for a post's language.
 *
 * The sparse half of the hybrid score is a tsvector/tsquery pair, and BOTH
 * halves must be built with the same dictionary or stemming silently fails to
 * match: under 'english', "traitements" and "traitement" are two unrelated
 * lexemes and "les"/"des"/"pour" are indexed as content words instead of
 * stopwords, so a French post's sparse score keys on French function words
 * that appear in every French article on the blog.
 *
 * generated_posts.language is "en" | "fr" | NULL. NULL is legacy data written
 * before that column existed — it falls back to English, which is what those
 * rows were indexed with anyway.
 */
const TS_CONFIG_BY_LANGUAGE: Record<string, string> = {
  en: "english",
  fr: "french",
};

export function tsConfigForLanguage(
  language: string | null | undefined,
): string {
  return (
    TS_CONFIG_BY_LANGUAGE[(language ?? "").trim().toLowerCase()] ?? "english"
  );
}

/**
 * Share of a backfill run's budget reserved for RE-linking already-linked
 * posts whose neighbourhood has changed. The rest goes to never-linked posts.
 */
function refreshShare(): number {
  const v = Number(process.env.SEMANTIC_LINK_REFRESH_SHARE);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.6;
}

/** Max posts taken from any ONE blog per refresh lane, so a 900-post blog
 *  can't monopolise a batch and starve the other 1,499 sites. */
function refreshPerBlogCap(): number {
  const v = Number(process.env.SEMANTIC_LINK_REFRESH_PER_BLOG);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 3;
}

/** Delay between posts in the backfill link loop, to be gentle on platform APIs. */
const LINK_THROTTLE_MS = (() => {
  const v = Number(process.env.SEMANTIC_LINK_THROTTLE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 150;
})();

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

const BLOCK_START = "<!-- netgrid-related-start -->";
const BLOCK_END = "<!-- netgrid-related-end -->";

export interface RelatedPost {
  id: string;
  title: string;
  url: string;
  similarity?: number;
}

// ─── Text sanitization ───────────────────────────────────────────────────────

/**
 * Strip HTML to plain text suitable for the embedding model. Removes script/
 * style, tags, and decodes the handful of entities our content actually emits.
 * Title is prepended so short posts still embed with topical signal.
 */
export function sanitizeForEmbedding(
  title: string | null,
  html: string | null,
): string {
  const text = (html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return [title?.trim(), text].filter(Boolean).join(". ");
}

/**
 * Stringify an error including any axios HTTP response body — the raw
 * "Request failed with status code 400" message hides Shopify's actual reason
 * (invalid_client, bad API key, "exceeded ... rate limit", etc.), which is what
 * we need to tell a config problem from throttling.
 */
function errDetail(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const resp = (err as { response?: { status?: number; data?: unknown } })
    ?.response;
  if (resp?.data != null) {
    const body =
      typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
    return `${base} — ${body.slice(0, 300)}`;
  }
  return base;
}

// ─── HTML helpers ────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRelatedBlock(related: RelatedPost[]): string {
  const items = related
    .map(
      (r) =>
        `<li><a href="${escapeHtml(r.url)}">${escapeHtml(r.title)}</a></li>`,
    )
    .join("");
  return (
    `${BLOCK_START}\n` +
    `<div class="netgrid-related-posts" data-netgrid="related-posts">\n` +
    `<h3>Related posts</h3>\n<ul>${items}</ul>\n</div>\n` +
    `${BLOCK_END}`
  );
}

/** Remove any previously-injected related block so re-links replace, not stack. */
function stripRelatedBlock(html: string): string {
  const re = new RegExp(
    `\\s*${escapeRegex(BLOCK_START)}[\\s\\S]*?${escapeRegex(BLOCK_END)}\\s*`,
    "g",
  );
  return html.replace(re, "").replace(/\s+$/, "");
}

// ─── Embedding ───────────────────────────────────────────────────────────────

export interface EmbedResult {
  ok: boolean;
  reason?: string;
}

/**
 * Embed a single generated post (by id) and store the vector. No-op-with-reason
 * if embeddings aren't configured or the post has no body yet.
 *
 * `override` lets callers (e.g. the Shopify webhook) embed from freshly-edited
 * live content instead of the stored body.
 */
export async function embedPost(
  postId: string,
  override?: { title?: string | null; body?: string | null },
): Promise<EmbedResult> {
  if (!embeddingsConfigured()) {
    return { ok: false, reason: "OPENAI_API_KEY not configured" };
  }
  const [post] = await db
    .select({
      id: generatedPosts.id,
      title: generatedPosts.title,
      body: generatedPosts.body,
      language: generatedPosts.language,
    })
    .from(generatedPosts)
    .where(eq(generatedPosts.id, postId))
    .limit(1);

  if (!post) return { ok: false, reason: "Post not found" };

  const title = override?.title !== undefined ? override.title : post.title;
  // A live edit may include our injected related block — strip it so it
  // doesn't pollute the topical embedding.
  const rawBody =
    override?.body !== undefined ? override.body : post.body;
  const body = rawBody ? stripRelatedBlock(rawBody) : rawBody;
  if (!body) return { ok: false, reason: "Post has no body to embed" };

  const text = sanitizeForEmbedding(title, body);
  if (!text) return { ok: false, reason: "Nothing to embed after sanitize" };

  try {
    const provider = getEmbeddingProvider();
    const [vector] = await provider.embed([text]);
    await db
      .update(generatedPosts)
      .set({
        embedding: vector,
        embeddingModel: provider.model,
        embeddedAt: new Date(),
        // Sparse half of the hybrid score: full-text vector over the same
        // sanitized text, in the post's OWN language. Set here so dense +
        // sparse always stay in sync, and so a re-embed also repairs a tsvector
        // that was built with the wrong dictionary.
        //
        // The ::regconfig cast is required: to_tsvector(regconfig, text) and
        // to_tsvector(text) are different overloads, and a bound parameter
        // arrives with unknown type, so Postgres would resolve the
        // single-argument form and treat the config NAME as the document. The
        // config name is still a bound value, never concatenated.
        searchTsv: sql`to_tsvector(${tsConfigForLanguage(post.language)}::regconfig, ${text})`,
        updatedAt: new Date(),
      })
      .where(eq(generatedPosts.id, postId));
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Embedding failed",
    };
  }
}

// ─── Hybrid similarity search (dense cosine + sparse full-text) ───────────────

/**
 * Build the full-text query string for the sparse signal from the target
 * post's title + keywords (kept tight so ranking keys on real topic terms, not
 * every word in a long body).
 */
function buildQueryText(title: string | null, keywords: unknown): string {
  const kw = Array.isArray(keywords)
    ? keywords.filter((k): k is string => typeof k === "string" && k.trim() !== "")
    : [];
  return [title ?? "", ...kw].join(" ").trim();
}

/**
 * Find posts on the SAME blog most related to the given post using a HYBRID
 * score: dense cosine similarity (pgvector) blended with the normalized sparse
 * full-text rank (Postgres FTS, our TF-IDF equivalent).
 *
 *   score = alpha * sparseNorm + (1 - alpha) * dense
 *
 * Scoped to published posts with a live URL and an embedding, excluding the
 * post itself. Candidates' raw dense + sparse scores are computed in SQL (no
 * vectors shipped to JS); sparse is min-maxed and blended in JS, then filtered
 * by the hybrid threshold and truncated to maxLinks.
 */
export async function findRelated(postId: string): Promise<RelatedPost[]> {
  // Join blogs for the canonical (customer-facing) domain: external_post_url
  // is the PLATFORM url, which on Shopify is xyz.myshopify.com — never the
  // host we want to link to.
  const [post] = await db
    .select({
      blogId: generatedPosts.blogId,
      title: generatedPosts.title,
      keywords: generatedPosts.keywords,
      language: generatedPosts.language,
      canonicalDomain: blogs.domain,
    })
    .from(generatedPosts)
    .innerJoin(blogs, eq(generatedPosts.blogId, blogs.id))
    .where(eq(generatedPosts.id, postId))
    .limit(1);
  if (!post) return [];

  const targetEmbedding = sql`(select ${generatedPosts.embedding} from ${generatedPosts} where ${generatedPosts.id} = ${postId})`;
  const queryText = buildQueryText(post.title, post.keywords);
  const tsConfig = tsConfigForLanguage(post.language);
  const tsQuery = sql`websearch_to_tsquery(${tsConfig}::regconfig, ${queryText})`;

  // Dense (0-1 cosine similarity) and raw sparse (ts_rank) per candidate.
  const dense = sql<number>`1 - (${generatedPosts.embedding} <=> ${targetEmbedding})`;
  const sparse = sql<number>`coalesce(ts_rank(${generatedPosts.searchTsv}, ${tsQuery}), 0)`;

  const rows = await db
    .select({
      id: generatedPosts.id,
      title: generatedPosts.title,
      url: generatedPosts.externalPostUrl,
      dense,
      sparse,
    })
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.blogId, post.blogId),
        ne(generatedPosts.id, postId),
        eq(generatedPosts.status, "published"),
        isNotNull(generatedPosts.embedding),
        isNotNull(generatedPosts.externalPostUrl),
        // Same-language siblings only. Bilingual clients alternate EN/FR on
        // one blog, and a cross-language "related post" is bad UX and an
        // unjustified crawl signal with no hreflang to back it. NULL-language
        // rows are legacy data and stay eligible so old blogs keep a pool.
        post.language
          ? or(
              isNull(generatedPosts.language),
              eq(generatedPosts.language, post.language),
            )
          : undefined,
      ),
    );

  // Normalize sparse to 0-1 across the candidate set (dense is already 0-1),
  // then blend. Done in JS so the normalization base is the actual candidates.
  const maxSparse = rows.reduce((m, r) => Math.max(m, Number(r.sparse) || 0), 0);
  const a = alpha();
  const th = threshold();

  return rows
    .map((r) => {
      const d = Number(r.dense) || 0;
      const s = maxSparse > 0 ? (Number(r.sparse) || 0) / maxSparse : 0;
      return {
        id: r.id,
        title: r.title,
        url: r.url,
        score: a * s + (1 - a) * d,
      };
    })
    .filter((r) => r.title && r.url && r.score > th)
    .sort((x, y) => y.score - x.score)
    .slice(0, maxLinks())
    .map((r) => ({
      id: r.id,
      title: r.title as string,
      url: toCanonicalUrl(r.url as string, post.canonicalDomain),
      similarity: r.score,
    }));
}

export interface TopicalLinkRef {
  title: string;
  url: string;
  /** Blended hybrid score, for logging/debugging. Not used by the prompt. */
  score?: number;
}

/**
 * Rank a blog's published posts by topical relevance to a DRAFT article that
 * does not exist yet (no row, no body, no embedding). Used by the generator to
 * choose which siblings Claude may weave in as inline anchors.
 *
 * Same hybrid formula as findRelated — alpha * sparseNorm + (1 - alpha) * dense
 * — so the inline-anchor lane and the Related-posts lane agree on what
 * "related" means. Differences from findRelated, all deliberate:
 *
 *   - The dense vector comes from embedding the draft's topic + keywords
 *     rather than a stored row.
 *   - Candidates without an embedding are NOT excluded; they simply score 0 on
 *     the dense half and can still win on the sparse half. A blog mid-backfill
 *     must not lose its inline links.
 *   - No threshold. This is a best-of-N pick, and the prompt already tells
 *     Claude to use only the ones that genuinely relate. A threshold here would
 *     silently return zero refs on a young blog and regress inline linking to
 *     nothing.
 *   - `recentSlots` of the returned slots are reserved for the most recently
 *     published posts, so brand-new pages keep accruing inbound internal links
 *     (the one property the old recency-only implementation had).
 *
 * Never throws: any failure returns whatever it has, and the caller has its own
 * fallback. All URLs are canonicalised.
 */
export async function findTopicalLinkRefs(opts: {
  blogId: string;
  canonicalDomain: string;
  topic: string;
  keywords?: string[];
  language?: string | null;
  /** Total refs to return. Default 8 — matches the generator's prompt cap. */
  limit?: number;
  /** How many of `limit` are reserved for the newest posts. Default 2. */
  recentSlots?: number;
  /** Exclude a post from its own candidate list (the regenerate path). */
  excludePostId?: string;
}): Promise<TopicalLinkRef[]> {
  const limit = Math.max(1, opts.limit ?? 8);
  const recentSlots = Math.min(Math.max(0, opts.recentSlots ?? 2), limit);
  const queryText = buildQueryText(opts.topic, opts.keywords ?? []);
  const tsConfig = tsConfigForLanguage(opts.language);

  // Dense half: embed the draft's topic + keywords. One embedding call against
  // a 25-35s publish. Degrade to lexical-only on failure.
  let vectorLiteral: string | null = null;
  if (embeddingsConfigured() && queryText) {
    try {
      const provider = getEmbeddingProvider();
      const [vector] = await provider.embed([queryText]);
      if (Array.isArray(vector) && vector.length > 0) {
        vectorLiteral = `[${vector.join(",")}]`;
      }
    } catch (err) {
      console.warn(
        `[semantic-linking] draft embed failed for blog ${opts.blogId}: ` +
          `${err instanceof Error ? err.message : "unknown"} — ranking lexically`,
      );
    }
  }

  // The ::vector cast is mandatory: pgvector's <=> is only defined for
  // vector <=> vector, and without it the bound parameter is unknown/text, so
  // Postgres raises "operator does not exist: vector <=> text" at runtime —
  // which the caller's try/catch would swallow into a permanent silent
  // fallback to lexical ranking.
  const dense = vectorLiteral
    ? sql<number>`coalesce(1 - (${generatedPosts.embedding} <=> ${vectorLiteral}::vector), 0)`
    : sql<number>`0`;
  const sparse = queryText
    ? sql<number>`coalesce(ts_rank(${generatedPosts.searchTsv}, websearch_to_tsquery(${tsConfig}::regconfig, ${queryText})), 0)`
    : sql<number>`0`;

  const rows = await db
    .select({
      title: generatedPosts.title,
      url: generatedPosts.externalPostUrl,
      publishedAt: generatedPosts.publishedAt,
      dense,
      sparse,
    })
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.blogId, opts.blogId),
        eq(generatedPosts.status, "published"),
        isNotNull(generatedPosts.externalPostUrl),
        isNotNull(generatedPosts.title),
        opts.excludePostId ? ne(generatedPosts.id, opts.excludePostId) : undefined,
        opts.language
          ? or(
              isNull(generatedPosts.language),
              eq(generatedPosts.language, opts.language),
            )
          : undefined,
      ),
    );

  const maxSparse = rows.reduce((m, r) => Math.max(m, Number(r.sparse) || 0), 0);
  const a = alpha();

  const scored = rows.flatMap((r) => {
    const title = r.title;
    const url = r.url;
    if (!title || !url) return [];
    const s = maxSparse > 0 ? (Number(r.sparse) || 0) / maxSparse : 0;
    return [
      {
        title,
        url: toCanonicalUrl(url, opts.canonicalDomain),
        publishedAt: r.publishedAt ? new Date(r.publishedAt).getTime() : 0,
        score: a * s + (1 - a) * (Number(r.dense) || 0),
      },
    ];
  });

  if (scored.length === 0) return [];

  // Topical slots first, then the reserved recency slots, then top up with the
  // next-best topical matches if recency produced duplicates. Keyed by
  // canonical URL so the same post can't occupy two slots.
  const byScore = [...scored].sort((x, y) => y.score - x.score);
  const chosen = new Map<string, (typeof scored)[number]>();
  for (const r of byScore.slice(0, Math.max(0, limit - recentSlots))) {
    chosen.set(r.url, r);
  }
  const byRecency = [...scored].sort((x, y) => y.publishedAt - x.publishedAt);
  for (const r of byRecency) {
    if (chosen.size >= limit) break;
    if (!chosen.has(r.url)) chosen.set(r.url, r);
  }
  for (const r of byScore) {
    if (chosen.size >= limit) break;
    if (!chosen.has(r.url)) chosen.set(r.url, r);
  }

  return Array.from(chosen.values())
    .sort((x, y) => y.score - x.score)
    .map(({ title, url, score }) => ({ title, url, score }));
}

// ─── Applying links to the live post ─────────────────────────────────────────

export interface ApplyResult {
  ok: boolean;
  count: number;
  changed: boolean;
  reason?: string;
  related?: RelatedPost[];
  /**
   * Set when the Shopify theme block couldn't be installed (e.g. missing
   * write_themes scope). Linking still "succeeds" — the metafield is written —
   * but nothing renders until the theme is fixed, so this is surfaced upward.
   */
  themeWarning?: string;
}

/**
 * Compute related posts for a published article and surface them as an internal
 * "Related posts" block.
 *
 *   - Shopify: write the related list to the custom.netgrid_related_posts
 *     metafield and ensure the theme renders it (a snippet in the article
 *     template). No post-body edit — cheaper and far more reliable than
 *     re-pushing bodies.
 *   - WordPress: inject an idempotent "Related posts" block into the post body
 *     (theme-file editing isn't available over the WP API).
 */
export async function applyRelatedLinks(postId: string): Promise<ApplyResult> {
  const [post] = await db
    .select({
      id: generatedPosts.id,
      blogId: generatedPosts.blogId,
      status: generatedPosts.status,
      externalPostId: generatedPosts.externalPostId,
    })
    .from(generatedPosts)
    .where(eq(generatedPosts.id, postId))
    .limit(1);

  if (!post) return { ok: false, count: 0, changed: false, reason: "Not found" };
  if (post.status !== "published" || !post.externalPostId) {
    return { ok: false, count: 0, changed: false, reason: "Post is not live" };
  }

  const related = await findRelated(postId);

  const [blog] = await db
    .select()
    .from(blogs)
    .where(eq(blogs.id, post.blogId))
    .limit(1);
  if (!blog) return { ok: false, count: 0, changed: false, reason: "Blog not found" };

  const relatedJson = JSON.stringify(
    related.map(({ id, title, url }) => ({ id, title, url })),
  );

  const stampLinked = () =>
    db
      .update(generatedPosts)
      .set({
        relatedPosts: related.map(({ id, title, url }) => ({ id, title, url })),
        relatedLinkedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(generatedPosts.id, postId));

  // ── Shopify: metafield + theme block (no body edit) ──
  if ((blog as PlatformBlog).platform === "shopify") {
    const res = await platform.writeShopifyRelatedMetafield(
      blog as PlatformBlog,
      post.externalPostId,
      relatedJson,
    );
    if (!res.ok) {
      return { ok: false, count: related.length, changed: false, reason: res.message };
    }
    // Ensure the article-template snippet is installed (cached per store).
    // Failure here doesn't fail the link — the metafield is written — but we
    // surface it so a store missing write_themes is visible.
    let themeWarning: string | undefined;
    const theme = await platform
      .ensureShopifyRelatedBlock(blog as PlatformBlog)
      .catch((err) => ({
        ok: false,
        message: err instanceof Error ? err.message : "theme install failed",
      }));
    if (!theme.ok) {
      themeWarning = `${(blog as { domain?: string }).domain ?? "shopify"}: ${theme.message ?? "theme install failed"}`;
    }
    await stampLinked();
    return { ok: true, count: related.length, changed: true, related, themeWarning };
  }

  // ── WordPress: idempotent in-body block ──
  const { body: liveBody, error: fetchError } =
    await platform.fetchLivePostBodyResult(blog as PlatformBlog, post.externalPostId);
  if (liveBody === null) {
    return {
      ok: false,
      count: 0,
      changed: false,
      reason: fetchError
        ? `Could not fetch live body: ${fetchError}`
        : "Could not fetch live body",
    };
  }

  const stripped = stripRelatedBlock(liveBody);
  const newBody =
    related.length > 0 ? `${stripped}\n${buildRelatedBlock(related)}` : stripped;

  if (newBody === liveBody) {
    await stampLinked();
    return { ok: true, count: related.length, changed: false, related };
  }

  const res = await platform.updateLivePostBody(
    blog as PlatformBlog,
    post.externalPostId,
    newBody,
  );
  if (!res.ok) {
    return { ok: false, count: related.length, changed: false, reason: res.message, related };
  }

  await stampLinked();
  return { ok: true, count: related.length, changed: true, related };
}

/**
 * Embed a post then (re)link it. Returns the related posts it linked so callers
 * can cascade a one-level relink of neighbours (keeping links bidirectional
 * when a new post joins a blog). Never throws.
 */
export async function relinkGeneratedPost(
  postId: string,
): Promise<{ ok: boolean; related: RelatedPost[]; reason?: string }> {
  try {
    const embedded = await embedPost(postId);
    if (!embedded.ok) return { ok: false, related: [], reason: embedded.reason };
    const applied = await applyRelatedLinks(postId);
    return { ok: applied.ok, related: applied.related ?? [], reason: applied.reason };
  } catch (err) {
    return {
      ok: false,
      related: [],
      reason: err instanceof Error ? err.message : "Relink failed",
    };
  }
}

/**
 * Fire-and-forget relink triggered after a post is published. Relinks the new
 * post AND its top related neighbours one level deep, so the new post appears
 * in their "Related posts" lists too. Bounded by maxLinks; safe to ignore.
 *
 * Called from EVERY publish path: the auto-publish cron, the manual publish
 * and the in-place regenerate. Set SEMANTIC_LINK_ON_PUBLISH=0 to disable all
 * three without a deploy.
 */
export function relinkAfterPublishFireAndForget(postId: string): void {
  // One switch for "stop writing to live posts on publish", covering the
  // auto-publish cron, the manual publish and the in-place regenerate. The
  // backfill cron then remains the only writer.
  if (process.env.SEMANTIC_LINK_ON_PUBLISH === "0") return;
  void (async () => {
    try {
      const { ok, related } = await relinkGeneratedPost(postId);
      if (!ok) return;
      for (const neighbour of related) {
        // Neighbour already has an embedding; just refresh its links so the
        // new post shows up. Best-effort, serial to avoid API bursts.
        await applyRelatedLinks(neighbour.id).catch(() => undefined);
      }
    } catch {
      // Swallow — linking must never affect the publish path.
    }
  })();
}

// ─── Backfill (cron) ─────────────────────────────────────────────────────────

export interface BackfillError {
  stage: "embed" | "link";
  id: string;
  reason: string;
}

export interface BackfillResult {
  embedded: number;
  embedFailed: number;
  /** Already-embedded posts whose sparse full-text vector was backfilled. */
  tsvBackfilled: number;
  /** Posts linked for the FIRST time this run (relatedLinkedAt was null). */
  linked: number;
  /** Already-linked posts RE-linked this run, so they pick up newer siblings. */
  relinked: number;
  linkFailed: number;
  /** First few failure reasons (capped), so the cron response is diagnosable. */
  errors?: BackfillError[];
  /**
   * Shopify stores whose theme block couldn't be installed (one per store),
   * e.g. "store.example.com: Token lacks the write_themes scope…". Linking to
   * these stores still writes the metafield; the block just won't render until
   * the theme is fixed.
   */
  themeErrors?: string[];
  skipped?: string;
}

// How many failure reasons to surface in the response before truncating.
const MAX_REPORTED_ERRORS = 10;

/**
 * Pick the refresh lane's batch: already-linked posts whose neighbourhood has
 * changed since they were last linked.
 *
 * "Stale" = the post's blog has published something (embedded, live) AFTER
 * this post's related_linked_at. That is exactly the set whose Related-posts
 * block is out of date.
 *
 * Fairness: row_number() partitions by blog so at most refreshPerBlogCap()
 * posts come from any one blog per run. Without it, a single 900-post blog
 * with a fresh publish would fill every slot for hours.
 *
 * `requireStale: false` drops the staleness predicate — that is the one-off
 * "?refresh=1" full rescore after tuning alpha/threshold.
 *
 * Raw SQL because the per-blog fairness cap needs a window function.
 */
async function selectRefreshBatch(opts: {
  limit: number;
  blogId?: string;
  requireStale: boolean;
}): Promise<string[]> {
  if (opts.limit <= 0) return [];
  const blogIdParam = opts.blogId ?? null;

  const staleFilter = opts.requireStale
    ? sql`AND EXISTS (
            SELECT 1
            FROM "generated_posts" newer
            WHERE newer."blog_id" = gp."blog_id"
              AND newer."id" <> gp."id"
              AND newer."status" = 'published'
              AND newer."embedding" IS NOT NULL
              AND newer."published_at" > gp."related_linked_at"
          )`
    : sql`AND TRUE`;

  const result = await db.execute<{ id: string }>(sql`
    SELECT ranked."id"
    FROM (
      SELECT gp."id",
             gp."related_linked_at",
             row_number() OVER (
               PARTITION BY gp."blog_id"
               ORDER BY gp."related_linked_at" ASC
             ) AS rn
      FROM "generated_posts" gp
      WHERE gp."status" = 'published'
        AND gp."embedding" IS NOT NULL
        AND gp."external_post_id" IS NOT NULL
        AND gp."related_linked_at" IS NOT NULL
        AND (${blogIdParam}::uuid IS NULL OR gp."blog_id" = ${blogIdParam}::uuid)
        ${staleFilter}
    ) ranked
    WHERE ranked."rn" <= ${refreshPerBlogCap()}
    ORDER BY ranked."related_linked_at" ASC
    LIMIT ${opts.limit}
  `);

  // Drizzle's neon-http driver returns { rows: [...] } here, not the array
  // directly.
  const rows = Array.isArray(result)
    ? (result as unknown as Array<{ id: string }>)
    : ((result as unknown as { rows?: Array<{ id: string }> }).rows ?? []);
  return rows
    .map((r) => r.id)
    .filter((id): id is string => typeof id === "string");
}

/**
 * Cron entry point. Embeds published posts that don't yet have a vector, then
 * links published posts that haven't been linked yet. Both passes are capped
 * per run so a large catalogue drains over several runs instead of one giant
 * job. New posts get linked immediately by the publish hook; this backfills
 * history and retries earlier failures.
 */
export async function runSemanticLinkingBackfill(options: {
  limit?: number;
  blogId?: string;
  /**
   * Re-link posts that were already linked (oldest first) and IGNORE the
   * staleness filter — a full rescore after tuning alpha/threshold or
   * upgrading the scorer. Off by default: scheduled runs use the split budget
   * below, whose refresh lane only touches posts whose neighbourhood actually
   * changed.
   */
  refresh?: boolean;
} = {}): Promise<BackfillResult> {
  if (!embeddingsConfigured()) {
    return {
      embedded: 0,
      embedFailed: 0,
      tsvBackfilled: 0,
      linked: 0,
      relinked: 0,
      linkFailed: 0,
      skipped: "OPENAI_API_KEY not configured",
    };
  }
  const limit = Math.min(Math.max(options.limit ?? 40, 1), 200);
  const errors: BackfillError[] = [];
  const record = (stage: "embed" | "link", id: string, reason: string) => {
    console.warn(`[semantic-linking] ${stage} failed for ${id}: ${reason}`);
    if (errors.length < MAX_REPORTED_ERRORS) errors.push({ stage, id, reason });
  };

  // 0. Backfill the sparse full-text vector for posts embedded before the
  //    hybrid layer existed. DB-only (no embedding API call) — sanitize the
  //    stored title+body and set search_tsv so they contribute to the sparse
  //    signal too.
  const toTsv = await db
    .select({
      id: generatedPosts.id,
      title: generatedPosts.title,
      body: generatedPosts.body,
      language: generatedPosts.language,
    })
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.status, "published"),
        isNotNull(generatedPosts.embedding),
        isNull(generatedPosts.searchTsv),
        isNotNull(generatedPosts.body),
        options.blogId ? eq(generatedPosts.blogId, options.blogId) : undefined,
      ),
    )
    .limit(limit);

  let tsvBackfilled = 0;
  for (const row of toTsv) {
    try {
      const text = sanitizeForEmbedding(row.title, row.body);
      if (!text) continue;
      await db
        .update(generatedPosts)
        .set({
          searchTsv: sql`to_tsvector(${tsConfigForLanguage(row.language)}::regconfig, ${text})`,
        })
        .where(eq(generatedPosts.id, row.id));
      tsvBackfilled++;
    } catch (err) {
      record("embed", row.id, err instanceof Error ? err.message : "tsv backfill failed");
    }
  }

  // 1. Embed published posts missing an embedding.
  const toEmbed = await db
    .select({ id: generatedPosts.id })
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.status, "published"),
        isNull(generatedPosts.embedding),
        isNotNull(generatedPosts.body),
        options.blogId ? eq(generatedPosts.blogId, options.blogId) : undefined,
      ),
    )
    .limit(limit);

  let embedded = 0;
  let embedFailed = 0;
  for (const row of toEmbed) {
    const res = await embedPost(row.id);
    if (res.ok) embedded++;
    else {
      embedFailed++;
      record("embed", row.id, res.reason ?? "unknown error");
    }
  }

  // 2. Link, in two lanes.
  //
  //    NEW lane     — never-linked posts, newest first. Since the publish hook
  //                   now links posts inline on every publish path, this lane
  //                   mostly catches hook failures and posts published while
  //                   OPENAI_API_KEY was down.
  //    REFRESH lane — already-linked posts whose blog has published something
  //                   newer. This is what keeps the graph bidirectional over
  //                   time: without it, post #1 links to nothing published
  //                   after the day it was first linked.
  //
  //    Unused NEW budget rolls into REFRESH, so once the historical corpus has
  //    drained the whole run does useful refresh work instead of idling.
  const wantsFullRefresh = options.refresh === true;
  const refreshBudget = wantsFullRefresh
    ? limit
    : Math.floor(limit * refreshShare());
  const newBudget = limit - refreshBudget;

  const newRows =
    newBudget > 0
      ? await db
          .select({ id: generatedPosts.id })
          .from(generatedPosts)
          .where(
            and(
              eq(generatedPosts.status, "published"),
              isNotNull(generatedPosts.embedding),
              isNotNull(generatedPosts.externalPostId),
              isNull(generatedPosts.relatedLinkedAt),
              options.blogId ? eq(generatedPosts.blogId, options.blogId) : undefined,
            ),
          )
          .orderBy(sql`${generatedPosts.publishedAt} desc nulls last`)
          .limit(newBudget)
      : [];

  const refreshIds = await selectRefreshBatch({
    limit: refreshBudget + (newBudget - newRows.length),
    blogId: options.blogId,
    requireStale: !wantsFullRefresh,
  });

  const newIds = new Set(newRows.map((r) => r.id));
  // The two lanes cannot overlap in normal operation — one requires
  // related_linked_at IS NULL, the other IS NOT NULL. The Set is
  // belt-and-braces for the ?refresh=1 mode where newBudget is 0.
  const toLink = Array.from(new Set([...newIds, ...refreshIds]));

  let linked = 0;
  let relinked = 0;
  let linkFailed = 0;
  const themeErrors = new Set<string>();
  for (const id of toLink) {
    try {
      const res = await applyRelatedLinks(id);
      if (res.ok) {
        if (newIds.has(id)) linked++;
        else relinked++;
      } else {
        linkFailed++;
        record("link", id, res.reason ?? "unknown error");
      }
      if (res.themeWarning) themeErrors.add(res.themeWarning);
    } catch (err) {
      // A platform API throwing (e.g. axios 4xx) must not abort the whole
      // run — record it and move on to the next post.
      linkFailed++;
      record("link", id, errDetail(err));
    }
    // Gentle throttle so a batch doesn't burst the platform's rate limit.
    await sleep(LINK_THROTTLE_MS);
  }

  if (themeErrors.size > 0) {
    for (const w of themeErrors) console.warn(`[semantic-linking] theme: ${w}`);
  }

  console.info(
    `[semantic-linking] run complete — embedded=${embedded} tsv=${tsvBackfilled} ` +
      `linked=${linked} relinked=${relinked} failed=${linkFailed} ` +
      `(budget ${newBudget}/${refreshBudget} of ${limit})`,
  );

  return {
    embedded,
    embedFailed,
    tsvBackfilled,
    ...(themeErrors.size > 0 ? { themeErrors: Array.from(themeErrors) } : {}),
    linked,
    relinked,
    linkFailed,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
