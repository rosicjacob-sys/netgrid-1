-- T04 — Google Search Console feedback loop.
--
-- Additive only: two new tables and seven nullable columns on blogs. No
-- existing column is altered and no existing row is touched, so this migration
-- cannot break a running deploy.
--
-- Written idempotently per src/lib/db/migrations/README.md — CREATE TABLE IF
-- NOT EXISTS, ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS — so the
-- runner (src/lib/db/migrate.mjs) can replay it safely against a database that
-- already has some of it.

-- ─── blogs: Search Console property state ───────────────────────────────────
--
-- gsc_site_url is the property identifier every API call is made with:
--   'sc-domain:example.com'  Domain property     (DNS_TXT verified)
--   'https://example.com/'   URL-prefix property (META verified)
-- NULL until the property is verified AND registered via sites.add.
ALTER TABLE "blogs" ADD COLUMN IF NOT EXISTS "gsc_site_url" varchar(255);
ALTER TABLE "blogs" ADD COLUMN IF NOT EXISTS "gsc_verification_method" varchar(16);
-- For DNS_TXT this is the operator deliverable: the TXT value to publish at
-- the apex. For META it is the full <meta> tag written into the Shopify theme.
ALTER TABLE "blogs" ADD COLUMN IF NOT EXISTS "gsc_verification_token" text;
ALTER TABLE "blogs" ADD COLUMN IF NOT EXISTS "gsc_verified_at" timestamp;
ALTER TABLE "blogs" ADD COLUMN IF NOT EXISTS "gsc_sitemap_submitted_at" timestamp;
-- Drives the sync cron's ordering (NULLS FIRST = never-synced blogs first) and
-- lets the suppressed-site alert tell "suppressed" from "the cron is broken".
ALTER TABLE "blogs" ADD COLUMN IF NOT EXISTS "gsc_last_synced_at" timestamp;
ALTER TABLE "blogs" ADD COLUMN IF NOT EXISTS "gsc_backfilled_at" timestamp;

CREATE INDEX IF NOT EXISTS "blogs_gsc_synced_idx" ON "blogs" ("gsc_last_synced_at");

-- ─── search_performance ─────────────────────────────────────────────────────
--
-- One row per (blog x date x query x page). Upserted every run, because Google
-- keeps revising the most recent ~3 days after first publishing them.
--
-- "date" is a Search Console date: America/Los_Angeles, not UTC.
-- "position" is the average SERP position, fractional (13.47), stored as
--   numeric so AVG() is exact and comparable between runs.
-- "row_hash" is sha256(query || E'\x00' || page) computed in app code AFTER
--   truncation. It exists only to keep the unique index small: a btree entry
--   is capped at ~2,704 bytes and (query, page) in UTF-8 can exceed that,
--   which would abort a whole 500-row upsert batch on one long URL.
-- ctr is deliberately absent — it is exactly clicks / impressions.
CREATE TABLE IF NOT EXISTS "search_performance" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "blog_id"     uuid NOT NULL REFERENCES "blogs"("id") ON DELETE CASCADE,
  "client_id"   uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "date"        date NOT NULL,
  "query"       varchar(500) NOT NULL,
  "page"        varchar(2048) NOT NULL,
  "row_hash"    varchar(64) NOT NULL,
  "clicks"      integer NOT NULL DEFAULT 0,
  "impressions" integer NOT NULL DEFAULT 0,
  "position"    numeric(6, 2) NOT NULL,
  "created_at"  timestamp NOT NULL DEFAULT now(),
  "updated_at"  timestamp NOT NULL DEFAULT now()
);

-- The ON CONFLICT target. Also serves every lookup prefixed by (blog_id) or
-- (blog_id, date), which is why no separate blog/date index exists below.
CREATE UNIQUE INDEX IF NOT EXISTS "search_performance_unique_idx"
  ON "search_performance" ("blog_id", "date", "row_hash");
CREATE INDEX IF NOT EXISTS "search_performance_client_date_idx"
  ON "search_performance" ("client_id", "date");
CREATE INDEX IF NOT EXISTS "search_performance_date_idx"
  ON "search_performance" ("date");
CREATE INDEX IF NOT EXISTS "search_performance_query_idx"
  ON "search_performance" ("query");

-- ─── index_coverage ─────────────────────────────────────────────────────────
--
-- Latest URL-inspection verdict per published post. Current state, not a log:
-- URL Inspection is capped at 10,000 calls/day per Cloud project, so history is
-- not worth spending quota on.
--
-- google_canonical vs user_canonical is the most diagnostic pair here — when
-- they disagree, Google has folded the page into another URL, which is exactly
-- the "indexed but demoted" state the platform previously could not see.
-- Every column arrives in the same API response, so storing all of them is free.
--
-- verdict and coverage_state are plain varchar rather than enums on purpose:
-- Google adds and rewords coverage states without notice, and an unknown value
-- arriving into an enum column is a hard insert failure at 3am, whereas into a
-- varchar it is just a new string to look at.
CREATE TABLE IF NOT EXISTS "index_coverage" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "post_id"          uuid NOT NULL REFERENCES "generated_posts"("id") ON DELETE CASCADE,
  "blog_id"          uuid NOT NULL REFERENCES "blogs"("id") ON DELETE CASCADE,
  "client_id"        uuid NOT NULL REFERENCES "clients"("id") ON DELETE CASCADE,
  "inspected_url"    varchar(2048) NOT NULL,
  "verdict"          varchar(32),
  "coverage_state"   varchar(160),
  "robots_txt_state" varchar(48),
  "indexing_state"   varchar(48),
  "page_fetch_state" varchar(48),
  "google_canonical" varchar(2048),
  "user_canonical"   varchar(2048),
  "last_crawl_time"  timestamp,
  "raw"              jsonb,
  "last_checked_at"  timestamp NOT NULL DEFAULT now(),
  "created_at"       timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "index_coverage_post_idx"
  ON "index_coverage" ("post_id");
CREATE INDEX IF NOT EXISTS "index_coverage_blog_verdict_idx"
  ON "index_coverage" ("blog_id", "verdict");
CREATE INDEX IF NOT EXISTS "index_coverage_checked_idx"
  ON "index_coverage" ("last_checked_at");
CREATE INDEX IF NOT EXISTS "index_coverage_client_idx"
  ON "index_coverage" ("client_id");
