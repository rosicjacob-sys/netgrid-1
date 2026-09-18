import { describe, expect, it } from "vitest";
import { isTransientFailure, utcDayKey } from "./publish-slots";

describe("utcDayKey", () => {
  it("buckets by the UTC day, not the host's local day", () => {
    expect(utcDayKey(new Date("2026-08-25T23:59:59.999Z"))).toBe("2026-08-25");
    expect(utcDayKey(new Date("2026-08-26T00:00:00.000Z"))).toBe("2026-08-26");
  });

  it("is stable across every hour of the same UTC day", () => {
    const first = utcDayKey(new Date("2026-08-25T00:00:00.000Z"));
    for (let h = 0; h < 24; h++) {
      const at = new Date(Date.UTC(2026, 7, 25, h, 30, 0));
      expect(utcDayKey(at)).toBe(first);
    }
  });
});

describe("isTransientFailure", () => {
  it("flags upstream throttling, 5xx and network faults", () => {
    const transient = [
      "Anthropic rate limit exceeded, retry after 12s",
      "Request failed with status code 429",
      "upstream returned 503 Service Unavailable",
      "504 Gateway Timeout",
      "socket hang up (ECONNRESET)",
      "connect ETIMEDOUT 104.18.0.1:443",
      "Model is overloaded, please retry",
      "network error while fetching image",
    ];
    for (const m of transient) expect(isTransientFailure(m)).toBe(true);
  });

  it("does not flag permanent failures", () => {
    const permanent = [
      "Blog example.com is missing shopify credentials — connect the platform first",
      "401 Unauthorized",
      "Could not resolve a topic to write about",
      "slot 0 for 2026-08-25 already claimed by another run",
    ];
    for (const m of permanent) expect(isTransientFailure(m)).toBe(false);
  });

  it("treats an absent message as permanent", () => {
    expect(isTransientFailure(null)).toBe(false);
    expect(isTransientFailure(undefined)).toBe(false);
    expect(isTransientFailure("")).toBe(false);
  });
});
