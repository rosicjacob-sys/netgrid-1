import { describe, expect, it } from "vitest";
import {
  computeOnSchedule,
  countPostsInWindow,
  expectedPostsPerWeek,
  fetchCountForBlog,
  maxDaysBetweenPosts,
  blogHasCredentials,
  type BlogRow,
} from "./cadence";
import { shardForBlog, parseShardParams } from "./sharding";

function blog(overrides: Partial<BlogRow>): BlogRow {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    platform: "wordpress",
    postingPlan: [0, 0, 0, 0, 0, 0, 0],
    wpUrl: "https://a.com",
    wpUsername: "u",
    wpAppPassword: "p",
    lastPostTitle: null,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    ...overrides,
  } as unknown as BlogRow;
}

describe("expectedPostsPerWeek", () => {
  it("sums the posting plan", () => {
    expect(expectedPostsPerWeek(blog({ postingPlan: [1, 0, 1, 0, 1, 0, 0] }))).toBe(3);
    expect(expectedPostsPerWeek(blog({ postingPlan: [2, 2, 2, 2, 2, 2, 2] }))).toBe(14);
  });

  it("returns 0 only when the blog has no schedule at all", () => {
    expect(expectedPostsPerWeek(blog({ postingPlan: [0, 0, 0, 0, 0, 0, 0] }))).toBe(0);
  });

  it("treats a malformed plan as unscheduled rather than partially honoured", () => {
    expect(expectedPostsPerWeek(blog({ postingPlan: [1, 0, 1] as unknown as number[] }))).toBe(0);
  });
});

describe("maxDaysBetweenPosts", () => {
  it("adds one day of grace to the cadence interval", () => {
    // 3/week -> ceil(7/3) + 1 = 4
    expect(maxDaysBetweenPosts(blog({ postingPlan: [1, 0, 1, 0, 1, 0, 0] }))).toBe(4);
    // 7/week -> ceil(7/7) + 1 = 2
    expect(maxDaysBetweenPosts(blog({ postingPlan: [1, 1, 1, 1, 1, 1, 1] }))).toBe(2);
  });

  it("returns 0 for an unscheduled blog", () => {
    expect(maxDaysBetweenPosts(blog({}))).toBe(0);
  });
});

describe("computeOnSchedule", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const scheduled = blog({ postingPlan: [1, 0, 1, 0, 1, 0, 0] }); // maxGap 4

  it("never flags an unscheduled blog — that is a T17 notification, not a missed post", () => {
    expect(computeOnSchedule(blog({}), 400, 0, now)).toBe(true);
  });

  it("gives a newly onboarded blog one cadence window of grace", () => {
    const fresh = blog({
      postingPlan: [1, 0, 1, 0, 1, 0, 0],
      createdAt: new Date("2026-05-30T00:00:00Z"), // 2 days old, maxGap 4
    });
    expect(computeOnSchedule(fresh, null, 4, now)).toBe(true);
  });

  it("treats no live posts past the grace window as behind", () => {
    expect(computeOnSchedule(scheduled, null, 4, now)).toBe(false);
  });

  it("compares the live gap against the tolerance", () => {
    expect(computeOnSchedule(scheduled, 4, 4, now)).toBe(true);
    expect(computeOnSchedule(scheduled, 5, 4, now)).toBe(false);
  });
});

describe("countPostsInWindow", () => {
  const now = new Date("2026-06-10T12:00:00Z");
  const at = (iso: string) => ({ publishedAt: new Date(iso) });

  it("counts only posts inside the rolling window", () => {
    const posts = [
      at("2026-06-10T00:00:00Z"),
      at("2026-06-07T00:00:00Z"),
      at("2026-06-01T00:00:00Z"), // 9 days ago — outside
      at("2026-01-01T00:00:00Z"),
    ];
    expect(countPostsInWindow(posts, now)).toBe(2);
  });

  it("ignores posts with no publish date", () => {
    expect(countPostsInWindow([{ publishedAt: null }], now)).toBe(0);
  });

  it("is a count over a period, not a count of rows returned", () => {
    // The old implementation stored posts.length, capped at 5. Five ancient
    // posts must count as 0, not 5, or the stored (posts_in_period,
    // expected_posts) pair is not comparable.
    const ancient = Array.from({ length: 5 }, () => at("2020-01-01T00:00:00Z"));
    expect(countPostsInWindow(ancient, now)).toBe(0);
  });
});

describe("fetchCountForBlog", () => {
  it("pulls enough rows for the window to fit, with a floor and a ceiling", () => {
    expect(fetchCountForBlog(0)).toBe(10);
    expect(fetchCountForBlog(3)).toBe(10);
    expect(fetchCountForBlog(7)).toBe(16);
    expect(fetchCountForBlog(14)).toBe(26);
    expect(fetchCountForBlog(500)).toBe(50);
  });
});

describe("blogHasCredentials", () => {
  it("requires all three WordPress fields", () => {
    expect(blogHasCredentials(blog({}))).toBe(true);
    expect(blogHasCredentials(blog({ wpAppPassword: null }))).toBe(false);
  });

  it("accepts either Shopify auth mode", () => {
    const base = { platform: "shopify", shopifyStoreUrl: "s.myshopify.com" };
    expect(
      blogHasCredentials(
        blog({ ...base, shopifyAuthMode: "legacy_token", shopifyAdminApiToken: "t" } as Partial<BlogRow>),
      ),
    ).toBe(true);
    expect(
      blogHasCredentials(
        blog({ ...base, shopifyClientId: "id", shopifyClientSecret: "sec" } as Partial<BlogRow>),
      ),
    ).toBe(true);
    expect(blogHasCredentials(blog({ ...base } as Partial<BlogRow>))).toBe(false);
  });
});

describe("shardForBlog — GOLDEN VALUES", () => {
  // Generated from the implementation as it stood inside
  // content-generation-actions.ts BEFORE it moved to src/lib/cron/sharding.ts.
  // A failure here means the extraction changed shard assignments, which
  // would silently redistribute the whole network across the auto-publish
  // shards — every blog would move, and blogs would be published by two
  // services during the transition.
  const GOLDEN: Array<[string, number, number]> = [
    ["00000000-0000-4000-8000-000000000001", 1, 5],
    ["11111111-1111-4111-8111-111111111111", 3, 7],
    ["c26a8f3e-1b4d-4c7a-9f21-0e5b3a7d1c88", 0, 4],
    ["f12d3b90-77aa-4e61-bb02-9c1e4f8a2d55", 3, 3],
    ["4a9b2c71-3e88-4d0f-a6b3-5f2c9e1d7a44", 2, 2],
  ];

  it("assigns exactly the shards the pre-extraction code assigned", () => {
    for (const [id, of4, of8] of GOLDEN) {
      expect(shardForBlog(id, 4)).toBe(of4);
      expect(shardForBlog(id, 8)).toBe(of8);
    }
  });

  it("collapses to shard 0 when there is only one shard", () => {
    expect(shardForBlog(GOLDEN[0][0], 1)).toBe(0);
  });
});

describe("parseShardParams", () => {
  const parse = (qs: string) => parseShardParams(new URL(`https://x/y${qs}`));

  it("accepts a well-formed pair", () => {
    expect(parse("?shard=2&shardCount=4")).toEqual({
      ok: true,
      shardIndex: 2,
      shardCount: 4,
    });
  });

  it("treats no query string as the single-shard case", () => {
    expect(parse("")).toEqual({ ok: true, shardIndex: 0, shardCount: 1 });
  });

  it("REJECTS a malformed shardCount rather than collapsing the filter", () => {
    // This is the whole point of the strict parser: a lenient one turns a
    // typo into one service sweeping the entire 1,500-blog network.
    const r = parse("?shard=0&shardCount=o");
    expect(r.ok).toBe(false);
  });

  it("rejects a half-supplied pair", () => {
    expect(parse("?shard=0").ok).toBe(false);
    expect(parse("?shardCount=4").ok).toBe(false);
  });

  it("rejects an out-of-range shard", () => {
    expect(parse("?shard=4&shardCount=4").ok).toBe(false);
  });

  it("rejects values Number() would happily accept", () => {
    expect(parse("?shard=1e0&shardCount=4").ok).toBe(false);
    expect(parse("?shard=1.0&shardCount=4").ok).toBe(false);
    expect(parse("?shard=%201%20&shardCount=4").ok).toBe(false);
  });
});
