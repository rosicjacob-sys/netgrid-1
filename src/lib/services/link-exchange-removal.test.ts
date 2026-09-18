import { describe, it, expect } from "vitest";
import { stripExchangeLinks } from "./link-exchange-removal";

const EDGE = "9f1c1d2e-0000-4000-8000-000000000001";
const HREF = "https://ottawapeptides.ca/blogs/news/bpc-157-storage";

const INTRO =
  "<p>Peptide storage temperature matters more than most first-time buyers realise.</p>";
const REST =
  "<p>Reconstituted vials belong in a fridge at 2&ndash;8&deg;C.</p>" +
  "<h2>Shelf life</h2>" +
  '<p>Lyophilised powder is stable for months. <a href="/faq">See the FAQ</a>.</p>';

function anchor(text: string): string {
  return `<a href="${HREF}" data-nx-exch="${EDGE}">${text}</a>`;
}

describe("stripExchangeLinks", () => {
  it("deletes the branded/naked carrier and leaves the rest byte-identical", () => {
    const carrier = `<p>You can find more information at ${anchor("Ottawapeptides")}.</p>`;
    const res = stripExchangeLinks(INTRO + carrier + REST);

    expect(res.html).toBe(INTRO + REST);
    expect(res.removedSentences).toBe(1);
    expect(res.unwrappedAnchors).toBe(0);
    expect(res.unresolved).toBe(0);
  });

  it("deletes the generic carrier", () => {
    const carrier = `<p>For additional context, ${anchor("further reading")}.</p>`;
    const res = stripExchangeLinks(INTRO + carrier + REST);

    expect(res.html).toBe(INTRO + REST);
    expect(res.removedSentences).toBe(1);
  });

  it("deletes the partial/exact carrier", () => {
    const carrier = `<p>Learn more about ${anchor("bpc 157 guide")}.</p>`;
    const res = stripExchangeLinks(INTRO + carrier + REST);

    expect(res.html).toBe(INTRO + REST);
    expect(res.removedSentences).toBe(1);
  });

  it("deletes a carrier appended at the very end (no </p> in the body)", () => {
    const body = "<div>A body with no paragraph tags at all.</div>";
    const carrier = `<p>You can find more information at ${anchor("Ottawapeptides")}.</p>`;
    const res = stripExchangeLinks(`${body}\n${carrier}`);

    expect(res.html).toBe(body);
    expect(res.removedSentences).toBe(1);
  });

  it("unwraps rather than deletes when a human edited the paragraph", () => {
    const edited =
      `<p>You can find more information at ${anchor("Ottawapeptides")}. We ship Canada-wide.</p>`;
    const res = stripExchangeLinks(INTRO + edited + REST);

    expect(res.html).toBe(
      INTRO +
        "<p>You can find more information at Ottawapeptides. We ship Canada-wide.</p>" +
        REST,
    );
    expect(res.removedSentences).toBe(0);
    expect(res.unwrappedAnchors).toBe(1);
  });

  it("preserves the anchor's inner markup when unwrapping", () => {
    const inContent = `<p>Read the ${anchor("<em>full guide</em>")} before dosing.</p>`;
    const res = stripExchangeLinks(INTRO + inContent + REST);

    expect(res.html).toBe(
      INTRO + "<p>Read the <em>full guide</em> before dosing.</p>" + REST,
    );
    expect(res.unwrappedAnchors).toBe(1);
  });

  it("is idempotent — a second pass changes nothing", () => {
    const carrier = `<p>You can find more information at ${anchor("Ottawapeptides")}.</p>`;
    const once = stripExchangeLinks(INTRO + carrier + REST);
    const twice = stripExchangeLinks(once.html);

    expect(twice.html).toBe(once.html);
    expect(twice.removedSentences).toBe(0);
    expect(twice.unwrappedAnchors).toBe(0);
    expect(twice.unresolved).toBe(0);
  });

  it("leaves a body with no marker completely untouched", () => {
    const body = INTRO + REST;
    const res = stripExchangeLinks(body);

    expect(res.html).toBe(body);
    expect(res.removedSentences + res.unwrappedAnchors + res.unresolved).toBe(0);
  });

  it("does not let a '>' inside an href end the tag early", () => {
    // A legal (if ugly) href containing ">" — the naive [^>]* regex approach
    // swallows the rest of the document here. The quote-aware scanner must not.
    const href = "https://example.ca/search?q=a%3Eb&sort=>desc";
    const carrier =
      `<p>Learn more about <a href="${href}" data-nx-exch="${EDGE}">the guide</a>.</p>`;
    const res = stripExchangeLinks(INTRO + carrier + REST);

    expect(res.html).toBe(INTRO + REST);
    expect(res.removedSentences).toBe(1);
    expect(res.unresolved).toBe(0);
  });

  it("does not delete a neighbouring paragraph when the carrier is last", () => {
    const carrier = `<p>For additional context, ${anchor("more reading")}.</p>`;
    const res = stripExchangeLinks(INTRO + REST + carrier);

    expect(res.html).toBe(INTRO + REST);
    expect(res.removedSentences).toBe(1);
  });
});
