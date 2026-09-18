// Link-exchange REMOVAL engine (T03).
//
// Undoes what src/lib/services/link-exchange.ts placed before the scheme was
// retired. Every link it injected was stamped data-nx-exch="{edgeId}" inside a
// standalone carrier paragraph spliced in after the first </p>:
//
//   <p>You can find more information at <a href="…" data-nx-exch="…">Brand</a>.</p>
//   <p>For additional context, <a href="…" data-nx-exch="…">read more</a>.</p>
//   <p>Learn more about <a href="…" data-nx-exch="…">bpc 157 guide</a>.</p>
//
// This module drains link_exchange_removals (one row per published post),
// fetches each post's LIVE body, strips the link, and pushes the body back
// through the same platform client the placement used — so WordPress and
// Shopify are both handled without a single branch in this file.
//
// Design rules, all load-bearing:
//   - Idempotent. A post with no marker is recorded "clean" and never fetched
//     again. Re-running over cleaned posts changes nothing.
//   - Restartable. Progress lives in the queue table, never in memory, so a
//     killed container resumes exactly where it stopped.
//   - Byte-exact. Mutations are string splices at boundaries a real HTML parser
//     verified. The rest of the body is never re-serialized or normalized.
//   - Reversible per post. The pre-strip body is snapshotted in
//     link_exchange_removals.previous_body; restoreRemovedPost puts it back.
//   - Rate-limited and capped per run, like every other platform-touching job.
//   - Dry-run writes nothing: not to the platform, not to the queue.

import { db } from "@/lib/db";
import {
  blogs,
  generatedPosts,
  linkExchangeEdges,
  linkExchangeRemovals,
} from "@/lib/db/schema";
import { and, asc, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import * as cheerio from "cheerio";
import * as platform from "@/lib/services/platform-client";
import type { PlatformBlog } from "@/lib/services/platform-client";

// ─── Config ──────────────────────────────────────────────────────────────────

/** The attribute stamped on every link the exchange placed. */
export const EXCHANGE_ATTR = "data-nx-exch";

/**
 * The three carrier prefixes, copied verbatim from the retired
 * injectExchangeLink. Lower-cased for comparison. If a paragraph does not
 * match one of these EXACTLY, it is not ours and the anchor is unwrapped
 * instead of the paragraph being deleted.
 */
const CARRIER_PREFIXES = [
  "for additional context,",
  "learn more about",
  "you can find more information at",
];

/** Delay between live-post writes, to stay under platform rate limits. */
function throttleMs(): number {
  const v = Number(process.env.LINK_EXCHANGE_REMOVAL_THROTTLE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 250;
}

/** A post that has failed this many times stops being retried automatically. */
export const MAX_ATTEMPTS = 5;

/** Safety bound on the strip loop; a body should never hold more than one. */
const MAX_LINKS_PER_BODY = 20;

/** Rows per INSERT when seeding, to keep statements a sane size. */
const SEED_CHUNK = 500;

/** How many failure reasons to surface in a run's response before truncating. */
const MAX_REPORTED_ERRORS = 10;

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

// ─── Pure HTML stripping ─────────────────────────────────────────────────────
//
// Everything below this line is side-effect free and unit-tested in
// link-exchange-removal.test.ts. Nothing here touches the network or the DB.
//
// Why not a single regex: `body.replace(/<p>[^<]*<a[^>]*data-nx-exch…/g, "")`
// corrupts live client sites four different ways — `[^>]*` breaks on a ">"
// inside an attribute value, `.*?</p>` is not paragraph-aware so it can delete
// real article content, `.` does not cross newlines so a reflowed body silently
// fails to match while reporting success, and the anchor is not guaranteed to
// contain only text. Instead: locate by index, VERIFY the located slice with a
// real parser, then splice at the verified boundaries.
//
// Why not cheerio end-to-end: load → mutate → $.html() re-serializes the WHOLE
// document. Entities get normalized, attribute quoting changes, void tags get
// rewritten. Thousands of gratuitously-diffed bodies would go to live sites
// with no way to tell an intended change from a serializer artefact.

export interface StripResult {
  /** The repaired HTML. Identical to the input when nothing matched. */
  html: string;
  /** Whole machine-written carrier paragraphs deleted. */
  removedSentences: number;
  /** Anchors unwrapped in place because the paragraph was not ours. */
  unwrappedAnchors: number;
  /** Markers found whose boundaries could not be verified — left untouched. */
  unresolved: number;
}

interface Span {
  start: number;
  end: number;
}

interface AnchorSpan extends Span {
  innerStart: number;
  innerEnd: number;
}

/** cheerio's .text() yields NBSP as U+00A0; fold it and collapse runs. */
function normalizeText(s: string): string {
  return s.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Find the "<" of the start tag that ENCLOSES `attrIndex`, or -1 if that index
 * is not inside a start tag.
 *
 * This scans FORWARD from the beginning rather than walking backwards, because
 * a backwards character walk cannot tell a ">" that closes a tag from a ">"
 * sitting inside a quoted attribute value. An href like
 * "…/search?q=a%3Eb&sort=>desc" contains a literal ">" before the
 * data-nx-exch attribute, and a backwards walk stops there and reports "not in
 * a tag" — which is safe (we refuse to splice) but wrong: it dumps a perfectly
 * ordinary post into manual triage. Forward scanning with the same quote-aware
 * boundary logic as tagCloseIndex gets it right.
 */
function tagOpenIndex(html: string, attrIndex: number): number {
  let i = 0;
  while (i < html.length && i <= attrIndex) {
    const lt = html.indexOf("<", i);
    if (lt < 0 || lt > attrIndex) return -1;
    const gt = tagCloseIndex(html, lt);
    if (gt < 0) return -1;
    if (attrIndex > lt && attrIndex < gt) return lt;
    i = gt + 1;
  }
  return -1;
}

/**
 * Find the ">" that ends the tag opening at `openIndex`, skipping over quoted
 * attribute values so a ">" inside href="…" cannot end the tag early. Returns
 * -1 if the tag is unterminated.
 */
function tagCloseIndex(html: string, openIndex: number): number {
  let quote: string | null = null;
  for (let i = openIndex + 1; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ">") return i;
  }
  return -1;
}

/**
 * Given the index of the data-nx-exch attribute, resolve the full span of the
 * <a> element that carries it, plus the span of its inner HTML. Returns null
 * whenever anything is not exactly as expected — we never guess.
 */
function anchorSpan(html: string, attrIndex: number): AnchorSpan | null {
  const open = tagOpenIndex(html, attrIndex);
  if (open < 0) return null;

  // Must be "<a" followed by a tag-name boundary — not "<article".
  if (html.slice(open, open + 2).toLowerCase() !== "<a") return null;
  if (!/[\s/>]/.test(html[open + 2] ?? "")) return null;

  const gt = tagCloseIndex(html, open);
  if (gt < 0) return null;

  const lower = html.toLowerCase();
  const close = lower.indexOf("</a", gt + 1);
  if (close < 0) return null;
  if (!/[\s>]/.test(html[close + 3] ?? "")) return null;
  const closeEnd = tagCloseIndex(html, close);
  if (closeEnd < 0) return null;

  // An <a> may not legally contain another <a>. If one is in there the markup
  // is not what we wrote and splicing would be guesswork.
  if (/<a[\s/>]/i.test(html.slice(gt + 1, close))) return null;

  return { start: open, end: closeEnd + 1, innerStart: gt + 1, innerEnd: close };
}

/**
 * Resolve the span of the <p> element wrapping `anchor`, or null if the anchor
 * is not inside a well-formed paragraph. Deliberately conservative: it takes
 * the LAST <p> start tag before the anchor, rejects the case where that
 * paragraph already closed before the anchor (i.e. the anchor is not in it),
 * and requires a real </p> after the anchor.
 */
function paragraphSpan(html: string, anchor: Span): Span | null {
  const lower = html.toLowerCase();

  let open = -1;
  const openRe = /<p(?=[\s/>])/g;
  for (let m = openRe.exec(lower); m !== null; m = openRe.exec(lower)) {
    if (m.index >= anchor.start) break;
    open = m.index;
  }
  if (open < 0) return null;

  // A </p> between that start tag and the anchor means the anchor lives
  // outside any paragraph (implicit close, or a bare inline run).
  if (lower.slice(open, anchor.start).includes("</p")) return null;

  const close = lower.indexOf("</p", anchor.end);
  if (close < 0) return null;
  const closeEnd = tagCloseIndex(html, close);
  if (closeEnd < 0) return null;

  return { start: open, end: closeEnd + 1 };
}

/**
 * Parse the candidate paragraph with a real HTML parser and decide whether it
 * is one of OUR machine-written carriers — exactly one paragraph, exactly one
 * exchange anchor, no other element children, and text that reads exactly
 * "<prefix> <anchor text>.".
 *
 * `cheerio.load(slice, null, false)` parses the slice as a FRAGMENT, so no
 * html/head/body wrapper is invented around it.
 */
function isCarrierParagraph(slice: string): boolean {
  const $ = cheerio.load(slice, null, false);

  const paragraphs = $("p");
  if (paragraphs.length !== 1) return false;

  const p = paragraphs.first();
  const anchors = p.find(`a[${EXCHANGE_ATTR}]`);
  if (anchors.length !== 1) return false;

  // The carrier we injected holds exactly one element: the anchor itself.
  if (p.children().length !== 1) return false;

  const anchorText = normalizeText(anchors.first().text()).toLowerCase();
  const full = normalizeText(p.text()).toLowerCase();

  return CARRIER_PREFIXES.some((prefix) => full === `${prefix} ${anchorText}.`);
}

/** Confirm the located slice really is a single exchange anchor. */
function isSingleExchangeAnchor(slice: string): boolean {
  const $ = cheerio.load(slice, null, false);
  const anchors = $("a");
  return (
    anchors.length === 1 && anchors.first().attr(EXCHANGE_ATTR) !== undefined
  );
}

/**
 * Remove every link-exchange link from a body of HTML.
 *
 *   1. Whole carrier paragraph → deleted (it was 100% machine-written).
 *   2. Anything else          → the <a> wrapper is unwrapped, inner HTML kept
 *                               verbatim, surrounding prose untouched.
 *   3. Boundaries we cannot verify → left alone and counted as `unresolved`,
 *                               so the caller can flag the post for a human.
 *
 * Idempotent: running it on its own output returns that output unchanged with
 * all counters at zero.
 */
export function stripExchangeLinks(bodyHtml: string): StripResult {
  let html = bodyHtml;
  let removedSentences = 0;
  let unwrappedAnchors = 0;
  let unresolved = 0;
  let searchFrom = 0;

  for (let i = 0; i < MAX_LINKS_PER_BODY; i++) {
    const marker = html
      .toLowerCase()
      .indexOf(`${EXCHANGE_ATTR}=`, searchFrom);
    if (marker < 0) break;

    const anchor = anchorSpan(html, marker);
    if (!anchor) {
      unresolved++;
      searchFrom = marker + EXCHANGE_ATTR.length;
      continue;
    }

    // 1. Our own carrier paragraph — delete the whole thing.
    const para = paragraphSpan(html, anchor);
    if (para && isCarrierParagraph(html.slice(para.start, para.end))) {
      const before = html.slice(0, para.start);
      const after = html.slice(para.end);
      // The fallback branch of injectExchangeLink appended the carrier after a
      // "\n" at the very end of the body; drop that orphaned whitespace too.
      html = after.length === 0 ? before.replace(/\s+$/, "") : before + after;
      removedSentences++;
      searchFrom = Math.min(para.start, html.length);
      continue;
    }

    // 2. Someone else's paragraph — unwrap the anchor only.
    if (!isSingleExchangeAnchor(html.slice(anchor.start, anchor.end))) {
      unresolved++;
      searchFrom = anchor.end;
      continue;
    }
    const inner = html.slice(anchor.innerStart, anchor.innerEnd);
    html = html.slice(0, anchor.start) + inner + html.slice(anchor.end);
    unwrappedAnchors++;
    searchFrom = Math.min(anchor.start, html.length);
  }

  return { html, removedSentences, unwrappedAnchors, unresolved };
}

// ─── Blog context ────────────────────────────────────────────────────────────

interface BlogContext {
  blog: PlatformBlog;
  domain: string;
  /** Pre-resolved once per blog per run so a batch doesn't hit /blogs.json per post. */
  shopifyBlogId?: string;
}

async function loadBlogContexts(
  blogIds: string[],
): Promise<Map<string, BlogContext>> {
  const map = new Map<string, BlogContext>();
  const ids = Array.from(new Set(blogIds));
  if (ids.length === 0) return map;

  const rows = await db.select().from(blogs).where(inArray(blogs.id, ids));

  for (const row of rows) {
    const platformBlog: PlatformBlog = {
      platform: row.platform,
      wpUrl: row.wpUrl,
      wpUsername: row.wpUsername,
      wpAppPassword: row.wpAppPassword,
      seoPlugin: row.seoPlugin,
      shopifyAuthMode: row.shopifyAuthMode,
      shopifyStoreUrl: row.shopifyStoreUrl,
      shopifyAdminApiToken: row.shopifyAdminApiToken,
      shopifyClientId: row.shopifyClientId,
      shopifyClientSecret: row.shopifyClientSecret,
      shopifyBlogHandle: row.shopifyBlogHandle,
    };

    let shopifyBlogId: string | undefined;
    if (row.platform === "shopify") {
      try {
        shopifyBlogId = (await platform.resolveShopifyBlogId(platformBlog))
          ?.blogId;
      } catch {
        shopifyBlogId = undefined;
      }
    }

    map.set(row.id, { blog: platformBlog, domain: row.domain, shopifyBlogId });
  }

  return map;
}

// ─── Queue bookkeeping ───────────────────────────────────────────────────────

type QueuePatch = {
  status?: string;
  linksRemoved?: number;
  attempts?: number;
  lastError?: string | null;
  previousBody?: string | null;
  checkedAt?: Date;
  priority?: number;
};

async function markQueue(postId: string, patch: QueuePatch): Promise<void> {
  await db
    .update(linkExchangeRemovals)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(linkExchangeRemovals.postId, postId));
}

// ─── Seeding ─────────────────────────────────────────────────────────────────

export interface SeedResult {
  sourceBlogs: number;
  inserted: number;
  queueTotal: number;
}

/**
 * (Re)populate the removal queue. Migration 0041 already does this once at
 * deploy time; this is the app-side equivalent for a manual top-up, e.g. after
 * restoring a blog or if the migration's seed was interrupted.
 *
 * Two passes, in this order so priorities land correctly:
 *   0. Posts a PLACED edge points at — known to carry a link. priority 0.
 *   1. Every published post on any blog that ever hosted an exchange link —
 *      the audit sweep that catches orphans. priority 1.
 *
 * ON CONFLICT DO NOTHING everywhere, so it converges on re-run and never
 * downgrades a priority-0 row to priority 1.
 */
export async function seedRemovalQueue(
  options: { blogId?: string } = {},
): Promise<SeedResult> {
  let inserted = 0;

  // Pass 0 — the precise set.
  const placedRows = await db
    .selectDistinct({ postId: linkExchangeEdges.placedInPostId })
    .from(linkExchangeEdges)
    .where(
      and(
        eq(linkExchangeEdges.status, "placed"),
        isNotNull(linkExchangeEdges.placedInPostId),
        options.blogId
          ? eq(linkExchangeEdges.sourceBlogId, options.blogId)
          : undefined,
      ),
    );
  const placedIds = placedRows
    .map((r) => r.postId)
    .filter((x): x is string => !!x);

  for (let i = 0; i < placedIds.length; i += SEED_CHUNK) {
    const chunk = placedIds.slice(i, i + SEED_CHUNK);
    const posts = await db
      .select({ id: generatedPosts.id, blogId: generatedPosts.blogId })
      .from(generatedPosts)
      .where(
        and(
          inArray(generatedPosts.id, chunk),
          isNotNull(generatedPosts.externalPostId),
        ),
      );
    if (posts.length === 0) continue;
    const res = await db
      .insert(linkExchangeRemovals)
      .values(posts.map((p) => ({ postId: p.id, blogId: p.blogId, priority: 0 })))
      .onConflictDoNothing()
      .returning({ postId: linkExchangeRemovals.postId });
    inserted += res.length;
  }

  // Pass 1 — the sweep.
  const sourceRows = await db
    .selectDistinct({ blogId: linkExchangeEdges.sourceBlogId })
    .from(linkExchangeEdges)
    .where(
      options.blogId
        ? eq(linkExchangeEdges.sourceBlogId, options.blogId)
        : undefined,
    );

  for (const { blogId } of sourceRows) {
    const posts = await db
      .select({ id: generatedPosts.id })
      .from(generatedPosts)
      .where(
        and(
          eq(generatedPosts.blogId, blogId),
          eq(generatedPosts.status, "published"),
          isNotNull(generatedPosts.externalPostId),
        ),
      );
    for (let i = 0; i < posts.length; i += SEED_CHUNK) {
      const chunk = posts.slice(i, i + SEED_CHUNK);
      const res = await db
        .insert(linkExchangeRemovals)
        .values(chunk.map((p) => ({ postId: p.id, blogId, priority: 1 })))
        .onConflictDoNothing()
        .returning({ postId: linkExchangeRemovals.postId });
      inserted += res.length;
    }
  }

  const [totals] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(linkExchangeRemovals);

  return {
    sourceBlogs: sourceRows.length,
    inserted,
    queueTotal: totals?.total ?? 0,
  };
}

// ─── The run ─────────────────────────────────────────────────────────────────

export interface RemovalOptions {
  /** Posts to process this run. Default 50, hard-capped at 300. */
  limit?: number;
  /** Restrict to one blog — use this to pilot on a single site first. */
  blogId?: string;
  /** Report what WOULD change and write nothing, anywhere. */
  dryRun?: boolean;
}

export interface RemovalError {
  postId: string;
  domain: string;
  reason: string;
}

export interface RemovalRunResult {
  dryRun: boolean;
  /** Live bodies fetched this run. */
  scanned: number;
  /** Posts that carried a link and were repaired (or would be, in a dry run). */
  cleanedPosts: number;
  /** Posts checked and found to carry no exchange link. */
  alreadyClean: number;
  failed: number;
  sentencesRemoved: number;
  anchorsUnwrapped: number;
  /** Markers seen whose markup could not be verified — needs a human. */
  unresolvedMarkers: number;
  /** Stored generated_posts.body rows repaired (expected to be 0). */
  storedBodiesFixed: number;
  /** link_exchange_edges rows moved from 'placed' to 'removed'. */
  edgesClosed: number;
  /** Queue rows still to do after this run. */
  remaining: number;
  errors?: RemovalError[];
}

/**
 * Drain one batch of the removal queue. Safe to run concurrently with itself
 * only in the sense that duplicated work is harmless (a second pass over an
 * already-clean post is a no-op) — but keep it to one cron service so the
 * platform rate limits are respected.
 */
export async function runLinkExchangeRemoval(
  options: RemovalOptions = {},
): Promise<RemovalRunResult> {
  const dryRun = options.dryRun ?? false;
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 300);
  const throttle = throttleMs();

  const errors: RemovalError[] = [];
  const record = (postId: string, domain: string, reason: string) => {
    console.warn(`[link-exchange-removal] ${domain} ${postId}: ${reason}`);
    if (errors.length < MAX_REPORTED_ERRORS) errors.push({ postId, domain, reason });
  };

  const rows = await db
    .select({
      postId: linkExchangeRemovals.postId,
      blogId: linkExchangeRemovals.blogId,
      attempts: linkExchangeRemovals.attempts,
      externalPostId: generatedPosts.externalPostId,
      storedBody: generatedPosts.body,
    })
    .from(linkExchangeRemovals)
    .innerJoin(
      generatedPosts,
      eq(generatedPosts.id, linkExchangeRemovals.postId),
    )
    .where(
      and(
        or(
          eq(linkExchangeRemovals.status, "pending"),
          and(
            eq(linkExchangeRemovals.status, "failed"),
            lt(linkExchangeRemovals.attempts, MAX_ATTEMPTS),
          ),
        ),
        isNotNull(generatedPosts.externalPostId),
        options.blogId ? eq(linkExchangeRemovals.blogId, options.blogId) : undefined,
      ),
    )
    .orderBy(
      asc(linkExchangeRemovals.priority),
      asc(linkExchangeRemovals.attempts),
      asc(linkExchangeRemovals.createdAt),
    )
    .limit(limit);

  const contexts = await loadBlogContexts(rows.map((r) => r.blogId));

  let scanned = 0;
  let cleanedPosts = 0;
  let alreadyClean = 0;
  let failed = 0;
  let sentencesRemoved = 0;
  let anchorsUnwrapped = 0;
  let unresolvedMarkers = 0;
  let storedBodiesFixed = 0;
  let edgesClosed = 0;

  for (const row of rows) {
    const externalPostId = row.externalPostId;
    if (!externalPostId) continue; // filtered in SQL; narrows the type

    const ctx = contexts.get(row.blogId);
    if (!ctx) {
      failed++;
      record(row.postId, "unknown-blog", "Blog row not found");
      if (!dryRun) {
        await markQueue(row.postId, {
          status: "failed",
          attempts: row.attempts + 1,
          lastError: "Blog row not found",
          checkedAt: new Date(),
        });
      }
      continue;
    }

    const { body, error } = await platform.fetchLivePostBodyResult(
      ctx.blog,
      externalPostId,
      ctx.shopifyBlogId,
    );
    scanned++;

    if (body === null) {
      failed++;
      const reason = error ?? "Could not fetch live body";
      record(row.postId, ctx.domain, reason);
      if (!dryRun) {
        await markQueue(row.postId, {
          status: "failed",
          attempts: row.attempts + 1,
          lastError: reason,
          checkedAt: new Date(),
        });
      }
      await sleep(throttle);
      continue;
    }

    const strip = stripExchangeLinks(body);
    unresolvedMarkers += strip.unresolved;
    const changes = strip.removedSentences + strip.unwrappedAnchors;

    // Nothing to change. Either genuinely clean, or a marker we refused to
    // touch — the latter must NOT be recorded as clean.
    if (changes === 0) {
      if (strip.unresolved > 0) {
        failed++;
        const reason =
          "Marker present but its markup could not be verified — needs a manual edit";
        record(row.postId, ctx.domain, reason);
        if (!dryRun) {
          await markQueue(row.postId, {
            status: "failed",
            attempts: MAX_ATTEMPTS, // stop auto-retrying; a human must look
            lastError: reason,
            checkedAt: new Date(),
          });
        }
      } else {
        alreadyClean++;
        if (!dryRun) {
          await markQueue(row.postId, {
            status: "clean",
            attempts: row.attempts + 1,
            linksRemoved: 0,
            lastError: null,
            checkedAt: new Date(),
          });
        }
      }
      await sleep(throttle);
      continue;
    }

    sentencesRemoved += strip.removedSentences;
    anchorsUnwrapped += strip.unwrappedAnchors;

    if (dryRun) {
      cleanedPosts++;
      await sleep(throttle);
      continue;
    }

    const res = await platform.updateLivePostBody(
      ctx.blog,
      externalPostId,
      strip.html,
      { shopifyBlogId: ctx.shopifyBlogId },
    );
    if (!res.ok) {
      failed++;
      const reason = res.message ?? "Update failed";
      record(row.postId, ctx.domain, reason);
      await markQueue(row.postId, {
        status: "failed",
        attempts: row.attempts + 1,
        lastError: reason,
        checkedAt: new Date(),
      });
      await sleep(throttle);
      continue;
    }

    // The placement only ever wrote to the live platform, never to
    // generated_posts.body — but repair the stored copy defensively so a
    // future republish cannot reintroduce the link. Expected to be a no-op.
    if (row.storedBody && row.storedBody.includes(EXCHANGE_ATTR)) {
      const storedStrip = stripExchangeLinks(row.storedBody);
      await db
        .update(generatedPosts)
        .set({ body: storedStrip.html, updatedAt: new Date() })
        .where(eq(generatedPosts.id, row.postId));
      storedBodiesFixed++;
    }

    const closed = await db
      .update(linkExchangeEdges)
      .set({ status: "removed", failureReason: null, updatedAt: new Date() })
      .where(
        and(
          eq(linkExchangeEdges.placedInPostId, row.postId),
          eq(linkExchangeEdges.status, "placed"),
        ),
      )
      .returning({ id: linkExchangeEdges.id });
    edgesClosed += closed.length;

    await markQueue(row.postId, {
      status: "removed",
      linksRemoved: changes,
      attempts: row.attempts + 1,
      lastError: null,
      previousBody: body,
      checkedAt: new Date(),
    });
    cleanedPosts++;
    await sleep(throttle);
  }

  const [counts] = await db
    .select({
      remaining: sql<number>`count(*) filter (where ${linkExchangeRemovals.status} = 'pending' or (${linkExchangeRemovals.status} = 'failed' and ${linkExchangeRemovals.attempts} < ${MAX_ATTEMPTS}))::int`,
    })
    .from(linkExchangeRemovals);

  return {
    dryRun,
    scanned,
    cleanedPosts,
    alreadyClean,
    failed,
    sentencesRemoved,
    anchorsUnwrapped,
    unresolvedMarkers,
    storedBodiesFixed,
    edgesClosed,
    remaining: counts?.remaining ?? 0,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

// ─── Per-post rollback ───────────────────────────────────────────────────────

/**
 * Push the snapshotted pre-removal body back to the live post and re-queue it.
 * This is the escape hatch for "the strip damaged that article" — it is not
 * something to run in bulk, and it will put the exchange link back.
 */
export async function restoreRemovedPost(
  postId: string,
): Promise<{ ok: boolean; message: string }> {
  const [row] = await db
    .select({
      blogId: linkExchangeRemovals.blogId,
      previousBody: linkExchangeRemovals.previousBody,
      externalPostId: generatedPosts.externalPostId,
    })
    .from(linkExchangeRemovals)
    .innerJoin(
      generatedPosts,
      eq(generatedPosts.id, linkExchangeRemovals.postId),
    )
    .where(eq(linkExchangeRemovals.postId, postId))
    .limit(1);

  if (!row) return { ok: false, message: "No removal record for that post" };
  if (!row.previousBody) {
    return { ok: false, message: "No snapshot stored for that post" };
  }
  if (!row.externalPostId) {
    return { ok: false, message: "Post has no external id" };
  }

  const contexts = await loadBlogContexts([row.blogId]);
  const ctx = contexts.get(row.blogId);
  if (!ctx) return { ok: false, message: "Blog row not found" };

  const res = await platform.updateLivePostBody(
    ctx.blog,
    row.externalPostId,
    row.previousBody,
    { shopifyBlogId: ctx.shopifyBlogId },
  );
  if (!res.ok) return { ok: false, message: res.message ?? "Update failed" };

  await markQueue(postId, {
    status: "pending",
    linksRemoved: 0,
    attempts: 0,
    lastError: "restored from snapshot",
  });

  return { ok: true, message: `Restored the pre-removal body of ${postId}` };
}
