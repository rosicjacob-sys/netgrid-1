-- T17 — ONE canonical cadence column. See src/lib/posting-plan.ts.
--
-- blogs.posting_plan is integer[7]; entry i = posts to publish on ISO weekday
-- i+1 (1=Mon … 7=Sun), UTC. All-zeros means "not scheduled", which is now an
-- ALERTABLE condition (see /api/notifications) rather than a silent skip.
--
-- Replaces three columns that could — and did — disagree:
--   posting_frequency       varchar   parsed by the publisher as posts/DAY
--   posting_frequency_days  integer[] used by the publisher as a day filter
--   posts_per_day           integer   read ONLY by the verification cron
-- plus posting_interval_hours, which nothing ever read.
--
-- The legacy columns are deliberately LEFT IN PLACE by this migration so a
-- code rollback still has data to read. 0044_drop_legacy_cadence.sql.pending
-- removes them after the soak window.
--
-- BACKFILL PRECEDENCE (first matching rule wins):
--   R1  posting_frequency_days non-empty  -> 1 post on each of those days
--   R2  "N per day" string                -> N posts every day
--   R3  posts_per_day column >= 1         -> N posts every day
--   R4  "N per week" string               -> N days from the spread table
--   R5  bare number N (1..7)              -> N days from the spread table
--   R6  "weekly" / "daily"                -> 1/week (Wed) / 1 per day
--   R7  anything else                     -> all zeros (alerts, see above)
--
-- R1 and R2 preserve current publisher behaviour exactly. R3 makes a class of
-- blog publishable for the first time. R5 DELIBERATELY CHANGES BEHAVIOUR:
-- a bare "2" used to mean 2 posts per DAY (14/week); it now means 2 per WEEK.
-- Run the audit queries in T17 §7.1 and sign off on the affected domains
-- BEFORE applying this file.

ALTER TABLE "blogs" ADD COLUMN IF NOT EXISTS "posting_plan" integer[];

-- ── R1: the weekday picker. This is what the form writes and what the
--    publisher already honours (the day array had priority over the frequency
--    string), so these blogs keep publishing exactly as they do today.
--    posts_per_day is ignored here on purpose: the publisher never read it, so
--    honouring it would change live behaviour for blogs that are working.
UPDATE "blogs"
SET "posting_plan" = ARRAY[
      CASE WHEN 1 = ANY("posting_frequency_days") THEN 1 ELSE 0 END,
      CASE WHEN 2 = ANY("posting_frequency_days") THEN 1 ELSE 0 END,
      CASE WHEN 3 = ANY("posting_frequency_days") THEN 1 ELSE 0 END,
      CASE WHEN 4 = ANY("posting_frequency_days") THEN 1 ELSE 0 END,
      CASE WHEN 5 = ANY("posting_frequency_days") THEN 1 ELSE 0 END,
      CASE WHEN 6 = ANY("posting_frequency_days") THEN 1 ELSE 0 END,
      CASE WHEN 7 = ANY("posting_frequency_days") THEN 1 ELSE 0 END
    ]::integer[]
WHERE "posting_plan" IS NULL
  AND "posting_frequency_days" IS NOT NULL
  AND cardinality("posting_frequency_days") > 0;

-- ── R2: explicit "N per day" strings, which parsePostsPerDay() matched and
--    the publisher acted on. No behaviour change. Clamped to 8/day, the same
--    ceiling the CHECK constraint below enforces.
UPDATE "blogs" b
SET "posting_plan" = array_fill(LEAST(src.n, 8), ARRAY[7])
FROM (
  SELECT id,
         (regexp_match("posting_frequency",
                       '(\d+)\s*(?:x|/|\s)*(?:posts?\s*)?(?:per\s*)?day',
                       'i'))[1]::int AS n
  FROM "blogs"
  WHERE "posting_plan" IS NULL
    AND "posting_frequency" ~* '(\d+)\s*(?:x|/|\s)*(?:posts?\s*)?(?:per\s*)?day'
) src
WHERE b.id = src.id AND src.n >= 1;

-- ── R3: the posts_per_day column. ONLY the verification cron ever read this,
--    so these blogs have been flagged "behind" every 6 hours while being
--    structurally unable to publish. Honouring it here is the repair — it
--    makes the publisher agree with what the verifier has always expected.
UPDATE "blogs"
SET "posting_plan" = array_fill(LEAST("posts_per_day", 8), ARRAY[7])
WHERE "posting_plan" IS NULL
  AND "posts_per_day" IS NOT NULL
  AND "posts_per_day" >= 1;

-- ── R4/R5/R6: weekly counts. The CASE ladder mirrors WEEKLY_SPREAD in
--    src/lib/posting-plan.ts verbatim — change one, change both.
--    R5 (bare number) is the ambiguous case: see the header comment.
UPDATE "blogs" b
SET "posting_plan" = CASE src.w
      WHEN 1 THEN '{0,0,1,0,0,0,0}'::integer[]  -- Wed
      WHEN 2 THEN '{0,1,0,0,1,0,0}'::integer[]  -- Tue, Fri
      WHEN 3 THEN '{1,0,1,0,1,0,0}'::integer[]  -- Mon, Wed, Fri
      WHEN 4 THEN '{1,1,0,1,1,0,0}'::integer[]  -- Mon, Tue, Thu, Fri
      WHEN 5 THEN '{1,1,1,1,1,0,0}'::integer[]  -- Mon-Fri
      WHEN 6 THEN '{1,1,1,1,1,1,0}'::integer[]  -- Mon-Sat
      WHEN 7 THEN '{1,1,1,1,1,1,1}'::integer[]  -- every day
    END
FROM (
  SELECT id,
         CASE
           -- R4: "N per week" / "Nx week" / "N posts per week"
           WHEN "posting_frequency" ~* '(\d+)\s*(?:x|/|\s)*(?:posts?\s*)?(?:per\s*)?week'
             THEN (regexp_match("posting_frequency",
                                '(\d+)\s*(?:x|/|\s)*(?:posts?\s*)?(?:per\s*)?week',
                                'i'))[1]::int
           -- R5: bare number, interpreted as posts per WEEK
           WHEN btrim("posting_frequency") ~ '^[0-9]+$'
             THEN btrim("posting_frequency")::int
           -- R6: the word "weekly" means once a week
           WHEN lower(btrim("posting_frequency")) IN ('weekly', 'week')
             THEN 1
           -- R6: the word "daily" means every day
           WHEN lower(btrim("posting_frequency")) IN ('daily', 'day')
             THEN 7
           ELSE NULL
         END AS w
  FROM "blogs"
  WHERE "posting_plan" IS NULL
) src
WHERE b.id = src.id AND src.w BETWEEN 1 AND 7;

-- ── R7: everything left over — NULL frequency, unparseable strings
--    ("biweekly", "3x monthly"), and weekly counts above 7 that cannot be
--    spread across distinct days. These become explicitly UNSCHEDULED, which
--    the app now raises as a critical notification, so they are visible
--    rather than silent. Fix them in the blog form.
UPDATE "blogs"
SET "posting_plan" = '{0,0,0,0,0,0,0}'::integer[]
WHERE "posting_plan" IS NULL;

-- ── Lock the shape in.
ALTER TABLE "blogs"
  ALTER COLUMN "posting_plan" SET DEFAULT '{0,0,0,0,0,0,0}'::integer[];
ALTER TABLE "blogs"
  ALTER COLUMN "posting_plan" SET NOT NULL;

-- Per-element bounds are spelled out rather than written with unnest(),
-- because a CHECK constraint may not contain a subquery. The explicit
-- IS NOT NULL matters: "NULL BETWEEN 0 AND 8" evaluates to NULL, and a CHECK
-- that evaluates to NULL PASSES.
DO $$
BEGIN
  ALTER TABLE "blogs"
    ADD CONSTRAINT "blogs_posting_plan_shape"
    CHECK (
      array_ndims("posting_plan") = 1
      AND array_length("posting_plan", 1) = 7
      AND "posting_plan"[1] IS NOT NULL AND "posting_plan"[1] BETWEEN 0 AND 8
      AND "posting_plan"[2] IS NOT NULL AND "posting_plan"[2] BETWEEN 0 AND 8
      AND "posting_plan"[3] IS NOT NULL AND "posting_plan"[3] BETWEEN 0 AND 8
      AND "posting_plan"[4] IS NOT NULL AND "posting_plan"[4] BETWEEN 0 AND 8
      AND "posting_plan"[5] IS NOT NULL AND "posting_plan"[5] BETWEEN 0 AND 8
      AND "posting_plan"[6] IS NOT NULL AND "posting_plan"[6] BETWEEN 0 AND 8
      AND "posting_plan"[7] IS NOT NULL AND "posting_plan"[7] BETWEEN 0 AND 8
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Backs the "unscheduled active blogs" alert in /api/notifications and the
-- candidate-query exclusion in runAutoPublishCron.
CREATE INDEX IF NOT EXISTS "blogs_unscheduled_idx"
  ON "blogs" ("status")
  WHERE "posting_plan" = '{0,0,0,0,0,0,0}'::integer[];
