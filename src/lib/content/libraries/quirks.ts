import type { Quirk, QuirkId } from "../types";

/**
 * 30 stylistic quirks. Categorized into:
 *   subtle (1-10)         — almost invisible per-post, identifiable in aggregate
 *   medium (11-20)        — noticeable but plausible from a human writer
 *   highly_visible (21-30) — signature tics that mark a blog clearly
 *
 * Assignment rules (Phase 8):
 *   - 2-3 quirks per blog
 *   - at least 1 from subtle
 *   - max 1 from highly_visible
 *   - no two with mutual conflicts (see conflictsWith)
 *
 * `detector` returns true if the quirk's signature is present in the prose.
 * Layer 2G uses this to flag missing quirks (the prompt didn't take).
 */

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m ? m.length : 0;
}

export const QUIRKS: Record<QuirkId, Quirk> = {
  // ── Subtle (1-10) ──────────────────────────────────────────────────────────
  1: {
    id: 1,
    name: "Sparing comma usage",
    category: "subtle",
    promptInstruction:
      "Use commas sparingly. Where most writers would use a comma to soften a sentence, you split the sentence instead.",
    detector: (text, wc) => countMatches(text, /,/g) / Math.max(wc, 1) * 1000 < 30,
  },
  2: {
    id: 2,
    name: "Inline parenthetical asides",
    category: "subtle",
    promptInstruction:
      "Use occasional parenthetical asides to qualify or specify (especially numerical specifics).",
    detector: (text, wc) =>
      countMatches(text, /\([^)]{3,}\)/g) / Math.max(wc, 1) * 1000 > 4,
  },
  3: {
    id: 3,
    name: "Em-dash-free",
    category: "subtle",
    promptInstruction:
      "Never use em-dashes or en-dashes as pauses. Use commas, parentheses, or sentence breaks instead.",
    conflictsWith: [21],
    detector: (text) => !/—/.test(text),
  },
  4: {
    id: 4,
    name: "Year-anchored references",
    category: "subtle",
    promptInstruction:
      "When referencing research, anchor it to a specific year ('a 2019 trial', 'the 2022 review').",
    detector: (text) => countMatches(text, /\b(19|20)\d{2}\b/g) >= 4,
  },
  5: {
    id: 5,
    name: "Compact opening sentence",
    category: "subtle",
    promptInstruction: "Open the article with a sentence under 15 words.",
  },
  6: {
    id: 6,
    name: "Trailing concrete number",
    category: "subtle",
    promptInstruction:
      "End at least one paragraph with a concrete number or specific unit (mg, days, %, n=).",
  },
  7: {
    id: 7,
    name: "Sentence-initial 'And' or 'But'",
    category: "subtle",
    promptInstruction:
      "Occasionally start a sentence with 'And' or 'But' — sparingly, only when it lands naturally.",
    detector: (text) => /(?:^|\.\s)(And|But)\s/.test(text),
  },
  8: {
    id: 8,
    name: "Inline definitions repeated",
    category: "subtle",
    promptInstruction:
      "When a compound is first mentioned in each major section, parenthesize the full name or category (e.g. BPC-157 (a 15-amino acid pentadecapeptide)).",
    detector: (text) => countMatches(text, /\([^)]*(?:peptide|amino acid|fragment|agonist)[^)]*\)/gi) >= 2,
  },
  9: {
    id: 9,
    name: "Numbered qualifier scale",
    category: "subtle",
    promptInstruction:
      "When evaluating evidence quality, use a 1-3 or 1-5 scale verbally ('this is a 2 of 3 on evidence quality').",
  },
  10: {
    id: 10,
    name: "Avoid 'just'",
    category: "subtle",
    promptInstruction:
      "Avoid the word 'just' as a hedge or minimizer. Prefer 'only' or omit.",
    detector: (text) => !/\bjust\b/i.test(text),
  },

  // ── Medium (11-20) ─────────────────────────────────────────────────────────
  11: {
    id: 11,
    name: "First-sentence question",
    category: "medium",
    promptInstruction: "Open the article with a question.",
    detector: (text) => {
      const firstPara = text.split(/\n\n/)[0] || "";
      return /\?/.test(firstPara);
    },
  },
  12: {
    id: 12,
    name: "One-sentence paragraph emphasis",
    category: "medium",
    promptInstruction: "Include at least two one-sentence paragraphs for emphasis.",
    detector: (text) => {
      const paragraphs = text.split(/\n\n+/);
      let count = 0;
      for (const p of paragraphs) {
        const sentences = p.match(/[.!?](?:\s|$)/g);
        if (sentences && sentences.length === 1) count++;
      }
      return count >= 2;
    },
  },
  13: {
    id: 13,
    name: "Mid-paragraph rhetorical pivot",
    category: "medium",
    promptInstruction:
      "Use a mid-paragraph rhetorical pivot occasionally ('Or maybe not.', 'Except — and this matters — …').",
  },
  14: {
    id: 14,
    name: "Specific dollar amounts",
    category: "medium",
    promptInstruction:
      "When discussing cost or commerce, reference specific dollar amounts ('$48 per vial', 'around $200 a month').",
  },
  15: {
    id: 15,
    name: "British spelling",
    category: "medium",
    promptInstruction:
      "Use British spelling consistently (analyse, behaviour, optimise, signalling).",
    detector: (text) => /\b(analyse|behaviour|optimise|signalling|colour)\b/i.test(text),
  },
  16: {
    id: 16,
    name: "Sentence-final preposition",
    category: "medium",
    promptInstruction:
      "Allow sentences to end with prepositions where natural ('what the research points to').",
  },
  17: {
    id: 17,
    name: "Hedged numerical ranges",
    category: "medium",
    promptInstruction:
      "When quoting numbers from research, use ranges with hedging ('something like 30-50%', 'in the neighbourhood of 200mcg').",
  },
  18: {
    id: 18,
    name: "Direct second-person occasional",
    category: "medium",
    promptInstruction:
      "Use direct second-person ('you') sparingly — once or twice per article maximum.",
  },
  19: {
    id: 19,
    name: "Section closes with question",
    category: "medium",
    promptInstruction:
      "Close at least one major section with an open question, not an answer.",
  },
  20: {
    id: 20,
    name: "Citing reviews not primary studies",
    category: "medium",
    promptInstruction:
      "When uncertain, prefer citing review articles or meta-analyses over individual primary studies.",
  },

  // ── Highly visible (21-30) ─────────────────────────────────────────────────
  21: {
    id: 21,
    name: "Aggressive em-dash usage",
    category: "highly_visible",
    promptInstruction:
      "Use em-dashes deliberately and frequently as a rhetorical device — sometimes mid-sentence — to interrupt the flow with parenthetical thought.",
    conflictsWith: [3],
  },
  22: {
    id: 22,
    name: "Russian-translation register",
    category: "highly_visible",
    promptInstruction:
      "Write with slight Eastern European register: occasional article-drop ('Research shows X is effective' → 'Research shows X effective'), 'denoted' instead of 'called', 'investigation' for 'study'.",
    detector: (text) => /\b(investigation|denoted)\b/i.test(text),
  },
  23: {
    id: 23,
    name: "Personal anecdote framing",
    category: "highly_visible",
    promptInstruction:
      "Open or close with a brief observational anecdote in research-frame ('A clinician I spoke with mentioned …', 'A 2023 case report described …'). Never first-person use.",
  },
  24: {
    id: 24,
    name: "Frequent footnote-style asides",
    category: "highly_visible",
    promptInstruction:
      "Use bracketed footnote-style asides [note: …] 2-4 times per article.",
    detector: (text) => countMatches(text, /\[(?:note|aside|fn)[:\s][^\]]+\]/gi) >= 2,
  },
  25: {
    id: 25,
    name: "Stock opening question",
    category: "highly_visible",
    promptInstruction:
      "Open every article with a question stated in a single sentence as its own paragraph.",
    conflictsWith: [5, 11],
    detector: (text) => {
      const firstPara = text.split(/\n\n/)[0] || "";
      return /\?$/.test(firstPara.trim());
    },
  },
  26: {
    id: 26,
    name: "Numbered list within prose",
    category: "highly_visible",
    promptInstruction:
      "Inline numbered enumerations within prose ('There are three reasons: 1) …, 2) …, 3) …').",
  },
  27: {
    id: 27,
    name: "Heavy bullet usage",
    category: "highly_visible",
    promptInstruction:
      "Use bulleted lists frequently — at least one list per major section.",
  },
  28: {
    id: 28,
    name: "Single-word emphatic paragraphs",
    category: "highly_visible",
    promptInstruction:
      "Use 1-2 single-word emphatic paragraphs in the article ('Maybe.', 'Probably not.').",
  },
  29: {
    id: 29,
    name: "Bracketed editor's note style",
    category: "highly_visible",
    promptInstruction:
      "Insert one or two italicized editor's-note style asides — '<em>(Editor's note: this point has been contested.)</em>'.",
  },
  30: {
    id: 30,
    name: "Concluding bullet summary",
    category: "highly_visible",
    promptInstruction:
      "Always close with a bulleted 'Quick takeaways' summary of 3-5 bullets.",
  },
};

export const QUIRK_IDS: QuirkId[] = Array.from({ length: 30 }, (_, i) => i + 1);

export function quirkById(id: QuirkId): Quirk {
  return QUIRKS[id];
}

export function quirksByCategory(cat: "subtle" | "medium" | "highly_visible"): QuirkId[] {
  return QUIRK_IDS.filter((id) => QUIRKS[id].category === cat);
}

export function quirksConflict(a: QuirkId, b: QuirkId): boolean {
  return (
    (QUIRKS[a].conflictsWith?.includes(b) ?? false) ||
    (QUIRKS[b].conflictsWith?.includes(a) ?? false)
  );
}

// ── Cross-niche quirk instructions ─────────────────────────────────────────
//
// A handful of promptInstruction strings above are written in peptide subject
// matter — quirk 8 names BPC-157 and "pentadecapeptide" outright, and several
// others reach for vials, mcg doses and clinicians. Those strings substitute
// into {quirks_rendered} on EVERY blog, so a roofing prompt was being told to
// parenthesize compound names and quote doses in micrograms.
//
// Same treatment as CROSS_NICHE_FLOWS in templates.ts: peptide sub-niches keep
// the original text byte-for-byte, everything else gets a subject-neutral
// rewrite. A quirk with no entry here is already subject-agnostic.
//
// The `detector` functions are deliberately NOT varied — they run over
// generated prose in the scrubber, and loosening them is a separate decision
// from what the prompt asks for.
const CROSS_NICHE_QUIRK_INSTRUCTIONS: Partial<Record<QuirkId, string>> = {
  6: "End at least one paragraph with a concrete number or specific unit (%, days, dollars, n=).",
  8: "When a term of art is first used in each major section, parenthesize a short plain-language gloss (e.g. ice damming (meltwater refreezing at the eaves)).",
  14: "When discussing cost or commerce, reference specific dollar amounts ('$48 a unit', 'around $200 a month').",
  17: "When quoting numbers from a source, use ranges with hedging ('something like 30-50%', 'in the neighbourhood of two hundred').",
  23: "Open or close with a brief observational anecdote in research-frame ('A practitioner I spoke with mentioned …', 'A 2023 case write-up described …'). Never first-person use.",
};

/**
 * The prompt instruction to render for this sub-niche. Peptide sub-niches
 * (1-13) keep the original; everything else gets the neutral rewrite when one
 * exists.
 */
export function quirkInstructionForSubNiche(
  id: QuirkId,
  subNiche: number,
): string | undefined {
  const quirk = QUIRKS[id];
  if (!quirk) return undefined;
  if (subNiche <= 13) return quirk.promptInstruction;
  return CROSS_NICHE_QUIRK_INSTRUCTIONS[id] ?? quirk.promptInstruction;
}
