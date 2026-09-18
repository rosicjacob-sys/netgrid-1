-- T11: ground topic ideation in real query data.
--
-- Two additive changes, both idempotent:
--   1. blog_covered_queries — the PERMANENT per-blog record of which search
--      queries a blog has already covered. Replaces the 24-title dedup window
--      (12 own + 12 sibling titles) that made a two-year-old blog forget
--      everything older than about two weeks.
--   2. generated_posts.primary_query / .supporting_queries — the audit trail
--      of what demand-validated query each post was built to cover.
--
-- No backfill here: history is populated by
--   npm run db:backfill-covered-queries
-- which normalises existing titles through the TS helper. Doing it in SQL
-- would need a different normalisation implementation, and the two would
-- drift.

CREATE TABLE IF NOT EXISTS blog_covered_queries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blog_id           uuid NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
  client_id         uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  query             varchar(255) NOT NULL,
  query_norm        varchar(255) NOT NULL,
  topic             varchar(500) NOT NULL,
  generated_post_id uuid REFERENCES generated_posts(id) ON DELETE SET NULL,
  source            varchar(16) NOT NULL DEFAULT 'ideation',
  covered_at        timestamp NOT NULL DEFAULT now()
);

-- The uniqueness key. An accent/case/hyphen/spacing variant of the same query
-- collapses onto one row, so recordCoveredQuery can use ON CONFLICT DO NOTHING
-- as its concurrency guard (neon-http has no interactive transactions).
CREATE UNIQUE INDEX IF NOT EXISTS blog_covered_queries_blog_query_idx
  ON blog_covered_queries (blog_id, query_norm);

-- Sibling lookup: a query a sibling blog of the same client already covered is
-- deprioritised rather than removed.
CREATE INDEX IF NOT EXISTS blog_covered_queries_client_query_idx
  ON blog_covered_queries (client_id, query_norm);

-- Recency reads for the admin/coverage views.
CREATE INDEX IF NOT EXISTS blog_covered_queries_blog_covered_at_idx
  ON blog_covered_queries (blog_id, covered_at);

ALTER TABLE generated_posts
  ADD COLUMN IF NOT EXISTS primary_query varchar(255);

ALTER TABLE generated_posts
  ADD COLUMN IF NOT EXISTS supporting_queries jsonb;
