/**
 * Canonical posting cadence for a blog.
 *
 * ONE representation, ONE column. `blogs.posting_plan` is an integer[] of
 * exactly 7 entries; entry i holds the number of posts to publish on ISO
 * weekday i+1 (1 = Monday … 7 = Sunday), in UTC.
 *
 *   Mon/Wed/Fri, one post each  -> [1,0,1,0,1,0,0]
 *   Two posts every day         -> [2,2,2,2,2,2,2]
 *   Not scheduled (ALERTABLE)   -> [0,0,0,0,0,0,0]
 *
 * This replaces three columns that could — and did — disagree:
 *   posting_frequency       varchar   parsed by the publisher as posts/DAY
 *   posting_frequency_days  integer[] used by the publisher as a day filter
 *   posts_per_day           integer   read ONLY by the verification cron
 *
 * Every consumer reads this and nothing else: the auto-publish cron, the
 * post-verification cron, the blog form, the CSV importer, the admin and
 * portal UIs.
 *
 * PURE MODULE — no "use server", no db import. It is imported by
 * src/lib/validators/blog.ts, which runs in the browser via zodResolver.
 */

/** Always exactly 7 entries. Use normalizePostingPlan() to obtain one. */
export type PostingPlan = readonly number[];

/** The "never publishes" plan. An active blog holding this is an alert. */
export const ZERO_PLAN: PostingPlan = [0, 0, 0, 0, 0, 0, 0];

/** Postgres literal for ZERO_PLAN. Keep in sync with 0043_posting_plan.sql. */
export const ZERO_PLAN_SQL = "{0,0,0,0,0,0,0}";

/** Ceiling on a single day's quota. Enforced by the DB CHECK constraint too. */
export const MAX_POSTS_PER_DAY = 8;

/** Ceiling on the weekly total. Enforced by the validators, not the DB —
 *  8/day x 7 days is representable, it just isn't something an operator may
 *  configure through the form or a CSV. */
export const MAX_POSTS_PER_WEEK = 14;

export const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * Which weekdays an "N posts per week" cadence maps onto. Spread so posts
 * are not adjacent for small N. This table is mirrored verbatim in the CASE
 * ladder of 0043_posting_plan.sql — change one, change both.
 */
export const WEEKLY_SPREAD: Readonly<Record<number, readonly number[]>> = {
  1: [3],                        // Wed
  2: [2, 5],                     // Tue, Fri
  3: [1, 3, 5],                  // Mon, Wed, Fri
  4: [1, 2, 4, 5],               // Mon, Tue, Thu, Fri
  5: [1, 2, 3, 4, 5],            // Mon-Fri
  6: [1, 2, 3, 4, 5, 6],         // Mon-Sat
  7: [1, 2, 3, 4, 5, 6, 7],      // every day
};

/** ISO weekday (1 = Monday … 7 = Sunday) from a Date, in UTC. */
export function isoWeekdayUtc(d: Date): number {
  const day = d.getUTCDay(); // 0 = Sunday … 6 = Saturday
  return ((day + 6) % 7) + 1; // 1 = Mon … 7 = Sun
}

/**
 * Coerce a value from the DB or a form payload into a valid plan.
 *
 * Anything malformed — wrong length, negative, non-integer, over the daily
 * ceiling, null — collapses to ZERO_PLAN. That is deliberate: a corrupt plan
 * must present as "unscheduled", which is loud, rather than as a partially
 * honoured schedule, which is silent.
 */
export function normalizePostingPlan(value: unknown): PostingPlan {
  if (!Array.isArray(value) || value.length !== 7) return ZERO_PLAN;
  const out: number[] = [];
  for (const raw of value) {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > MAX_POSTS_PER_DAY) return ZERO_PLAN;
    out.push(n);
  }
  return out;
}

/** Total posts this plan produces in a 7-day window. 0 means unscheduled. */
export function postsPerWeek(plan: PostingPlan): number {
  return plan.reduce((sum, n) => sum + n, 0);
}

/** True when the blog can never publish — the alertable condition. */
export function isUnscheduled(plan: PostingPlan): boolean {
  return postsPerWeek(plan) === 0;
}

/** How many posts this plan wants on the UTC day containing `now`. */
export function quotaForDate(plan: PostingPlan, now: Date): number {
  return plan[isoWeekdayUtc(now) - 1] ?? 0;
}

/** ISO weekdays that carry at least one post, ascending. */
export function planDays(plan: PostingPlan): number[] {
  const days: number[] = [];
  for (let i = 0; i < 7; i++) {
    if ((plan[i] ?? 0) > 0) days.push(i + 1);
  }
  return days;
}

/**
 * Build a plan from a weekday picker plus a per-day count. Out-of-range
 * weekdays are ignored; the count is clamped to 1..MAX_POSTS_PER_DAY.
 */
export function buildPostingPlan(
  days: readonly number[] | null | undefined,
  postsPerDay: number = 1,
): number[] {
  const out = [0, 0, 0, 0, 0, 0, 0];
  if (!days || days.length === 0) return out;
  const n =
    Number.isInteger(postsPerDay) && postsPerDay > 0
      ? Math.min(postsPerDay, MAX_POSTS_PER_DAY)
      : 1;
  for (const d of days) {
    if (Number.isInteger(d) && d >= 1 && d <= 7) out[d - 1] = n;
  }
  return out;
}

/** "N posts per week" -> plan, using WEEKLY_SPREAD. null when N is out of range. */
export function planForPostsPerWeek(n: number): number[] | null {
  const days = WEEKLY_SPREAD[n];
  if (!days) return null;
  return buildPostingPlan(days, 1);
}

/** "N posts per day" -> plan (N on every weekday). null when N is out of range. */
export function planForPostsPerDay(n: number): number[] | null {
  if (!Number.isInteger(n) || n < 1 || n > MAX_POSTS_PER_DAY) return null;
  return [n, n, n, n, n, n, n];
}

/** Human label for logs, the admin table and the client portal. */
export function formatPostingPlan(plan: PostingPlan): string {
  const days = planDays(plan);
  if (days.length === 0) return "not scheduled";
  const counts = new Set(days.map((d) => plan[d - 1]));
  const label = days.map((d) => WEEKDAY_NAMES[d - 1]).join(", ");
  if (counts.size === 1) {
    const n = plan[days[0] - 1];
    return n === 1 ? label : `${label} (x${n})`;
  }
  return days.map((d) => `${WEEKDAY_NAMES[d - 1]}x${plan[d - 1]}`).join(", ");
}

/**
 * Split a plan back into the (days, postsPerDay) pair the blog form edits.
 *
 * A plan with different counts on different days cannot be expressed by the
 * form; it collapses to the highest count, and re-saving the form flattens
 * the plan to a uniform one. Only hand-written SQL can create such a plan —
 * neither the form, the CSV importer nor migration 0043 ever produces one.
 */
export function planToFormValues(plan: PostingPlan): {
  days: number[];
  postsPerDay: number;
} {
  const days = planDays(plan);
  if (days.length === 0) return { days: [], postsPerDay: 1 };
  return { days, postsPerDay: Math.max(...days.map((d) => plan[d - 1] ?? 1)) };
}
