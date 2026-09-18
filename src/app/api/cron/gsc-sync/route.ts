import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/helpers";
import {
  findSuppressedBlogs,
  runGscSync,
  sendSuppressedBlogsAlert,
} from "@/lib/services/gsc-sync";
import { provisionPendingProperties } from "@/lib/services/gsc-verifier";

// A daily shard of ~375 blogs at concurrency 5 is one searchanalytics call and
// one small upsert each — roughly 200-300s. Backfill mode walks ~17 windows per
// blog, which is why its default batch is 25 rather than 500. 600s covers both
// with headroom for a slow tail.
export const maxDuration = 600;

/**
 * Google Search Console sync cron.
 *
 * GET /api/cron/gsc-sync
 *
 * Query params (all optional, cron-secret protected):
 *   ?shard=N&shardCount=M   Shard assignment. Same convention as auto-publish —
 *                           the cron SERVICE encodes it in CRON_PATH because
 *                           cron services and the web service have separate env
 *                           var sets.
 *   ?limit=N                Blogs per run. Default 500 daily / 25 backfill.
 *                           0 skips syncing entirely (used by the alert cron).
 *   ?days=N                 Trailing window for the daily pull. Default 5.
 *   ?backfill=1             Pull the historical window for blogs that have
 *                           never been backfilled, then stamp gsc_backfilled_at.
 *   ?months=N               Backfill length, clamped to Google's 16-month
 *                           retention ceiling. Default 16.
 *   ?blogId=<uuid>          Restrict to one blog. For debugging a single site.
 *   ?verify=1               Before syncing, attempt property provisioning for
 *                           blogs that are not verified yet. This is what picks
 *                           up CSV-imported blogs and WordPress blogs whose DNS
 *                           TXT record has since been published.
 *   ?verifyLimit=N          Blogs per provisioning pass. Default 50.
 *   ?alert=1                Run the suppressed-or-unindexed query and email it.
 *
 * Returns 200 with a zeroed summary (configured: false) when the service
 * account is not set, so an unconfigured environment does not fail the job.
 */

/** Same clamping semantics as the other cron routes, so every route parses
 * params identically. */
function clampInt(
  v: string | undefined | null,
  min: number,
  max: number,
  def: number,
): number {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return def;
  return Math.max(min, Math.min(max, n));
}

export async function GET(request: Request) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const shardParam = url.searchParams.get("shard");
  const shardCountParam = url.searchParams.get("shardCount");
  const backfill = url.searchParams.get("backfill") === "1";
  const verify = url.searchParams.get("verify") === "1";
  const alert = url.searchParams.get("alert") === "1";
  const blogId = url.searchParams.get("blogId") ?? undefined;

  const limit = clampInt(
    url.searchParams.get("limit"),
    0,
    2000,
    backfill ? 25 : 500,
  );
  const days = clampInt(url.searchParams.get("days"), 1, 90, 5);
  const months = clampInt(url.searchParams.get("months"), 1, 16, 16);

  try {
    // Provisioning first: a blog verified in this pass is eligible for the sync
    // in the same run, which makes onboarding one cron tick rather than two.
    // Explicitly initialised: TS narrows an unassigned `let` to
    // "used before being assigned" at the read sites below, which only run
    // when `verify` is set — the compiler cannot see that correspondence.
    let provisioned: Awaited<ReturnType<typeof provisionPendingProperties>> | undefined =
      undefined;
    if (verify) {
      provisioned = await provisionPendingProperties(
        clampInt(url.searchParams.get("verifyLimit"), 1, 200, 50),
      );
    }

    const summary = await runGscSync({
      shardIndex: shardParam !== null ? Number(shardParam) : undefined,
      shardCount: shardCountParam !== null ? Number(shardCountParam) : undefined,
      limit,
      days,
      backfill,
      months,
      blogId,
    });

    let suppressed;
    let alertSent;
    if (alert) {
      suppressed = await findSuppressedBlogs();
      alertSent = await sendSuppressedBlogsAlert(suppressed);
    }

    return NextResponse.json({
      ...summary,
      ...(verify
        ? {
            provisioned: {
              considered: provisioned?.length ?? 0,
              verified: provisioned?.filter((p) => p.status === "verified").length ?? 0,
              pendingDns: provisioned?.filter((p) => p.status === "pending_dns").length ?? 0,
              failed: provisioned?.filter((p) => p.status === "failed").length ?? 0,
              results: provisioned,
            },
          }
        : {}),
      ...(alert ? { suppressed, alertSent } : {}),
    });
  } catch (error) {
    console.error("GSC sync cron error:", error);
    const message = error instanceof Error ? error.message : "GSC sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
