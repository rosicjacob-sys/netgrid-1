import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  decimal,
  timestamp,
  date,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
  vector,
  customType,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

// Postgres full-text search vector. We never read the raw value back through
// Drizzle (queries use ts_rank / @@ on it and set it via to_tsvector(...)),
// so a minimal custom type is enough to reference the column type-safely.
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// ─── Enums ───────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum("user_role", ["super_admin", "admin", "client"]);
export const clientStatusEnum = pgEnum("client_status", ["onboarding", "active", "paused", "churned"]);
export const blogStatusEnum = pgEnum("blog_status", ["active", "paused", "setup", "decommissioned"]);
export const seoPluginEnum = pgEnum("seo_plugin", ["yoast", "rankmath", "none"]);
export const platformEnum = pgEnum("platform", ["wordpress", "shopify"]);
export const shopifyAuthModeEnum = pgEnum("shopify_auth_mode", [
  "legacy_token",
  "client_credentials",
]);
export const seoCategoryEnum = pgEnum("seo_category", ["meta", "content", "technical", "links", "images", "schema", "performance"]);
export const issueSeverityEnum = pgEnum("issue_severity", ["critical", "warning", "notice"]);
export const issueStatusEnum = pgEnum("issue_status", ["detected", "queued", "approved", "applied", "verified", "dismissed", "failed"]);
export const senderRoleEnum = pgEnum("sender_role", ["admin", "client", "system"]);
export const seoTrendEnum = pgEnum("seo_trend", ["improving", "stable", "declining"]);
export const checkTypeEnum = pgEnum("check_type", ["scheduled", "manual"]);
export const thirdPartySourceEnum = pgEnum("third_party_source", ["ahrefs", "semrush", "moz"]);
export const generatedPostStatusEnum = pgEnum("generated_post_status", ["pending", "generating", "generated", "publishing", "published", "failed"]);
export const keywordTargetStatusEnum = pgEnum("keyword_target_status", ["pending", "generating", "generated", "failed", "skipped"]);
export const dataforseoRunStatusEnum = pgEnum("dataforseo_run_status", ["pending", "success", "failed"]);
export const scrubberStrictnessEnum = pgEnum("scrubber_strictness", ["loose", "standard", "strict"]);
export const compliancePlacementEnum = pgEnum("compliance_placement", [
  "TOP",
  "BOTTOM",
  "TOP_AND_BOTTOM",
  "INLINE",
  "ABOUT_ONLY",
  "ROTATING",
]);
export const knowledgeSourceTypeEnum = pgEnum("knowledge_source_type", [
  "spreadsheet",
  "csv",
  "docx",
  "pdf",
  "image",
  "text",
]);
export const knowledgeExtractionStatusEnum = pgEnum("knowledge_extraction_status", [
  "pending",
  "extracted",
  "failed",
]);

// ─── 1. users ────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  passwordHash: text("password_hash"),
  role: userRoleEnum("role").notNull().default("client"),
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
  avatarUrl: text("avatar_url"),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("users_email_idx").on(table.email),
  index("users_client_id_idx").on(table.clientId),
]);

// ─── 2. clients ──────────────────────────────────────────────────────────────

export const clients = pgTable("clients", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  contactName: varchar("contact_name", { length: 255 }),
  contactEmail: varchar("contact_email", { length: 255 }),
  contactPhone: varchar("contact_phone", { length: 50 }),
  niche: varchar("niche", { length: 255 }),
  totalBlogsTarget: integer("total_blogs_target").default(0),
  notesInternal: text("notes_internal"),
  // Optional custom generation prompt (client-level default). When set, it
  // drives article generation for this client's blogs instead of the
  // Client-wide custom generation prompt. When set, ALL of this client's blogs
  // are generated from it instead of the niche/persona style. Compliance and
  // the JSON output contract stay locked regardless.
  customPrompt: text("custom_prompt"),
  // When the custom prompt is active, also layer each blog's generated
  // persona/voice on top of it (instead of the custom prompt fully replacing
  // the persona). Persona is still per-blog, so each site keeps its own voice.
  // Off by default — a plain custom prompt keeps replacing the persona.
  stackPersona: boolean("stack_persona").default(false).notNull(),
  // Call-to-action button appended to the bottom of every published post for
  // this client (link to their main site / contact / registration page).
  ctaEnabled: boolean("cta_enabled").default(false).notNull(),
  ctaLabel: varchar("cta_label", { length: 80 }),
  ctaUrl: varchar("cta_url", { length: 1000 }),
  // Where the button appears: "bottom" | "top_bottom" | "top_middle_bottom".
  ctaPlacement: varchar("cta_placement", { length: 40 }).default("bottom"),
  // Preset CTA button color key (see cta-colors.ts). NULL = per-blog derived.
  ctaColor: varchar("cta_color", { length: 20 }),
  // Manual seed terms (newline/comma separated) fed to the keyword scraper
  // alongside the client's niche key-topics. See client_keywords.
  keywordSeeds: text("keyword_seeds"),
  // Peptides-only programmatic location pages: target locations (newline/comma
  // separated) + drip campaign controls. See peptide_location_targets.
  peptideLocations: text("peptide_locations"),
  // Optional global dosage list (newline/comma separated) for location pages.
  peptideDosages: text("peptide_dosages"),
  locationCampaignEnabled: boolean("location_campaign_enabled").default(false).notNull(),
  locationPagesPerDay: integer("location_pages_per_day").default(2).notNull(),
  // Mini registration form injected into posts. On submit it records the lead
  // and redirects the visitor to registrationRedirectUrl (the client's own
  // sign-up page). Placement: "top" | "bottom" | "top_bottom".
  registrationFormEnabled: boolean("registration_form_enabled").default(false).notNull(),
  registrationRedirectUrl: varchar("registration_redirect_url", { length: 1000 }),
  registrationFormPlacement: varchar("registration_form_placement", { length: 40 }).default("bottom"),
  // Post language control: "en" | "fr" | "en_fr" | null.
  //   en    → all posts English
  //   fr    → all posts French
  //   en_fr → posts alternate English / French (strict, per blog)
  //   null  → legacy derived behaviour (niche / TLD / vertical rules)
  // When set, overrides the hardcoded niche/TLD language locks.
  languageMode: varchar("language_mode", { length: 8 }),
  status: clientStatusEnum("status").default("onboarding"),
  // Opt-in to the cross-site ABC link-exchange network. Off by default.
  linkExchangeEnabled: boolean("link_exchange_enabled").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("clients_status_idx").on(table.status),
]);

// ─── 3. blogs ────────────────────────────────────────────────────────────────

export const blogs = pgTable("blogs", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  domain: varchar("domain", { length: 255 }).notNull(),
  platform: platformEnum("platform").default("wordpress").notNull(),
  wpUrl: varchar("wp_url", { length: 500 }),
  wpUsername: varchar("wp_username", { length: 255 }),
  wpAppPassword: varchar("wp_app_password", { length: 255 }),
  seoPlugin: seoPluginEnum("seo_plugin").default("none"),
  shopifyStoreUrl: varchar("shopify_store_url", { length: 500 }),
  shopifyAdminApiToken: varchar("shopify_admin_api_token", { length: 500 }),

  // Shopify auth & metadata
  shopifyAuthMode: shopifyAuthModeEnum("shopify_auth_mode").default("client_credentials"),
  shopifyClientId: varchar("shopify_client_id", { length: 255 }),
  shopifyClientSecret: varchar("shopify_client_secret", { length: 500 }),
  shopifyBlogHandle: varchar("shopify_blog_handle", { length: 255 }),
  shopifyGrantedScopes: text("shopify_granted_scopes"),

  // CANONICAL CADENCE. integer[7]; entry i = posts to publish on ISO weekday
  // i+1 (1 = Mon ... 7 = Sun), UTC. All-zeros = "not scheduled", which is an
  // alertable condition (see /api/notifications), never a silent skip.
  // The publisher and the verification cron both read THIS and nothing else.
  // See src/lib/posting-plan.ts and migration 0043_posting_plan.sql.
  postingPlan: integer("posting_plan")
    .array()
    .notNull()
    .default(sql`'{0,0,0,0,0,0,0}'::integer[]`),
  // -- LEGACY cadence columns. Superseded by postingPlan; retained only so a
  //    code rollback still has data to read. Dropped by migration 0044.
  //    Nothing may READ these any more.
  postingFrequency: varchar("posting_frequency", { length: 50 }),
  postingFrequencyDays: integer("posting_frequency_days").array(),
  postsPerDay: integer("posts_per_day"),
  postingIntervalHours: integer("posting_interval_hours"),
  lastPostVerifiedAt: timestamp("last_post_verified_at"),
  lastPostTitle: varchar("last_post_title", { length: 500 }),
  currentSeoScore: integer("current_seo_score"),
  lastSeoScanAt: timestamp("last_seo_scan_at"),
  status: blogStatusEnum("status").default("setup"),
  notesInternal: text("notes_internal"),
  // Deprecated per-blog custom generation prompt column. Custom prompts are now
  // client-wide only (see clients.customPrompt) — this column is retained for
  // back-compat but is no longer read or written by the app.
  customPrompt: text("custom_prompt"),
  // Local keyword-targeted content (see docs/local-keyword-content-plan.md).
  // city is the feature's on/off switch: null means this blog keeps the
  // ordinary ideateTopic flow. Assignment is manual — the domain is not a
  // reliable source of the city (pizzeriacrosta.ca carries none at all).
  city: varchar("city", { length: 120 }),
  region: varchar("region", { length: 120 }),
  countryCode: varchar("country_code", { length: 2 }),
  // Display name for this blog's own store, e.g. "Montreal Peptides". Null
  // falls back to a domain-derived label at read time.
  brandName: varchar("brand_name", { length: 160 }),
  // Shopify homepage SEO — pushed to the shop's global.title_tag /
  // global.description_tag metafields (same convention as article meta).
  // Null means "don't touch the shop's existing metafields."
  homepageMetaTitle: varchar("homepage_meta_title", { length: 70 }),
  homepageMetaDescription: varchar("homepage_meta_description", { length: 320 }),
  // ── Google Search Console (T04) ──
  // gscSiteUrl is the property identifier every Search Console call is made
  // with. Two shapes, decided by the verification method:
  //   "sc-domain:example.com"  Domain property   (DNS_TXT verified)
  //   "https://example.com/"   URL-prefix property (META verified)
  // Null until the property is verified AND registered via sites.add.
  gscSiteUrl: varchar("gsc_site_url", { length: 255 }),
  // "DNS_TXT" | "META". Chosen by platform — see gsc-verifier.methodForBlog.
  gscVerificationMethod: varchar("gsc_verification_method", { length: 16 }),
  // The token Google handed back. For DNS_TXT this IS the operator
  // deliverable (the TXT value to publish at the apex); for META it is the
  // full <meta> tag we wrote into the theme.
  gscVerificationToken: text("gsc_verification_token"),
  gscVerifiedAt: timestamp("gsc_verified_at"),
  gscSitemapSubmittedAt: timestamp("gsc_sitemap_submitted_at"),
  // Last successful searchanalytics pull. Drives the sync cron's ordering
  // (NULLS FIRST = never-synced blogs jump the queue) and lets the alert
  // distinguish "suppressed site" from "broken cron".
  gscLastSyncedAt: timestamp("gsc_last_synced_at"),
  // Stamped when the 16-month historical pull completed for this blog, so
  // the backfill mode can be re-run to completion without redoing work.
  gscBackfilledAt: timestamp("gsc_backfilled_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("blogs_domain_idx").on(table.domain),
  index("blogs_client_id_idx").on(table.clientId),
  index("blogs_status_idx").on(table.status),
  // Partial index: the sync cron's candidate query is
  //   status = 'active' AND gsc_verified_at IS NOT NULL
  // over the whole table, every run, on every shard.
  index("blogs_gsc_synced_idx").on(table.gscLastSyncedAt),
]);

// ─── 4. seo_scans ───────────────────────────────────────────────────────────

export const seoScans = pgTable("seo_scans", {
  id: uuid("id").defaultRandom().primaryKey(),
  blogId: uuid("blog_id").notNull().references(() => blogs.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  overallScore: integer("overall_score").notNull(),
  metaScore: integer("meta_score").notNull(),
  contentScore: integer("content_score").notNull(),
  technicalScore: integer("technical_score").notNull(),
  linkScore: integer("link_score").notNull(),
  imageScore: integer("image_score").notNull(),
  pagesCrawled: integer("pages_crawled").default(0),
  issuesFound: integer("issues_found").default(0),
  criticalIssues: integer("critical_issues").default(0),
  warnings: integer("warnings").default(0),
  notices: integer("notices").default(0),
  rawData: jsonb("raw_data"),
  scanDurationMs: integer("scan_duration_ms"),
  scannedAt: timestamp("scanned_at").defaultNow().notNull(),
}, (table) => [
  index("seo_scans_blog_id_idx").on(table.blogId),
  index("seo_scans_client_id_idx").on(table.clientId),
  index("seo_scans_scanned_at_idx").on(table.scannedAt),
]);

// ─── 5. seo_issues ──────────────────────────────────────────────────────────

export const seoIssues = pgTable("seo_issues", {
  id: uuid("id").defaultRandom().primaryKey(),
  scanId: uuid("scan_id").notNull().references(() => seoScans.id, { onDelete: "cascade" }),
  blogId: uuid("blog_id").notNull().references(() => blogs.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  pageUrl: varchar("page_url", { length: 1000 }),
  category: seoCategoryEnum("category").notNull(),
  severity: issueSeverityEnum("severity").notNull(),
  title: varchar("title", { length: 500 }).notNull(),
  description: text("description"),
  suggestedFix: text("suggested_fix"),
  fixPayload: jsonb("fix_payload"),
  status: issueStatusEnum("status").default("detected"),
  approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
  appliedAt: timestamp("applied_at"),
  verifiedAt: timestamp("verified_at"),
  failureReason: text("failure_reason"),
  autoFixable: boolean("auto_fixable").default(false),
  detectedAt: timestamp("detected_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),
}, (table) => [
  index("seo_issues_blog_id_idx").on(table.blogId),
  index("seo_issues_client_id_idx").on(table.clientId),
  index("seo_issues_status_idx").on(table.status),
  index("seo_issues_severity_idx").on(table.severity),
]);

// ─── 6. post_verifications ──────────────────────────────────────────────────

export const postVerifications = pgTable("post_verifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  blogId: uuid("blog_id").notNull().references(() => blogs.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  checkType: checkTypeEnum("check_type").default("scheduled"),
  latestPostDate: timestamp("latest_post_date"),
  latestPostTitle: varchar("latest_post_title", { length: 500 }),
  latestPostUrl: varchar("latest_post_url", { length: 1000 }),
  postsInPeriod: integer("posts_in_period").default(0),
  expectedPosts: integer("expected_posts").default(0),
  onSchedule: boolean("on_schedule").default(true),
  daysSinceLastPost: integer("days_since_last_post"),
  alertTriggered: boolean("alert_triggered").default(false),
  checkedAt: timestamp("checked_at").defaultNow().notNull(),
}, (table) => [
  index("post_verifications_blog_id_idx").on(table.blogId),
  index("post_verifications_client_id_idx").on(table.clientId),
]);

// ─── 8. messages ─────────────────────────────────────────────────────────────

export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  senderId: uuid("sender_id").references(() => users.id, { onDelete: "set null" }),
  senderRole: senderRoleEnum("sender_role").notNull(),
  content: text("content").notNull(),
  isInternal: boolean("is_internal").default(false),
  attachments: jsonb("attachments"),
  readByClient: boolean("read_by_client").default(false),
  readByAdmin: boolean("read_by_admin").default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("messages_client_id_idx").on(table.clientId),
  index("messages_sender_id_idx").on(table.senderId),
]);

// ─── 9. reports ──────────────────────────────────────────────────────────────

export const reports = pgTable("reports", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  title: varchar("title", { length: 255 }),
  summaryHtml: text("summary_html"),
  overallSeoTrend: seoTrendEnum("overall_seo_trend"),
  avgSeoScore: integer("avg_seo_score"),
  totalPostsPublished: integer("total_posts_published"),
  totalIssuesFixed: integer("total_issues_fixed"),
  blogsOnSchedule: integer("blogs_on_schedule"),
  blogsOffSchedule: integer("blogs_off_schedule"),
  // Generation cost (text + images) for posts created during the report's
  // period. Computed at report-generation time; null on reports generated
  // before this column existed.
  totalCostUsd: decimal("total_cost_usd", { precision: 10, scale: 6 }),
  highlights: jsonb("highlights"),
  concerns: jsonb("concerns"),
  rawData: jsonb("raw_data"),
  visibleToClient: boolean("visible_to_client").default(false),
  generatedAt: timestamp("generated_at").defaultNow().notNull(),
  publishedAt: timestamp("published_at"),
}, (table) => [
  index("reports_client_id_idx").on(table.clientId),
]);

// ─── 11. seo_third_party_data ───────────────────────────────────────────────

export const seoThirdPartyData = pgTable("seo_third_party_data", {
  id: uuid("id").defaultRandom().primaryKey(),
  blogId: uuid("blog_id").notNull().references(() => blogs.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  source: thirdPartySourceEnum("source").notNull(),
  domainAuthority: integer("domain_authority"),
  backlinksTotal: integer("backlinks_total"),
  referringDomains: integer("referring_domains"),
  organicKeywords: integer("organic_keywords"),
  organicTrafficEst: integer("organic_traffic_est"),
  topKeywords: jsonb("top_keywords"),
  rawResponse: jsonb("raw_response"),
  fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
}, (table) => [
  index("seo_third_party_blog_id_idx").on(table.blogId),
  index("seo_third_party_client_id_idx").on(table.clientId),
]);

// ─── generated_posts ────────────────────────────────────────────────────────

export const generatedPosts = pgTable("generated_posts", {
  id: uuid("id").defaultRandom().primaryKey(),
  blogId: uuid("blog_id").notNull().references(() => blogs.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  topic: varchar("topic", { length: 500 }).notNull(),
  keywords: jsonb("keywords"),
  title: varchar("title", { length: 500 }),
  body: text("body"),
  excerpt: text("excerpt"),
  metaTitle: varchar("meta_title", { length: 255 }),
  metaDescription: text("meta_description"),
  featuredImageUrl: text("featured_image_url"),
  // Second image — a deliberately differently-framed shot of the same
  // topic, embedded into the body HTML at roughly the midpoint by
  // content-generator.ts. Stored separately from featuredImageUrl so
  // we can reuse it (e.g. for social cards) without re-extracting from
  // the body. Always a data: URI when present.
  bodyImageUrl: text("body_image_url"),
  wordCount: integer("word_count"),
  seoScore: integer("seo_score"),
  readabilityScore: integer("readability_score"),
  brandVoiceScore: integer("brand_voice_score"),
  tokensUsed: integer("tokens_used"),
  costUsd: decimal("cost_usd", { precision: 10, scale: 6 }),
  status: generatedPostStatusEnum("status").default("pending").notNull(),
  // Concrete language this post was written in ("en" | "fr"), recorded at
  // generation time. Drives strict EN/FR alternation for bilingual clients
  // (flip the blog's most recent post language) and serves as an audit trail.
  language: varchar("language", { length: 2 }),
  failureReason: text("failure_reason"),
  externalPostId: varchar("external_post_id", { length: 100 }),
  externalPostUrl: varchar("external_post_url", { length: 1000 }),
  isAutoGenerated: boolean("is_auto_generated").default(false),
  // Scrubber audit trail. Shape mirrors ScrubberReport in
  // src/lib/content/scrubber/types.ts; jsonb so we can GROUP BY violation
  // kinds without locking the report shape in DDL.
  scrubberReport: jsonb("scrubber_report"),
  flaggedForReview: boolean("flagged_for_review").default(false).notNull(),
  // ── Semantic linking (pgvector) ──
  // Dense embedding of title + sanitized body, used for cosine-similarity
  // "related posts" linking. text-embedding-3-small → 1536 dims. Null until
  // the post has been embedded (see semantic-linking service).
  embedding: vector("embedding", { dimensions: 1536 }),
  // Which model produced `embedding` — lets us re-embed only stale rows if we
  // ever change models/dimensions.
  embeddingModel: varchar("embedding_model", { length: 64 }),
  embeddedAt: timestamp("embedded_at"),
  // Sparse (full-text) half of the hybrid linking score. Maintained in app
  // code from the same sanitized title+body we embed. See semantic-linking.
  searchTsv: tsvector("search_tsv"),
  // The related posts most recently linked into this post, as
  // [{ id, title, url }]. Mirrors what was written into the live body block
  // and the Shopify custom.netgrid_related_posts metafield.
  relatedPosts: jsonb("related_posts"),
  relatedLinkedAt: timestamp("related_linked_at"),
  generatedAt: timestamp("generated_at"),
  publishedAt: timestamp("published_at"),
  // ── Auto-publish idempotency (T08) ──
  // publishDay is the UTC calendar day this row CLAIMS a publishing slot
  // on, as 'YYYY-MM-DD' (Drizzle maps a Postgres `date` to a string — same
  // convention as reports.periodStart). daySlot is which slot inside that
  // day, 0-based: a blog configured "2x per day" legitimately claims slots
  // 0 and 1 (see parsePostsPerDay / isBlogDueForPost).
  //
  // Written ONLY by the auto-publish path (runGenerateAndPublish with
  // isAutoGenerated). Manual generation from the admin UI leaves both null,
  // and NULLs never collide in a unique index, so an operator can always
  // add an extra post by hand. Every pre-T08 row is null too, which is why
  // the unique index below can be created against a history that already
  // contains same-day duplicates.
  publishDay: date("publish_day"),
  daySlot: integer("day_slot"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("generated_posts_blog_id_idx").on(table.blogId),
  index("generated_posts_client_id_idx").on(table.clientId),
  index("generated_posts_status_idx").on(table.status),
  index("generated_posts_created_at_idx").on(table.createdAt),
  // THE idempotency guard. At most one row may occupy a given
  // (blog, UTC day, slot) while it is in flight or live. A row that fails
  // drops out of the predicate and frees its slot for a retry; 'generated'
  // (written but the platform publish failed) is also outside the
  // predicate, so a failed publish does not burn the day. This is what
  // makes /api/cron/auto-publish safe to invoke twice.
  uniqueIndex("generated_posts_blog_day_slot_uniq")
    .on(table.blogId, table.publishDay, table.daySlot)
    .where(sql`${table.status} in ('generating', 'publishing', 'published')`),
  // Drives the stuck-row reaper (reapStuckPublishes).
  index("generated_posts_inflight_idx")
    .on(table.status, table.updatedAt)
    .where(sql`${table.status} in ('generating', 'publishing')`),
]);

// ─── style_profiles ─────────────────────────────────────────────────────────
// One per blog. Built by the 14-phase assignment algorithm at blog creation.
// Locked after assignment — never re-rolled automatically. Field IDs reference
// the library files in src/lib/content/libraries/*.

export const styleProfiles = pgTable("style_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  blogId: uuid("blog_id")
    .notNull()
    .references(() => blogs.id, { onDelete: "cascade" })
    .unique(),
  // Future-proofing for non-peptide expansions. Currently always "peptides".
  nicheKey: varchar("niche_key", { length: 64 }).notNull().default("peptides"),

  // Locked stylistic core (referencing the libraries by integer ID)
  subNicheId: integer("sub_niche_id").notNull(),
  voiceId: integer("voice_id").notNull(),
  skeletonId: integer("skeleton_id").notNull(),
  cadenceId: integer("cadence_id").notNull(),
  quirks: integer("quirks").array().notNull(),
  schemaId: integer("schema_id").notNull(),
  tagSetId: integer("tag_set_id").notNull(),
  citationStyleId: integer("citation_style_id").notNull(),

  // Per-post draws
  structuralPool: integer("structural_pool").array().notNull(),

  // Compliance
  compliancePhraseIds: integer("compliance_phrase_ids").array().notNull(),
  compliancePlacement: compliancePlacementEnum("compliance_placement").notNull(),

  // Operational
  wordBandMin: integer("word_band_min").notNull(),
  wordBandMax: integer("word_band_max").notNull(),
  scrubberStrictness: scrubberStrictnessEnum("scrubber_strictness")
    .notNull()
    .default("standard"),

  // Niche content
  primaryCompounds: text("primary_compounds").array().notNull(),
  secondaryCompounds: text("secondary_compounds").array().notNull(),

  // Audit
  assignmentSeed: varchar("assignment_seed", { length: 64 }),
  // Hamming distance from the closest existing profile at the moment
  // this profile was assigned. Computed as sum of integer single-valued
  // mismatches (0-8) + 3 Jaccard distances (0.0-1.0 each), so the
  // realistic range is 0.00-11.00. Stored as decimal because Jaccard
  // produces fractional values (e.g. 9.55 means 8 single-valued
  // mismatches + ~1.55 fractional set-distance).
  minHammingAtAssign: decimal("min_hamming_at_assign", { precision: 5, scale: 2 }),
  // Phase 3: optional LLM-generated per-blog persona. Shape mirrors
  // GeneratedPersona in src/lib/content/persona-generator.ts. When present,
  // composeForPost uses it for the voice slots instead of the library voice —
  // a unique generated voice per blog. Null → use the library voiceId
  // (behavior unchanged). generatedPersonaSeed keeps the operator's seed inputs
  // so the persona can be regenerated with the same direction.
  generatedPersona: jsonb("generated_persona"),
  generatedPersonaSeed: text("generated_persona_seed"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("style_profiles_blog_id_idx").on(table.blogId),
  index("style_profiles_sub_niche_idx").on(table.subNicheId),
  index("style_profiles_voice_idx").on(table.voiceId),
]);

// ─── 11b. niche_profiles ────────────────────────────────────────────────────
// Auto-generated niche definitions for client niches NOT hardcoded in
// src/lib/content/libraries/niches.ts. Created once (LLM) when a client with a
// new niche is added, cached in memory at runtime, and reused like the
// built-in niches. `key` is the normalized niche key (e.g. "restaurant").
export const nicheProfiles = pgTable("niche_profiles", {
  key: varchar("key", { length: 80 }).primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  audience: text("audience").notNull(),
  brandVoice: text("brand_voice").notNull(),
  contentStyle: text("content_style").notNull(),
  requirements: text("requirements").notNull(),
  keyTopics: text("key_topics").array().notNull(),
  primaryTerms: text("primary_terms").array().notNull(),
  adjacentTerms: text("adjacent_terms").array().notNull(),
  source: varchar("source", { length: 24 }).notNull().default("generated"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── 12. activity_log ───────────────────────────────────────────────────────

export const activityLog = pgTable("activity_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
  action: varchar("action", { length: 100 }).notNull(),
  entityType: varchar("entity_type", { length: 50 }),
  entityId: uuid("entity_id"),
  details: jsonb("details"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("activity_log_user_id_idx").on(table.userId),
  index("activity_log_client_id_idx").on(table.clientId),
  index("activity_log_created_at_idx").on(table.createdAt),
]);

// ─── cron_runs ──────────────────────────────────────────────────────────────
//
// One row per cron invocation (T22). This is the durable replacement for
// returning AutoPublishResult to a curl: the counters land here whether or
// not anyone reads the HTTP response, and they survive container restarts.
//
// Deliberately NOT foreign-keyed (same convention as link_events, see
// migrations/0026_link_events.sql) — a telemetry write must never fail
// because a blog or client row moved underneath it.
export const cronRuns = pgTable("cron_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** Job name, e.g. "auto-publish", "post-verification", "alerts". */
  job: varchar("job", { length: 64 }).notNull(),
  /** 0-based shard index, or null when the job is not sharded. */
  shardIndex: integer("shard_index"),
  shardCount: integer("shard_count"),
  startedAt: timestamp("started_at").notNull(),
  finishedAt: timestamp("finished_at").defaultNow().notNull(),
  durationMs: integer("duration_ms").notNull(),
  /** false when the run body threw. */
  ok: boolean("ok").default(true).notNull(),
  /** RunCounters — see src/lib/services/run-telemetry.ts. jsonb so the
   * counter set can grow without a migration. */
  counters: jsonb("counters").notNull(),
  /** Total pipeline_errors recorded during this run (including any
   * dropped past the in-memory buffer cap). */
  errorCount: integer("error_count").default(0).notNull(),
  /** First 25 errors inline, so the run row alone is readable. */
  errorSample: jsonb("error_sample"),
  fatalError: text("fatal_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("cron_runs_job_started_idx").on(table.job, table.startedAt),
  index("cron_runs_started_at_idx").on(table.startedAt),
]);

// ─── pipeline_errors ────────────────────────────────────────────────────────
//
// One row per typed failure. Replaces the ~131 console.warn/console.error
// dead-ends. Normalised (rather than only living inside cron_runs.errors)
// so "how many META_WRITE_FAILED across how many distinct blogs in the
// last 24h" is one indexed query, and so failures outside a cron run
// (manual Generate now, /r/ redirect, webhook) are captured too.
export const pipelineErrors = pgTable("pipeline_errors", {
  id: uuid("id").defaultRandom().primaryKey(),
  /** cron_runs.id when inside a run; null for ad-hoc failures. */
  runId: uuid("run_id"),
  job: varchar("job", { length: 64 }).notNull(),
  /** Code location, e.g. "content-generator.images". */
  site: varchar("site", { length: 64 }).notNull(),
  /** PipelineErrorCode — see run-telemetry.ts. */
  code: varchar("code", { length: 64 }).notNull(),
  /** "warn" | "error" | "fatal". */
  severity: varchar("severity", { length: 16 }).default("error").notNull(),
  blogId: uuid("blog_id"),
  clientId: uuid("client_id"),
  postId: uuid("post_id"),
  message: text("message").notNull(),
  context: jsonb("context"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("pipeline_errors_created_at_idx").on(table.createdAt),
  index("pipeline_errors_code_created_idx").on(table.code, table.createdAt),
  index("pipeline_errors_blog_id_idx").on(table.blogId),
  index("pipeline_errors_run_id_idx").on(table.runId),
]);

// ─── alert_log / alert_suppression ──────────────────────────────────────────
//
// alert_log is the audit trail of everything the alerter tried to send
// (including delivery failures). alert_suppression is the per-key cooldown
// claim: alert_key is the PRIMARY KEY, so the conditional upsert in
// pipeline-alerts.ts is atomic across the four concurrently-running
// auto-publish shards without needing a transaction (the neon-http driver
// has none).
export const alertLog = pgTable("alert_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  alertKey: varchar("alert_key", { length: 160 }).notNull(),
  severity: varchar("severity", { length: 16 }).notNull(),
  subject: varchar("subject", { length: 300 }).notNull(),
  body: text("body").notNull(),
  delivered: boolean("delivered").default(false).notNull(),
  deliveryError: text("delivery_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("alert_log_key_created_idx").on(table.alertKey, table.createdAt),
  index("alert_log_created_idx").on(table.createdAt),
]);

export const alertSuppression = pgTable("alert_suppression", {
  alertKey: varchar("alert_key", { length: 160 }).primaryKey(),
  suppressedUntil: timestamp("suppressed_until").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── news_items ─────────────────────────────────────────────────────────────
//
// Cached headlines fetched from Google News RSS (and optional NewsAPI /
// GNews fallbacks) keyed by vertical. The auto-publish ideation step
// reads recent rows for the blog's vertical so Claude can brainstorm
// topics tied to current local/international news instead of cold.
//
// Rows are immutable: the refresh cron upserts on (verticalKey, link)
// so duplicates from multiple queries on the same vertical collapse.

export const newsItems = pgTable("news_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  verticalKey: varchar("vertical_key", { length: 64 }).notNull(),
  // The query string that surfaced this item (one vertical may run
  // several queries — one per topic angle / location). Useful for
  // attribution and for skipping stale queries during re-fetch.
  query: varchar("query", { length: 256 }).notNull(),
  // Source label: "google_news_rss" | "newsapi" | "gnews".
  source: varchar("source", { length: 32 }).notNull(),
  // Publisher (e.g. "CBC News", "Le Devoir"). Optional — RSS sometimes
  // omits it.
  publisher: varchar("publisher", { length: 128 }),
  title: varchar("title", { length: 512 }).notNull(),
  link: varchar("link", { length: 1024 }).notNull(),
  snippet: text("snippet"),
  language: varchar("language", { length: 8 }),
  country: varchar("country", { length: 8 }),
  publishedAt: timestamp("published_at"),
  fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
  // True once the row has been surfaced to an ideation prompt —
  // optional dedupe signal so the same headline doesn't seed
  // back-to-back topics on the same blog.
  usedInIdeation: boolean("used_in_ideation").default(false).notNull(),
  raw: jsonb("raw"),
}, (table) => [
  index("news_items_vertical_idx").on(table.verticalKey),
  index("news_items_fetched_at_idx").on(table.fetchedAt),
  index("news_items_published_at_idx").on(table.publishedAt),
  uniqueIndex("news_items_vertical_link_uk").on(table.verticalKey, table.link),
]);

// ─── knowledge_documents ──────────────────────────────────────────────────────
//
// Per-client Knowledge Base. The team uploads briefs, keyword sheets, brand
// guides, etc.; each file is normalised to Markdown at upload time (see
// services/knowledge-converter.ts) and run through a one-time extraction pass
// (services/knowledge-extractor.ts) that distills keywords, topics, and a
// summary. Ideation and generation later read the active rows for a blog/client
// so Claude works from the client's actual material instead of generic niche
// keyword lists.
//
// blogId is nullable: when set, the document is scoped to a single blog; when
// null it applies to the whole client (shared across all its blogs).

export const knowledgeDocuments = pgTable("knowledge_documents", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  blogId: uuid("blog_id").references(() => blogs.id, { onDelete: "cascade" }),
  fileName: varchar("file_name", { length: 500 }).notNull(),
  contentType: varchar("content_type", { length: 150 }),
  sourceType: knowledgeSourceTypeEnum("source_type").notNull(),
  // Normalised Markdown body — the canonical form fed to Claude.
  markdown: text("markdown").notNull(),
  charCount: integer("char_count").notNull().default(0),
  // True when extraction produced suspiciously little text (e.g. a scanned
  // PDF with no text layer) — surfaced for manual review.
  lowConfidence: boolean("low_confidence").notNull().default(false),
  warnings: jsonb("warnings"), // string[] of non-fatal conversion notes
  // Distilled knowledge from the one-time extraction pass.
  extractedKeywords: jsonb("extracted_keywords"), // string[]
  extractedTopics: jsonb("extracted_topics"), // string[]
  summary: text("summary"),
  extractionStatus: knowledgeExtractionStatusEnum("extraction_status")
    .notNull()
    .default("pending"),
  extractionError: text("extraction_error"),
  // Whether this document should be consulted during ideation/generation.
  isActive: boolean("is_active").notNull().default(true),
  uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("knowledge_documents_client_id_idx").on(table.clientId),
  index("knowledge_documents_blog_id_idx").on(table.blogId),
  index("knowledge_documents_active_idx").on(table.isActive),
]);

// ─── niches ───────────────────────────────────────────────────────────────────
//
// The editable, per-niche generation config. Phase 0 of the content-config
// rebuild: these rows are SEEDED from the currently-hardcoded niche rules in
// content-generator.ts (NICHE_CONTEXTS + getNicheRequirements) so ops can review
// and edit them in the admin "Niches" screen. Generation still reads the code
// path in Phase 0 — this table is a shadow copy until the composer is switched
// over to read from it.
//
// `key` matches normalizeNicheKey() output (e.g. "peptides", "tax_lawyer"), so a
// blog's free-text clients.niche resolves to a row by the same normalization.

export const niches = pgTable("niches", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: varchar("key", { length: 100 }).notNull().unique(),
  label: varchar("label", { length: 255 }).notNull(),
  industry: varchar("industry", { length: 255 }).notNull(),
  defaultAudience: text("default_audience"),
  defaultBrandVoice: text("default_brand_voice"),
  // The long "contentStyle" directive (voice/approach) that goes into the prompt.
  contentStyle: text("content_style"),
  // string[] — topical anchors used by ideation + generation.
  keyTopics: jsonb("key_topics"),
  // The per-niche writing-requirements block (getNicheRequirements).
  requirements: text("requirements"),
  // string[] — compliance/legal disclaimers (locked layer; mostly empty at seed
  // time since today's disclaimers live in the peptide/gambling phrase library).
  disclaimers: jsonb("disclaimers"),
  // Optional niche-level word-count override (per-blog band still wins today).
  wordBandMin: integer("word_band_min"),
  wordBandMax: integer("word_band_max"),
  // Provenance: "seed" = mirrored from code, "manual" = hand-edited in the UI,
  // "imported" = extracted from an uploaded file (Phase 2). Lets re-sync skip
  // hand-edited rows so it never clobbers ops changes.
  source: varchar("source", { length: 20 }).notNull().default("seed"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("niches_key_idx").on(table.key),
]);

// ─── client_keywords ──────────────────────────────────────────────────────────
//
// Auto-scraped keyword sets bound to a client's content generation. Discovered
// per client from the client's niche key-topics + manual seeds (see
// keyword-scraper.ts). When active, the top-ranked keywords are merged into the
// ideation keyword pool so every generated post targets them.
//
// searchVolume / cpc are nullable — Google Autocomplete supplies neither, but
// the columns keep the store ready for volume-bearing providers so ranking can
// use real volume without a schema change. For volume-less sources, hitCount
// (how many seed queries surfaced the term) + bestPosition act as the ranking
// proxy.

export const clientKeywords = pgTable("client_keywords", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  keyword: varchar("keyword", { length: 200 }).notNull(),
  searchVolume: integer("search_volume"),
  cpc: decimal("cpc", { precision: 10, scale: 2 }),
  source: varchar("source", { length: 32 }).notNull().default("google_autocomplete"),
  hitCount: integer("hit_count").notNull().default(1),
  bestPosition: integer("best_position"),
  isActive: boolean("is_active").notNull().default(true),
  fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
  // DataForSEO fields — nullable, populated only for source='dataforseo' rows.
  // Autocomplete rows never touch these. See migrations/0037.
  keywordDifficulty: integer("keyword_difficulty"),
  competition: decimal("competition", { precision: 6, scale: 4 }),
  lowTopOfPageBid: decimal("low_top_of_page_bid", { precision: 10, scale: 2 }),
  highTopOfPageBid: decimal("high_top_of_page_bid", { precision: 10, scale: 2 }),
  monthlySearches: jsonb("monthly_searches"),
  mainIntent: varchar("main_intent", { length: 32 }),
  locationCode: integer("location_code"),
  raw: jsonb("raw"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("client_keywords_client_keyword_idx").on(table.clientId, table.keyword),
  index("client_keywords_client_active_idx").on(table.clientId, table.isActive),
]);

// ─── dataforseo_runs ────────────────────────────────────────────────────────
//
// One row per (client, seed) DataForSEO pull — cost tracking and debugging,
// kept separate from the keyword data itself (which lands in client_keywords
// above). A run's cost is real money, unlike the free Autocomplete scrape.

export const dataforseoRuns = pgTable("dataforseo_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  seed: varchar("seed", { length: 200 }).notNull(),
  endpoint: varchar("endpoint", { length: 120 }).notNull(),
  locationCode: integer("location_code").notNull(),
  languageCode: varchar("language_code", { length: 16 }).notNull(),
  status: dataforseoRunStatusEnum("status").notNull().default("pending"),
  itemsReturned: integer("items_returned").notNull().default(0),
  cost: decimal("cost", { precision: 10, scale: 4 }),
  error: text("error"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  finishedAt: timestamp("finished_at"),
}, (table) => [
  index("dataforseo_runs_client_idx").on(table.clientId, table.startedAt),
]);

// ─── peptide_location_targets ─────────────────────────────────────────────────
//
// Peptides-only programmatic long-tail location pages. One row = one
// (blog compound × client location) page. A campaign builds the matrix as
// "pending" rows; a daily drip cron generates up to the client's
// locationPagesPerDay per blog as full unique articles through the normal
// generator, so aggressive coverage rolls out slowly rather than as a burst of
// thin doorway pages.

export const peptideLocationTargets = pgTable("peptide_location_targets", {
  id: uuid("id").defaultRandom().primaryKey(),
  blogId: uuid("blog_id")
    .notNull()
    .references(() => blogs.id, { onDelete: "cascade" }),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  compound: varchar("compound", { length: 120 }).notNull(),
  location: varchar("location", { length: 160 }).notNull(),
  // Optional dosage ('' = none). Part of the uniqueness key.
  dosage: varchar("dosage", { length: 40 }).notNull().default(""),
  // Templated title used as the generation topic (query-targeted).
  title: varchar("title", { length: 500 }).notNull(),
  // "pending" | "generated" | "failed"
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  generatedPostId: uuid("generated_post_id").references(() => generatedPosts.id, {
    onDelete: "set null",
  }),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  generatedAt: timestamp("generated_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("peptide_location_targets_unique_idx").on(
    table.blogId,
    table.compound,
    table.dosage,
    table.location,
  ),
  index("peptide_location_targets_blog_status_idx").on(table.blogId, table.status),
  index("peptide_location_targets_client_idx").on(table.clientId),
]);

// ─── blog_keyword_targets ──────────────────────────────────────────────────────
//
// Local keyword-targeted content ledger. One row = one candidate "[keyword] in
// [city]" post for a blog — pairing the blog's assigned city (blogs.city) with
// one of its own scraped keywords (client_keywords). Built by
// buildKeywordTargetsForBlog() whenever the blog has a city; claimed by
// runAutoPublishCron in priority order, one claim per due blog per run. See
// docs/local-keyword-content-plan.md.
//
// Niche-agnostic and strictly additive: a blog with no city never gets rows
// here and keeps today's ideateTopic flow untouched. Same shape as
// peptide_location_targets (which this table eventually unifies with), except
// keyed on a real scraped keyword instead of a client-picked compound.

export const blogKeywordTargets = pgTable("blog_keyword_targets", {
  id: uuid("id").defaultRandom().primaryKey(),
  blogId: uuid("blog_id")
    .notNull()
    .references(() => blogs.id, { onDelete: "cascade" }),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  keyword: varchar("keyword", { length: 255 }).notNull(),
  // Snapshot of blogs.city at build time — kept even if the blog's city is
  // later reassigned, so historical rows still describe what was targeted.
  city: varchar("city", { length: 120 }).notNull(),
  topicTitle: varchar("topic_title", { length: 500 }).notNull(),
  status: keywordTargetStatusEnum("status").notNull().default("pending"),
  // Rank snapshot at build time (lower = higher priority). Real search
  // volume once the DataForSEO corpus lands; the Autocomplete popularity
  // proxy (hitCount/bestPosition ordering) until then.
  priority: integer("priority").notNull().default(0),
  keywordSource: varchar("keyword_source", { length: 32 }).notNull().default("google_autocomplete"),
  searchVolume: integer("search_volume"),
  generatedPostId: uuid("generated_post_id").references(() => generatedPosts.id, {
    onDelete: "set null",
  }),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  generatedAt: timestamp("generated_at"),
}, (table) => [
  uniqueIndex("blog_keyword_targets_unique_idx").on(table.blogId, table.keyword, table.city),
  index("blog_keyword_targets_blog_status_priority_idx").on(table.blogId, table.status, table.priority),
  index("blog_keyword_targets_client_idx").on(table.clientId),
]);

// ─── registration_leads ───────────────────────────────────────────────────────
//
// Leads captured by the per-client mini registration form injected into posts.
// The form POSTs to /api/register/{blogId}, which stores a row here and then
// redirects the visitor to the client's own registration page.

export const registrationLeads = pgTable("registration_leads", {
  id: uuid("id").defaultRandom().primaryKey(),
  clientId: uuid("client_id")
    .notNull()
    .references(() => clients.id, { onDelete: "cascade" }),
  blogId: uuid("blog_id").references(() => blogs.id, { onDelete: "set null" }),
  postId: uuid("post_id").references(() => generatedPosts.id, { onDelete: "set null" }),
  name: varchar("name", { length: 255 }),
  location: varchar("location", { length: 255 }),
  email: varchar("email", { length: 320 }),
  referrer: varchar("referrer", { length: 2000 }),
  userAgent: varchar("user_agent", { length: 1000 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("registration_leads_client_created_idx").on(table.clientId, table.createdAt),
  index("registration_leads_blog_idx").on(table.blogId),
]);

// ─── Relations ──────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ one }) => ({
  client: one(clients, { fields: [users.clientId], references: [clients.id] }),
}));

export const clientsRelations = relations(clients, ({ many }) => ({
  blogs: many(blogs),
  users: many(users),
  messages: many(messages),
  reports: many(reports),
  activityLogs: many(activityLog),
  knowledgeDocuments: many(knowledgeDocuments),
}));

export const blogsRelations = relations(blogs, ({ one, many }) => ({
  client: one(clients, { fields: [blogs.clientId], references: [clients.id] }),
  seoScans: many(seoScans),
  seoIssues: many(seoIssues),
  postVerifications: many(postVerifications),
  thirdPartyData: many(seoThirdPartyData),
  generatedPosts: many(generatedPosts),
  knowledgeDocuments: many(knowledgeDocuments),
  styleProfile: one(styleProfiles, {
    fields: [blogs.id],
    references: [styleProfiles.blogId],
  }),
}));

export const styleProfilesRelations = relations(styleProfiles, ({ one }) => ({
  blog: one(blogs, { fields: [styleProfiles.blogId], references: [blogs.id] }),
}));

export const knowledgeDocumentsRelations = relations(knowledgeDocuments, ({ one }) => ({
  client: one(clients, { fields: [knowledgeDocuments.clientId], references: [clients.id] }),
  blog: one(blogs, { fields: [knowledgeDocuments.blogId], references: [blogs.id] }),
  uploadedByUser: one(users, { fields: [knowledgeDocuments.uploadedBy], references: [users.id] }),
}));

export const generatedPostsRelations = relations(generatedPosts, ({ one }) => ({
  blog: one(blogs, { fields: [generatedPosts.blogId], references: [blogs.id] }),
  client: one(clients, { fields: [generatedPosts.clientId], references: [clients.id] }),
}));

export const seoScansRelations = relations(seoScans, ({ one, many }) => ({
  blog: one(blogs, { fields: [seoScans.blogId], references: [blogs.id] }),
  client: one(clients, { fields: [seoScans.clientId], references: [clients.id] }),
  issues: many(seoIssues),
}));

export const seoIssuesRelations = relations(seoIssues, ({ one }) => ({
  scan: one(seoScans, { fields: [seoIssues.scanId], references: [seoScans.id] }),
  blog: one(blogs, { fields: [seoIssues.blogId], references: [blogs.id] }),
  client: one(clients, { fields: [seoIssues.clientId], references: [clients.id] }),
  approvedByUser: one(users, { fields: [seoIssues.approvedBy], references: [users.id] }),
}));

export const postVerificationsRelations = relations(postVerifications, ({ one }) => ({
  blog: one(blogs, { fields: [postVerifications.blogId], references: [blogs.id] }),
  client: one(clients, { fields: [postVerifications.clientId], references: [clients.id] }),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  client: one(clients, { fields: [messages.clientId], references: [clients.id] }),
  sender: one(users, { fields: [messages.senderId], references: [users.id] }),
}));

export const reportsRelations = relations(reports, ({ one }) => ({
  client: one(clients, { fields: [reports.clientId], references: [clients.id] }),
}));

export const seoThirdPartyDataRelations = relations(seoThirdPartyData, ({ one }) => ({
  blog: one(blogs, { fields: [seoThirdPartyData.blogId], references: [blogs.id] }),
  client: one(clients, { fields: [seoThirdPartyData.clientId], references: [clients.id] }),
}));

export const activityLogRelations = relations(activityLog, ({ one }) => ({
  user: one(users, { fields: [activityLog.userId], references: [users.id] }),
  client: one(clients, { fields: [activityLog.clientId], references: [clients.id] }),
}));

// ─── app_settings ────────────────────────────────────────────────────────────
// Operator-global key/value settings (e.g. which model powers content
// generation vs SEO fixes). One row per key; values are stored as text and
// parsed by typed getters in @/lib/settings/app-settings.
export const appSettings = pgTable("app_settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── link_events ─────────────────────────────────────────────────────────────
// Append-only traffic log for netgrid-tracked links on published posts:
//   type "view"      → a tracking-pixel hit (page view)
//   type "cta_click" → the CTA redirect (/r/{postId}) was followed
// Not FK-constrained so the log survives post/blog deletion. Ids are stored
// loosely (nullable) for the same reason.
// ─── link_exchange_loops / link_exchange_edges ──────────────────────────────
// RETIRED (T03). Read-only history of the link-exchange scheme. A "loop" row
// was one client's FULL MESH (every site linking to every other site it owns —
// NOT the ABC cycle the original comment described); each edge is one directed
// link with its anchor and placement record.
// Statuses now in use: "pending" (legacy), "placed", "failed",
//   "disabled" (never placed, terminated by migration 0041),
//   "removed"  (was live, stripped by the removal job).
export const linkExchangeLoops = pgTable("link_exchange_loops", {
  id: uuid("id").defaultRandom().primaryKey(),
  // One loop per client — the client's full mesh of interlinked sites.
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
  niche: varchar("niche", { length: 255 }),
  size: integer("size").default(3).notNull(),
  status: varchar("status", { length: 16 }).default("active").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("link_exchange_loops_status_idx").on(table.status),
  index("link_exchange_loops_client_idx").on(table.clientId),
]);

export const linkExchangeEdges = pgTable("link_exchange_edges", {
  id: uuid("id").defaultRandom().primaryKey(),
  loopId: uuid("loop_id").notNull().references(() => linkExchangeLoops.id, { onDelete: "cascade" }),
  sourceBlogId: uuid("source_blog_id").notNull().references(() => blogs.id, { onDelete: "cascade" }),
  targetBlogId: uuid("target_blog_id").notNull().references(() => blogs.id, { onDelete: "cascade" }),
  position: integer("position").default(0).notNull(),
  anchorText: varchar("anchor_text", { length: 255 }).notNull(),
  // "branded" | "naked" | "generic" | "partial" | "exact"
  anchorType: varchar("anchor_type", { length: 16 }).notNull(),
  targetUrl: varchar("target_url", { length: 1000 }),
  // "pending" | "placed" | "failed"
  status: varchar("status", { length: 16 }).default("pending").notNull(),
  placedInPostId: uuid("placed_in_post_id").references(() => generatedPosts.id, { onDelete: "set null" }),
  placedAt: timestamp("placed_at"),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("link_exchange_edges_pair_idx").on(table.sourceBlogId, table.targetBlogId),
  index("link_exchange_edges_loop_idx").on(table.loopId),
  index("link_exchange_edges_status_idx").on(table.status),
  index("link_exchange_edges_source_idx").on(table.sourceBlogId),
]);

// ─── link_exchange_removals ─────────────────────────────────────────────────
// Durable work queue for the T03 link-exchange teardown. One row per published
// post that must be checked for a `data-nx-exch` link left behind by the
// retired exchange. All progress lives here rather than in memory, so the
// removal job is restartable, idempotent and observable in SQL.
//
//   priority 0 → a placed edge points at this post: it is known to carry a link
//   priority 1 → swept in because its blog ever hosted an exchange link
//   status     → "pending" | "clean" | "removed" | "failed"
//
// previous_body holds the exact live body as it was BEFORE the strip, so a
// single post can be restored (see restoreRemovedPost). Null it out once the
// drain has been signed off.
export const linkExchangeRemovals = pgTable("link_exchange_removals", {
  postId: uuid("post_id")
    .primaryKey()
    .references(() => generatedPosts.id, { onDelete: "cascade" }),
  blogId: uuid("blog_id").notNull().references(() => blogs.id, { onDelete: "cascade" }),
  priority: integer("priority").default(1).notNull(),
  status: varchar("status", { length: 16 }).default("pending").notNull(),
  linksRemoved: integer("links_removed").default(0).notNull(),
  attempts: integer("attempts").default(0).notNull(),
  lastError: text("last_error"),
  previousBody: text("previous_body"),
  checkedAt: timestamp("checked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("link_exchange_removals_queue_idx").on(table.status, table.priority),
  index("link_exchange_removals_blog_idx").on(table.blogId),
]);

export const linkEvents = pgTable("link_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  postId: uuid("post_id"),
  blogId: uuid("blog_id"),
  clientId: uuid("client_id"),
  type: varchar("type", { length: 16 }).notNull(),
  referrer: text("referrer"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("link_events_post_idx").on(table.postId, table.type),
  index("link_events_blog_idx").on(table.blogId, table.type),
  index("link_events_client_idx").on(table.clientId, table.type),
  index("link_events_created_idx").on(table.createdAt),
]);

// ─── search_performance ──────────────────────────────────────────────────────
//
// Google Search Console performance rows: one per (blog x date x query x page).
// Pulled by /api/cron/gsc-sync from searchanalytics.query and UPSERTED, so
// re-running a window is idempotent — which matters because Google keeps
// revising the most recent ~3 days after first publishing them.
//
// `date` is a Search Console date: America/Los_Angeles, NOT UTC. See
// gscToday() in gsc-sync.ts — asking for a UTC "today" returns an empty day
// for eight hours out of every twenty-four.
//
// `position` is the average SERP position for that row, fractional exactly as
// Google returns it (e.g. 13.47). Stored as numeric, not a float, so AVG()
// across millions of rows is exact and comparable between runs. Drizzle
// returns numeric as a string — see the insert in gsc-sync.upsertRows.
//
// `ctr` is deliberately absent: it is exactly clicks / impressions and storing
// it would create a second source of truth for one division.
//
// `rowHash` = sha256(query || '\0' || page), computed AFTER truncation so the
// hash always describes what is actually stored. It exists for one reason: a
// btree index entry cannot exceed ~2,704 bytes, and (query, page) in UTF-8
// can. A natural unique index on (blog_id, date, query, page) would work for
// months and then abort an entire 500-row upsert batch the first time one long
// URL arrives. Hashing makes the key a fixed 64 bytes. query and page are
// still stored verbatim and are still queryable.
export const searchPerformance = pgTable("search_performance", {
  id: uuid("id").defaultRandom().primaryKey(),
  blogId: uuid("blog_id").notNull().references(() => blogs.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  date: date("date", { mode: "string" }).notNull(),
  query: varchar("query", { length: 500 }).notNull(),
  page: varchar("page", { length: 2048 }).notNull(),
  rowHash: varchar("row_hash", { length: 64 }).notNull(),
  clicks: integer("clicks").notNull().default(0),
  impressions: integer("impressions").notNull().default(0),
  position: decimal("position", { precision: 6, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  // The upsert conflict target. Also serves every lookup prefixed by
  // (blog_id) or (blog_id, date), which is why there is no separate
  // blog_id/date index below — it would be redundant.
  uniqueIndex("search_performance_unique_idx").on(table.blogId, table.date, table.rowHash),
  index("search_performance_client_date_idx").on(table.clientId, table.date),
  index("search_performance_date_idx").on(table.date),
  index("search_performance_query_idx").on(table.query),
]);

// ─── index_coverage ──────────────────────────────────────────────────────────
//
// Latest Search Console URL-inspection verdict per published post. One row per
// post, overwritten in place — this is a current-state table, not a log,
// because URL Inspection is the scarcest quota we have (10,000 calls/day per
// Cloud project) and history is not worth spending it on.
//
//   verdict:       PASS | PARTIAL | FAIL | NEUTRAL | VERDICT_UNSPECIFIED
//   coverageState: the human string, e.g. "Submitted and indexed",
//                  "Crawled - currently not indexed",
//                  "Discovered - currently not indexed",
//                  "URL is unknown to Google",
//                  "Duplicate without user-selected canonical"
//
// googleCanonical vs userCanonical is the single most diagnostic pair in this
// table: when they disagree, Google has folded the page into another URL,
// which is exactly the "indexed but demoted" state the platform could not
// previously see. Every column here comes back in the SAME response as
// verdict, so storing them costs no extra quota. `raw` keeps the untouched
// payload (same convention as client_keywords.raw / seo_scans.rawData) so
// reprocessing never means re-spending an inspection.
export const indexCoverage = pgTable("index_coverage", {
  id: uuid("id").defaultRandom().primaryKey(),
  postId: uuid("post_id").notNull().references(() => generatedPosts.id, { onDelete: "cascade" }),
  blogId: uuid("blog_id").notNull().references(() => blogs.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  // The URL actually sent to Google, snapshotted — generated_posts.external_post_url
  // can be rewritten later and we need to know what this verdict describes.
  inspectedUrl: varchar("inspected_url", { length: 2048 }).notNull(),
  verdict: varchar("verdict", { length: 32 }),
  coverageState: varchar("coverage_state", { length: 160 }),
  robotsTxtState: varchar("robots_txt_state", { length: 48 }),
  indexingState: varchar("indexing_state", { length: 48 }),
  pageFetchState: varchar("page_fetch_state", { length: 48 }),
  googleCanonical: varchar("google_canonical", { length: 2048 }),
  userCanonical: varchar("user_canonical", { length: 2048 }),
  lastCrawlTime: timestamp("last_crawl_time"),
  raw: jsonb("raw"),
  lastCheckedAt: timestamp("last_checked_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("index_coverage_post_idx").on(table.postId),
  index("index_coverage_blog_verdict_idx").on(table.blogId, table.verdict),
  index("index_coverage_checked_idx").on(table.lastCheckedAt),
  index("index_coverage_client_idx").on(table.clientId),
]);
