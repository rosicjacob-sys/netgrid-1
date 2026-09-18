/**
 * lib/services/pipeline-alerts.ts
 *
 * Threshold evaluation over cron_runs / pipeline_errors, with per-key
 * suppression and delivery through the existing Resend wrapper (T22).
 *
 * Called by /api/cron/alerts. Safe to call concurrently: the suppression
 * claim is a single atomic upsert, so duplicate evaluation cannot produce
 * duplicate email.
 *
 * Every threshold is a RATE with a minimum sample size. The whole point is
 * to separate one broken blog from a broken platform — an absolute count
 * cannot do that.
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { alertLog } from "@/lib/db/schema";
import { sendGenericEmail } from "@/lib/services/email";
import { recordPipelineError } from "@/lib/services/run-telemetry";

export type AlertSeverity = "warn" | "critical";

export interface FiredAlert {
  key: string;
  severity: AlertSeverity;
  title: string;
  /** One line of numbers: what tripped and by how much. */
  detail: string;
  /** First thing to check. Mirrors the runbook in the T22 SOP. */
  runbook: string;
}

// Expected interval between runs, per job, in minutes. Sourced from
// render.yaml — keep in sync when a schedule changes.
//   auto-publish       "0 * * * *"          hourly, 4 shards
//   semantic-linking   "20 * * * *"         hourly
//   post-verification  "0 0,6,12,18 * * *"  every 6h
//   link-exchange      "40 5 * * *"         daily
const JOB_INTERVAL_MINUTES: Record<string, number> = {
  "auto-publish": 60,
  "semantic-linking": 60,
  "post-verification": 360,
  "link-exchange": 1440,
};

/** Drizzle's neon-http driver returns { rows: [...] }, not an array. Same
 * defensive shape used at src/app/(admin)/messages/page.tsx. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const r = result as { rows?: T[] } | null;
  return r?.rows ?? [];
}

function pct(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

// ─── Aggregations ───────────────────────────────────────────────────────────

export interface CounterTotals {
  runs: number;
  published: number;
  failed: number;
  truncatedSalvaged: number;
  imageless: number;
  metaWriteUnverified: number;
  indexNowRejected: number;
  blockedRegenerate: number;
  linkingSkipped: number;
  deepseek: number;
  claude: number;
}

/** Sum the jsonb counter set for one job over the last N hours. */
async function totalsForJob(job: string, hours: number): Promise<CounterTotals> {
  const res = await db.execute(sql`
    SELECT
      count(*) AS runs,
      coalesce(sum((counters->>'published')::int), 0) AS published,
      coalesce(sum((counters->>'failed')::int), 0) AS failed,
      coalesce(sum((counters->>'truncatedSalvaged')::int), 0) AS truncated_salvaged,
      coalesce(sum((counters->>'imageless')::int), 0) AS imageless,
      coalesce(sum((counters->>'metaWriteUnverified')::int), 0) AS meta_write_unverified,
      coalesce(sum((counters->>'indexNowRejected')::int), 0) AS index_now_rejected,
      coalesce(sum((counters->>'blockedRegenerate')::int), 0) AS blocked_regenerate,
      coalesce(sum((counters->>'linkingSkipped')::int), 0) AS linking_skipped,
      coalesce(sum((counters->'providerUsed'->>'deepseek')::int), 0) AS deepseek,
      coalesce(sum((counters->'providerUsed'->>'claude')::int), 0) AS claude
    FROM cron_runs
    WHERE job = ${job}
      AND started_at > now() - (${hours} || ' hours')::interval
  `);
  const r = rowsOf<Record<string, string>>(res)[0];
  const n = (k: string) => Number(r?.[k] ?? 0);
  return {
    runs: n("runs"),
    published: n("published"),
    failed: n("failed"),
    truncatedSalvaged: n("truncated_salvaged"),
    imageless: n("imageless"),
    metaWriteUnverified: n("meta_write_unverified"),
    indexNowRejected: n("index_now_rejected"),
    blockedRegenerate: n("blocked_regenerate"),
    linkingSkipped: n("linking_skipped"),
    deepseek: n("deepseek"),
    claude: n("claude"),
  };
}

/** Read the operator's model setting straight from the table, bypassing the
 * 15s in-process cache in app-settings.ts (this runs in a different
 * process than the generator). */
async function currentContentModel(): Promise<string> {
  try {
    const res = await db.execute(sql`
      SELECT value FROM app_settings WHERE key = 'content_model' LIMIT 1
    `);
    return rowsOf<{ value: string }>(res)[0]?.value ?? "auto";
  } catch {
    return "auto";
  }
}

// ─── Rules ──────────────────────────────────────────────────────────────────

export async function evaluateAlerts(): Promise<FiredAlert[]> {
  const fired: FiredAlert[] = [];

  // 1. Liveness — is each job running at all? This is the failure mode that
  //    runs for months: an absent run produces no error to count.
  const liveness = await db.execute(sql`
    SELECT job, max(started_at) AS last_started
    FROM cron_runs
    WHERE started_at > now() - interval '7 days'
    GROUP BY job
  `);
  const lastByJob = new Map(
    rowsOf<{ job: string; last_started: string | null }>(liveness).map((r) => [
      r.job,
      r.last_started ? new Date(r.last_started).getTime() : 0,
    ]),
  );

  for (const [job, minutes] of Object.entries(JOB_INTERVAL_MINUTES)) {
    // No row in 7 days means the job has never run in this environment —
    // not the same thing as a job that stopped. Skip rather than page.
    if (!lastByJob.has(job)) continue;
    const last = lastByJob.get(job) ?? 0;
    const ageMin = (Date.now() - last) / 60000;
    if (ageMin > minutes * 2) {
      fired.push({
        key: `cron.dead.${job}`,
        severity: "critical",
        title: `Cron "${job}" has not run for ${Math.round(ageMin)} minutes`,
        detail: `Expected every ${minutes} min; last cron_runs row was ${Math.round(ageMin)} min ago.`,
        runbook:
          "Render dashboard -> the cron service for this job -> Events. " +
          "Check the container is not suspended and CRON_SECRET matches the web service.",
      });
    }
  }

  // 2-9. Rate rules over the counter totals. Extracted as a pure function so
  //      the thresholds are unit-testable without a database — an off-by-one
  //      here means either a missed outage or alert spam.
  const t6 = await totalsForJob("auto-publish", 6);
  const t24 = await totalsForJob("auto-publish", 24);
  const contentModel =
    t6.deepseek + t6.claude >= 50 ? await currentContentModel() : "auto";
  fired.push(...evaluateRateRules(t6, t24, contentModel));

  // 10. Per-blog silence — the complement of the rate alerts. Derived from
  //     the SAME canonical cadence the publisher schedules against
  //     (blogs.posting_plan, T17): expected interval = 168h / posts-per-week.
  //     Blogs with an empty plan are excluded — they cannot publish at all,
  //     which is reported as `unscheduled_blogs`, not as silence.
  const silent = await db.execute(sql`
    WITH cadence AS (
      SELECT
        b.id,
        b.domain,
        168.0 / GREATEST(
          b.posting_plan[1] + b.posting_plan[2] + b.posting_plan[3]
          + b.posting_plan[4] + b.posting_plan[5] + b.posting_plan[6]
          + b.posting_plan[7],
          1
        ) AS expected_hours,
        (SELECT max(gp.published_at)
           FROM generated_posts gp
          WHERE gp.blog_id = b.id AND gp.status = 'published') AS last_published
      FROM blogs b
      WHERE b.status = 'active'
        AND b.posting_plan <> '{0,0,0,0,0,0,0}'::integer[]
    )
    SELECT id, domain, expected_hours,
           EXTRACT(EPOCH FROM (now() - last_published)) / 3600 AS hours_since
    FROM cadence
    WHERE last_published IS NOT NULL
      AND now() - last_published > (expected_hours * 2 || ' hours')::interval
    ORDER BY hours_since DESC
    LIMIT 50
  `);

  for (const b of rowsOf<{
    id: string;
    domain: string;
    expected_hours: number;
    hours_since: number | null;
  }>(silent)) {
    fired.push({
      key: `blog.silent.${b.id}`,
      severity: "critical",
      title: `${b.domain} has not published in ${Math.round(Number(b.hours_since ?? 0))}h`,
      detail: `Cadence implies one post every ~${Math.round(Number(b.expected_hours))}h.`,
      runbook:
        "Query pipeline_errors for this blog_id. Look for a repeating code — 401/403 in the " +
        "message means expired WordPress application password or revoked Shopify scope. " +
        "Note that a credential failure sets status='generated', NOT 'failed', so it does " +
        "not appear in /api/admin/recent-failures.",
    });
  }

  // 11. Error spikes. The distinct-blog count is the whole trick: 25 hits on
  //     one blog is one broken site (already covered by blog.silent); 25
  //     across five blogs is a platform condition.
  const spikes = await db.execute(sql`
    SELECT code, count(*) AS n, count(DISTINCT blog_id) AS blogs
    FROM pipeline_errors
    WHERE created_at > now() - interval '1 hour'
      AND severity IN ('error', 'fatal')
    GROUP BY code
    HAVING count(*) >= 25 AND count(DISTINCT blog_id) >= 5
    ORDER BY count(*) DESC
  `);
  for (const s of rowsOf<{ code: string; n: string; blogs: string }>(spikes)) {
    fired.push({
      key: `error.spike.${s.code}`,
      severity: "critical",
      title: `${s.n} x ${s.code} across ${s.blogs} blogs in 1h`,
      detail: "Multiple distinct blogs affected — treat as a platform condition.",
      runbook:
        "Read 5 sample rows with their context jsonb. " +
        "Same message everywhere = upstream provider or credential class.",
    });
  }

  // 12. Fatals. No threshold — one is too many.
  const fatals = await db.execute(sql`
    SELECT count(*) AS n, string_agg(DISTINCT job, ', ') AS jobs
    FROM pipeline_errors
    WHERE created_at > now() - interval '1 hour' AND severity = 'fatal'
  `);
  const f = rowsOf<{ n: string; jobs: string }>(fatals)[0];
  if (Number(f?.n ?? 0) > 0) {
    fired.push({
      key: "error.fatal",
      severity: "critical",
      title: `${f.n} fatal pipeline error(s) in the last hour`,
      detail: `Jobs affected: ${f.jobs ?? "unknown"}.`,
      runbook:
        "SELECT * FROM cron_runs WHERE ok = false ORDER BY started_at DESC LIMIT 5 " +
        "and read fatal_error.",
    });
  }

  return fired;
}

/**
 * The rate rules, as a pure function over already-fetched totals.
 *
 * Every threshold is a ratio with a minimum sample size, so one broken blog
 * cannot page the team and a broken platform cannot hide behind volume.
 * `contentModel` only matters for the provider-cost rule.
 */
export function evaluateRateRules(
  t6: CounterTotals,
  t24: CounterTotals,
  contentModel: string,
): FiredAlert[] {
  const fired: FiredAlert[] = [];

  const attempts6 = t6.published + t6.failed;
  if (attempts6 >= 10 && pct(t6.failed, attempts6) > 0.2) {
    fired.push({
      key: "publish.failure_rate",
      severity: "critical",
      title: `Publish failure rate ${(pct(t6.failed, attempts6) * 100).toFixed(0)}% over 6h`,
      detail: `${t6.failed} failed of ${attempts6} attempts across ${t6.runs} runs.`,
      runbook:
        "Group pipeline_errors by code for the last 6h. " +
        "One dominant code with many distinct blog_ids = a shared cause.",
    });
  }

  // 3-8. Quality ratios over 24h, all gated on a 20-post minimum sample.
  const rules: Array<{
    key: string;
    num: number;
    threshold: number;
    severity: AlertSeverity;
    label: string;
    runbook: string;
  }> = [
    {
      key: "content.truncated",
      num: t24.truncatedSalvaged,
      threshold: 0.05,
      severity: "critical",
      label: "articles salvaged from truncated JSON",
      runbook:
        "Query pipeline_errors for JSON_TRUNCATION_SALVAGED and read context.maxTokens. " +
        "See T06 — the 4096-token clamp.",
    },
    {
      key: "content.imageless",
      num: t24.imageless,
      threshold: 0.05,
      severity: "warn",
      label: "posts published with no hero image",
      runbook:
        "Query pipeline_errors for IMAGE_* codes. A uniform message across blogs = " +
        "Google image API quota or auth; varied messages = prompt/safety rejections.",
    },
    {
      key: "meta.unverified",
      num: t24.metaWriteUnverified,
      threshold: 0.1,
      severity: "critical",
      label: "publishes with unconfirmed SEO meta",
      runbook:
        "Split META_WRITE_FAILED vs META_WRITE_SKIPPED vs metaStatus=unverified. " +
        "FAILED on WordPress = plugin endpoint or credentials. See T14.",
    },
    {
      key: "indexnow.rejected",
      num: t24.indexNowRejected,
      threshold: 0.1,
      severity: "warn",
      label: "IndexNow pings rejected",
      runbook:
        "Read context.status on INDEXNOW_REJECTED rows. 403 = key file unreachable at " +
        "context.keyLocation; curl it. See T15.",
    },
    {
      key: "scrubber.blocked",
      num: t24.blockedRegenerate,
      threshold: 0.05,
      severity: "warn",
      label: "posts published against a REGENERATE_NEEDED verdict",
      runbook:
        "Read context.critical on SCRUBBER_REGENERATE_IGNORED rows and check whether one " +
        "style profile dominates. See T07.",
    },
    {
      key: "linking.skipped",
      num: t24.linkingSkipped,
      threshold: 0.3,
      severity: "warn",
      label: "articles generated with zero internal links",
      runbook:
        "Confirm generated_posts.external_post_url is being written on publish. See T16.",
    },
  ];

  for (const r of rules) {
    if (t24.published < 20) continue;
    const ratio = pct(r.num, t24.published);
    if (ratio > r.threshold) {
      fired.push({
        key: r.key,
        severity: r.severity,
        title: `${(ratio * 100).toFixed(1)}% ${r.label} (24h)`,
        detail: `${r.num} of ${t24.published} published; threshold ${(r.threshold * 100).toFixed(0)}%.`,
        runbook: r.runbook,
      });
    }
  }

  // 9. Provider mix — purely a cost alert, and only meaningful in "auto" mode.
  //    Claude output is ~10x DeepSeek's price, so a silent brown-out that
  //    flips the fleet to Claude multiplies the bill with no other symptom.
  const calls6 = t6.deepseek + t6.claude;
  if (calls6 >= 50 && pct(t6.claude, calls6) > 0.5) {
    if (contentModel === "auto") {
      fired.push({
        key: "provider.claude_share",
        severity: "warn",
        title: `Claude served ${(pct(t6.claude, calls6) * 100).toFixed(0)}% of model calls (6h)`,
        detail: `${t6.claude} Claude vs ${t6.deepseek} DeepSeek calls while content_model='auto'.`,
        runbook:
          "Query pipeline_errors for PROVIDER_FALLBACK in the last 6h and read the message — " +
          "it carries DeepSeek's own error. Check DEEPSEEK_API_KEY and account balance.",
      });
    }
  }

  return fired;
}

// ─── Suppression + delivery ─────────────────────────────────────────────────

/**
 * Atomically claim the right to send `key`. Returns true for exactly one
 * caller per suppression window, even with four shards racing: the INSERT
 * ... ON CONFLICT DO UPDATE ... WHERE is a single statement, and the WHERE
 * clause makes the update a no-op (returning zero rows) when the existing
 * suppression has not expired.
 *
 * The table-qualified name in the WHERE is required — Postgres will not
 * parse the clause without it, and without the whole clause the upsert
 * always succeeds and every shard mails.
 */
async function claimAlert(key: string, hours: number): Promise<boolean> {
  try {
    const res = await db.execute(sql`
      INSERT INTO alert_suppression (alert_key, suppressed_until, updated_at)
      VALUES (${key}, now() + (${hours} || ' hours')::interval, now())
      ON CONFLICT (alert_key) DO UPDATE
        SET suppressed_until = EXCLUDED.suppressed_until,
            updated_at = now()
        WHERE alert_suppression.suppressed_until < now()
      RETURNING alert_key
    `);
    return rowsOf<{ alert_key: string }>(res).length > 0;
  } catch (err) {
    recordPipelineError({
      site: "pipeline-alerts.claim",
      code: "ACTIVITY_LOG_FAILED",
      severity: "error",
      message: `alert suppression claim failed for ${key}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      job: "alerts",
    });
    // Fail closed: no claim, no email. Better a missed alert than four.
    return false;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderEmail(a: FiredAlert): string {
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL || "https://netgrid-16f6.onrender.com";
  const color = a.severity === "critical" ? "#b42318" : "#b54708";
  return `
    <div style="font-family: sans-serif; max-width: 620px; margin: 0 auto;">
      <p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${color};margin:0 0 4px;">
        NETGRID pipeline ${a.severity}
      </p>
      <h2 style="color:#111;margin:0 0 12px;">${escapeHtml(a.title)}</h2>
      <p style="color:#333;margin:0 0 16px;">${escapeHtml(a.detail)}</p>
      <p style="color:#333;margin:0 0 4px;"><strong>Check first</strong></p>
      <p style="color:#333;margin:0 0 20px;">${escapeHtml(a.runbook)}</p>
      <a href="${appUrl}/api/admin/pipeline-health"
         style="display:inline-block;background:#111;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:500;">
        Open pipeline health
      </a>
      <p style="color:#888;font-size:12px;margin-top:24px;">
        alert key: ${escapeHtml(a.key)} — suppressed for
        ${process.env.ALERT_SUPPRESS_HOURS || "6"}h after this message.
      </p>
    </div>
  `;
}

export interface AlertRunResult {
  evaluated: number;
  sent: number;
  suppressed: number;
  failed: number;
  alerts: Array<{ key: string; severity: AlertSeverity; sent: boolean }>;
}

export async function evaluateAndSendAlerts(): Promise<AlertRunResult> {
  const fired = await evaluateAlerts();
  const suppressHours = Math.max(
    1,
    Number(process.env.ALERT_SUPPRESS_HOURS || "6"),
  );
  const recipients = (process.env.ALERT_EMAIL_TO || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const out: AlertRunResult = {
    evaluated: fired.length,
    sent: 0,
    suppressed: 0,
    failed: 0,
    alerts: [],
  };

  for (const a of fired) {
    const claimed = await claimAlert(a.key, suppressHours);
    if (!claimed) {
      out.suppressed++;
      out.alerts.push({ key: a.key, severity: a.severity, sent: false });
      continue;
    }

    const subject = `[NETGRID ${a.severity.toUpperCase()}] ${a.title}`;
    const html = renderEmail(a);

    let delivered = false;
    let deliveryError: string | null = null;

    if (recipients.length === 0) {
      deliveryError = "ALERT_EMAIL_TO is not set";
    } else {
      for (const to of recipients) {
        try {
          // sendGenericEmail takes ONE recipient and throws when
          // RESEND_API_KEY is unset (email.ts) — unlike sendMagicLink,
          // which has a dev fallback. Hence the per-recipient try.
          await sendGenericEmail(to, subject, html);
          delivered = true;
        } catch (err) {
          deliveryError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    // Always log the attempt, delivered or not. An operator must be able to
    // see "we alerted 40 times and nobody received it".
    try {
      await db.insert(alertLog).values({
        alertKey: a.key,
        severity: a.severity,
        subject: subject.slice(0, 300),
        body: `${a.detail}\n\nCheck first: ${a.runbook}`,
        delivered,
        deliveryError,
      });
    } catch (err) {
      console.error("[pipeline-alerts] alert_log insert failed:", err);
    }

    if (delivered) out.sent++;
    else out.failed++;
    out.alerts.push({ key: a.key, severity: a.severity, sent: delivered });
  }

  return out;
}
