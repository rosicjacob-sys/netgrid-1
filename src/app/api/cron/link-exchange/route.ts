import { NextResponse } from "next/server";

/**
 * RETIRED (T03) — the link exchange is permanently shut down.
 *
 * This route deliberately imports nothing from
 * @/lib/services/link-exchange. A stale Render cron service, a forgotten
 * uptime check, or a hand-rolled curl cannot resume placements through it,
 * regardless of what the service module does.
 *
 * It answers 410 Gone (not 404) so a caller's logs say "this endpoint was
 * removed on purpose" rather than "someone broke the routing". It is
 * deliberately unauthenticated: nothing happens and nothing is disclosed, and
 * a 401 would hide the fact that a stale caller still exists.
 *
 * Links already placed on live posts are removed by
 * /api/cron/link-exchange-removal.
 */
export async function GET() {
  console.warn(
    "[link-exchange] retired endpoint /api/cron/link-exchange was called — " +
      "a stale cron service or external caller still exists; find and remove it",
  );

  return NextResponse.json(
    {
      error: "Gone",
      message:
        "The link exchange was retired (T03) and cannot be run. " +
        "Removal of already-placed links runs at /api/cron/link-exchange-removal.",
    },
    { status: 410 },
  );
}
