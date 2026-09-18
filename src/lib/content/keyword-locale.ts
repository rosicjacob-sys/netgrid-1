// Autocomplete locale resolution for a client's keyword scrape.
//
// client_keywords is a CLIENT-WIDE pool (unique on client_id + keyword), but
// the markets it has to serve are a property of the client's BLOGS: a client
// can run Montreal and Toronto storefronts, and an "en_fr" client publishes
// English AND French posts (see content/post-language.ts). Deriving a single
// locale from clients.language_mode — what keyword-actions.ts's old
// localeForLanguageMode did — therefore scraped the wrong market for most of
// the network: gl=us for Canadian city blogs, and hl=fr only for bilingual
// clients whose English posts then targeted French keywords.
//
// This resolves the SET of (lang, country) pairs a client actually needs. The
// caller scrapes each pair and merges the results into the one pool.
//
// No `import "server-only"` — same reasoning as
// src/lib/content/client-keywords.ts: every consumer is a "use server" action
// or a standalone tsx script, never a client component.

import { db } from "@/lib/db";
import { blogs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  defaultLanguageModeForNiche,
  togglesFromLanguageMode,
} from "@/lib/content/language";

export interface ScrapeLocale {
  /** Autocomplete `hl` — UI language. */
  lang: "en" | "fr";
  /** Autocomplete `gl` — ISO 3166-1 alpha-2 country code, lowercased. */
  country: string;
}

/**
 * Ceiling on (lang x country) pairs scraped for one client. Each pair is a
 * full scrapeKeywords() call, so this directly bounds per-client wall clock.
 */
export const MAX_LOCALES_PER_CLIENT = 4;

/**
 * ccTLD -> ISO 3166-1 alpha-2. Only unambiguous country TLDs; generic ones
 * (.com/.net/.org/.io) deliberately fall through to the blogs' explicit
 * country_code or the network default.
 *
 * Note ".uk" maps to "gb" — GB is the ISO code for the United Kingdom. If a
 * UK market is ever onboarded, verify that the Autocomplete endpoint returns
 * UK suggestions for gl=gb before trusting it (Google has historically
 * accepted "uk" as an alias).
 */
const TLD_COUNTRY: Record<string, string> = {
  ca: "ca",
  fr: "fr",
  uk: "gb",
  au: "au",
  nz: "nz",
  ie: "ie",
  de: "de",
  es: "es",
  it: "it",
  nl: "nl",
  be: "be",
  ch: "ch",
  mx: "mx",
};

/** Country implied by a domain's ccTLD, or null for generic TLDs. */
export function countryFromDomain(domain: string): string | null {
  const clean = (domain || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .replace(/:\d+$/, "");
  const tld = clean.split(".").pop() ?? "";
  return TLD_COUNTRY[tld] ?? null;
}

/**
 * The (lang, country) pairs this client's keyword pool has to cover.
 *
 * Languages come from the operator's explicit clients.language_mode, falling
 * back to the same legacy niche rules the onboarding form shows
 * (defaultLanguageModeForNiche). "en_fr" yields BOTH languages — that is the
 * whole point: half that client's posts are English.
 *
 * Countries come from the client's blogs: blogs.country_code when the operator
 * set it, else the domain's ccTLD, else the network default "us".
 *
 * Fail-safe: any DB error degrades to [{ lang, country: "us" }] rather than
 * throwing, matching the rest of this pipeline's never-break-generation
 * contract.
 */
export async function resolveScrapeLocalesForClient(opts: {
  clientId: string;
  languageMode: string | null | undefined;
  niche: string | null | undefined;
}): Promise<ScrapeLocale[]> {
  const mode = opts.languageMode ?? defaultLanguageModeForNiche(opts.niche);
  const { en, fr } = togglesFromLanguageMode(mode);
  const langs: Array<"en" | "fr"> = [];
  if (en) langs.push("en");
  if (fr) langs.push("fr");
  if (langs.length === 0) langs.push("en");

  let rows: Array<{ countryCode: string | null; domain: string }> = [];
  try {
    // No status filter: blogs.status is NULLABLE, so ne(status,
    // 'decommissioned') would silently drop legacy NULL-status rows. A
    // decommissioned blog's market is still a fair signal for a client-wide
    // pool anyway.
    rows = await db
      .select({ countryCode: blogs.countryCode, domain: blogs.domain })
      .from(blogs)
      .where(eq(blogs.clientId, opts.clientId));
  } catch (err) {
    console.warn(
      `[keyword-locale] blog lookup failed for client ${opts.clientId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  const countries = new Set<string>();
  for (const row of rows) {
    const explicit = row.countryCode?.trim().toLowerCase();
    if (explicit && explicit.length === 2) {
      countries.add(explicit);
      continue;
    }
    const derived = countryFromDomain(row.domain);
    if (derived) countries.add(derived);
  }

  // No blog says otherwise -> the network's historical default.
  if (countries.size === 0) countries.add("us");

  // Sorted so the locale list — and therefore the scrape order and the
  // truncation point — is deterministic for a given client.
  const ordered = Array.from(countries).sort();

  const locales: ScrapeLocale[] = [];
  for (const lang of langs) {
    for (const country of ordered) {
      if (locales.length >= MAX_LOCALES_PER_CLIENT) return locales;
      locales.push({ lang, country });
    }
  }
  return locales;
}
