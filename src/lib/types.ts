// Enums matching database schema
export type UserRole = "super_admin" | "admin" | "client";
export type ClientStatus = "onboarding" | "active" | "paused" | "churned";
export type BlogStatus = "active" | "paused" | "setup" | "decommissioned";
export type SeoPlugin = "yoast" | "rankmath" | "none";
export type Platform = "wordpress" | "shopify";
export type SeoCategory = "meta" | "content" | "technical" | "links" | "images" | "schema" | "performance";
export type IssueSeverity = "critical" | "warning" | "notice";
export type IssueStatus = "detected" | "queued" | "approved" | "applied" | "verified" | "dismissed" | "failed";
export type MessageSenderRole = "admin" | "client" | "system";
export type SeoTrend = "improving" | "stable" | "declining";
export type CheckType = "scheduled" | "manual";
export type ThirdPartySource = "ahrefs" | "semrush" | "moz";

// Dashboard stat card
export interface StatCard {
  title: string;
  value: string | number;
  change?: number;
  changeLabel?: string;
  icon?: string;
}

// SEO Score breakdown
export interface SeoScoreBreakdown {
  overall: number;
  meta: number;
  content: number;
  technical: number;
  links: number;
  images: number;
}

// Fix payload for WP REST API calls
export interface FixPayload {
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: Record<string, unknown>;
}

// CSV import result
export interface CsvImportResult {
  totalRows: number;
  successCount: number;
  failedCount: number;
  errors: Array<{ row: number; field: string; message: string }>;
}

// Platform connection test result (WordPress or Shopify)
export interface ConnectionResult {
  success: boolean;
  message: string;
  platform?: Platform;
  wpVersion?: string;
  seoPlugin?: SeoPlugin;
  /**
   * Version reported by the netgrid-seo-bridge MU-plugin, or null when it is
   * not installed. Without the bridge, Yoast meta is NOT REST-writable on the
   * site (see docs/wordpress/netgrid-seo-bridge.php). undefined means the
   * probe was not applicable (Shopify).
   */
  seoBridgeVersion?: string | null;
  userRole?: string;
  shopifyStoreName?: string;
  shopifyPlan?: string;
}

// Back-compat alias — older code imports WpConnectionResult
export type WpConnectionResult = ConnectionResult;

// Generic post input for publishing
export interface PublishPostInput {
  title: string;
  content: string;
  excerpt?: string;
  status?: "draft" | "publish";
  tags?: string[];
  featuredImageUrl?: string;
  /**
   * SEO meta title (title tag). Written to the platform's SEO fields:
   * Shopify → article metafield `global.title_tag`; WordPress → Yoast /
   * RankMath title (routed by the blog's seoPlugin). Falls back to `title`
   * for rendering when absent.
   */
  metaTitle?: string;
  /**
   * SEO meta description. Written to the platform's SEO fields: Shopify →
   * article metafield `global.description_tag`; WordPress → Yoast /
   * RankMath description. When absent, the platform falls back to an
   * excerpt or auto-generated snippet.
   */
  metaDescription?: string;
  /**
   * Byline / author display name. Shopify stamps every article with the API
   * token's name ("Shopify API") unless an `author` is supplied — a
   * network-wide fingerprint. When omitted, the platform client derives a
   * stable per-blog human name so each site has its own consistent byline.
   */
  author?: string;
  /**
   * Explicit URL slug (WordPress `slug` / Shopify article `handle`). When set,
   * it overrides the platform's default title-derived slug. Used to carry the
   * keyword-first SEO handle. When omitted, publishPost derives one from the
   * primary keyword (see lib/seo/meta-suffix.ts).
   */
  slug?: string;
}

/**
 * Outcome of the SEO title/description write that accompanies a publish.
 *
 *   "written"     — the platform confirmed the write (WP Yoast / RankMath
 *                   endpoint returned 2xx).
 *   "unverified"  — the values were sent but the platform gives us no
 *                   confirmation. Shopify nests metafields inside the article
 *                   POST and silently drops invalid ones, so a 2xx on the
 *                   article says nothing about the metafields.
 *   "skipped"     — nothing to write, or the site runs no SEO plugin and has
 *                   no REST surface that could accept a head meta tag.
 *   "failed"      — the write was attempted and threw.
 */
export type MetaWriteStatus = "written" | "unverified" | "skipped" | "failed";

export interface PublishPostResult {
  success: boolean;
  message: string;
  postId?: string | number;
  postUrl?: string;
  /**
   * Optional so every existing construction site still type-checks. Absent is
   * treated as "unverified" by the auto-publish counter — see T14.
   */
  metaStatus?: MetaWriteStatus;
  /**
   * WordPress only. Whether the SEO meta we wrote was confirmed on the LIVE
   * page. WordPress returns 200 for meta writes it silently discards, so this
   * is the only trustworthy signal (T14).
   *   true      - confirmed in the live <head>
   *   false     - the page was fetched and shows something else
   *   null      - checked but the page was unreachable
   *   undefined - not applicable (Shopify, draft, or no meta supplied)
   */
  seoMetaVerified?: boolean | null;
  /** Operator-readable explanation of seoMetaVerified. */
  seoMetaMessage?: string;
}

// Activity log entry details
export interface ActivityDetails {
  [key: string]: unknown;
}

// Report highlights/concerns
export interface ReportHighlight {
  blogDomain: string;
  description: string;
  scoreChange?: number;
}

// Top keywords from third-party data
export interface TopKeyword {
  keyword: string;
  position: number;
  volume: number;
  url: string;
}
