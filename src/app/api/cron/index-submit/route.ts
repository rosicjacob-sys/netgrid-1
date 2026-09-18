import { NextResponse } from "next/server";
import { and, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { verifyCronSecret } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { blogs } from "@/lib/db/schema";
import { ensureSitemapSubmitted } from "@/lib/services/indexing-onboarding";
import {
  ensureIndexNowKeyDeployed,
  _clearIndexNowDeployCache,
} from "@/lib/services/index-now-deployer";

// Each blog costs a robots.txt fetch, a sitemap fetch and two Google calls,
// plus (WordPress) a REST call and a key-file fetch. The limit keeps a run
// inside this budget; the backlog drains over successive days.
export const maxDuration = 600;

const SITEMAP_STALE_DAYS = 30;
const KEYFILE_STALE_DAYS = 7;

/**
 * Daily indexing sweep (T15).
 *
 *  1. Submit sitemaps for blogs that have never had one submitted, or whose
 *     submission is older than 30 days.
 *  2. Re-verify IndexNow key files that have never been verified or whose
 *     verification is older than 7 days — this is what catches a site whose
 *     MU-plugin was removed, whose domain moved, or whose host started serving
 *     *.txt from disk.
 *
 * This sweep, not the fire-and-forget hook in createBlog, is the durable path:
 * a floating promise in a server action can be cut short when the request ends.
 *
 * GET /api/cron/index-submit?limit=25
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") ?? "25", 10) || 25, 1),
    200,
  );

  try {
    // ── 1. Sitemaps ────────────────────────────────────────────────
    const sitemapDue = await db
      .select({ id: blogs.id, domain: blogs.domain })
      .from(blogs)
      .where(
        and(
          ne(blogs.status, "decommissioned"),
          or(
            isNull(blogs.sitemapSubmittedAt),
            lt(
              blogs.sitemapSubmittedAt,
              sql`now() - make_interval(days => ${SITEMAP_STALE_DAYS}::int)`,
            ),
          ),
        ),
      )
      .limit(limit);

    const sitemapResults: Array<{ domain: string; ok: boolean; message: string }> = [];
    for (const b of sitemapDue) {
      const r = await ensureSitemapSubmitted(b.id, { force: true });
      sitemapResults.push({ domain: b.domain, ok: r.ok, message: r.message });
    }

    // ── 2. Key files (WordPress only) ──────────────────────────────
    // Drop the in-process cache first so this is a genuine re-check rather
    // than a replay of whatever the last publish cached.
    _clearIndexNowDeployCache();

    const keyDue = await db
      .select()
      .from(blogs)
      .where(
        and(
          eq(blogs.platform, "wordpress"),
          ne(blogs.status, "decommissioned"),
          or(
            isNull(blogs.indexnowKeyVerifiedAt),
            lt(
              blogs.indexnowKeyVerifiedAt,
              sql`now() - make_interval(days => ${KEYFILE_STALE_DAYS}::int)`,
            ),
          ),
        ),
      )
      .limit(limit);

    const keyResults: Array<{ domain: string; keyLocation: string | null }> = [];
    for (const b of keyDue) {
      const deployed = await ensureIndexNowKeyDeployed(b);
      keyResults.push({ domain: b.domain, keyLocation: deployed?.keyLocation ?? null });
    }

    return NextResponse.json({
      sitemaps: {
        considered: sitemapDue.length,
        submitted: sitemapResults.filter((r) => r.ok).length,
        results: sitemapResults,
      },
      keyFiles: {
        considered: keyDue.length,
        verified: keyResults.filter((r) => r.keyLocation !== null).length,
        results: keyResults,
      },
    });
  } catch (error) {
    console.error("index-submit cron error:", error);
    const message =
      error instanceof Error ? error.message : "Index submission sweep failed";
    return NextResponse.json({ error: message, job: "index-submit" }, { status: 500 });
  }
}
