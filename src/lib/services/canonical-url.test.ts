import { describe, it, expect } from "vitest";
import { toCanonicalUrl } from "./canonical-url";

describe("toCanonicalUrl", () => {
  it("swaps a Shopify admin host for the merchant's domain", () => {
    // The reason this exists: Shopify's Admin API returns .myshopify.com URLs,
    // which IndexNow rejects with a 422 and which split crawl equity away from
    // the canonical storefront when used as an internal link target.
    expect(
      toCanonicalUrl(
        "https://ottawa-peptides.myshopify.com/blogs/news/bpc-157",
        "ottawapeptides.ca",
      ),
    ).toBe("https://ottawapeptides.ca/blogs/news/bpc-157");
  });

  it("forces https and drops an IP+port host", () => {
    expect(
      toCanonicalUrl("http://1.2.3.4:8080/2026/03/post-slug/", "example.com"),
    ).toBe("https://example.com/2026/03/post-slug/");
  });

  it("strips a scheme, path and port from the supplied domain", () => {
    expect(
      toCanonicalUrl("https://x.myshopify.com/a", "https://example.ca:443/blog"),
    ).toBe("https://example.ca/a");
  });

  it("preserves the query string and fragment", () => {
    expect(
      toCanonicalUrl("https://x.myshopify.com/a?b=1#c", "example.com"),
    ).toBe("https://example.com/a?b=1#c");
  });

  it("returns the original URL when the domain is unusable", () => {
    // A silent host swap onto something broken is worse than leaving the URL
    // alone: the caller then surfaces a clearer error.
    const url = "https://x.myshopify.com/a";
    expect(toCanonicalUrl(url, "")).toBe(url);
    expect(toCanonicalUrl(url, "127.0.0.1")).toBe(url);
    expect(toCanonicalUrl(url, "localhost")).toBe(url);
  });

  it("returns the original when the platform URL does not parse", () => {
    expect(toCanonicalUrl("not a url", "example.com")).toBe("not a url");
  });
});
