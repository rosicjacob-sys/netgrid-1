/**
 * AI-tells library. Feeds into:
 *   - The composer's [BLOCK_AI_TELLS] (rendered into every skeleton)
 *   - Scrubber Layer 1A (vocab blocklist) and 1B (phrase blocklist)
 *   - Scrubber Layer 2E (transition density)
 *
 * Word-boundary anchored. Case-insensitive matching is applied at call site
 * via the `i` flag.
 */

// ── Vocabulary blocklist (1A) ──────────────────────────────────────────────

export const VOCAB_BLOCKLIST: readonly RegExp[] = [
  /\b(delve|delving|delved)\b/gi,
  /\btapestry\b/gi,
  /\brealm\b/gi,
  /\b(unleash|unleashing)\b/gi,
  /\b(harness|harnessing)\b/gi,
  /\b(foster|fostering)\b/gi,
  /\b(cultivate|cultivating)\b/gi,
  /\b(embark|embarking)\b/gi,
  /\brobust\b/gi,
  /\bseamless(ly)?\b/gi,
  /\bholistic(ally)?\b/gi,
  /\bnuanced?\b/gi,
  /\bparadigm\b/gi,
  /\bmultifaceted\b/gi,
  /\bintricate\b/gi,
  /\bpivotal\b/gi,
  /\bplethora\b/gi,
  /\bmyriad\b/gi,
  /\bgleaned?\b/gi,
  /\bmeticulous(ly)?\b/gi,
  /\bunderscore[sd]?\b/gi,
  /\bbolster[sed]?\b/gi,
  /\bgarner(ed|ing)?\b/gi,
  /\bnavigate\s+(the|this|these|complex|complexities)\b/gi,
  /\b(landscape|ecosystem)\s+(of|for)\b/gi,
  /\bjourney\s+(of|to|toward)\b/gi,
  /\bleverage\s+(the|this|these)\b/gi,
  /\bcomprehensive\s+(guide|article|overview)\b/gi,
];

// ── Phrase blocklist (1B) ──────────────────────────────────────────────────

export const PHRASE_BLOCKLIST: readonly RegExp[] = [
  /it'?s\s+not\s+just\s+\w+,?\s+it'?s\s+\w+/gi, // "it's not just X, it's Y"
  /whether\s+you'?re\s+/gi,
  /in\s+today'?s\s+(world|fast-?paced|digital|modern|complex)/gi,
  /\b(game[-\s]?changer|revolutionary|transformative)\b/gi,
  /it'?s\s+worth\s+noting/gi,
  /\bthat\s+said,/gi,
  /with\s+that\s+in\s+mind/gi,
  /look\s+no\s+further/gi,
  /without\s+further\s+ado/gi,
  /when\s+it\s+comes\s+to/gi,
  /let'?s\s+dive\s+in/gi,
  /at\s+its\s+core/gi,
  /^(ultimately|fundamentally|essentially),/gim,
  /the\s+key\s+takeaway/gi,
  /happy\s+\w+ing!/gi,
];

// ── Transition tokens (2E) — counted per 1000 words ────────────────────────

export const TRANSITION_TOKENS: readonly string[] = [
  "however",
  "moreover",
  "furthermore",
  "additionally",
  "consequently",
  "therefore",
  "thus",
  "nevertheless",
  "nonetheless",
  "accordingly",
];

export const TRANSITION_REGEX = new RegExp(
  `\\b(${TRANSITION_TOKENS.join("|")})\\b`,
  "gi",
);

// ── Transition density tiers (2E thresholds per 1000 words) ────────────────

export const TRANSITION_DENSITY_RANGES: Record<
  "none" | "low" | "medium" | "high",
  [number, number]
> = {
  none: [0, 2],
  low: [0, 3],
  medium: [4, 7],
  high: [8, Infinity],
};

// ── Block bodies for skeletons ─────────────────────────────────────────────

/**
 * Rendered into every skeleton via [BLOCK_AI_TELLS]. Drafted to match the
 * detector regex above so Claude can avoid the same patterns the scrubber
 * checks for.
 */
export const BLOCK_AI_TELLS = `STRICTLY AVOID the following AI-cliché vocabulary in your output:
delve, tapestry, realm, unleash, harness, foster, cultivate, embark, robust, seamless, holistic, nuanced, paradigm, multifaceted, intricate, pivotal, plethora, myriad, gleaned, meticulous, underscore, bolster, garner.

STRICTLY AVOID the following AI-cliché phrases and constructions:
- "it's not just X, it's Y"
- "whether you're …"
- "in today's [world/fast-paced/digital/modern/complex] …"
- "game-changer", "revolutionary", "transformative"
- "it's worth noting"
- "that said,", "with that in mind", "look no further", "without further ado"
- "when it comes to", "let's dive in", "at its core"
- sentence-initial "Ultimately,", "Fundamentally,", "Essentially,"
- "the key takeaway", "happy [verb]-ing!"

STRUCTURAL AVOIDANCE:
- Do NOT write paragraphs of consistently 3-4 sentences throughout — vary deliberately.
- Do NOT open with "In today's …" or any time-anchored cliché.
- Do NOT close with "In conclusion …" or a recap.
- Do NOT apply parallel structure to every list.

PUNCTUATION:
- Do NOT use em-dashes ("—") or en-dashes ("–") as pauses. Use commas, parentheses, or sentence breaks.
- Do NOT use smart quotes (curly quotes) or ellipsis characters. Use straight quotes and three dots.`;

export const BLOCK_OUTPUT_FORMAT = `OUTPUT FORMAT:
Return ONLY valid JSON matching the schema below. No prose before or after the JSON.

{schema.json}

The HTML in your "content" field must use ONLY tags from this whitelist: {tag_set.allowed_tags}.
Inline images, figures, picture, source, and figcaption tags will be stripped — do not emit them.`;

export const BLOCK_COMPLIANCE = `COMPLIANCE — research-information frame:
This article must remain in research-information frame at all times. It must NOT:
- Recommend personal use of any compound discussed
- Suggest specific doses for human consumption
- Compare peptides to approved medications as if interchangeable
- Make therapeutic claims, implied or direct
- Use first-person experiential language ("I dosed", "after my cycle", "we tried")

REQUIRED COMPLIANCE LANGUAGE:
Include at least one of the following phrases verbatim, placed at {compliance.placement}:
{compliance.phrases_rendered}

Do NOT improvise alternative compliance language. Use ONLY the phrasings supplied above.`;

export const BLOCK_COMPLIANCE_BRIEF = `COMPLIANCE: include one of the following phrases verbatim at {compliance.placement}:
{compliance.phrases_rendered}`;

/**
 * Compliance frame for niches that supply NO compliance phrases — every niche
 * in niches.ts except peptides, gambling and online_casino.
 *
 * BLOCK_COMPLIANCE cannot serve those blogs: it orders the model to reproduce
 * {compliance.phrases_rendered} verbatim and forbids improvising an
 * alternative. With no phrases to render, the composer used to substitute the
 * literal string "(no compliance phrase required for this niche)" — so the
 * model was being told to print that sentence, verbatim, in the article.
 *
 * This variant keeps the useful half (an editorial frame) and drops the phrase
 * machinery entirely. It is also subject-neutral, where BLOCK_COMPLIANCE talks
 * about peptides and approved medications.
 */
export const BLOCK_COMPLIANCE_NO_PHRASES = `EDITORIAL FRAME:
Write as an informed observer describing what is known, not as an advisor telling the reader what to do. This article must NOT:
- Present a personal recommendation as established fact
- Promise the reader a specific outcome, saving, or result
- Claim professional, medical, legal, or financial authority
- Use first-person experiential language ("I tried this", "when we tested it")

State findings, say where they come from, and let the reader draw the conclusion. Where a claim is contested or the evidence is thin, say so plainly.`;

/** Short form of the above, for the minimalist skeleton (S4). */
export const BLOCK_COMPLIANCE_BRIEF_NO_PHRASES = `EDITORIAL FRAME: describe what is known and where it comes from. No personal recommendations, no promised outcomes, no first-person experience claims.`;

/**
 * Compliance frame for niches that DO supply compliance phrases but are not
 * about peptides — gambling and online_casino.
 *
 * BLOCK_COMPLIANCE's prohibition list is peptide vocabulary ("Recommend
 * personal use of any compound", "Compare peptides to approved medications",
 * "Suggest specific doses for human consumption"). Those lines shipped to
 * every casino and gambling blog, which is both nonsensical and a visible
 * generation tell. The phrase machinery below is IDENTICAL to
 * BLOCK_COMPLIANCE's — these niches genuinely need their required phrases
 * rendered — only the prohibition list is subject-neutral.
 */
export const BLOCK_COMPLIANCE_NEUTRAL_SUBJECT = `COMPLIANCE — informational frame:
This article must remain in an informational frame at all times. It must NOT:
- Present a personal recommendation as established fact
- Promise the reader a specific outcome, saving, or result
- Claim professional, medical, legal, or financial authority
- Make guarantees, implied or direct, about results the reader can expect
- Use first-person experiential language ("I tried this", "after my last run", "when we tested it")

REQUIRED COMPLIANCE LANGUAGE:
Include at least one of the following phrases verbatim, placed at {compliance.placement}:
{compliance.phrases_rendered}

Do NOT improvise alternative compliance language. Use ONLY the phrasings supplied above.`;

/** Short form of the above, for the minimalist skeleton (S4). */
export const BLOCK_COMPLIANCE_BRIEF_NEUTRAL_SUBJECT = `COMPLIANCE: include one of the following phrases verbatim at {compliance.placement}:
{compliance.phrases_rendered}`;

export const BLOCK_CITATIONS = `CITATIONS:
Use citation style: {citation.style_description}
Example of how a citation should appear inline: {citation.example}

If unsure of a citation's accuracy, OMIT it rather than fabricate. The scrubber will verify URLs and author/year/journal references; fabricated citations cause the article to fail and be regenerated.`;
