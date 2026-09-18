import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/helpers";
import { runAutoPublishCron } from "@/lib/actions/content-generation-actions";

// Generation + analysis + publish takes ~25-35s per blog. The per-run cap
// (MAX_BLOGS_PER_CRON_RUN) and the worker-pool width
// (AUTO_PUBLISH_CONCURRENCY) are sized so a full run finishes well inside
// this deadline. Anything beyond the cap is reported "deferred" and picked up
// on the next hourly tick.
//
// cron/invoke.sh must use a --max-time ABOVE this number, never below it:
// curl treats its own timeout as a transient error and re-invokes, while the
// handler it abandoned keeps running (T08).
export const maxDuration = 600;

/**
 * Parse a shard query param.
 *
 *   null      — the param was absent
 *   number    — a clean non-negative integer
 *   undefined — the param was present but malformed; the caller answers 400
 *
 * Deliberately stricter than Number(): "4.5", "1e3", " 4 " and "" are all
 * rejected. These values come from a query string baked into each cron
 * service's CRON_PATH env var, where a typo is silent and permanent, so the
 * only safe posture is to refuse anything that is not exactly an integer.
 */
function parseShardParam(raw: string | null): number | null | undefined {
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

export async function GET(request: Request) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Sharding via query string. Cron services and the web service are separate
  // Render services with separate env var sets — env vars set on a cron
  // service do NOT reach the web handler. So each cron service encodes its
  // shard in CRON_PATH:
  //   /api/cron/auto-publish?shard=0&shardCount=4
  //
  // These are validated HARD (T08). The previous version coerced with a bare
  // Number() and let runAutoPublishCron default anything malformed to shard 0
  // of 1. A one-character typo therefore had two silent double-publish modes:
  // a bad `shard` key duplicated the real shard-0 service (a quarter of the
  // network published twice hourly), and a bad `shardCount` collapsed the
  // shard filter entirely so this one service published the WHOLE network.
  // Neither surfaced in the response or the logs.
  //
  // A 400 is the right answer because curl's transient set is
  // "timeout / 408 / 429 / 5xx" — a 400 is NOT retried, so invoke.sh fails
  // the container immediately and Render shows the cron run red.
  const url = new URL(request.url);
  const shard = parseShardParam(url.searchParams.get("shard"));
  const shardCount = parseShardParam(url.searchParams.get("shardCount"));

  const reject = (message: string) =>
    NextResponse.json(
      {
        error: message,
        hint: "CRON_PATH must look like /api/cron/auto-publish?shard=0&shardCount=4",
        received: url.search || "(no query string)",
        job: "auto-publish",
      },
      { status: 400 },
    );

  if (shard === undefined) {
    return reject(
      `Invalid ?shard= — expected a non-negative integer, got "${url.searchParams.get("shard")}"`,
    );
  }
  if (shardCount === undefined) {
    return reject(
      `Invalid ?shardCount= — expected a non-negative integer, got "${url.searchParams.get("shardCount")}"`,
    );
  }
  if ((shard === null) !== (shardCount === null)) {
    return reject(
      "shard and shardCount must be supplied together " +
        `(shard=${shard === null ? "absent" : shard}, shardCount=${shardCount === null ? "absent" : shardCount})`,
    );
  }
  if (shardCount !== null && shardCount < 1) {
    return reject(`shardCount must be >= 1, got ${shardCount}`);
  }
  if (shard !== null && shardCount !== null && shard >= shardCount) {
    return reject(
      `shard must be in [0, ${shardCount - 1}] for shardCount=${shardCount}, got ${shard}`,
    );
  }

  // ?dry=1 builds the eligibility queue and returns it without generating
  // or publishing anything. Used to inspect cadence decisions on production
  // data. The Render cron services never pass it.
  const dryRun = url.searchParams.get("dry") === "1";

  try {
    const result = await runAutoPublishCron({
      shardIndex: shard ?? undefined,
      shardCount: shardCount ?? undefined,
      dryRun,
    });
    return NextResponse.json(result);
  } catch (error) {
    // runWithTelemetry already persisted a cron_runs row with ok=false and
    // a CRON_RUN_FATAL pipeline_errors row before re-throwing, so this is
    // purely the HTTP surface. Keep the console line for the live tail.
    console.error("[auto-publish] cron error:", error);
    const message = error instanceof Error ? error.message : "Auto-publish failed";
    return NextResponse.json(
      { error: message, job: "auto-publish" },
      { status: 500 },
    );
  }
}
