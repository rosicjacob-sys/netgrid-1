import type { SchemaId, SchemaSpec } from "../types";

/**
 * 8 JSON output schemas. The composer pastes `jsonSpec` verbatim into the
 * skeleton's {schema.json} placeholder so Claude has the exact target shape.
 *
 * All schemas share a common envelope (title, content, excerpt, metaTitle,
 * metaDescription, keywords, faq). The generator reads those fields — `faq`
 * included since T05, where it is parsed by normalizeFaq() and surfaced on
 * GeneratedContent for T20's FAQPage structured data. The OTHER extra fields
 * (deck/items/steps/...) are still guidance only, not parsed. The
 * differentiators are inside `content`:
 *
 *   A — Standard article (h2/h3 hierarchy, prose-heavy)
 *   B — Magazine feature (lead callout, sidebars, byline-style block)
 *   C — FAQ-rich (article followed by Q/A block)
 *   D — Listicle-anchored (numbered headings, summary cards)
 *   E — How-to / step guide (sequential numbered steps)
 *   F — Comparison / versus (side-by-side, pros and cons)
 *   G — Case study / narrative (situation → approach → outcome)
 *   H — Buyer's guide (criteria sections + a clear recommendation)
 *
 * {brand} is substituted by the composer from ComposeInput.brandName. The
 * "no brand name" rule these specs used to carry suppressed the one entity
 * token that distinguished 1,500 sites from each other in a SERP — every page
 * on every site emitted the same title grammar, with the site's own name
 * explicitly forbidden.
 */
export const SCHEMAS: Record<SchemaId, SchemaSpec> = {
  1: {
    id: 1,
    code: "A",
    name: "Standard article",
    jsonSpec: `{
  "title":            "string, ≤60 chars, leads with the answer or the promise; include the target query's wording only where it reads naturally. No brand name.",
  "content":          "HTML using only tags from the assigned tag set",
  "excerpt":          "150-160 char summary, plain text",
  "metaTitle":        "string, ≤40 chars of headline then ' | ' and the site's brand: {brand}. Never ' - ' as the separator.",
  "metaDescription":  "string, ~140 chars, one natural sentence saying what the page answers",
  "keywords":         ["3-7 keyword strings, no duplicates"],
  "faq":              [{ "question": "exact question wording", "answer": "40-90 word answer, plain text, no HTML" }]
}
Mirror "faq" from the FAQ section inside "content" — same questions, same answers, 3-6 entries, plain text. FAQ question wording must not repeat any heading used earlier in the page.`,
  },
  2: {
    id: 2,
    code: "B",
    name: "Magazine feature",
    jsonSpec: `{
  "title":            "string, ≤80 chars, feature-style",
  "deck":             "string, ≤140 chars, subtitle/standfirst",
  "content":          "HTML: opens with a lead callout <p><strong>…</strong></p>, then body. Allowed tags from tag set only.",
  "excerpt":          "150-160 char summary",
  "metaTitle":        "string, ≤40 chars of headline then ' | ' and the site's brand: {brand}. Never ' - ' as the separator.",
  "metaDescription":  "string, ~140 chars, one natural sentence saying what the page answers",
  "keywords":         ["3-7 keywords"],
  "faq":              [{ "question": "exact question wording", "answer": "40-90 word answer, plain text, no HTML" }]
}
Mirror "faq" from the FAQ section inside "content" — same questions, same answers, 3-6 entries, plain text. FAQ question wording must not repeat any heading used earlier in the page.`,
  },
  3: {
    id: 3,
    code: "C",
    name: "FAQ-rich",
    jsonSpec: `{
  "title":            "string, ≤60 chars",
  "content":          "HTML body, then a section <h2>Common questions</h2> followed by an <h3>/answer-paragraph pattern.",
  "faq":              [{ "question": "exact question wording", "answer": "40-90 word answer, plain text, no HTML" }],
  "excerpt":          "150-160 char summary",
  "metaTitle":        "string, ≤40 chars of headline then ' | ' and the site's brand: {brand}. Never ' - ' as the separator.",
  "metaDescription":  "string, ~140 chars, one natural sentence saying what the page answers",
  "keywords":         ["3-7 keywords"]
}
Mirror "faq" from the FAQ section inside "content" — same questions, same answers, 3-6 entries, plain text. FAQ question wording must not repeat any heading used earlier in the page.`,
  },
  4: {
    id: 4,
    code: "D",
    name: "Listicle-anchored",
    jsonSpec: `{
  "title":            "string, ≤60 chars, may begin with a number",
  "intro":            "120-200 word framing paragraph as plain HTML <p>",
  "items":            [{ "heading": "string ≤80 chars", "body": "string, 120-260 words, plain HTML paragraphs/lists" }],
  "content":          "Concatenated full-article HTML (intro + items rendered)",
  "excerpt":          "150-160 char summary",
  "metaTitle":        "string, ≤40 chars of headline then ' | ' and the site's brand: {brand}. Never ' - ' as the separator.",
  "metaDescription":  "string, ~140 chars, one natural sentence saying what the page answers",
  "keywords":         ["3-7 keywords"],
  "faq":              [{ "question": "exact question wording", "answer": "40-90 word answer, plain text, no HTML" }]
}
Mirror "faq" from the FAQ section inside "content" — same questions, same answers, 3-6 entries, plain text. FAQ question wording must not repeat any heading used earlier in the page.`,
  },
  5: {
    id: 5,
    code: "E",
    name: "How-to / step guide",
    jsonSpec: `{
  "title":            "string, ≤60 chars, action-oriented (often 'How to …')",
  "content":          "HTML: a short framing <p>, then sequential numbered steps as <h2>/<h3> headings each followed by instructional paragraphs (and <ol>/<ul> where it helps). Allowed tags from the tag set only.",
  "excerpt":          "150-160 char summary",
  "metaTitle":        "string, ≤40 chars of headline then ' | ' and the site's brand: {brand}. Never ' - ' as the separator.",
  "metaDescription":  "string, ~140 chars, one natural sentence saying what the page answers",
  "keywords":         ["3-7 keywords"],
  "faq":              [{ "question": "exact question wording", "answer": "40-90 word answer, plain text, no HTML" }]
}
Mirror "faq" from the FAQ section inside "content" — same questions, same answers, 3-6 entries, plain text. FAQ question wording must not repeat any heading used earlier in the page.`,
  },
  6: {
    id: 6,
    code: "F",
    name: "Comparison / versus",
    jsonSpec: `{
  "title":            "string, ≤70 chars, often 'X vs Y' framing",
  "content":          "HTML: a framing <p>, then a section per option or per criterion with <h2>/<h3> headings, explicit trade-offs, and an honest pros/cons treatment. End with a short verdict paragraph. Allowed tags from the tag set only.",
  "excerpt":          "150-160 char summary",
  "metaTitle":        "string, ≤40 chars of headline then ' | ' and the site's brand: {brand}. Never ' - ' as the separator.",
  "metaDescription":  "string, ~140 chars, one natural sentence saying what the page answers",
  "keywords":         ["3-7 keywords"],
  "faq":              [{ "question": "exact question wording", "answer": "40-90 word answer, plain text, no HTML" }]
}
Mirror "faq" from the FAQ section inside "content" — same questions, same answers, 3-6 entries, plain text. FAQ question wording must not repeat any heading used earlier in the page.`,
  },
  7: {
    id: 7,
    code: "G",
    name: "Case study / narrative",
    jsonSpec: `{
  "title":            "string, ≤70 chars",
  "content":          "HTML structured as a narrative: a 'situation' section, an 'approach' section, and an 'outcome' section under <h2> headings, with concrete specifics throughout. Allowed tags from the tag set only.",
  "excerpt":          "150-160 char summary",
  "metaTitle":        "string, ≤40 chars of headline then ' | ' and the site's brand: {brand}. Never ' - ' as the separator.",
  "metaDescription":  "string, ~140 chars, one natural sentence saying what the page answers",
  "keywords":         ["3-7 keywords"],
  "faq":              [{ "question": "exact question wording", "answer": "40-90 word answer, plain text, no HTML" }]
}
Mirror "faq" from the FAQ section inside "content" — same questions, same answers, 3-6 entries, plain text. FAQ question wording must not repeat any heading used earlier in the page.`,
  },
  8: {
    id: 8,
    code: "H",
    name: "Buyer's guide",
    jsonSpec: `{
  "title":            "string, ≤70 chars (often 'best … for …' or 'how to choose …')",
  "content":          "HTML: a short intro on what matters, then a section per selection criterion under <h2>/<h3> headings, then a clear recommendation paragraph naming who each option suits. Allowed tags from the tag set only.",
  "excerpt":          "150-160 char summary",
  "metaTitle":        "string, ≤40 chars of headline then ' | ' and the site's brand: {brand}. Never ' - ' as the separator.",
  "metaDescription":  "string, ~140 chars, one natural sentence saying what the page answers",
  "keywords":         ["3-7 keywords"],
  "faq":              [{ "question": "exact question wording", "answer": "40-90 word answer, plain text, no HTML" }]
}
Mirror "faq" from the FAQ section inside "content" — same questions, same answers, 3-6 entries, plain text. FAQ question wording must not repeat any heading used earlier in the page.`,
  },
};

export const SCHEMA_IDS: SchemaId[] = [1, 2, 3, 4, 5, 6, 7, 8];

export function schemaById(id: SchemaId): SchemaSpec {
  return SCHEMAS[id];
}
