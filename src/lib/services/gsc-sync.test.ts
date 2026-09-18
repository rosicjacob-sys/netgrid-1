import { describe, it, expect } from "vitest";
import {
  gscShardForBlog,
  gscToday,
  rowHash,
  shiftDate,
  MAX_PAGE_LEN,
  MAX_QUERY_LEN,
} from "./gsc-sync";

describe("gscToday", () => {
  it("returns the Pacific date, not the UTC date", () => {
    // 2026-03-10T03:00:00Z is still 2026-03-09 in Los Angeles (PDT, UTC-7).
    // Getting this wrong asks Google for a day it has not opened yet and gets
    // an empty 200 back — the exact silent failure this helper prevents.
    expect(gscToday(new Date("2026-03-10T03:00:00Z"))).toBe("2026-03-09");
  });

  it("rolls over once Pacific midnight passes", () => {
    expect(gscToday(new Date("2026-03-10T08:00:00Z"))).toBe("2026-03-10");
  });

  it("formats as YYYY-MM-DD with zero padding", () => {
    expect(gscToday(new Date("2026-01-05T20:00:00Z"))).toBe("2026-01-05");
  });
});

describe("shiftDate", () => {
  it("shifts backwards across a month boundary", () => {
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("handles a leap day", () => {
    expect(shiftDate("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("shifts forwards", () => {
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("is stable across a DST transition (anchored to UTC midnight)", () => {
    // 2026-03-08 is the US DST switch. A local-midnight implementation would
    // return 2026-03-08 twice or skip a day here.
    expect(shiftDate("2026-03-07", 1)).toBe("2026-03-08");
    expect(shiftDate("2026-03-08", 1)).toBe("2026-03-09");
  });

  it("walks a 16-month backfill window to a plausible start", () => {
    expect(shiftDate("2026-08-22", -Math.round(16 * 30.44))).toBe("2025-04-22");
  });
});

describe("rowHash", () => {
  it("is deterministic", () => {
    expect(rowHash("buy peptides", "https://x.com/a")).toBe(
      rowHash("buy peptides", "https://x.com/a"),
    );
  });

  it("is always 64 hex characters regardless of input length", () => {
    expect(rowHash("a", "b")).toMatch(/^[0-9a-f]{64}$/);
    expect(rowHash("q".repeat(MAX_QUERY_LEN), "p".repeat(MAX_PAGE_LEN))).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("does not collide when the boundary between query and page moves", () => {
    // A naive concatenation would make these two identical. The NUL separator
    // is what prevents ("ab", "c") and ("a", "bc") sharing a key.
    expect(rowHash("ab", "c")).not.toBe(rowHash("a", "bc"));
  });

  it("distinguishes different pages for the same query", () => {
    expect(rowHash("peptides", "https://x.com/a")).not.toBe(
      rowHash("peptides", "https://x.com/b"),
    );
  });
});

describe("gscShardForBlog", () => {
  const ids = Array.from(
    { length: 2000 },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  );

  it("collapses to shard 0 when there is only one shard", () => {
    expect(gscShardForBlog(ids[0], 1)).toBe(0);
  });

  it("is stable for a given id", () => {
    expect(gscShardForBlog(ids[7], 4)).toBe(gscShardForBlog(ids[7], 4));
  });

  it("always returns a valid shard index", () => {
    for (const id of ids.slice(0, 200)) {
      const s = gscShardForBlog(id, 4);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(4);
    }
  });

  it("distributes roughly evenly across 4 shards", () => {
    const counts = [0, 0, 0, 0];
    for (const id of ids) counts[gscShardForBlog(id, 4)]++;
    // 2000 / 4 = 500 expected per shard; allow +/- 15%.
    for (const c of counts) {
      expect(c).toBeGreaterThan(425);
      expect(c).toBeLessThan(575);
    }
  });
});
