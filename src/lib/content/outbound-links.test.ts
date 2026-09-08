import { describe, expect, it } from "vitest";
import {
    COMMERCIAL_LINK_REL,
    EDITORIAL_LINK_REL,
    UTM_CAMPAIGN,
    stripUtm,
    utmSourceFromDomain,
    withUtm,
} from "./outbound-links";
const POST_ID = "8b1f0c2e-5d3a-4f21-9c77-0a1b2c3d4e5f";
describe("utmSourceFromDomain", () => {
    it("normalizes every stored domain shape to a bare host", () => {
        expect(utmSourceFromDomain("https://www.Example.com/")).toBe("example.com");
        expect(utmSourceFromDomain("example.com")).toBe("example.com");
        expect(utmSourceFromDomain("http://shop.example.com/blog")).toBe(
            "shop.example.com",
        );
        expect(utmSourceFromDomain("  ")).toBeNull();
        expect(utmSourceFromDomain(null)).toBeNull();
    });
});
describe("withUtm", () => {
    it("tags a bare destination", () => {
        const u = new URL(
            withUtm("https://client.example/shop", {
                blogDomain: "www.publisher.example",
                medium: "cta_button",
                postId: POST_ID,
            }),
        );
        expect(u.searchParams.get("utm_source")).toBe("publisher.example");
        expect(u.searchParams.get("utm_medium")).toBe("cta_button");
        expect(u.searchParams.get("utm_campaign")).toBe(UTM_CAMPAIGN);
        expect(u.searchParams.get("utm_content")).toBe(POST_ID);
    });
    it("keeps the client's own utm values and never double-tags", () => {
        const once = withUtm("https://client.example/shop?utm_source=partner", {
            blogDomain: "publisher.example",
            medium: "body_link",
        });
        expect(new URL(once).searchParams.get("utm_source")).toBe("partner");
        // Re-tagging an already-tagged URL is a no-op.
        expect(withUtm(once, { blogDomain: "other.example", medium: "cta_button" }))
            .toBe(once);
    });
    it("preserves existing query params and the fragment", () => {
        const out = withUtm("https://client.example/p?variant=42#buy", {
            blogDomain: "publisher.example",
            medium: "cta_button",
        });
        const u = new URL(out);
        expect(u.searchParams.get("variant")).toBe("42");
        expect(u.hash).toBe("#buy");
    });
    it("falls back to a stable source when the blog has no domain", () => {
        const u = new URL(
            withUtm("https://client.example/", { blogDomain: null, medium: "body_link" }),
        );
        expect(u.searchParams.get("utm_source")).toBe("netgrid");
    });
    it("leaves non-http(s) input untouched", () => {
        expect(withUtm("mailto:hi@client.example", { medium: "cta_button" })).toBe(
            "mailto:hi@client.example",
        );
        expect(withUtm("", { medium: "cta_button" })).toBe("");
        expect(withUtm("  /relative/path ", { medium: "cta_button" })).toBe(
            "/relative/path",
        );
    });
});
describe("stripUtm", () => {
    it("removes every utm_* parameter and keeps the rest", () => {
        const out = stripUtm(
            "https://client.example/p?variant=42&utm_source=a&utm_medium=b#buy",
        );
        expect(out).toBe("https://client.example/p?variant=42#buy");
    });
});
describe("rel policy", () => {
    it("never nofollows a paid commercial link and never strips the referrer", () => {
        expect(COMMERCIAL_LINK_REL).toBe("sponsored noopener");
        expect(COMMERCIAL_LINK_REL).not.toContain("nofollow");
        expect(COMMERCIAL_LINK_REL).not.toContain("noreferrer");
        expect(COMMERCIAL_LINK_REL).not.toContain("ugc");
    });
    it("marks editorial citations without a sponsorship claim", () => {
        expect(EDITORIAL_LINK_REL).toBe("noopener");
        expect(EDITORIAL_LINK_REL).not.toContain("sponsored");
    });
});