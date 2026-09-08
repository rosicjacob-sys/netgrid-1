import Anthropic from "@anthropic-ai/sdk";
import { composeForPost } from "@/lib/content/composer/compose";
import { getCachedNicheProfile } from "@/lib/content/niche-registry";
import {
  runScrubber,
  runScrubberLite,
  type ScrubberReport,
  type ScrubberVerdict,
} from "@/lib/content/scrubber";
import type { GeneratedPersona, StyleProfile } from "@/lib/content/types";
import {
  getContentModel,
  DEFAULT_CONTENT_MODEL,
  type ContentModel,
} from "@/lib/settings/app-settings";
import {
  COMMERCIAL_LINK_REL,
  EDITORIAL_LINK_REL,
  withUtm,
} from "@/lib/content/outbound-links";
import { SUB_NICHES } from "@/lib/content/libraries/sub-niches";
import { findMostSimilarTitle } from "@/lib/content/topic-similarity";
import {
  FRENCH_ONLY_NICHE_KEYS,
  MIXED_LANGUAGE_NICHE_KEYS,
} from "@/lib/content/language";
import {
  truncateToPx,
  DESC_FONT_PX,
  DESC_TARGET_PX,
} from "@/lib/seo/text-width";
import {
  appendBrandToTitle,
  capMetaDescription,
  stripLegacyRedditToken,
} from "@/lib/seo/meta-suffix";
import {
  recordPipelineError,
  bumpCounter,
  bumpProvider,
} from "@/lib/services/run-telemetry";
import {
  ensureLocalTargetTitle,
  ensureLocalTargetDescription,
  type LocalTargetMetaContext,
} from "@/lib/seo/local-target";
import {
  generateBodyImage,
  generateHeroImage,
} from "@/lib/services/image-generator";

// Generation runs DeepSeek v4-pro as PRIMARY, with Claude as the automatic
// FALLBACK whenever DeepSeek errors (auth, rate limit, server error, timeout).
// DeepSeek is set via env so the exact model / endpoint can change without a
// code edit:
//   DEEPSEEK_API_KEY   (required to enable DeepSeek; unset → Claude only)
//   DEEPSEEK_MODEL     (default "deepseek-v4-pro")
//   DEEPSEEK_BASE_URL  (default "https://api.deepseek.com", OpenAI-compatible)
const CLAUDE_MODEL = "claude-sonnet-4-6";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
// Abort deadline for one DeepSeek call. Raised from 120s with T06: a ~7,500-
// token French article legitimately takes longer to produce than a 4,096-token
// one. Safe to raise only because the abort is now thrown as PERMANENT (408)
// rather than transient (504) — see callDeepSeekOnce — so it is no longer
// multiplied by the callWithRetry budget.
const DEEPSEEK_TIMEOUT_MS =
  Number(process.env.DEEPSEEK_TIMEOUT_MS) > 0
    ? Number(process.env.DEEPSEEK_TIMEOUT_MS)
    : 180_000;

function deepseekConfigured(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY);
}

// Claude Sonnet 4.6 pricing — per-token (USD), not per-1K. Verify current rates
// at https://www.anthropic.com/pricing before relying on cost reporting.
// As of writing: $3 / 1M input tokens, $15 / 1M output tokens.
const PRICING = {
  inputPerToken: 0.000003,
  outputPerToken: 0.000015,
};

// DeepSeek v4-pro pricing — per-token (USD). Promotional rate as of 2026-06
// (~$0.435 / 1M input, ~$0.870 / 1M output); post-promo list is ~$1.74 / $3.48.
// Verify at https://api-docs.deepseek.com/quick_start/pricing.
const DEEPSEEK_PRICING = {
  inputPerToken: 0.000000435,
  outputPerToken: 0.00000087,
};

// Network-wide word-count policy. Single source of truth lives in
// src/lib/content/config.ts. Imported here so both the legacy
// (non-profile) generation path and the profile-driven path use the
// same range. Change those constants once to shift the policy
// everywhere.
import {
  GLOBAL_WORD_BAND_MAX,
  GLOBAL_WORD_BAND_MIN,
} from "@/lib/content/config";
import {
  CLAUDE_MAX_OUTPUT_TOKENS,
  deepseekMaxOutputTokens,
  outputTokenBudget,
} from "@/lib/services/content-token-budget";
import {
  takeNewsContextForVertical,
  formatNewsContextForPrompt,
  getRecentNewsForVerticalInternal,
} from "@/lib/actions/news-actions";

const MIN_WORDS = GLOBAL_WORD_BAND_MIN;
const MAX_WORDS = GLOBAL_WORD_BAND_MAX;

// Absolute publish floor, applied on EVERY generation path even when a style
// profile carries a lower band (un-migrated profiles predate
// GLOBAL_WORD_BAND_MIN, and the scrubber's lite pseudo-profile uses 0).
// Half the network minimum: no legitimate profile band goes below it, so this
// only ever fires on a truncation salvage.
const ABSOLUTE_MIN_WORDS = Math.round(MIN_WORDS * 0.5);

// One retry per topic on shape drift ({title} only, {title, deck}, etc.).
// 1 = 2 total attempts. Second attempt is a stripped-down last chance.
const MAX_SHAPE_RETRIES = 1;

/** Appended to the user prompt on the retry attempt. */
const SHAPE_RETRY_REMINDER = `

Your previous response was missing the article body. Please write the full piece this time and return it as the "content" field of the JSON. Sample shape:

{
  "title": "...",
  "content": "<p>Opening paragraph...</p><h2>Section heading</h2><p>...</p><h2>Next section</h2><p>...</p>",
  "excerpt": "...",
  "metaTitle": "...",
  "metaDescription": "...",
  "keywords": ["...", "...", "..."]
}

The "content" field should hold the article body itself — opening, sections with <h2> headings, paragraphs, lists where useful, and a closing. Target roughly ${MIN_WORDS}+ words. Write naturally; this is consumer-information content.`;

/**
 * Appended to the user prompt when the PREVIOUS attempt was cut off by
 * max_tokens (or only parsed after truncation repair). Deliberately the
 * mirror image of SHAPE_RETRY_REMINDER: that one asks for more, this one
 * trades length for completeness.
 */
const LENGTH_RETRY_REMINDER = `

Your previous response was cut off before the JSON object was closed. Write a COMPLETE article this time: finish the final sentence, close every HTML tag you open, close the "content" string, and close the JSON object. If you have to trade length for completeness, write a shorter article — a complete ${MIN_WORDS}-word piece is far better than a truncated ${MAX_WORDS}-word one. Return ONE JSON object and nothing else.`;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Niche contexts ─────────────────────────────────────────────────────────

interface NicheContext {
  label: string;
  industry: string;
  defaultAudience: string;
  defaultBrandVoice: string;
  contentStyle: string;
  keyTopics: string[];
}

const NICHE_CONTEXTS: Record<string, NicheContext> = {
  reputation_sites: {
    label: "Good Reputation Sites & Reviews",
    industry: "Reputation Management",
    defaultAudience: "Business owners, consumers, marketers researching reviews",
    defaultBrandVoice: "professional and balanced, ethical consultant",
    contentStyle: "Balanced perspective addressing both business and consumer viewpoints, platform-specific details, ethical practices only",
    keyTopics: ["Trustpilot", "Yelp", "Google Reviews", "BBB", "G2", "review response", "fake reviews", "reputation management"],
  },
  peptides: {
    label: "Peptides & Performance Enhancement",
    industry: "Health & Performance",
    defaultAudience: "Bodybuilders, biohackers, anti-aging seekers, researchers, medical professionals",
    defaultBrandVoice: "scientific yet accessible, evidence-based",
    contentStyle: "Scientific credibility with E-A-T compliance, reference actual studies, acknowledge limitations, never recommend suppliers",
    keyTopics: ["BPC-157", "TB-500", "peptide protocols", "growth hormone", "tissue repair", "clinical research"],
  },
  gambling: {
    label: "Gambling, Sports Betting & Online Casino",
    industry: "Sports Betting, Wagering Markets & Online Casino",
    defaultAudience: "Adult gambling readers across the curve: recreational sports bettors and casino players who want to understand the math before they wager, line-shopping and bonus-hunting enthusiasts, sharper bettors interested in closing-line value and Kelly sizing, casino players researching RTP and wagering requirements, betting/casino journalists, and responsible-gambling advocates focused on consumer protection",
    defaultBrandVoice: "analytical statistical voice with consumer-protection awareness — explains expected value, line movement, vig math, house edge, and RTP openly. Not a tipster, pick-seller, or operator promoter; a consumer-information explainer who treats the reader as informed and capable",
    contentStyle: "Statistical and market analysis over hot takes, pick promotion, or operator hype. SPORTS BETTING: lead with concrete math — -110 means a 4.55% vig, +EV requires beating closing line value, the long-term win rate needed to overcome juice. Use real odds in American (+150 / -110), decimal (2.50 / 1.91), and fractional (3/2 / 10/11); show the conversion at least once. Reference real sportsbooks by name and jurisdiction: DraftKings / FanDuel / BetMGM / Caesars / ESPN BET (US), Pinnacle (sharp-friendly), bet365 / William Hill (UK/EU), PointsBet / theScore Bet (Canada), Mise-o-jeu+ (Loto-Québec, Québec). Cover sport-specific market structure: NFL spreads/totals (key numbers 3, 7, 10, 14), NBA totals and player props, MLB run lines, NHL puck lines, soccer 1X2 / Asian handicap / BTTS / corners. ONLINE CASINO: use real RTP percentages — 95–97% typical slots, 99.5% blackjack basic strategy, 98.65% European roulette, 97.3% American roulette. Reference named game providers (Pragmatic Play, NetEnt, Evolution, Microgaming, Play'n GO) and a few specific top-grossing titles. Be precise about welcome-bonus mechanics: wagering requirements (e.g. 35x bonus + deposit), max-bet caps, game contribution percentages (slots usually 100%, blackjack often 10% or excluded). Acknowledge openly that the house edge means most bettors AND most casino players lose long-term — the math says so — and frame every piece as consumer information. Include responsible-gambling language naturally: deposit limits, self-exclusion (Loto-Québec's program, GamCare, NCPG, Jeu Responsable), session timers, never chase losses. Distinguish regulated jurisdictions (state-by-state US, AGCO Ontario, UKGC, MGA, NJ DGE) from offshore Curaçao operators — never recommend offshore as a way to bypass regulation. Numbers and historical context are great; profit-promise language is not.",
    keyTopics: ["closing line value", "expected value", "EV calculation", "vig", "juice", "no-vig odds", "Kelly criterion", "bankroll management", "unit sizing", "line movement", "steam moves", "sharps vs squares", "DraftKings", "FanDuel", "BetMGM", "Pinnacle", "bet365", "Mise-o-jeu+", "NFL spreads", "NBA totals", "MLB run lines", "soccer 1X2", "Asian handicap", "moneyline odds", "player props", "parlays", "live betting", "online slots", "blackjack", "roulette", "baccarat", "live dealer", "video poker", "casino welcome bonus", "wagering requirements", "RTP", "house edge", "Pragmatic Play", "NetEnt", "Evolution Gaming", "responsible gambling", "self-exclusion", "AGCO Ontario", "UKGC", "MGA", "Loto-Québec", "+EV spots"],
  },
  apps_marketing: {
    label: "Apps Marketing & Reviews",
    industry: "Mobile Apps & Software",
    defaultAudience: "App users, productivity seekers, buyers researching software",
    defaultBrandVoice: "honest reviewer, practical and helpful",
    contentStyle: "Test apps when possible, mention limitations honestly, real pricing, platform differences (iOS vs Android)",
    keyTopics: ["app reviews", "productivity apps", "app comparison", "mobile software", "app features", "user experience"],
  },
  exclusive_models: {
    label: "Creator Platforms & OnlyFans Business",
    industry: "Creator Economy",
    defaultAudience: "Aspiring creators, current creators, business researchers",
    defaultBrandVoice: "professional business advisor, entrepreneurial consultant",
    contentStyle: "Business-first framing not explicit content, frame as entrepreneurship, real numbers on fees and earnings, respect creator autonomy",
    keyTopics: ["OnlyFans", "Fansly", "creator monetization", "content marketing", "subscriber retention", "creator business", "platform fees"],
  },
  ecom_nails: {
    label: "Nails & Beauty E-commerce",
    industry: "Beauty & Cosmetics",
    defaultAudience: "Beginners to experienced home manicurists, beauty enthusiasts",
    defaultBrandVoice: "practical and experienced, helpful beauty enthusiast",
    contentStyle: "Correct product terminology, reference actual brands with real prices, include timing, describe looks specifically",
    keyTopics: ["gel polish", "nail art", "chrome powder", "builder gel", "manicure techniques", "nail products", "nail trends"],
  },
  soccer_jersey: {
    label: "Soccer Jerseys & Fan Merchandise",
    industry: "Sports Merchandise",
    defaultAudience: "Passionate fans, collectors, parents, gift buyers",
    defaultBrandVoice: "knowledgeable fan perspective, experienced collector",
    contentStyle: "Distinguish authentic vs replica vs counterfeit, use proper terminology (kit, strip), sizing by manufacturer, authentication methods",
    keyTopics: ["authentic jerseys", "replica jerseys", "soccer kits", "jersey sizing", "fan merchandise", "jersey collecting", "team jerseys"],
  },
  payment_processing: {
    label: "Payment Processing & Fintech",
    industry: "Financial Technology",
    defaultAudience: "Business owners, financial decision-makers, developers, e-commerce operators",
    defaultBrandVoice: "business consultant, fintech expert, technical advisor",
    contentStyle: "Use correct terminology (interchange, acquirer, PSP), real fee structures, include hidden costs, compliance requirements",
    keyTopics: ["Stripe", "Square", "payment gateway", "transaction fees", "PCI compliance", "merchant account", "payment integration"],
  },
  web_dev: {
    label: "Web Development",
    industry: "Software Development",
    defaultAudience: "Beginners to experienced developers evaluating tools and approaches",
    defaultBrandVoice: "experienced developer, pragmatic engineer",
    contentStyle: "Use current web standards, reference actual versions (React 18, Node 20), address trade-offs honestly, explain why not just how",
    keyTopics: ["React", "Next.js", "JavaScript", "web performance", "frameworks", "frontend development", "backend development"],
  },
  app_dev: {
    label: "App Development",
    industry: "Mobile Development",
    defaultAudience: "Entrepreneurs, business stakeholders, developers evaluating platforms",
    defaultBrandVoice: "realistic consultant, mobile development expert",
    contentStyle: "Balance business and technical perspectives, honest cost ranges and timelines, include ongoing costs, post-launch reality",
    keyTopics: ["React Native", "Flutter", "iOS development", "Android development", "app costs", "mobile development", "cross-platform"],
  },
  construction: {
    label: "Construction & B2B Services",
    industry: "Construction",
    defaultAudience: "Contractors, subcontractors, construction business owners, project managers",
    defaultBrandVoice: "industry veteran, construction business consultant",
    contentStyle: "Use correct construction terminology (GC, sub, bid process), real cost ranges, regulatory requirements, regional differences",
    keyTopics: ["commercial construction", "bidding strategy", "project management", "subcontractors", "construction business", "permits"],
  },
  loans: {
    label: "Loans & Lending",
    industry: "Financial Services",
    defaultAudience: "Borrowers researching options, credit rebuilders, financial education seekers",
    defaultBrandVoice: "responsible financial advisor, consumer advocate",
    contentStyle: "Use correct financial terminology (APR, LTV, DTI), show total cost not just monthly payment, address predatory lending red flags",
    keyTopics: ["personal loans", "mortgage", "APR", "interest rates", "credit score", "loan qualification", "debt consolidation"],
  },
  tax_lawyer: {
    label: "Tax Law & IRS Representation",
    industry: "Legal Services",
    defaultAudience: "Individuals and business owners facing tax issues, CPAs researching legal options, small business owners",
    defaultBrandVoice: "authoritative legal advisor, plain-English translator of tax code",
    contentStyle: "Cite specific IRC sections and real penalty schedules, distinguish federal vs state, use concrete dollar examples and timelines, always note this is general info not legal advice",
    keyTopics: ["IRS audit", "tax debt settlement", "offer in compromise", "innocent spouse relief", "FBAR penalties", "back taxes", "wage garnishment", "tax court", "installment agreement"],
  },
  charity: {
    label: "Charity & Nonprofit Operations",
    industry: "Nonprofit Sector",
    defaultAudience: "Nonprofit founders, board members, donors, fundraisers, grant writers",
    defaultBrandVoice: "mission-driven advisor, experienced nonprofit operator",
    contentStyle: "Reference real 501(c)(3) requirements and actual grant sources, cite donor psychology research, include realistic budgets and overhead ratios, cover legal compliance honestly",
    keyTopics: ["501(c)(3) status", "donor retention", "grant writing", "fundraising campaigns", "nonprofit governance", "Form 990", "Giving Tuesday", "donor stewardship", "capital campaigns"],
  },
  pest_extermination: {
    label: "Pest Control & Extermination",
    industry: "Pest Management Services",
    defaultAudience: "Homeowners with pest issues, property managers, small business owners, DIY-curious researchers",
    defaultBrandVoice: "experienced pest control professional, practical exterminator",
    contentStyle: "Use correct pest names (German cockroach vs American), seasonal pest patterns, real product names (Termidor, Advion), distinguish DIY vs professional treatments, address safety for pets and children",
    keyTopics: ["termites", "bed bugs", "cockroach treatment", "rodent control", "ant infestations", "wasp removal", "integrated pest management", "preventive maintenance", "pest inspections"],
  },
  roofing: {
    label: "Roofing & Roof Repair",
    industry: "Roofing Contracting",
    defaultAudience: "Homeowners needing repairs or replacement, property managers, contractors comparing materials",
    defaultBrandVoice: "experienced roofing contractor, practical industry veteran",
    contentStyle: "Distinguish material types (asphalt shingle, metal, tile, TPO), give real cost ranges per square, address regional climate considerations and warranty terms, walk through insurance claim processes honestly",
    keyTopics: ["asphalt shingles", "metal roofing", "roof replacement cost", "storm damage claims", "roof inspections", "flashing", "underlayment", "roof leaks", "TPO commercial roofing"],
  },
  gym_subscription: {
    label: "Gym Memberships & Fitness Subscriptions",
    industry: "Fitness & Wellness",
    defaultAudience: "Consumers comparing gyms, fitness beginners, gym owners researching the market, budget-conscious health seekers",
    defaultBrandVoice: "honest fitness consultant, practical gym-goer",
    contentStyle: "Compare actual chains (Planet Fitness, LA Fitness, Equinox) with real prices, contract terms, and cancellation policies, distinguish big-box vs boutique vs class-based, address hidden fees honestly",
    keyTopics: ["Planet Fitness", "Equinox", "ClassPass", "CrossFit memberships", "gym contracts", "cancellation policies", "boutique fitness", "personal training costs", "gym comparison"],
  },
  gym_franchise: {
    label: "Gym Franchise Openings & Launches",
    industry: "Fitness Franchise",
    defaultAudience: "Local readers tracking new fitness options, prospective first-time members, fitness journalists, franchise operators",
    defaultBrandVoice: "local fitness journalist covering opening-day stories",
    contentStyle: "Focused on NEW gym launches and franchise openings — not ongoing membership comparisons (that's a separate niche). Cover ribbon-cutting dates, founder backgrounds, equipment partners, opening-day promotions, the franchise's local footprint. Name specific chains by their real local names — in Quebec: Énergie Cardio, Éconofitness, Nautilus Plus, Buzzfit, World Gym. Distinguish franchise vs corporate vs independent. Mention permit timing or municipal context when known.",
    keyTopics: ["new gym opening", "franchise launch", "ribbon cutting", "grand opening promotions", "franchise owner", "Énergie Cardio", "Éconofitness", "Nautilus Plus", "Buzzfit", "World Gym", "first-month free", "equipment partner", "build-out timeline"],
  },
  real_estate: {
    label: "Real Estate & Property",
    industry: "Real Estate",
    defaultAudience: "Home buyers and sellers, first-time mortgage applicants, small-to-mid investors evaluating rental or flip opportunities, real estate agents, brokerage staff, and local-market journalists",
    defaultBrandVoice: "experienced market analyst translating data into plain language — consumer-information voice, not sales pitch",
    contentStyle: "Concrete numbers over generic advice. Use real median sale prices, $/sq ft, days-on-market, price-to-rent ratios, cap rates, and cash-on-cash returns from named sources (NAR, Zillow Research, FRED, S&P CoreLogic Case-Shiller, CMHC for Canada, local MLS boards). Distinguish residential vs commercial vs mixed-use. Cover mortgage mechanics with the right vocabulary (DTI, LTV, PMI thresholds, 30-year vs 15-year amortization, conventional vs FHA vs CMHC-insured). Address regional variation honestly: Toronto, Montréal, Vancouver, and rural Quebec differ sharply. For investor content, name the concept (1% rule, 50% rule, cap rate ranges) and show the math. Surface transaction costs (5-6% agent split, 2-5% closing, transfer/welcome tax). Frame everything as general information; never give specific legal or tax advice.",
    keyTopics: ["home buying", "first-time buyer", "mortgage rates", "down payment", "closing costs", "MLS listing", "real estate agent commission", "cap rate", "cash-on-cash return", "rental yield", "1031 exchange", "median sale price", "days on market", "market report", "DTI ratio", "LTV", "PMI", "amortization", "commercial real estate", "investment property", "house flipping", "REIT", "Toronto market", "Montréal market", "welcome tax"],
  },
};

const DEFAULT_NICHE: NicheContext = {
  label: "General",
  industry: "General",
  defaultAudience: "general audience",
  defaultBrandVoice: "professional and informative",
  contentStyle: "clear and engaging",
  keyTopics: [],
};

/**
 * Niche aliases — keys that resolve to another canonical niche. online_casino
 * is folded into the single "gambling" niche, which now covers BOTH sportsbook
 * and casino content. Any blog row still stored as "online_casino" keeps
 * working and is treated as gambling everywhere (context, requirements,
 * language).
 */
const NICHE_ALIASES: Record<string, string> = {
  online_casino: "gambling",
};

export function normalizeNicheKey(niche: string | null | undefined): string | null {
  if (!niche) return null;
  const key = niche.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!key) return null;
  return NICHE_ALIASES[key] ?? key;
}

/**
 * Turn a raw niche string into a human-readable label.
 *
 *   "Dog Grooming"  → "Dog Grooming"
 *   "dog_grooming"  → "Dog Grooming"
 *   "DOG-GROOMING"  → "Dog Grooming"
 *
 * Used when synthesizing a NicheContext on the fly for unregistered niches
 * so the ideation + article prompts still get a real topical anchor instead
 * of falling back to a generic "General" placeholder.
 */
function humanizeNiche(raw: string): string {
  return raw
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .split(" ")
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(" ");
}

export function getNicheContext(niche: string | null | undefined): NicheContext {
  const key = normalizeNicheKey(niche);
  if (!key) return DEFAULT_NICHE;

  const registered = NICHE_CONTEXTS[key];
  if (registered) return registered;

  // Auto-generated niche profile (created on client-create, cached in memory).
  // Gives unregistered niches the same richness as the hardcoded ones.
  const generated = getCachedNicheProfile(key);
  if (generated) {
    return {
      label: generated.name,
      industry: generated.name,
      defaultAudience: generated.audience,
      defaultBrandVoice: generated.brandVoice,
      contentStyle: generated.contentStyle,
      keyTopics: generated.keyTopics,
    };
  }

  // Unregistered niche with no generated profile yet — synthesize a context
  // from the typed string so the model is still grounded in the admin's intent
  // (e.g. "Dog Grooming" → "blog topics for a Dog Grooming niche site").
  const label = humanizeNiche(niche!);
  return {
    label,
    industry: label,
    defaultAudience: `readers interested in ${label.toLowerCase()}`,
    defaultBrandVoice: "knowledgeable and helpful, evidence-based",
    contentStyle:
      "clear and specific, use real names and numbers when possible, acknowledge limitations honestly, avoid generic filler",
    keyTopics: [],
  };
}

export interface NicheSeed {
  key: string;
  label: string;
  industry: string;
  defaultAudience: string;
  defaultBrandVoice: string;
  contentStyle: string;
  keyTopics: string[];
  requirements: string;
}

/**
 * Snapshot the hardcoded niche config (context + requirements) for seeding the
 * `niches` DB table. Reads the SAME in-code maps generation uses, so the seeded
 * rows are byte-identical to the live prompt inputs. Consumed by the "Sync from
 * code" admin action in Phase 0 of the content-config rebuild — generation stays
 * on this code path until the composer is switched to read the DB.
 */
export function exportNicheSeedData(): NicheSeed[] {
  return Object.entries(NICHE_CONTEXTS).map(([key, ctx]) => ({
    key,
    label: ctx.label,
    industry: ctx.industry,
    defaultAudience: ctx.defaultAudience,
    defaultBrandVoice: ctx.defaultBrandVoice,
    contentStyle: ctx.contentStyle,
    keyTopics: ctx.keyTopics,
    requirements: getNicheRequirements(key),
  }));
}

export function getAvailableNiches(): Array<{ key: string; label: string }> {
  return Object.entries(NICHE_CONTEXTS).map(([key, ctx]) => ({ key, label: ctx.label }));
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type Tone = "professional" | "casual" | "friendly" | "authoritative" | "technical" | "warm";

export interface GenerateOptions {
  topic: string;
  keywords: string[];
  wordCount: number;
  tone: Tone;
  niche?: string | null;
  brandVoice?: string;
  targetAudience?: string;
  seoOptimized?: boolean;
  /**
   * When present, the composer uses this style profile to build the prompt
   * via the skeleton pipeline (overrides the niche-based default prompt).
   * The scrubber also runs profile-aware checks on the generated content.
   */
  styleProfile?: StyleProfile;
  /**
   * Vertical key (from src/lib/content/verticals/registry.ts). When set
   * AND the niche is not peptides, the generator pulls recent news
   * items for this vertical and instructs Claude to weave 1-3 of them
   * in as external `<a href>` links — adds topical credibility AND
   * outbound link signal for SEO. Peptide blogs intentionally skip
   * external news links for compliance.
   */
  verticalKey?: string | null;
  /**
   * Output language for the article. Comes from the vertical config's
   * `language` field.
   *   "en"    → English (default)
   *   "fr"    → French (Québec-French phrasing for the QC verticals)
   *   "en_fr" → bilingual vertical; defaults to English here (per-track
   *             FR handling lives in the charity vertical's contentTracks)
   * When undefined or "en", no language directive is added and Claude
   * writes in English as before.
   */
  language?: "en" | "fr" | "en_fr";
  /**
   * Per-blog stylistic seed. When provided, the legacy (non-profile) path
   * uses it to deterministically pick:
   *   - 2 writing-habit quirks from QUIRK_POOL
   *   - a per-blog word band drawn from inside [GLOBAL_WORD_BAND_MIN,
   *     GLOBAL_WORD_BAND_MAX]
   *   - a body-image wrapper class name
   * Same seed → same picks always. The cron passes `blog.id` so each blog
   * keeps a stable, distinct voice. Profile blogs (peptides) ignore this
   * field — their composer already does per-blog randomization.
   */
  blogSeed?: string;
  /**
   * Pre-fetched internal sibling post references for inline link injection.
   * Each entry is a previously-published post on the SAME blog. Claude is
   * instructed to weave 2-4 of these as inline <a href> links — adds the
   * single SEO signal the audit flagged as missing (internal link graph).
   */
  blogDomain?: string | null;

  internalLinkRefs?: Array<{ title: string; url: string }>;
  /**
   * Distilled summaries of the client's active Knowledge Base documents for
   * this blog. When present, they're appended to the system prompt so the
   * article draws on the client's own facts/terminology. Placed in the system
   * prefix (stable per blog) rather than the user message so it stays
   * cache-friendly if generation is ever batched per blog.
   */
  knowledgeSummaries?: string[];
  /**
   * Per-client call-to-action button appended to the bottom of the article
   * body (link to the client's main site / contact / registration page).
   * Injected deterministically — not LLM-generated.
   */
  cta?: { label: string; url: string; placement?: string; color?: string };
  /**
   * In-body contextual "money link": hyperlink the first occurrence of one of
   * `terms` (e.g. "buy bpc-157", the compound) in the opening paragraph to
   * `url`. Used by peptide location pages to link buy-phrases to the site's own
   * domain (the funnel). Injected deterministically — separate from the CTA
   * button. No-op when unset or no term is found.
   */
  buyLink?: { url: string; terms: string[] };
  /**
   * Per-client mini registration form (Name / Location / Email). When set, the
   * form is injected at the given position(s); it POSTs to `actionUrl`
   * (/api/register/{blogId}) which records the lead and redirects to the
   * client's own registration page. Injected deterministically — not
   * LLM-generated. Placement: "top" | "bottom" | "top_bottom".
   */
  registrationForm?: { actionUrl: string; placement?: string; color?: string };
  /**
   * The generated_posts row id for this post. Carried as utm_content on the
   * CTA and money links so the client's analytics attribute a session to a
   * specific article, and used as the registration form's hidden postId.
   */
  postId?: string;
  /**
   * Niche config resolved by the caller — e.g. from the editable `niches` DB
   * table (Content Studio). When provided, the legacy system prompt uses it
   * instead of the hardcoded code niche. When absent, renderSystemPrompt falls
   * back to resolveCodeNiche(niche), so any un-migrated niche keeps working.
   */
  resolvedNiche?: ResolvedNiche;
  /**
   * Optional custom generation prompt (per-blog override or client default,
   * resolved by the caller). When set and non-empty, it drives the article
   * system prompt instead of the niche/persona style — but the JSON output
   * contract, the no-images rule, the anti-AI-tell guardrails, and the niche's
   * compliance disclaimers are still appended (locked).
   */
  customPrompt?: string;
  /**
   * When a custom prompt is in effect, also layer the blog's generated
   * persona/voice on top of it (rather than the custom prompt fully replacing
   * the persona). Resolved by the caller from the client/blog "stack persona"
   * toggle. Only takes effect when both a customPrompt and a styleProfile with
   * a generatedPersona are present; otherwise it's a no-op.
   */
  applyPersona?: boolean;
  /**
   * Operator-confirmed store name for this blog (blogs.brand_name). Appended
   * to the meta TITLE as " | {brandName}" when the keyword title still fits
   * beside it — see lib/seo/meta-suffix.ts. Null/undefined means no suffix.
   * Callers must pass blogs.brand_name verbatim and must NOT substitute
   * content/brand.ts's deriveBrandName() — that value is a form-prefill
   * suggestion, never authoritative.
   */
  brandName?: string | null;
  /**
   * Local keyword-targeted content (see docs/local-keyword-content-plan.md).
   * Present only when a blog_keyword_targets row was claimed for this post —
   * the caller (runGenerateAndPublish) resolves this; absent for every post
   * on a blog with no assigned city, which keeps this feature strictly
   * additive. When set: the article works the exact keyword phrase in
   * naturally, gives the city substantive (not find-and-replace) treatment,
   * and names brandName once in the body as the source. The meta title and
   * description are guaranteed to carry keyword + city regardless of what
   * Claude wrote — see lib/seo/local-target.ts.
   */
  localTarget?: {
    keyword: string;
    city: string;
    region?: string | null;
    countryCode?: string | null;
    brandName?: string | null;
    brandUrl?: string | null;
  };
}

export interface GeneratedContent {
  title: string;
  content: string;
  excerpt: string;
  metaTitle: string;
  metaDescription: string;
  keywords: string[];
  wordCount: number;
}

export interface AnalysisScores {
  seoScore: number;
  readabilityScore: number;
  brandVoiceScore: number;
}

export interface GenerationResult extends GeneratedContent, AnalysisScores {
  tokensUsed: number;
  costUsd: number;
  heroImageUrl?: string;
  /**
   * Second deliberately differently-framed image for the body of the
   * post. Already embedded into `content` HTML at the midpoint by the
   * generator; surfaced here too so the caller can persist it on its
   * own column without HTML-parsing.
   */
  bodyImageUrl?: string;
  /** Scrubber audit trail, populated when scrubber runs. */
  scrubberReport?: ScrubberReport;
  /** True if scrubber flagged this post for admin review. */
  flaggedForReview?: boolean;
  /**
   * The scrubber's typed decision for this post (T07). Undefined on the
   * non-profile "lite" path, which has no thresholds and never gates.
   * The publish paths branch on this rather than on the two booleans.
   */
  scrubberVerdict?: ScrubberVerdict;
}

// ─── Model wrapper (DeepSeek primary, Claude fallback) ──────────────────────

type ModelProvider = "deepseek" | "claude";

interface ClaudeCallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Which provider actually produced this result — drives cost accounting. */
  provider: ModelProvider;
  /**
   * True when the provider stopped because it hit max_tokens rather than
   * finishing its turn:
   *   Claude   — response.stop_reason === "max_tokens"
   *   DeepSeek — choices[0].finish_reason === "length"
   * Authoritative. The JSON-repair tier is a backstop for providers/paths
   * that do not report it.
   */
  truncated: boolean;
}

/**
 * Bracket-aware JSON extraction. Walks the text from the first `{`, tracks
 * brace depth while ignoring braces inside string literals, and returns
 * the substring of the first complete top-level object.
 *
 * Handles every shape Claude has produced in the wild:
 *
 *   {...}                            ← clean
 *   ```json\n{...}\n```              ← markdown-fenced
 *   ```\n{...}\n```                  ← bare-fenced
 *   "Here is the JSON: {...} done."  ← prose-wrapped
 *   {...}\n```                       ← trailing fence
 *   \n  {...}\n{...}                 ← multiple objects (returns first)
 *
 * Unlike the previous naive "first { to last }" version, this never
 * mistakes a `}` inside a string value for the closing brace.
 */
function extractJsonObject(text: string): string {
  const startIdx = text.indexOf("{");
  if (startIdx === -1) return text.trim();

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.substring(startIdx, i + 1);
      }
    }
  }

  // Hit end without closing — response was truncated. Return what we have
  // so the caller can attempt repair / decide whether to retry.
  return text.substring(startIdx);
}

/**
 * Repair common LLM JSON issues that JSON.parse rejects but we can
 * confidently fix:
 *
 *   1. Trailing commas inside arrays / objects: `[1,2,3,]` → `[1,2,3]`
 *   2. Unescaped control chars inside strings: literal `\n`, `\r`, `\t`
 *      become escaped `\\n`, `\\r`, `\\t` (Claude sometimes embeds raw
 *      newlines in HTML content fields)
 *   3. Smart quotes around keys: `"key"` → `"key"`
 *
 * Things this does NOT fix (would require a real parser):
 *   - Unescaped double quotes inside string values
 *   - Comments
 *   - Single-quoted strings
 *
 * Caller falls back to retrying the Claude call if these heuristics
 * aren't enough.
 */
function repairLlmJson(text: string): string {
  // Smart quotes anywhere (Claude rarely produces these but it has)
  let result = text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");

  // Walk the text and escape literal control chars only inside string
  // literals (where they're invalid JSON). Outside strings they're just
  // whitespace and JSON.parse accepts them.
  let fixed = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < result.length; i++) {
    const ch = result[i];

    if (escape) {
      fixed += ch;
      escape = false;
      continue;
    }

    if (inString && ch === "\\") {
      fixed += ch;
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      fixed += ch;
      continue;
    }

    if (inString) {
      if (ch === "\n") {
        fixed += "\\n";
        continue;
      }
      if (ch === "\r") {
        fixed += "\\r";
        continue;
      }
      if (ch === "\t") {
        fixed += "\\t";
        continue;
      }
    }

    fixed += ch;
  }
  result = fixed;

  // Strip trailing commas: ", ]" → " ]", ", }" → " }". Regex is safe here
  // because we only target the comma followed by closing bracket; it
  // doesn't matter whether we're inside a string because LLMs essentially
  // never embed literal `, ]` patterns inside string values.
  result = result.replace(/,(\s*[\]}])/g, "$1");

  return result;
}

/**
 * Repair unescaped double quotes that appear INSIDE JSON string values.
 *
 * Classic Claude failure mode: emits HTML inside a string field with
 * unescaped attribute quotes, e.g.
 *
 *   { "content": "<a href="https://example.com">link</a>" }
 *
 * The inner `"` characters close the string prematurely; downstream
 * parsing fails with "Expected ',' or '}' after property value" deep in
 * the response.
 *
 * Strategy: walk the text. At every `"`, decide whether it's a real
 * string boundary or an escaped-but-Claude-forgot-to-escape quote by
 * looking at the next non-whitespace character:
 *
 *   `: , } ] EOF`  → real boundary (key terminator / value separator / structural)
 *   anything else  → unescaped quote inside a value; escape it
 *
 * Tolerates correctly-escaped backslash-quote pairs and ignores quotes
 * outside string context.
 */
function escapeStrayQuotesInsideStrings(text: string): string {
  let result = "";
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      result += ch;
      escape = false;
      continue;
    }

    if (ch === "\\") {
      result += ch;
      escape = true;
      continue;
    }

    if (ch !== '"') {
      result += ch;
      continue;
    }

    // We hit a `"`. Decide: open, close, or stray-inside-value?
    if (!inString) {
      // Outside any string — this opens a new one.
      inString = true;
      result += ch;
      continue;
    }

    // We're inside a string. Look ahead at the next non-whitespace char.
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    const next = j < text.length ? text[j] : undefined;

    const isBoundary =
      next === undefined ||  // end of input
      next === ":" ||
      next === "," ||
      next === "}" ||
      next === "]";

    if (isBoundary) {
      // Valid string close.
      inString = false;
      result += ch;
    } else {
      // Stray unescaped quote inside the value — escape it.
      result += '\\"';
    }
  }

  return result;
}

/** What repairTruncatedJson did, so callers can tell salvage from success. */
interface TruncationRepairResult {
  text: string;
  /**
   * True when the input was NOT a complete JSON document and we patched it.
   * The resulting object parses, but any string it was in the middle of is
   * a FRAGMENT. Never publish a body that came back with this set.
   */
  repaired: boolean;
}

/**
 * Repair JSON that was TRUNCATED mid-output (Claude hit max_tokens before
 * closing the last string and the wrapping braces). Strategy:
 *
 *   1. Walk the text tracking string-context, escape-context, and the
 *      bracket stack ({ vs [).
 *   2. Find the last position where a complete key-value pair ended
 *      (i.e. a `,` at object depth, outside any string). This is the
 *      safe truncation point that keeps a valid JSON object.
 *   3. If found, truncate the text there and close all open brackets.
 *      The post loses the in-progress field but everything else parses.
 *   4. If no clean boundary found (very short response), close the
 *      open string + brackets as a last resort.
 *
 * The result is a DIAGNOSTIC SALVAGE, not a publishable article. It exists so
 * the caller can read the recovered `title` for logging and decide whether to
 * retry — before T06 the salvaged body was published as-is, which is what put
 * half-sentence posts on live client blogs. Callers MUST check `.repaired`.
 */
function repairTruncatedJson(text: string): TruncationRepairResult {
  let depth = 0;
  let inString = false;
  let escape = false;
  let lastSafeBoundary = -1; // position right BEFORE a `,` at object depth
  const stack: string[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      stack.push("{");
      depth++;
    } else if (ch === "[") {
      stack.push("[");
    } else if (ch === "}") {
      stack.pop();
      depth--;
    } else if (ch === "]") {
      stack.pop();
    } else if (
      ch === "," &&
      stack.length > 0 &&
      stack[stack.length - 1] === "{"
    ) {
      lastSafeBoundary = i;
    }
  }

  // If parse-state ended cleanly, the input is fine.
  if (!inString && depth === 0 && stack.length === 0) {
    return { text, repaired: false };
  }

  // Decide where to cut.
  let result: string;
  if (inString) {
    // Truncated mid-string-value — the common case for a long `content`
    // field. Keep EVERYTHING and just close the open string. Rolling back to
    // the previous complete field (lastSafeBoundary) here would discard the
    // whole partial value; for the {title, content} envelope that means
    // dropping the entire article body and surfacing only the title (the
    // "missing content (keys: title)" failure). A partial body is recoverable
    // (sanitize + capWordCount clean it up); an empty one is not.
    result = text + '"';
  } else if (lastSafeBoundary > 0) {
    // Truncated cleanly between fields — roll back to the last complete pair.
    result = text.substring(0, lastSafeBoundary);
  } else {
    result = text;
  }

  // Recount open brackets at the truncated position and close them.
  let inStr = false;
  let esc = false;
  const closeStack: string[] = [];
  for (let i = 0; i < result.length; i++) {
    const ch = result[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      closeStack.push("{");
    } else if (ch === "[") closeStack.push("[");
    else if (ch === "}") {
      closeStack.pop();
    } else if (ch === "]") closeStack.pop();
  }
  if (inStr) result += '"';
  while (closeStack.length > 0) {
    const open = closeStack.pop();
    result += open === "{" ? "}" : "]";
  }

  return { text: result, repaired: true };
}

/**
 * Tolerant article-shape normalizer. Handles the most common ways Claude
 * deviates from the requested {title, content, excerpt, ...} envelope:
 *
 *   1. Wraps the article in an outer object: {"article": {...}} or
 *      {"data": {...}} or {"response": {...}}
 *   2. Renames "content" to "html", "body", "article_html", or "article_body"
 *   3. Renames "title" to "headline" or "post_title"
 *   4. Splits the article into parts instead of one content string:
 *        - {intro, items[]}            → listicle
 *        - {intro, body, conclusion}   → three-part
 *        - {sections: [{heading, content}, ...]}
 *        - {paragraphs: ["...", "..."]}
 *        - {content: [...]} (array instead of string)
 *      These get stitched into a single HTML string.
 *
 * Returns the (possibly unwrapped + remapped) partial. Other shape mismatches
 * surface as the "missing required fields" error with the actual key list.
 */
function normalizeArticleShape(
  parsed: Partial<GeneratedContent> & Record<string, unknown>,
): Partial<GeneratedContent> {
  // Unwrap a single-key wrapper that looks like the real envelope.
  const wrapperKeys = ["article", "data", "response", "result", "output"];
  for (const key of wrapperKeys) {
    const inner = parsed[key];
    if (
      inner &&
      typeof inner === "object" &&
      !Array.isArray(inner) &&
      ("title" in (inner as object) ||
        "content" in (inner as object) ||
        "intro" in (inner as object) ||
        "sections" in (inner as object))
    ) {
      parsed = inner as Partial<GeneratedContent> & Record<string, unknown>;
      break;
    }
  }

  // Remap alternate field names.
  if (!parsed.title) {
    const titleAlt = parsed.headline ?? parsed.post_title ?? parsed.article_title;
    if (typeof titleAlt === "string") parsed.title = titleAlt;
  }
  if (!parsed.content) {
    const contentAlt =
      parsed.html ?? parsed.body ?? parsed.article_html ?? parsed.article_body;
    if (typeof contentAlt === "string") parsed.content = contentAlt;
  }

  // Multi-part reconstruction — stitch alternate part-shaped responses
  // into a single HTML content string. Only runs when `content` is still
  // missing, so a well-formed response is never touched.
  if (!parsed.content || typeof parsed.content !== "string") {
    const stitched = reconstructContentFromParts(parsed);
    if (stitched) {
      parsed.content = stitched;
    }
  }

  return parsed;
}

/**
 * Stitch a Claude response that returned the article as parts into a
 * single HTML string. Best-effort — returns null when nothing usable is
 * found so the caller can fall through to the "missing required fields"
 * error with the original key list.
 *
 * Handles (in priority order):
 *
 *   {sections: [{heading, content}, ...]}
 *      → <h2>heading</h2><p>content</p> for each section
 *   {intro: "...", items: ["...", ...]}
 *      → <p>intro</p><ul><li>item</li>...</ul>
 *   {intro: "...", items: [{heading, body}, ...]}
 *      → <p>intro</p><h2>heading</h2><p>body</p>...
 *   {intro, body, conclusion}
 *      → <p>intro</p>...body...<p>conclusion</p>
 *   {paragraphs: ["...", ...]}
 *      → <p>p1</p><p>p2</p>...
 *   {content: ["string", "string"]}   (array instead of string)
 *      → joined as <p>...</p> blocks
 */
function reconstructContentFromParts(
  parsed: Record<string, unknown>,
): string | null {
  const out: string[] = [];

  const intro = parsed["intro"];
  const items = parsed["items"];
  const sections = parsed["sections"];
  const paragraphs = parsed["paragraphs"];
  const conclusion = parsed["conclusion"];
  const bodyText = parsed["body"];
  const contentAny = parsed["content"];

  // sections: [{heading, content|body|text}]
  if (Array.isArray(sections) && sections.length > 0) {
    if (typeof intro === "string") out.push(maybeWrapHtml(intro));
    for (const sec of sections) {
      if (!sec || typeof sec !== "object") continue;
      const s = sec as Record<string, unknown>;
      const heading = pickString(s, ["heading", "title", "header"]);
      const text = pickString(s, ["content", "body", "text", "paragraph"]);
      if (heading) out.push(`<h2>${escapeHtml(heading)}</h2>`);
      if (text) out.push(maybeWrapHtml(text));
    }
    if (typeof conclusion === "string") out.push(maybeWrapHtml(conclusion));
    return out.length > 0 ? out.join("\n") : null;
  }

  // intro + items (listicle or part-shaped)
  if (Array.isArray(items) && items.length > 0) {
    if (typeof intro === "string") out.push(maybeWrapHtml(intro));
    const allStrings = items.every((it) => typeof it === "string");
    if (allStrings) {
      // Plain listicle — items are bullet strings.
      out.push("<ul>");
      for (const it of items as string[]) {
        out.push(`<li>${escapeHtml(it)}</li>`);
      }
      out.push("</ul>");
    } else {
      // Object items — usually {heading/title, body/content/description}.
      for (const it of items) {
        if (!it || typeof it !== "object") continue;
        const i = it as Record<string, unknown>;
        const heading = pickString(i, ["heading", "title", "header", "name"]);
        const text = pickString(i, [
          "body",
          "content",
          "description",
          "text",
          "paragraph",
        ]);
        if (heading) out.push(`<h2>${escapeHtml(heading)}</h2>`);
        if (text) out.push(maybeWrapHtml(text));
      }
    }
    if (typeof conclusion === "string") out.push(maybeWrapHtml(conclusion));
    return out.length > 0 ? out.join("\n") : null;
  }

  // intro + body + conclusion (three-part essay shape)
  if (
    typeof intro === "string" ||
    typeof bodyText === "string" ||
    typeof conclusion === "string"
  ) {
    if (typeof intro === "string") out.push(maybeWrapHtml(intro));
    if (typeof bodyText === "string") out.push(maybeWrapHtml(bodyText));
    if (typeof conclusion === "string") out.push(maybeWrapHtml(conclusion));
    return out.length > 0 ? out.join("\n") : null;
  }

  // paragraphs: [...]
  if (Array.isArray(paragraphs) && paragraphs.length > 0) {
    for (const p of paragraphs) {
      if (typeof p === "string") out.push(maybeWrapHtml(p));
    }
    return out.length > 0 ? out.join("\n") : null;
  }

  // content: ["string", "string"] — array instead of string
  if (Array.isArray(contentAny) && contentAny.length > 0) {
    for (const c of contentAny) {
      if (typeof c === "string") out.push(maybeWrapHtml(c));
    }
    return out.length > 0 ? out.join("\n") : null;
  }

  return null;
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * If the input already looks like HTML (has angle-bracket tags), pass
 * it through. Otherwise wrap it as a paragraph.
 */
function maybeWrapHtml(text: string): string {
  const trimmed = text.trim();
  if (/<\s*(p|h[1-6]|ul|ol|li|strong|em|a|br|div|section)\b/i.test(trimmed)) {
    return trimmed;
  }
  return wrapParagraph(trimmed);
}

function wrapParagraph(text: string): string {
  return `<p>${escapeHtml(text)}</p>`;
}

/**
 * Try JSON.parse on:
 *   1. The raw text                  (the happy path)
 *   2. Light repair                  (smart quotes, trailing commas, control chars)
 *   3. Stray-quote repair            (escape unescaped " inside string values,
 *                                     e.g. HTML attribute quotes Claude forgot
 *                                     to backslash-escape)
 *   4. Truncation repair             (closes unterminated strings + braces,
 *                                     applied on top of light repair)
 *
 * Returns the parsed value or throws the original error with a helpful
 * preview of where parsing failed.
 */
/** Which repair tier produced a parse. "truncation" means the model ran
 * out of tokens and the body is cut short — see T06. */
export type JsonRepairTier = "none" | "light" | "stray-quote" | "truncation";

/**
 * Same behaviour as safeParseClaudeJson, but reports which tier succeeded
 * so callers can count salvaged truncations instead of silently shipping
 * a fragment. safeParseClaudeJson delegates here and drops the tier, so
 * existing call sites are byte-identical in behaviour.
 */
export function safeParseClaudeJsonWithTier<T = unknown>(
  text: string,
): { value: T; tier: JsonRepairTier } {
  // 1. Happy path
  try {
    return { value: JSON.parse(text) as T, tier: "none" };
  } catch (err1) {
    // 2. Light repair
    try {
      return { value: JSON.parse(repairLlmJson(text)) as T, tier: "light" };
    } catch {
      // 3. Stray-quote repair on top of light repair
      try {
        return {
          value: JSON.parse(
            repairLlmJson(escapeStrayQuotesInsideStrings(text)),
          ) as T,
          tier: "stray-quote",
        };
      } catch {
        // 4. Truncation repair as last resort. `repaired` distinguishes a
        //    genuine salvage (the model ran out of budget mid-object) from
        //    the case where repairTruncatedJson found nothing to patch —
        //    only the former is a truncated article (T06).
        try {
          const recovered = repairTruncatedJson(text);
          return {
            value: JSON.parse(
              repairLlmJson(escapeStrayQuotesInsideStrings(recovered.text)),
            ) as T,
            tier: recovered.repaired ? "truncation" : "stray-quote",
          };
        } catch {
          const msg = err1 instanceof Error ? err1.message : "JSON parse failed";
          const match = /position\s+(\d+)/i.exec(msg);
          if (match) {
            const pos = parseInt(match[1], 10);
            const start = Math.max(0, pos - 80);
            const end = Math.min(text.length, pos + 80);
            const around = text.slice(start, end).replace(/\s+/g, " ").trim();
            throw new Error(
              `${msg} | context near pos ${pos}: "...${around}..."`,
            );
          }
          throw err1;
        }
      }
    }
  }
}

export function safeParseClaudeJson<T = unknown>(text: string): T {
  return safeParseClaudeJsonWithTier<T>(text).value;
}

/**
 * Returns true when an Anthropic SDK error is worth retrying. We treat
 * 429 (rate limit), 500/502/503/504 (server), 529 (overloaded), and
 * network / timeout / connection-reset errors as transient. 4xx other
 * than 429 are permanent (bad request, auth, etc.) and bubble up.
 */
function isTransientClaudeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { status?: number; type?: string };
  if (e.status !== undefined) {
    if (e.status === 429 || e.status === 529) return true;
    if (e.status >= 500 && e.status < 600) return true;
  }
  const msg = err.message.toLowerCase();
  if (
    msg.includes("rate limit") ||
    msg.includes("overloaded") ||
    msg.includes("timeout") ||
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("internal server error")
  ) {
    return true;
  }
  return false;
}

const MAX_CLAUDE_RETRIES = 3;
const CLAUDE_BACKOFF_BASE_MS = 2000; // 2s, 4s, 8s

async function callClaudeOnce(
  system: string,
  userMessage: string,
  options: { maxTokens?: number; temperature?: number; expectJson?: boolean },
): Promise<ClaudeCallResult> {
  const { maxTokens = 4000, temperature = 0.7, expectJson = false } = options;

  // Per-provider ceiling. claude-sonnet-4-6 accepts up to 128,000 output
  // tokens, but this is a NON-STREAMING request, so we hold it to the
  // non-streaming-safe default. Callers compute a desired budget without
  // knowing which provider will serve the call; the clamp belongs here.
  const boundedMaxTokens = Math.min(maxTokens, CLAUDE_MAX_OUTPUT_TOKENS);
  if (boundedMaxTokens < maxTokens) {
    console.warn(
      `[claude] requested max_tokens ${maxTokens} clamped to ${boundedMaxTokens}`,
    );
  }

  // Compact JSON envelope. The detailed schema rules (no wrapping, no
  // renaming "content", no "deck"/"subtitle" substitution, etc.) already
  // live in buildSystemPrompt / composeForPost. safeParseClaudeJson handles
  // markdown-fence and stray-quote repair, so we don't need to spell that
  // out either. Keeping this short reduces token cost AND the recognizable
  // network-wide response shape (per the footprint audit).
  const finalSystem = expectJson
    ? `${system}\n\nOUTPUT: Return ONE valid JSON object only. Escape every \\" inside HTML attribute values. Close every string and the object before hitting the token budget — a shorter complete article beats a truncated long one.`
    : system;

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: boundedMaxTokens,
    temperature,
    system: finalSystem,
    messages: [{ role: "user", content: userMessage }],
  });

  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("Claude returned no text content");
  }

  const rawText = block.text;
  // Always extract the JSON object when caller expects JSON. The previous
  // implementation only stripped when text didn't start with `{`, missing
  // cases where Claude wrapped output in markdown fences but the first
  // non-whitespace char appeared to be `{` (or vice versa).
  const text = expectJson ? extractJsonObject(rawText) : rawText.trim();

  const truncated = response.stop_reason === "max_tokens";
  if (truncated) {
    console.warn(
      `[claude] response hit max_tokens (${boundedMaxTokens}) — output is truncated`,
    );
  }

  return {
    text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    provider: "claude",
    truncated,
  };
}

/**
 * One DeepSeek call via its OpenAI-compatible Chat Completions endpoint
 * (POST {base}/chat/completions, Bearer auth). Returns the same shape as
 * callClaudeOnce so the two are interchangeable. Network/timeout/5xx/429
 * errors are thrown with a `status` so isTransientClaudeError() treats them
 * as retryable — and, after retries, callClaude() falls back to Claude.
 */
async function callDeepSeekOnce(
  system: string,
  userMessage: string,
  options: { maxTokens?: number; temperature?: number; expectJson?: boolean },
): Promise<ClaudeCallResult> {
  const { maxTokens = 4000, temperature = 0.7, expectJson = false } = options;
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");

  // Per-provider ceiling. DEEPSEEK_MODEL is env-configurable and points at a
  // generic OpenAI-compatible endpoint, so the real limit is not knowable
  // from this repo — DEEPSEEK_MAX_OUTPUT_TOKENS makes it operator-settable.
  // An over-large value comes back as HTTP 400, which isTransientClaudeError
  // treats as permanent, so callClaude() falls through to Claude.
  const deepseekCap = deepseekMaxOutputTokens();
  const boundedMaxTokens = Math.min(maxTokens, deepseekCap);
  if (boundedMaxTokens < maxTokens) {
    console.warn(
      `[deepseek] requested max_tokens ${maxTokens} clamped to ${boundedMaxTokens} ` +
      `(DEEPSEEK_MAX_OUTPUT_TOKENS). Raise it if ${DEEPSEEK_MODEL} supports more.`,
    );
  }

  const finalSystem = expectJson
    ? `${system}\n\nOUTPUT: Return ONE valid JSON object only. Escape every \\" inside HTML attribute values. Close every string and the object before hitting the token budget — a shorter complete article beats a truncated long one.`
    : system;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEEPSEEK_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: finalSystem },
          { role: "user", content: userMessage },
        ],
        max_tokens: boundedMaxTokens,
        temperature,
        // deepseek-v4-pro enables thinking by default — the chain-of-thought
        // goes to `reasoning_content` and can leave `content` empty (or eat the
        // token budget and truncate it), which surfaced as "no text content".
        // Article generation doesn't need reasoning, so disable it: `content`
        // is then populated directly and `temperature` is honoured (thinking
        // mode ignores temperature/top_p).
        thinking: { type: "disabled" },
        ...(expectJson ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    // Network error → 503, transient, worth a retry.
    // Abort/deadline → 408, PERMANENT. isTransientClaudeError only treats
    // 429/529/5xx as transient, so 408 breaks callWithRetry immediately and
    // callClaude() falls through to Claude. Retrying an identical request
    // against the same deadline 3 more times just multiplies the deadline
    // (4 x 180s would exceed the auto-publish route's 600s maxDuration).
    const e = err as Error;
    const wrapped = new Error(
      e.name === "AbortError"
        ? `DeepSeek request exceeded the ${DEEPSEEK_TIMEOUT_MS}ms deadline`
        : `DeepSeek network error: ${e.message}`,
    ) as Error & { status?: number };
    wrapped.status = e.name === "AbortError" ? 408 : 503;
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    const err = new Error(
      `DeepSeek API ${response.status}: ${errText.slice(0, 200)}`,
    ) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message?: { content?: string; reasoning_content?: string };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = data.choices?.[0];
  const rawText = choice?.message?.content;
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    // Diagnostic: finish_reason="length" → raise max_tokens; a populated
    // reasoning_content with empty content → thinking wasn't disabled.
    const fr = choice?.finish_reason ?? "unknown";
    const hadReasoning = Boolean(choice?.message?.reasoning_content);
    throw new Error(
      `DeepSeek returned empty content (finish_reason=${fr}, reasoning_present=${hadReasoning})`,
    );
  }
  const text = expectJson ? extractJsonObject(rawText) : rawText.trim();

  const truncated = choice?.finish_reason === "length";
  if (truncated) {
    console.warn(
      `[deepseek] finish_reason=length at max_tokens ${boundedMaxTokens} — output is truncated`,
    );
  }

  return {
    text,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    provider: "deepseek",
    truncated,
  };
}

/**
 * Run `fn` with automatic retry on transient errors (429 / 5xx / network /
 * timeout) using exponential backoff (2s, 4s, 8s). Non-transient errors throw
 * immediately so callers can fall back fast.
 */
async function callWithRetry(
  label: string,
  fn: () => Promise<ClaudeCallResult>,
): Promise<ClaudeCallResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_CLAUDE_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_CLAUDE_RETRIES) break;
      if (!isTransientClaudeError(err)) break;
      const delayMs = CLAUDE_BACKOFF_BASE_MS * Math.pow(2, attempt);
      const msg = err instanceof Error ? err.message : String(err);
      recordPipelineError({
        site: "content-generator.callWithRetry",
        code: "PROVIDER_TRANSIENT",
        severity: "warn",
        message: `Transient error (attempt ${attempt + 1}/${MAX_CLAUDE_RETRIES + 1}), retrying in ${delayMs}ms: ${msg.slice(0, 200)}`,
        context: { label, attempt: attempt + 1, delayMs },
      });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/**
 * Public model wrapper. PRIMARY = DeepSeek v4-pro (when DEEPSEEK_API_KEY is
 * set); FALLBACK = Claude. Each provider gets its own transient-error retry
 * budget; if DeepSeek still fails (including auth / bad-request), we log and
 * transparently fall back to Claude so a post is never lost to a DeepSeek
 * outage. The returned `.provider` drives cost accounting.
 *
 * Named `callClaude` for call-site compatibility — every generation path
 * (article, scene summary, analysis) already routes through it.
 */
async function callClaude(
  system: string,
  userMessage: string,
  options: { maxTokens?: number; temperature?: number; expectJson?: boolean } = {},
): Promise<ClaudeCallResult> {
  // Operator-selected provider (Settings → AI Models). Default "auto" preserves
  // the historical DeepSeek→Claude behavior. Falls back to "auto" on any lookup
  // error so a settings hiccup never blocks generation.
  let mode: ContentModel = DEFAULT_CONTENT_MODEL;
  try {
    mode = await getContentModel();
  } catch {
    mode = DEFAULT_CONTENT_MODEL;
  }

  const wantDeepseek = mode === "auto" || mode === "deepseek";
  if (wantDeepseek && deepseekConfigured()) {
    try {
      const r = await callWithRetry("deepseek", () =>
        callDeepSeekOnce(system, userMessage, options),
      );
      bumpProvider("deepseek");
      return r;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "deepseek" = exclusive: surface the error instead of silently billing
      // Claude (the whole point of forcing DeepSeek is to avoid Claude).
      if (mode === "deepseek") throw err;
      // Not just noise: Claude output tokens are ~10x DeepSeek's, so a
      // silent fleet-wide fallback is a cost incident.
      recordPipelineError({
        site: "content-generator.callClaude",
        code: "PROVIDER_FALLBACK",
        severity: "error",
        message: `DeepSeek failed — falling back to Claude: ${msg.slice(0, 200)}`,
        context: { mode, maxTokens: options.maxTokens ?? 4000 },
      });
    }
  } else if (mode === "deepseek") {
    throw new Error(
      "Content model is set to DeepSeek only, but DEEPSEEK_API_KEY is not configured.",
    );
  }
  return await callWithRetry("claude", () =>
    callClaudeOnce(system, userMessage, options),
  );
}

function calcCost(
  inputTokens: number,
  outputTokens: number,
  provider: ModelProvider = "claude",
): number {
  const p = provider === "deepseek" ? DEEPSEEK_PRICING : PRICING;
  return inputTokens * p.inputPerToken + outputTokens * p.outputPerToken;
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

function convertMarkdownToHtml(content: string): string {
  return content
    .replace(/^######\s+(.+)$/gm, "<h6>$1</h6>")
    .replace(/^#####\s+(.+)$/gm, "<h5>$1</h5>")
    .replace(/^####\s+(.+)$/gm, "<h4>$1</h4>")
    .replace(/^###\s+(.+)$/gm, "<h3>$1</h3>")
    .replace(/^##\s+(.+)$/gm, "<h2>$1</h2>")
    // A single `#` would be the page H1, but the platform (Shopify/WP theme)
    // already renders the post *title* as the page's sole <h1>. Emitting
    // another <h1> in the body creates a duplicate-H1 SEO error, so we map
    // `#` to <h2> instead. demoteH1ToH2() below is the belt-and-suspenders
    // catch for any literal <h1> Claude writes directly as HTML.
    .replace(/^#\s+(.+)$/gm, "<h2>$1</h2>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, "<em>$1</em>");
}

function sanitizeMetadata(html: string): string {
  return html
    .replace(/<p>\s*Created:\s*.+?<\/p>/gi, "")
    .replace(/<p>\s*Niche:\s*.+?<\/p>/gi, "")
    .replace(/<p>\s*Keywords?:\s*.+?<\/p>/gi, "")
    .replace(/<p>\s*<em>Discover\s+.+?<\/em>\s*<\/p>/gi, "")
    .replace(/<p>\s*<\/p>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Strip any Claude-emitted image tags (they'd have placeholder or hallucinated
 * URLs that 404). We attach a real hero image as a featured image at publish
 * time instead.
 */
function stripClaudeImages(html: string): string {
  return html
    .replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, "")
    .replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, "")
    .replace(/<img\b[^>]*\/?>/gi, "")
    .replace(/<source\b[^>]*\/?>/gi, "")
    .replace(/<figcaption\b[^>]*>[\s\S]*?<\/figcaption>/gi, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/<p>\s*<\/p>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Soft word-count enforcement: if the model ignored the upper bound, trim down
 * to the last VISIBLE word that still fits within `max`, then close every
 * element the cut left open. We never pad shorts — that's the prompt's job.
 *
 * Counting matches countWordsInHtml(): markup is NOT a word. The previous
 * implementation split on whitespace and counted every token, so a standalone
 * <ul> counted as one word and
 *   <a href="https://x/y" target="_blank" rel="nofollow">
 * counted as four — it therefore trimmed EARLIER than `max` by roughly the
 * number of markup tokens in the body.
 *
 * T23 owns the full post-processor rewrite. This version fixes only the two
 * properties the T06 token-budget change makes load-bearing:
 *   1. counting parity with countWordsInHtml
 *   2. closing more than just <p>, so a cap-trim is not indistinguishable
 *      from a model truncation in the published HTML
 */
export function capWordCount(html: string, max: number): string {
  if (countWordsInHtml(html) <= max) return html;

  // Walk the string alternating between markup and text runs, counting words
  // only inside text runs. The cut offset always lands on a word boundary
  // inside a text run, so we can never slice a tag in half.
  const TAG_OR_TEXT = /<[^>]*>|[^<]+/g;
  let count = 0;
  let cutAt = -1;
  let chunk: RegExpExecArray | null;

  while ((chunk = TAG_OR_TEXT.exec(html)) !== null) {
    if (chunk[0].startsWith("<")) continue; // markup — never a word
    const wordRe = /\S+/g;
    let word: RegExpExecArray | null;
    while ((word = wordRe.exec(chunk[0])) !== null) {
      count++;
      if (count > max) {
        cutAt = chunk.index + word.index;
        break;
      }
    }
    if (cutAt >= 0) break;
  }

  if (cutAt < 0) return html;
  const truncated = html.slice(0, cutAt).replace(/\s+$/, "");
  return closeOpenTags(truncated);
}

/**
 * Append closing tags, innermost-first, for every non-void element still open
 * at the end of `html`. Keeps a cap-trimmed body from ending in a dangling
 * <ul> / <li> / <h2> / <a>, which renders as a visibly broken post AND is
 * indistinguishable from a model truncation when auditing published bodies.
 */
export function closeOpenTags(html: string): string {
  const VOID = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
  ]);
  const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  const stack: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = TAG.exec(html)) !== null) {
    const isClosing = m[1] === "/";
    const name = m[2].toLowerCase();
    const isSelfClosing = m[3] === "/";
    if (VOID.has(name) || isSelfClosing) continue;
    if (isClosing) {
      // Tolerate mis-nesting: close the nearest matching open tag.
      const idx = stack.lastIndexOf(name);
      if (idx !== -1) stack.splice(idx, 1);
    } else {
      stack.push(name);
    }
  }

  let out = html;
  for (let i = stack.length - 1; i >= 0; i--) {
    out += `</${stack[i]}>`;
  }
  return out;
}

export function countWordsInHtml(html: string): number {
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.split(" ").filter((w) => w.length > 0).length : 0;
}

function generateExcerpt(content: string): string {
  const text = content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 160 ? text.substring(0, 157) + "..." : text;
}

// SEO meta sizing is PIXEL based (see @/lib/seo/text-width). We normalize TO
// the strict-safe write targets (TITLE_TARGET_PX / DESC_TARGET_PX) so what we
// generate clears the audit ceilings (580px / 1000px) with headroom.

/**
 * Demote every <h1> in the body to <h2>. The platform renders the post
 * TITLE as the page's single <h1>; any <h1> inside the body produces the
 * "Too many H1 headings" audit error. Runs on both the legacy and profile
 * paths so no generation route can leak a body H1.
 *
 * Preserves attributes on the opening tag (rare, but harmless) by only
 * swapping the tag name.
 */
export function demoteH1ToH2(html: string): string {
  return html
    .replace(/<h1(\s[^>]*)?>/gi, "<h2$1>")
    .replace(/<\/h1\s*>/gi, "</h2>");
}

/** True when the HTML contains at least one <h1> tag. */
export function hasH1(html: string): boolean {
  return /<h1(\s[^>]*)?>/i.test(html);
}

/** Normalize heading text for duplicate comparison. */
function normalizeHeadingText(inner: string): string {
  return inner
    .replace(/<[^>]+>/g, "") // strip nested tags
    .replace(/&[a-z]+;/gi, " ") // entities → space
    .replace(/[^\p{L}\p{N}\s]/gu, "") // drop punctuation
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Remove duplicate heading TEXT from the body (Seobility "duplicate heading
 * texts" warning). Keeps the first occurrence of each heading; for any later
 * heading with the same normalized text — or one that just restates the page
 * title (the body's content stays; only the redundant heading element is
 * dropped, so the prose flows on without a repeated label).
 *
 * `title` is the post title (the page's sole <h1>), seeded as "already seen"
 * so a body heading echoing the title is removed too.
 */
export function dedupeHeadings(html: string, title: string): string {
  const seen = new Set<string>();
  const titleKey = normalizeHeadingText(title);
  if (titleKey) seen.add(titleKey);

  return html.replace(
    /<h([2-6])(\s[^>]*)?>([\s\S]*?)<\/h\1\s*>/gi,
    (match, _level, _attrs, inner) => {
      const key = normalizeHeadingText(inner);
      if (!key) return match; // empty heading — leave as-is
      if (seen.has(key)) return ""; // duplicate → drop the heading element
      seen.add(key);
      return match;
    },
  );
}

/**
 * Enforce UNIQUE anchor text across the article body (Seobility "some anchor
 * texts are used more than once" warning). Keeps the FIRST link with a given
 * visible text; any later link whose visible text matches is unwrapped to plain
 * text (the words stay, the redundant <a> is removed). Reusing the same anchor
 * text for multiple links is a weak internal-linking signal anyway — Google
 * collapses them — so dropping the duplicate link is the safe, warning-clearing
 * choice. Links with no visible text (e.g. image-only) are left untouched.
 *
 * Note: this only governs anchors WE generate in the body; repeated anchors in
 * the theme's nav/footer/related-posts are outside our control per post.
 */
export function dedupeAnchorText(html: string): string {
  const seen = new Set<string>();
  return html.replace(
    /<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (match, inner) => {
      const key = normalizeHeadingText(inner);
      if (!key) return match; // no visible text — leave as-is
      if (seen.has(key)) return inner; // duplicate text → unwrap the link
      seen.add(key);
      return match;
    },
  );
}

/**
 * Normalize the SEO meta TITLE (the <title> / title-tag) to the audit spec:
 *   - strip any legacy " Reddit" token left in a stored value (T01)
 *   - collapse whitespace
 *   - convert spaced-hyphen / en-dash / em-dash separators to " | "
 *     (Seobility / Google best practice) and collapse duplicates
 *   - append " | {brandName}" when the blog has an operator-confirmed brand
 *     AND the keyword title still fits beside it — the brand is the
 *     drop-first element, never the keyword
 *   - cap at TITLE_TARGET_PX (strict-safe under the 580px limit) on a word
 *     boundary
 * Falls back to the article title when the model omitted metaTitle.
 */
export function normalizeMetaTitle(
  raw: string | null | undefined,
  fallback: string,
  localTarget?: LocalTargetMetaContext,
  brandName?: string | null,
): string {
  // Strip the legacy token BEFORE choosing between raw and fallback, so a
  // stored value of exactly "Reddit" (the pre-T01 empty-completion bug)
  // collapses to "" and the article title takes over.
  let t = (stripLegacyRedditToken(raw) || stripLegacyRedditToken(fallback) || "")
    .replace(/\s+/g, " ")
    .trim();
  // Separator normalization: spaced dashes → vertical bar.
  t = t.replace(/\s*[–—]\s*/g, " | ").replace(/\s+-\s+/g, " | ");
  // Collapse any doubled separators and strip leading/trailing ones.
  t = t
    .replace(/(?:\s*\|\s*){2,}/g, " | ")
    .replace(/^\s*\|\s*|\s*\|\s*$/g, "")
    .trim();
  // Guarantee keyword + city survive regardless of what the model wrote —
  // BEFORE the brand suffix below, so keyword+city lead the
  // pixel-truncation-from-the-right (see lib/seo/local-target.ts). No-op when
  // the model already complied, and a no-op entirely when this post has no
  // local target.
  if (localTarget) t = ensureLocalTargetTitle(t, localTarget);
  // Brand suffix + pixel cap. No-op suffix when brandName is null/empty or
  // already present in the title (local-target's titleLead may have added it).
  return appendBrandToTitle(t, brandName);
}

/**
 * Normalize the SEO meta DESCRIPTION to the audit spec:
 *   - strip any legacy " Reddit" token left in a stored value (T01)
 *   - collapse whitespace
 *   - cap at DESC_TARGET_PX (strict-safe under the 1000px limit) on a word
 *     boundary
 * No suffix of any kind. We never pad shorts — a shorter accurate description
 * beats filler. Falls back to a body-derived excerpt when the model omitted
 * metaDescription.
 */
export function normalizeMetaDescription(
  raw: string | null | undefined,
  fallback: string,
  localTarget?: LocalTargetMetaContext,
): string {
  let d = (stripLegacyRedditToken(raw) || stripLegacyRedditToken(fallback) || "")
    .replace(/\s+/g, " ")
    .trim();
  // Guarantee the description LEADS with keyword + city, so the lead clause
  // survives pixel-truncation-from-the-right even if the rest gets cut. No-op
  // when the model already led with them, and a no-op entirely when this post
  // has no local target.
  if (localTarget) d = ensureLocalTargetDescription(d, localTarget);
  return capMetaDescription(d);
}

/**
 * Normalize the article EXCERPT (Shopify summary_html / WP excerpt). On many
 * themes the excerpt is what renders as the <meta name="description"> when no
 * explicit SEO description metafield is honored — so a long Claude-written
 * excerpt leaks straight past the meta-description pixel policy. We cap it to
 * the same strict-safe description budget so the rendered meta description
 * stays under the 1000px audit limit regardless of how the theme sources it.
 */
export function normalizeExcerpt(raw: string | null | undefined): string {
  const e = (raw || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return truncateToPx(e, DESC_FONT_PX, DESC_TARGET_PX);
}

// Hero-image URL generation lives in image-generator.ts. The composer here
// also runs a small Claude call (summarizeArticleAsScene below) that turns
// the freshly-written article body into a concrete photographic scene
// description, which then gets passed to the image model as a customPrompt.
// This is what makes the hero image actually match the post's topic instead
// of falling back to whatever generic visual theme the style profile has.

/**
 * Use Claude to convert an article into a single-sentence photographic scene
 * description suitable for Nano Banana / Imagen. The call is small (~200
 * output tokens) and adds ~2-4s and ~$0.001 to total generation cost. In
 * exchange, the image becomes content-aware instead of theme-locked.
 *
 * Returns null on any failure so the caller falls back to the static
 * scene-builder in image-generator.buildImagePrompt().
 */
async function summarizeArticleAsScene(
  title: string,
  bodyHtml: string,
  keywords: string[],
): Promise<string | null> {
  // Strip HTML and take the first ~2000 chars — enough to identify the
  // article's actual subject without paying for the whole body's tokens.
  const plain = bodyHtml
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);

  const system = `You write image-generation prompts for editorial documentary photography. Given an article, you describe ONE concrete photographic scene that would accompany it as a hero image.

Constraints — every prompt MUST:
- Name a specific, real-world physical environment (clinic interior, gym, lab bench, bedroom, kitchen counter, mountain trail, etc.)
- Name specific concrete objects in the frame (not abstract concepts)
- Specify lighting (window light, golden hour, overhead industrial, moonlight, etc.)
- Specify camera angle / composition (low angle, overhead flat-lay, macro close-up, wide shot, etc.)

Constraints — every prompt MUST NOT include:
- Bottles, vials, jars, ampoules, syringes, pills, or pharmaceutical packaging
- Shelves with bottles arranged on them
- Skincare flat-lays or "wellness aesthetic" still lifes
- Identifiable human faces
- Text, labels, logos, or watermarks
- Words like "wellness", "luxury", "premium", or "boutique"

The scene MUST visually evoke the article's actual subject matter and stay strictly within its niche. Examples:
- ligament repair / recovery → a physiotherapy rehab clinic with a treatment bench
- growth hormone / performance → a strength-training gym, loaded barbell
- sleep / circadian → a bedroom at night, moonlight through curtains
- gym opening / membership → a new fitness facility interior, cardio + weight equipment, sign-up desk
- roofing → a residential roof mid-replacement, shingles, ladder, roofing tools
- tax law / IRS / Revenu Québec → a law office desk with legal code books and tax documents
- pest control → a technician's sprayer + inspection flashlight on a home floor, baseboard visible
- charity / nonprofit → a community food-bank sorting table stacked with donations

Never drift to an unrelated domain. A gym article must NOT show a lab; a roofing article must NOT show an office; a tax article must NOT show a gym.

Output: ONE sentence, 25-60 words, describing the scene. Plain text only. No quotes, no preamble.`;

  const user = `ARTICLE TITLE: ${title}

KEYWORDS: ${keywords.slice(0, 8).join(", ")}

ARTICLE EXCERPT (first ~2000 chars):
${plain}

Describe the photographic scene for the hero image.`;

  try {
    const { text } = await callClaude(system, user, {
      maxTokens: 200,
      temperature: 0.8,
    });
    const cleaned = text.trim().replace(/^["']|["']$/g, "");
    if (cleaned.length < 20 || cleaned.length > 600) return null;
    return cleaned;
  } catch (err) {
    // Falls back to the static niche scene; degrades image relevance only.
    recordPipelineError({
      site: "content-generator.sceneSummary",
      code: "SCENE_SUMMARY_FAILED",
      severity: "warn",
      message: `Scene summarization failed: ${err instanceof Error ? err.message : String(err)
        }`,
    });
    return null;
  }
}

// ─── Prompt builders ────────────────────────────────────────────────────────

function getNicheRequirements(niche: string): string {
  const key = normalizeNicheKey(niche) ?? "";
  const requirements: Record<string, string> = {
    peptides: `Reference actual published studies. Use proper terminology with explanations. Cite dosage ranges from research, not anecdotes. Acknowledge limitations and unknowns. Distinguish between animal studies, human trials, and theoretical applications. Include medical disclaimers. Never recommend sources or suppliers. Be clear about regulatory status.`,
    gambling: `Cover BOTH sports betting and online casino under one roof. SPORTS BETTING: use real odds examples and specific numbers, reference statistical concepts accurately (EV, variance, ROI, CLV), acknowledge most bettors lose long-term. ONLINE CASINO: use real RTP percentages (95-97% slots, ~99.5% blackjack basic strategy, 98.65% European roulette), reference actual game providers (Pragmatic Play, NetEnt, Evolution, Microgaming), be precise about wagering requirements (35x bonus + deposit, max bet caps, game contribution percentages), acknowledge the house edge openly and never frame casino games as positive-EV. Include a responsible gambling framework naturally (deposit limits, self-exclusion). Distinguish regulated jurisdictions (UKGC, MGA, Ontario AGCO, Loto-Québec) from offshore operators. Never promote gambling as guaranteed income and never recommend operators to bypass regulation.`,
    web_dev: `Reference actual tools and versions (React 18, Node 20 LTS). Address real trade-offs. Include both happy path and common issues. Compare modern vs legacy approaches honestly. Mention browser compatibility when relevant.`,
    payment_processing: `Use correct terminology (interchange, acquirer, PSP, basis points). Cite actual fee structures with real numbers. Include hidden fees and contract terms. Address compliance requirements (PCI DSS). Acknowledge regional regulatory differences.`,
    loans: `Use correct financial terminology (APR, LTV, DTI). Show total cost of loan, not just monthly payment. Address predatory lending red flags. Include qualification requirements honestly. Distinguish between loan types and their implications.`,
    construction: `Use correct construction terminology (GC, sub, bid process). Include real cost ranges by project scale. Reference regulatory requirements (permits, OSHA, prevailing wage). Acknowledge regional differences. Address business-side concerns (cash flow, payment terms).`,
    reputation_sites: `Reference actual platforms (Trustpilot, Yelp, Google Reviews, BBB, G2). Address both business and consumer viewpoints. Never promote fake review services or manipulation. Distinguish authentic reviews from suspicious patterns. Focus on ethical response strategies.`,
    apps_marketing: `Include actual pricing and version numbers. Acknowledge platform differences (iOS vs Android). Mention real limitations and bugs honestly. Reference actual user feedback. Compare based on what people care about: speed, reliability, cost, privacy.`,
    exclusive_models: `Frame as creator entrepreneurship, not explicit content. Focus on marketing, monetization, branding. Include real platform fees and earnings ranges. Respect creator autonomy. Address platform risks honestly. Never overpromise income potential.`,
    ecom_nails: `Use correct product terminology (gel polish vs builder gel). Reference actual brands with real prices. Include timing (cure times, wear duration). Describe looks specifically with shade names and finish types. Address nail health honestly.`,
    soccer_jersey: `Distinguish authentic vs replica vs counterfeit. Reference actual manufacturers (Nike, Adidas, Puma). Use proper terminology (kit, strip, home/away/third). Address sizing by manufacturer. Never promote counterfeit sources.`,
    app_dev: `Distinguish native (Swift/Kotlin), cross-platform (React Native/Flutter), hybrid. Include realistic cost ranges and timelines. Cover iOS and Android considerations. Address ongoing costs (hosting, APIs, maintenance). Acknowledge market saturation.`,
    tax_lawyer: `Cite specific IRC sections and real penalty amounts. Use concrete dollar figures and timelines (e.g. "10-year CSED on tax debt"). Distinguish federal vs state procedures. Always include a "general information, not legal advice — consult a licensed attorney for your situation" disclaimer. Address common myths honestly (e.g. pennies-on-the-dollar OIC marketing claims).`,
    charity: `Reference actual 501(c)(3) compliance requirements and IRS Form 990 specifics. Use real benchmarks for overhead ratios, donor retention rates, and grant award sizes. Cite specific grant databases (Candid, Grants.gov). Distinguish program vs administrative vs fundraising expenses. Acknowledge sector-wide challenges (donor fatigue, restricted funding) honestly.`,
    pest_extermination: `Use correct entomological names (German vs American cockroach, Eastern vs Western subterranean termite). Reference actual products and active ingredients (fipronil in Termidor, indoxacarb in Advion). Distinguish DIY-feasible vs licensed-only treatments. Address pet and child safety explicitly. Include realistic timelines (bed bug eradication takes 2-3 treatments over 4-6 weeks).`,
    roofing: `Distinguish material types with real per-square cost ranges (asphalt $350-550, metal $900-1400, tile $1000-1800). Reference manufacturer warranties (GAF, Owens Corning, CertainTeed) honestly including pro-rated vs non-prorated terms. Address regional climate factors (snow load, hurricane straps, hail belts). Walk through insurance claim process realistically — what insurers cover vs deny.`,
    online_casino: `Use real RTP percentages (95-97% for slots, 99.5% for blackjack basic strategy, 98.65% European roulette). Reference actual game providers (Pragmatic Play, NetEnt, Evolution, Microgaming) and a few specific top-grossing titles. Be precise about wagering requirements (35x bonus + deposit, max bet caps, game contribution percentages). Acknowledge house edge openly — never frame casino games as positive-EV. Include responsible-gambling language naturally (deposit limits, self-exclusion, GamCare/National Council on Problem Gambling references). Distinguish regulated jurisdictions (UKGC, MGA, NJ DGE, Ontario AGCO) from offshore operators. Never recommend specific operators to bypass regulation.`,
    real_estate: `Use concrete numbers — median sale prices, $/sq ft, days-on-market, price-to-rent ratios. Reference real data sources (NAR, Zillow Research, FRED, S&P CoreLogic Case-Shiller, CMHC for Canada). Distinguish residential vs commercial vs mixed-use. Include realistic transaction costs (6% agent split, 2-5% closing). Cover mortgage mechanics accurately (DTI < 43% conforming, LTV affecting PMI, 30-year vs 15-year). Address regional variation honestly — pricing in Toronto vs Montréal vs rural Quebec differs sharply. For investor content, cover cap rate / cash-on-cash / 1% rule with real ranges, not generic platitudes. Never give specific legal or tax advice — frame as general information.`,
    gym_subscription: `Use actual chain pricing (Planet Fitness $15/$25 tiers, Equinox $200-$300, LA Fitness ~$30). Address contract gotchas (annual fees, cancellation requirements, auto-renewal). Distinguish big-box vs boutique vs class-based models honestly. Include realistic personal training costs ($60-150/session). Address common frustrations (overcrowding, equipment availability, cancellation friction).`,
    gym_franchise: `Focus on NEW gym launches and franchise openings — NOT ongoing membership comparison (that's the gym_subscription niche). Cover ribbon-cutting dates, the franchise owner's background, equipment partners, opening-day promotions (first-month-free deals, founder discounts), location-specific build-out timing, and how this opening fits the local fitness scene. Name specific local chains by their real names — in Quebec: Énergie Cardio, Éconofitness, Nautilus Plus, Buzzfit, World Gym. Distinguish franchise vs corporate vs independent operations. When local news headlines about gym openings or industry shifts are provided in the prompt, cite them as inline links — this niche lives or dies on locally relevant news context.`,
  };
  // Hardcoded niche requirements first, then an auto-generated niche's
  // requirements (cached), then empty.
  return requirements[key] || getCachedNicheProfile(key)?.requirements || "";
}

/**
 * Resolve a vertical's language setting into the CONCRETE language for
 * a single post.
 *
 *   "fr"    → always French
 *   "en"    → always English
 *   "en_fr" → bilingual vertical: pick ONE language per post (50/50
 *             coin flip). Each post is cleanly single-language; over
 *             many posts the blog accumulates both — which is what
 *             "bilingual" means for SEO (NOT mixing both in one post).
 *
 * Call this ONCE per generation at the action layer, then pass the
 * resolved value to BOTH ideateTopic and generateContent so the topic
 * and the article are in the same language.
 */
export function resolvePostLanguage(
  language: "en" | "fr" | "en_fr" | null | undefined,
): "en" | "fr" {
  if (language === "fr") return "fr";
  if (language === "en_fr") return Math.random() < 0.5 ? "fr" : "en";
  return "en";
}

/**
 * Estimated cost (USD) for ONE Gemini image generation, based on the
 * configured GOOGLE_IMAGE_MODEL. Used by the per-post cost log — the
 * actual image cost isn't tracked through the publish pipeline (Gemini's
 * REST API doesn't return a billable-token count), so this is a heuristic
 * keyed off the model id we know we asked for. Pricing source:
 * https://ai.google.dev/pricing (verify before relying on cost reporting).
 */
const IMAGE_COST_USD: Record<string, number> = {
  "gemini-3-pro-image-preview": 0.13,
  "gemini-3-flash-image-preview": 0.04,
  "gemini-2.5-flash-image": 0.04,
};

export function estimateImageCostUsd(): number {
  const model = process.env.GOOGLE_IMAGE_MODEL || "gemini-3-flash-image-preview";
  return IMAGE_COST_USD[model] ?? 0.04;
}

// FRENCH_ONLY_NICHE_KEYS + MIXED_LANGUAGE_NICHE_KEYS are the LEGACY derived
// language rules (used only when a client has no explicit languageMode). They
// live in the isomorphic language module so the client form shares them.

/**
 * Language resolution, in priority order — first match wins:
 *   1. Niche in FRENCH_ONLY_NICHE_KEYS   → ALWAYS French (gambling family).
 *   2. Niche in MIXED_LANGUAGE_NICHE_KEYS → en_fr coin-flip (overrides .com).
 *   3. Domain ends in .com               → ALWAYS English (US / international).
 *   4. Otherwise                         → vertical's configured language
 *      via resolvePostLanguage. en_fr verticals coin-flip per post; each
 *      post is single-language, never mixed within one post.
 */
export function postLanguageForDomain(
  verticalLanguage: "en" | "fr" | "en_fr" | null | undefined,
  domain: string,
  niche?: string | null,
): "en" | "fr" {
  const normalizedNiche = (niche || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  // 1. Niche override — gambling family always French.
  if (FRENCH_ONLY_NICHE_KEYS.has(normalizedNiche)) {
    return "fr";
  }

  // 2. Niche override — bilingual niches coin-flip per post, even on .com.
  if (MIXED_LANGUAGE_NICHE_KEYS.has(normalizedNiche)) {
    return resolvePostLanguage("en_fr");
  }

  // 3. TLD override — .com forces English.
  const cleanDomain = (domain || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .replace(/:\d+$/, "");
  if (cleanDomain.endsWith(".com")) {
    return "en";
  }

  // 4. Default — vertical's configured language.
  return resolvePostLanguage(verticalLanguage);
}

/**
 * Build a language directive appended to the system prompt. Empty for
 * English. For French it forces the ENTIRE JSON payload — title,
 * content, excerpt, metaTitle, metaDescription, keywords — into Québec
 * French. Callers should resolve "en_fr" to a concrete "en"/"fr" via
 * resolvePostLanguage() before this is reached.
 */
function buildLanguageDirective(
  language: GenerateOptions["language"],
): string {
  if (language === "fr") {
    return `

LANGUE / LANGUAGE — CRITICAL:
- Write the ENTIRE article in FRENCH (français). This is a French-
  language blog for a Québec audience.
- Every JSON field must be in French: "title", "content", "excerpt",
  "metaTitle", "metaDescription", AND the "keywords" array.
- Use natural Québec French phrasing and vocabulary, not literal
  English-to-French translation. Prices in CAD ($), dates in French
  format, French punctuation conventions.
- Industry/brand/technical terms with no common French equivalent may
  stay in English (e.g. product names, "GLP-1", "shingles"), but the
  surrounding sentence MUST be French.
- Do NOT write whole sentences or paragraphs in English.`;
  }
  // "en", "en_fr" (should have been resolved already), or undefined →
  // English, no directive.
  return "";
}

// ─── Per-blog stylistic seeding (legacy / non-profile path) ─────────────────
//
// Same blog → same picks every time. Lets the legacy path approach the
// profile-path's per-blog diversification without the full composer stack.
// Per the footprint audit: shared voice fingerprint across a niche is the
// easiest network pattern for a classifier to find — these helpers break it.

const QUIRK_POOL: string[] = [
  "Occasionally drop a single-sentence paragraph for emphasis (max 2–3 per article).",
  "Use parentheticals (like this one) more than average — 3–5 per article.",
  "Open roughly 30% of paragraphs with a question.",
  "Use heavy parallel construction in some sections, then deliberately break it elsewhere.",
  "Prefer numerals (3) over spelled-out numbers (three), even at sentence starts.",
  "Use specific timeframes frequently: 'in 2014,' 'by 2019,' 'as of late 2022.'",
  "Mid-paragraph self-correction: 'Actually, that's imprecise — more accurately...'",
  "Use sentence fragments for emphasis. Sparingly. Like this.",
  "Prefer 'Note that...' or 'Consider...' as section openers in technical passages.",
  "Use first-person plural ('we') rather than second-person ('you') when explaining concepts.",
  "Avoid the colon-before-list pattern. Lead with a sentence ending in a period.",
  "Use 'I' once or twice per article to inject authorial voice — sparingly.",
];

/** Small deterministic 32-bit hash of a string. Stable across processes. */
function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Pick `count` distinct quirks from QUIRK_POOL deterministically by seed. */
function pickQuirks(seed: string | undefined, count = 2): string[] {
  if (!seed) return [];
  const base = hashSeed(seed);
  const picks: string[] = [];
  const used = new Set<number>();
  for (let i = 0; i < count; i++) {
    let idx = (base + i * 31) % QUIRK_POOL.length;
    // De-collision: walk forward until we find an unused slot.
    while (used.has(idx)) idx = (idx + 1) % QUIRK_POOL.length;
    used.add(idx);
    picks.push(QUIRK_POOL[idx]);
  }
  return picks;
}

/**
 * Per-blog word band drawn from inside the network bounds
 * [GLOBAL_WORD_BAND_MIN, GLOBAL_WORD_BAND_MAX]. Each blog gets a stable
 * (~300-word-wide) sub-range so the network doesn't cluster on uniform
 * word counts. Falls back to the network bounds when no seed is provided.
 */
function wordBandForBlog(
  seed: string | undefined,
  requestedTarget: number,
): { min: number; max: number; target: number } {
  const lo = MIN_WORDS;
  const hi = MAX_WORDS;
  if (!seed) {
    const target = Math.max(lo, Math.min(hi, requestedTarget));
    return { min: lo, max: hi, target };
  }
  const span = hi - lo; // e.g. 700
  const bandWidth = Math.max(250, Math.round(span * 0.35)); // ~245+
  const h = hashSeed(seed);
  // Deterministic start offset such that [start, start + bandWidth] ⊆ [lo, hi].
  const start = lo + (h % Math.max(1, span - bandWidth));
  const min = start;
  const max = start + bandWidth;
  const target = Math.round((min + max) / 2);
  return { min, max, target };
}

/**
 * Per-blog body-image wrapper class (used by embedBodyImage). Different
 * sites should emit different markup; identical class names across the
 * network are a trivial HTML fingerprint per the audit.
 */
function bodyImageClassForBlog(seed: string | undefined): string {
  const POOL = [
    "post-figure",
    "inline-illustration",
    "article-figure",
    "story-image",
    "post-illustration",
    "body-figure",
    "feature-image",
    "content-figure",
  ];
  if (!seed) return POOL[0];
  return POOL[hashSeed(seed) % POOL.length];
}

/**
 * Per-blog CTA button appearance. Identical inline-styled buttons across the
 * network are an obvious footprint (footprint audit). Each blog gets a stable
 * colour/padding/radius/weight drawn deterministically from its seed, so the
 * serialized HTML differs site-to-site while every button still renders as a
 * tasteful dark pill. Same blog → same button always.
 */
function ctaStyleForBlog(seed: string | undefined): {
  bg: string;
  padding: string;
  radius: string;
  weight: string;
  fontSize: string;
  align: string;
  margin: string;
} {
  const BG = ["#111827", "#0f172a", "#1f2937", "#18181b", "#1e293b", "#0b1220", "#171717"];
  const PADDING = ["14px 30px", "13px 28px", "15px 32px", "12px 26px", "14px 34px"];
  const RADIUS = ["8px", "6px", "10px", "4px", "9999px"];
  const WEIGHT = ["600", "700", "500"];
  const FONT = ["16px", "15px", "17px"];
  const MARGIN = ["2.5em 0", "2.25em 0", "2.75em 0", "2em 0"];
  if (!seed) {
    return {
      bg: BG[0], padding: PADDING[0], radius: RADIUS[0],
      weight: WEIGHT[0], fontSize: FONT[0], align: "center", margin: MARGIN[0],
    };
  }
  const h = hashSeed(seed);
  return {
    bg: BG[h % BG.length],
    padding: PADDING[(h >> 2) % PADDING.length],
    radius: RADIUS[(h >> 4) % RADIUS.length],
    weight: WEIGHT[(h >> 6) % WEIGHT.length],
    fontSize: FONT[(h >> 8) % FONT.length],
    align: (h >> 10) % 4 === 0 ? "left" : "center",
    margin: MARGIN[(h >> 11) % MARGIN.length],
  };
}

export interface ResolvedNiche {
  label: string;
  industry: string;
  defaultAudience: string;
  defaultBrandVoice: string;
  contentStyle: string;
  keyTopics: string[];
  requirements: string;
  /** Compliance/legal disclaimers — locked into the prompt even under a custom
   *  prompt. Empty from code today (legacy prompt injects none); populated from
   *  the niches DB row. */
  disclaimers: string[];
}

/**
 * The niche config as the CODE provides it today — getNicheContext (voice,
 * style, audience) plus getNicheRequirements. This is the byte-for-byte source
 * live generation uses. A DB-backed resolver (Phase 1) produces the SAME shape
 * from the `niches` table; renderSystemPrompt is agnostic to the source, so the
 * eventual switch to DB-sourced config is a provable no-op on the prompt.
 */
export function resolveCodeNiche(niche: string | null | undefined): ResolvedNiche {
  const ctx = getNicheContext(niche);
  return {
    label: ctx.label,
    industry: ctx.industry,
    defaultAudience: ctx.defaultAudience,
    defaultBrandVoice: ctx.defaultBrandVoice,
    contentStyle: ctx.contentStyle,
    keyTopics: ctx.keyTopics,
    // Matches buildSystemPrompt's original guard: requirements only when a
    // niche string was supplied.
    requirements: niche ? getNicheRequirements(niche) : "",
    // The legacy code path injects no niche-level disclaimers (peptide/gambling
    // compliance rides the profile phrase library); the DB resolver supplies
    // them when a niches row has them.
    disclaimers: [],
  };
}

/**
 * Assemble the legacy article system prompt from a RESOLVED niche + per-blog
 * options. Extracted verbatim from buildSystemPrompt so the identical assembly
 * can render from either the code niche (live) or a DB niche (preview/parity).
 */
export function renderSystemPrompt(
  opts: GenerateOptions,
  niche: ResolvedNiche,
): string {
  const brandVoice = opts.brandVoice || niche.defaultBrandVoice;
  const audience = opts.targetAudience || niche.defaultAudience;
  // Per-blog word band — same seed → same band always. The opts.wordCount
  // is treated as a hint; the per-blog band overrides it so the network
  // doesn't cluster on a uniform target.
  const wb = wordBandForBlog(opts.blogSeed, opts.wordCount);
  const targetWords = wb.target;
  // Per-blog stylistic tics — picked deterministically from QUIRK_POOL by
  // blogSeed. Same blog always writes with the same 2 quirks.
  const quirks = pickQuirks(opts.blogSeed, 2);

  let prompt = `You are an expert content writer in the ${niche.industry} space. Write a comprehensive, original article that reads like it was written by someone with deep first-hand experience.

VOICE & STYLE:
- Brand voice: ${brandVoice}
- Audience: ${audience}
- Tone: ${opts.tone}
- Style: ${niche.contentStyle}

QUALITY BAR:
- Specific over generic — exact prices, real brand/tool names, concrete numbers
- Show your reasoning, don't just assert
- Include trade-offs and limitations honestly, not just upsides

FORBIDDEN AI TELLS (will cause the post to be rejected):

Punctuation:
- NEVER use em-dashes (—) or en-dashes (–) as pause markers. Replace with periods, commas, or sentence breaks.
- NEVER use the single-character ellipsis (…). Use three periods (...).
- NEVER use curly/smart quotes (" " ' '). Use straight quotes (" and ').

Forbidden vocabulary (do not appear in any context):
delve, tapestry, realm, ecosystem (as metaphor), landscape (as metaphor), journey (as metaphor), navigate (as metaphor), unleash, harness, foster, cultivate, embark, robust, seamless, holistic, nuanced, paradigm, multifaceted, intricate, pivotal, plethora, myriad, gleaned, meticulous, underscore, bolster, garner.

Forbidden phrases (never include any of these):
- "It's not just X, it's Y"
- "Whether you're X or Y..."
- "In today's [world / fast-paced / digital / modern]..."
- "Game-changer", "Revolutionary", "Transformative"
- "It's worth noting that"
- "That said," / "With that in mind"
- "Look no further" / "Without further ado"
- "When it comes to"
- "Let's dive in" / "Let's explore"
- "At its core"
- Sentence-initial: "Ultimately," / "Fundamentally," / "Essentially,"
- "The key takeaway"
- Sign-off lines like "Happy [verbing]!"
- Filler transitions: "Moreover," "Furthermore," "In conclusion"

Forbidden structural patterns:
- Do NOT make every paragraph exactly 3 or 4 sentences. Vary paragraph length deliberately: some single-sentence paragraphs for emphasis, some 5–7 sentence paragraphs, some short.
- Do NOT use perfect parallel structure in every list. Real writers break parallelism naturally.
- Do NOT open with a time-anchored cliché ("In today's...", "In an era of...").
- Do NOT close with "In conclusion" or a recap paragraph.

CADENCE TARGET:
- Average sentence length: 15–20 words.
- HIGH variance: include at least 3–5 sentences under 10 words AND at least 2–3 sentences over 25 words.
- Paragraphs vary between 1 and 7 sentences.

WORD COUNT (HARD LIMITS):
- Minimum ${wb.min} words — anything shorter will be rejected.
- Maximum ${wb.max} words — leave a 200–300-word buffer below the maximum so the JSON can't be truncated mid-string.
- Target approximately ${targetWords} words.
- Depth over padding; trim ruthlessly before approaching the cap.

IMAGES:
- Do NOT include any <img>, <figure>, <picture>, or <figcaption> tags in your output. A hero image is attached as the article's featured image at publish time — any inline images you emit will be stripped.

STRUCTURE:
- Open with a substantive hook (no time-anchored opener).
- Use <h2> for major sections, <h3> for subsections.
- Lists where useful, not where padding.
- Close with concrete takeaways, not platitudes.

OUTPUT FORMAT:
Return ONLY valid JSON with EXACTLY these top-level keys:
{
  "title": "Article title, primary keyword first, ~50 characters, no site/brand name",
  "content": "Full HTML article between ${wb.min} and ${wb.max} words",
  "excerpt": "150-160 character summary",
  "metaTitle": "SEO title tag, primary keyword FIRST, ~50 characters max (must render under 580px). Use ' | ' not '-' as a separator. No brand/site name, no duplicate words.",
  "metaDescription": "Meta description, primary keyword early, ~140 characters max (must render under 1000px). One natural sentence ending with a soft call to action.",
  "keywords": ["keyword1", "keyword2", "keyword3"]
}

JSON SHAPE — strict:
- "content" is ONE HTML string. Do not split into "intro"/"items"/"sections"/"paragraphs"/"deck"/"body"+"conclusion". Build one HTML string.
- Do not wrap the response in another object ({"article": ...}). Return the JSON directly.
- Use field names exactly as shown ("content" not "html"/"body"/"article_html"; "title" not "headline"/"post_title").
- Allowed tags in "content": <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <a>. No images, no markdown headings.`;

  if (quirks.length > 0) {
    prompt += `\n\nTHIS BLOG'S WRITING HABITS (apply consistently across the article):\n${quirks.map((q) => `- ${q}`).join("\n")}`;
  }

  const nicheReqs = niche.requirements;
  if (nicheReqs) {
    prompt += `\n\nNICHE-SPECIFIC REQUIREMENTS:\n${nicheReqs}`;
  }

  // SEO REQUIREMENTS block removed per the footprint audit (insight 2):
  // "Natural keyword density 1-2%" / "primary keyword in first 100 words"
  // optimize to exactly what classifiers fingerprint. The structure rules
  // above are enough; entity coverage + uniqueness is the right replacement
  // (separate follow-up). Keeping seoOptimized for back-compat / future use.
  if (opts.seoOptimized) {
    // Intentionally a no-op for now — see comment above.
  }

  return prompt;
}

/**
 * Legacy article system prompt — live path. Uses the caller-resolved niche
 * (e.g. the editable `niches` DB row) when present, else falls back to the
 * hardcoded code niche. The fallback runs lazily here (after loadNicheProfiles
 * in the action), so registry-backed niches still resolve correctly.
 */
function buildSystemPrompt(opts: GenerateOptions): string {
  return renderSystemPrompt(opts, opts.resolvedNiche ?? resolveCodeNiche(opts.niche));
}

/**
 * Render the blog's generated persona as a voice block for the custom-prompt
 * path. Only used when the "stack persona" toggle is on — it lets the operator
 * keep the blog's unique voice while still steering angle/structure with a
 * custom prompt. Mirrors the {voice.*} slots the composer fills on the profile
 * path, so the same persona reads consistently across both paths.
 */
function renderPersonaBlock(persona: GeneratedPersona): string {
  const lines: string[] = [
    "\n\n--- VOICE & PERSONA (write in this voice on top of the instructions above) ---",
    `Persona: ${persona.persona}`,
    `Register / tone: ${persona.registerSignature}`,
  ];
  if (persona.toneNotes && persona.toneNotes.trim()) {
    lines.push(`Tone notes: ${persona.toneNotes.trim()}`);
  }
  const examples = [persona.examplePara1, persona.examplePara2]
    .map((p) => (p ?? "").trim())
    .filter(Boolean);
  if (examples.length > 0) {
    lines.push(
      "Match the rhythm, sentence length, and word choice of these example paragraphs (do not copy their content):",
      ...examples.map((p) => `  ${p}`),
    );
  }
  return lines.join("\n");
}

/**
 * System prompt for the CUSTOM-PROMPT path. The operator's prompt drives the
 * article's angle, voice, and structure; a fixed guardrails block is appended
 * that ALWAYS applies regardless of what the custom prompt says:
 *   - the niche's compliance/legal disclaimers (locked — per the design),
 *   - the anti-AI-tell punctuation/word rules (network footprint protection),
 *   - the no-images rule and per-blog word band,
 *   - the strict JSON output contract the app parses.
 * Self-contained (does not reuse renderSystemPrompt) so the proven legacy path
 * stays byte-for-byte untouched.
 */
function buildCustomSystemPrompt(
  opts: GenerateOptions,
  niche: ResolvedNiche,
): string {
  const wb = wordBandForBlog(opts.blogSeed, opts.wordCount);
  const disclaimers = (niche.disclaimers ?? []).filter(Boolean);
  const complianceBlock = disclaimers.length
    ? `\n\nCOMPLIANCE (locked — include these verbatim, non-negotiable):\n${disclaimers
      .map((d) => `- ${d}`)
      .join("\n")}`
    : "";

  // Optional persona layer: when the operator has opted to STACK the persona
  // (instead of letting the custom prompt fully replace it) AND this blog has
  // a generated persona, render its voice as a block between the custom prompt
  // and the guardrails. This matches the layered model — instructions, then
  // persona, then locked rules. No-op when the toggle is off or no persona
  // exists (a plain custom prompt keeps replacing the voice).
  const personaBlock =
    opts.applyPersona && opts.styleProfile?.generatedPersona
      ? renderPersonaBlock(opts.styleProfile.generatedPersona)
      : "";

  return `${(opts.customPrompt ?? "").trim()}${personaBlock}${complianceBlock}

--- REQUIRED OUTPUT & GUARDRAILS (always apply, even if the instructions above conflict) ---
- Do NOT use em-dashes (—) or en-dashes (–), the single-character ellipsis (…), or curly/smart quotes. Use straight quotes and normal punctuation.
- Do NOT include any <img>, <figure>, <picture>, or <figcaption> tags. A hero image is attached at publish time.
- Length: between ${wb.min} and ${wb.max} words (target approximately ${wb.target}). Leave a small buffer under the max so the JSON never truncates mid-string.
- Allowed HTML tags in "content": <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <a>. No markdown headings, no images.

OUTPUT FORMAT:
Return ONLY valid JSON with EXACTLY these top-level keys:
{
  "title": "Article title, primary keyword first, ~50 characters, no site/brand name",
  "content": "Full HTML article as ONE string, between ${wb.min} and ${wb.max} words",
  "excerpt": "150-160 character summary",
  "metaTitle": "SEO title tag, primary keyword FIRST, ~50 characters (must render under 580px). Use ' | ' not '-' as a separator.",
  "metaDescription": "Meta description, primary keyword early, ~140 characters (under 1000px). One natural sentence ending with a soft call to action.",
  "keywords": ["keyword1", "keyword2", "keyword3"]
}
Return the JSON object directly — no preamble, no wrapping object, field names exactly as shown.`;
}

/**
 * On-page quality rules appended to every article-generation system prompt
 * (both the profile and legacy paths). Phrased as natural-language ceilings,
 * not mechanical SEO knobs (no keyword-density / "keyword in first 100 words"
 * rules — those are AI-detector fingerprints, deliberately avoided).
 */
const SEO_QUALITY_DIRECTIVE = `

ON-PAGE QUALITY (apply throughout the article):
- Keep the AVERAGE sentence length at or below ~20 words (shorter is fine; vary length for rhythm). Break up any single sentence that runs past ~28 words into two.
- Every <h2>/<h3> heading must have UNIQUE text — never repeat the same heading wording, and do not restate the article title as a heading.
- Every hyperlink must use UNIQUE, descriptive anchor text — never reuse the same anchor wording for two links, and don't use an anchor that merely repeats a heading.
- Make the opening paragraph clearly on-topic: reference the article's main subject naturally in the first few sentences.`;

/**
 * Local keyword-targeted content directive — appended alongside
 * SEO_QUALITY_DIRECTIVE whenever opts.localTarget is set (see
 * docs/local-keyword-content-plan.md §5). Absent otherwise, so a blog with
 * no assigned city gets byte-for-byte the same prompt as before this
 * feature existed.
 */
function buildLocalTargetingDirective(
  target: NonNullable<GenerateOptions["localTarget"]>,
): string {
  const brandLine =
    target.brandName && target.brandUrl
      ? `\n- Name "${target.brandName}" once in the body as the source, formatted as an HTML hyperlink: <a href="${target.brandUrl}">${target.brandName}</a>. Do not repeat it in every section, and never leave it as plain unlinked text.`
      : target.brandName
        ? `\n- Name "${target.brandName}" once in the body as the source for this. Do not repeat it in every section.`
        : "";
  return `

LOCAL TARGETING (this post targets a real search query for a specific market — apply throughout):
- Use the exact phrase "${target.keyword}" naturally: once in the opening paragraph, once in an <h2> heading, and once in the closing. Never as a repeated block.
- Give ${target.city} substantive treatment — local delivery/shipping expectations, regional context, or regulation that actually applies there. Not a mechanical find-and-replace city drop.${brandLine}
- Never invent a physical storefront, local address, phone number, or in-person pickup in ${target.city} unless the reference material below explicitly supplies one.`;
}

/**
 * Build the styled call-to-action button appended to the bottom of a post.
 * Inline CSS so it renders as a button on any theme. Returns "" when the CTA
 * is incomplete or the URL isn't a safe http(s) link.
 */
/** Only allow a plain #hex color into inline CSS (guards against injection). */
function safeCssColor(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return /^#[0-9a-f]{3,8}$/i.test(s) ? s : null;
}

/**
 * Escape a URL for use inside an HTML attribute. Money links now carry UTM
 * query strings, so a bare "&" would be an HTML parse error (and gets mangled
 * by some WordPress/Shopify sanitizers) — encode it. Quotes and angle brackets
 * are percent-encoded exactly as the previous inline escaping did.
 */
export function safeAttrUrl(url: string): string {
  return url
    .replace(/&/g, "&amp;")
    .replace(/"/g, "%22")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
}

export function buildCtaHtml(
  cta?: { label: string; url: string; color?: string },
  seed?: string,
): string {
  const label = (cta?.label ?? "").trim();
  const url = (cta?.url ?? "").trim();
  if (!label || !/^https?:\/\//i.test(url)) return "";

  const safeLabel = label
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const safeUrl = safeAttrUrl(url);

  // Per-blog button APPEARANCE only, so the CTA markup isn't byte-identical
  // across the network. Same blog → same button always. A client-chosen color
  // overrides the derived background when set.
  //
  // The `rel` is NOT randomized (T02). This is a paid placement on every blog,
  // so every blog declares it the same, honest way: sponsored + noopener. The
  // old per-blog pool nofollowed the client's own CTA on 5 blogs in 6 and
  // stripped the referrer on 1 in 6.
  const s = ctaStyleForBlog(seed);
  const bg = safeCssColor(cta?.color) ?? s.bg;

  return (
    `\n<div style="text-align:${s.align};margin:${s.margin};">` +
    `<a href="${safeUrl}" target="_blank" rel="${COMMERCIAL_LINK_REL}" ` +
    `style="display:inline-block;padding:${s.padding};background:${bg};color:#ffffff;` +
    `font-weight:${s.weight};font-size:${s.fontSize};text-decoration:none;border-radius:${s.radius};">` +
    `${safeLabel}</a></div>`
  );
}

/** Positions for the CTA from a placement preset. */
function ctaPositions(placement?: string): Array<"top" | "middle" | "bottom"> {
  if (placement === "top_bottom") return ["top", "bottom"];
  if (placement === "top_middle_bottom") return ["top", "middle", "bottom"];
  return ["bottom"];
}

/** Insert an HTML snippet at the ~50% word-count point, on a paragraph boundary. */
function insertHtmlAtMidpoint(html: string, snippet: string): string {
  const parts = html.split(/(<\/p>)/i);
  const paragraphs: Array<{ html: string; words: number }> = [];
  for (let i = 0; i < parts.length; i += 2) {
    const combined = (parts[i] ?? "") + (parts[i + 1] ?? "");
    if (combined.trim().length === 0) continue;
    const words = combined.replace(/<[^>]+>/g, " ").trim().split(/\s+/).filter(Boolean).length;
    paragraphs.push({ html: combined, words });
  }
  if (paragraphs.length < 4) return html + snippet; // too short for a sensible midpoint
  const total = paragraphs.reduce((s, p) => s + p.words, 0);
  let acc = 0;
  let insertAt = paragraphs.length - 1;
  for (let i = 0; i < paragraphs.length; i++) {
    acc += paragraphs[i].words;
    if (acc >= total / 2) {
      insertAt = i + 1;
      break;
    }
  }
  return (
    paragraphs.slice(0, insertAt).map((p) => p.html).join("") +
    snippet +
    paragraphs.slice(insertAt).map((p) => p.html).join("")
  );
}

/**
 * Insert a snippet AFTER the first paragraph rather than before it. A "top"
 * CTA used to be prepended as the literal first element of the body, which
 * meant every body-derived field — the theme's meta description, the OG /
 * Twitter descriptions, and the JSON-LD articleBody — opened with the CTA
 * label (e.g. "Explore Now!") instead of real content. Slotting it after the
 * opening paragraph keeps the CTA above the fold while leaving the article's
 * first words clean for SEO. Falls back to prepend only when there's no
 * paragraph to anchor to.
 */
function insertHtmlAfterFirstParagraph(html: string, snippet: string): string {
  const match = /<\/p>/i.exec(html);
  if (!match) return snippet + html;
  const idx = match.index + match[0].length;
  return html.slice(0, idx) + snippet + html.slice(idx);
}

/** Inject the client's CTA button at its configured position(s). */
function injectCta(
  body: string,
  cta?: GenerateOptions["cta"],
  seed?: string,
): string {
  if (!cta) return body;
  const button = buildCtaHtml(cta, seed);
  if (!button) return body;

  const positions = ctaPositions(cta.placement);
  let out = body;
  // Middle first, so the top/bottom buttons don't skew the midpoint math.
  if (positions.includes("middle")) out = insertHtmlAtMidpoint(out, button);
  // "Top" goes after the opening paragraph, not before it — see
  // insertHtmlAfterFirstParagraph for why (keeps the meta description / OG /
  // schema from leading with the CTA label).
  if (positions.includes("top")) out = insertHtmlAfterFirstParagraph(out, button);
  if (positions.includes("bottom")) out = out + button;
  return out;
}

/** Escape a string for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Hyperlink the first occurrence of one of `terms` (priority order) in the
 * article's OPENING paragraph to `url`. Scoped to the first <p> — and skipped
 * if that paragraph already contains a link — so we add exactly one clean
 * contextual link near the top without ever nesting anchors or touching
 * headings/markup. Returns the body unchanged when no term is found.
 */
export function injectMoneyLink(
  body: string,
  url: string,
  terms: string[],
): string {
  if (!url || !/^https?:\/\//i.test(url)) return body;
  const pMatch = body.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (!pMatch) return body;
  const pInner = pMatch[1];
  if (/<a\b/i.test(pInner)) return body; // opening paragraph already links out

  // Paid placement → one honest, network-wide rel (T02). No seed needed.
  const safeUrl = safeAttrUrl(url);
  for (const term of terms) {
    const t = term.trim();
    if (!t) continue;
    // Match the term with word-ish boundaries so we don't split a larger word.
    const re = new RegExp(`(^|[\\s(>"'])(${escapeRegExp(t)})(?=[\\s.,;:)!?<"']|$)`, "i");
    const m = re.exec(pInner);
    if (!m) continue;
    const start = m.index + m[1].length;
    const matched = pInner.slice(start, start + m[2].length);
    const anchor =
      `<a href="${safeUrl}" target="_blank" rel="${COMMERCIAL_LINK_REL}">${matched}</a>`;
    const newInner = pInner.slice(0, start) + anchor + pInner.slice(start + m[2].length);
    return body.replace(pInner, newInner);
  }
  return body;
}

/**
 * Build the inline mini registration form (Name / Location / Email + Register).
 * Inline-styled so it renders on any theme. Submits to `actionUrl`
 * (/api/register/{blogId}); a hidden postId ties the lead to this post, and a
 * hidden honeypot field ("website") catches bots. Per-blog accent colour from
 * the seed so the markup isn't byte-identical across the network.
 */
function buildRegistrationFormHtml(
  actionUrl: string,
  postId: string | undefined,
  seed?: string,
  color?: string,
): string {
  if (!/^https?:\/\//i.test(actionUrl)) return "";
  const s = ctaStyleForBlog(seed);
  const btnBg = safeCssColor(color) ?? s.bg;
  const safeAction = actionUrl.replace(/"/g, "%22");
  const postField = postId
    ? `<input type="hidden" name="postId" value="${postId.replace(/"/g, "")}" />`
    : "";
  const inputStyle =
    "display:block;width:100%;box-sizing:border-box;margin:0 0 10px;padding:10px 12px;" +
    "border:1px solid #d1d5db;border-radius:8px;font-size:15px;";
  return (
    `\n<div style="margin:24px 0;padding:20px;border:1px solid #e5e7eb;border-radius:12px;background:#f9fafb;max-width:460px;">` +
    `<div style="font-weight:700;font-size:18px;margin:0 0 4px;">Register for access</div>` +
    `<div style="font-size:13px;color:#6b7280;margin:0 0 14px;">Enter your details to continue.</div>` +
    `<form action="${safeAction}" method="post">` +
    `<input style="${inputStyle}" type="text" name="name" placeholder="Name" required />` +
    `<input style="${inputStyle}" type="text" name="location" placeholder="Location" />` +
    `<input style="${inputStyle}" type="email" name="email" placeholder="Email" required />` +
    `<input type="text" name="website" tabindex="-1" autocomplete="off" ` +
    `style="position:absolute;left:-9999px;width:1px;height:1px;" aria-hidden="true" />` +
    postField +
    `<button type="submit" style="display:inline-block;width:100%;padding:${s.padding};` +
    `background:${btnBg};color:#ffffff;font-weight:${s.weight};font-size:${s.fontSize};` +
    `border:0;border-radius:${s.radius};cursor:pointer;">Register</button>` +
    `</form></div>`
  );
}

/** Inject the registration form at the configured position(s). */
function injectRegistrationForm(
  body: string,
  form: NonNullable<GenerateOptions["registrationForm"]>,
  postId: string | undefined,
  seed?: string,
): string {
  const html = buildRegistrationFormHtml(form.actionUrl, postId, seed, form.color);
  if (!html) return body;
  const placement = form.placement ?? "bottom";
  let out = body;
  if (placement === "top" || placement === "top_bottom") {
    out = insertHtmlAfterFirstParagraph(out, html);
  }
  if (placement === "bottom" || placement === "top_bottom") {
    out = out + html;
  }
  return out;
}

/**
 * Render the client's Knowledge Base summaries into a system-prompt block.
 * Returns "" when there's nothing to inject.
 */
function buildKnowledgeContext(summaries?: string[]): string {
  const list = (summaries ?? []).map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return "";
  return (
    `\n\nCLIENT KNOWLEDGE BASE — reference material this client provided. Draw on these facts, terminology, and context wherever they fit the topic, and never contradict them:\n` +
    list.map((s) => `- ${s}`).join("\n")
  );
}

function buildUserPrompt(opts: GenerateOptions): string {
  return `Write the article.

Topic: ${opts.topic}
Target keywords: ${opts.keywords.join(", ") || "(infer from topic)"}

Begin now. Return only the JSON object.`;
}

// ─── Topic ideation (used by cron auto-publish) ─────────────────────────────

/**
 * Render the client's distilled Knowledge Base into a prompt section that
 * tells the model to prioritize the client's own topics/keywords. Returns ""
 * when there's nothing to inject (blogs with no active knowledge documents).
 */
function buildKnowledgeSection(
  knowledge?: { keywords: string[]; topics: string[] },
): string {
  const topics = knowledge?.topics?.filter(Boolean).slice(0, 20) ?? [];
  const keywords = knowledge?.keywords?.filter(Boolean).slice(0, 40) ?? [];
  if (topics.length === 0 && keywords.length === 0) return "";

  return (
    `\n\nCLIENT KNOWLEDGE BASE (uploaded reference material — prioritize this over generic niche topics):\n` +
    (topics.length ? `  priority topics: ${topics.join(", ")}\n` : "") +
    (keywords.length ? `  target keywords: ${keywords.join(", ")}\n` : "") +
    `Prefer a topic and keywords that align with the client's own material above whenever it fits the niche.`
  );
}

export async function ideateTopic(
  niche: string | null | undefined,
  recentTitles: string[],
  opts: {
    verticalKey?: string | null;
    /**
     * Per-blog locked style profile. When provided, the topic ideation
     * anchors on this blog's UNIQUE primaryCompounds and locked
     * sub-niche instead of the niche's generic keyTopics list. Without
     * this, every blog's first post (no recent titles) defaulted to
     * the first compound in keyTopics (BPC-157 for peptides) — every
     * peptide blog ended up starting with the same topic.
     */
    styleProfile?: StyleProfile;
    /** Output language — French verticals get French topics + keywords. */
    language?: "en" | "fr" | "en_fr";
    /**
     * Distilled client Knowledge Base for this blog (uploaded reference
     * material — briefs, keyword sheets, etc.). When present, ideation
     * prioritizes the client's own topics/keywords over the generic niche
     * list, so posts reflect the material the client actually gave us.
     */
    knowledge?: { keywords: string[]; topics: string[] };
    /**
     * Client/blog custom generation prompt. When set, topic ideation is driven
     * by this brief (its subject, business, and keywords) INSTEAD of the niche's
     * generic key topics — otherwise a "restaurant" niche would keep suggesting
     * generic B2B management topics even when the operator's brief is a foodie
     * review of one specific pizzeria. Keeps posts on-brand for what was asked.
     */
    customPrompt?: string;
  } = {},
): Promise<{ topic: string; keywords: string[] }> {
  const ctx = getNicheContext(niche);
  const brief = (opts.customPrompt ?? "").trim();
  const recentList = recentTitles.length
    ? recentTitles.slice(0, 20).map((t) => `- ${t}`).join("\n")
    : "(none yet — first post for this blog)";

  // Pull recent news headlines for this vertical (if registered + has
  // cached items). Cron `/api/cron/refresh-news` keeps the cache fresh
  // daily. Returns empty string when no vertical or no items — ideation
  // falls back to its cold-start behavior.
  let newsBlock = "";
  if (opts.verticalKey) {
    try {
      const items = await takeNewsContextForVertical(opts.verticalKey, 6);
      if (items.length > 0) {
        newsBlock = await formatNewsContextForPrompt(items);
      }
    } catch (err) {
      // Non-fatal — ideation should still produce a topic even if the
      // news lookup or marking fails.
      recordPipelineError({
        site: "content-generator.ideateNews",
        code: "NEWS_CONTEXT_FAILED",
        severity: "warn",
        message: `news context lookup failed: ${err instanceof Error ? err.message : String(err)
          }`,
        context: { verticalKey: opts.verticalKey ?? null },
      });
    }
  }

  const newsClause = newsBlock
    ? `- Tie the topic to a current news angle when one of the recent headlines fits naturally\n- Skip the news angle entirely if no headline relates to the niche`
    : "";

  // Profile-aware focus anchor. When a style profile is present, force
  // the topic to center on this blog's UNIQUE primary/secondary
  // compounds and locked sub-niche. This is what makes each peptide
  // blog's first post unique — the random assignment algorithm gave
  // every blog a different 2-compound primary canon, so anchoring
  // ideation on those compounds guarantees blog-level uniqueness even
  // when recentTitles is empty.
  //
  // When no profile (non-peptide blogs), fall back to the niche's
  // generic keyTopics list.
  let focusLine: string;
  let profileAnchorSection = "";
  if (brief) {
    // A custom prompt is an explicit content brief — it defines the exact
    // subject/business the post is about. Anchor topic selection on it and
    // ignore the niche's generic key-topic list (which is what caused a
    // pizzeria to get a "restaurant employee handbook" topic).
    focusLine =
      `- The topic MUST be a specific, on-brand angle for the exact subject/business described in the CONTENT BRIEF below\n` +
      `- Draw on the brief's own target keywords, locale, and terminology\n` +
      `- Vary the angle from recent titles, but never drift off the brief's subject\n` +
      `- Do NOT suggest generic ${ctx.industry} topics that aren't about the brief's subject`;
  } else if (opts.styleProfile) {
    const sp = opts.styleProfile;
    const subNiche = SUB_NICHES[sp.subNicheId];
    const subNicheName = subNiche?.name ?? "general";
    const primary = sp.primaryCompounds.length
      ? sp.primaryCompounds.join(", ")
      : "(none specified)";
    const secondary = sp.secondaryCompounds.length
      ? sp.secondaryCompounds.join(", ")
      : "(none specified)";

    focusLine =
      `- Anchor the topic on ONE of THIS BLOG'S primary compounds: ${primary}\n` +
      `- Stay strictly within the "${subNicheName}" sub-niche\n` +
      `- Secondary compounds available for comparison/stack context: ${secondary}`;

    profileAnchorSection =
      `\n\nBLOG-SPECIFIC CANON (this blog's locked profile — DO NOT drift):\n` +
      `  sub-niche: ${subNicheName}\n` +
      `  primary compounds: ${primary}\n` +
      `  secondary compounds: ${secondary}\n` +
      `Every peptide blog in this network has a different primary-compound\n` +
      `pair, which is what makes each site unique. The topic you suggest\n` +
      `MUST center on one of the two primary compounds above — do not\n` +
      `default to BPC-157 / TB-500 / semaglutide unless those are in the\n` +
      `primary list. Picking a compound outside this canon breaks the\n` +
      `network's per-blog distinctiveness.`;
  } else if (ctx.keyTopics.length > 0) {
    focusLine = `- Cover the niche's key topics: ${ctx.keyTopics.join(", ")}`;
  } else {
    focusLine = `- Stay tightly focused on the ${ctx.label} niche — do not drift into adjacent industries`;
  }

  const languageClause =
    opts.language === "fr"
      ? `\n- Write the "topic" AND every "keywords" entry in FRENCH (français), Québec phrasing — this is a French-language blog`
      : "";

  const system = `You generate fresh blog post topic ideas for a ${ctx.industry} niche site (${ctx.label}). Suggest topics that:
${focusLine}
- Do NOT overlap with recent titles
- Have clear search intent
- Are specific (not generic listicles)${languageClause}
${newsClause}

Return JSON only:
{ "topic": "Specific topic for the article", "keywords": ["kw1", "kw2", "kw3"] }`;

  const newsSection = newsBlock
    ? `\n\nRecent news headlines relevant to this vertical (last 72 hours):\n${newsBlock}`
    : "";

  const knowledgeSection = buildKnowledgeSection(opts.knowledge);

  // The operator's brief takes priority over every other signal — it names the
  // exact business/subject and target keywords the topic must fit.
  const briefSection = brief
    ? `\n\nCONTENT BRIEF (operator instructions — every topic MUST fit this exactly; it overrides the niche's generic topics):\n${brief}`
    : "";

  // The "don't overlap with recent titles" instruction above is a prompt
  // ask, not an enforced check — the model can (and does) return a reworded
  // near-duplicate ("BPC-157 vs TB-500" vs "BPC-157 TB500 Cost in Toronto")
  // that technically isn't string-identical to anything in recentTitles.
  // Score the actual output against recentTitles and retry with an explicit
  // "too similar to X" correction, bounded so a stubborn model can't loop
  // forever or blow up cost.
  const MAX_IDEATION_ATTEMPTS = 3;
  let rejectionNote = "";
  let lastResult: { topic: string; keywords: string[] } | undefined;

  for (let attempt = 1; attempt <= MAX_IDEATION_ATTEMPTS; attempt++) {
    const user = `Recent titles already used across this client's sites — avoid duplicating or closely echoing any of these (this includes sister sites in the same network, so the client's blogs don't converge on the same topic):
${recentList}${briefSection}${profileAnchorSection}${knowledgeSection}${newsSection}${rejectionNote}

Suggest the next post's topic.`;

    const { text } = await callClaude(system, user, {
      maxTokens: 300,
      temperature: 0.9,
      expectJson: true,
    });

    let result: { topic: string; keywords: string[] };
    try {
      const parsed = safeParseClaudeJson<{ topic?: unknown; keywords?: unknown }>(text);
      result = {
        topic: String(parsed.topic || "").slice(0, 500),
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : [],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "parse error";
      throw new Error(
        `Topic ideation returned invalid JSON: ${msg} | response preview: ${text.slice(0, 200)}`,
      );
    }

    lastResult = result;
    const similar = findMostSimilarTitle(result.topic, recentTitles);
    if (!similar) return result;

    if (attempt === MAX_IDEATION_ATTEMPTS) {
      // Near-duplicate titles repeated across a network are a footprint.
      recordPipelineError({
        site: "content-generator.ideateTopic",
        code: "TOPIC_SIMILARITY_ACCEPTED",
        severity: "warn",
        message:
          `accepting "${result.topic}" after ${attempt} attempts despite ` +
          `${Math.round(similar.score * 100)}% word overlap with "${similar.title}"`,
        context: {
          topic: result.topic,
          similarTitle: similar.title,
          score: similar.score,
          attempts: attempt,
        },
      });
      return result;
    }

    console.info(
      `[ideateTopic] attempt ${attempt} too similar (${Math.round(similar.score * 100)}%) ` +
      `to "${similar.title}" — retrying`,
    );
    rejectionNote =
      `\n\nYour previous suggestion "${result.topic}" is too similar to an existing title ` +
      `"${similar.title}" (${Math.round(similar.score * 100)}% word overlap). Pick a genuinely ` +
      `different subject or angle — do not just reword the same idea.`;
  }

  // Unreachable — the loop always returns by MAX_IDEATION_ATTEMPTS — but
  // TypeScript can't see that, and lastResult is always set by attempt 1.
  return lastResult!;
}

// ─── Keyword suggestion (manual "Suggest keywords" button) ──────────────────

/**
 * Generate target keywords for a (possibly user-supplied) topic. Powers the
 * manual "Suggest keywords" button: topic-aware when a topic is given,
 * otherwise falls back to niche/Knowledge-Base keywords. Draws on the
 * client's Knowledge Base first, then the niche's generic key topics.
 */
export async function suggestKeywords(
  niche: string | null | undefined,
  topic: string,
  opts: {
    knowledge?: { keywords: string[]; topics: string[] };
    language?: "en" | "fr" | "en_fr";
  } = {},
): Promise<string[]> {
  const ctx = getNicheContext(niche);
  const cleanTopic = topic.trim();

  const knowledgeSection = buildKnowledgeSection(opts.knowledge);
  const nicheKeywords =
    ctx.keyTopics.length > 0
      ? `\n\nNiche key topics (use as fallback inspiration): ${ctx.keyTopics.join(", ")}`
      : "";

  const languageClause =
    opts.language === "fr"
      ? `\n- Write every keyword in FRENCH (français), Québec phrasing — this is a French-language blog`
      : "";

  const topicLine = cleanTopic
    ? `the article topic below`
    : `the ${ctx.label} niche (no specific topic yet)`;

  const system = `You generate target SEO keywords for a ${ctx.industry} blog (${ctx.label}). Produce 4-6 concrete, search-worthy keywords or short phrases for ${topicLine}. Keywords must:
- Be specific (real terms of art, products, metrics) — not generic filler
- Have genuine search intent
- Prefer terms from the client's Knowledge Base when relevant${languageClause}

Return JSON only:
{ "keywords": ["kw1", "kw2", "kw3", "kw4"] }`;

  const user = `${cleanTopic ? `Topic: ${cleanTopic}` : "(no topic supplied — suggest niche-level keywords)"}${knowledgeSection}${nicheKeywords}

Suggest the target keywords.`;

  const { text } = await callClaude(system, user, {
    maxTokens: 200,
    temperature: 0.7,
    expectJson: true,
  });

  try {
    const parsed = safeParseClaudeJson<{ keywords?: unknown }>(text);
    if (!Array.isArray(parsed.keywords)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const k of parsed.keywords) {
      const s = String(k).trim();
      if (!s) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (out.length >= 8) break;
    }
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "parse error";
    throw new Error(
      `Keyword suggestion returned invalid JSON: ${msg} | response preview: ${text.slice(0, 200)}`,
    );
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function generateContent(opts: GenerateOptions): Promise<GenerationResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }

  // Branch on whether the blog has a locked style profile.
  //   - With profile (peptide blogs): use skeleton-composer + profile-aware scrubber
  //   - Without profile (other niches): use the existing niche-based prompt +
  //     scrubber-lite (punctuation + AI-tells, no compliance enforcement)
  const usingProfile = Boolean(opts.styleProfile);

  // External-link news references — non-peptide blogs only. Pulls
  // recent items from the news_items cache for the blog's vertical and
  // formats them as a reference list Claude can inline as <a href>
  // links. Peptide blogs intentionally skip outbound news links for
  // compliance posture (we don't want to look like we're endorsing
  // third-party clinical claims by linking to news articles about
  // peptides).
  const nicheNormalized = normalizeNicheKey(opts.niche);
  const allowExternalNewsLinks =
    nicheNormalized !== "peptides" && Boolean(opts.verticalKey);
  let newsLinksClause = "";
  if (allowExternalNewsLinks) {
    try {
      const items = await getRecentNewsForVerticalInternal(
        opts.verticalKey ?? null,
        6,
      );
      if (items.length > 0) {
        const refList = items
          .map((it, i) => {
            const pub = it.publisher ? ` — ${it.publisher}` : "";
            return `[${i + 1}] "${it.title}"${pub}\n    ${it.link}`;
          })
          .join("\n");
        newsLinksClause =
          `\n\nEXTERNAL NEWS REFERENCES (use 1-3 as inline <a href> links where they fit the topic):\n` +
          `${refList}\n\n` +
          `LINKING RULES:\n` +
          `- Pick 1-3 of the above whose headline genuinely relates to a point you're making.\n` +
          `- Use HTML <a href="URL" target="_blank" rel="${EDITORIAL_LINK_REL}">descriptive anchor text</a>.\n` +
          `- Anchor text should describe what the reader is clicking to, NOT raw URLs or "click here".\n` +
          `- If none of the references fits naturally, do NOT force a link — quality over count.\n` +
          `- Never include all 6; keep external link count to 3 max.`;
      }
    } catch (err) {
      // Post ships with no external links.
      recordPipelineError({
        site: "content-generator.newsLinks",
        code: "NEWS_LINKS_FAILED",
        severity: "warn",
        message: `news-links lookup failed: ${err instanceof Error ? err.message : String(err)
          }`,
      });
    }
  }

  // Internal-link references — recent sibling posts on the SAME blog.
  // Pre-fetched by the caller (see content-generation-actions.ts). Claude
  // weaves 2–4 of them in as inline <a href> anchors. Per the footprint
  // audit, internal link architecture is the single biggest SEO signal
  // we were leaving on the table; sibling links also raise time-on-site,
  // which is an actual ranking input.
  let internalLinksClause = "";
  const refs = opts.internalLinkRefs ?? [];
  if (refs.length > 0) {
    const refList = refs
      .slice(0, 8)
      .map((it, i) => `[${i + 1}] "${it.title}"\n    ${it.url}`)
      .join("\n");
    internalLinksClause =
      `\n\nINTERNAL LINKS — recent posts on THIS site (weave 2–4 in as inline anchors):\n` +
      `${refList}\n\n` +
      `INTERNAL LINKING RULES:\n` +
      `- Pick 2–4 of the above whose topic genuinely relates to what this article is about.\n` +
      `- Use HTML <a href="URL">descriptive anchor text</a> — no target/rel attributes (these are same-site).\n` +
      `- Anchor text must describe the linked article's subject, never "click here" / "this post" / raw URLs.\n` +
      `- Place internal links inside sentences where the reader would actually click for more — not in a "related posts" footer.\n` +
      `- Do NOT exceed 4 internal links.`;
  }

  // Language directive — appended to the system prompt so French
  // verticals (gym, roofing, tax lawyer, pest) generate French content
  // and the title / excerpt / meta fields come back in French too.
  const languageDirective = buildLanguageDirective(opts.language);

  // Client Knowledge Base context — appended to the SYSTEM prompt (the stable
  // per-blog prefix) so the article draws on the client's own material.
  const knowledgeContext = buildKnowledgeContext(opts.knowledgeSummaries);

  // Local keyword-targeted content — "" for every post on a blog with no
  // assigned city, which is what keeps this feature strictly additive.
  const localTargetingDirective = opts.localTarget
    ? buildLocalTargetingDirective(opts.localTarget)
    : "";

  let system: string;
  let user: string;
  // Word budget this call is being asked to fill. Drives the output-token
  // budget below. NOTE this is deliberately separate from `capMax` further
  // down (the published-length trim): a custom prompt on a profile blog uses
  // the global band for the token budget but the profile's own band for the
  // cap. Over-budgeting tokens is free; over-trimming words is not.
  let wordBudget: number;
  if (opts.customPrompt && opts.customPrompt.trim()) {
    // Custom-prompt path: the operator's prompt drives the article; the locked
    // guardrails (compliance + AI-tells + no-images + JSON contract) are baked
    // into buildCustomSystemPrompt. Overrides BOTH the profile and legacy paths.
    const nicheForCustom = opts.resolvedNiche ?? resolveCodeNiche(opts.niche);
    system =
      buildCustomSystemPrompt(opts, nicheForCustom) +
      languageDirective +
      knowledgeContext +
      SEO_QUALITY_DIRECTIVE +
      localTargetingDirective;
    user = buildUserPrompt(opts);
    if (newsLinksClause) user = user + newsLinksClause;
    if (internalLinksClause) user = user + internalLinksClause;
    wordBudget = MAX_WORDS;
  } else if (usingProfile && opts.styleProfile) {
    const composed = composeForPost({
      profile: opts.styleProfile,
      topic: opts.topic,
      // For universal-niche profiles, pass the blog's actual niche label
      // (e.g. "gym marketing") so the prompt's {sub_niche} placeholder
      // gets a topical value instead of the generic "General Content".
      nicheLabel: opts.niche,
    });
    system =
      composed.systemPrompt +
      languageDirective +
      knowledgeContext +
      SEO_QUALITY_DIRECTIVE +
      localTargetingDirective;
    user = composed.userPrompt;
    // Append the external-news-links clause (no-op for peptides — they
    // skip this entirely upstream).
    if (newsLinksClause) {
      user = user + newsLinksClause;
    }
    if (internalLinksClause) {
      user = user + internalLinksClause;
    }
    // Clamp the band to the global ceiling so an un-migrated profile (still
    // 1500) doesn't request a needlessly large budget.
    wordBudget = Math.min(opts.styleProfile.wordBandMax, MAX_WORDS);
  } else {
    system =
      buildSystemPrompt(opts) +
      languageDirective +
      knowledgeContext +
      SEO_QUALITY_DIRECTIVE +
      localTargetingDirective;
    user = buildUserPrompt(opts);
    if (newsLinksClause) {
      user = user + newsLinksClause;
    }
    if (internalLinksClause) {
      user = user + internalLinksClause;
    }
    wordBudget = MAX_WORDS;
  }

  // Output-token budget — ONE expression for all three paths, language-aware.
  //
  // max_tokens must comfortably fit a COMPLETE post + JSON envelope, or the
  // response truncates mid-`content`. It does NOT drive cost — billing is on
  // tokens actually generated, and the model stops on its own when the
  // article is done; the real cost lever is the word cap (the prompt target
  // + capWordCount below). A too-LOW budget is the expensive case.
  //
  // The expression this replaces —
  //   Math.min(4096, Math.max(3000, Math.round(MAX_WORDS * 3.2)))
  // — ALWAYS returned 4096, because MAX_WORDS is 2000 and 2000 * 3.2 = 6400.
  // At the file's own stated French ratio that is ~1280 French words against
  // a 1000-2000 band, and the composer asks for the 1500-word midpoint.
  // Every French post was budgeted to truncate.
  //
  // There is intentionally NO ceiling here: the per-provider ceiling is
  // applied in callClaudeOnce / callDeepSeekOnce, which are the only places
  // that know which model will serve the request.
  const baseMaxTokens = outputTokenBudget(wordBudget, opts.language);
  console.info(
    `[content-generator] token budget: ${baseMaxTokens} ` +
    `(lang=${opts.language ?? "en"}, words=${wordBudget})`,
  );

  // 1. Generate — with ONE retry on a bad attempt. An attempt is bad when it
  //    (a) fails to parse, (b) comes back without title+content, (c) was cut
  //    off by max_tokens or only parsed after truncation repair, or (d) carries
  //    a body below this blog's minimum word count. First attempt uses the full
  //    styled prompt; the retry swaps in a minimal consumer-information prompt
  //    because the full styled prompt is exactly what tends to trigger the
  //    {title}-only refusal pattern, and raises the token budget 50% so a
  //    truncation cause cannot simply repeat.
  let parsed: Partial<GeneratedContent> = {};
  let genInput = 0;
  let genOutput = 0;
  // Accumulate cost per call, since the provider (DeepSeek vs Claude) can
  // differ across attempts and they price differently.
  let genCost = 0;
  let lastShapeKeys = "(empty)";
  let lastShapePreview = "";
  let lastFailure = "";
  let lastAttemptTruncated = false;

  // Minimum publishable length for THIS post, on EVERY path. Before T06 this
  // check was wrapped in `if (!usingProfile)`, so profile blogs — the entire
  // composer path — had no minimum-length gate anywhere in generateContent,
  // and a salvaged fragment published silently. We take the LOWER of (profile
  // band min, network min) so an un-migrated profile is not retroactively
  // failed, then floor it at ABSOLUTE_MIN_WORDS so a zero/garbage band cannot
  // disable the gate again.
  const minWords =
    usingProfile && opts.styleProfile
      ? Math.max(
        ABSOLUTE_MIN_WORDS,
        Math.min(opts.styleProfile.wordBandMin, MIN_WORDS),
      )
      : MIN_WORDS;

  for (let shapeAttempt = 0; shapeAttempt <= MAX_SHAPE_RETRIES; shapeAttempt++) {
    const attemptSystem =
      shapeAttempt === 0
        ? system
        : `You are writing a consumer-information article for an adult audience. The topic and target language come from the user message below. Treat the topic analytically and informatively. Write the full article naturally — multiple sections with <h2> headings, paragraphs, lists where useful.

Return ONE JSON object with these fields:
{
  "title": "...",
  "content": "<p>opening paragraph...</p><h2>section heading</h2><p>...</p><h2>next section</h2><p>...</p>",
  "excerpt": "150-160 character summary",
  "metaTitle": "SEO title under 60 chars",
  "metaDescription": "150-160 char meta description",
  "keywords": ["...", "...", "..."]
}

The "content" field is the full HTML article body — at least ${MIN_WORDS} words. Use <p>, <h2>, <h3>, <ul>, <ol>, <li>, <strong>, <em>, <a> tags only. Escape \\" inside HTML attribute values.${languageDirective}`;

    // Truncation and shape drift need OPPOSITE instructions: one asks for the
    // body that was missing, the other trades length for a closed object.
    const attemptUser =
      shapeAttempt === 0
        ? user
        : user +
        (lastAttemptTruncated ? LENGTH_RETRY_REMINDER : SHAPE_RETRY_REMINDER);

    // Give the retry 50% more room. Harmless when the first failure was shape
    // drift (unused tokens are not billed) and decisive when it was length.
    const attemptMaxTokens =
      shapeAttempt === 0 ? baseMaxTokens : Math.ceil(baseMaxTokens * 1.5);

    if (shapeAttempt > 0) {
      console.info(
        `[content-generator] retry attempt ${shapeAttempt + 1} ` +
        `(cause: ${lastFailure || "unknown"}) using simplified fallback prompt, ` +
        `maxTokens=${attemptMaxTokens}`,
      );
    }

    const gen = await callClaude(attemptSystem, attemptUser, {
      maxTokens: attemptMaxTokens,
      // 0.5 (down from 0.7). Lower variance reduces the chance the
      // sampler picks a hedging trajectory that returns {title} only.
      temperature: 0.5,
      expectJson: true,
    });
    genInput += gen.inputTokens;
    genOutput += gen.outputTokens;
    genCost += calcCost(gen.inputTokens, gen.outputTokens, gen.provider);

    // 2. Parse — safeParseClaudeJsonWithTier reports which repair tier
    //    succeeded so a salvaged truncation is counted, not hidden.
    let candidate: Partial<GeneratedContent>;
    let salvagedFromTruncation = false;
    try {
      const parsedResult =
        safeParseClaudeJsonWithTier<Partial<GeneratedContent>>(gen.text);
      candidate = parsedResult.value;
      salvagedFromTruncation = parsedResult.tier === "truncation";
      if (parsedResult.tier === "truncation") {
        // The model hit its token budget. repairTruncatedJson closed the
        // object at the last safe comma, so the article body ends
        // mid-sentence. T06 now FAILS the attempt below rather than
        // publishing the salvage; the counter still records that it happened.
        bumpCounter("truncatedSalvaged");
        recordPipelineError({
          site: "content-generator.parse",
          code: "JSON_TRUNCATION_SALVAGED",
          severity: "error",
          message:
            "Article JSON only parsed after truncation repair — the body is cut short",
          postId: opts.postId ?? null,
          context: {
            topic: opts.topic,
            maxTokens: attemptMaxTokens,
            rawLength: gen.text.length,
            shapeAttempt: shapeAttempt + 1,
          },
        });
      } else if (parsedResult.tier !== "none") {
        bumpCounter("jsonRepaired");
        recordPipelineError({
          site: "content-generator.parse",
          code: "JSON_REPAIRED",
          severity: "warn",
          message: `Article JSON needed ${parsedResult.tier} repair`,
          postId: opts.postId ?? null,
          context: { topic: opts.topic, tier: parsedResult.tier },
        });
      }
    } catch (err) {
      lastAttemptTruncated = gen.truncated;
      lastFailure = `invalid JSON${gen.truncated ? " (provider reported max_tokens)" : ""}`;
      if (shapeAttempt < MAX_SHAPE_RETRIES) {
        parsed = {};
        recordPipelineError({
          site: "content-generator.parse",
          code: "JSON_PARSE_RETRY",
          severity: "warn",
          message: `attempt ${shapeAttempt + 1} produced invalid JSON — retrying`,
          postId: opts.postId ?? null,
          context: {
            topic: opts.topic,
            error: err instanceof Error ? err.message.slice(0, 400) : String(err),
          },
        });
        continue;
      }
      const msg = err instanceof Error ? err.message : "parse error";
      throw new Error(`Claude returned invalid JSON: ${msg}`);
    }

    const shaped = normalizeArticleShape(candidate);

    // 3. TRUNCATION GATE. A response the provider cut off at max_tokens — or
    //    one that only parsed because repairTruncatedJson closed the string
    //    and brackets for us — is a FAILED generation, not a short article.
    //    The body ends mid-sentence and usually mid-HTML-element. Publishing
    //    the salvage is what put half-finished posts on live client blogs.
    if (gen.truncated || salvagedFromTruncation) {
      lastAttemptTruncated = true;
      lastFailure = gen.truncated
        ? `provider reported max_tokens at budget ${attemptMaxTokens}`
        : `JSON only parsed after truncation repair (budget ${attemptMaxTokens})`;
      lastShapeKeys = Object.keys(shaped).join(", ") || "(empty)";
      if (shapeAttempt < MAX_SHAPE_RETRIES) {
        console.warn(
          `[content-generator] attempt ${shapeAttempt + 1} TRUNCATED ` +
          `(${lastFailure}) — retrying with a larger budget`,
        );
        parsed = {};
        continue;
      }
      throw new Error(
        `Generation truncated on every attempt (${lastFailure}). ` +
        `Raise the ratios in src/lib/services/content-token-budget.ts, or ` +
        `lower GLOBAL_WORD_BAND_MAX in src/lib/content/config.ts.`,
      );
    }
    lastAttemptTruncated = false;

    // 4. SHAPE GATE — unchanged semantics.
    if (!shaped.title || !shaped.content) {
      lastShapeKeys = Object.keys(shaped).join(", ") || "(empty)";
      lastShapePreview = Object.entries(shaped)
        .slice(0, 8)
        .map(([k, v]) => {
          if (typeof v === "string") return `${k}=str(${v.length}ch)`;
          if (Array.isArray(v)) return `${k}=arr(${v.length})`;
          if (v && typeof v === "object")
            return `${k}=obj{${Object.keys(v).slice(0, 4).join(",")}}`;
          return `${k}=${typeof v}`;
        })
        .join(" ");
      lastFailure = `missing content (keys: ${lastShapeKeys})`;
      parsed = shaped;
      if (shapeAttempt < MAX_SHAPE_RETRIES) {
        recordPipelineError({
          site: "content-generator.shapeRetry",
          code: "SHAPE_RETRY",
          severity: "warn",
          message: `attempt ${shapeAttempt + 1} missing content (keys: ${lastShapeKeys}) — retrying with stripped prompt`,
          postId: opts.postId ?? null,
          context: { keys: lastShapeKeys, shapeAttempt: shapeAttempt + 1 },
        });
        continue;
      }
      break; // falls through to the "missing required fields" throw below
    }

    // 5. LENGTH GATE, pre-pipeline. Cheap proxy on the RAW body so a short
    //    article costs an in-loop retry instead of burning a whole topic
    //    attempt in the caller. Sanitization only ever removes content, so a
    //    raw body under the minimum can never come out over it.
    const rawWords = countWordsInHtml(shaped.content);
    parsed = shaped;
    if (rawWords < minWords) {
      lastFailure = `body is ${rawWords} words, below the ${minWords}-word minimum`;
      if (shapeAttempt < MAX_SHAPE_RETRIES) {
        console.warn(
          `[content-generator] attempt ${shapeAttempt + 1} too short ` +
          `(${rawWords} < ${minWords}) — retrying`,
        );
        continue;
      }
      break; // falls through to the hard gate after post-processing
    }

    if (shapeAttempt > 0) {
      console.info(
        `[content-generator] recovered on attempt ${shapeAttempt + 1}`,
      );
    }
    break;
  }

  if (!parsed.title || !parsed.content) {
    throw new Error(
      `Claude response missing required fields (title, content) after ${MAX_SHAPE_RETRIES + 1} attempts. ` +
      `Returned keys: ${lastShapeKeys}. Shape: ${lastShapePreview}. ` +
      `Reconstruction did not match any known variant — extend ` +
      `reconstructContentFromParts() in content-generator.ts.`,
    );
  }
  // 3. Format + sanitize, strip any Claude-emitted images (they'd be broken).
  //    Word-count enforcement here is the legacy hard MIN_WORDS check; for
  //    profile blogs the scrubber's Layer 1F handles word-band checks.
  let body = parsed.content;
  if (body.includes("#")) body = convertMarkdownToHtml(body);
  body = sanitizeMetadata(body);
  body = stripClaudeImages(body);
  // Guarantee the body carries no <h1> — the platform title is the page's
  // sole H1. Prevents the "Too many H1 headings" SEO error.
  body = demoteH1ToH2(body);
  // Drop duplicate heading text (and any body heading that restates the
  // title) — clears the "duplicate heading texts" audit warning.
  body = dedupeHeadings(body, parsed.title ?? "");
  // Enforce unique anchor text — unwrap any later link that reuses an earlier
  // link's visible text ("some anchor texts are used more than once" warning).
  body = dedupeAnchorText(body);

  // Hard-cap article length on BOTH paths. The prompt + max_tokens keep
  // Claude near the target, but it still occasionally overshoots; trimming
  // here guarantees the published word count stays within the band (the
  // 1262-word posts came from the profile path, which previously skipped this
  // cap and relied on the scrubber, which only flags — never trims). Cap
  // BEFORE the scrubber so any bottom-placed compliance phrase it appends is
  // never cut off.
  const capMax =
    usingProfile && opts.styleProfile
      ? Math.min(opts.styleProfile.wordBandMax, MAX_WORDS)
      : MAX_WORDS;
  body = capWordCount(body, capMax);

  // HARD MINIMUM — every path: legacy, custom-prompt AND profile. This check
  // used to be wrapped in `if (!usingProfile)`, which is how profile blogs
  // published truncation salvage. It is the last line of defence after all
  // post-processing has run, so it also catches a body that only fell below
  // the floor because sanitize/dedupe/cap removed content.
  const postProcessWordCount = countWordsInHtml(body);
  if (postProcessWordCount < minWords) {
    throw new Error(
      `Generated content is ${postProcessWordCount} words, below the ` +
      `${minWords}-word minimum` +
      (usingProfile ? " (profile path)" : "") +
      (lastFailure ? ` | last attempt: ${lastFailure}` : ""),
    );
  }

  // Short fields are computed BEFORE the scrubber so it can check and fix
  // them in the same pass as the body (T07). They used to be normalized
  // inline in the return statement, which is why an em dash in a <title> —
  // the single most visible AI tell we ship, and one that lands directly in
  // the SERP — bypassed every check.
  const metaTargetContext: LocalTargetMetaContext | undefined = opts.localTarget
    ? {
      keyword: opts.localTarget.keyword,
      city: opts.localTarget.city,
      brandName: opts.localTarget.brandName,
    }
    : undefined;
  const shortFields = {
    title: parsed.title,
    excerpt: normalizeExcerpt(parsed.excerpt || generateExcerpt(body)),
    metaTitle: normalizeMetaTitle(
      parsed.metaTitle,
      parsed.title,
      metaTargetContext,
      opts.brandName,
    ),
    metaDescription: normalizeMetaDescription(
      parsed.metaDescription,
      generateExcerpt(body),
      metaTargetContext,
    ),
  };

  // 4. Scrubber — profile-aware when a profile exists, lite otherwise.
  let scrubberReport: ScrubberReport | undefined;
  let flaggedForReview = false;
  let scrubberVerdict: ScrubberVerdict | undefined;
  let scrubbedTitle = shortFields.title;
  let scrubbedExcerpt = shortFields.excerpt;
  let scrubbedMetaTitle = shortFields.metaTitle;
  let scrubbedMetaDescription = shortFields.metaDescription;
  if (usingProfile && opts.styleProfile) {
    const result = runScrubber({
      content: body,
      profile: opts.styleProfile,
      fields: shortFields,
    });
    body = result.content;
    scrubberReport = result.report;
    flaggedForReview = result.flaggedForReview;
    scrubberVerdict = result.verdict;
    scrubbedTitle = result.fields.title ?? scrubbedTitle;
    scrubbedExcerpt = result.fields.excerpt ?? scrubbedExcerpt;
    scrubbedMetaTitle = result.fields.metaTitle ?? scrubbedMetaTitle;
    scrubbedMetaDescription =
      result.fields.metaDescription ?? scrubbedMetaDescription;
    if (flaggedForReview) bumpCounter("flaggedForReview");
    // runScrubber's fourth return value has never been read. When it is
    // true the scrubber found a CRITICAL violation (or a terminal Layer 1
    // rule) and asked for a regenerate — and we publish anyway. T22 does
    // NOT change that; T07 does. This makes the size of the problem
    // visible so T07 can be scoped against a real number.
    if (result.regenerateRequested) {
      bumpCounter("blockedRegenerate");
      recordPipelineError({
        site: "content-generator.scrubber",
        code: "SCRUBBER_REGENERATE_IGNORED",
        severity: "error",
        message:
          `Scrubber returned ${result.report.action} ` +
          `(${result.report.violations.critical.length} critical, ` +
          `${result.report.violations.high.length} high) — published anyway`,
        postId: opts.postId ?? null,
        context: {
          action: result.report.action,
          finalStatus: result.report.finalStatus,
          strictness: opts.styleProfile.scrubberStrictness,
          critical: result.report.violations.critical.length,
          high: result.report.violations.high.length,
          medium: result.report.violations.medium.length,
          low: result.report.violations.low.length,
        },
      });
    }
  } else {
    // Lite path — auto-fix punctuation + log AI-tell hits but don't gate.
    // Short fields get the same punctuation fix; no thresholds apply here.
    const lite = runScrubberLite(body, shortFields);
    body = lite.content;
    scrubbedTitle = lite.fields.title ?? scrubbedTitle;
    scrubbedExcerpt = lite.fields.excerpt ?? scrubbedExcerpt;
    scrubbedMetaTitle = lite.fields.metaTitle ?? scrubbedMetaTitle;
    scrubbedMetaDescription =
      lite.fields.metaDescription ?? scrubbedMetaDescription;
    if (lite.violationCount > 0) {
      recordPipelineError({
        site: "content-generator.scrubberLite",
        code: "SCRUBBER_LITE_VIOLATIONS",
        severity: "warn",
        message: `scrubber-lite found ${lite.violationCount} violation(s)`,
        postId: opts.postId ?? null,
        context: {
          violationCount: lite.violationCount,
          fixesApplied: lite.fixesApplied.length,
        },
      });
    }
  }

  const wordCount = countWordsInHtml(body);

  // 5. Compute the hero image URL via Google Nano Banana.
  //    Strategy: run a small Claude call to summarize the article body into
  //    a concrete photographic scene description, then pass that to Nano
  //    Banana as a customScene. This makes the image content-aware (the
  //    scene actually matches what THIS article is about) instead of
  //    falling back to the blog's locked sub-niche theme for every post.
  //    Falls back to the static scene builder if the summary call fails.
  //    Output is always a data: URI — Shopify and WordPress decode it
  //    inline at publish time. No fallback provider.
  const imageKeywords =
    parsed.keywords && parsed.keywords.length > 0 ? parsed.keywords : opts.keywords;
  let heroImageUrl: string | undefined;
  let bodyImageUrl: string | undefined;
  let customScene: string | null = null;
  try {
    customScene = await summarizeArticleAsScene(
      parsed.title,
      body,
      imageKeywords,
    );
    if (customScene) {
      console.info(
        `[content-generator] Image scene: "${customScene.slice(0, 100)}${customScene.length > 100 ? "…" : ""}"`,
      );
    }

    const imageInputBase = {
      title: parsed.title,
      keywords: imageKeywords,
      niche: opts.niche,
      subNicheId: opts.styleProfile?.subNicheId,
      primaryCompounds: opts.styleProfile?.primaryCompounds,
      customScene: customScene ?? undefined,
    };

    // Generate hero + body in parallel — they share the same scene but
    // request different framings (wide vs detail), giving the post two
    // visually distinct images for ~2× the latency of one.
    // Either failure is non-fatal: settle so a body-image timeout
    // doesn't drop the hero.
    const [heroResult, bodyResult] = await Promise.allSettled([
      generateHeroImage(imageInputBase),
      generateBodyImage(imageInputBase),
    ]);

    if (heroResult.status === "fulfilled") {
      heroImageUrl = heroResult.value.url;
      console.info(
        `[content-generator] Hero image via ${heroResult.value.model} for "${parsed.title.slice(0, 60)}"`,
      );
    } else {
      // Retry below may still recover it, hence warn.
      recordPipelineError({
        site: "content-generator.images",
        code: "IMAGE_HERO_FAILED",
        severity: "warn",
        message: `Hero image generation failed: ${heroResult.reason instanceof Error
          ? heroResult.reason.message
          : String(heroResult.reason)
          }`,
        postId: opts.postId ?? null,
      });
    }

    if (bodyResult.status === "fulfilled") {
      bodyImageUrl = bodyResult.value.url;
      console.info(
        `[content-generator] Body image via ${bodyResult.value.model} for "${parsed.title.slice(0, 60)}"`,
      );
    } else {
      recordPipelineError({
        site: "content-generator.images",
        code: "IMAGE_BODY_FAILED",
        severity: "warn",
        message: `Body image generation failed: ${bodyResult.reason instanceof Error
          ? bodyResult.reason.message
          : String(bodyResult.reason)
          }`,
        postId: opts.postId ?? null,
      });
    }

    // HERO RETRY — the hero is the post's primary image; never ship
    // without one if we can avoid it. If the first attempt failed
    // (transient Google error, or a customScene the safety filter
    // rejected), retry ONCE using the static niche scene instead of
    // the article-derived customScene. The static scenes are
    // pre-vetted and safe-filter-friendly, so this recovers the vast
    // majority of first-attempt failures.
    if (!heroImageUrl) {
      try {
        const retry = await generateHeroImage({
          title: parsed.title,
          keywords: imageKeywords,
          niche: opts.niche,
          subNicheId: opts.styleProfile?.subNicheId,
          primaryCompounds: opts.styleProfile?.primaryCompounds,
          // No customScene → buildImagePrompt uses the static niche
          // scene (SUB_NICHE_VISUALS / FREE_NICHE_VISUALS / default).
        });
        heroImageUrl = retry.url;
        console.info(
          `[content-generator] Hero image RECOVERED on retry (static scene) for "${parsed.title.slice(0, 60)}"`,
        );
      } catch (retryErr) {
        // The post will ship with no hero image.
        recordPipelineError({
          site: "content-generator.images",
          code: "IMAGE_HERO_RETRY_FAILED",
          severity: "error",
          message: `Hero image retry also failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)
            }`,
          postId: opts.postId ?? null,
        });
      }
    }

    // BODY RETRY — same idea, lower priority. Only retry if the hero
    // succeeded (so we don't double-spend Google calls on a fully-down
    // API). Static scene, body framing.
    if (!bodyImageUrl && heroImageUrl) {
      try {
        const retry = await generateBodyImage({
          title: parsed.title,
          keywords: imageKeywords,
          niche: opts.niche,
          subNicheId: opts.styleProfile?.subNicheId,
          primaryCompounds: opts.styleProfile?.primaryCompounds,
        });
        bodyImageUrl = retry.url;
        console.info(
          `[content-generator] Body image RECOVERED on retry (static scene) for "${parsed.title.slice(0, 60)}"`,
        );
      } catch (retryErr) {
        // Non-fatal — body image is optional, but still worth a rate.
        recordPipelineError({
          site: "content-generator.images",
          code: "IMAGE_BODY_RETRY_FAILED",
          severity: "warn",
          message: `Body image retry also failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)
            }`,
          postId: opts.postId ?? null,
        });
      }
    }
  } catch (err) {
    // Scene summarizer threw — record and ship without images rather than
    // substituting an unrelated placeholder.
    recordPipelineError({
      site: "content-generator.images",
      code: "IMAGE_PIPELINE_FAILED",
      severity: "error",
      message: `Image pipeline failed: ${err instanceof Error ? err.message : String(err)
        }`,
      postId: opts.postId ?? null,
    });
  }

  // Verdict on the image pipeline. This is currently the ONLY place an
  // imageless post is observable: the auto-publish path does not persist
  // generated_posts.featured_image_url (see the PR notes on T22 Step 9c),
  // so it cannot be reconstructed from the database afterwards.
  if (!heroImageUrl) {
    bumpCounter("imageless");
    recordPipelineError({
      site: "content-generator.images",
      code: "POST_HAS_NO_HERO_IMAGE",
      severity: "error",
      message: `"${parsed.title.slice(0, 80)}" is shipping with no hero image`,
      postId: opts.postId ?? null,
      context: {
        niche: opts.niche,
        subNicheId: opts.styleProfile?.subNicheId ?? null,
      },
    });
  }
  if (!bodyImageUrl) bumpCounter("bodyImageMissing");

  // Embed the body image into the HTML at roughly the midpoint so it
  // actually appears in the published post. Hero stays as the featured
  // image (rendered above the post by Shopify/WordPress themes).
  if (bodyImageUrl) {
    body = embedBodyImage(body, bodyImageUrl, parsed.title, opts.blogSeed);
  }

  // Inject the client's call-to-action button at its configured position(s)
  // — no-op when the client has no CTA configured.
  //
  // T02: the button links DIRECTLY to the client's destination. It used to be
  // rewritten to {NEXT_PUBLIC_APP_URL}/r/{postId}, which put one shared netgrid
  // host into the HTML of every site in the network and hid the client's own
  // domain from the markup. Attribution moved to UTM parameters, which the
  // client's GA4 / Shopify analytics already parse.
  const ctaForInject = opts.cta
    ? {
        ...opts.cta,
        url: withUtm(opts.cta.url, {
          blogDomain: opts.blogDomain,
          medium: "cta_button",
          postId: opts.postId,
        }),
      }
    : opts.cta;
  body = injectCta(body, ctaForInject, opts.blogSeed);

  // In-body buy-phrase money link (funnel) — link the first buy-phrase/compound
  // mention to the client's destination, tagged so the click is distinguishable
  // from a CTA-button click in the client's analytics.
  if (opts.buyLink && opts.buyLink.terms.length > 0) {
    const buyUrl = withUtm(opts.buyLink.url, {
      blogDomain: opts.blogDomain,
      medium: "body_link",
      postId: opts.postId,
    });
    body = injectMoneyLink(body, buyUrl, opts.buyLink.terms);
  }

  // Mini registration form (Name / Location / Email) at the configured
  // position(s) — no-op when the client hasn't enabled it.
  if (opts.registrationForm) {
    body = injectRegistrationForm(
      body,
      opts.registrationForm,
      opts.postId,
      opts.blogSeed,
    );
  }

  // T02: the page-view tracking pixel that used to be appended here is gone.
  // It embedded {NEXT_PUBLIC_APP_URL}/api/track/px/{postId} — one shared host —
  // into the body of every published article on every site in the network.
  // Page views now come from the client's own analytics and, once T04 lands,
  // from Search Console impressions per URL.

  // 6. Scoring removed (per footprint audit insight 2). The old
  //    analyzeContent call cost ~$0.0015/post AND optimized to exactly the
  //    metrics classifiers fingerprint (keyword density 1-3%, primary kw
  //    in first 100w). Replacement is a local uniqueness + fingerprint
  //    check — separate follow-up. Default scores keep the DB schema and
  //    UI happy; they're advisory anyway, never blocking.
  const scores: AnalysisScores = {
    seoScore: 70,
    readabilityScore: 70,
    brandVoiceScore: 70,
  };

  const totalInputTokens = genInput;
  const totalOutputTokens = genOutput;
  const totalTokens = totalInputTokens + totalOutputTokens;
  const costUsd = genCost;

  return {
    // Short fields come back from the scrubber (T07) — see the hoist above.
    title: scrubbedTitle,
    content: body,
    excerpt: scrubbedExcerpt,
    metaTitle: scrubbedMetaTitle,
    metaDescription: scrubbedMetaDescription,
    keywords: parsed.keywords && parsed.keywords.length > 0 ? parsed.keywords : opts.keywords,
    wordCount,
    seoScore: scores.seoScore,
    readabilityScore: scores.readabilityScore,
    brandVoiceScore: scores.brandVoiceScore,
    tokensUsed: totalTokens,
    costUsd: Number(costUsd.toFixed(6)),
    heroImageUrl,
    bodyImageUrl,
    scrubberReport,
    flaggedForReview,
    scrubberVerdict,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Insert the body image into the article HTML at roughly the midpoint.
 *
 * Strategy: split the body on closing </p> tags, walk to the paragraph
 * that crosses the halfway word-count mark, and insert a <figure> with
 * the image right before it. If the body has fewer than 4 paragraphs
 * we fall back to inserting before the last paragraph so the image
 * doesn't end up at the very top or in a one-line stub.
 *
 * Uses a plain alt attribute derived from the post title — the body
 * image content is conceptually the same topic as the hero, so we
 * don't bother generating a separate alt string.
 */
function embedBodyImage(
  html: string,
  dataUri: string,
  title: string,
  blogSeed?: string,
): string {
  const safeAlt = title
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 200);
  // Per-blog wrapper class + style variant so this markup isn't identical
  // across the network (footprint audit #8). Same blog → same markup always.
  const cls = bodyImageClassForBlog(blogSeed);
  // Two style variants picked deterministically so different blogs emit
  // different inline-style strings. Both render identically; only the
  // serialized HTML differs.
  const styleVariant = blogSeed && hashSeed(blogSeed) % 2 === 0
    ? `margin:1.5em 0;`
    : `margin:1.25rem 0 1.75rem;`;
  const imgStyle = blogSeed && (hashSeed(blogSeed) >> 3) % 2 === 0
    ? `width:100%;height:auto;display:block;`
    : `display:block;max-width:100%;height:auto;`;
  const figure =
    `<figure class="${cls}" style="${styleVariant}">` +
    `<img src="${dataUri}" alt="${safeAlt}" loading="lazy" ` +
    `style="${imgStyle}" />` +
    `</figure>`;

  // Split keeping the closing tag attached to each piece.
  const parts = html.split(/(<\/p>)/i);
  // After the split, paragraphs look like [text, "</p>", text, "</p>", ...].
  // Rebuild paragraphs by pairing each text part with its closing tag.
  type Para = { html: string; words: number };
  const paragraphs: Para[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i] ?? "";
    const close = parts[i + 1] ?? "";
    const combined = text + close;
    if (combined.trim().length === 0) continue;
    const words = combined.replace(/<[^>]+>/g, " ").trim().split(/\s+/).length;
    paragraphs.push({ html: combined, words });
  }

  if (paragraphs.length === 0) {
    // No paragraphs — append at end as fallback.
    return html + figure;
  }
  if (paragraphs.length < 4) {
    // Short article — insert before the last paragraph.
    const insertAt = paragraphs.length - 1;
    return (
      paragraphs
        .slice(0, insertAt)
        .map((p) => p.html)
        .join("") +
      figure +
      paragraphs
        .slice(insertAt)
        .map((p) => p.html)
        .join("")
    );
  }

  // Walk paragraphs accumulating word count until we cross the midpoint.
  const total = paragraphs.reduce((s, p) => s + p.words, 0);
  const midpoint = total / 2;
  let running = 0;
  let insertBefore = Math.floor(paragraphs.length / 2); // safe default
  for (let i = 0; i < paragraphs.length; i++) {
    running += paragraphs[i].words;
    if (running >= midpoint) {
      // Insert before paragraph i so the image breaks the flow at the
      // halfway mark rather than after it.
      insertBefore = i;
      break;
    }
  }
  // Never insert before paragraph 0 or after the last — both look bad.
  if (insertBefore <= 0) insertBefore = 1;
  if (insertBefore >= paragraphs.length) insertBefore = paragraphs.length - 1;

  return (
    paragraphs
      .slice(0, insertBefore)
      .map((p) => p.html)
      .join("") +
    figure +
    paragraphs
      .slice(insertBefore)
      .map((p) => p.html)
      .join("")
  );
}
