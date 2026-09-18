-- T15 — IndexNow: per-blog keys, Google Search Console sitemap state, and an
-- auditable record of every index-notification attempt.
--
-- Why per-blog keys: the previous implementation published ONE key
-- (INDEXNOW_KEY) at a guessable URL on every domain in the network, which
-- turns "is this domain ours?" into a single unauthenticated GET and hands
-- every receiving engine the network adjacency list for free.
--
-- Why an events table: failures were console.warn only, so a subsystem that
-- had never once succeeded was indistinguishable from a healthy one.
--
-- Idempotent — safe to replay against a live database.

ALTER TABLE "blogs" ADD COLUMN IF NOT EXISTS "indexnow_key" varchar(128);
ALTER TABLE "blogs" ADD COLUMN IF NOT EXISTS "indexnow_key_location" varchar(1000);
ALTER TABLE "blogs" ADD COLUMN IF NOT EXISTS "indexnow_key_verified_at" timestamp;
ALTER TABLE "blogs" ADD COLUMN IF NOT EXISTS "sitemap_url" varchar(1000);
ALTER TABLE "blogs" ADD COLUMN IF NOT EXISTS "sitemap_submitted_at" timestamp;
ALTER TABLE "blogs" ADD COLUMN IF NOT EXISTS "sitemap_submit_error" text;

-- Two blogs must never share a key. Partial so the many NULLs (blogs not yet
-- deployed) don't collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS "blogs_indexnow_key_idx"
  ON "blogs" ("indexnow_key")
  WHERE "indexnow_key" IS NOT NULL;

-- Append-only attempt log.
--   channel: 'indexnow' | 'indexnow_deploy' | 'gsc_sitemap'
--   outcome: 'ok' | 'failed' | 'skipped'
-- 'skipped' is a deliberate non-attempt (unsupported platform, kill switch,
-- missing credentials) and must never be counted as a failure.
CREATE TABLE IF NOT EXISTS "index_ping_events" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "blog_id"      uuid NOT NULL REFERENCES "blogs"("id") ON DELETE CASCADE,
  "post_id"      uuid REFERENCES "generated_posts"("id") ON DELETE SET NULL,
  "channel"      varchar(24) NOT NULL,
  "outcome"      varchar(16) NOT NULL,
  "target_url"   varchar(1000),
  "key_location" varchar(1000),
  "http_status"  integer,
  "error"        text,
  "created_at"   timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "index_ping_events_blog_idx"
  ON "index_ping_events" ("blog_id", "channel");
CREATE INDEX IF NOT EXISTS "index_ping_events_outcome_idx"
  ON "index_ping_events" ("outcome", "created_at");
CREATE INDEX IF NOT EXISTS "index_ping_events_created_idx"
  ON "index_ping_events" ("created_at");
