import type {
  StructuralTemplate,
  StyleProfile,
  SubNicheId,
  TemplateId,
} from "../types";
import { CADENCES } from "../libraries/cadences";
import {
  CITATION_STYLES,
  citationDescriptionForSubNiche,
  citationExampleForSubNiche,
} from "../libraries/citation-styles";
import { COMPLIANCE_PHRASES } from "../libraries/compliance-phrases";
import { quirkInstructionForSubNiche } from "../libraries/quirks";
import { SCHEMAS } from "../libraries/schemas";
import { SKELETONS } from "../libraries/skeletons";
import { SUB_NICHES } from "../libraries/sub-niches";
import { TAG_SETS } from "../libraries/tag-sets";
import {
  CROSS_NICHE_TEMPLATE_IDS,
  TEMPLATES,
  TEMPLATE_IDS,
  WEIRD_IDS,
  WORKHORSE_IDS,
  flowForSubNiche,
} from "../libraries/templates";
import { VOICES } from "../libraries/voices";
import { SeededRng } from "../assignment/draw-helpers";
import { inlineSharedBlocks } from "./shared-blocks";

/**
 * Per-post template selection from the blog's locked structural pool.
 *
 * Weights (from Batch 4 closeout):
 *   60% workhorse
 *   25% weird
 *   15% niche-natural (template explicitly fits the blog's sub-niche
 *        archetype)
 *
 * When a bucket is empty, weight redistributes proportionally to the others.
 */
export function pickTemplateForPost(
  rng: SeededRng,
  profile: StyleProfile,
): StructuralTemplate {
  const pool = profile.structuralPool ?? [];
  const workhorse = pool.filter((id) => WORKHORSE_IDS.includes(id));
  const weird = pool.filter((id) => WEIRD_IDS.includes(id));
  // "Niche-natural" = the template explicitly fits the blog's sub-niche.
  // subNicheFit only ever lists peptide sub-niches 1-13, so on a non-peptide
  // blog this bucket was ALWAYS empty and its 15% weight silently vanished.
  // For those blogs the natural set is the cross-niche template set.
  const nicheNatural = pool.filter((id) =>
    profile.subNicheId <= 13
      ? TEMPLATES[id].subNicheFit.includes(profile.subNicheId)
      : CROSS_NICHE_TEMPLATE_IDS.includes(id),
  );

  // Build weighted candidate set. A template can appear in multiple buckets,
  // so dedupe at pick time.
  const buckets: Array<{ ids: TemplateId[]; weight: number }> = [
    { ids: workhorse, weight: 0.60 },
    { ids: weird, weight: 0.25 },
    { ids: nicheNatural, weight: 0.15 },
  ];

  // Drop empty buckets and renormalise
  const active = buckets.filter((b) => b.ids.length > 0);
  if (active.length === 0) {
    // Pool is empty or corrupt. Before the assignment fix this was the NORMAL
    // path for every non-peptide blog, and returning TEMPLATES[1] put the same
    // six peptide-flavoured sections on every post they ever published. Draw
    // from the sub-niche-appropriate set instead, and make the anomaly visible
    // instead of silent.
    console.warn(
      `[composer] empty structuralPool for blog ${profile.blogId} ` +
        `(niche=${profile.nicheKey}, subNiche=${profile.subNicheId}). ` +
        `Run: npx tsx src/lib/db/repair-structural-pools.ts`,
    );
    const fallbackIds =
      profile.subNicheId <= 13 ? TEMPLATE_IDS : CROSS_NICHE_TEMPLATE_IDS;
    return TEMPLATES[fallbackIds[Math.floor(rng.next() * fallbackIds.length)]];
  }
  const totalWeight = active.reduce((sum, b) => sum + b.weight, 0);

  const r = rng.next() * totalWeight;
  let acc = 0;
  let chosenBucket = active[active.length - 1];
  for (const b of active) {
    acc += b.weight;
    if (r <= acc) {
      chosenBucket = b;
      break;
    }
  }

  const tid = chosenBucket.ids[Math.floor(rng.next() * chosenBucket.ids.length)];
  return TEMPLATES[tid];
}

// ─── Placeholder rendering ─────────────────────────────────────────────────

function renderFlow(
  template: StructuralTemplate,
  subNiche: SubNicheId,
): string {
  return flowForSubNiche(template, subNiche)
    .map((s, i) => `${i + 1}. ${s.label}`)
    .join(" → ");
}

function renderFlowAsOutline(
  template: StructuralTemplate,
  subNiche: SubNicheId,
  wordBandTotal: number,
): string {
  return flowForSubNiche(template, subNiche)
    .map((s, i) => {
      const approx = Math.round(s.approxWordsWeight * wordBandTotal);
      const g = s.guidance ? `: ${s.guidance}` : "";
      return `${i + 1}. ${s.label} (~${approx} words)${g}`;
    })
    .join("\n");
}

function renderQuirks(profile: StyleProfile): string {
  return profile.quirks
    .map((qid) => quirkInstructionForSubNiche(qid, profile.subNicheId))
    .filter((s): s is string => Boolean(s))
    .join(" / ");
}

/**
 * True when the profile carries at least one resolvable compliance phrase.
 * False for every niche with useCompliancePhrases: false in niches.ts — i.e.
 * everything except peptides, gambling and online_casino.
 */
function hasCompliancePhrases(profile: StyleProfile): boolean {
  const ids = profile.compliancePhraseIds ?? [];
  return ids.some((id) => Boolean(COMPLIANCE_PHRASES[id]?.text));
}

/**
 * Render the phrase list. Returns "" when there are none — callers must not
 * emit the surrounding instruction in that case.
 *
 * This used to return the literal "(no compliance phrase required for this
 * niche)", which BLOCK_COMPLIANCE then ordered the model to reproduce verbatim
 * while forbidding it to improvise an alternative.
 */
function renderCompliancePhrases(profile: StyleProfile): string {
  return (profile.compliancePhraseIds ?? [])
    .map((id) => COMPLIANCE_PHRASES[id]?.text)
    .filter((s): s is string => Boolean(s))
    .map((s) => `"${s}"`)
    .join(" OR ");
}

const COMPLIANCE_PHRASE_TOKEN = "{compliance.phrases_rendered}";

/**
 * Drop every LINE referencing the compliance-phrase token. Used when the niche
 * supplies no phrases: substituting an empty string instead would leave the
 * model reading "include one of  at BOTTOM".
 *
 * Must run BEFORE substitution — afterwards the token is gone.
 *
 * Every occurrence in the library is a standalone bullet or a self-contained
 * sentence, so removing the whole line always leaves valid prose. The two
 * shared blocks that reference it are swapped wholesale instead, via
 * SHARED_BLOCK_BODIES_NO_PHRASES.
 */
function stripCompliancePhraseLines(body: string): string {
  return body
    .split("\n")
    .filter((line) => !line.includes(COMPLIANCE_PHRASE_TOKEN))
    .join("\n");
}

/** Collapse the 3+ newline runs a removed line can leave behind. */
function collapseBlankRuns(body: string): string {
  return body.replace(/\n{3,}/g, "\n\n").trimEnd();
}

/**
 * Every placeholder token the composer knows how to substitute. Kept in
 * lockstep with the `substitutions` table inside composeForPost.
 *
 * composer-repair.test.ts asserts two things against this list:
 *   1. every {token} appearing in any SKELETONS body or any BLOCK_* body is a
 *      member — this is what shipped {citation.style} to the model
 *      unsubstituted on every skeleton-1 blog;
 *   2. no member survives into a rendered prompt.
 */
export const KNOWN_PLACEHOLDER_TOKENS: readonly string[] = [
  "{voice.persona}",
  "{voice.register_signature}",
  "{voice.example_paragraph_1}",
  "{voice.example_paragraph_2}",
  "{cadence.numbers.avgWords}",
  "{cadence.numbers.stdDev}",
  "{cadence.numbers.shortExample}",
  "{cadence.numbers.longExample}",
  "{cadence.numbers.avgParagraph}",
  "{cadence.voiceDirection}",
  "{cadence.transitionDensity}",
  "{cadence.spec}",
  "{citation.style_description}",
  "{citation.style}",
  "{citation.example}",
  "{schema.json}",
  "{tag_set.allowed_tags}",
  "{compliance.placement}",
  "{compliance.phrases_rendered}",
  "{template.flow_as_outline}",
  "{template.flow}",
  "{primary_compounds}",
  "{secondary_compounds}",
  "{sub_niche}",
  "{word_band_min}",
  "{word_band_max}",
  "{word_band_target}",
  "{topic}",
  "{quirks_rendered}",
  "{question_about_topic}",
];

function effectivePlacement(
  profile: StyleProfile,
  template: StructuralTemplate,
): string {
  return template.compliancePlacementOverride ?? profile.compliancePlacement;
}

// ─── Main compose ──────────────────────────────────────────────────────────

export interface ComposeInput {
  profile: StyleProfile;
  topic: string;
  /** Optional pre-rolled template (for testing / retry). */
  templateOverride?: StructuralTemplate;
  /** Used for question-driven skeleton S8 — composer pre-converts topic. */
  questionAboutTopic?: string;
  /** PRNG seed for per-post template selection. Defaults to topic. */
  seed?: string;
  /**
   * The blog's actual free-text niche string (e.g. "gym marketing",
   * "real estate", "dental practice"). When the profile's niche is
   * "universal" (catches any unregistered niche), this is substituted
   * into the {sub_niche} placeholder so Claude still receives
   * topical context. Ignored for peptide and other registered niches —
   * those use the SUB_NICHES name directly.
   */
  nicheLabel?: string | null;
}

export interface ComposeResult {
  systemPrompt: string;
  userPrompt: string;
  /** Recorded for the scrubber and analytics. */
  template: StructuralTemplate;
  /** Effective compliance placement, considering template overrides. */
  effectiveCompliancePlacement: string;
  /** Word band actually used (may be tightened from profile by template). */
  wordBand: [number, number];
}

/**
 * Render the full system + user prompt for one post against a locked style
 * profile and a topic. The composer pulls the locked skeleton, picks one
 * template from the structural pool, substitutes every placeholder, and
 * inlines shared blocks.
 *
 * Per-post variability comes from template draw, not skeleton draw — the
 * skeleton is locked at the blog level.
 */
export function composeForPost(input: ComposeInput): ComposeResult {
  const rng = new SeededRng(input.seed ?? input.topic);
  const profile = input.profile;
  const skeleton = SKELETONS[profile.skeletonId];
  if (!skeleton) {
    throw new Error(`Skeleton id ${profile.skeletonId} not found`);
  }

  const template = input.templateOverride ?? pickTemplateForPost(rng, profile);

  const voice = VOICES[profile.voiceId];
  const cadence = CADENCES[profile.cadenceId];
  const citation = CITATION_STYLES[profile.citationStyleId];
  const schema = SCHEMAS[profile.schemaId];
  const tagSet = TAG_SETS[profile.tagSetId];
  const subNiche = SUB_NICHES[profile.subNicheId];

  const wordBandMin = profile.wordBandMin;
  const wordBandMax = profile.wordBandMax;
  const wordBandTarget = Math.round((wordBandMin + wordBandMax) / 2);
  const placement = effectivePlacement(profile, template);
  // Niches with no compliance phrase set (everything except peptides,
  // gambling and online_casino) must not receive the phrase machinery at
  // all — not the instruction, not a placeholder standing in for it.
  const withPhrases = hasCompliancePhrases(profile);
  const phrasesRendered = renderCompliancePhrases(profile);

  // For the universal niche (sub-niche 25 / nicheKey "universal") the blog's
  // free-text niche label gives more topical context than the generic
  // "General Content" sub-niche name. Substitute it directly so Claude
  // sees e.g. "gym marketing" or "real estate" in the prompt.
  const isUniversal =
    profile.nicheKey === "universal" || profile.subNicheId === 25;
  const subNicheLabel =
    isUniversal && input.nicheLabel && input.nicheLabel.trim().length > 0
      ? input.nicheLabel.trim()
      : subNiche.name;

  // S8 requires a pre-rolled question. If absent, synthesize a default form.
  const questionAboutTopic =
    input.questionAboutTopic ??
    `What does current research show about ${input.topic}, and where is the evidence weak?`;

  // ── Placeholder substitution ──
  // Order matters slightly — replace longer placeholders first so we don't
  // accidentally consume a substring.
  // Phase 3: an LLM-generated persona, when present on the profile, overrides
  // the library voice for the {voice.*} slots — a unique generated voice per
  // blog. Absent → the library voice (unchanged behavior).
  const gp = profile.generatedPersona ?? null;
  const voicePersona = gp?.persona || voice.persona;
  const voiceRegister =
    (gp?.registerSignature || gp?.toneNotes) ?? voice.registerSignature;
  const voiceEx1 =
    gp?.examplePara1 ||
    (voice.examplePara1 ?? "(example paragraph not yet provided for this voice)");
  const voiceEx2 =
    gp?.examplePara2 ||
    (voice.examplePara2 ?? "(example paragraph not yet provided for this voice)");

  const substitutions: Array<[string, string]> = [
    ["{voice.persona}", voicePersona],
    ["{voice.register_signature}", voiceRegister],
    ["{voice.example_paragraph_1}", voiceEx1],
    ["{voice.example_paragraph_2}", voiceEx2],
    ["{cadence.numbers.avgWords}", String(cadence.numbers.avgWords)],
    ["{cadence.numbers.stdDev}", String(cadence.numbers.stdDev)],
    ["{cadence.numbers.shortExample}", String(cadence.numbers.shortExample)],
    ["{cadence.numbers.longExample}", String(cadence.numbers.longExample)],
    ["{cadence.numbers.avgParagraph}", String(cadence.numbers.avgParagraph)],
    ["{cadence.voiceDirection}", cadence.voiceDirection],
    ["{cadence.transitionDensity}", cadence.transitionDensity],
    ["{cadence.spec}", cadence.spec],
    [
      "{citation.style_description}",
      citationDescriptionForSubNiche(citation, profile.subNicheId),
    ],
    // Legacy alias. BLOCK_CITATIONS shipped {citation.style} unsubstituted to
    // the model on every skeleton-1 blog; the block is fixed, and this entry
    // keeps any other stray occurrence from doing the same. Safe beside the
    // canonical name: the literal "{citation.style}" cannot match inside
    // "{citation.style_description}" — the brace does not line up.
    [
      "{citation.style}",
      citationDescriptionForSubNiche(citation, profile.subNicheId),
    ],
    [
      "{citation.example}",
      citationExampleForSubNiche(citation, profile.subNicheId),
    ],
    ["{schema.json}", schema.jsonSpec],
    ["{tag_set.allowed_tags}", `<${tagSet.allowedTags.join(">, <")}>`],
    ["{compliance.placement}", placement],
    ["{compliance.phrases_rendered}", phrasesRendered],
    [
      "{template.flow_as_outline}",
      renderFlowAsOutline(template, profile.subNicheId, wordBandTarget),
    ],
    ["{template.flow}", renderFlow(template, profile.subNicheId)],
    ["{primary_compounds}", profile.primaryCompounds.join(", ")],
    ["{secondary_compounds}", profile.secondaryCompounds.join(", ")],
    ["{sub_niche}", subNicheLabel],
    ["{word_band_min}", String(wordBandMin)],
    ["{word_band_max}", String(wordBandMax)],
    ["{word_band_target}", String(wordBandTarget)],
    ["{topic}", input.topic],
    ["{quirks_rendered}", renderQuirks(profile)],
    ["{question_about_topic}", questionAboutTopic],
  ];

  let body = skeleton.body;
  // Remove phrase-carrying lines BEFORE substitution — afterwards the token is
  // gone and the sentence would read "include one of  at BOTTOM".
  if (!withPhrases) body = stripCompliancePhraseLines(body);
  for (const [needle, value] of substitutions) {
    body = body.split(needle).join(value);
  }

  // Inline shared blocks — the phrase-free table when the niche has none.
  body = inlineSharedBlocks(body, {
    compliancePhrases: withPhrases,
    peptideSubject: profile.subNicheId <= 13,
  });

  // Belt and braces: a block body could still carry the token.
  if (!withPhrases) body = stripCompliancePhraseLines(body);

  // Final pass — substitute again in case shared blocks introduced placeholders
  for (const [needle, value] of substitutions) {
    body = body.split(needle).join(value);
  }

  // Only tidy whitespace on the path that removed lines, so peptide, gambling
  // and casino prompts are byte-identical to before.
  if (!withPhrases) body = collapseBlankRuns(body);

  return {
    systemPrompt: body,
    userPrompt: `Write the article now. Topic: ${input.topic}. Return ONLY the JSON object — no prose before or after.`,
    template,
    effectiveCompliancePlacement: placement,
    wordBand: [wordBandMin, wordBandMax],
  };
}
