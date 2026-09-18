import { describe, it, expect } from "vitest";
import {
  descriptionMatches,
  readHeadMeta,
  titleMatches,
} from "./wp-meta-verify";

describe("readHeadMeta", () => {
  it("reads the head title and meta description", () => {
    const html = `<!doctype html><html><head>
      <title>Peptide Storage | Ottawa Peptides</title>
      <meta name="description" content="How to store reconstituted peptides." />
    </head><body><p>hi</p></body></html>`;
    expect(readHeadMeta(html)).toEqual({
      title: "Peptide Storage | Ottawa Peptides",
      description: "How to store reconstituted peptides.",
    });
  });

  it("prefers the head title over an SVG <title> in the body", () => {
    // This is why the selector is head-scoped first: an inline icon's SVG
    // title would otherwise win a document-wide $("title") lookup.
    const html = `<!doctype html><html><head><title>Real Page Title</title></head>
      <body><svg><title>icon label</title></svg></body></html>`;
    expect(readHeadMeta(html).title).toBe("Real Page Title");
  });

  it("collapses whitespace and newlines", () => {
    const html = `<html><head><title>
        Spaced   Out
      </title><meta name="description" content="one
      two"></head></html>`;
    expect(readHeadMeta(html)).toEqual({
      title: "Spaced Out",
      description: "one two",
    });
  });

  it("returns nulls when the head carries neither", () => {
    expect(readHeadMeta("<html><head></head><body>x</body></html>")).toEqual({
      title: null,
      description: null,
    });
  });

  it("does not throw on junk", () => {
    expect(() => readHeadMeta("not html at all")).not.toThrow();
  });
});

describe("titleMatches", () => {
  it("accepts an exact match, ignoring case and whitespace", () => {
    expect(titleMatches("  Peptide   Storage ", "peptide storage")).toBe(true);
  });

  it("accepts a theme-appended site-name suffix", () => {
    expect(titleMatches("Peptide Storage | Ottawa Peptides", "Peptide Storage")).toBe(
      true,
    );
  });

  it("REJECTS a suffix match", () => {
    // A suffix match would let the theme's default "Post Title - Site Name"
    // pass whenever our meta title happens to equal the site name.
    expect(titleMatches("Ottawa Peptides | Peptide Storage", "Peptide Storage")).toBe(
      false,
    );
  });

  it("rejects a missing observed title", () => {
    expect(titleMatches(null, "Peptide Storage")).toBe(false);
    expect(titleMatches("", "Peptide Storage")).toBe(false);
  });

  it("rejects an empty expectation rather than passing vacuously", () => {
    expect(titleMatches("anything", "")).toBe(false);
  });
});

describe("descriptionMatches", () => {
  it("accepts an exact match", () => {
    expect(descriptionMatches("Store it cold.", "store it cold.")).toBe(true);
  });

  it("accepts truncation past the prefix window", () => {
    const expected = "a".repeat(200);
    const observed = "a".repeat(130);
    expect(descriptionMatches(observed, expected)).toBe(true);
  });

  it("rejects a different description", () => {
    expect(descriptionMatches("Theme default blurb", "Store it cold.")).toBe(false);
  });

  it("rejects a missing description — the exact bug this catches", () => {
    expect(descriptionMatches(null, "Store it cold.")).toBe(false);
  });
});
