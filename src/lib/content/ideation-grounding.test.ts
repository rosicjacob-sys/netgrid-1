import { describe, it, expect } from "vitest";
import {
  buildIdeationKeywords,
  cleanSupportingQueries,
} from "@/lib/services/content-generator";
import { normalizeQueryKey, titleSimilarity } from "./topic-similarity";

describe("buildIdeationKeywords", () => {
  const candidate = {
    query: "bpc 157 dosage",
    demand: 2400,
    difficulty: 31,
    source: "dataforseo",
    rank: 0,
  };

  it("always puts the selected candidate query first, verbatim", () => {
    // The SOP's load-bearing invariant: keywords[0] === primaryQuery, byte for
    // byte. A mis-localised keyword pool then shows up in the published post
    // instead of being laundered into fluent prose by the model.
    const out = buildIdeationKeywords(candidate, ["tendon repair peptide", "bpc dosing"]);
    expect(out[0]).toBe("bpc 157 dosage");
  });

  it("does not let the model's list displace or duplicate the candidate", () => {
    const out = buildIdeationKeywords(candidate, ["BPC 157 Dosage", "bpc dosing"]);
    expect(out[0]).toBe("bpc 157 dosage");
    // Case-insensitive dedupe — the model echoing the query back must not
    // produce two slots for the same term.
    expect(out.filter((k) => k.toLowerCase() === "bpc 157 dosage")).toHaveLength(1);
  });

  it("caps at 4 keywords", () => {
    const out = buildIdeationKeywords(candidate, ["a", "b", "c", "d", "e", "f"]);
    expect(out).toHaveLength(4);
  });

  it("leaves the model's list alone on the ungrounded fallback path", () => {
    const out = buildIdeationKeywords(undefined, ["roof flashing repair", "ice damming"]);
    expect(out).toEqual(["roof flashing repair", "ice damming"]);
  });

  it("drops empty and whitespace-only entries", () => {
    const out = buildIdeationKeywords(undefined, ["", "   ", "real keyword", null]);
    expect(out).toEqual(["real keyword"]);
  });
});

describe("cleanSupportingQueries", () => {
  it("dedupes case-insensitively and clamps to 6", () => {
    const out = cleanSupportingQueries([
      "How long does it take?",
      "how long does it take?",
      "q2", "q3", "q4", "q5", "q6", "q7",
    ]);
    expect(out).toHaveLength(6);
    expect(out[0]).toBe("How long does it take?");
  });

  it("returns [] for a non-array, which is the ungrounded/absent case", () => {
    expect(cleanSupportingQueries(undefined)).toEqual([]);
    expect(cleanSupportingQueries("not an array")).toEqual([]);
    expect(cleanSupportingQueries(null)).toEqual([]);
  });

  it("drops empties and truncates over-long entries", () => {
    const out = cleanSupportingQueries(["", "  ", "x".repeat(300)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(200);
  });
});

describe("normalizeQueryKey / tokenize agreement", () => {
  // The backfill writes query_norm through normalizeQueryKey and the runtime
  // matches on it. If the two normalisation pipelines ever drift, the backfill
  // writes keys the runtime can never match and every blog silently starts
  // from an empty history again.
  it("collapses the accent/case/hyphen/spacing variants that titleSimilarity also collapses", () => {
    const pairs: Array<[string, string]> = [
      ["Créatine récupération", "Creatine recuperation"],
      ["BPC-157 Dosage", "bpc157   dosage"],
      ["L'entraînement", "l entrainement"],
    ];
    for (const [a, b] of pairs) {
      expect(normalizeQueryKey(a)).toBe(normalizeQueryKey(b));
      expect(titleSimilarity(a, b)).toBe(1);
    }
  });

  it("keeps genuinely different queries apart", () => {
    expect(normalizeQueryKey("bpc 157 dosage")).not.toBe(
      normalizeQueryKey("bpc 157 side effects"),
    );
  });
});
