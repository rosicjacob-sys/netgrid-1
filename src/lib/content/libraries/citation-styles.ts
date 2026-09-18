import type { CitationStyleId, CitationStyleSpec } from "../types";

/**
 * 5 citation styles. The scrubber's Layer 3A dispatches verification by style:
 *   - URL-bearing styles get HTTP HEAD checks
 *   - Author/Year/Journal styles get Crossref lookups
 *   - Style 4 (no citations) is skipped entirely
 *   - Style 5 (community references) is best-effort with rot fallback
 */
export const CITATION_STYLES: Record<CitationStyleId, CitationStyleSpec> = {
  1: {
    id: 1,
    name: "URL inline (PubMed/DOI link)",
    styleDescription:
      "Embed source URLs inline as anchor tags pointing to PubMed, DOI, or publisher landing pages.",
    example:
      'A 2022 study (<a href="https://pubmed.ncbi.nlm.nih.gov/35291232/">PubMed</a>) reported …',
    verifiable: true,
  },
  2: {
    id: 2,
    name: "Author-Year inline",
    styleDescription:
      "Inline citations in (Author Year) format. No URLs. Reference list optional.",
    example: "Recent work (Sikiric 2018) showed elevated VEGF expression …",
    verifiable: true,
  },
  3: {
    id: 3,
    name: "Author-Year-Journal narrative",
    styleDescription:
      "Cite author, year, and journal in narrative prose without parenthetical formatting.",
    example:
      "In a 2020 paper published in Peptides, Chang and colleagues found …",
    verifiable: true,
  },
  4: {
    id: 4,
    name: "No explicit citations",
    styleDescription:
      "Discuss research conclusions without citing individual papers. Use phrases like 'published research shows' or 'the literature on X suggests'.",
    example:
      "Published research on tirzepatide consistently shows greater glycemic control than first-generation GLP-1 agonists.",
    verifiable: false,
  },
  5: {
    id: 5,
    name: "Mixed community references",
    styleDescription:
      "Mix of inline URLs (when reliable) and informal 'the BPC-157 literature' framing. Forum-style.",
    example:
      'Posters in the BPC-157 thread on r/Peptides noted a similar pattern, though no formal study has tested it (<a href="https://pubmed.ncbi.nlm.nih.gov/30551256/">PubMed</a>).',
    verifiable: true,
  },
};

export const CITATION_STYLE_IDS: CitationStyleId[] = [1, 2, 3, 4, 5];

export function citationStyleById(id: CitationStyleId): CitationStyleSpec {
  return CITATION_STYLES[id];
}

// ── Cross-niche citation variants ──────────────────────────────────────────
//
// Every `example` above — and style 5's `styleDescription` — is written in
// peptide subject matter ("the BPC-157 thread on r/Peptides", "a 2020 paper
// published in Peptides", "tirzepatide … GLP-1 agonists"). Those strings
// substitute into {citation.example} and {citation.style_description} on
// EVERY blog, so a roofing or loans prompt was being handed peptide research
// as its worked example of how to cite.
//
// Same treatment as CROSS_NICHE_FLOWS in templates.ts: keep the peptide text
// byte-identical for peptide sub-niches, and resolve a subject-neutral
// rewrite for everything else. Style 4 needs no description variant — only
// its example names a compound.
const CROSS_NICHE_CITATION_EXAMPLES: Record<CitationStyleId, string> = {
  1: 'A 2022 analysis (<a href="https://example.org/report">source</a>) reported …',
  2: "Recent work (Halvorsen 2018) found the same pattern across three markets …",
  3: "In a 2020 paper published in the Journal of Building Physics, Chang and colleagues found …",
  4: "Published research consistently shows a wider spread in outcomes than the headline figures suggest.",
  5: 'Posters in the long-running thread on this noted a similar pattern, though no formal study has tested it (<a href="https://example.org/thread">source</a>).',
};

const CROSS_NICHE_CITATION_DESCRIPTIONS: Partial<
  Record<CitationStyleId, string>
> = {
  5: "Mix of inline URLs (when reliable) and informal 'the literature on X' framing. Forum-style.",
};

/**
 * The citation example to render for this sub-niche. Peptide sub-niches
 * (1-13) keep the original peptide-flavoured example; everything else gets
 * the subject-neutral rewrite.
 */
export function citationExampleForSubNiche(
  style: CitationStyleSpec,
  subNiche: number,
): string {
  if (subNiche <= 13) return style.example;
  return CROSS_NICHE_CITATION_EXAMPLES[style.id] ?? style.example;
}

/** As above, for {citation.style_description}. */
export function citationDescriptionForSubNiche(
  style: CitationStyleSpec,
  subNiche: number,
): string {
  if (subNiche <= 13) return style.styleDescription;
  return CROSS_NICHE_CITATION_DESCRIPTIONS[style.id] ?? style.styleDescription;
}
