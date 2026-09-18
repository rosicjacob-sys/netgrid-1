import type {
  ArchetypeId,
  CompliancePlacement,
  FlowStep,
  StructuralTemplate,
  SubNicheId,
  TagSetId,
  TemplateId,
  WordTier,
} from "../types";

/**
 * 24 structural templates: 18 workhorse (T1–T18) + 6 weird (W19–W24).
 *
 * Each defines a `flow` of FlowStep entries with proportional word weights
 * (sum to 1.0). Skeleton S9 renders these as an explicit outline; other
 * skeletons render them as a comma-joined sequence.
 *
 * `voiceArchetypeFit` is the *positive* archetype filter; an empty array
 * means "all archetypes." The assignment algorithm intersects this with the
 * voice's sub-niche affinity.
 */

function flow(...steps: Array<[label: string, weight: number, guidance?: string]>): FlowStep[] {
  return steps.map(([label, approxWordsWeight, guidance]) => ({
    label,
    approxWordsWeight,
    guidance,
  }));
}

// ── Standard templates T1–T18 ──────────────────────────────────────────────

const STANDARD_TEMPLATES: StructuralTemplate[] = [
  {
    id: 1,
    code: "T1",
    name: "Classic explainer",
    kind: "workhorse",
    flow: flow(
      ["Opening hook", 0.10, "Pose the article's central question"],
      ["Background", 0.18, "Historical / research context"],
      ["Mechanism", 0.30, "How the compound works at cellular level"],
      ["Research findings", 0.25, "Studies published, what they reported"],
      ["Limitations", 0.10, "What's unknown or contested"],
      ["Closing observations", 0.07, "Synthesis, no platitudes"],
    ),
    wordTier: "medium",
    schemaFit: [1, 2],
    tagSetFit: [2, 3, 4, 5],
    subNicheFit: [1, 2, 3, 5, 7, 8, 11],
    voiceArchetypeFit: [],
    riskTier: "low",
  },
  {
    id: 2,
    code: "T2",
    name: "Compound profile",
    kind: "workhorse",
    flow: flow(
      ["What it is", 0.15, "Structure, class, source"],
      ["Mechanism", 0.25, "Receptor and pathway-level activity"],
      ["Research summary", 0.30, "Notable studies and their findings"],
      ["Practical considerations", 0.15, "Stability, formulation, handling — research context only"],
      ["Open questions", 0.15, "Where evidence remains weak"],
    ),
    wordTier: "medium",
    schemaFit: [1, 2],
    tagSetFit: [2, 3, 4],
    subNicheFit: [1, 2, 3, 5, 6, 7, 9, 11],
    voiceArchetypeFit: [],
    riskTier: "low",
  },
  {
    id: 3,
    code: "T3",
    name: "Mechanism deep-dive",
    kind: "workhorse",
    flow: flow(
      ["Mechanism overview", 0.12],
      ["Step 1 of cascade", 0.20],
      ["Step 2 of cascade", 0.20],
      ["Step 3+ of cascade", 0.20],
      ["Implications for outcomes", 0.18],
      ["Evidence quality summary", 0.10],
    ),
    wordTier: "medium_long",
    schemaFit: [1, 2],
    tagSetFit: [2, 3, 4, 5],
    subNicheFit: [1, 2, 3, 5, 7, 8],
    voiceArchetypeFit: [1, 4, 6, 7] as ArchetypeId[],
    riskTier: "low",
  },
  {
    id: 4,
    code: "T4",
    name: "Single-question essay",
    kind: "workhorse",
    flow: flow(
      ["The question", 0.10, "Articulate the central question"],
      ["Why it matters", 0.15, "Stakes / what hangs on the answer"],
      ["What the evidence says", 0.40, "Build the answer from evidence"],
      ["Counter-evidence", 0.15, "Steel-man the opposite view"],
      ["Synthesis", 0.20, "Where the weight of evidence falls"],
    ),
    wordTier: "medium",
    schemaFit: [1, 2],
    tagSetFit: [1, 2, 3, 4],
    subNicheFit: [1, 2, 3, 4, 5, 7, 8, 11],
    voiceArchetypeFit: [1, 4, 7] as ArchetypeId[],
    riskTier: "low",
  },
  {
    id: 5,
    code: "T5",
    name: "Comparison piece (two compounds)",
    kind: "workhorse",
    flow: flow(
      ["Why compare these two", 0.10],
      ["Compound A profile", 0.25],
      ["Compound B profile", 0.25],
      ["Head-to-head evidence", 0.25],
      ["Where each is studied more", 0.15, "Research-evidence framing, not recommendation"],
    ),
    wordTier: "medium_long",
    schemaFit: [1, 4],
    tagSetFit: [2, 3, 4, 5],
    subNicheFit: [1, 2, 3, 5, 6, 7],
    voiceArchetypeFit: [],
    riskTier: "medium",
    flowConflicts: [19, 22],
  },
  {
    id: 6,
    code: "T6",
    name: "Compound history",
    kind: "workhorse",
    flow: flow(
      ["Discovery", 0.18, "How and when discovered"],
      ["Early research era", 0.22],
      ["Modern research era", 0.30],
      ["Current research trajectory", 0.20],
      ["What comes next", 0.10],
    ),
    wordTier: "medium",
    schemaFit: [1, 2],
    tagSetFit: [2, 3],
    subNicheFit: [3, 7, 8, 10, 11, 12],
    voiceArchetypeFit: [1, 7, 10, 12] as ArchetypeId[],
    riskTier: "low",
  },
  {
    id: 7,
    code: "T7",
    name: "Annotated literature review",
    kind: "workhorse",
    flow: flow(
      ["Scope of this review", 0.10],
      ["Study 1: design + finding + significance", 0.18],
      ["Study 2: design + finding + significance", 0.18],
      ["Study 3: design + finding + significance", 0.18],
      ["Study 4+: design + finding + significance", 0.18],
      ["Synthesis", 0.10],
      ["Open questions", 0.08],
    ),
    wordTier: "long",
    schemaFit: [1, 2],
    tagSetFit: [2, 3, 4, 5],
    subNicheFit: [1, 2, 3, 7, 8],
    voiceArchetypeFit: [1, 4, 7] as ArchetypeId[],
    riskTier: "low",
  },
  {
    id: 8,
    code: "T8",
    name: "Beginner overview",
    kind: "workhorse",
    flow: flow(
      ["What is this compound", 0.18, "Definition for a true beginner"],
      ["What does the research show", 0.22],
      ["What's the current understanding", 0.18],
      ["What's still unclear", 0.15],
      ["Common questions about this", 0.27, "Mini-FAQ on common misconceptions"],
    ),
    wordTier: "short_medium",
    schemaFit: [1, 3],
    tagSetFit: [2, 5],
    subNicheFit: [1, 2, 3, 4, 7, 11],
    voiceArchetypeFit: [5] as ArchetypeId[],
    riskTier: "low",
  },
  {
    id: 9,
    code: "T9",
    name: "Misconception correction",
    kind: "workhorse",
    flow: flow(
      ["The misconception", 0.15, "State the common claim"],
      ["Where it came from", 0.15, "How the misconception originated"],
      ["What the research actually shows", 0.40],
      ["Why the misconception persists", 0.15],
      ["The current understanding", 0.15],
    ),
    wordTier: "medium",
    schemaFit: [1],
    tagSetFit: [2, 3, 4],
    subNicheFit: [1, 2, 3, 4, 5, 7, 8, 11],
    voiceArchetypeFit: [1, 4, 5, 11] as ArchetypeId[],
    riskTier: "low",
  },
  {
    id: 10,
    code: "T10",
    name: "Evidence-quality breakdown",
    kind: "workhorse",
    flow: flow(
      ["What we'd want to see", 0.15, "Ideal evidence for this claim"],
      ["What we have", 0.30],
      ["What's missing", 0.25],
      ["How to read it", 0.15],
      ["The honest answer", 0.15],
    ),
    wordTier: "medium",
    schemaFit: [1, 2],
    tagSetFit: [2, 3, 4, 5],
    subNicheFit: [1, 2, 3, 4, 5, 7, 8, 11],
    voiceArchetypeFit: [1, 4, 7, 11] as ArchetypeId[],
    riskTier: "low",
  },
  {
    id: 11,
    code: "T11",
    name: "Long-form essay",
    kind: "workhorse",
    flow: flow(
      ["Reflective opening", 0.10],
      ["Historical or philosophical context", 0.20],
      ["Mechanism / science core", 0.30],
      ["Implications", 0.20],
      ["Where the evidence ends", 0.10],
      ["Reflective close", 0.10],
    ),
    wordTier: "long",
    schemaFit: [1, 2],
    tagSetFit: [1, 2, 3],
    subNicheFit: [3, 7, 8, 11],
    voiceArchetypeFit: [1, 7, 10] as ArchetypeId[],
    riskTier: "low",
  },
  {
    id: 12,
    code: "T12",
    name: "News-explainer",
    kind: "workhorse",
    flow: flow(
      ["The news", 0.10, "What happened, when"],
      ["Context", 0.18, "What led up to it"],
      ["What it means", 0.30],
      ["Who's affected", 0.20],
      ["What to watch next", 0.22],
    ),
    wordTier: "short_medium",
    schemaFit: [1, 2],
    tagSetFit: [2, 3],
    subNicheFit: [4, 10],
    voiceArchetypeFit: [12, 11] as ArchetypeId[],
    riskTier: "low",
  },
  {
    id: 13,
    code: "T13",
    name: "Sub-niche overview",
    kind: "workhorse",
    flow: flow(
      ["What this sub-niche covers", 0.15],
      ["Key compounds in this area", 0.30],
      ["What the research consensus looks like", 0.30],
      ["Where the active research is", 0.15],
      ["Where the gaps are", 0.10],
    ),
    wordTier: "medium",
    schemaFit: [1, 4],
    tagSetFit: [2, 3, 4, 5],
    subNicheFit: [1, 2, 3, 4, 5, 6, 7, 8, 11, 12],
    voiceArchetypeFit: [],
    riskTier: "low",
  },
  {
    id: 14,
    code: "T14",
    name: "Numbered listicle",
    kind: "workhorse",
    flow: flow(
      ["Framing intro", 0.12],
      ["Item 1", 0.18],
      ["Item 2", 0.18],
      ["Item 3", 0.18],
      ["Item 4", 0.18],
      ["Closing synthesis", 0.16],
    ),
    wordTier: "short_medium",
    schemaFit: [4, 1],
    tagSetFit: [2, 3, 5],
    subNicheFit: [1, 2, 3, 4, 5, 6, 7, 11, 12],
    voiceArchetypeFit: [],
    riskTier: "low",
  },
  {
    id: 15,
    code: "T15",
    name: "Pros / limitations / open questions",
    kind: "workhorse",
    flow: flow(
      ["Compound intro", 0.12],
      ["What the research supports", 0.28],
      ["Limitations of current evidence", 0.25],
      ["Open questions", 0.20],
      ["How to interpret what's known", 0.15],
    ),
    wordTier: "medium",
    schemaFit: [1, 2],
    tagSetFit: [2, 3, 4],
    subNicheFit: [1, 2, 3, 4, 5, 7, 8, 11],
    voiceArchetypeFit: [1, 4] as ArchetypeId[],
    riskTier: "low",
  },
  {
    id: 16,
    code: "T16",
    name: "Case-series synthesis",
    kind: "workhorse",
    flow: flow(
      ["The clinical question", 0.10],
      ["Case 1 — design and finding", 0.20],
      ["Case 2 — design and finding", 0.20],
      ["Case 3 — design and finding", 0.20],
      ["What the series suggests", 0.18],
      ["Limits of case-series evidence", 0.12],
    ),
    wordTier: "medium_long",
    schemaFit: [1],
    tagSetFit: [2, 3, 4, 5],
    subNicheFit: [1, 5, 7, 9, 11],
    voiceArchetypeFit: [4, 9] as ArchetypeId[],
    riskTier: "medium",
  },
  {
    id: 17,
    code: "T17",
    name: "Translated foreign-research review",
    kind: "workhorse",
    flow: flow(
      ["Why this body of work matters", 0.12],
      ["The research school", 0.18, "E.g. St Petersburg Institute, Khavinson group"],
      ["Key findings 1", 0.20],
      ["Key findings 2", 0.20],
      ["How it relates to Western literature", 0.15],
      ["Open questions", 0.15],
    ),
    wordTier: "medium",
    schemaFit: [1, 2],
    tagSetFit: [2, 3],
    subNicheFit: [3, 7, 8, 11, 13],
    voiceArchetypeFit: [10] as ArchetypeId[],
    riskTier: "low",
  },
  {
    id: 18,
    code: "T18",
    name: "Industry / regulatory analysis",
    kind: "workhorse",
    flow: flow(
      ["The development", 0.10],
      ["Regulatory context", 0.20],
      ["Industry response", 0.25],
      ["What practitioners are watching", 0.20],
      ["Likely trajectory", 0.25],
    ),
    wordTier: "medium",
    schemaFit: [1, 2],
    tagSetFit: [2, 3],
    subNicheFit: [4, 9, 10, 12],
    voiceArchetypeFit: [11, 12] as ArchetypeId[],
    riskTier: "low",
  },
];

// ── Weird templates W19–W24 ────────────────────────────────────────────────

const WEIRD_TEMPLATES: StructuralTemplate[] = [
  {
    id: 19,
    code: "W1",
    name: "FAQ-Only Piece",
    kind: "weird",
    flow: flow(
      ["Framing intro (1-2 paragraphs)", 0.08],
      ["Q1 + answer", 0.10],
      ["Q2 + answer", 0.10],
      ["Q3 + answer", 0.10],
      ["Q4 + answer", 0.10],
      ["Q5 + answer", 0.10],
      ["Q6 + answer", 0.10],
      ["Q7 + answer", 0.10],
      ["Q8+ + answer", 0.22, "Continue Q&A pattern; 8-15 total Q/A pairs"],
    ),
    wordTier: "short_medium",
    schemaFit: [3],
    tagSetFit: [2, 5],
    subNicheFit: [1, 2, 3, 4, 5, 7, 8, 11],
    voiceArchetypeFit: [5] as ArchetypeId[],
    riskTier: "low",
  },
  {
    id: 20,
    code: "W2",
    name: "Q&A Interview Format",
    kind: "weird",
    flow: flow(
      ["Framing intro — who the (composite/fictional) researcher is", 0.10, "Composite or fictional researcher persona — never real attribution"],
      ["Q1 — exchange", 0.15],
      ["Q2 — exchange", 0.15],
      ["Q3 — exchange", 0.15],
      ["Q4 — exchange", 0.15],
      ["Q5 — exchange", 0.15],
      ["Closing summary", 0.15],
    ),
    wordTier: "medium_long",
    schemaFit: [1],
    tagSetFit: [1, 2, 3],
    subNicheFit: [1, 2, 3, 4, 5, 7, 8, 11],
    voiceArchetypeFit: [12] as ArchetypeId[],
    riskTier: "medium",
  },
  {
    id: 21,
    code: "W3",
    name: "Glossary-Style Reference",
    kind: "weird",
    flow: flow(
      ["Framing intro", 0.08],
      ["Term 1: definition / context", 0.13],
      ["Term 2: definition / context", 0.13],
      ["Term 3: definition / context", 0.13],
      ["Term 4: definition / context", 0.13],
      ["Term 5: definition / context", 0.13],
      ["Term 6+: definition / context", 0.27, "Continue until 8-12 terms covered"],
    ),
    wordTier: "medium",
    schemaFit: [1, 4],
    tagSetFit: [2, 5],
    subNicheFit: [1, 2, 3, 5, 8, 11],
    voiceArchetypeFit: [5] as ArchetypeId[],
    riskTier: "low",
  },
  {
    id: 22,
    code: "W4",
    name: "Annotated Study Breakdown",
    kind: "weird",
    flow: flow(
      ["Introduction — why this study", 0.08],
      ["Methods", 0.20, "Design, subjects, intervention, measurements"],
      ["Results", 0.20, "Specific reported findings"],
      ["Discussion — what authors concluded", 0.18],
      ["Annotated critique", 0.20, "What the design supports vs doesn't"],
      ["Implications and limits", 0.14],
    ),
    wordTier: "medium_long",
    schemaFit: [1, 2],
    tagSetFit: [2, 3, 4, 5],
    subNicheFit: [1, 2, 3, 4, 5, 7, 8],
    voiceArchetypeFit: [1, 4, 6, 7] as ArchetypeId[],
    riskTier: "medium",
    flowConflicts: [5],
  },
  {
    id: 23,
    code: "W5",
    name: "Reconstitution / Dosing-Math Technical Guide",
    kind: "weird",
    flow: flow(
      ["Compliance framing", 0.10, "Research-protocol framing only"],
      ["What reconstitution requires", 0.20],
      ["Dose-math worked example from a published protocol", 0.30],
      ["Stability considerations", 0.20],
      ["Common pitfalls described in literature", 0.15],
      ["Compliance closing", 0.05],
    ),
    wordTier: "medium",
    schemaFit: [1, 2],
    tagSetFit: [4, 5],
    subNicheFit: [9, 8],
    voiceArchetypeFit: [6] as ArchetypeId[],
    riskTier: "high",
    compliancePlacementOverride: "TOP_AND_BOTTOM" as CompliancePlacement,
  },
  {
    id: 24,
    code: "W6",
    name: "Reading List / Curation",
    kind: "weird",
    flow: flow(
      ["Framing — why this reading list", 0.12],
      ["Paper 1 — citation + annotation", 0.16],
      ["Paper 2 — citation + annotation", 0.16],
      ["Paper 3 — citation + annotation", 0.16],
      ["Paper 4 — citation + annotation", 0.16],
      ["Paper 5+ — citation + annotation", 0.16, "Continue to 4-8 papers"],
      ["Closing synthesis", 0.08],
    ),
    wordTier: "medium_long",
    schemaFit: [1, 4],
    tagSetFit: [2, 3, 5],
    subNicheFit: [1, 2, 3, 7, 8, 11, 12],
    voiceArchetypeFit: [1, 4, 7, 12] as ArchetypeId[],
    riskTier: "low",
  },
];

const ALL_TEMPLATES_ARRAY = [...STANDARD_TEMPLATES, ...WEIRD_TEMPLATES];

if (ALL_TEMPLATES_ARRAY.length !== 24) {
  throw new Error(`Expected 24 templates, got ${ALL_TEMPLATES_ARRAY.length}`);
}

export const TEMPLATES: Record<TemplateId, StructuralTemplate> = (() => {
  const o: Record<TemplateId, StructuralTemplate> = {};
  for (const t of ALL_TEMPLATES_ARRAY) {
    o[t.id] = t;
  }
  return o;
})();

export const TEMPLATE_IDS: TemplateId[] = ALL_TEMPLATES_ARRAY.map((t) => t.id);
export const WORKHORSE_IDS: TemplateId[] = STANDARD_TEMPLATES.map((t) => t.id);
export const WEIRD_IDS: TemplateId[] = WEIRD_TEMPLATES.map((t) => t.id);

export function templateById(id: TemplateId): StructuralTemplate {
  return TEMPLATES[id];
}

// ── Word band mapping for Phase 11 ─────────────────────────────────────────

export const WORD_BANDS: Record<WordTier, [number, number]> = {
  short:        [600, 1100],
  short_medium: [800, 1500],
  medium:       [1000, 2000],
  medium_long:  [1400, 2500],
  long:         [1800, 3000],
};

export function wordBandForTier(tier: WordTier): [number, number] {
  return WORD_BANDS[tier];
}

/**
 * Sub-niche → tag-set affinity overrides for Phase 5.
 * Reconstitution sub-niche (9) forces tag set 4 or 5.
 */
export const SUB_NICHE_TAG_SET_OVERRIDES: Partial<Record<SubNicheId, TagSetId[]>> = {
  9: [4, 5],
};

/**
 * Tag set 6 excluded when cadence is forum-energy (cadence 7).
 */
export const TAG_SET_EXCLUDED_FOR_CADENCE: Partial<Record<number, TagSetId[]>> = {
  7: [5],
};

// ── Cross-niche flow variants ──────────────────────────────────────────────
//
// Every `subNicheFit` list above covers peptide sub-niches 1-13 only, and
// several `flow` labels are peptide-specific ("Mechanism — How the compound
// works at cellular level"). A blog on a non-peptide sub-niche (14-90) needs
// BOTH a template it is allowed to draw AND section labels that make sense
// for its subject.
//
// The map below is the second half of that: for each template that
// generalises, a subject-agnostic rewrite of its flow. Step COUNT and step
// WEIGHTS are identical to the peptide flow above, so the word-budget maths
// in renderFlowAsOutline is unchanged; only labels and guidance differ.
//
// A template with no entry here is peptide-only by nature and is excluded
// from the cross-niche pool: T17 (Russian translation review) and W23
// (reconstitution / dose maths).
export const CROSS_NICHE_FLOWS: Partial<Record<TemplateId, FlowStep[]>> = {
  1: flow(
    ["Opening hook", 0.10, "Pose the article's central question"],
    ["Background", 0.18, "How the subject got to where it is; context the reader needs"],
    ["How it works", 0.30, "The underlying mechanism or process, explained at working level"],
    ["What the evidence shows", 0.25, "Published data, reported results, who reported them"],
    ["Limitations", 0.10, "What is unknown, contested, or situation-dependent"],
    ["Closing observations", 0.07, "Synthesis, no platitudes"],
  ),
  2: flow(
    ["What it is", 0.15, "Definition, category, origin"],
    ["How it works", 0.25, "The mechanism or process behind it"],
    ["What the record shows", 0.30, "Notable findings, results, reported outcomes"],
    ["Practical considerations", 0.15, "Cost, availability, handling, constraints"],
    ["Open questions", 0.15, "Where the evidence remains weak"],
  ),
  3: flow(
    ["Process overview", 0.12],
    ["Step 1 of the sequence", 0.20],
    ["Step 2 of the sequence", 0.20],
    ["Step 3+ of the sequence", 0.20],
    ["Implications for outcomes", 0.18],
    ["Evidence quality summary", 0.10],
  ),
  4: flow(
    ["The question", 0.10, "Articulate the central question"],
    ["Why it matters", 0.15, "Stakes / what hangs on the answer"],
    ["What the evidence says", 0.40, "Build the answer from evidence"],
    ["Counter-evidence", 0.15, "Steel-man the opposite view"],
    ["Synthesis", 0.20, "Where the weight of evidence falls"],
  ),
  5: flow(
    ["Why compare these two", 0.10],
    ["Option A profile", 0.25],
    ["Option B profile", 0.25],
    ["Head-to-head evidence", 0.25],
    ["Where each one fits", 0.15, "Evidence framing, not a blanket recommendation"],
  ),
  6: flow(
    ["Origins", 0.18, "How and when it started"],
    ["The early era", 0.22],
    ["The modern era", 0.30],
    ["Current trajectory", 0.20],
    ["What comes next", 0.10],
  ),
  7: flow(
    ["Scope of this review", 0.10],
    ["Source 1: what it examined, what it found, why it matters", 0.18],
    ["Source 2: what it examined, what it found, why it matters", 0.18],
    ["Source 3: what it examined, what it found, why it matters", 0.18],
    ["Source 4+: what it examined, what it found, why it matters", 0.18],
    ["Synthesis", 0.10],
    ["Open questions", 0.08],
  ),
  8: flow(
    ["What this is", 0.18, "Definition for a true beginner"],
    ["What the evidence shows", 0.22],
    ["What the current understanding is", 0.18],
    ["What is still unclear", 0.15],
    ["Common questions about this", 0.27, "Mini-FAQ on common misconceptions"],
  ),
  9: flow(
    ["The misconception", 0.15, "State the common claim"],
    ["Where it came from", 0.15, "How the misconception originated"],
    ["What the evidence actually shows", 0.40],
    ["Why the misconception persists", 0.15],
    ["The current understanding", 0.15],
  ),
  10: flow(
    ["What we would want to see", 0.15, "Ideal evidence for this claim"],
    ["What we have", 0.30],
    ["What is missing", 0.25],
    ["How to read it", 0.15],
    ["The honest answer", 0.15],
  ),
  11: flow(
    ["Reflective opening", 0.10],
    ["Historical or cultural context", 0.20],
    ["How it actually works", 0.30],
    ["Implications", 0.20],
    ["Where the evidence ends", 0.10],
    ["Reflective close", 0.10],
  ),
  12: flow(
    ["The news", 0.10, "What happened, when"],
    ["Context", 0.18, "What led up to it"],
    ["What it means", 0.30],
    ["Who is affected", 0.20],
    ["What to watch next", 0.22],
  ),
  13: flow(
    ["What this area covers", 0.15],
    ["The main options, players, or ideas in it", 0.30],
    ["Where the consensus currently sits", 0.30],
    ["Where the activity is", 0.15],
    ["Where the gaps are", 0.10],
  ),
  14: flow(
    ["Framing intro", 0.12],
    ["Item 1", 0.18],
    ["Item 2", 0.18],
    ["Item 3", 0.18],
    ["Item 4", 0.18],
    ["Closing synthesis", 0.16],
  ),
  15: flow(
    ["Subject intro", 0.12],
    ["What the evidence supports", 0.28],
    ["Limitations of the current evidence", 0.25],
    ["Open questions", 0.20],
    ["How to interpret what is known", 0.15],
  ),
  16: flow(
    ["The question these cases raise", 0.10],
    ["Case 1 — situation and outcome", 0.20],
    ["Case 2 — situation and outcome", 0.20],
    ["Case 3 — situation and outcome", 0.20],
    ["What the set suggests", 0.18],
    ["Limits of reasoning from a handful of cases", 0.12],
  ),
  // 17 — peptide-only (Khavinson / St Petersburg translation review).
  18: flow(
    ["The development", 0.10],
    ["Regulatory context", 0.20],
    ["Industry response", 0.25],
    ["What practitioners are watching", 0.20],
    ["Likely trajectory", 0.25],
  ),
  19: flow(
    ["Framing intro (1-2 paragraphs)", 0.08],
    ["Q1 + answer", 0.10],
    ["Q2 + answer", 0.10],
    ["Q3 + answer", 0.10],
    ["Q4 + answer", 0.10],
    ["Q5 + answer", 0.10],
    ["Q6 + answer", 0.10],
    ["Q7 + answer", 0.10],
    ["Q8+ + answer", 0.22, "Continue the Q/A pattern; 8-15 total Q/A pairs"],
  ),
  20: flow(
    ["Framing intro — who the (composite/fictional) practitioner is", 0.10, "Composite or fictional persona — never real attribution"],
    ["Q1 — exchange", 0.15],
    ["Q2 — exchange", 0.15],
    ["Q3 — exchange", 0.15],
    ["Q4 — exchange", 0.15],
    ["Q5 — exchange", 0.15],
    ["Closing summary", 0.15],
  ),
  21: flow(
    ["Framing intro", 0.08],
    ["Term 1: definition / context", 0.13],
    ["Term 2: definition / context", 0.13],
    ["Term 3: definition / context", 0.13],
    ["Term 4: definition / context", 0.13],
    ["Term 5: definition / context", 0.13],
    ["Term 6+: definition / context", 0.27, "Continue until 8-12 terms are covered"],
  ),
  22: flow(
    ["Introduction — why this source", 0.08],
    ["Method", 0.20, "How the work was done: scope, sample, approach, measurements"],
    ["Results", 0.20, "The specific reported findings"],
    ["Discussion — what the authors concluded", 0.18],
    ["Annotated critique", 0.20, "What the method supports and what it does not"],
    ["Implications and limits", 0.14],
  ),
  // 23 — peptide-only (reconstitution and dose maths).
  24: flow(
    ["Framing — why this reading list", 0.12],
    ["Source 1 — citation + annotation", 0.16],
    ["Source 2 — citation + annotation", 0.16],
    ["Source 3 — citation + annotation", 0.16],
    ["Source 4 — citation + annotation", 0.16],
    ["Source 5+ — citation + annotation", 0.16, "Continue to 4-8 sources"],
    ["Closing synthesis", 0.08],
  ),
};

/**
 * Templates a non-peptide blog is allowed to draw — the 22 that carry a
 * cross-niche flow variant (all but T17 and W23). Used as the
 * sub-niche-agnostic floor of buildStructuralPool's tier ladder.
 */
export const CROSS_NICHE_TEMPLATE_IDS: TemplateId[] = TEMPLATE_IDS.filter(
  (id) => CROSS_NICHE_FLOWS[id] !== undefined,
);

/** True for the 13 original peptide sub-niches. */
export function isPeptideSubNiche(subNiche: SubNicheId): boolean {
  return subNiche <= 13;
}

/**
 * The flow the composer should render for this template on this sub-niche.
 * Peptide sub-niches always get the original peptide flow; everything else
 * gets the neutral variant when one exists, falling back to the original.
 */
export function flowForSubNiche(
  template: StructuralTemplate,
  subNiche: SubNicheId,
): FlowStep[] {
  if (isPeptideSubNiche(subNiche)) return template.flow;
  return CROSS_NICHE_FLOWS[template.id] ?? template.flow;
}
