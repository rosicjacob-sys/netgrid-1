import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/helpers";
import { refreshAllClientKeywordsInternal } from "@/lib/actions/keyword-actions";
import {
  rebuildAllKeywordTargetsInternal,
  reapStuckKeywordTargets,
} from "@/lib/actions/keyword-target-actions";
import { parseShardParams } from "@/lib/cron/sharding";

// This route is deployed as FOUR parallel hourly cron services, sharded by a
// stable hash of the client/blog UUID exactly like auto-publish
// (render.yaml). Each run is bounded by KEYWORD_REFRESH_MAX_CLIENTS and
// KEYWORD_REFRESH_TIME_BUDGET_MS, so it returns in a few minutes regardless of
// network size. The old version scraped EVERY client in one unordered pass —
// ~5 hours at 1,500 clients — so it never returned, and because curl treats a
// timeout as transient it was re-fired up to four times per schedule, each
// starting a fresh full-network scrape while the previous ones were still
// running.
//
// NOTE on maxDuration: this is a Next.js route-segment hint honoured by
// serverless platforms. On Render the app runs `next start` and nothing
// enforces it — the real ceiling is cron/invoke.sh's
// `curl --max-time "$CRON_MAX_TIME"`. It is set to 600 to document intent and
// to stay correct if this ever moves to a serverless host. The work budgets
// are what actually keep the run short.
export const maxDuration = 600;

/** A finite integer query param, or undefined. */
function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * GET /api/cron/refresh-keywords?shard=0&shardCount=4[&limit=25]
 *
 * Three phases, each independently fail-safe:
 *   1. reap   — return ledger rows stranded in 'generating' to the pool.
 *               Cheap (two UPDATEs) and runs first so the rebuild sees them.
 *   2. scrape — one shard's worth of stale, seeded clients.
 *   3. rebuild— ledgers for the clients phase 2 actually refreshed, plus any
 *               active city blog that has never been built at all.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Strict shard validation, same as the auto-publish and post-verification
  // routes: a malformed shardCount collapses the filter so this one service
  // scrapes the WHOLE network, which is the unbounded run this task removes.
  const url = new URL(request.url);
  const shards = parseShardParams(url);
  if (!shards.ok) {
    return NextResponse.json(
      {
        error: shards.message,
        hint: "CRON_PATH must look like /api/cron/refresh-keywords?shard=0&shardCount=4",
        received: url.search || "(no query string)",
        job: "refresh-keywords",
      },
      { status: 400 },
    );
  }
  const { shardIndex, shardCount } = shards;
  const maxClients = intParam(url, "limit");

  try {
    // Phase 1. Never throws (see reapStuckKeywordTargets).
    const reaped = await reapStuckKeywordTargets();

    // Phase 2.
    const summary = await refreshAllClientKeywordsInternal({
      shardIndex,
      shardCount,
      maxClients,
    });

    // Phase 3. Kept in its own try/catch — a target-rebuild failure must not
    // mask the scrape summary above, which already succeeded.
    let targets: Awaited<ReturnType<typeof rebuildAllKeywordTargetsInternal>> | null = null;
    let targetsError: string | null = null;
    try {
      targets = await rebuildAllKeywordTargetsInternal({
        clientIds: summary.clientIdsScraped,
        includeUnbuilt: true,
        shardIndex,
        shardCount,
      });
    } catch (error) {
      console.error("Refresh-keywords cron — target rebuild error:", error);
      targetsError = error instanceof Error ? error.message : "Target rebuild failed";
    }

    // clientIdsScraped can hold hundreds of UUIDs and is only useful inside
    // this handler — keep it out of the response body.
    const { clientIdsScraped, ...publicSummary } = summary;
    void clientIdsScraped;

    if (publicSummary.clientsBlocked > 0) {
      console.error(
        `[refresh-keywords] ALERT shard ${publicSummary.shardIndex}/${publicSummary.shardCount} — ` +
          `${publicSummary.clientsBlocked} of ${publicSummary.clientsProcessed} client scrapes were BLOCKED ` +
          `(${publicSummary.queriesFailed}/${publicSummary.queriesAttempted} queries failed)`,
      );
    }

    return NextResponse.json({ reaped, ...publicSummary, targets, targetsError });
  } catch (error) {
    console.error("Refresh-keywords cron error:", error);
    const message =
      error instanceof Error ? error.message : "Refresh-keywords cron failed";
    return NextResponse.json({ error: message, job: "refresh-keywords" }, { status: 500 });
  }
}
