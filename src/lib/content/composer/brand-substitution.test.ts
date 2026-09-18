import { describe, it, expect } from "vitest";
import { assignProfile, emptyNetworkState } from "../assignment/algorithm";
import { composeForPost } from "./compose";

describe("brand substitution ordering", () => {
  it("substitutes {brand} that arrives via {schema.json}", () => {
    const p = assignProfile("00000000-0000-4000-8000-0000000000aa", emptyNetworkState(), {
      nicheKey: "roofing",
    });
    const { systemPrompt } = composeForPost({
      profile: p,
      topic: "T",
      nicheLabel: "roofing",
      brandName: "Acme Roofing Co",
    });
    // The schema spec must actually have landed in the prompt...
    expect(systemPrompt).toContain("metaTitle");
    // ...and its {brand} token must be gone, replaced by the real brand.
    expect(systemPrompt).not.toContain("{brand}");
    expect(systemPrompt).toContain("Acme Roofing Co");
  });

  it("renders the sentinel when the blog has no brand", () => {
    const p = assignProfile("00000000-0000-4000-8000-0000000000ab", emptyNetworkState(), {
      nicheKey: "roofing",
    });
    const { systemPrompt } = composeForPost({ profile: p, topic: "T", nicheLabel: "roofing" });
    expect(systemPrompt).not.toContain("{brand}");
    expect(systemPrompt).toContain("omit the brand element entirely");
  });
});
