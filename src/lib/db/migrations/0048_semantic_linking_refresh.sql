-- T16: indexes for the internal-linking refresh lane, plus a converging
-- backfill of generated_posts.language.
--
-- Additive and idempotent. No column is altered; the UPDATE only fills NULLs.

-- ── Refresh-lane indexes ────────────────────────────────────────────────────
--
-- The refresh lane selects already-linked posts, partitioned by blog and
-- ordered by related_linked_at, then tests whether that blog has published
-- anything newer. Two partial indexes, one per half of that query.

-- The candidate scan: already-linked, live, embedded posts, oldest link first.
CREATE INDEX IF NOT EXISTS "generated_posts_relinked_idx"
  ON "generated_posts" ("blog_id", "related_linked_at")
  WHERE "status" = 'published'
    AND "embedding" IS NOT NULL
    AND "external_post_id" IS NOT NULL
    AND "related_linked_at" IS NOT NULL;

-- The EXISTS half: "has this blog published something embedded since then?"
CREATE INDEX IF NOT EXISTS "generated_posts_blog_published_idx"
  ON "generated_posts" ("blog_id", "published_at")
  WHERE "status" = 'published'
    AND "embedding" IS NOT NULL;

-- ── generated_posts.language backfill ───────────────────────────────────────
--
-- The linking engine now restricts related posts to the same language, and
-- builds the full-text vector with that language's dictionary. Rows written
-- before the language column existed are NULL, which the code treats as
-- "English, and eligible as a candidate for any language" so the change cannot
-- empty a candidate pool.
--
-- That fallback is right for English-only clients and wrong for French-only
-- ones, whose legacy posts are French but indexed as English. Where the
-- client's language_mode is unambiguous we can say so. 'en_fr' is deliberately
-- left alone: a bilingual client alternates per post, and there is no way to
-- tell from the row which language a given legacy post was written in -
-- guessing would be worse than the NULL fallback.
--
-- Converging: only fills NULLs, so replaying it is a no-op, and a re-embed
-- (which rebuilds search_tsv in the row's language) then repairs the tsvector.
UPDATE "generated_posts" gp
SET "language" = c."language_mode"
FROM "blogs" b
JOIN "clients" c ON c."id" = b."client_id"
WHERE gp."blog_id" = b."id"
  AND gp."language" IS NULL
  AND c."language_mode" IN ('en', 'fr');
