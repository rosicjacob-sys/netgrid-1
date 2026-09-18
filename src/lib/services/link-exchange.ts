// Link Exchange engine — RETIRED (T03). DO NOT RE-ENABLE.
//
// This module used to build a full directed mesh of reciprocal links between
// every pair of a client's own active blogs, and drip one body-text link at a
// time into live published posts. Each placed link carried a machine-readable
// data-nx-exch="{edgeId}" attribute inside one of three fixed carrier
// sentences, with no rel qualifier — a network-wide, joinable fingerprint of a
// reciprocal link scheme.
//
// The engine is now inert:
//   - LINK_EXCHANGE_RETIRED below short-circuits every exported entry point.
//   - The cron route (/api/cron/link-exchange) returns 410 and does not import
//     this module at all.
//   - The Render cron service was deleted from render.yaml.
//   - Migration 0041 opted every client out and moved every unplaced edge to
//     the terminal 'disabled' status.
//
// The placement code below is deliberately left in place, unreachable, as the
// record of what was done. Links already live are removed by
// src/lib/services/link-exchange-removal.ts.
//
// Re-enabling requires editing this constant, which is intentional: it forces a
// code review rather than a config toggle. Do not add an env-var escape hatch.
// Typed as `boolean`, not inferred as `true`, so TypeScript does not narrow the
// rest of each function to unreachable code (which would fail lint).
const LINK_EXCHANGE_RETIRED: boolean = true;

const RETIRED_REASON =
  "Link exchange retired (T03) — placements are permanently disabled.";
import { db } from "@/lib/db";
import {
  blogs,
  clients,
  clientKeywords,
  generatedPosts,
  linkExchangeEdges,
  linkExchangeLoops,
} from "@/lib/db/schema";
import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import * as platform from "@/lib/services/platform-client";
import type { PlatformBlog } from "@/lib/services/platform-client";

// ─── Config ──────────────────────────────────────────────────────────────────

function maxPlacementsPerRun(): number {
  const v = Number(process.env.LINK_EXCHANGE_MAX);
  return Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), 100) : 10;
}

const PLACE_THROTTLE_MS = 200;

// Anchor-type weights → ~85% branded+naked, ~10% generic, <5% partial, <2% exact.
const ANCHOR_WEIGHTS: Array<{ type: AnchorType; weight: number }> = [
  { type: "branded", weight: 0.45 },
  { type: "naked", weight: 0.4 },
  { type: "generic", weight: 0.1 },
  { type: "partial", weight: 0.04 },
  { type: "exact", weight: 0.01 },
];

const GENERIC_ANCHORS = [
  "read more",
  "learn more",
  "this article",
  "more here",
  "further reading",
  "see details",
];

type AnchorType = "branded" | "naked" | "generic" | "partial" | "exact";

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

// ─── Anchor allocation ───────────────────────────────────────────────────────

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** "oldquebecpeptides.ca" → "Oldquebecpeptides"; "shop.example.com" → "Example". */
function brandFromDomain(domain: string): string {
  const host = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const parts = host.split(".").filter(Boolean);
  // Drop TLD; prefer the most significant label (skip common subdomains).
  const labels = parts.slice(0, -1).filter((p) => !["www", "shop", "blog"].includes(p));
  const label = labels[labels.length - 1] ?? parts[0] ?? host;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function nakedFromDomain(domain: string): string {
  return domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

function weightedAnchorType(): AnchorType {
  const r = Math.random();
  let acc = 0;
  for (const { type, weight } of ANCHOR_WEIGHTS) {
    acc += weight;
    if (r <= acc) return type;
  }
  return "branded";
}

function allocateAnchor(
  targetDomain: string,
  keyword: string | null,
): { text: string; type: AnchorType } {
  let type = weightedAnchorType();
  // Fall back off keyword-based types when we have no keyword.
  if ((type === "partial" || type === "exact") && !keyword) type = "branded";

  switch (type) {
    case "naked":
      return { text: nakedFromDomain(targetDomain), type };
    case "generic":
      return { text: pick(GENERIC_ANCHORS), type };
    case "partial":
      return {
        text: pick([`${keyword} guide`, `more on ${keyword}`, `best ${keyword}`]),
        type,
      };
    case "exact":
      return { text: keyword as string, type };
    case "branded":
    default:
      return { text: brandFromDomain(targetDomain), type: "branded" };
  }
}

// ─── Mesh building ───────────────────────────────────────────────────────────

interface EligibleBlog {
  id: string;
  clientId: string;
  domain: string;
  niche: string;
}

/**
 * Ensure each opted-in client has a full mesh: every one of its active sites
 * links to every other site it owns (A→B, A→C, …, B→A, …). Idempotent — one
 * loop row per client, and only missing directed edges are added, so a client
 * that gains a site later gets wired in on the next run. Never links across
 * clients.
 */
export async function buildLoops(): Promise<{
  loopsCreated: number;
  edgesCreated: number;
}> {
  if (LINK_EXCHANGE_RETIRED) return { loopsCreated: 0, edgesCreated: 0 };

  const eligible = await db
    .select({
      id: blogs.id,
      clientId: blogs.clientId,
      domain: blogs.domain,
      clientNiche: clients.niche,
    })
    .from(blogs)
    .innerJoin(clients, eq(blogs.clientId, clients.id))
    .where(and(eq(clients.linkExchangeEnabled, true), eq(blogs.status, "active")));

  // Group active sites by client.
  const byClient = new Map<string, EligibleBlog[]>();
  for (const b of eligible) {
    const site: EligibleBlog = {
      id: b.id,
      clientId: b.clientId,
      domain: b.domain,
      niche: (b.clientNiche || "default").trim().toLowerCase(),
    };
    const list = byClient.get(b.clientId) ?? [];
    list.push(site);
    byClient.set(b.clientId, list);
  }

  const keywordByClient = await loadClientKeywords(eligible.map((b) => b.clientId));

  let loopsCreated = 0;
  let edgesCreated = 0;

  for (const [clientId, sites] of byClient) {
    if (sites.length < 2) continue; // need ≥2 sites to interlink
    const niche = sites[0]?.niche ?? "default";
    const keyword = keywordByClient.get(clientId) ?? nicheKeyword(niche);

    // One loop per client (its whole mesh). Find or create it.
    let [loop] = await db
      .select({ id: linkExchangeLoops.id })
      .from(linkExchangeLoops)
      .where(
        and(
          eq(linkExchangeLoops.clientId, clientId),
          eq(linkExchangeLoops.status, "active"),
        ),
      )
      .limit(1);
    if (!loop) {
      [loop] = await db
        .insert(linkExchangeLoops)
        .values({ clientId, niche, size: sites.length })
        .returning({ id: linkExchangeLoops.id });
      loopsCreated++;
    } else {
      await db
        .update(linkExchangeLoops)
        .set({ size: sites.length, niche, updatedAt: new Date() })
        .where(eq(linkExchangeLoops.id, loop.id));
    }

    // Which directed edges already exist for this client's mesh.
    const existing = await db
      .select({
        source: linkExchangeEdges.sourceBlogId,
        target: linkExchangeEdges.targetBlogId,
      })
      .from(linkExchangeEdges)
      .where(eq(linkExchangeEdges.loopId, loop.id));
    const have = new Set(existing.map((e) => `${e.source}|${e.target}`));

    // Add every missing ordered pair (X → Y, X ≠ Y).
    for (const source of sites) {
      for (const target of sites) {
        if (source.id === target.id) continue;
        if (have.has(`${source.id}|${target.id}`)) continue;
        const anchor = allocateAnchor(target.domain, keyword);
        await db
          .insert(linkExchangeEdges)
          .values({
            loopId: loop.id,
            sourceBlogId: source.id,
            targetBlogId: target.id,
            position: 0,
            anchorText: anchor.text.slice(0, 255),
            anchorType: anchor.type,
          })
          .onConflictDoNothing();
        edgesCreated++;
      }
    }
  }

  return { loopsCreated, edgesCreated };
}

function nicheKeyword(niche: string): string | null {
  return niche && niche !== "default" ? niche : null;
}

async function loadClientKeywords(
  clientIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const ids = Array.from(new Set(clientIds));
  if (ids.length === 0) return map;
  const rows = await db
    .select({ clientId: clientKeywords.clientId, keyword: clientKeywords.keyword })
    .from(clientKeywords)
    .where(and(inArray(clientKeywords.clientId, ids), eq(clientKeywords.isActive, true)));
  for (const r of rows) {
    if (!map.has(r.clientId)) map.set(r.clientId, r.keyword);
  }
  return map;
}

// ─── Placement ───────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Inject an inline body-text link. Returns the new body, or null if the post
 * already carries an exchange link (one per host post) or has no usable body.
 * The link is tagged `data-nx-exch` for idempotency, tracking and removal.
 */
function injectExchangeLink(
  bodyHtml: string,
  anchorText: string,
  url: string,
  edgeId: string,
  type: AnchorType,
): string | null {
  if (/data-nx-exch=/.test(bodyHtml)) return null; // already hosts one
  if (bodyHtml.replace(/<[^>]+>/g, "").trim().length < 400) return null; // too thin

  const anchor = `<a href="${escapeHtml(url)}" data-nx-exch="${edgeId}">${escapeHtml(anchorText)}</a>`;
  const clause =
    type === "generic"
      ? `<p>For additional context, ${anchor}.</p>`
      : type === "partial" || type === "exact"
        ? `<p>Learn more about ${anchor}.</p>`
        : `<p>You can find more information at ${anchor}.</p>`;

  // Insert after the first paragraph so it reads as body content, not a footer.
  const firstClose = bodyHtml.indexOf("</p>");
  if (firstClose >= 0) {
    return bodyHtml.slice(0, firstClose + 4) + clause + bodyHtml.slice(firstClose + 4);
  }
  return `${bodyHtml}\n${clause}`;
}

/** Pick a topically-relevant published post URL on the target blog. */
async function pickTargetUrl(
  targetBlogId: string,
  sourcePostId: string,
): Promise<string | null> {
  const targetEmbedding = sql`(select ${generatedPosts.embedding} from ${generatedPosts} where ${generatedPosts.id} = ${sourcePostId})`;
  const [relevant] = await db
    .select({ url: generatedPosts.externalPostUrl })
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.blogId, targetBlogId),
        eq(generatedPosts.status, "published"),
        isNotNull(generatedPosts.externalPostUrl),
        isNotNull(generatedPosts.embedding),
      ),
    )
    .orderBy(sql`${generatedPosts.embedding} <=> ${targetEmbedding} asc`)
    .limit(1);
  if (relevant?.url) return relevant.url;

  const [recent] = await db
    .select({ url: generatedPosts.externalPostUrl })
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.blogId, targetBlogId),
        eq(generatedPosts.status, "published"),
        isNotNull(generatedPosts.externalPostUrl),
      ),
    )
    .orderBy(desc(generatedPosts.publishedAt))
    .limit(1);
  return recent?.url ?? null;
}

export interface PlaceResult {
  ok: boolean;
  reason?: string;
}

/** RETIRED (T03) — always refuses. See the module header. */
export async function placeEdge(edgeId: string): Promise<PlaceResult> {
  if (LINK_EXCHANGE_RETIRED) return { ok: false, reason: RETIRED_REASON };

  const [edge] = await db
    .select()
    .from(linkExchangeEdges)
    .where(eq(linkExchangeEdges.id, edgeId))
    .limit(1);
  if (!edge) return { ok: false, reason: "Edge not found" };

  const [sourceBlog] = await db
    .select()
    .from(blogs)
    .where(eq(blogs.id, edge.sourceBlogId))
    .limit(1);
  if (!sourceBlog) return fail(edge.id, "Source blog not found");

  // A host post on the source blog: published, live, not already used by an
  // exchange edge, and (below) not already carrying an exchange link.
  const usedRows = await db
    .select({ id: linkExchangeEdges.placedInPostId })
    .from(linkExchangeEdges)
    .where(
      and(
        eq(linkExchangeEdges.sourceBlogId, edge.sourceBlogId),
        isNotNull(linkExchangeEdges.placedInPostId),
      ),
    );
  const usedPostIds = usedRows.map((r) => r.id).filter((x): x is string => !!x);

  const hostConds = [
    eq(generatedPosts.blogId, edge.sourceBlogId),
    eq(generatedPosts.status, "published"),
    isNotNull(generatedPosts.externalPostId),
    ...usedPostIds.map((id) => ne(generatedPosts.id, id)),
  ];
  const [host] = await db
    .select({
      id: generatedPosts.id,
      externalPostId: generatedPosts.externalPostId,
    })
    .from(generatedPosts)
    .where(and(...hostConds))
    .orderBy(desc(generatedPosts.publishedAt))
    .limit(1);
  if (!host || !host.externalPostId) {
    return fail(edge.id, "No available host post on source blog");
  }

  const targetUrl = await pickTargetUrl(edge.targetBlogId, host.id);
  if (!targetUrl) return fail(edge.id, "No linkable post on target blog");

  const shopifyBlogId =
    (sourceBlog as PlatformBlog).platform === "shopify"
      ? await resolveShopifyBlogIdSafe(sourceBlog as PlatformBlog)
      : undefined;

  const { body, error } = await platform.fetchLivePostBodyResult(
    sourceBlog as PlatformBlog,
    host.externalPostId,
    shopifyBlogId,
  );
  if (body === null) return fail(edge.id, error ?? "Could not fetch host body");

  const newBody = injectExchangeLink(
    body,
    edge.anchorText,
    targetUrl,
    edge.id,
    edge.anchorType as AnchorType,
  );
  if (newBody === null) {
    return fail(edge.id, "Host post unsuitable (already linked or too thin)");
  }

  const res = await platform.updateLivePostBody(
    sourceBlog as PlatformBlog,
    host.externalPostId,
    newBody,
    { shopifyBlogId },
  );
  if (!res.ok) return fail(edge.id, res.message ?? "Update failed");

  await db
    .update(linkExchangeEdges)
    .set({
      status: "placed",
      targetUrl,
      placedInPostId: host.id,
      placedAt: new Date(),
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(eq(linkExchangeEdges.id, edge.id));
  return { ok: true };
}

async function resolveShopifyBlogIdSafe(
  blog: PlatformBlog,
): Promise<string | undefined> {
  try {
    return (await platform.resolveShopifyBlogId(blog))?.blogId;
  } catch {
    return undefined;
  }
}

async function fail(edgeId: string, reason: string): Promise<PlaceResult> {
  // Keep the edge pending but stamp the reason + updatedAt so it rotates to the
  // back of the queue (oldest-first) and doesn't re-hammer a broken source.
  await db
    .update(linkExchangeEdges)
    .set({ failureReason: reason, updatedAt: new Date() })
    .where(eq(linkExchangeEdges.id, edgeId));
  return { ok: false, reason };
}

// ─── Cron entry point (RETIRED) ──────────────────────────────────────────────

export interface LinkExchangeRunResult {
  loopsCreated: number;
  edgesCreated: number;
  placed: number;
  placeFailed: number;
  errors?: Array<{ edgeId: string; reason: string }>;
  /** Set when the engine refused to run at all (it is retired). */
  skipped?: string;
}

/**
 * RETIRED (T03). Returns a zeroed result with `skipped` set and touches
 * nothing. Kept as a function rather than deleted so any forgotten caller
 * fails loudly in its response body instead of throwing a 500 that looks like
 * an outage. The real gate is the 410 on the cron route.
 */
export async function runLinkExchange(
  options: { limit?: number } = {},
): Promise<LinkExchangeRunResult> {
  if (LINK_EXCHANGE_RETIRED) {
    console.warn(
      `[link-exchange] runLinkExchange called after retirement (limit=${options.limit ?? "default"}) — find and remove the caller`,
    );
    return {
      loopsCreated: 0,
      edgesCreated: 0,
      placed: 0,
      placeFailed: 0,
      skipped: RETIRED_REASON,
    };
  }

  const { loopsCreated, edgesCreated } = await buildLoops();
  const limit = Math.min(Math.max(options.limit ?? maxPlacementsPerRun(), 1), 100);

  const pending = await db
    .select({ id: linkExchangeEdges.id, sourceBlogId: linkExchangeEdges.sourceBlogId })
    .from(linkExchangeEdges)
    .where(eq(linkExchangeEdges.status, "pending"))
    .orderBy(sql`${linkExchangeEdges.updatedAt} asc`)
    .limit(limit * 5);

  const errors: Array<{ edgeId: string; reason: string }> = [];
  const usedSources = new Set<string>();
  let placed = 0;
  let placeFailed = 0;

  for (const edge of pending) {
    if (placed >= limit) break;
    if (usedSources.has(edge.sourceBlogId)) continue; // drip: 1/source/run
    usedSources.add(edge.sourceBlogId);

    let res: PlaceResult;
    try {
      res = await placeEdge(edge.id);
    } catch (err) {
      res = { ok: false, reason: err instanceof Error ? err.message : "placement threw" };
    }
    if (res.ok) placed++;
    else {
      placeFailed++;
      if (errors.length < 10) errors.push({ edgeId: edge.id, reason: res.reason ?? "unknown" });
    }
    await sleep(PLACE_THROTTLE_MS);
  }

  return {
    loopsCreated,
    edgesCreated,
    placed,
    placeFailed,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
