# NetGrid remediation programme — status

Where we left off, for whoever picks this up next.

**Source of truth for the work itself:** the 27 SOPs (`T00`–`T26`) from
`netgrid-remediation-sops.zip`. `T00` is the roadmap and dependency map; read it
before assigning anything. This file only tracks *what has been done against
them* — it does not restate the tasks.

**Branch:** `claude/dazzling-maxwell-7qwt7b` · **PR:**
[#137](https://github.com/rosicjacob-sys/netgrid-1/pull/137)

**Last updated:** 2026-09-18

---

## Verification status

**The branch compiles, lints, tests and builds clean.**

The npm registry was unreachable for most of the work on this branch
(`503 upstream connect error` on every attempt, direct and proxied), so
everything from T07 through T16 was written without a compiler. The registry
came back after T16 landed, and the full suite has now been run:

| Check | Result |
|---|---|
| `npm ci` | **Was broken.** T04 added `googleapis` to `package.json` without regenerating the lockfile, so `npm ci` — which Render's build command uses — failed with `EUSAGE ... Missing: googleapis@144.0.0 from lock file`. Fixed by committing the regenerated `package-lock.json`. |
| `npx tsc --noEmit` | Clean. Two real errors found and fixed — see below. |
| `npm run lint` | Clean, no warnings. |
| `npx vitest run` | 22 files, 277 tests, all passing. |
| `npm run build` | Succeeds. |

### What the compiler caught that the hand-rolled checks did not

The substitute checks used while the registry was down (TypeScript *syntactic*
diagnostics plus executing pure functions under a vitest shim) caught three
real defects during the work, but they cannot see types. The full compiler
found three more:

1. **`npm ci` was broken on this branch** — the lockfile/manifest mismatch
   above. This would have failed the Render build on the next deploy,
   regardless of any code change.
2. **`gsc-sync/route.ts` — `provisioned` used before assignment** (T04).
   Declared as a bare `let` and read inside a `verify`-gated block; TS cannot
   see that correspondence.
3. **`wp-client.ts` — `META_NOT_LIVE` was not in `PipelineErrorCode`** (T14).
   The new telemetry code was emitted but never added to the union.

A stale `tsconfig.tsbuildinfo` initially masked the third one after it was
fixed — `incremental: true` is set in `tsconfig.json`, so delete that file if a
type error survives an edit that plainly fixes it.

### Still not verified by any of this

`tsc`/`lint`/`vitest`/`build` prove the code is internally consistent. They say
nothing about behaviour against live systems. The acceptance sections of each
SOP — the `psql` probes and the live smoke tests — are still outstanding, and
the operator actions below are still required.

---

## Status: 15 of 26 done, 11 remaining — **Phase 3 started**

### Done before this session

| | Task | Notes |
|---|---|---|
| **T01** | Reddit token removal | `src/lib/seo/meta-suffix.ts` replaced the injector |
| **T02** | Shared tracking host | Direct UTM links; `link-tracker.ts` retired; backfill tooling in `scripts/t02-*` |
| **T06** | Token clamp / truncation | `content-token-budget.ts` + `DEEPSEEK_MAX_OUTPUT_TOKENS` |
| **T22** | Pipeline telemetry | `cron_runs`, `pipeline_errors`, `alert_log`, `/api/admin/pipeline-health` |

### Done this session

| | Task | What landed |
|---|---|---|
| **T07** | Scrubber publish gate | **The gate had no caller.** `shouldHoldForReview()` was exported and unit-tested but never invoked, so `SCRUBBER_ENFORCEMENT=enforce` changed one word in a log line and blocked nothing. Now called on both automatic publish paths. `publishGeneratedPost` stays ungated — it is how a reviewer *releases* a held draft. |
| **T08** | Publish idempotency | `publish_day` + `day_slot` with a partial unique index; `cron/invoke.sh` retry/timeout fix; strict shard validation (400, not silent default); `reapStuckPublishes()`; `transient` on the result type so the worker-pool retry is reachable. Migration `0040`. |
| **T03** | Link exchange shutdown | Engine hard-retired behind `LINK_EXCHANGE_RETIRED`; route returns 410 and imports nothing from the service; admin toggle refuses to re-enable; new `link-exchange-removal.ts` stripper + queue + cron. Migration `0041`. |
| **T04** | Search Console feedback loop | `gsc-client.ts`, `gsc-verifier.ts`, `gsc-sync.ts`, `gsc-index-coverage.ts`, two cron routes, `search_performance` + `index_coverage` tables, 7 Render cron services. Migration `0042`. |
| **T15** | IndexNow + sitemaps | IndexNow could not have worked on either platform. The WordPress key went into the media library and Shopify's was a themed HTML page — and IndexNow **scopes a key file to its own directory**, so neither authorised a single post URL. Failures were `console.warn` only, so a 100% failure rate looked exactly like a 100% success rate. Now: per-blog keys, a root-served key file via a new MU-plugin, verification of the actual file before any ping, an `index_ping_events` audit table, and the Google path via Search Console sitemap submission. Shopify is deliberately sitemap-only. Migration `0049`. |
| **T16** | Internal linking wiring | The relink hook had two call sites, both in the manual admin UI — it never fired for the auto-publish cron, which is the dominant publish path. So a cron-published post waited for the hourly backfill and its older siblings never linked forward at all. Now called from `runGenerateAndPublish`, behind a `SEMANTIC_LINK_ON_PUBLISH` kill switch that covers all three paths. Also: inline link candidates are chosen topically instead of by recency (same hybrid formula as the Related-posts engine), the full-text dictionary follows the post's language instead of always `english`, related posts are restricted to the same language, every link target is canonicalised, and the backfill budget is split into a new lane and a stale-refresh lane. Migration `0048`. |
| **T14** | Yoast meta no-op | Every Yoast WordPress post published with the theme's default title and no meta description, while the log said "(SEO meta set)". Three independent reasons, all returning HTTP 200. Fixed: new `docs/wordpress/netgrid-seo-bridge.php` MU-plugin registers the real `_yoast_wpseo_*` keys for REST with an `auth_callback` and refreshes Yoast's indexable cache; `updateYoastMeta` writes those keys and throws when the bridge is absent; every write is now confirmed against the live `<head>` before anything is called a success. `metaStatus: "written"` now requires live verification. Per-post result persisted on `generated_posts`, bridge version per blog, and a measure-then-repair backfill. Migration `0047`. |
| **T10** | Keyword pipeline at scale + ledger draining | The weekly refresh scraped every client in one unordered sequential pass (~5 h at 1,500 clients), so it never returned and the ledger rebuild after it never ran at all. Now 4-way sharded, hourly, staggered, with a staleness cursor on `clients.keywords_refresh_attempted_at` stamped *before* the scrape. `markKeywordTargetFailed` no longer buries a row in `failed` on the first transient error — bounded retries with a cool-off, dead-lettering only once the budget is spent, plus a two-window reaper that respects in-flight posts. Scrape locales now come from the client's own blogs instead of guessing from `language_mode`. A blocked scrape is reported instead of looking like "no results". The DataForSEO provenance downgrade is fixed. Migration `0046`, which also releases the existing permanent graves. |
| **T18** | Post-verification at scale | The sweep was a single unordered sequential loop over every active blog under `curl --max-time 660 --retry 3` — it never finished, and curl retried it three more times while the abandoned handler kept running. Now 4-way sharded (same hash partition as auto-publish, pinned by golden-value tests), concurrency-capped, wall-clock budgeted, ordered least-recently-verified-first so nothing starves, with batched writes, a persisted run summary in `activity_log`, coverage/silence alerts, and a retention prune. `posts_in_period` is a real 7-day count for the first time. The sweep no longer stamps `blogs.lastPostVerifiedAt` — that column is the auto-publish priority key. `vercel.json` deleted (two of its five schedules 404'd, two exactly duplicated Render). Migration `0045`. |
| **T13** | Composer repair | Every non-peptide blog in the network was writing from **one** template. `buildStructuralPool` filtered on `subNicheFit` at all three tiers, and no template declares a sub-niche above 13 — so the pool came back `[]` for sub-niches 14-90 and `pickTemplateForPost` silently served `TEMPLATES[1]`, peptide section labels ("Mechanism — how the compound works at cellular level") included, on every roofing, loans and casino post ever published. Separately `archetypeForVoice` scanned only the `voiceRange` bands, which stop at V77, so all 50 cross-niche voices collapsed onto archetype 1 and 5 of 12 skeletons were unreachable. Now: 22 niche-neutral flow variants (`CROSS_NICHE_FLOWS`), a 6-tier pool ladder with a sub-niche-agnostic floor, `archetypeForVoice` reading the voice's declared archetype, and the three dead compatibility guards (`SubNiche`, `Cadence`, `Strictness`) finally called. Two strings that were being ordered into published HTML are gone: the literal `(no compliance phrase required for this niche)` and the raw token `{citation.style}`. No migration — data repair only, via `src/lib/db/repair-structural-pools.ts`. |
| **T17** | Cadence integrity | One canonical `blogs.posting_plan integer[7]` replaces four disagreeing columns. New pure module `src/lib/posting-plan.ts`; publisher, verifier, pipeline-alerts, validators, CSV importer, form, admin + portal UIs all read it. Publish window narrowed to 0–17h so no blog has a single tick of runway. `?dry=1` on the auto-publish route. "No posting plan" is now a critical notification and an `activity_log` row, not a discarded JSON string. Migration `0043`; `0044_drop_legacy_cadence.sql.pending` written but inert. |

### Remaining: 11

Grouped by the phase plan; ordering follows T00's dependency map.

**Phase 3 — content & targeting (6 of 7 left)**

`T13` composer repair is **done**. Next: `T09` winnability → `T11` ideation
grounding → `T05` prompt rewrite → `T21` prompt contradictions; plus `T12`
author entities → `T20` FAQ structured data. **Order is load-bearing:**
composer before prompts, difficulty before winnability before ideation.

`T09` is **blocked** on a `DATAFORSEO_MONTHLY_BUDGET` figure — T10 Step 10 (the
budgeted DataForSEO cron) was deliberately not built pending that sign-off, and
T09's difficulty scoring depends on it.

**Phase 4 — hygiene (5)**

`T19` real quality score (still `seoScore: 70` hardcoded at
`content-generator.ts:3988`) · `T23` HTML post-processor · `T24`
robots/canonicals/hreflang/jitter · `T25` autofix hardening · `T26` image
pipeline.

---

## Bugs found while implementing

Three defects the SOPs' own code carried, caught by executing it rather than
reading it. Worth knowing about because the SOPs are otherwise reliable.

1. **`a ?? b || c` is a JS syntax error** — appeared three times in T04's code
   (`gsc-sync.ts` concurrency, `gsc-index-coverage.ts` budget and perSite).
   Mixing `??` with `||` without parentheses does not parse. Would have failed
   `npm run build`. Fixed by parenthesising the `||` group.

2. **`tagOpenIndex` was not quote-aware** (T03 stripper). It walked *backwards*
   from the marker looking for `<`, bailing on the first `>` — but a `>` inside
   a quoted `href` is not a tag end. `tagCloseIndex` scanning forward *was*
   quote-aware, so the two disagreed. Behaviour was safe (it refused to splice
   rather than corrupting) but it dumped ordinary posts into manual triage.
   Rewritten to scan forward with the same quote-aware boundary logic.

3. **A raw `0x00` byte landed in `gsc-sync.ts`** instead of the ``\u0000``
   escape, making it a binary file. Functionally identical, invisible in
   review, and hostile to tooling. Replaced with the escape sequence.

---

## Operator actions that are NOT code

These block acceptance and nobody but a human can do them.

- **T13 — run the structural-pool repair after this deploys, not before.**
  `npx tsx src/lib/db/repair-structural-pools.ts --dry-run`, read the sample,
  then run it without the flag. It rebuilds the empty `structural_pool` arrays
  every non-peptide profile was written with, and re-picks any `skeleton_id`
  the newly-live guards reject. It calls `buildStructuralPool` and
  `pickSkeleton` directly, so **run against the old code it would rewrite
  every row with the same empty arrays it exists to repair.** Idempotent, so
  re-running is safe. If `src/lib/db/repair-compounds.ts` is also queued, run
  that one first — different columns, neither reads the other's output. Snapshot
  first if you want an undo path: `CREATE TABLE style_profiles_backup_t13 AS
  SELECT blog_id, structural_pool, skeleton_id FROM style_profiles;`
- **T13 — grep the logs for `[composer] empty structuralPool` for 24h after
  the backfill.** Any hit is a profile the repair missed; re-run it.

- **T03 — the removal sweep touches ~1,500 live client sites.** The code, the
  queue and the dry-run mode are built; *running* it is a deliberate trigger,
  not something to schedule blindly. Start with
  `?blogId=<uuid>&dryRun=1&limit=25` on one blog, read the diff, then go live
  on that one blog, then let the `*/10` cron drain. T03 §7.3–7.5.
- **T03 — suspend `netgrid-cron-link-exchange` in the Render dashboard now.**
  `render.yaml` no longer defines it, but until the blueprint syncs, the daily
  05:40 UTC run keeps placing links. Delete the service after the deploy lands.
- **T04 — Google Cloud setup.** Create the project, enable
  `searchconsole.googleapis.com` and `siteverification.googleapis.com`, mint a
  service-account key, and set `GSC_SERVICE_ACCOUNT_EMAIL` /
  `GSC_SERVICE_ACCOUNT_PRIVATE_KEY` on the **web** service only. T04 §4.1.
  Until both are set every GSC route no-ops with a 200 — that is the kill switch.
- **T04 — ~1,400 DNS TXT records.** WordPress blogs cannot be verified
  automatically (an application password cannot write site-wide `<head>` markup
  or install a plugin). The code fetches and stores each token; an operator or
  a registrar-API script publishes it. The worklist query is in T04 §7.1. **This
  is the long pole of the whole programme** and it can start before any of this
  code deploys — tokens are stable per domain.
- **T04 — run the 16-month backfill on day one.** Search Console retains 16
  months on a rolling window. Every day of delay permanently loses a day of the
  network's only objective history. Driver script in T04 §7.2.
- **T04 — record the baseline** (T04 §8.3 query D) *before* T01–T03's effects
  land, and keep it outside the database. It is the only before-picture this
  programme will ever have.
- **T07 — decide when to flip `SCRUBBER_ENFORCEMENT` to `enforce`.** It ships
  as `shadow`. Now that the gate is actually wired, flipping it will start
  holding posts. Read a week of `[scrubber-gate]` log lines first to see what
  fraction of the network it would stop.
- **T17 — sign off on two behaviour changes BEFORE `0043` is applied.** Migration
  `0043` re-interprets a bare number in `posting_frequency` as posts-per-**week**
  (it currently means posts-per-**day**, i.e. 7x more), and starts honouring the
  `posts_per_day` column for blogs that publish nothing today. Run the audit
  queries in T17 §7.1–7.2 and get the affected domain list agreed. Pause
  `netgrid-cron-auto-publish-0..3` for the deploy window.
- **T17 — work the triage queue.** Everything migration `0043` could not
  classify lands on the zero plan and raises the new critical notification.
  Query in T17 §7.4; fix each in the blog form.
- **T17 — add a Render log alert on `[auto-publish][ALERT]`** against the web
  service. Shard 0 emits it at most once an hour, only when the count is
  non-zero.
- **T18 — delete `netgrid-cron-post-verification` in the Render dashboard.**
  Removing a service from the blueprint does not delete it. Until someone
  suspends it by hand it keeps firing at `0 0,6,12,18` with no shard
  parameters — the full unsharded sweep, on top of the four new sharded ones.
- **T18 — confirm no Vercel deployment is live before this merges.** This
  commit deletes `vercel.json`. Two of its five schedules pointed at routes
  that do not exist and two exactly duplicated Render, but if some Vercel
  deployment is serving traffic for a domain nobody mentioned, deleting the
  file stops five jobs there rather than two duplicates here.
- **T18 — repair `blogs.last_post_verified_at`.** The sweep has been
  overwriting it with "time of last check" for every blog it reached; it means
  "time of our last publish" and is the auto-publish priority key. Re-derive it
  from `MAX(generated_posts.published_at WHERE status='published')` once, after
  deploy. T18 §7.
- **T18 — set `ALERT_EMAIL_TO`** on the web service, or coverage and
  silent-blog alerts are console + `activity_log` only.
- **T10 — delete `netgrid-cron-refresh-keywords` in the Render dashboard**, and
  populate `CRON_SECRET` on the four new `...-refresh-keywords-N` services
  (it is `sync: false`, so Render prompts rather than copying it).
- **T10 — watch `activity_log` for `keywords.scrape_blocked`** after deploy. If
  it appears, halve `KEYWORD_SCRAPE_CONCURRENCY` first, then
  `KEYWORD_REFRESH_MAX_CLIENTS`. Do not "fix" it by spoofing a browser
  User-Agent — that hides the next block instead of reporting it.
- **T14 — deploy `docs/wordpress/netgrid-seo-bridge.php` to every Yoast site.**
  It goes at `wp-content/mu-plugins/netgrid-seo-bridge.php`, directly in that
  directory (WordPress does not recurse into subdirectories). **Nothing in T14
  works on a site without it** — `updateYoastMeta` now throws there instead of
  silently succeeding, which is the point, but it means Yoast meta writes fail
  loudly until the rollout lands. T14 §5 Step 3 covers doing this at 1,500-site
  scale. Run a connection test afterwards to populate `blogs.seo_bridge_version`.
- **T14 — then run the backfill, per blog, measure first.**
  `/api/cron/yoast-meta-backfill?blogId=<uuid>&dryRun=1` reports the real damage
  without writing; drop `dryRun` to repair. Only sweep the network once one blog
  shows `stillBroken: 0`. It skips un-bridged blogs by default.
- **T15 — roll out the second MU-plugin.** `docs/indexnow/netgrid-indexnow.php`
  goes at `wp-content/mu-plugins/netgrid-indexnow.php`. Without it a site has
  no spec-compliant key file and every IndexNow ping is rejected — but now it
  is *recorded* as rejected instead of looking fine. `docs/indexnow/README.md`
  has the install and verification commands.
- **T15 — run `npm run db:backfill-indexnow` (dry run first).** It mints
  per-blog keys, deletes the junk "IndexNow Verification" page the old code
  published on every Shopify storefront, and prints the MU-plugin worklist.
  **Then delete `INDEXNOW_KEY` from Render** — in that order, because the old
  value is the only way to find the junk media uploads it names.
- **T15 — the service account needs Full user on each Search Console
  property.** `sitemaps.submit` returns 403 with no useful hint otherwise, and
  Restricted is not enough. The property must already be verified by a human;
  the API cannot verify one.
- **T19, when you get to it, needs a communications plan.** It makes
  client-facing scores drop sharply. T00 §4 is explicit that it should be
  scheduled, not shipped opportunistically.

---

## Migration numbering

The SOPs assume the next free migration is `0039`. It was not — `0039` is
`pipeline_telemetry` from T22. Actual numbering on this branch:

| File | Task |
|---|---|
| `0040_publish_idempotency.sql` | T08 |
| `0041_link_exchange_shutdown.sql` | T03 |
| `0042_search_console.sql` | T04 |
| `0043_posting_plan.sql` | T17 |
| `0045_post_verification_retention.sql` | T18 |
| `0046_keyword_pipeline_scale.sql` | T10 |
| `0047_yoast_meta_verification.sql` | T14 |
| `0048_semantic_linking_refresh.sql` | T16 |
| `0049_indexnow_per_blog_keys.sql` | T15 |
| `0044_drop_legacy_cadence.sql.pending` | T17 follow-up — **inert**, the runner globs `*.sql` |

If you apply an SOP verbatim, **check the highest existing file first.**

---

## Known gaps in what was shipped

Flagged deliberately rather than quietly left.

- **T13 found four peptide-vocabulary leaks the SOP did not list**, and its
  own acceptance criteria could not pass without fixing them. The SOP treats
  `templates.ts` as the only library carrying peptide-specific text. It is
  not: three of five `citation-styles.ts` examples are peptide research
  ("a 2020 paper published in Peptides", "the BPC-157 thread on r/Peptides"),
  five `quirks.ts` prompt instructions reach for compounds, vials and mcg
  doses (quirk 8 names BPC-157 and "pentadecapeptide" outright), and
  `BLOCK_COMPLIANCE`'s prohibition list is peptide vocabulary — which reaches
  **gambling and online_casino**, because those niches do carry compliance
  phrases and so take the phrase-bearing block, not the SOP's phrase-free
  one. All four are fixed the same way `CROSS_NICHE_FLOWS` fixes templates:
  peptide sub-niches (1-13) keep the original string byte-for-byte, everything
  else resolves a subject-neutral variant. `BLOCK_COMPLIANCE_NEUTRAL_SUBJECT`
  keeps the phrase machinery identical and swaps only the prohibition list.
  Quirk `detector` functions are deliberately **not** varied — they run over
  generated prose in the scrubber, and loosening them is a separate decision.
- **T13's peptide path is not byte-identical, contrary to the SOP's §7.3
  claim** — and that is correct. A pinned differential across 4 peptide
  sub-niches × 12 skeletons × 3 templates shows exactly two differences, both
  intended fixes that happen to land on peptides too: `{citation.style}` now
  substitutes instead of shipping the raw token to the model, and skeleton
  12's compliance clause moved onto its own line. Nothing else moved — no flow
  label, no compliance block, no quirk. Re-run that check before touching the
  composer again; the harness is three files and a `git stash`.
- **T13 changes the RNG draw order.** `pickCadence` now runs before
  `pickSkeleton`, so for a given `blogId` seed `assignProfile` produces a
  different profile than it did before this deploy. Persisted rows are
  untouched and nothing recomputes them, but **`reassignProfile` is no longer
  idempotent across the deploy** — an admin re-roll returns a different
  profile than the same re-roll would have yesterday. Say so in the release
  note.
- **Peptide sub-niche 13 (Sleep / circadian, ~40 blogs) changes behaviour**,
  which is the one peptide-side improvement to expect. It is listed in exactly
  one template's `subNicheFit` (T17), so the old tier 3 returned a
  **one-template pool** and every sleep/circadian blog wrote from T17 forever.
  It now falls through to tier 4 and gets a proper 3-5 pool. No other peptide
  sub-niche moves.
- **`resolveShard` throws outside the telemetry wrapper** (T08). A bad shard
  param from a non-route caller won't get a `cron_runs` row. The route
  validates first and returns 400, so this is defence-in-depth only.
- **Held posts send their keyword target to a terminal `failed`** (T07),
  matching the neighbouring publish-failure path. That is the ledger-draining
  bug T10 owns; this deliberately did not diverge ahead of that fix.
- **`shopifyCredsFromBlog` is now one implementation** in
  `src/lib/services/shopify-creds.ts` (T04 assigned this to T15). The nullable
  `shopify_auth_mode` defaulting to `client_credentials` was being re-derived
  at four sites; getting it wrong in one silently breaks auth for every
  legacy-token store in that subsystem.
- **The `netgrid-gsc` and `netgrid-seo` theme markers must stay distinct.**
  Both write into the same Shopify theme assets and are kept apart only by
  their marker strings. Generalising either regex to `netgrid-\w+` would make
  one subsystem silently delete the other's block, and affected stores would
  lose Search Console ownership with no error raised. Do not "tidy" them.
- **T17 ships a legacy dual-write.** `createBlog`, `updateBlog` and both CSV
  insert paths still write `posting_frequency` / `posting_frequency_days` so a
  code rollback has data to read. Nothing *reads* them. Delete the three
  `LEGACY DUAL-WRITE` blocks and rename `0044_...pending` one week after
  `0043` lands, not before.
- **T18's shard parser is strict where the SOP specified lenient.** The SOP
  collapses a malformed `?shard`/`?shardCount` to (0 of 1). That is the
  failure mode T08 already fixed on the auto-publish route, and here it is
  worse: a typo turns the shard filter into a no-op, so one service sweeps the
  whole network — the unsharded run that blows through curl's `--max-time` and
  gets retried. The route answers 400 instead, which curl does not retry.
- **`pipeline-alerts.ts` was a fourth cadence reader the T17 SOP did not know
  about** — T22 added it after the SOP was written. Its raw-SQL silence rule
  now derives `expected_hours` from `posting_plan` like everything else. If you
  add another cadence consumer, it reads `posting_plan` or it is a bug.
- **T10 Step 10 (the budgeted DataForSEO cron) is NOT implemented.** The SOP
  gates it behind `DATAFORSEO_CRON_ENABLED` and says explicitly that it can
  ship in a follow-up deploy without blocking the rest. It also spends real
  money on a schedule and needs a finance-approved
  `DATAFORSEO_MONTHLY_BUDGET` derived from measured per-seed cost (T10 §5
  Step 10 has the queries). **T09 depends on it** for keyword difficulty data
  — do it before starting T09.
- **T10 reuses `src/lib/cron/sharding.ts` rather than adding the SOP's
  `src/lib/cron/shard.ts`.** Same function, same SHA1 bytes 8-15; T18 already
  extracted it. A second copy would be the drift the extraction exists to
  prevent.
- **T10 replaced T08's `releaseStuckKeywordTargets`** with a two-window reaper.
  T08's version ignored `generated_post_id` and could reap a row whose post was
  mid-publish, handing the same keyword out twice. The old name survives as a
  shim so the auto-publish hot path did not change.
- **T14's backfill requires the bridge by default**, which the SOP left as an
  operator discipline note. Without that filter every post on an un-bridged blog
  burns a live fetch plus a REST write, comes back `stillBroken`, and stays in
  the candidate set — so the next run does it all again. `requireBridge=0` is
  available for a deliberate dry-run measurement.
- **T16 fixed a pre-existing bug in `toCanonicalUrl` rather than copying it
  verbatim as the SOP instructed.** The `URL.host` setter parses its value as
  `host[:port]` and *leaves the existing port* when the value carries none, so
  a self-hosted WordPress URL like `http://1.2.3.4:8080/x` became
  `https://example.com:8080/x` — still rejected by IndexNow, and a broken
  internal link now that the linking engine uses the same helper. The unit test
  is what caught it. `u.port = ""` is now set explicitly.
- **T16's publish hook raises peak concurrency.** Up to 12 simultaneous
  publishes (4 shards x concurrency 3), each now also spawning one embedding
  call plus up to 6 serial platform writes — worst case ~72 in-flight platform
  writes for a few seconds per tick, all against *different* stores and all
  outside the request's await chain. Safe on Render (`next start` is a
  long-running process, so floating promises complete). **If the network ever
  moves to a serverless host this hook must become an awaited call or a queue**,
  or the writes are silently truncated.
- **T03's removal cron and queue table are temporary.** Delete
  `netgrid-cron-link-exchange-removal`, the route, the service file and
  `link_exchange_removals` once the queue drains and is signed off (T03 §7.7).
