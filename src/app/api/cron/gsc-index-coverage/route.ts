import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/helpers";
import { runGscIndexCoverage } from "@/lib/services/gsc-index-coverage";

// One inspect call is ~1-2s. A 900-call shard at concurrency 4 lands around
// 300-450s. 600s covers the slow tail; the budget, not the clock, is the
// intended limiter.
export const maxDuration = 600;

/**
 * Search Console URL-inspection cron.
 *
 * GET /api/cron/gsc-index-coverage
 *
 * Query params (all optional, cron-secret protected):
 *   ?shard=N&shardCount=M  Shard assignment, same convention as every other cron.
 *   ?budget=N              Inspections this run. Default GSC_URL_INSPECT_DAILY_BUDGET
 *                          (900), hard-clamped to 5,000. The project-wide Google
 *                          quota is 10,000/DAY across ALL shards — if you raise
 *                          this, raise it on one shard and check the numbers
 *                          before raising it on the others.
 *   ?perSite=N             Max inspections one blog may consume this run.
 *                          Default GSC_URL_INSPECT_PER_SITE (4).
 *   ?concurrency=N         Parallel inspections. Default 4, clamped 1..8.
 */
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

  try {
    const summary = await runGscIndexCoverage({
      shardIndex: shardParam !== null ? Number(shardParam) : undefined,
      shardCount: shardCountParam !== null ? Number(shardCountParam) : undefined,
      budget: clampInt(
        url.searchParams.get("budget"),
        0,
        5000,
        Number(process.env.GSC_URL_INSPECT_DAILY_BUDGET ?? 900) || 900,
      ),
      perSite: clampInt(
        url.searchParams.get("perSite"),
        1,
        50,
        Number(process.env.GSC_URL_INSPECT_PER_SITE ?? 4) || 4,
      ),
      concurrency: clampInt(url.searchParams.get("concurrency"), 1, 8, 4),
    });
    return NextResponse.json(summary);
  } catch (error) {
    console.error("GSC index-coverage cron error:", error);
    const message =
      error instanceof Error ? error.message : "GSC index coverage failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
