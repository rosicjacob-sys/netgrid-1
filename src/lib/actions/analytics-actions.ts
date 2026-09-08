"use server";

import { db } from "@/lib/db";
import { linkEvents } from "@/lib/db/schema";
import { count, eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/helpers";

/**
 * HISTORIC TRAFFIC TOTALS — netgrid-side tracking was retired 2026-09-08 (T02).
 *
 * These functions aggregate link_events, which stopped growing when the
 * per-post pixel and the tracked redirect were removed from published posts.
 * Counts up to that date remain accurate for the historical record; new
 * traffic is measured by UTM attribution (utm_campaign=netgrid_content) in
 * each client's own GA4 / Shopify analytics. Present any UI built on these
 * numbers as historical, so a flat line is not read as a traffic collapse.
 */

export interface TrafficTotals {
  views: number;
  clicks: number;
}

function tally(rows: { type: string; c: number }[]): TrafficTotals {
  let views = 0;
  let clicks = 0;
  for (const r of rows) {
    if (r.type === "view") views = Number(r.c);
    else if (r.type === "cta_click") clicks = Number(r.c);
  }
  return { views, clicks };
}

/** Page-view + CTA-click totals for one blog. Fail-safe to zeros. */
export async function getBlogTrafficTotals(
  blogId: string,
): Promise<TrafficTotals> {
  await requireAdmin();
  try {
    const rows = await db
      .select({ type: linkEvents.type, c: count() })
      .from(linkEvents)
      .where(eq(linkEvents.blogId, blogId))
      .groupBy(linkEvents.type);
    return tally(rows);
  } catch {
    return { views: 0, clicks: 0 };
  }
}

/** Page-view + CTA-click totals for one client (across all its blogs). */
export async function getClientTrafficTotals(
  clientId: string,
): Promise<TrafficTotals> {
  await requireAdmin();
  try {
    const rows = await db
      .select({ type: linkEvents.type, c: count() })
      .from(linkEvents)
      .where(eq(linkEvents.clientId, clientId))
      .groupBy(linkEvents.type);
    return tally(rows);
  } catch {
    return { views: 0, clicks: 0 };
  }
}

/**
 * Per-post traffic for one blog, keyed by generated-post id. Fail-safe to an
 * empty map (e.g. when link_events isn't migrated yet).
 */
export async function getBlogPostTraffic(
  blogId: string,
): Promise<Record<string, TrafficTotals>> {
  await requireAdmin();
  const out: Record<string, TrafficTotals> = {};
  try {
    const rows = await db
      .select({ postId: linkEvents.postId, type: linkEvents.type, c: count() })
      .from(linkEvents)
      .where(eq(linkEvents.blogId, blogId))
      .groupBy(linkEvents.postId, linkEvents.type);
    for (const r of rows) {
      if (!r.postId) continue;
      const t = out[r.postId] ?? { views: 0, clicks: 0 };
      if (r.type === "view") t.views = Number(r.c);
      else if (r.type === "cta_click") t.clicks = Number(r.c);
      out[r.postId] = t;
    }
  } catch {
    /* leave empty */
  }
  return out;
}
