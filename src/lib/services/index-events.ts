/**
 * Append-only recorder for index_ping_events.
 *
 * Every attempt to notify a search engine — IndexNow ping, key-file
 * deploy/verify, Search Console sitemap submit — writes one row. This
 * replaces console.warn as the failure channel: warns in a Render container
 * are not queryable, not countable, and not alertable, which is why a
 * subsystem that never worked looked identical to one that did.
 *
 * Fire-and-forget: a failure to record must never fail the caller.
 */

import { db } from "@/lib/db";
import { indexPingEvents } from "@/lib/db/schema";

export type IndexChannel = "indexnow" | "indexnow_deploy" | "gsc_sitemap";
export type IndexOutcome = "ok" | "failed" | "skipped";

export interface IndexEventInput {
  blogId: string;
  postId?: string | null;
  channel: IndexChannel;
  outcome: IndexOutcome;
  targetUrl?: string | null;
  keyLocation?: string | null;
  httpStatus?: number | null;
  error?: string | null;
}

export async function recordIndexEvent(input: IndexEventInput): Promise<void> {
  try {
    await db.insert(indexPingEvents).values({
      blogId: input.blogId,
      postId: input.postId ?? null,
      channel: input.channel,
      outcome: input.outcome,
      targetUrl: input.targetUrl?.slice(0, 1000) ?? null,
      keyLocation: input.keyLocation?.slice(0, 1000) ?? null,
      httpStatus: input.httpStatus ?? null,
      error: input.error?.slice(0, 2000) ?? null,
    });
  } catch (err) {
    // Same contract as logActivity: log, never throw.
    console.error("[index-events] failed to record event:", err);
  }
}
