import { describe, it, expect } from "vitest";
import {
  renderSearchBrief,
  renderReferenceFacts,
  resolveTargetQuery,
} from "./search-brief";

describe("resolveTargetQuery", () => {
  it("prefers the explicit target query", () => {
    expect(
      resolveTargetQuery({
        topic: "A long editorial topic sentence about storage",
        keywords: ["peptide storage"],
        searchIntent: { targetQuery: "how to store bpc 157" },
      }),
    ).toBe("how to store bpc 157");
  });

  it("falls back to local keyword, then first keyword, then topic", () => {
    expect(
      resolveTargetQuery({ topic: "t", keywords: ["kw"], localKeyword: "buy peptides" }),
    ).toBe("buy peptides");
    expect(resolveTargetQuery({ topic: "t", keywords: ["   ", "kw"] })).toBe("kw");
    expect(resolveTargetQuery({ topic: "t", keywords: [] })).toBe("t");
  });
});

describe("renderSearchBrief", () => {
  it("names the query, the intent, and every supplied question", () => {
    const brief = renderSearchBrief({
      topic: "Buying peptides in Montreal",
      keywords: ["buy peptides montreal"],
      searchIntent: {
        targetQuery: "buy peptides montreal",
        relatedQuestions: [
          "Is it legal to buy peptides in Canada?",
          "How long does shipping take?",
        ],
        entities: ["Health Canada"],
      },
    });
    expect(brief).toContain("TARGET QUERY: buy peptides montreal");
    expect(brief).toContain("SEARCH INTENT: transactional");
    expect(brief).toContain("1. Is it legal to buy peptides in Canada?");
    expect(brief).toContain("2. How long does shipping take?");
    expect(brief).toContain("Health Canada");
  });

  it("never invents questions when none were supplied", () => {
    const brief = renderSearchBrief({ topic: "Tendon repair research", keywords: [] });
    expect(brief).toContain("none were supplied");
    expect(brief).not.toMatch(/^\d+\. /m);
  });

  it("classifies a comparison query", () => {
    const brief = renderSearchBrief({ topic: "x", keywords: ["bpc 157 vs tb 500"] });
    expect(brief).toContain("SEARCH INTENT: comparison");
  });

  it("caps the question list so a long pool cannot swamp the prompt", () => {
    const brief = renderSearchBrief({
      topic: "x",
      keywords: ["q"],
      searchIntent: {
        targetQuery: "q",
        relatedQuestions: Array.from({ length: 20 }, (_, i) => `Question ${i + 1}?`),
      },
    });
    expect(brief).toContain("8. Question 8?");
    expect(brief).not.toContain("9. Question 9?");
  });

  it("drops blank and whitespace-only questions rather than numbering them", () => {
    const brief = renderSearchBrief({
      topic: "x",
      keywords: ["q"],
      searchIntent: {
        targetQuery: "q",
        relatedQuestions: ["", "   ", "A real question?"],
      },
    });
    expect(brief).toContain("1. A real question?");
    expect(brief).not.toContain("2.");
  });
});

describe("renderReferenceFacts", () => {
  it("is empty when nothing was supplied", () => {
    expect(renderReferenceFacts({ topic: "t", keywords: [] })).toBe("");
  });

  it("lists supplied facts verbatim", () => {
    const out = renderReferenceFacts({
      topic: "t",
      keywords: [],
      searchIntent: {
        targetQuery: "q",
        referenceFacts: ["A 5mg vial retails at CAD $54.99 (client price list, 2026-08)"],
      },
    });
    expect(out).toContain("CAD $54.99");
  });
});
