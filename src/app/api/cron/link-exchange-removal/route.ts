import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/helpers";
import {
  restoreRemovedPost,
  runLinkExchangeRemoval,
  seedRemovalQueue,
} from "@/lib/services/link-exchange-removal";

// Every queued post costs a live fetch, and every post carrying a link costs a
// live write on top. Give the batch the same headroom as the other
// platform-touching jobs.
export const maxDuration = 600;

/**
 * T03 — strip retired link-exchange links out of live posts.
 *
 * Usage (all guarded by CRON_SECRET):
 *   /api/cron/link-exchange-removal                  → drain 50 posts
 *   /api/cron/link-exchange-removal?limit=200        → drain 200
 *   /api/cron/link-exchange-removal?blogId=<uuid>    → one blog only
 *   /api/cron/link-exchange-removal?dryRun=1         → preview, no writes
 *   /api/cron/link-exchange-removal?seed=1           → top up the queue first
 *   /api/cron/link-exchange-removal?restore=<postId> → undo one post
 *
 * This service is TEMPORARY. Delete it, its Render cron service, and the
 * link_exchange_removals table once the queue has drained and been signed off.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);

  const restore = url.searchParams.get("restore");
  if (restore) {
    try {
      return NextResponse.json(await restoreRemovedPost(restore));
    } catch (error) {
      console.error("Link-exchange restore error:", error);
      const message = error instanceof Error ? error.message : "Restore failed";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  const limitParam = url.searchParams.get("limit");
  const limit = limitParam !== null ? Number(limitParam) : undefined;
  const blogId = url.searchParams.get("blogId") ?? undefined;
  const dryRun =
    url.searchParams.get("dryRun") === "1" ||
    url.searchParams.get("dryRun") === "true";
  const seed =
    url.searchParams.get("seed") === "1" ||
    url.searchParams.get("seed") === "true";

  try {
    const seeded = seed ? await seedRemovalQueue({ blogId }) : undefined;
    const result = await runLinkExchangeRemoval({
      limit: Number.isFinite(limit) ? limit : undefined,
      blogId,
      dryRun,
    });
    return NextResponse.json(seeded ? { seeded, ...result } : result);
  } catch (error) {
    console.error("Link-exchange removal cron error:", error);
    const message =
      error instanceof Error ? error.message : "Link-exchange removal failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
