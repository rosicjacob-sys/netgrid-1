/**
 * Print the fully rendered article system prompt for a sample GenerateOptions,
 * so prompt edits can be reviewed without spending API credit.
 *
 * Usage (from project root):
 *   ANTHROPIC_API_KEY=dummy npx tsx scripts/print-article-prompt.ts
 *   ANTHROPIC_API_KEY=dummy npx tsx scripts/print-article-prompt.ts --questions
 *
 * ANTHROPIC_API_KEY only needs to be SET, not valid: importing
 * content-generator.ts constructs an Anthropic client at module scope. No
 * network call is made by this script.
 *
 * Covers the LEGACY path only. The profile path's prompt comes from
 * composeForPost (see src/lib/content/composer/compose.ts — and
 * scripts/preview-prompt.ts prints that one) and the custom path needs an
 * operator brief; both are exercised by a real generation.
 */
import {
  renderSystemPrompt,
  resolveCodeNiche,
  type GenerateOptions,
} from "../src/lib/services/content-generator";

const withQuestions = process.argv.includes("--questions");

const opts: GenerateOptions = {
  topic: "Storing reconstituted BPC-157 safely",
  keywords: ["how to store bpc 157", "bpc 157 storage"],
  wordCount: 1000,
  tone: "professional",
  niche: "peptides",
  blogSeed: "preview:peptides",
  brandName: "Montreal Peptides",
  seoOptimized: true,
  searchIntent: withQuestions
    ? {
        targetQuery: "how to store bpc 157",
        relatedQuestions: [
          "Does BPC-157 need to be refrigerated?",
          "How long does reconstituted BPC-157 last?",
          "Can BPC-157 be frozen?",
          "What happens if BPC-157 gets warm?",
        ],
        entities: ["bacteriostatic water"],
      }
    : undefined,
};

console.log(renderSystemPrompt(opts, resolveCodeNiche(opts.niche)));
