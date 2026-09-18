/**
 * Pure helpers for the auto-publish day-slot claim (T08).
 *
 * These live outside content-generation-actions.ts because that file carries
 * the "use server" directive: every export there must be an async server
 * action, so plain synchronous helpers can neither be exported nor unit
 * tested from it. Nothing in this module touches the database or the network.
 */

/**
 * The UTC calendar day of `now` as a `YYYY-MM-DD` key.
 *
 * This is the value written to generated_posts.publish_day. Drizzle maps a
 * Postgres `date` column to a string — the same convention reports.periodStart
 * already uses — and Date#toISOString is always UTC, so the key can never
 * drift with the server's local timezone or with the database session's
 * TimeZone GUC.
 *
 * Deliberately parallel to startOfUtcDay() in content-generation-actions.ts:
 * both describe the same boundary, one as a Date and one as a date key.
 */
export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Message-shape heuristic for "worth retrying inside the same cron tick".
 * Rate limits, upstream 5xx and network blips are transient; auth failures,
 * validation errors and bad configuration are not.
 *
 * Lifted verbatim from the inline classifier that used to live in
 * publishOneInner(). It now has two callers: publishOneInner still uses it for
 * THROWN errors, and runGenerateAndPublish uses it to classify the failures it
 * CATCHES and returns. One heuristic, one place to change it.
 *
 * Known limitation, inherited: this is a substring test, so a message that
 * happens to embed "429" or "503" inside an unrelated number is a false
 * positive. The cost of a false positive is one wasted retry, so it is
 * tolerated rather than fixed here.
 */
export function isTransientFailure(
  message: string | null | undefined,
): boolean {
  if (!message) return false;
  const msg = message.toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("timeout") ||
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("network") ||
    msg.includes("overloaded")
  );
}
