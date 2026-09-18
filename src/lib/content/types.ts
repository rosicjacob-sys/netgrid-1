/**
 * Shared types for the content-generation system.
 *
 * Every library file references these IDs as the canonical key into its
 * respective array. IDs are 1-indexed integers (not zero) to match how the
 * architecture spec was delivered — readers can pattern-match "voice V42"
 * directly to voices[42] without subtracting 1 mentally.
 */

// ─── Library IDs ────────────────────────────────────────────────────────────

export type SubNicheId =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13
  | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24
  | 25  // universal — for niches not in the registry
  | 26  // gym_franchise (openings / launches — short-lifespan)
  | 27  // roofing
  | 28  // tax_lawyer
  | 29  // pest_extermination
  | 30  // charity
  | 31  // gym_subscription (long-term membership comparisons)
  | 32  // online_casino (casino games — slots / poker / blackjack)
  | 33  // real_estate (residential + commercial property)
  // ── Per-niche topical sub-divisions (34-90) ───────────────────────────────
  // Each registered non-peptide niche gets 3 extra sub-niches so blogs in
  // the same niche don't all share one topical frame (a footprint at scale).
  | 34 | 35 | 36   // reputation_sites
  | 37 | 38 | 39   // gambling
  | 40 | 41 | 42   // apps_marketing
  | 43 | 44 | 45   // exclusive_models
  | 46 | 47 | 48   // ecom_nails
  | 49 | 50 | 51   // soccer_jersey
  | 52 | 53 | 54   // payment_processing
  | 55 | 56 | 57   // web_dev
  | 58 | 59 | 60   // app_dev
  | 61 | 62 | 63   // construction
  | 64 | 65 | 66   // loans
  | 67 | 68 | 69   // gym_franchise
  | 70 | 71 | 72   // roofing
  | 73 | 74 | 75   // tax_lawyer
  | 76 | 77 | 78   // pest_extermination
  | 79 | 80 | 81   // charity
  | 82 | 83 | 84   // gym_subscription
  | 85 | 86 | 87   // online_casino
  | 88 | 89 | 90;  // real_estate

export type ArchetypeId =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export type VoiceId = number; // 1..77
export type SkeletonId =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export type CadenceId =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14
  // Extended rhythm pool (15-24) — reachable by non-peptide niches so the
  // ~hundreds of cross-niche sites don't cluster on 14 sentence rhythms.
  | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24;

export type SchemaId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8; // A-H output shapes
export type TagSetId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type CitationStyleId = 1 | 2 | 3 | 4 | 5;
export type TemplateId = number; // 1..24 (T1-T18 standard, W19-W24 weird)
export type QuirkId = number; // 1..30
export type CompliancePhraseId = number; // 1..40

export type CompliancePlacement =
  | "TOP"
  | "BOTTOM"
  | "TOP_AND_BOTTOM"
  | "INLINE"
  | "ABOUT_ONLY"
  | "ROTATING";

export type ScrubberStrictness = "loose" | "standard" | "strict";

// ─── Locked profile (mirrors the styleProfiles table) ───────────────────────

/**
 * LLM-generated per-blog writing persona (Phase 3). When present on a profile,
 * composeForPost uses it for the {voice.*} prompt slots instead of the library
 * voice, giving the blog a unique generated voice.
 */
export interface GeneratedPersona {
  persona: string;
  registerSignature: string;
  examplePara1: string;
  examplePara2: string;
  toneNotes?: string;
  label?: string;
}

export interface StyleProfile {
  blogId: string;
  nicheKey: string;
  subNicheId: SubNicheId;
  voiceId: VoiceId;
  skeletonId: SkeletonId;
  cadenceId: CadenceId;
  quirks: QuirkId[]; // 2-3
  schemaId: SchemaId;
  tagSetId: TagSetId;
  citationStyleId: CitationStyleId;
  structuralPool: TemplateId[]; // 3-5
  compliancePhraseIds: CompliancePhraseId[]; // 2-3
  compliancePlacement: CompliancePlacement;
  wordBandMin: number;
  wordBandMax: number;
  scrubberStrictness: ScrubberStrictness;
  primaryCompounds: string[]; // 2
  secondaryCompounds: string[]; // 4
  assignmentSeed?: string;
  minHammingAtAssign?: number;
  /** Optional LLM-generated persona — overrides the library voice when set. */
  generatedPersona?: GeneratedPersona | null;
  /** Operator seed direction used to generate the persona (for regeneration). */
  generatedPersonaSeed?: string | null;
}

// ─── Library row shapes ─────────────────────────────────────────────────────

export interface SubNiche {
  id: SubNicheId;
  key: string; // "weight_loss_glp1"
  name: string; // "Weight loss / metabolic (GLP-1)"
  targetPct: number; // 14
  targetBlogs: number; // 280
  defaultStrictness?: ScrubberStrictness;
  thinCanon?: boolean; // sub-niches 6, 13
}

export interface CompoundCanonEntry {
  subNiche: SubNicheId;
  mode: "primary" | "broad";
  primary: string[];
  adjacent: string[]; // may be ["any"] or ["any_common"]
}

export interface Archetype {
  id: ArchetypeId;
  key: string; // "research_translator"
  name: string;
  description: string;
  voiceRange: [number, number]; // inclusive
  defaultStrictness: ScrubberStrictness;
}

export interface Voice {
  id: VoiceId;
  archetype: ArchetypeId;
  name: string;
  persona: string; // "{voice.persona}" — first-line identity
  registerSignature: string; // "{voice.register_signature}" — vocabulary/sentence shape
  defaultQuirkPool: QuirkId[]; // 4-8 quirk candidates
  compatibleCadences: CadenceId[];
  compatibleCitationStyles: CitationStyleId[];
  subNicheAffinity: SubNicheId[]; // sub-niches this voice can serve
  examplePara1?: string; // for S6 — fallback to S2 if missing
  examplePara2?: string;
}

export type SkeletonTokenCost = "low" | "medium" | "high";

export interface SkeletonAffinity {
  archetypes?: ArchetypeId[];
  avoidArchetypes?: ArchetypeId[];
  cadenceIds?: CadenceId[];
  avoidCadenceIds?: CadenceId[];
  schemaIds?: SchemaId[];
  templateIds?: TemplateId[];
  subNiches?: SubNicheId[];
  strictness?: ScrubberStrictness[];
  voiceIds?: VoiceId[];
}

export interface Skeleton {
  id: SkeletonId;
  name: string;
  distinctiveFeature: string;
  body: string; // template with {placeholders} + [BLOCK_*] markers
  sharedBlocks: SharedBlock[];
  affinity: SkeletonAffinity;
  requiresVoiceExamples: boolean;
  tokenCostTier: SkeletonTokenCost;
}

export type SharedBlock =
  | "AI_TELLS"
  | "OUTPUT_FORMAT"
  | "COMPLIANCE"
  | "COMPLIANCE_BRIEF"
  | "CITATIONS";

export type TemplateKind = "workhorse" | "weird";
export type WordTier = "short" | "short_medium" | "medium" | "medium_long" | "long";

export interface FlowStep {
  label: string;
  approxWordsWeight: number; // share of total word band
  guidance?: string;
}

export interface StructuralTemplate {
  id: TemplateId;
  code: string; // "T1" | "W3"
  name: string;
  kind: TemplateKind;
  flow: FlowStep[];
  wordTier: WordTier;
  schemaFit: SchemaId[];
  tagSetFit: TagSetId[];
  subNicheFit: SubNicheId[];
  voiceArchetypeFit: ArchetypeId[];
  riskTier: "low" | "medium" | "high";
  compliancePlacementOverride?: CompliancePlacement;
  flowConflicts?: TemplateId[];
}

export type QuirkCategory = "subtle" | "medium" | "highly_visible";

export interface Quirk {
  id: QuirkId;
  name: string;
  category: QuirkCategory;
  promptInstruction: string; // injected into {quirks[]}
  conflictsWith?: QuirkId[];
  /** Detector signature for Layer 2G — present means we can verify it. */
  detector?: (plainText: string, wordCount: number) => boolean;
}

export interface CadenceSpec {
  id: CadenceId;
  name: string;
  spec: string; // human-readable description for {cadence.spec}
  numbers: {
    avgWords: number;
    stdDev: number;
    shortExample: number;
    longExample: number;
    avgParagraph: number;
  };
  voiceDirection: string;
  transitionDensity: "none" | "low" | "medium" | "high";
}

export interface CitationStyleSpec {
  id: CitationStyleId;
  name: string;
  styleDescription: string; // for {citation.style_description}
  example: string; // for {citation.example}
  /** If false, citations are not verified at scrubber Layer 3. */
  verifiable: boolean;
}

export interface SchemaSpec {
  id: SchemaId;
  code: "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";
  name: string;
  jsonSpec: string; // pasted verbatim into {schema.json}
}

export interface TagSet {
  id: TagSetId;
  name: string;
  allowedTags: string[]; // e.g. ["h2","h3","p","ul","ol","li","strong","em","a"]
  description: string;
}

export interface CompliancePhrase {
  id: CompliancePhraseId;
  text: string;
  syntacticShape: string; // for the "at least 2 distinct shapes" constraint
  strictnessRequired?: ScrubberStrictness; // phrase 16 example
}

// ─── Network state (passed into the assignment algorithm) ───────────────────

export interface NetworkState {
  allProfiles: StyleProfile[];
  subNicheUsage: Map<SubNicheId, number>;
  voiceUsage: Map<VoiceId, number>;
  skeletonUsage: Map<SkeletonId, number>;
  cadenceUsage: Map<CadenceId, number>;
  cadenceUsageInSubNiche: Map<SubNicheId, Map<CadenceId, number>>;
  tagSetUsage: Map<TagSetId, number>;
  schemaUsage: Map<SchemaId, number>;
  citationStyleUsage: Map<CitationStyleId, number>;
  quirkPairUsage: Map<string, number>; // "q3,q7" -> count
  compliancePhraseUsage: Map<CompliancePhraseId, number>;
  placementUsage: Map<CompliancePlacement, number>;
  compoundUsage: Map<string, number>;
}
