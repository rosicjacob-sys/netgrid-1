import { describe, it, expect } from "vitest";
import {
  buildPostingPlan,
  formatPostingPlan,
  isUnscheduled,
  isoWeekdayUtc,
  normalizePostingPlan,
  planDays,
  planForPostsPerDay,
  planForPostsPerWeek,
  planToFormValues,
  postsPerWeek,
  quotaForDate,
  ZERO_PLAN,
} from "./posting-plan";

describe("isoWeekdayUtc", () => {
  it("maps Sunday to 7 and Monday to 1", () => {
    expect(isoWeekdayUtc(new Date("2026-08-23T12:00:00Z"))).toBe(7); // Sunday
    expect(isoWeekdayUtc(new Date("2026-08-24T12:00:00Z"))).toBe(1); // Monday
    expect(isoWeekdayUtc(new Date("2026-08-25T12:00:00Z"))).toBe(2); // Tuesday
  });

  it("uses UTC, not local time", () => {
    // 23:30 UTC Sunday is still Sunday no matter where the server is.
    expect(isoWeekdayUtc(new Date("2026-08-23T23:30:00Z"))).toBe(7);
  });
});

describe("normalizePostingPlan", () => {
  it("passes a valid plan through", () => {
    expect(normalizePostingPlan([1, 0, 1, 0, 1, 0, 0])).toEqual([1, 0, 1, 0, 1, 0, 0]);
  });

  it("collapses anything malformed to the zero plan", () => {
    expect(normalizePostingPlan(null)).toEqual(ZERO_PLAN);
    expect(normalizePostingPlan(undefined)).toEqual(ZERO_PLAN);
    expect(normalizePostingPlan([])).toEqual(ZERO_PLAN);
    expect(normalizePostingPlan([1, 0, 1])).toEqual(ZERO_PLAN); // short
    expect(normalizePostingPlan([1, 0, 1, 0, 1, 0, 0, 1])).toEqual(ZERO_PLAN); // long
    expect(normalizePostingPlan([1, -1, 0, 0, 0, 0, 0])).toEqual(ZERO_PLAN); // negative
    expect(normalizePostingPlan([1, 99, 0, 0, 0, 0, 0])).toEqual(ZERO_PLAN); // over cap
    expect(normalizePostingPlan([1.5, 0, 0, 0, 0, 0, 0])).toEqual(ZERO_PLAN); // fractional
  });

  it("coerces the numeric strings a driver may hand back", () => {
    expect(normalizePostingPlan(["1", "0", "1", "0", "1", "0", "0"])).toEqual([
      1, 0, 1, 0, 1, 0, 0,
    ]);
  });
});

describe("postsPerWeek / isUnscheduled / quotaForDate", () => {
  it("sums the plan", () => {
    expect(postsPerWeek([1, 0, 1, 0, 1, 0, 0])).toBe(3);
    expect(postsPerWeek([2, 2, 2, 2, 2, 2, 2])).toBe(14);
    expect(postsPerWeek(ZERO_PLAN)).toBe(0);
  });

  it("flags the empty plan", () => {
    expect(isUnscheduled(ZERO_PLAN)).toBe(true);
    expect(isUnscheduled([0, 0, 1, 0, 0, 0, 0])).toBe(false);
  });

  it("reads today's quota by ISO weekday", () => {
    const monWedFri = [1, 0, 1, 0, 1, 0, 0];
    expect(quotaForDate(monWedFri, new Date("2026-08-24T00:00:00Z"))).toBe(1); // Mon
    expect(quotaForDate(monWedFri, new Date("2026-08-25T00:00:00Z"))).toBe(0); // Tue
    expect(quotaForDate(monWedFri, new Date("2026-08-26T23:59:59Z"))).toBe(1); // Wed
  });
});

describe("buildPostingPlan", () => {
  it("builds a uniform plan from days plus a count", () => {
    expect(buildPostingPlan([1, 3, 5])).toEqual([1, 0, 1, 0, 1, 0, 0]);
    expect(buildPostingPlan([1, 3, 5], 2)).toEqual([2, 0, 2, 0, 2, 0, 0]);
  });

  it("returns the zero plan for no days", () => {
    expect(buildPostingPlan([])).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(buildPostingPlan(null)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("dedupes, ignores out-of-range days and clamps the count", () => {
    expect(buildPostingPlan([3, 3, 9, 0, -2])).toEqual([0, 0, 1, 0, 0, 0, 0]);
    expect(buildPostingPlan([1], 99)).toEqual([8, 0, 0, 0, 0, 0, 0]);
    expect(buildPostingPlan([1], 0)).toEqual([1, 0, 0, 0, 0, 0, 0]);
  });
});

describe("planForPostsPerWeek / planForPostsPerDay", () => {
  it("spreads weekly counts across distinct days", () => {
    expect(planForPostsPerWeek(1)).toEqual([0, 0, 1, 0, 0, 0, 0]);
    expect(planForPostsPerWeek(2)).toEqual([0, 1, 0, 0, 1, 0, 0]);
    expect(planForPostsPerWeek(3)).toEqual([1, 0, 1, 0, 1, 0, 0]);
    expect(planForPostsPerWeek(7)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it("refuses weekly counts it cannot spread", () => {
    expect(planForPostsPerWeek(0)).toBeNull();
    expect(planForPostsPerWeek(8)).toBeNull();
  });

  it("fills every day for a per-day count", () => {
    expect(planForPostsPerDay(2)).toEqual([2, 2, 2, 2, 2, 2, 2]);
    expect(planForPostsPerDay(0)).toBeNull();
    expect(planForPostsPerDay(9)).toBeNull();
  });
});

describe("planDays / formatPostingPlan / planToFormValues", () => {
  it("round-trips days", () => {
    expect(planDays([1, 0, 1, 0, 1, 0, 0])).toEqual([1, 3, 5]);
    expect(planDays(ZERO_PLAN)).toEqual([]);
  });

  it("formats for humans", () => {
    expect(formatPostingPlan([1, 0, 1, 0, 1, 0, 0])).toBe("Mon, Wed, Fri");
    expect(formatPostingPlan([2, 0, 2, 0, 0, 0, 0])).toBe("Mon, Wed (x2)");
    expect(formatPostingPlan([2, 0, 1, 0, 0, 0, 0])).toBe("Monx2, Wedx1");
    expect(formatPostingPlan(ZERO_PLAN)).toBe("not scheduled");
  });

  it("splits a plan back into form values", () => {
    expect(planToFormValues([2, 0, 2, 0, 0, 0, 0])).toEqual({
      days: [1, 3],
      postsPerDay: 2,
    });
    expect(planToFormValues(ZERO_PLAN)).toEqual({ days: [], postsPerDay: 1 });
  });
});
