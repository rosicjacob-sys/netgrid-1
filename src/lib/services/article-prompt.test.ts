import { describe, it, expect } from "vitest";
import {
  renderSystemPrompt,
  resolveCodeNiche,
  type GenerateOptions,
} from "./content-generator";

function baseOpts(over: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    topic: "Storing reconstituted BPC-157 safely",
    keywords: ["how to store bpc 157"],
    wordCount: 1000,
    tone: "professional",
    niche: "peptides",
    blogSeed: "test:peptides",
    seoOptimized: true,
    ...over,
  };
}

function render(over: Partial<GenerateOptions> = {}): string {
  const opts = baseOpts(over);
  return renderSystemPrompt(opts, resolveCodeNiche(opts.niche));
}

/** Pull the JSON object out of the OUTPUT FORMAT block. */
function outputContract(prompt: string): string {
  const m = prompt.match(
    /Return ONLY valid JSON with EXACTLY these top-level keys:\n(\{[\s\S]*?\n\})\n/,
  );
  expect(m, "OUTPUT FORMAT block not found in the prompt").toBeTruthy();
  return m![1];
}

describe("article prompt — output contract", () => {
  // The brand rule is interpolated INTO the JSON example. Writing the brand
  // suffix with double quotes closes the surrounding JSON string value early
  // and hands the model a malformed object as its output contract — which is
  // exactly what it is being asked to return.
  it("is valid JSON with a brand configured", () => {
    const contract = outputContract(render({ brandName: "Montreal Peptides" }));
    expect(() => JSON.parse(contract)).not.toThrow();
    expect(contract).toContain("Montreal Peptides");
  });

  it("is valid JSON with no brand configured", () => {
    const contract = outputContract(render({ brandName: null }));
    expect(() => JSON.parse(contract)).not.toThrow();
    expect(contract).toContain("no configured brand name");
  });

  it("is valid JSON when the brand itself contains a quote or apostrophe", () => {
    const contract = outputContract(render({ brandName: `Joe's "Best" Peptides` }));
    expect(() => JSON.parse(contract)).not.toThrow();
  });

  it("declares the faq field so T20 has structured data to emit", () => {
    const parsed = JSON.parse(outputContract(render())) as Record<string, unknown>;
    expect(Object.keys(parsed)).toContain("faq");
    expect(Array.isArray(parsed.faq)).toBe(true);
  });
});

describe("article prompt — search brief leads", () => {
  it("opens with the search brief, not the voice rules", () => {
    expect(render()).toMatch(/^SEARCH BRIEF/);
  });

  it("names the target query and lists supplied questions", () => {
    const p = render({
      searchIntent: {
        targetQuery: "how to store bpc 157",
        relatedQuestions: ["Does it need refrigeration?", "How long does it last?"],
      },
    });
    expect(p).toContain("TARGET QUERY: how to store bpc 157");
    expect(p).toContain("1. Does it need refrigeration?");
    expect(p).toContain("2. How long does it last?");
  });

  it("refuses to manufacture questions when none were supplied", () => {
    expect(render()).toContain("none were supplied");
  });
});

describe("article prompt — facts policy replaces the fabrication mandate", () => {
  it("no longer mandates exact prices and concrete numbers", () => {
    // The old QUALITY BAR line told a model with NO retrieval of any kind to
    // produce "exact prices, real brand/tool names, concrete numbers".
    expect(render()).not.toContain("exact prices, real brand/tool names, concrete numbers");
  });

  it("restricts specifics to supplied reference material", () => {
    const p = render();
    expect(p).toContain("may ONLY come from reference material supplied to you");
  });
});

describe("article prompt — style rules survive the rewrite", () => {
  // The scrubber's blocklists still test for these exact words. Dropping them
  // from the prompt while keeping them in the detector would only raise the
  // flag rate.
  it("keeps the forbidden-vocabulary list in full", () => {
    const p = render();
    for (const word of ["delve", "tapestry", "plethora", "garner", "meticulous"]) {
      expect(p, `"${word}" dropped from the style appendix`).toContain(word);
    }
  });

  it("keeps the per-blog word band and quirks", () => {
    const p = render();
    expect(p).toMatch(/Minimum \d+ words/);
    expect(p).toMatch(/Maximum \d+ words/);
  });
});
