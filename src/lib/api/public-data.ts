import { db } from "@/lib/db";
import {
  clients,
  blogs,
  linkEvents,
  generatedPosts,
  seoThirdPartyData,
  seoScans,
} from "@/lib/db/schema";
import {
  and,
  avg,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  max,
  sql,
} from "drizzle-orm";

/**
 * Read models for the public marketing API. These deliberately expose ONLY
 * safe, client-facing fields — never platform credentials (WP passwords,
 * Shopify tokens/secrets), internal notes, or custom prompts. Add fields here
 * explicitly; do not spread whole rows.
 */

type ClientStatus = "onboarding" | "active" | "paused" | "churned";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Resolve a traffic time-window from query params. Supports either:
 *   ?days=<1..365>   rolling window ending now
 *   ?since=<ISO>     explicit lower bound
 * `days` wins when both are present. Returns undefined for all-time.
 */
export function parseSince(params: URLSearchParams): Date | undefined {
  const daysRaw = params.get("days")?.trim();
  if (daysRaw) {
    const days = Number.parseInt(daysRaw, 10);
    if (Number.isFinite(days)) {
      const clamped = Math.min(365, Math.max(1, days));
      return new Date(Date.now() - clamped * 24 * 60 * 60 * 1000);
    }
  }
  const sinceRaw = params.get("since")?.trim();
  if (sinceRaw) {
    const d = new Date(sinceRaw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}

interface Traffic {
  views: number;
  clicks: number;
}

// ─── Aggregations (all fail-safe: an un-migrated link_events table → zeros) ──

// HISTORIC: netgrid-side tracking was retired 2026-09-08 (T02). link_events
// stopped growing from that date; the numbers below are accurate up to it and
// are served for the historical record. Current traffic is measured by UTM
// attribution (utm_campaign=netgrid_content) in the client's own analytics.
// Any consumer must present these as historic (see docs/marketing-api.md).

/** Views + CTA clicks grouped by clientId, across all clients. */
async function trafficByClient(since?: Date): Promise<Map<string, Traffic>> {
  const map = new Map<string, Traffic>();
  try {
    const rows = await db
      .select({
        clientId: linkEvents.clientId,
        type: linkEvents.type,
        c: count(),
      })
      .from(linkEvents)
      .where(since ? gte(linkEvents.createdAt, since) : undefined)
      .groupBy(linkEvents.clientId, linkEvents.type);
    for (const r of rows) {
      if (!r.clientId) continue;
      const t = map.get(r.clientId) ?? { views: 0, clicks: 0 };
      if (r.type === "view") t.views = Number(r.c);
      else if (r.type === "cta_click") t.clicks = Number(r.c);
      map.set(r.clientId, t);
    }
  } catch {
    /* table missing / transient — leave empty */
  }
  return map;
}

/** Views + CTA clicks grouped by blogId, for one client. */
async function trafficByBlog(
  clientId: string,
  since?: Date,
): Promise<Map<string, Traffic>> {
  const map = new Map<string, Traffic>();
  try {
    const rows = await db
      .select({
        blogId: linkEvents.blogId,
        type: linkEvents.type,
        c: count(),
      })
      .from(linkEvents)
      .where(
        since
          ? and(
              eq(linkEvents.clientId, clientId),
              gte(linkEvents.createdAt, since),
            )
          : eq(linkEvents.clientId, clientId),
      )
      .groupBy(linkEvents.blogId, linkEvents.type);
    for (const r of rows) {
      if (!r.blogId) continue;
      const t = map.get(r.blogId) ?? { views: 0, clicks: 0 };
      if (r.type === "view") t.views = Number(r.c);
      else if (r.type === "cta_click") t.clicks = Number(r.c);
      map.set(r.blogId, t);
    }
  } catch {
    /* leave empty */
  }
  return map;
}

/** Published-post count grouped by clientId. */
async function publishedByClient(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const rows = await db
      .select({ clientId: generatedPosts.clientId, c: count() })
      .from(generatedPosts)
      .where(eq(generatedPosts.status, "published"))
      .groupBy(generatedPosts.clientId);
    for (const r of rows) {
      if (r.clientId) map.set(r.clientId, Number(r.c));
    }
  } catch {
    /* leave empty */
  }
  return map;
}

/** Published-post count grouped by blogId, for one client. */
async function publishedByBlog(clientId: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const rows = await db
      .select({ blogId: generatedPosts.blogId, c: count() })
      .from(generatedPosts)
      .where(
        and(
          eq(generatedPosts.clientId, clientId),
          eq(generatedPosts.status, "published"),
        ),
      )
      .groupBy(generatedPosts.blogId);
    for (const r of rows) {
      if (r.blogId) map.set(r.blogId, Number(r.c));
    }
  } catch {
    /* leave empty */
  }
  return map;
}

export interface PublicSiteMetrics {
  source: string | null;
  domainAuthority: number | null;
  backlinks: number | null;
  referringDomains: number | null;
  organicKeywords: number | null;
  organicTrafficEst: number | null;
  topKeywords: unknown | null;
  fetchedAt: string | null;
}

/**
 * Latest third-party SEO snapshot (Ahrefs/Semrush) per blog, for one client.
 * Rows are ordered newest-first and reduced to the first (latest) per blogId.
 */
async function thirdPartyByBlog(
  clientId: string,
): Promise<Map<string, PublicSiteMetrics>> {
  const map = new Map<string, PublicSiteMetrics>();
  try {
    const rows = await db
      .select({
        blogId: seoThirdPartyData.blogId,
        source: seoThirdPartyData.source,
        domainAuthority: seoThirdPartyData.domainAuthority,
        backlinks: seoThirdPartyData.backlinksTotal,
        referringDomains: seoThirdPartyData.referringDomains,
        organicKeywords: seoThirdPartyData.organicKeywords,
        organicTrafficEst: seoThirdPartyData.organicTrafficEst,
        topKeywords: seoThirdPartyData.topKeywords,
        fetchedAt: seoThirdPartyData.fetchedAt,
      })
      .from(seoThirdPartyData)
      .where(eq(seoThirdPartyData.clientId, clientId))
      .orderBy(desc(seoThirdPartyData.fetchedAt));
    for (const r of rows) {
      if (!r.blogId || map.has(r.blogId)) continue; // keep the latest only
      map.set(r.blogId, {
        source: r.source ?? null,
        domainAuthority: r.domainAuthority ?? null,
        backlinks: r.backlinks ?? null,
        referringDomains: r.referringDomains ?? null,
        organicKeywords: r.organicKeywords ?? null,
        organicTrafficEst: r.organicTrafficEst ?? null,
        topKeywords: r.topKeywords ?? null,
        fetchedAt: iso(r.fetchedAt),
      });
    }
  } catch {
    /* leave empty */
  }
  return map;
}

/** Count of posts published in the last 30 days for one client. */
async function publishedLast30(clientId: string): Promise<number> {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [row] = await db
      .select({ c: count() })
      .from(generatedPosts)
      .where(
        and(
          eq(generatedPosts.clientId, clientId),
          eq(generatedPosts.status, "published"),
          gte(generatedPosts.publishedAt, since),
        ),
      );
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

// ─── Public shapes ───────────────────────────────────────────────────────────

export interface PublicClientSummary {
  id: string;
  name: string;
  niche: string | null;
  status: string | null;
  blogCount: number;
  avgSeoScore: number | null;
  lastPostAt: string | null;
  /** Published posts across the client's sites. */
  postCount: number;
  /** Tracked page views across the client's sites. */
  views: number;
  /** Tracked CTA clicks across the client's sites. */
  clicks: number;
}

export interface PublicSite {
  id: string;
  domain: string;
  platform: string | null;
  status: string | null;
  seoScore: number | null;
  lastPostAt: string | null;
  lastPostTitle: string | null;
  lastScanAt: string | null;
  postCount: number;
  views: number;
  clicks: number;
  /** Latest third-party SEO snapshot (Ahrefs/Semrush), or null if none. */
  metrics: PublicSiteMetrics | null;
}

export interface PublicClientDetail extends PublicClientSummary {
  contactEmail: string | null;
  activeBlogCount: number;
  /** Posts published in the last 30 days. */
  postsLast30Days: number;
  sites: PublicSite[];
}

/**
 * List clients with rolled-up site count, average SEO score, last-post
 * timestamp, published-post count, and tracked views/clicks. Optional
 * case-insensitive email match and status filter.
 */
export async function listPublicClients(opts?: {
  email?: string;
  status?: string;
  /** Only count views/clicks recorded at or after this instant. */
  since?: Date;
}): Promise<PublicClientSummary[]> {
  const conds = [];
  if (opts?.email) conds.push(ilike(clients.contactEmail, opts.email));
  if (opts?.status) conds.push(eq(clients.status, opts.status as ClientStatus));

  const [rows, traffic, posts] = await Promise.all([
    db
      .select({
        id: clients.id,
        name: clients.name,
        niche: clients.niche,
        status: clients.status,
        blogCount: count(blogs.id),
        avgSeoScore: avg(blogs.currentSeoScore),
        lastPostAt: max(blogs.lastPostVerifiedAt),
      })
      .from(clients)
      .leftJoin(blogs, eq(blogs.clientId, clients.id))
      .where(conds.length ? and(...conds) : undefined)
      .groupBy(clients.id)
      .orderBy(desc(clients.createdAt)),
    trafficByClient(opts?.since),
    publishedByClient(),
  ]);

  return rows.map((r) => {
    const t = traffic.get(r.id) ?? { views: 0, clicks: 0 };
    return {
      id: r.id,
      name: r.name,
      niche: r.niche,
      status: r.status,
      blogCount: Number(r.blogCount ?? 0),
      avgSeoScore:
        r.avgSeoScore != null ? Math.round(Number(r.avgSeoScore)) : null,
      lastPostAt: iso(r.lastPostAt),
      postCount: posts.get(r.id) ?? 0,
      views: t.views,
      clicks: t.clicks,
    };
  });
}

/**
 * A single client with its sites (blogs), per-site SEO scores, published-post
 * counts, and tracked views/clicks. Returns null when the id doesn't exist.
 */
export async function getPublicClient(
  clientId: string,
  since?: Date,
): Promise<PublicClientDetail | null> {
  const [c] = await db
    .select({
      id: clients.id,
      name: clients.name,
      niche: clients.niche,
      status: clients.status,
      contactEmail: clients.contactEmail,
    })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!c) return null;

  const [siteRows, blogTraffic, blogPosts, postsLast30Days, blogMetrics] =
    await Promise.all([
      db
        .select({
          id: blogs.id,
          domain: blogs.domain,
          platform: blogs.platform,
          status: blogs.status,
          seoScore: blogs.currentSeoScore,
          lastPostAt: blogs.lastPostVerifiedAt,
          lastPostTitle: blogs.lastPostTitle,
          lastScanAt: blogs.lastSeoScanAt,
        })
        .from(blogs)
        .where(eq(blogs.clientId, clientId))
        .orderBy(desc(blogs.currentSeoScore)),
      trafficByBlog(clientId, since),
      publishedByBlog(clientId),
      publishedLast30(clientId),
      thirdPartyByBlog(clientId),
    ]);

  const sites: PublicSite[] = siteRows.map((s) => {
    const t = blogTraffic.get(s.id) ?? { views: 0, clicks: 0 };
    return {
      id: s.id,
      domain: s.domain,
      platform: s.platform,
      status: s.status,
      seoScore: s.seoScore ?? null,
      lastPostAt: iso(s.lastPostAt),
      lastPostTitle: s.lastPostTitle,
      lastScanAt: iso(s.lastScanAt),
      postCount: blogPosts.get(s.id) ?? 0,
      views: t.views,
      clicks: t.clicks,
      metrics: blogMetrics.get(s.id) ?? null,
    };
  });

  const scored = sites.filter((s) => s.seoScore != null);
  const avgSeoScore = scored.length
    ? Math.round(
        scored.reduce((sum, s) => sum + (s.seoScore as number), 0) /
          scored.length,
      )
    : null;
  const lastPostAt =
    sites
      .map((s) => s.lastPostAt)
      .filter((d): d is string => Boolean(d))
      .sort()
      .at(-1) ?? null;

  const views = sites.reduce((sum, s) => sum + s.views, 0);
  const clicks = sites.reduce((sum, s) => sum + s.clicks, 0);
  const postCount = sites.reduce((sum, s) => sum + s.postCount, 0);

  return {
    id: c.id,
    name: c.name,
    niche: c.niche,
    status: c.status,
    contactEmail: c.contactEmail,
    blogCount: sites.length,
    activeBlogCount: sites.filter((s) => s.status === "active").length,
    avgSeoScore,
    lastPostAt,
    postCount,
    postsLast30Days,
    views,
    clicks,
    sites,
  };
}

// ─── Published posts ─────────────────────────────────────────────────────────

export interface PublicPost {
  id: string;
  blogId: string;
  title: string | null;
  topic: string;
  excerpt: string | null;
  keywords: unknown | null;
  /** Live URL on the client's site, when the platform returned one. */
  url: string | null;
  publishedAt: string | null;
  wordCount: number | null;
  seoScore: number | null;
  readabilityScore: number | null;
  views: number;
  clicks: number;
}

export interface PublicPostsPage {
  clientId: string;
  total: number;
  limit: number;
  offset: number;
  posts: PublicPost[];
}

/** Per-post views/clicks for a set of post ids. */
async function trafficForPosts(
  postIds: string[],
): Promise<Map<string, Traffic>> {
  const map = new Map<string, Traffic>();
  if (postIds.length === 0) return map;
  try {
    const rows = await db
      .select({ postId: linkEvents.postId, type: linkEvents.type, c: count() })
      .from(linkEvents)
      .where(inArray(linkEvents.postId, postIds))
      .groupBy(linkEvents.postId, linkEvents.type);
    for (const r of rows) {
      if (!r.postId) continue;
      const t = map.get(r.postId) ?? { views: 0, clicks: 0 };
      if (r.type === "view") t.views = Number(r.c);
      else if (r.type === "cta_click") t.clicks = Number(r.c);
      map.set(r.postId, t);
    }
  } catch {
    /* leave empty */
  }
  return map;
}

/**
 * Published posts for one client (optionally one site), newest first, with a
 * live URL and per-post traffic. Paginated: limit is clamped 1–100.
 */
export async function listClientPosts(
  clientId: string,
  opts?: { blogId?: string; limit?: number; offset?: number },
): Promise<PublicPostsPage> {
  const limit = Math.min(100, Math.max(1, opts?.limit ?? 20));
  const offset = Math.max(0, opts?.offset ?? 0);

  const conds = [
    eq(generatedPosts.clientId, clientId),
    eq(generatedPosts.status, "published"),
  ];
  if (opts?.blogId) conds.push(eq(generatedPosts.blogId, opts.blogId));
  const where = and(...conds);

  const [countRow] = await db
    .select({ c: count() })
    .from(generatedPosts)
    .where(where);
  const total = Number(countRow?.c ?? 0);

  const rows = await db
    .select({
      id: generatedPosts.id,
      blogId: generatedPosts.blogId,
      title: generatedPosts.title,
      topic: generatedPosts.topic,
      excerpt: generatedPosts.excerpt,
      keywords: generatedPosts.keywords,
      url: generatedPosts.externalPostUrl,
      publishedAt: generatedPosts.publishedAt,
      wordCount: generatedPosts.wordCount,
      seoScore: generatedPosts.seoScore,
      readabilityScore: generatedPosts.readabilityScore,
    })
    .from(generatedPosts)
    .where(where)
    .orderBy(desc(generatedPosts.publishedAt))
    .limit(limit)
    .offset(offset);

  const traffic = await trafficForPosts(rows.map((r) => r.id));

  const posts: PublicPost[] = rows.map((r) => {
    const t = traffic.get(r.id) ?? { views: 0, clicks: 0 };
    return {
      id: r.id,
      blogId: r.blogId,
      title: r.title,
      topic: r.topic,
      excerpt: r.excerpt,
      keywords: r.keywords ?? null,
      url: r.url,
      publishedAt: iso(r.publishedAt),
      wordCount: r.wordCount ?? null,
      seoScore: r.seoScore ?? null,
      readabilityScore: r.readabilityScore ?? null,
      views: t.views,
      clicks: t.clicks,
    };
  });

  return { clientId, total, limit, offset, posts };
}

// ─── Traffic time series ─────────────────────────────────────────────────────

export type TrafficGranularity = "day" | "week";

export interface TrafficPoint {
  /** Bucket start, ISO 8601 (midnight UTC for day, week-start for week). */
  date: string;
  views: number;
  clicks: number;
}

/**
 * Views/clicks bucketed by day or week for one client (optionally one site).
 * Only buckets with activity are returned, oldest first. Fail-safe to [].
 */
export async function clientTrafficSeries(
  clientId: string,
  opts?: { granularity?: TrafficGranularity; since?: Date; blogId?: string },
): Promise<TrafficPoint[]> {
  const granularity: TrafficGranularity =
    opts?.granularity === "week" ? "week" : "day";
  try {
    const bucket = sql<string>`date_trunc(${granularity}, ${linkEvents.createdAt})`;
    const conds = [eq(linkEvents.clientId, clientId)];
    if (opts?.blogId) conds.push(eq(linkEvents.blogId, opts.blogId));
    if (opts?.since) conds.push(gte(linkEvents.createdAt, opts.since));

    const rows = await db
      .select({ bucket, type: linkEvents.type, c: count() })
      .from(linkEvents)
      .where(and(...conds))
      .groupBy(bucket, linkEvents.type)
      .orderBy(bucket);

    const map = new Map<string, TrafficPoint>();
    for (const r of rows) {
      const key = iso(r.bucket) ?? String(r.bucket);
      const p = map.get(key) ?? { date: key, views: 0, clicks: 0 };
      if (r.type === "view") p.views = Number(r.c);
      else if (r.type === "cta_click") p.clicks = Number(r.c);
      map.set(key, p);
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

// ─── SEO score history (score-over-time) ─────────────────────────────────────

/**
 * SEO history bucket size:
 *   "scan" — one point per individual scan (default; raw trend).
 *   "week" — one point per ISO week, the average overall score for that week.
 */
export type SeoHistoryGranularity = "scan" | "week";

export interface SeoHistoryPoint {
  /** Scan timestamp ("scan") or week-start ("week"), ISO 8601. */
  date: string;
  /** Overall SEO score, 0–100 — the per-scan value, or the week's average. */
  score: number;
}

export interface SeoHistorySite {
  blogId: string;
  domain: string;
  points: SeoHistoryPoint[];
}

export interface SeoHistory {
  clientId: string;
  sites: SeoHistorySite[];
}

/**
 * Per-site overall-SEO-score time series for one client, oldest point first.
 * With `granularity: "week"` each point is the average overall score for an ISO
 * week (`date_trunc('week', …)`); otherwise each point is a raw individual scan.
 * Optionally scoped to one site (`blogId`) and/or a time window (`since`).
 * Sites with no scans in range are omitted. Fail-safe to no sites.
 */
export async function clientSeoHistory(
  clientId: string,
  opts?: { blogId?: string; since?: Date; granularity?: SeoHistoryGranularity },
): Promise<SeoHistory> {
  const granularity: SeoHistoryGranularity =
    opts?.granularity === "week" ? "week" : "scan";
  try {
    const conds = [eq(seoScans.clientId, clientId)];
    if (opts?.blogId) conds.push(eq(seoScans.blogId, opts.blogId));
    if (opts?.since) conds.push(gte(seoScans.scannedAt, opts.since));

    if (granularity === "week") {
      // One point per ISO week per site = the week's average overall score.
      const bucket = sql<string>`date_trunc('week', ${seoScans.scannedAt})`;
      const rows = await db
        .select({
          blogId: seoScans.blogId,
          domain: blogs.domain,
          avgScore: avg(seoScans.overallScore),
          bucket,
        })
        .from(seoScans)
        .innerJoin(blogs, eq(seoScans.blogId, blogs.id))
        .where(and(...conds))
        .groupBy(seoScans.blogId, blogs.domain, bucket)
        .orderBy(bucket);

      const bySite = new Map<string, SeoHistorySite>();
      for (const r of rows) {
        const d = iso(r.bucket);
        if (!d || r.avgScore == null) continue;
        let site = bySite.get(r.blogId);
        if (!site) {
          site = { blogId: r.blogId, domain: r.domain, points: [] };
          bySite.set(r.blogId, site);
        }
        site.points.push({ date: d, score: Math.round(Number(r.avgScore)) });
      }
      return { clientId, sites: Array.from(bySite.values()) };
    }

    // Default: raw per-scan points.
    const rows = await db
      .select({
        blogId: seoScans.blogId,
        domain: blogs.domain,
        score: seoScans.overallScore,
        scannedAt: seoScans.scannedAt,
      })
      .from(seoScans)
      .innerJoin(blogs, eq(seoScans.blogId, blogs.id))
      .where(and(...conds))
      .orderBy(seoScans.scannedAt);

    const bySite = new Map<string, SeoHistorySite>();
    for (const r of rows) {
      const d = iso(r.scannedAt);
      if (!d) continue;
      let site = bySite.get(r.blogId);
      if (!site) {
        site = { blogId: r.blogId, domain: r.domain, points: [] };
        bySite.set(r.blogId, site);
      }
      site.points.push({ date: d, score: Number(r.score) });
    }
    return { clientId, sites: Array.from(bySite.values()) };
  } catch {
    return { clientId, sites: [] };
  }
}

// ─── Network rollup ──────────────────────────────────────────────────────────

export interface NetworkSummary {
  clients: number;
  sites: number;
  publishedPosts: number;
  views: number;
  clicks: number;
  avgSeoScore: number | null;
}

/** Network-wide totals for a dashboard overview widget. */
export async function getNetworkSummary(): Promise<NetworkSummary> {
  const [clientCount, siteAgg, postCount, trafficRows] = await Promise.all([
    db.select({ c: count() }).from(clients),
    db
      .select({ c: count(), avgSeo: avg(blogs.currentSeoScore) })
      .from(blogs),
    db
      .select({ c: count() })
      .from(generatedPosts)
      .where(eq(generatedPosts.status, "published"))
      .catch(() => [{ c: 0 }]),
    db
      .select({ type: linkEvents.type, c: count() })
      .from(linkEvents)
      .groupBy(linkEvents.type)
      .catch(() => [] as { type: string; c: number }[]),
  ]);

  let views = 0;
  let clicks = 0;
  for (const r of trafficRows) {
    if (r.type === "view") views = Number(r.c);
    else if (r.type === "cta_click") clicks = Number(r.c);
  }

  const avgSeoRaw = siteAgg[0]?.avgSeo;
  return {
    clients: Number(clientCount[0]?.c ?? 0),
    sites: Number(siteAgg[0]?.c ?? 0),
    publishedPosts: Number(postCount[0]?.c ?? 0),
    views,
    clicks,
    avgSeoScore: avgSeoRaw != null ? Math.round(Number(avgSeoRaw)) : null,
  };
}
