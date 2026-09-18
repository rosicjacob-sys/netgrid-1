import { describe, it, expect } from "vitest";
import { assignProfile, buildNetworkState } from "./algorithm";
import { composeForPost, KNOWN_PLACEHOLDER_TOKENS } from "../composer/compose";
import { archetypeForVoice } from "../libraries/archetypes";
import {
  BLOCK_AI_TELLS,
  BLOCK_CITATIONS,
  BLOCK_COMPLIANCE,
  BLOCK_COMPLIANCE_BRIEF,
  BLOCK_COMPLIANCE_BRIEF_NO_PHRASES,
  BLOCK_COMPLIANCE_NO_PHRASES,
  BLOCK_OUTPUT_FORMAT,
} from "../libraries/ai-tells";
import {
  isSkeletonCompatibleWithSubNiche,
  isSkeletonCompatibleWithVoice,
} from "../libraries/compatibility";
import { NICHES } from "../libraries/niches";
import { SKELETONS, SKELETON_IDS } from "../libraries/skeletons";
import { CROSS_NICHE_TEMPLATE_IDS, TEMPLATES } from "../libraries/templates";
import { VOICES, VOICE_IDS } from "../libraries/voices";
import type { StyleProfile } from "../types";

const NICHE_KEYS = Object.keys(NICHES);
const BLOGS_PER_NICHE = 25;

/** Assign N profiles in one niche against a growing network, as production does. */
function assignMany(nicheKey: string, n: number): StyleProfile[] {
  const out: StyleProfile[] = [];
  for (let i = 0; i < n; i++) {
    const ns = buildNetworkState(out);
    out.push(
      assignProfile(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, ns, {
        nicheKey,
      }),
    );
  }
  return out;
}

describe("archetypeForVoice", () => {
  it("returns the archetype each voice declares, for all 127 voices", () => {
    for (const id of VOICE_IDS) {
      expect(archetypeForVoice(id)).toBe(VOICES[id].archetype);
    }
  });

  it("still resolves the peptide voiceRange bands", () => {
    expect(archetypeForVoice(1)).toBe(1);
    expect(archetypeForVoice(44)).toBe(6);
    expect(archetypeForVoice(77)).toBe(12);
  });

  it("no longer collapses the cross-niche voices onto archetype 1", () => {
    const crossNiche = VOICE_IDS.filter((id) => id >= 78);
    const distinct = new Set(crossNiche.map((id) => archetypeForVoice(id)));
    expect(crossNiche.length).toBe(50);
    expect(distinct.size).toBeGreaterThan(1);
  });
});

describe("structural pools", () => {
  it("is never empty, for any registered niche", () => {
    for (const nicheKey of NICHE_KEYS) {
      for (const p of assignMany(nicheKey, BLOGS_PER_NICHE)) {
        expect(
          p.structuralPool.length,
          `${nicheKey} / sub-niche ${p.subNicheId} got an empty pool`,
        ).toBeGreaterThanOrEqual(3);
        for (const id of p.structuralPool) {
          expect(TEMPLATES[id], `unknown template id ${id}`).toBeDefined();
        }
      }
    }
  });

  it("gives non-peptide blogs only templates that carry a neutral flow", () => {
    for (const nicheKey of NICHE_KEYS.filter((k) => k !== "peptides")) {
      for (const p of assignMany(nicheKey, BLOGS_PER_NICHE)) {
        for (const id of p.structuralPool) {
          expect(
            CROSS_NICHE_TEMPLATE_IDS,
            `${nicheKey} drew peptide-only template ${id}`,
          ).toContain(id);
        }
      }
    }
  });

  it("does not put the same single template on every non-peptide blog", () => {
    const seen = new Set<number>();
    for (const nicheKey of NICHE_KEYS.filter((k) => k !== "peptides")) {
      for (const p of assignMany(nicheKey, BLOGS_PER_NICHE)) {
        for (const id of p.structuralPool) seen.add(id);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });
});

describe("skeleton compatibility guards", () => {
  it("never assigns a skeleton that fails the voice or sub-niche guard", () => {
    for (const nicheKey of NICHE_KEYS) {
      for (const p of assignMany(nicheKey, BLOGS_PER_NICHE)) {
        expect(isSkeletonCompatibleWithVoice(p.skeletonId, p.voiceId)).toBe(true);
        expect(
          isSkeletonCompatibleWithSubNiche(p.skeletonId, p.subNicheId),
          `${nicheKey} sub ${p.subNicheId} got skeleton ${p.skeletonId}`,
        ).toBe(true);
      }
    }
  });

  it("keeps the peptide-only skeleton 11 off non-peptide blogs", () => {
    for (const nicheKey of NICHE_KEYS.filter((k) => k !== "peptides")) {
      for (const p of assignMany(nicheKey, BLOGS_PER_NICHE)) {
        expect(p.skeletonId).not.toBe(11);
      }
    }
  });

  it("widens the reachable skeleton set for cross-niche voices past 7", () => {
    const reachable = new Set<number>();
    for (const id of VOICE_IDS.filter((v) => v >= 78)) {
      for (const s of SKELETON_IDS) {
        if (isSkeletonCompatibleWithVoice(s, id)) reachable.add(s);
      }
    }
    expect(reachable.size).toBeGreaterThan(7);
  });
});

describe("composed prompt", () => {
  const TOPICS: Record<string, string> = {
    roofing: "Metal versus asphalt shingles in a freeze-thaw climate",
    loans: "How lenders actually price a personal loan",
    web_dev: "When server components are the wrong choice",
    online_casino: "How wagering requirements change a bonus's real value",
    peptides: "BPC-157 and tendon repair: what the evidence supports",
  };

  it("substitutes every known placeholder token", () => {
    for (const nicheKey of NICHE_KEYS) {
      const topic = TOPICS[nicheKey] ?? "A representative topic for this niche";
      for (const profile of assignMany(nicheKey, 8)) {
        const { systemPrompt } = composeForPost({
          profile,
          topic,
          nicheLabel: nicheKey,
        });
        for (const token of KNOWN_PLACEHOLDER_TOKENS) {
          expect(
            systemPrompt.includes(token),
            `${nicheKey} skeleton ${profile.skeletonId} left ${token} unsubstituted`,
          ).toBe(false);
        }
      }
    }
  });

  it("never emits the compliance placeholder sentence", () => {
    for (const nicheKey of NICHE_KEYS) {
      for (const profile of assignMany(nicheKey, 8)) {
        const { systemPrompt } = composeForPost({
          profile,
          topic: TOPICS[nicheKey] ?? "A representative topic",
          nicheLabel: nicheKey,
        });
        expect(systemPrompt).not.toContain("no compliance phrase required");
        // No orphaned instruction left behind by the suppression.
        expect(systemPrompt).not.toMatch(/include (at least )?one of\s*(at|$)/i);
      }
    }
  });

  it("keeps peptide vocabulary out of non-peptide prompts", () => {
    for (const nicheKey of ["roofing", "loans", "online_casino", "web_dev"]) {
      for (const profile of assignMany(nicheKey, 12)) {
        const { systemPrompt } = composeForPost({
          profile,
          topic: TOPICS[nicheKey] ?? "A representative topic",
          nicheLabel: nicheKey,
        });
        expect(systemPrompt.toLowerCase()).not.toContain("peptide");
        expect(systemPrompt).not.toContain("at cellular level");
      }
    }
  });

  it("still renders the peptide flow for peptide blogs", () => {
    const hits = assignMany("peptides", 40)
      .map(
        (profile) =>
          composeForPost({ profile, topic: TOPICS.peptides }).systemPrompt,
      )
      .filter((s) => /compound|research findings|mechanism/i.test(s));
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("placeholder vocabulary", () => {
  const TOKEN_RE = /\{[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\}/gi;

  it("every token used by a skeleton or a shared block is substitutable", () => {
    const sources: Array<[string, string]> = [
      ...SKELETON_IDS.map(
        (id) => [`skeleton ${id}`, SKELETONS[id].body] as [string, string],
      ),
      ["BLOCK_AI_TELLS", BLOCK_AI_TELLS],
      ["BLOCK_OUTPUT_FORMAT", BLOCK_OUTPUT_FORMAT],
      ["BLOCK_COMPLIANCE", BLOCK_COMPLIANCE],
      ["BLOCK_COMPLIANCE_BRIEF", BLOCK_COMPLIANCE_BRIEF],
      ["BLOCK_COMPLIANCE_NO_PHRASES", BLOCK_COMPLIANCE_NO_PHRASES],
      ["BLOCK_COMPLIANCE_BRIEF_NO_PHRASES", BLOCK_COMPLIANCE_BRIEF_NO_PHRASES],
      ["BLOCK_CITATIONS", BLOCK_CITATIONS],
    ];
    for (const [label, text] of sources) {
      for (const token of text.match(TOKEN_RE) ?? []) {
        expect(
          KNOWN_PLACEHOLDER_TOKENS,
          `${label} references ${token}, which the composer cannot substitute`,
        ).toContain(token);
      }
    }
  });
});
