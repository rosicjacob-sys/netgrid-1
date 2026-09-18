-- T18 — indexes for the post-verification sweep.
--
-- Both are pure performance; no column or row is changed. Written
-- idempotently per src/lib/db/migrations/README.md so the runner can replay
-- it safely.

-- The retention prune selects post_verifications rows older than N days.
-- Without this index that predicate is a sequential scan of a table that
-- grows by ~6,000 rows/day at full coverage (~2.2M/year).
CREATE INDEX IF NOT EXISTS "post_verifications_checked_at_idx"
  ON "post_verifications" ("checked_at");

-- The sweep's run summaries are persisted to activity_log under
-- action = 'post_verification_run', and read back "newest first for this
-- action". T17 writes 'auto_publish_unscheduled' the same way. Without this
-- composite index, answering "was the network covered last night?" scans the
-- whole activity log.
CREATE INDEX IF NOT EXISTS "activity_log_action_created_idx"
  ON "activity_log" ("action", "created_at" DESC);
