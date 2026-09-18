import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/helpers";
import { backfillYoastMeta } from "@/lib/actions/yoast-meta-backfill-actions";

// Each post costs at least one live page fetch plus a REST write, so give the
// run the same headroom as the SEO backfill route.
export const maxDuration = 600;

/**
 * Re-push and verify Yoast SEO meta on already-published WordPress posts (T14).
 *
 * Usage:
 *   /api/cron/yoast-meta-backfill?blogId=<uuid>&dryRun=1   => measure one blog
 *   /api/cron/yoast-meta-backfill?blogId=<uuid>            => repair one blog
 *   /api/cron/yoast-meta-backfill?blogLimit=25&limit=200   => sweep the network
 *   ...&includeVerified=1                                 => re-check everything
 *   ...&requireBridge=0                                   => include blogs with
 *                                                            no MU-plugin (only
 *                                                            sensible with
 *                                                            dryRun=1)
 *
 * Guarded by CRON_SECRET. Blog-scoped by default so it can be proven on one
 * blog before any network-wide run - same convention as /api/cron/seo-backfill.
 *
 * NOT on a schedule, deliberately. This is a one-shot repair driven by hand
 * after the MU-plugin rollout reaches a blog; there is no Render cron service
 * for it.
 */
export async function GET(request: Request) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const num = (key: string): number | undefined => {
    const raw = url.searchParams.get(key);
    if (raw === null) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const flag = (key: string): boolean =>
    url.searchParams.get(key) === "1" || url.searchParams.get(key) === "true";

  try {
    const result = await backfillYoastMeta({
      blogId: url.searchParams.get("blogId") ?? undefined,
      limit: num("limit"),
      blogLimit: num("blogLimit"),
      dryRun: flag("dryRun"),
      includeVerified: flag("includeVerified"),
      // Defaults to true in the action; only an explicit "0"/"false" turns it
      // off, so a missing param never widens the sweep.
      ...(url.searchParams.has("requireBridge")
        ? { requireBridge: flag("requireBridge") }
        : {}),
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Yoast meta backfill error:", error);
    const message = error instanceof Error ? error.message : "Backfill failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
