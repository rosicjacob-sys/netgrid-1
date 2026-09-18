import { describe, it, expect } from "vitest";
import { parseBlogCsv } from "./csv-parser";

const CLIENT = "00000000-0000-4000-8000-000000000001";
const BASE_HEADER = "domain,wp_url,wp_username,wp_app_password,seo_plugin";

function sheet(header: string, ...rows: string[]): string {
  return [header, ...rows].join("\n");
}

describe("parseBlogCsv — cadence", () => {
  it("rejects a bare number with the ambiguity message", () => {
    const res = parseBlogCsv(
      sheet(
        `${BASE_HEADER},posting_frequency`,
        "a.com,https://a.com,u,p,none,2",
      ),
      CLIENT,
    );
    expect(res.valid).toHaveLength(0);
    expect(res.errors).toHaveLength(1);
    // The exact wording matters: it tells the operator both readings and
    // which one used to apply, so they can pick deliberately.
    expect(res.errors[0].message).toBe(
      'posting_frequency "2" is ambiguous — it used to be read as 2 posts per DAY ' +
        '(14/week). Write "2 per week" or "2 per day".',
    );
  });

  it('reads "3 per week" as the Mon/Wed/Fri spread', () => {
    const res = parseBlogCsv(
      sheet(
        `${BASE_HEADER},posting_frequency`,
        "a.com,https://a.com,u,p,none,3 per week",
      ),
      CLIENT,
    );
    expect(res.errors).toEqual([]);
    expect(res.valid[0].postingPlan).toEqual([1, 0, 1, 0, 1, 0, 0]);
  });

  it('reads "2 per day" as two posts on every weekday', () => {
    const res = parseBlogCsv(
      sheet(
        `${BASE_HEADER},posting_frequency`,
        "a.com,https://a.com,u,p,none,2 per day",
      ),
      CLIENT,
    );
    expect(res.errors).toEqual([]);
    expect(res.valid[0].postingPlan).toEqual([2, 2, 2, 2, 2, 2, 2]);
  });

  it("combines posting_days with posts_per_day", () => {
    const res = parseBlogCsv(
      sheet(
        `${BASE_HEADER},posting_days,posts_per_day`,
        'a.com,https://a.com,u,p,none,"Mon Wed Fri",2',
      ),
      CLIENT,
    );
    expect(res.errors).toEqual([]);
    expect(res.valid[0].postingPlan).toEqual([2, 0, 2, 0, 2, 0, 0]);
  });

  it("names the offending token when a weekday is unrecognised", () => {
    const res = parseBlogCsv(
      sheet(
        `${BASE_HEADER},posting_days`,
        'a.com,https://a.com,u,p,none,"Mon Funday"',
      ),
      CLIENT,
    );
    expect(res.valid).toHaveLength(0);
    expect(res.errors[0].message).toContain('"Funday"');
  });

  it("rejects a header with neither cadence column", () => {
    const res = parseBlogCsv(
      sheet(BASE_HEADER, "a.com,https://a.com,u,p,none"),
      CLIENT,
    );
    expect(res.valid).toHaveLength(0);
    expect(res.errors[0].field).toBe("header");
    expect(res.errors[0].message).toContain("Missing cadence column");
  });

  it("does not throw when posts_per_day is absent from the header", () => {
    // Regression guard: colIndex holds -1 for an absent optional column, and
    // fields[-1] is undefined — the old getValue() let that through.
    const res = parseBlogCsv(
      sheet(
        `${BASE_HEADER},posting_days`,
        'a.com,https://a.com,u,p,none,"Tue Fri"',
      ),
      CLIENT,
    );
    expect(res.errors).toEqual([]);
    expect(res.valid[0].postingPlan).toEqual([0, 1, 0, 0, 1, 0, 0]);
  });

  it("refuses a weekly count it cannot spread across distinct days", () => {
    const res = parseBlogCsv(
      sheet(
        `${BASE_HEADER},posting_frequency`,
        "a.com,https://a.com,u,p,none,10 per week",
      ),
      CLIENT,
    );
    expect(res.valid).toHaveLength(0);
    expect(res.errors[0].message).toContain('must be written as "N per day"');
  });

  it("caps the weekly total from posting_days x posts_per_day", () => {
    const res = parseBlogCsv(
      sheet(
        `${BASE_HEADER},posting_days,posts_per_day`,
        'a.com,https://a.com,u,p,none,"Mon Tue Wed Thu Fri Sat Sun",3',
      ),
      CLIENT,
    );
    expect(res.valid).toHaveLength(0);
    expect(res.errors[0].message).toBe(
      "That schedule is 21 posts/week; the maximum is 14",
    );
  });

  it('maps the words "weekly" and "daily"', () => {
    const res = parseBlogCsv(
      sheet(
        `${BASE_HEADER},posting_frequency`,
        "a.com,https://a.com,u,p,none,weekly",
        "b.com,https://b.com,u,p,none,daily",
      ),
      CLIENT,
    );
    expect(res.errors).toEqual([]);
    expect(res.valid[0].postingPlan).toEqual([0, 0, 1, 0, 0, 0, 0]);
    expect(res.valid[1].postingPlan).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it("requires a cadence value on every row, not just the header", () => {
    const res = parseBlogCsv(
      sheet(`${BASE_HEADER},posting_frequency`, "a.com,https://a.com,u,p,none,"),
      CLIENT,
    );
    expect(res.valid).toHaveLength(0);
    expect(res.errors[0].message).toContain("posting_frequency is required");
  });
});
