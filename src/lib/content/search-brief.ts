/**
 * Search brief — the block that opens every article system prompt.
 *
 * The prompt stack used to open with voice and style rules and never named the
 * query the page had to win, so the model optimized for "an article about X"
 * instead of "the page that answers X". This module renders the fix: target
 * query, classified intent, the searcher's goal, and the exact sub-questions
 * the page must answer.
 *
 * The questions are REAL related queries supplied by the caller (T11 feeds them
 * from the demand-validated candidate pool). They are never model-invented: an
 * invented question set reproduces exactly the generic outline this change
 * exists to kill, and the model has no retrieval to check itself against.
 *
 * Pure string rendering — no I/O, no SDK import — so it is unit-testable
 * without an API key (see search-brief.test.ts). That is also why it takes a
 * narrow SearchBriefInput instead of GenerateOptions: content-generator.ts
 * imports the Anthropic SDK at module scope.
 */
import { detectKeywordIntent, type KeywordIntent } from "./keyword-targeting";

export type { KeywordIntent };

/**
 * Everything the caller knows about the query this page is meant to win.
 * Supplied by T11; every field is optional except the query itself, so a
 * partially-populated brief still renders correctly.
 */
export interface SearchIntentContext {
  /** The exact query the page targets, e.g. "how to store bpc 157". */
  targetQuery: string;
  /**
   * Overrides the keyword-derived classification when the caller knows better
   * (e.g. DataForSEO reported the SERP shape). Absent => derived from the
   * target query by detectKeywordIntent().
   */
  intent?: KeywordIntent;
  /**
   * REAL related queries / "people also ask" questions for targetQuery. NEVER
   * model-invented — see the module comment. Absent or empty renders an
   * explicit "none were supplied, do not invent any" instruction.
   */
  relatedQuestions?: string[];
  /** Entities (brands, products, organisations, places) that should be named. */
  entities?: string[];
  /**
   * Verified facts the article is ALLOWED to state as specifics — prices,
   * dates, percentages. Rendered as a REFERENCE FACTS block; the FACTS POLICY
   * in SEO_QUALITY_DIRECTIVE forbids any specific that is not in here, in the
   * client knowledge base, or in the news references.
   */
  referenceFacts?: string[];
}

/** The slice of GenerateOptions this module needs. See the module comment. */
export interface SearchBriefInput {
  topic: string;
  keywords: string[];
  searchIntent?: SearchIntentContext;
  /** blog_keyword_targets keyword when this post has a claimed local target. */
  localKeyword?: string | null;
}

const MAX_BRIEF_QUESTIONS = 8;
const MAX_BRIEF_ENTITIES = 12;
const MAX_REFERENCE_FACTS = 20;

/** One sentence per intent, naming what the reader is actually trying to do. */
const SEARCHER_GOAL: Record<KeywordIntent, string> = {
  transactional:
    "buy, book, or order something. They need availability, what it actually costs, what the process looks like, and enough detail to be confident they are not making a mistake.",
  comparison:
    "choose between real options. They need the differences that change the decision, the conditions under which each option wins, and a clear statement of who each one suits.",
  informational:
    "understand something well enough to act on it, and to leave without having to open a second page.",
};

/**
 * The query this page is written to win. Falls back through the local-target
 * keyword, the first non-empty target keyword, and finally the topic — so the
 * brief is never empty even before T11 supplies real query data.
 */
export function resolveTargetQuery(input: SearchBriefInput): string {
  const explicit = input.searchIntent?.targetQuery?.trim();
  if (explicit) return explicit;

  const local = (input.localKeyword ?? "").trim();
  if (local) return local;

  const keyword = (input.keywords ?? [])
    .map((k) => (typeof k === "string" ? k.trim() : ""))
    .find((k) => k.length > 0);
  if (keyword) return keyword;

  return (input.topic ?? "").trim();
}

/** Caller-supplied intent, else classified from the target query. */
export function resolveIntent(input: SearchBriefInput): KeywordIntent {
  return (
    input.searchIntent?.intent ?? detectKeywordIntent(resolveTargetQuery(input))
  );
}

function cleanList(
  values: readonly string[] | undefined,
  max: number,
): string[] {
  return (values ?? [])
    .map((v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : ""))
    .filter((v) => v.length > 0)
    .slice(0, max);
}

/**
 * The brief. Always non-empty: with no searchIntent supplied it still names a
 * target query and an intent, which is strictly more direction than the prompt
 * carried before this existed.
 */
export function renderSearchBrief(input: SearchBriefInput): string {
  const targetQuery = resolveTargetQuery(input);
  const intent = resolveIntent(input);
  const questions = cleanList(
    input.searchIntent?.relatedQuestions,
    MAX_BRIEF_QUESTIONS,
  );
  const entities = cleanList(input.searchIntent?.entities, MAX_BRIEF_ENTITIES);

  const questionBlock = questions.length
    ? `QUESTIONS THIS PAGE MUST ANSWER (these are queries real people ran — answer every one, each under its own <h2>):\n${questions
        .map((q, i) => `${i + 1}. ${q}`)
        .join("\n")}`
    : `QUESTIONS THIS PAGE MUST ANSWER: none were supplied for this post. Derive 4-6 sub-questions from the target query itself and answer each under its own <h2>. Do NOT invent statistics, survey results, or "people also ask" claims to fill them.`;

  const entityLine = entities.length
    ? `\nENTITIES TO NAME (use these exact names at least once each, only where they genuinely belong): ${entities.join(", ")}`
    : "";

  return `SEARCH BRIEF — this is the job. Every instruction below serves it.
TARGET QUERY: ${targetQuery}
SEARCH INTENT: ${intent}
SEARCHER'S GOAL: someone running that query wants to ${SEARCHER_GOAL[intent]}
${questionBlock}${entityLine}`;
}

/**
 * Operator-supplied verified facts. Returns "" when none were supplied, so a
 * post without them gets a byte-identical prompt to one generated before this
 * field existed.
 */
export function renderReferenceFacts(input: SearchBriefInput): string {
  const facts = cleanList(
    input.searchIntent?.referenceFacts,
    MAX_REFERENCE_FACTS,
  );
  if (facts.length === 0) return "";
  return (
    `\n\nREFERENCE FACTS — verified and supplied by the operator. These are the ONLY figures you may state as specifics. Reproduce them as written; do not round, extrapolate, or update them:\n` +
    facts.map((f) => `- ${f}`).join("\n")
  );
}
