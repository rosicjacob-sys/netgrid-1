-- T03 — Link-exchange shutdown + removal queue.
--
-- The link exchange built a full directed mesh of reciprocal links between
-- every pair of a client's own blogs and injected them into live posts,
-- stamped with data-nx-exch="{edgeId}". It is retired. This migration:
--
--   1. Opts every client out (nothing left for buildLoops to build).
--   2. Retires every mesh row.
--   3. Moves every never-placed edge to the terminal 'disabled' status, so
--      runLinkExchange's pending-only queue is empty even if the code guard
--      is ever removed.
--   4. Creates the removal work queue.
--   5. Seeds it: first the posts a placed edge points at, then every published
--      post on any blog that ever hosted an exchange link (the audit sweep).
--
-- Idempotent — every UPDATE is WHERE-guarded and every INSERT is
-- ON CONFLICT DO NOTHING, so a replay is a no-op.

-- ── 1. Nobody is in the network any more ────────────────────────────────────
UPDATE "clients"
   SET "link_exchange_enabled" = false,
       "updated_at"            = now()
 WHERE "link_exchange_enabled" = true;

-- ── 2. Retire every client mesh ─────────────────────────────────────────────
UPDATE "link_exchange_loops"
   SET "status"     = 'disabled',
       "updated_at" = now()
 WHERE "status" = 'active';

-- ── 3. Terminal state for every edge that was never placed ──────────────────
-- runLinkExchange selects WHERE status = 'pending' with no join back to
-- clients, so opting a client out never stopped its queued placements. This
-- empties that queue for good.
UPDATE "link_exchange_edges"
   SET "status"         = 'disabled',
       "failure_reason" = 'link exchange retired (T03)',
       "updated_at"     = now()
 WHERE "status" = 'pending';

-- ── 4. Removal work queue ───────────────────────────────────────────────────
-- One row per published post to be checked for a data-nx-exch link.
--   priority 0 → a placed edge points here: known to carry a link
--   priority 1 → swept in because its blog ever hosted an exchange link
--   status     → 'pending' | 'clean' | 'removed' | 'failed'
-- previous_body snapshots the live body as it was before the strip, so a
-- single post can be restored. Null it out after sign-off.
CREATE TABLE IF NOT EXISTS "link_exchange_removals" (
  "post_id"       uuid PRIMARY KEY REFERENCES "generated_posts"("id") ON DELETE CASCADE,
  "blog_id"       uuid NOT NULL REFERENCES "blogs"("id") ON DELETE CASCADE,
  "priority"      integer NOT NULL DEFAULT 1,
  "status"        varchar(16) NOT NULL DEFAULT 'pending',
  "links_removed" integer NOT NULL DEFAULT 0,
  "attempts"      integer NOT NULL DEFAULT 0,
  "last_error"    text,
  "previous_body" text,
  "checked_at"    timestamp,
  "created_at"    timestamp NOT NULL DEFAULT now(),
  "updated_at"    timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "link_exchange_removals_queue_idx"
  ON "link_exchange_removals" ("status", "priority");
CREATE INDEX IF NOT EXISTS "link_exchange_removals_blog_idx"
  ON "link_exchange_removals" ("blog_id");

-- ── 5a. Seed the PRECISE set (priority 0) ───────────────────────────────────
-- Posts a placed edge explicitly points at. These are known to carry a link.
INSERT INTO "link_exchange_removals" ("post_id", "blog_id", "priority")
SELECT DISTINCT e."placed_in_post_id", gp."blog_id", 0
  FROM "link_exchange_edges" e
  JOIN "generated_posts" gp ON gp."id" = e."placed_in_post_id"
 WHERE e."status" = 'placed'
   AND e."placed_in_post_id" IS NOT NULL
   AND gp."external_post_id" IS NOT NULL
ON CONFLICT ("post_id") DO NOTHING;

-- ── 5b. Seed the SWEEP set (priority 1) ─────────────────────────────────────
-- Every published post on any blog that ever acted as an exchange source.
-- Catches links whose edge row lost its placed_in_post_id (the FK is
-- ON DELETE SET NULL) and any placement that succeeded on the platform but
-- crashed before the edge row was updated.
INSERT INTO "link_exchange_removals" ("post_id", "blog_id", "priority")
SELECT gp."id", gp."blog_id", 1
  FROM "generated_posts" gp
 WHERE gp."status" = 'published'
   AND gp."external_post_id" IS NOT NULL
   AND gp."blog_id" IN (
         SELECT DISTINCT "source_blog_id" FROM "link_exchange_edges"
       )
ON CONFLICT ("post_id") DO NOTHING;
