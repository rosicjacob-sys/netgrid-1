/**
 * URL-inspection sampler — writes index_coverage.
 *
 * QUOTA, AND WHY THIS FILE IS SHAPED THE WAY IT IS
 * ------------------------------------------------
 * urlInspection.index.inspect is capped at 2,000 calls/day PER SITE and
 * 10,000 calls/day PER CLOUD PROJECT. The project cap is the binding one and it
 * does not scale with the number of properties: 1,500 properties share the same
 * 10,000. That is 6.6 inspections per site per day if you spend every unit and
 * leave nothing for debugging.
 *
 * Corpus size: ~1,500 blogs x ~30 published posts = ~45,000 URLs, growing by
 * the network's publish rate (docs/scaling.md puts that at ~500/day at target
 * cadence).
 *
 * A naive "re-inspect everything monthly" policy needs 45,000/30 = 1,500
 * calls/day today and is unbounded tomorrow, because the corpus grows by 500/day
 * forever. So this file does not do that. The sampling policy is:
 *
 *   1. Every published post is inspected ONCE, three days after publish. This is
 *      the single highest-information datapoint per URL and it costs exactly the
 *      publish rate (~500/day).
 *   2. A post whose last verdict was NOT "PASS" is re-inspected every 14 days.
 *      These are the ones that can still change and the ones worth spending on.
 *   3. A 1-in-20 random control sample of PASSing posts is re-inspected every
 *      90 days, so a fleet-wide de-indexing event is still detectable.
 *
 * Steady-state cost is therefore publish-rate plus a fixed sample, not
 * corpus-size — bounded regardless of how large the archive grows.
 *
 * Default budget is 900 per run x 2 shards = 1,800/day, i.e. 18% of the project
 * cap, leaving 8,200/day of headroom for manual debugging and any future
 * consumer. Raise GSC_URL_INSPECT_DAILY_BUDGET deliberately, and never above
 * 5,000 per shard.
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { indexCoverage } from "@/lib/db/schema";
import { gscConfigured, inspectUrl, isQuotaExhausted } from "@/lib/services/gsc-client";

interface CoverageCandidate {
  post_id: string;
  blog_id: string;
  client_id: string;
  external_post_url: string;
  gsc_site_url: string;
  domain: string;
}

export interface CoverageOutcome {
  postId: string;
  domain: string;
  status: "inspected" | "failed" | "skipped";
  verdict?: string | null;
  coverageState?: string | null;
  message?: string;
}

export interface CoverageSummary {
  configured: boolean;
  shardIndex: number;
  shardCount: number;
  budget: number;
  perSite: number;
  considered: number;
  inspected: number;
  failed: number;
  /** True when Google reported the daily quota spent — the run stopped early
   *  on purpose rather than burning the remaining time on doomed calls. */
  quotaExhausted: boolean;
  byVerdict: Record<string, number>;
  totalDurationMs: number;
  results: CoverageOutcome[];
}

/**
 * Candidate selection. Implements the three-tier sampling policy above in one
 * query, with a per-blog cap so a single 500-post blog cannot eat the shard's
 * whole budget.
 *
 * The 1-in-20 control sample uses md5 of the post id rather than random(), so
 * the same posts are sampled run after run — a stable panel, which is what makes
 * a trend readable.
 * (('x' || substr(md5(...),1,4))::bit(16)::int) is always 0..65535, so the
 * modulo is never negative. Do not "simplify" it to bit(32), which is signed.
 */
async function fetchCandidates(
  limit: number,
  perSite: number,
): Promise<CoverageCandidate[]> {
  const result = await db.execute(sql`
    WITH candidates AS (
      SELECT
        gp.id::text            AS post_id,
        gp.blog_id::text       AS blog_id,
        gp.client_id::text     AS client_id,
        gp.external_post_url   AS external_post_url,
        b.gsc_site_url         AS gsc_site_url,
        b.domain               AS domain,
        ic.last_checked_at     AS last_checked_at,
        row_number() OVER (
          PARTITION BY gp.blog_id
          ORDER BY ic.last_checked_at ASC NULLS FIRST, gp.published_at DESC
        ) AS rn
      FROM generated_posts gp
      JOIN blogs b ON b.id = gp.blog_id
      LEFT JOIN index_coverage ic ON ic.post_id = gp.id
      WHERE gp.status = 'published'
        AND gp.external_post_url IS NOT NULL
        AND gp.published_at IS NOT NULL
        -- Give Google three days to find it before asking about it.
        AND gp.published_at < now() - INTERVAL '3 days'
        AND b.status = 'active'
        AND b.gsc_verified_at IS NOT NULL
        AND b.gsc_site_url IS NOT NULL
        AND (
          -- Tier 1: never inspected.
          ic.last_checked_at IS NULL
          -- Tier 2: not indexed last time; still changeable.
          OR (ic.verdict IS DISTINCT FROM 'PASS'
              AND ic.last_checked_at < now() - INTERVAL '14 days')
          -- Tier 3: stable 1-in-20 control panel of PASSing posts.
          OR (ic.last_checked_at < now() - INTERVAL '90 days'
              AND ((('x' || substr(md5(gp.id::text), 1, 4))::bit(16)::int) % 20) = 0)
        )
    )
    SELECT post_id, blog_id, client_id, external_post_url, gsc_site_url, domain
    FROM candidates
    WHERE rn <= ${perSite}
    ORDER BY last_checked_at ASC NULLS FIRST
    LIMIT ${limit}
  `);

  const raw = (Array.isArray(result) ? result : result.rows) as CoverageCandidate[];
  return raw;
}

/** SHA1-free shard split. The candidate query cannot easily shard in SQL, so we
 * over-fetch by shardCount and filter in JS. At a 900 budget and 2 shards that
 * is one 1,800-row query per run — cheaper than any SQL hashing scheme. */
function shardFilter<T extends { post_id: string }>(
  items: T[],
  shardIndex: number,
  shardCount: number,
): T[] {
  if (shardCount <= 1) return items;
  return items.filter((c) => {
    // FNV-1a over the uuid text — cheap, well distributed, no crypto import.
    let h = 0x811c9dc5;
    for (let i = 0; i < c.post_id.length; i++) {
      h ^= c.post_id.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % shardCount === shardIndex;
  });
}

export async function runGscIndexCoverage(opts: {
  shardIndex?: number;
  shardCount?: number;
  budget?: number;
  perSite?: number;
  concurrency?: number;
} = {}): Promise<CoverageSummary> {
  const startedAt = Date.now();
  const shardCount = Math.max(1, opts.shardCount ?? 1);
  const shardIndex = Math.min(Math.max(0, opts.shardIndex ?? 0), shardCount - 1);
  const budget = Math.max(
    0,
    Math.min(
      5000,
      opts.budget ?? (Number(process.env.GSC_URL_INSPECT_DAILY_BUDGET ?? 900) || 900),
    ),
  );
  const perSite = Math.max(
    1,
    Math.min(50, opts.perSite ?? (Number(process.env.GSC_URL_INSPECT_PER_SITE ?? 4) || 4)),
  );
  const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 4));

  const base: CoverageSummary = {
    configured: gscConfigured(),
    shardIndex,
    shardCount,
    budget,
    perSite,
    considered: 0,
    inspected: 0,
    failed: 0,
    quotaExhausted: false,
    byVerdict: {},
    totalDurationMs: 0,
    results: [],
  };

  if (!base.configured || budget === 0) {
    return { ...base, totalDurationMs: Date.now() - startedAt };
  }

  const pool = await fetchCandidates(budget * shardCount, perSite);
  const batch = shardFilter(pool, shardIndex, shardCount).slice(0, budget);

  // Shared stop flag. Once Google says the daily quota is spent, every further
  // call is guaranteed to fail, so in-flight workers short-circuit instead of
  // spending the remaining runtime on 429s.
  let exhausted = false;
  let cursor = 0;
  const results = new Array<CoverageOutcome>(batch.length);

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= batch.length) return;
      const c = batch[i];
      if (exhausted) {
        results[i] = {
          postId: c.post_id,
          domain: c.domain,
          status: "skipped",
          message: "daily URL Inspection quota exhausted",
        };
        continue;
      }
      try {
        const r = await inspectUrl(c.gsc_site_url, c.external_post_url);
        const now = new Date();
        await db
          .insert(indexCoverage)
          .values({
            postId: c.post_id,
            blogId: c.blog_id,
            clientId: c.client_id,
            inspectedUrl: c.external_post_url.slice(0, 2048),
            verdict: r.verdict,
            coverageState: r.coverageState,
            robotsTxtState: r.robotsTxtState,
            indexingState: r.indexingState,
            pageFetchState: r.pageFetchState,
            googleCanonical: r.googleCanonical,
            userCanonical: r.userCanonical,
            lastCrawlTime: r.lastCrawlTime ? new Date(r.lastCrawlTime) : null,
            raw: r.raw as object,
            lastCheckedAt: now,
          })
          .onConflictDoUpdate({
            target: indexCoverage.postId,
            set: {
              blogId: sql`excluded.blog_id`,
              clientId: sql`excluded.client_id`,
              inspectedUrl: sql`excluded.inspected_url`,
              verdict: sql`excluded.verdict`,
              coverageState: sql`excluded.coverage_state`,
              robotsTxtState: sql`excluded.robots_txt_state`,
              indexingState: sql`excluded.indexing_state`,
              pageFetchState: sql`excluded.page_fetch_state`,
              googleCanonical: sql`excluded.google_canonical`,
              userCanonical: sql`excluded.user_canonical`,
              lastCrawlTime: sql`excluded.last_crawl_time`,
              raw: sql`excluded.raw`,
              lastCheckedAt: now,
            },
          });
        results[i] = {
          postId: c.post_id,
          domain: c.domain,
          status: "inspected",
          verdict: r.verdict,
          coverageState: r.coverageState,
        };
      } catch (err) {
        if (isQuotaExhausted(err)) {
          exhausted = true;
          console.warn(
            `[gsc-coverage] daily URL Inspection quota exhausted after ${i} call(s) — stopping`,
          );
        }
        const message = err instanceof Error ? err.message : String(err);
        results[i] = {
          postId: c.post_id,
          domain: c.domain,
          status: "failed",
          message: message.slice(0, 200),
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(concurrency, batch.length)) },
      () => worker(),
    ),
  );

  const outcomes = results.filter(Boolean);
  const inspected = outcomes.filter((o) => o.status === "inspected").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  const byVerdict: Record<string, number> = {};
  for (const o of outcomes) {
    if (o.status !== "inspected") continue;
    const key = o.coverageState ?? o.verdict ?? "unknown";
    byVerdict[key] = (byVerdict[key] ?? 0) + 1;
  }
  const totalDurationMs = Date.now() - startedAt;

  console.info(
    `[gsc-coverage] shard ${shardIndex + 1}/${shardCount} complete in ${totalDurationMs}ms — ` +
      `inspected=${inspected} failed=${failed} quotaExhausted=${exhausted} ` +
      `(budget=${budget}, perSite=${perSite})`,
  );

  return {
    ...base,
    considered: batch.length,
    inspected,
    failed,
    quotaExhausted: exhausted,
    byVerdict,
    totalDurationMs,
    results: outcomes,
  };
}
