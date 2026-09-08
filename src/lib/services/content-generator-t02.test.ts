/**
 * T02 generator-path tests: the exact functions a real publish runs to emit
 * the CTA button and the in-body money link. Verifies the shared netgrid host
 * is gone from generated markup and the direct UTM-tagged client link is
 * correct, including attribute-safe "&amp;" escaping and the honest
 * rel="sponsored noopener" for paid placements.
 *
 * buildCtaHtml / injectMoneyLink / safeAttrUrl are exported for exactly this
 * purpose — they are internal to the generation pipeline and otherwise only
 * observable end-to-end after an API-credit publish.
 */
import { describe, it, expect } from "vitest";
import {
  buildCtaHtml,
  injectMoneyLink,
  safeAttrUrl,
} from "@/lib/services/content-generator";
import { withUtm } from "@/lib/content/outbound-links";

const POST_ID = "8b1f0c2e-5d3a-4f21-9c77-0a1b2c3d4e5f";
const CLIENT_URL = "https://client.example/shop";
const BLOG_DOMAIN = "publisher.example";

/** The URL the generator passes to buildCtaHtml since T02. */
function taggedCtaUrl() {
  return withUtm(CLIENT_URL, {
    blogDomain: BLOG_DOMAIN,
    medium: "cta_button",
    postId: POST_ID,
  });
}

describe("T02 — buildCtaHtml (the CTA button a publish emits)", () => {
  const html = buildCtaHtml(
    { label: "Shop now!", url: taggedCtaUrl(), color: "#123456" },
    "seed-1",
  );

  it("links DIRECTLY to the client — no netgrid host anywhere", () => {
    expect(html).not.toContain("netgrid-16f6.onrender.com");
    expect(html).not.toContain("/r/");
    expect(html).toContain('href="https://client.example/shop?');
  });

  it("carries all four UTM parameters, with &amp;-escaped separators", () => {
    expect(html).toContain("utm_source=publisher.example");
    expect(html).toContain("utm_medium=cta_button");
    expect(html).toContain("utm_campaign=netgrid_content");
    expect(html).toContain(`utm_content=${POST_ID}`);
    // The raw "&" would be an HTML parse error / sanitizer-mangled.
    expect(html).toContain("&amp;utm_medium=");
    expect(html).not.toMatch(/&(?!amp;|lt;|gt;|#)/);
  });

  it("declares the paid placement honestly: rel=sponsored noopener", () => {
    expect(html).toContain('rel="sponsored noopener"');
    expect(html).not.toContain("nofollow");
    expect(html).not.toContain("noreferrer");
    expect(html).not.toContain("ugc");
  });

  it("keeps the per-blog appearance randomisation (no rel randomisation)", () => {
    const other = buildCtaHtml({ label: "Shop now!", url: taggedCtaUrl() }, "seed-2");
    // Same rel everywhere, but styling differs per seed.
    expect(other).toContain('rel="sponsored noopener"');
    expect(other).not.toBe(html);
  });

  it("returns empty for an unsafe or missing URL/label", () => {
    expect(buildCtaHtml(undefined, "s")).toBe("");
    expect(buildCtaHtml({ label: "", url: CLIENT_URL }, "s")).toBe("");
    expect(buildCtaHtml({ label: "x", url: "javascript:alert(1)" }, "s")).toBe("");
  });
});

describe("T02 — injectMoneyLink (the in-body buy-phrase link)", () => {
  const body =
    "<p>You can buy bpc-157 from trusted Canadian sources online.</p>" +
    "<p>Second paragraph with more detail.</p>";
  const tagged = withUtm(CLIENT_URL, {
    blogDomain: BLOG_DOMAIN,
    medium: "body_link",
    postId: POST_ID,
  });
  const out = injectMoneyLink(body, tagged, ["buy bpc-157"]);

  it("links the buy phrase DIRECTLY to the client with UTMs", () => {
    expect(out).toContain(`<a href="${safeAttrUrl(tagged)}"`);
    expect(out).toContain("utm_campaign=netgrid_content");
    expect(out).toContain("utm_medium=body_link");
    expect(out).not.toContain("netgrid-16f6.onrender.com");
  });

  it("uses the commercial rel and no-ops on already-linked paragraphs", () => {
    expect(out).toContain('rel="sponsored noopener"');
    const linked = "<p>Already has <a href=\"https://x.example\">a link</a> here, so buy bpc-157 stays plain.</p>";
    expect(injectMoneyLink(linked, tagged, ["buy bpc-157"])).toBe(linked);
  });

  it("leaves the body untouched when no term matches", () => {
    expect(injectMoneyLink(body, tagged, ["nonexistent phrase"])).toBe(body);
  });
});

describe("T02 — safeAttrUrl", () => {
  it("escapes & and percent-encodes quotes/angle brackets for attributes", () => {
    expect(safeAttrUrl("https://c.example/p?a=1&b=2"))
      .toBe("https://c.example/p?a=1&amp;b=2");
    expect(safeAttrUrl('https://c.example/"<x>')).toBe("https://c.example/%22%3Cx%3E");
  });
});
