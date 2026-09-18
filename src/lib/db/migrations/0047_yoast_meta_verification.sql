-- T14: never trust a 200 from WordPress for an SEO-meta write again.
--
-- WordPress returns HTTP 200 for /wp/v2/posts requests carrying meta keys it
-- does not recognise, and silently discards them. Every Yoast blog in the
-- network has been publishing posts with the theme's default title and no meta
-- description while the logs said "(SEO meta set)".
--
-- seo_meta_verified records what the LIVE page rendered after the write:
--   true  - the live <head> matched what we wrote
--   false - the page was fetched and did NOT match: the write did not land
--   NULL  - never checked (Shopify, a draft, or the page was unreachable)
--
-- seo_bridge_version records whether the netgrid-seo-bridge MU-plugin is
-- installed on a WordPress site. NULL = not installed = Yoast meta is not
-- REST-writable there.
--
-- Idempotent: safe to replay against an already-migrated database.

ALTER TABLE "generated_posts" ADD COLUMN IF NOT EXISTS "seo_meta_verified" boolean;
ALTER TABLE "generated_posts" ADD COLUMN IF NOT EXISTS "seo_meta_verified_at" timestamp;

ALTER TABLE "blogs" ADD COLUMN IF NOT EXISTS "seo_bridge_version" varchar(20);

-- The backfill and the "which posts are still broken" dashboards both filter
-- by blog and verification state.
CREATE INDEX IF NOT EXISTS "generated_posts_seo_meta_verified_idx"
  ON "generated_posts" ("blog_id", "seo_meta_verified");
