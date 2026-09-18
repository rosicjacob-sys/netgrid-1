/**
 * lib/services/run-telemetry.ts
 *
 * Run-scoped telemetry for the cron pipeline (T22).
 *
 * Two things live here:
 *
 *   1. RunCounters       — the per-run tally (published, truncatedSalvaged,
 *                          imageless, providerUsed, ...). Deep call sites bump
 *                          these without knowing anything about the cron run
 *                          they are inside.
 *   2. recordPipelineError — the typed replacement for the console.warn
 *                          dead-ends. Buffers inside a run and flushes in one
 *                          batched insert; falls back to a detached single
 *                          insert outside a run.
 *
 * Both find the current run through an AsyncLocalStorage store, so nothing
 * between runAutoPublishCron and generateContent needs a new parameter.
 *
 * NOTHING in this module may throw. Telemetry that can break a publish is
 * worse than no telemetry. Every DB call is wrapped and swallowed.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { cronRuns, pipelineErrors } from "@/lib/db/schema";

// ─── Kill switch ────────────────────────────────────────────────────────────
// TELEMETRY_ENABLED=0 turns every DB write here into a no-op without
// touching the call sites. Counters still accumulate in memory (free) and
// console lines are still emitted, so the rollback is lossless-ish.
function telemetryEnabled(): boolean {
  return process.env.TELEMETRY_ENABLED !== "0";
}

// ─── Typed error codes ──────────────────────────────────────────────────────
// One code per failure class. Adding a code is a one-line change here plus
// the call site; the dashboard groups by this column.
export const PIPELINE_ERROR_CODES = [
  "SETTINGS_READ_FAILED",
  "PROVIDER_TRANSIENT",
  "PROVIDER_FALLBACK",
  "FIX_MODEL_EMPTY",
  "FIX_MODEL_LOOKUP_FAILED",
  "ISSUE_DESC_PARSE_FAILED",
  "SCENE_SUMMARY_FAILED",
  "NEWS_CONTEXT_FAILED",
  "NEWS_LINKS_FAILED",
  "TOPIC_SIMILARITY_ACCEPTED",
  "TOPIC_ATTEMPT_FAILED",
  "JSON_PARSE_RETRY",
  "JSON_REPAIRED",
  "JSON_TRUNCATION_SALVAGED",
  "SHAPE_RETRY",
  "SCRUBBER_REGENERATE_IGNORED",
  "SCRUBBER_LITE_VIOLATIONS",
  "IMAGE_HERO_FAILED",
  "IMAGE_BODY_FAILED",
  "IMAGE_HERO_RETRY_FAILED",
  "IMAGE_BODY_RETRY_FAILED",
  "IMAGE_PIPELINE_FAILED",
  "POST_HAS_NO_HERO_IMAGE",
  "INTERNAL_LINKS_UNAVAILABLE",
  "META_WRITE_FAILED",
  "META_WRITE_SKIPPED",
  "META_WRITE_UNVERIFIED",
  "INDEXNOW_KEY_MISSING",
  "INDEXNOW_DEPLOY_FAILED",
  "INDEXNOW_REJECTED",
  "INDEXNOW_THREW",
  "POST_SCAN_FAILED",
  "LIVE_HTML_UNREACHABLE",
  "LINK_EVENT_LOG_FAILED",
  "LINK_RESOLVE_FAILED",
  "AUTOCOMPLETE_HTTP",
  "AUTOCOMPLETE_FAILED",
  "ACTIVITY_LOG_FAILED",
  "PUBLISH_ATTEMPT_FAILED",
  // T07 — a post the scrubber gate stopped before it reached the platform.
  "SCRUBBER_PUBLISH_HELD",
  // T08 — the auto-publish day-slot guard.
  "PUBLISH_SLOT_CLAIM_LOST",
  "PUBLISH_ROWS_REAPED",
  "CRON_RUN_FATAL",
] as const;

export type PipelineErrorCode = (typeof PIPELINE_ERROR_CODES)[number];
export type PipelineErrorSeverity = "warn" | "error" | "fatal";

// ─── Counters ───────────────────────────────────────────────────────────────

export interface RunCounters {
  /** Blogs the run looked at (post shard filter). */
  considered: number;
  /** Blogs eligible to publish this tick. */
  due: number;
  published: number;
  failed: number;
  skipped: number;
  deferred: number;
  /**
   * Blogs whose UTC-day publishing slot was already held by another process
   * — the T08 idempotency guard firing. A subset of `skipped`. Steady state
   * is 0; anything above 0 means a cron shard was invoked twice.
   */
  claimLost: number;
  /** Articles whose JSON only parsed after truncation repair — the body
   * ends mid-sentence. See T06. */
  truncatedSalvaged: number;
  /** Articles whose JSON needed light or stray-quote repair (benign). */
  jsonRepaired: number;
  /** Articles that shipped with no hero image. */
  imageless: number;
  /** Articles that shipped with a hero but no body image. */
  bodyImageMissing: number;
  flaggedForReview: number;
  /** Scrubber returned REGENERATE_NEEDED and we published anyway. T07. */
  blockedRegenerate: number;
  /**
   * Posts the scrubber gate actually HELD (SCRUBBER_ENFORCEMENT=enforce).
   * Distinct from flaggedForReview, which counts posts that tripped the
   * scrubber whether or not enforcement stopped them. T07.
   */
  scrubberHeld: number;
  /** Publishes where SEO meta was not confirmed written. T14. */
  metaWriteUnverified: number;
  indexNowRejected: number;
  /** Articles generated with zero internal-link references available. T16. */
  linkingSkipped: number;
  /** Model calls by provider — calls, not posts. A run generating 12
   * articles makes ~24-36 calls (article + ideation + scene summary). */
  providerUsed: { deepseek: number; claude: number };
}

export type CounterKey = Exclude<keyof RunCounters, "providerUsed">;

export function emptyCounters(): RunCounters {
  return {
    considered: 0,
    due: 0,
    published: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
    claimLost: 0,
    truncatedSalvaged: 0,
    jsonRepaired: 0,
    imageless: 0,
    bodyImageMissing: 0,
    flaggedForReview: 0,
    blockedRegenerate: 0,
    scrubberHeld: 0,
    metaWriteUnverified: 0,
    indexNowRejected: 0,
    linkingSkipped: 0,
    providerUsed: { deepseek: 0, claude: 0 },
  };
}

// ─── Run context ────────────────────────────────────────────────────────────

interface BlogFrame {
  blogId: string | null;
  clientId: string | null;
  domain: string | null;
  postId: string | null;
}

type PipelineErrorRow = typeof pipelineErrors.$inferInsert;

interface RunContext {
  runId: string;
  job: string;
  shardIndex: number | null;
  shardCount: number | null;
  startedAt: Date;
  // Shared by reference across every withBlog() branch.
  counters: RunCounters;
  errors: PipelineErrorRow[];
  dropped: { n: number };
  background: Array<Promise<void>>;
  // Per-async-branch.
  frame: BlogFrame;
}

const MAX_BUFFERED_ERRORS = 500;
const ERROR_SAMPLE_SIZE = 25;
const INSERT_CHUNK = 100;

// Pinned on globalThis: Next can instantiate this module more than once
// (route bundle vs "use server" bundle, and again under turbopack in dev).
// Two AsyncLocalStorage instances would silently split the counters.
// Same reasoning as the lazy db proxy in src/lib/db/index.ts.
const g = globalThis as typeof globalThis & {
  __netgridRunAls?: AsyncLocalStorage<RunContext>;
};
const als = (g.__netgridRunAls ??= new AsyncLocalStorage<RunContext>());

function ctx(): RunContext | undefined {
  return als.getStore();
}

// ─── Public counter API ─────────────────────────────────────────────────────
// All no-ops outside a run, so call sites never need a guard.

export function bumpCounter(key: CounterKey, by = 1): void {
  const c = ctx();
  if (!c) return;
  c.counters[key] += by;
}

export function setCounter(key: CounterKey, value: number): void {
  const c = ctx();
  if (!c) return;
  c.counters[key] = value;
}

export function bumpProvider(provider: "deepseek" | "claude", by = 1): void {
  const c = ctx();
  if (!c) return;
  c.counters.providerUsed[provider] += by;
}

/** Snapshot of the live counters, for embedding in an HTTP response. */
export function snapshotCounters(): RunCounters | undefined {
  const c = ctx();
  if (!c) return undefined;
  return { ...c.counters, providerUsed: { ...c.counters.providerUsed } };
}

export function currentRunId(): string | undefined {
  return ctx()?.runId;
}

// ─── Blog frame ─────────────────────────────────────────────────────────────

/**
 * Run `fn` attributed to one blog. Shallow-clones the context so counters,
 * errors and background promises stay shared (same object references) while
 * the blog frame is per-branch — which is what makes attribution correct
 * with AUTO_PUBLISH_CONCURRENCY > 1.
 */
export function withBlog<T>(
  frame: {
    blogId?: string | null;
    clientId?: string | null;
    domain?: string | null;
    postId?: string | null;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const c = ctx();
  if (!c) return fn();
  return als.run(
    {
      ...c,
      frame: {
        blogId: frame.blogId ?? null,
        clientId: frame.clientId ?? null,
        domain: frame.domain ?? null,
        postId: frame.postId ?? null,
      },
    },
    fn,
  );
}

/** Attach the generated_posts row id to the current blog frame. */
export function setCurrentPostId(postId: string): void {
  const c = ctx();
  if (c) c.frame.postId = postId;
}

/**
 * Register detached work (IndexNow ping, per-post SEO scan) with the run so
 * the flush waits for it — bounded by TELEMETRY_BACKGROUND_WAIT_MS. Without
 * this, indexNowRejected would be recorded after the run row was written.
 */
export function trackBackground(p: Promise<unknown>): void {
  const c = ctx();
  if (!c) return;
  c.background.push(
    p.then(
      () => undefined,
      () => undefined,
    ),
  );
}

// ─── Typed error recording ──────────────────────────────────────────────────

export interface PipelineErrorInput {
  /** Code location: "<file-or-module>.<operation>", max 64 chars. */
  site: string;
  code: PipelineErrorCode;
  message: string;
  severity?: PipelineErrorSeverity;
  blogId?: string | null;
  clientId?: string | null;
  postId?: string | null;
  context?: Record<string, unknown>;
  /** Only needed outside a run scope; defaults to the run's job. */
  job?: string;
}

/**
 * Record a typed failure. Synchronous, never throws, never awaited.
 *
 * Inside a run: buffered and flushed in one batched insert at run end.
 * Outside a run: detached single insert.
 */
export function recordPipelineError(input: PipelineErrorInput): void {
  const c = ctx();
  const severity: PipelineErrorSeverity = input.severity ?? "error";

  const row: PipelineErrorRow = {
    runId: c?.runId ?? null,
    job: (c?.job ?? input.job ?? "adhoc").slice(0, 64),
    site: input.site.slice(0, 64),
    code: input.code,
    severity,
    blogId: input.blogId ?? c?.frame.blogId ?? null,
    clientId: input.clientId ?? c?.frame.clientId ?? null,
    postId: input.postId ?? c?.frame.postId ?? null,
    message: (input.message || "(no message)").slice(0, 4000),
    context: input.context ?? null,
  };

  // Keep a console line: Render's live log tail stays useful, and it is the
  // only output when TELEMETRY_ENABLED=0. Format is uniform and greppable.
  const label = `[pipeline] ${severity.toUpperCase()} ${row.code} @ ${row.site}`;
  if (severity === "warn") console.warn(label, row.message);
  else console.error(label, row.message);

  if (!telemetryEnabled()) return;

  if (c) {
    if (c.errors.length < MAX_BUFFERED_ERRORS) c.errors.push(row);
    else c.dropped.n++;
    return;
  }

  // Outside a cron run: manual "Generate now", a /r/ redirect, a webhook.
  // Drizzle query builders are thenable and expose .catch().
  void db
    .insert(pipelineErrors)
    .values(row)
    .catch((err) => {
      console.error("[run-telemetry] pipeline_errors insert failed:", err);
    });
}

// ─── Run wrapper ────────────────────────────────────────────────────────────

/**
 * Establish a telemetry run around `fn`. Persists exactly one cron_runs row
 * plus the buffered pipeline_errors, whether `fn` resolves or throws.
 * A throw is re-thrown after the flush so the route's own error handling is
 * unchanged.
 */
export async function runWithTelemetry<T>(
  opts: { job: string; shardIndex?: number | null; shardCount?: number | null },
  fn: () => Promise<T>,
): Promise<T> {
  const c: RunContext = {
    runId: randomUUID(),
    job: opts.job,
    shardIndex: opts.shardIndex ?? null,
    shardCount: opts.shardCount ?? null,
    startedAt: new Date(),
    counters: emptyCounters(),
    errors: [],
    dropped: { n: 0 },
    background: [],
    frame: { blogId: null, clientId: null, domain: null, postId: null },
  };

  return als.run(c, async () => {
    let ok = true;
    let fatal: string | null = null;
    try {
      return await fn();
    } catch (err) {
      ok = false;
      fatal = err instanceof Error ? err.message : String(err);
      recordPipelineError({
        site: `${opts.job}.run`,
        code: "CRON_RUN_FATAL",
        severity: "fatal",
        message: fatal,
      });
      throw err;
    } finally {
      await settleBackground(c);
      await flush(c, ok, fatal);
    }
  });
}

/** Wait (bounded) for detached IndexNow / post-scan work to land. */
async function settleBackground(c: RunContext): Promise<void> {
  if (c.background.length === 0) return;
  const capMs = Math.max(
    0,
    Number(process.env.TELEMETRY_BACKGROUND_WAIT_MS || "15000"),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((r) => {
    timer = setTimeout(r, capMs);
  });
  try {
    await Promise.race([Promise.allSettled(c.background), cap]);
  } catch {
    // allSettled never rejects; this is belt-and-braces.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function flush(
  c: RunContext,
  ok: boolean,
  fatal: string | null,
): Promise<void> {
  if (!telemetryEnabled()) return;

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - c.startedAt.getTime();

  try {
    await db.insert(cronRuns).values({
      id: c.runId,
      job: c.job,
      shardIndex: c.shardIndex,
      shardCount: c.shardCount,
      startedAt: c.startedAt,
      finishedAt,
      durationMs,
      ok,
      counters: c.counters,
      errorCount: c.errors.length + c.dropped.n,
      errorSample: c.errors.slice(0, ERROR_SAMPLE_SIZE).map((e) => ({
        code: e.code,
        site: e.site,
        severity: e.severity,
        blogId: e.blogId,
        message: String(e.message).slice(0, 400),
      })),
      fatalError: fatal,
    });
  } catch (err) {
    console.error("[run-telemetry] cron_runs insert failed:", err);
  }

  // One HTTP round-trip per statement on the neon-http driver, so batch.
  for (let i = 0; i < c.errors.length; i += INSERT_CHUNK) {
    const chunk = c.errors.slice(i, i + INSERT_CHUNK);
    try {
      await db.insert(pipelineErrors).values(chunk);
    } catch (err) {
      console.error("[run-telemetry] pipeline_errors insert failed:", err);
    }
  }

  console.info(
    `[run-telemetry] ${c.job}` +
      (c.shardIndex !== null ? ` shard=${c.shardIndex}/${c.shardCount}` : "") +
      ` run=${c.runId} ok=${ok} ${durationMs}ms ` +
      `published=${c.counters.published} failed=${c.counters.failed} ` +
      `truncated=${c.counters.truncatedSalvaged} imageless=${c.counters.imageless} ` +
      `errors=${c.errors.length + c.dropped.n}`,
  );
}
