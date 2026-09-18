import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/helpers";
import { runPostVerificationSweep } from "@/lib/cron/post-verification";
import { parseShardParams } from "@/lib/cron/sharding";

/**
 * BUDGET ARITHMETIC — do not change one of these numbers without the others.
 *
 * Per-blog cost is one live HTTPS request (WordPress: wp-client.ts, 10s axios
 * timeout) or two (Shopify: listBlogs + articles, 15s timeout each). Writes
 * are batched, so DB cost is ~2 round trips per RUN, not per blog.
 *
 * Wall clock ~= (activeBlogs / shardCount) * meanLatency / concurrency
 *
 *   1,500 blogs, 4 shards, concurrency 6  => 375 blogs per shard:
 *     mean 0.9s  ->  375 * 0.9 / 6 =  56s   (typical)
 *     mean 3.0s  ->  375 * 3.0 / 6 = 188s   (pessimistic: slow Shopify)
 *     mean 10s   ->  375 * 10  / 6 = 625s   (total outage of every host)
 *
 * The 625s case is why the sweep carries its own wall-clock budget rather
 * than relying on the platform timeout: POST_VERIFICATION_BUDGET_MS (default
 * 240,000) stops it dispatching new work at 240s, it reports partial
 * coverage, the coverage alert fires, and the blogs it could not reach sort
 * to the front of the next run.
 *
 * The chain of inequalities that must hold:
 *
 *   budgetMs (240s)
 *     + longest single in-flight request (15s, Shopify)
 *     + batched writes, prune, activity_log, alert email (~5s)
 *   = ~260s
 *     <  maxDuration      300s   (this file — enforced on Vercel-style hosts)
 *     <  CRON_MAX_TIME    330s   (render.yaml, passed to curl --max-time)
 *
 * That last inequality is the important one on Render. cron/invoke.sh runs
 * `curl -fsS --retry N --max-time "$MAX_TIME"`, and curl treats a timeout as
 * a TRANSIENT error, so exceeding --max-time does not merely fail the run —
 * it retries it, producing overlapping sweeps. Keeping the server-side budget
 * strictly below CRON_MAX_TIME is what prevents that.
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Sharding via query string. Render cron services and the web service are
  // separate services with separate env var sets — env vars set on a cron
  // service do NOT reach this handler. So each cron service encodes its
  // shard in CRON_PATH:
  //   /api/cron/post-verification?shard=0&shardCount=4
  //
  // Malformed values are REJECTED, not defaulted: a bad shardCount collapses
  // the shard filter so this one service would sweep the whole network, which
  // is the unsharded 1,500-blog run that blows through curl's --max-time and
  // gets retried. See parseShardParams.
  const url = new URL(request.url);
  const shards = parseShardParams(url);
  if (!shards.ok) {
    return NextResponse.json(
      {
        error: shards.message,
        hint: "CRON_PATH must look like /api/cron/post-verification?shard=0&shardCount=4",
        received: url.search || "(no query string)",
        job: "post-verification",
      },
      { status: 400 },
    );
  }

  const limitParam = url.searchParams.get("limit");
  const concurrencyParam = url.searchParams.get("concurrency");
  const pruneParam = url.searchParams.get("prune");

  try {
    const result = await runPostVerificationSweep({
      shardIndex: shards.shardIndex,
      shardCount: shards.shardCount,
      // Out-of-range or non-numeric values fall back to the env default
      // rather than throwing — clampInt in the sweep rejects NaN. These are
      // operator conveniences, not the correctness-critical shard pair.
      limit: limitParam !== null ? Number(limitParam) : undefined,
      concurrency:
        concurrencyParam !== null ? Number(concurrencyParam) : undefined,
      // Default: prune on shard 0 only. ?prune=1 / ?prune=0 forces it.
      prune: pruneParam !== null ? pruneParam === "1" : undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Post verification cron error:", error);
    const message =
      error instanceof Error ? error.message : "Verification failed";
    return NextResponse.json(
      { error: "Verification failed", message, job: "post-verification" },
      { status: 500 },
    );
  }
}
