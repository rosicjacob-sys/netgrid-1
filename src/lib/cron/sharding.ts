import crypto from "crypto";

/**
 * Stable shard assignment for a blog — same blog => same shard, forever.
 * Used to partition the active blog pool across parallel cron services.
 * Each service is configured with (shardIndex, shardCount) via query string
 * and only processes blogs where:
 *
 *   shardForBlog(blog.id, shardCount) === shardIndex
 *
 * Uses bytes 8-15 of the SHA1 hex (different than preferredHourForBlog in
 * content-generation-actions.ts, which uses bytes 0-7) so a blog's shard
 * assignment is independent of its hour assignment.
 *
 * Moved here from content-generation-actions.ts so the post-verification
 * cron can reuse it: that file is "use server", and a "use server" module
 * may only export async functions. The body is byte-identical to the
 * original, and cadence.test.ts pins golden values so a future edit cannot
 * silently redistribute the network across auto-publish shards.
 */
export function shardForBlog(blogId: string, shardCount: number): number {
  if (shardCount <= 1) return 0;
  const hex = crypto
    .createHash("sha1")
    .update(blogId)
    .digest("hex")
    .slice(8, 16);
  return parseInt(hex, 16) % shardCount;
}

/**
 * Parse one shard query param.
 *
 *   null      — the param was absent
 *   number    — a clean non-negative integer
 *   undefined — the param was present but malformed; the caller answers 400
 *
 * Deliberately stricter than Number(): "4.5", "1e3", " 4 " and "" are all
 * rejected. Identical in shape to the validator in
 * src/app/api/cron/auto-publish/route.ts, and strict for the same reason.
 */
export function parseShardParam(raw: string | null): number | null | undefined {
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

export type ShardParams =
  | { ok: true; shardIndex: number; shardCount: number }
  | { ok: false; message: string };

/**
 * Read ?shard= / ?shardCount= off a cron route's URL and REJECT anything
 * malformed rather than defaulting.
 *
 * The T18 SOP specified a lenient parser that collapses bad input to
 * (0 of 1). This diverges from it on purpose, for the reason T08 already
 * established on the auto-publish route: these values arrive from a query
 * string baked into each cron service's CRON_PATH env var, where a typo is
 * silent and permanent, and the lenient failure mode is the worse one.
 * A mistyped `shardCount` turns the shard filter into a no-op, so ONE
 * service sweeps the ENTIRE network — the unsharded 1,500-blog sweep that
 * blows through curl's --max-time and gets retried three times, which is
 * precisely the failure T18 exists to remove.
 *
 * A 400 is the right answer: curl's transient set is
 * "timeout / 408 / 429 / 5xx", so a 400 is NOT retried — invoke.sh fails the
 * container immediately and Render shows the cron run red.
 */
export function parseShardParams(url: URL): ShardParams {
  const shard = parseShardParam(url.searchParams.get("shard"));
  const shardCount = parseShardParam(url.searchParams.get("shardCount"));

  if (shard === undefined) {
    return {
      ok: false,
      message: `Invalid ?shard= — expected a non-negative integer, got "${url.searchParams.get("shard")}"`,
    };
  }
  if (shardCount === undefined) {
    return {
      ok: false,
      message: `Invalid ?shardCount= — expected a non-negative integer, got "${url.searchParams.get("shardCount")}"`,
    };
  }
  if ((shard === null) !== (shardCount === null)) {
    return {
      ok: false,
      message:
        "shard and shardCount must be supplied together " +
        `(shard=${shard === null ? "absent" : shard}, shardCount=${shardCount === null ? "absent" : shardCount})`,
    };
  }
  if (shard === null || shardCount === null) {
    return { ok: true, shardIndex: 0, shardCount: 1 };
  }
  if (shardCount < 1 || shardCount > 64) {
    return { ok: false, message: `shardCount must be in [1, 64], got ${shardCount}` };
  }
  if (shard >= shardCount) {
    return {
      ok: false,
      message: `shard must be in [0, ${shardCount - 1}] for shardCount=${shardCount}, got ${shard}`,
    };
  }
  return { ok: true, shardIndex: shard, shardCount };
}
