# Local keyword-targeted content — implementation plan

Status: **planned, not yet built.**

Turns the main auto-publish flow from freeform LLM ideation into **keyword-driven,
city-targeted content**. Each blog gets a city; each post targets one scraped
keyword against that city; the store the blog belongs to is named as the answer.

Worked example — blog `montrealpeptides.com`, city `Montreal`, brand
`Montreal Peptides`, scraped keyword `where to buy peptides`:

| Surface | Output |
|---|---|
| Topic / H1 | Where to Buy Peptides in Montreal: Sourcing, Pricing & Delivery |
| Meta title | Where to Buy Peptides in Montreal \| Montreal Peptides |
| Meta description | …where to buy peptides in Montreal… (no third-party token) |
| Body | City named substantively; Montreal Peptides named as the source, money-linked |

---

## 1. What already exists (reuse, don't rebuild)

The peptide **location-page drip** is a working prototype of half of this:

- `location-targeting.ts` — 6 rotating `"Where to Buy {c} in {l}"` title templates, deterministic per (compound, location) so pages aren't byte-identical, plus `buildLocationKeywords()`
- `peptide_location_targets` — a (blog × compound × location × dosage) matrix with `pending`/`generated`/`failed` status, dripped at a per-client daily cap
- `location-actions.runLocationDripInternal()` → `generateLocationTarget()` → `runGenerateAndPublish({ topic, keywords, buyLinkTerms })`

So the "explicit topic + keywords + money link fed into the normal generator"
path is **already proven in production**. What it lacks: the location is
client-level (`clients.peptideLocations`), it is peptides-only, and its keywords
are **templated, not scraped**.

Also reused as-is: `cta-target.blogDomainCtaUrl()` (peptide CTAs already point at
the blog's own domain), `injectMoneyLink()`, the scrubber, and
`getActiveKnowledgeForBlog()`'s keyword merge.

### Keyword source

Today's scraped keywords are `client_keywords` — Google Autocomplete, **no search
volume** (ranked by `hitCount` + `bestPosition` proxies). The DataForSEO corpus
(see `dataforseo-keyword-pipeline.md`) is planned but **not built**. This plan
reads keywords through one provider-agnostic function so the corpus swaps in
later without touching the ledger or the generator.

---

## 2. Decisions taken

1. **Brand in title, body, and link** — new `blogs.brand_name`, auto-derived from
   the domain and operator-editable. But see §5: the title's pixel budget means
   the brand is the **drop-first** element there; body + link are guaranteed.
2. **Meta title carries keyword + city, plus the brand when it fits.** Keyword
   and city always survive; the brand yields when the budget is tight.
3. **Ledger table** — `blog_keyword_targets`, mirroring `peptide_location_targets`.
4. **Unify onto the new path** — the peptide matrix builder feeds the ledger
   instead of running its own generation loop.
5. **Custom prompts keep their authority and gain placeholders** — a brief can
   reference `{keyword}` and `{city}` directly (§6), so the operator controls
   the sentence while the database supplies the values.

---

## 3. Data model

Migration `0036_local_keyword_targeting.sql`, hand-written idempotent SQL per
`migrations/README.md`, mirrored into `schema.ts`.

### `blogs` — new columns

**Assignment is manual.** The operator sets each blog's city in the admin form
and it is stored on the row — `montrealpeptides.com` → Montreal,
`ottawapeptides.com` → Ottawa, `pizzeriacrosta.ca` → Brossard. That last one is
the case that settles two things: the domain often contains **no** city, so
derivation can only ever be a suggestion in the form; and the blog is a pizzeria,
not peptides, so **this is niche-agnostic** — any blog with a city set gets
local targeting, whatever its vertical.

| Column | Type | Notes |
|---|---|---|
| `city` | varchar(120), nullable | `Montreal` / `Ottawa` / `Brossard`, operator-assigned. **Null disables the whole feature for that blog** — it falls back to today's ideation |
| `region` | varchar(120), nullable | `Quebec` — used in body context and later for location-code mapping |
| `country_code` | varchar(2), nullable | `CA` |
| `brand_name` | varchar(160), nullable | `Montreal Peptides`. Null → derived from the domain at read time |

One city per blog, as specified. A blog needing several cities gets several
ledger rows per keyword only if we later add a city list — not now.

**Domain-derived defaults.** `deriveBrandName("montrealpeptides.com")` →
`"Montreal Peptides"` by splitting the domain against a known-token dictionary
(city names + niche words). This only ever **pre-fills the admin form** — the
operator confirms or overrides it. It cannot be authoritative: `pizzeriacrosta.ca`
yields no city at all (its city is Brossard) and `montrealpeptides.com` might be
branded `MTL Peptides`. The city field is never auto-populated from the domain
without an operator confirming it.

### `blog_keyword_targets` — the ledger

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `blog_id` | uuid fk → blogs | cascade |
| `client_id` | uuid fk → clients | cascade |
| `keyword` | varchar(255) | the scraped phrase, normalized lowercase |
| `city` | varchar(120) | snapshot of the blog's city at build time |
| `topic_title` | varchar(500) | the templated title (§4) |
| `status` | enum `keyword_target_status` | `pending` / `generating` / `generated` / `failed` / `skipped` |
| `priority` | integer | rank snapshot — lower is better |
| `keyword_source` | varchar(32) | `google_autocomplete` today, `dataforseo` later |
| `search_volume` | integer, nullable | snapshot when the source has one |
| `generated_post_id` | uuid fk → generated_posts | set null on delete |
| `failure_reason` | text, nullable | |
| `created_at`, `updated_at`, `generated_at` | timestamp | |

- **Unique on `(blog_id, keyword, city)`** — the idempotency key. Rebuilding the
  matrix never duplicates a row.
- Index on `(blog_id, status, priority)` — the claim query.

---

## 4. Target building

`buildKeywordTargetsForBlog(blogId)`:

1. Skip if the blog has no `city`.
2. Read the blog's client keywords through `topActiveClientKeywords()` (already
   volume-aware in its ordering, so the DataForSEO swap is transparent).
3. Filter: drop keywords that already name a city (`peptides toronto` on a
   Montreal blog is wrong), drop navigational/brand-competitor terms.
4. For each survivor, upsert a `pending` row with `priority` = its rank.
5. Title from an extended `location-targeting.ts` template set, chosen
   deterministically by `hash(keyword|city)` so it's stable across rebuilds and
   varied across the network:
   - `Where to Buy {k} in {city}: Pricing & Availability`
   - `{k} in {city} — Cost, Sourcing & What to Know`
   - `Is {k} Available in {city}? A Practical Buyer's Guide`
   - …plus intent-aware variants for non-"buy" keywords, since a scraped keyword
     may be informational (`peptide dosage chart`), where a "Where to Buy" frame
     would be wrong. **Template selection branches on detected intent**
     (transactional / informational / comparison), not just a hash.

Run on demand from the admin, and on the weekly `refresh-keywords` cron right
after the scrape, so new keywords automatically become new targets.

---

## 5. Generation changes

### Selection

`runAutoPublishCron` keeps every existing gate (client cap, cadence, weekday,
6h floor, preferred hour, sharding). Once a blog is due, one new step: claim the
best `pending` ledger row for it (`ORDER BY priority ASC`, mark `generating`).
Found → keyword-targeted post. Not found (no city, or ledger drained) → today's
`ideateTopic` path, unchanged. **This feature is strictly additive; a blog
without a city behaves exactly as it does now.**

### Prompt

`GenerateOptions` gains `localTarget?: { keyword, city, region, countryCode, brandName, brandUrl }`.
When present, a `LOCAL_TARGETING_DIRECTIVE` is appended alongside the existing
`SEO_QUALITY_DIRECTIVE`:

- Use the exact keyword phrase naturally in the opening paragraph, one `<h2>`,
  and the closing — never as a repeated block (that's the density fingerprint the
  old scorer was removed for).
- Reference **{city}** substantively: local delivery/shipping expectations,
  regional regulation, local context. **Not** a find-and-replace city drop.
- Name **{brandName}** as the source, once in the body, linked to the site's own
  domain. Never in every section.
- Never invent a physical storefront, local address, phone number, or
  in-person pickup unless the client's Knowledge Base supplies one.

That last rule matters: the model will otherwise happily write "visit our
Montreal location" for a site that has none.

### Meta title — the ordering constraint

`appendBrandToTitle()` truncates the base **from the right** inside
`TITLE_TARGET_PX = 555` at 20px, and drops the brand suffix **whole** rather than
truncating it. So element order decides what survives:

```
[keyword incl. city] → + " | [brand]"   (brand appended only if the whole thing fits)
```

Keyword+city first means right-truncation eats the brand before it eats the city.
Concretely, `"Where to Buy Peptides in Montreal"` ≈ 309px and
`" | Montreal Peptides"` ≈ 178px, so the pair fits (487px ≤ 555px) and the brand
is kept. A longer keyword phrase — e.g. `"Where to Buy Research Peptides in
Montreal: Sourcing, Cold-Chain Shipping and Pricing"` at ≈ 790px — leaves no
room, so the brand is dropped entirely and only the keyword phrase is capped. It
is never truncated mid-brand. That is the intended outcome: keyword + city are
guaranteed, brand is a bonus. The brand's real placement is the body and the
money link.

`normalizeMetaTitle` / `normalizeMetaDescription` gain an optional target
context. The description gets the keyword phrase in its **first clause** (before
any truncation can reach it) and carries **no suffix of any kind**. Both stay
idempotent — re-running on an already-normalized value is a no-op aside from
pixel-cap trimming, the contract `meta-suffix.ts` honors.

### After generation

On success, the ledger row goes `generated` with the post id; on failure,
`failed` with the reason, and the run continues — the same isolation
`generateLocationTarget()` already uses.

---

## 6. Custom prompts — placeholder interpolation

Some clients have a custom prompt (`clients.customPrompt`, client-wide; the
per-blog `blogs.custom_prompt` column is dead — retained for back-compat, never
read). Today that brief is the **top-priority** anchor: it overrides the style
profile's compound canon in `ideateTopic` and replaces the styled system prompt
entirely in `generateContent`.

That authority is preserved. The brief does not lose to the ledger — instead it
gains the ability to **reference** what the database now holds:

```
generate a seo rich topic about {keyword} in {city}
```

### Supported placeholders

| Token | Source |
|---|---|
| `{keyword}` | the claimed `blog_keyword_targets.keyword` |
| `{city}` | `blogs.city` |
| `{region}` | `blogs.region` |
| `{country}` | `blogs.country_code` |
| `{brand}` | `blogs.brand_name` (or the domain-derived fallback) |
| `{domain}` | `blogs.domain` |

### Interpolation rules

- **One seam.** `runGenerateAndPublish` resolves the blog, city, and claimed
  target before either consumer runs, so the prompt string is interpolated
  **once** at load and the already-rendered text flows into both `ideateTopic`'s
  brief section and `buildCustomSystemPrompt`. Neither of them learns about
  placeholders.
- **Unknown tokens are left literal**, not blanked. `{keywrd}` renders as
  `{keywrd}` and is logged, so a typo is visible in the output instead of
  silently producing "a topic about  in Montreal".
- **A placeholder never renders empty.** If `{keyword}` is used but no target can
  be claimed (ledger drained, no city), fall back in order: the blog's
  top-ranked scraped keyword regardless of ledger status → the niche's key
  topic → drop the local targeting and take today's pure-brief path. An empty
  substitution would produce a malformed instruction, which is worse than not
  targeting at all.
- **Placeholders are optional.** A custom prompt with no tokens still gets the
  claimed keyword and city through the standard `LOCAL_TARGETING_DIRECTIVE`
  (§5). The tokens exist so the operator can control *where in their own
  sentence* the values land, not to opt in.

### Assumption worth confirming in review

Because targeting activates only once a blog has a city assigned — and cities
are new and assigned deliberately, one blog at a time — **existing custom-prompt
clients are unaffected until someone gives their blog a city.** That is what
makes it safe to have keyword targeting apply uniformly rather than behind
another per-client toggle.

### One contradiction to fix

`buildCustomSystemPrompt` currently instructs the model to produce a title with
**"no site/brand name"**, which fights the brand-in-title decision (§2) — but
only on the custom-prompt path. That line becomes conditional: brand stays out
of the title for non-local posts, and is permitted for local-targeted ones where
it survives the pixel budget (§5). The body-and-money-link placement is
unaffected either way.

## 7. Unifying the peptide drip

`buildLocationMatrix()` stops writing `peptide_location_targets` rows it
generates from, and instead writes `blog_keyword_targets` rows with
`keyword = "buy {compound}"`, `city = {location}`. `runLocationDripInternal()`
and the `location-pages` cron are retired; the daily cap moves onto the ledger
claim as a per-blog/per-client limit so pacing is preserved.

`peptide_location_targets` is **left in place, not dropped** — it's the record of
what was already generated, and dropping it would orphan `generated_post_id`
links. A one-time backfill copies its `generated` rows into the ledger so the
unique index prevents re-targeting a query that already has a live page.

---

## 8. Risks worth stating plainly

**This is programmatic local content at network scale, which is the exact shape
Google's scaled-content-abuse and doorway-page guidance targets.** The existing
system already carries real mitigations — per-blog locked style profiles, rotating
templates, the drip cap, the scrubber, per-blog CTA/quirk variation — and this
plan keeps all of them. What it adds as protection: intent-aware templates rather
than one pattern, substantive city context rather than name substitution, and a
per-post keyword that actually differs. The residual risk is real and worth
watching, and the honest mitigation is volume pacing plus genuine per-page
difference, not more templates. Flagging it, not blocking on it.

**Thin/duplicate risk across a client's own network.** Two of a client's blogs
in different cities targeting the same keyword produce near-identical articles
differing only by city. `getRecentTitles()` already feeds sibling titles into
ideation as a diversity guard, but that guard does not apply on the ledger path
(the title is templated, not ideated). Mitigation: the template hash keys on
`keyword|city`, so different cities get different templates — and the body
directive requires city-specific substance. Worth an explicit cross-blog check
before scaling past a handful of cities per client.

**Keyword quality is the current ceiling.** Autocomplete gives no volume, so
`priority` is a popularity proxy. Some targets will be worthless queries. This
gets materially better when the DataForSEO corpus lands and real
`search_volume` populates `priority`.

---

## 9. Rollout

1. **Migration + fields** — city/region/country/brand on blogs, ledger table, admin form fields with domain-derived suggestions
2. **Target builder** — matrix + intent-aware templates, admin preview of pending rows
3. **Generation** — claim step, `localTarget` option, prompt directive, meta injection
4. **Unification** — backfill peptide targets, retire the drip cron
5. **Observability** — per-blog coverage view: targeted / pending / failed

Phases 1–3 are independently shippable; the feature does nothing until a blog
has a city, which makes rollout controllable one blog at a time.

## 10. Definition of done

- [ ] `0036` applied; blogs carry city/region/country/brand; ledger table with its unique index
- [ ] Weekly scrape produces ledger rows automatically for city-bearing blogs
- [ ] A due blog with pending targets publishes `[keyword] in [city]` content naming and linking the store
- [ ] Meta title contains keyword + city inside the pixel cap and carries no third-party token; meta description leads with the keyword
- [ ] Blogs without a city are byte-for-byte unaffected
- [ ] Re-running the builder is idempotent; a failed target doesn't abort the run
- [ ] Peptide location targets backfilled; drip cron retired without orphaning post links
- [ ] A custom prompt containing `{keyword}` / `{city}` renders with real values; unknown tokens survive literally; no placeholder ever renders empty
- [ ] Custom-prompt clients whose blogs have no city behave exactly as they do today
- [ ] No new runtime dependency
