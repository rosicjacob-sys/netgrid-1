-- Auto-publish idempotency (T08).
--
-- The auto-publish route is invoked by four Render cron containers running
-- cron/invoke.sh. curl treats a --max-time expiry as a transient error and
-- re-invokes, but the Next handler it abandoned keeps running: two sweeps of
-- the same shard then overlap. The sweep's due-check counts only
-- status='published' rows with a non-null published_at, so it cannot see the
-- first sweep's in-flight work and publishes the same blog twice on the same
-- UTC day.
--
-- The fix is a claim the database enforces. Each auto-publish attempt inserts
-- its generated_posts row with (publish_day, day_slot); a partial unique index
-- means only one process can ever hold a given slot while that row is in
-- flight or live.
--
-- WHY day_slot EXISTS: a blog is allowed more than one post per day.
-- blogs.posting_frequency parses as posts-per-day ("2", "2x per day") and
-- isBlogDueForPost permits todaysPublishedCount < postsPerDay. Slot n is the
-- (n+1)-th post of that UTC day. A plain (blog_id, day) key would cap those
-- blogs at one post per day forever.
--
-- WHY THE COLUMNS ARE NULLABLE: NULLs are distinct in a Postgres unique
-- index. Every pre-existing row gets NULL for both columns, so the index
-- builds cleanly against a history that already contains same-day duplicates
-- (which must not be deleted -- those posts are live on customer sites).
-- Manual generation from the admin UI also leaves them NULL on purpose: an
-- operator asking for an extra post today still gets one.
--
-- There is deliberately NO backfill of publish_day onto historical rows.
-- Setting publish_day = published_at::date would collide with the unique
-- index on exactly the duplicate rows this task exists to prevent, aborting
-- the migration mid-UPDATE and blocking the deploy.
--
-- There is also deliberately no CHECK constraint requiring publish_day on
-- auto-generated rows, not even NOT VALID: a NOT VALID check is still
-- enforced on UPDATEs to pre-existing rows, and the semantic-linking backfill
-- and seo-backfill-actions both update historical published rows that have
-- publish_day IS NULL. The constraint would take those crons down. The
-- monitoring query in the T08 SOP §8.6 covers the same class of mistake.

ALTER TABLE "generated_posts" ADD COLUMN IF NOT EXISTS "publish_day" date;
ALTER TABLE "generated_posts" ADD COLUMN IF NOT EXISTS "day_slot" integer;

-- The guard. 'generated' and 'failed' are deliberately OUTSIDE the predicate:
-- a run that failed, or generated an article the platform refused, releases
-- its slot so the blog can be retried on the next hourly tick.
CREATE UNIQUE INDEX IF NOT EXISTS "generated_posts_blog_day_slot_uniq"
  ON "generated_posts" ("blog_id", "publish_day", "day_slot")
  WHERE "status" IN ('generating', 'publishing', 'published');

-- Supports the stuck-row reaper: rows left in flight by a process that died.
CREATE INDEX IF NOT EXISTS "generated_posts_inflight_idx"
  ON "generated_posts" ("status", "updated_at")
  WHERE "status" IN ('generating', 'publishing');

-- Supports the keyword-ledger half of the same reaper.
CREATE INDEX IF NOT EXISTS "blog_keyword_targets_inflight_idx"
  ON "blog_keyword_targets" ("status", "updated_at")
  WHERE "status" = 'generating';
