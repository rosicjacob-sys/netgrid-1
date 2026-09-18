import {
  BLOCK_AI_TELLS,
  BLOCK_CITATIONS,
  BLOCK_COMPLIANCE,
  BLOCK_COMPLIANCE_BRIEF,
  BLOCK_COMPLIANCE_BRIEF_NEUTRAL_SUBJECT,
  BLOCK_COMPLIANCE_BRIEF_NO_PHRASES,
  BLOCK_COMPLIANCE_NEUTRAL_SUBJECT,
  BLOCK_COMPLIANCE_NO_PHRASES,
  BLOCK_OUTPUT_FORMAT,
} from "../libraries/ai-tells";
import type { SharedBlock } from "../types";

/**
 * Map shared-block markers to their body text. Markers in skeletons look
 * like `[BLOCK_AI_TELLS]` — the composer replaces them by name.
 */
export const SHARED_BLOCK_BODIES: Record<SharedBlock, string> = {
  AI_TELLS: BLOCK_AI_TELLS,
  OUTPUT_FORMAT: BLOCK_OUTPUT_FORMAT,
  COMPLIANCE: BLOCK_COMPLIANCE,
  COMPLIANCE_BRIEF: BLOCK_COMPLIANCE_BRIEF,
  CITATIONS: BLOCK_CITATIONS,
};

/**
 * Variant used when the blog's niche supplies no compliance phrases — every
 * niche except peptides, gambling and online_casino (niches.ts). Both
 * compliance blocks are swapped for phrase-free editorial frames; the
 * AI-tells, output-format and citation blocks are identical.
 *
 * Swapping the whole body (rather than stripping the phrase line out of
 * BLOCK_COMPLIANCE) is necessary because the phrase line does not stand
 * alone: removing it would orphan the "REQUIRED COMPLIANCE LANGUAGE" header
 * above it and the "Do NOT improvise alternative compliance language" order
 * below it.
 */
export const SHARED_BLOCK_BODIES_NO_PHRASES: Record<SharedBlock, string> = {
  ...SHARED_BLOCK_BODIES,
  COMPLIANCE: BLOCK_COMPLIANCE_NO_PHRASES,
  COMPLIANCE_BRIEF: BLOCK_COMPLIANCE_BRIEF_NO_PHRASES,
};

/**
 * Variant used when the blog's niche DOES supply compliance phrases but is
 * not about peptides — gambling and online_casino. The phrase machinery is
 * kept; only BLOCK_COMPLIANCE's peptide-specific prohibition list is swapped
 * for a subject-neutral one.
 */
export const SHARED_BLOCK_BODIES_NEUTRAL_SUBJECT: Record<SharedBlock, string> = {
  ...SHARED_BLOCK_BODIES,
  COMPLIANCE: BLOCK_COMPLIANCE_NEUTRAL_SUBJECT,
  COMPLIANCE_BRIEF: BLOCK_COMPLIANCE_BRIEF_NEUTRAL_SUBJECT,
};

/**
 * Replace every [BLOCK_X] marker in `body` with the rendered block body.
 * Unknown markers are left untouched (and will surface as obvious anomalies).
 *
 * Pass `{ compliancePhrases: false }` when the profile carries no compliance
 * phrase ids, to select the phrase-free block table. Pass
 * `{ peptideSubject: false }` alongside phrases to keep the phrase machinery
 * but drop the peptide-specific prohibition list.
 */
export function inlineSharedBlocks(
  body: string,
  options: { compliancePhrases?: boolean; peptideSubject?: boolean } = {},
): string {
  const bodies =
    options.compliancePhrases === false
      ? SHARED_BLOCK_BODIES_NO_PHRASES
      : options.peptideSubject === false
        ? SHARED_BLOCK_BODIES_NEUTRAL_SUBJECT
        : SHARED_BLOCK_BODIES;
  return body.replace(/\[BLOCK_([A-Z_]+)\]/g, (_, name) => {
    const key = name as SharedBlock;
    return bodies[key] ?? `[BLOCK_${name}]`;
  });
}
