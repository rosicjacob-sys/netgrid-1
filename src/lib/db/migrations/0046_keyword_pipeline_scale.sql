-- Keyword pipeline: scale + lifecycle (T10).
--
-- Three problems, all additive to fix:
--
-- 1. The refresh cron looped over EVERY client in one request and never
--    finished, so the ledger rebuild after it never ran at all. It is now
--    sharded and time-boxed, and needs a per-client fairness cursor to know
--    where to resume — clients.keywords_refresh_attempted_at. The cursor
--    lives here rather than in app_settings on purpose: a stamp on the row
--    itself cannot drift when clients are inserted or deleted, and a run
--    that dies halfway simply leaves the rest still stale.
--
-- 2. blog_keyword_targets had no notion of an attempt. markKeywordTargetFailed
--    set status='failed' on the FIRST failure while claimKeywordTargetForBlog
--    only ever selected 'pending' and nothing anywhere reset it, so one
--    transient model/platform error permanently deleted that keyword from
--    that blog. attempts + next_retry_at turn 'failed' into a real
--    dead-letter state reached only after the retry budget is spent.
--
-- 3. Rows stranded in 'generating' by a crashed container were never reaped,
--    and 'generating' doubles as a cross-sibling reservation — so each one
--    also shrank every sibling blog's pool. The reaper needs an index on
--    (status, updated_at) to find them cheaply.

-- ── clients: keyword-refresh bookkeeping ────────────────────────────────────

-- Last SUCCESSFUL scrape (stored keywords). Reporting/debugging only.
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "keywords_refreshed_at" timestamp;

-- Last ATTEMPT, successful or not. THIS is the cron's fairness cursor: it is
-- stamped BEFORE the scrape so a client that hangs or crashes the run moves
-- to the back of the queue instead of pinning the head of it forever.
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "keywords_refresh_attempted_at" timestamp;

-- Consecutive empty/blocked scrapes. Reset to 0 by any success; escalated to
-- activity_log past SCRAPE_ALERT_AFTER_FAILURES (or immediately when the
-- scrape was blocked rather than merely empty).
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "keywords_refresh_failures" integer NOT NULL DEFAULT 0;

-- The candidate query: stalest-first, nulls first.
CREATE INDEX IF NOT EXISTS "clients_keywords_refresh_idx"
  ON "clients" ("keywords_refresh_attempted_at");

-- ── blog_keyword_targets: bounded retry lifecycle ───────────────────────────

-- Resolved failures INCLUDING reaper requeues. Row is dead-lettered to
-- 'failed' once this reaches KEYWORD_TARGET_MAX_ATTEMPTS (default 3).
ALTER TABLE "blog_keyword_targets" ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0;

-- When the last attempt resolved. Diagnostics; not read by the claim query.
ALTER TABLE "blog_keyword_targets" ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp;

-- Cool-off gate. NULL = claimable now (never attempted, or terminal).
ALTER TABLE "blog_keyword_targets" ADD COLUMN IF NOT EXISTS "next_retry_at" timestamp;

-- The claim query is now
--   blog_id = $1 AND status = 'pending'
--   AND (next_retry_at IS NULL OR next_retry_at <= now())
--   ORDER BY attempts, priority
-- The existing blog_status_priority index no longer covers it.
CREATE INDEX IF NOT EXISTS "blog_keyword_targets_claim_idx"
  ON "blog_keyword_targets" ("blog_id", "status", "next_retry_at", "attempts", "priority");

-- The reaper: status='generating' AND updated_at < cutoff, network-wide.
CREATE INDEX IF NOT EXISTS "blog_keyword_targets_stranded_idx"
  ON "blog_keyword_targets" ("status", "updated_at");

-- ── One-time repair: release the existing permanent graves ──────────────────
--
-- Every row already sitting in 'failed' got there from a SINGLE failure under
-- the old semantics, with no retry budget spent — the column did not exist.
-- Leaving them would keep those keywords deleted from their blogs forever,
-- which is the defect this migration exists to end. They are returned to the
-- pool with one attempt charged, so a keyword that genuinely cannot be
-- generated still dead-letters after two more tries.
--
-- Rows stranded in 'generating' for over a day are the cross-sibling
-- reservations described above; the same treatment applies. Anything younger
-- is left alone so this migration cannot race a live auto-publish run.
UPDATE "blog_keyword_targets"
SET "status" = 'pending',
    "attempts" = GREATEST("attempts", 1),
    "next_retry_at" = NULL,
    "updated_at" = now()
WHERE "status" = 'failed';

UPDATE "blog_keyword_targets"
SET "status" = 'pending',
    "attempts" = GREATEST("attempts", 1),
    "next_retry_at" = NULL,
    "failure_reason" = 'Released by migration 0046: stranded in ''generating'' before the reaper existed',
    "updated_at" = now()
WHERE "status" = 'generating'
  AND "generated_post_id" IS NULL
  AND "updated_at" < now() - INTERVAL '1 day';
