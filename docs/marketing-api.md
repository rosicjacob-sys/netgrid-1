# netgrid Marketing API (v1)

A read-only JSON API for surfacing each client's sites and SEO scores in the
marketing app's dashboard.

## Base URL

```
https://netgrid-16f6.onrender.com
```

(Use your actual deployment host.)

## Authentication

Every request needs the shared secret in **`MARKETING_API_KEY`** (set on the
netgrid server). Present it one of two ways:

```
Authorization: Bearer <MARKETING_API_KEY>
```
or
```
X-API-Key: <MARKETING_API_KEY>
```

**Server-to-server only.** The API returns client data and sets no CORS
headers, so call it from the marketing app's **backend** and keep the key
server-side — never ship it to a browser.

### Auth responses

| Status | Meaning |
|--------|---------|
| `200`  | OK |
| `401`  | Missing or wrong key |
| `503`  | `MARKETING_API_KEY` not configured on the server |

---

## Endpoints

### `GET /api/v1`

Self-documenting index — lists the available endpoints.

---

### `GET /api/v1/summary`

Network-wide totals for an overview widget. No parameters.

**Response** `200`:

```json
{
  "clients": 24,
  "sites": 210,
  "publishedPosts": 5820,
  "views": 148300,
  "clicks": 4120,
  "avgSeoScore": 94
}
```

| Field            | Type           | Notes |
|------------------|----------------|-------|
| `clients`        | number         | total clients |
| `sites`          | number         | total sites (blogs) |
| `publishedPosts` | number         | published posts across the network |
| `views`          | number         | HISTORIC page views — netgrid tracking retired 2026-09-08 |
| `clicks`         | number         | HISTORIC CTA clicks — netgrid tracking retired 2026-09-08 |
| `avgSeoScore`    | number \| null | 0–100, averaged over all scored sites |

> **`views`/`clicks` are historic.** Netgrid-side tracking (a per-post pixel and a tracked redirect) was retired on **2026-09-08** (T02). These counts stop growing from that date and are kept for the historical record only. Current traffic measurement is UTM-based attribution in each client's own GA4 / Shopify analytics (`utm_campaign=netgrid_content`), which also attributes revenue the pixel never could. Do not read a flat `views` line after 2026-09-08 as a traffic collapse.

---

### `GET /api/v1/clients`

List clients with rolled-up stats.

**Query parameters** (all optional):

| Param    | Description |
|----------|-------------|
| `email`  | Case-insensitive exact match on the client's contact email. Use to resolve a logged-in marketing-app user to their netgrid client. |
| `status` | Filter by client status: `onboarding` \| `active` \| `paused` \| `churned`. |
| `days`   | Traffic window: count `views`/`clicks` over the last N days (`1`–`365`, clamped). Omit for all-time. |
| `since`  | Traffic window lower bound as an ISO 8601 timestamp. Ignored when `days` is set. Omit for all-time. |

**Response** `200`:

```json
{
  "clients": [
    {
      "id": "96c4f390-67f5-4687-8376-8c7c400972a2",
      "name": "Pizza Crosta",
      "niche": "restaurant",
      "status": "active",
      "blogCount": 10,
      "avgSeoScore": 98,
      "lastPostAt": "2026-07-03T15:36:00.000Z",
      "postCount": 396,
      "views": 12840,
      "clicks": 372
    }
  ]
}
```

| Field         | Type              | Notes |
|---------------|-------------------|-------|
| `id`          | string (UUID)     | netgrid client id |
| `name`        | string            | |
| `niche`       | string \| null    | |
| `status`      | string \| null    | `onboarding` \| `active` \| `paused` \| `churned` |
| `blogCount`   | number            | number of sites for this client |
| `avgSeoScore` | number \| null    | 0–100, averaged over the client's sites; `null` if none scored yet |
| `lastPostAt`  | string \| null    | ISO 8601; most recent verified post across the client's sites |
| `postCount`   | number            | published posts across the client's sites |
| `views`       | number            | HISTORIC tracked page views (retired 2026-09-08) |
| `clicks`      | number            | HISTORIC tracked CTA clicks (retired 2026-09-08) |

> **Traffic (`views`/`clicks`) is historic.** Netgrid-side tracking was retired on **2026-09-08** (T02): the per-post pixel and the tracked redirect were removed from new and repaired posts, so these counts stop growing from that date. Counts up to that date remain accurate for the historical record. Current traffic is measured by UTM attribution (`utm_campaign=netgrid_content`) in the client's own GA4 / Shopify analytics — `utm_source` is the publishing site and `utm_content` is the netgrid post id, so exported GA4 reports still join back to these rows. CTR = `clicks / views` (historic). By default the counts are all-time; pass `days` or `since` to scope them to a window (e.g. `?days=30` for the trailing 30 days).

---

### `GET /api/v1/clients/{clientId}`

A single client with its sites (blogs) and per-site SEO scores.

`clientId` must be a UUID.

**Query parameters** (all optional):

| Param   | Description |
|---------|-------------|
| `days`  | Traffic window: count `views`/`clicks` (client total and per-site) over the last N days (`1`–`365`, clamped). Omit for all-time. |
| `since` | Traffic window lower bound as an ISO 8601 timestamp. Ignored when `days` is set. Omit for all-time. |

**Response** `200`:

```json
{
  "id": "96c4f390-67f5-4687-8376-8c7c400972a2",
  "name": "Pizza Crosta",
  "niche": "restaurant",
  "status": "active",
  "contactEmail": "owner@pizzacrosta.ca",
  "blogCount": 10,
  "activeBlogCount": 10,
  "avgSeoScore": 98,
  "lastPostAt": "2026-07-03T15:36:00.000Z",
  "postCount": 396,
  "postsLast30Days": 41,
  "views": 12840,
  "clicks": 372,
  "sites": [
    {
      "id": "71fb73bd-ec69-491b-8026-0a0c3ea1d32f",
      "domain": "crostapizza.store",
      "platform": "shopify",
      "status": "active",
      "seoScore": 100,
      "lastPostAt": "2026-07-03T15:36:00.000Z",
      "lastPostTitle": "Pizzeria Crosta's Sourdough Secret",
      "lastScanAt": "2026-07-03T16:02:00.000Z",
      "postCount": 42,
      "views": 1620,
      "clicks": 48,
      "metrics": {
        "source": "ahrefs",
        "domainAuthority": 38,
        "backlinks": 1240,
        "referringDomains": 96,
        "organicKeywords": 512,
        "organicTrafficEst": 3400,
        "topKeywords": ["sourdough pizza montreal", "best pizza mile end"],
        "fetchedAt": "2026-07-01T04:00:00.000Z"
      }
    }
  ]
}
```

Top-level fields are the same as the list item, plus:

| Field             | Type           | Notes |
|-------------------|----------------|-------|
| `contactEmail`    | string \| null | |
| `activeBlogCount` | number         | sites with status `active` |
| `postsLast30Days` | number         | posts published in the last 30 days |
| `sites`           | array          | see below, ordered by SEO score (highest first) |

**`sites[]`:**

| Field           | Type            | Notes |
|-----------------|-----------------|-------|
| `id`            | string (UUID)   | site/blog id |
| `domain`        | string          | |
| `platform`      | string \| null  | `wordpress` \| `shopify` |
| `status`        | string \| null  | `active` \| `paused` \| `setup` \| `decommissioned` |
| `seoScore`      | number \| null  | 0–100, latest score; `null` if never scanned |
| `lastPostAt`    | string \| null  | ISO 8601, last verified post |
| `lastPostTitle` | string \| null  | |
| `lastScanAt`    | string \| null  | ISO 8601, last SEO scan |
| `postCount`     | number          | published posts on this site |
| `views`         | number          | HISTORIC tracked page views on this site (retired 2026-09-08) |
| `clicks`        | number          | HISTORIC tracked CTA clicks on this site (retired 2026-09-08) |
| `metrics`       | object \| null  | latest third-party SEO snapshot (see below); `null` if never fetched |

**`sites[].metrics`** (third-party SEO — from Ahrefs/Semrush, latest snapshot):

| Field               | Type            | Notes |
|---------------------|-----------------|-------|
| `source`            | string \| null  | `ahrefs` \| `semrush` \| … |
| `domainAuthority`   | number \| null  | |
| `backlinks`         | number \| null  | total backlinks |
| `referringDomains`  | number \| null  | |
| `organicKeywords`   | number \| null  | keywords the site ranks for |
| `organicTrafficEst` | number \| null  | estimated monthly organic visits |
| `topKeywords`       | array \| null   | ranking keywords (shape as stored by the provider) |
| `fetchedAt`         | string \| null  | ISO 8601, when the snapshot was pulled |

**Errors:**

| Status | When |
|--------|------|
| `400`  | `clientId` isn't a valid UUID |
| `404`  | No client with that id |

---

### `GET /api/v1/clients/{clientId}/posts`

Published posts for a client, newest first, each with its live URL and per-post
traffic. Paginated.

**Query parameters** (all optional):

| Param    | Description |
|----------|-------------|
| `blogId` | Restrict to one site (UUID). |
| `limit`  | Page size, `1`–`100` (default `20`). |
| `offset` | Pagination offset (default `0`). |

**Response** `200`:

```json
{
  "clientId": "96c4f390-67f5-4687-8376-8c7c400972a2",
  "total": 396,
  "limit": 20,
  "offset": 0,
  "posts": [
    {
      "id": "b2e0f1a2-1111-2222-3333-444455556666",
      "blogId": "71fb73bd-ec69-491b-8026-0a0c3ea1d32f",
      "title": "Pizzeria Crosta's Sourdough Secret",
      "topic": "sourdough pizza crust",
      "excerpt": "How a 48-hour ferment builds the crust…",
      "keywords": ["sourdough", "montreal pizza"],
      "url": "https://crostapizza.store/blogs/news/sourdough-secret",
      "publishedAt": "2026-07-03T15:36:00.000Z",
      "wordCount": 1280,
      "seoScore": 96,
      "readabilityScore": 72,
      "views": 210,
      "clicks": 8
    }
  ]
}
```

| Field              | Type            | Notes |
|--------------------|-----------------|-------|
| `total`            | number          | total published posts matching the filter |
| `limit` / `offset` | number          | echo of the effective paging |
| `posts[].id`       | string (UUID)   | generated-post id |
| `posts[].blogId`   | string (UUID)   | site the post belongs to |
| `posts[].title`    | string \| null  | |
| `posts[].topic`    | string          | |
| `posts[].excerpt`  | string \| null  | |
| `posts[].keywords` | array \| null   | target keywords (shape as stored) |
| `posts[].url`      | string \| null  | live URL on the client's site; `null` if the platform returned none |
| `posts[].publishedAt`      | string \| null | ISO 8601 |
| `posts[].wordCount`        | number \| null | |
| `posts[].seoScore`         | number \| null | 0–100 at generation time |
| `posts[].readabilityScore` | number \| null | 0–100 |
| `posts[].views` / `clicks` | number         | tracked views/CTA clicks on this post |

**Errors:** `400` when `clientId` or `blogId` isn't a valid UUID.

---

### `GET /api/v1/clients/{clientId}/traffic`

Views/clicks bucketed over time — for a trend chart. Only buckets with activity
are returned, oldest first.

**Query parameters** (all optional):

| Param         | Description |
|---------------|-------------|
| `granularity` | `day` (default) or `week`. |
| `blogId`      | Restrict to one site (UUID). |
| `days`        | Window: last N days (`1`–`365`, clamped). Omit for all-time. |
| `since`       | Window lower bound as ISO 8601. Ignored when `days` is set. |

**Response** `200`:

```json
{
  "clientId": "96c4f390-67f5-4687-8376-8c7c400972a2",
  "granularity": "day",
  "series": [
    { "date": "2026-06-30T00:00:00.000Z", "views": 180, "clicks": 6 },
    { "date": "2026-07-01T00:00:00.000Z", "views": 240, "clicks": 9 }
  ]
}
```

`series[].date` is the bucket start (ISO 8601, UTC — midnight for `day`,
week-start for `week`).

**Errors:** `400` when `clientId` or `blogId` isn't a valid UUID.

---

### `GET /api/v1/clients/{clientId}/seo-history`

Per-site **overall SEO score over time** — one series per site, oldest point
first — for a trend chart. Scores come from the periodic SEO scans (roughly one
per site per month). Sites with no scans in range are omitted.

**Query parameters** (all optional):

| Param         | Description |
|---------------|-------------|
| `granularity` | `scan` (default) = one point per individual scan; `week` = one point per ISO week, the average overall score for that week. |
| `blogId`      | Restrict to one site (UUID). |
| `days`        | Window: last N days (`1`–`365`, clamped). Omit for all-time. |
| `since`       | Window lower bound as ISO 8601. Ignored when `days` is set. |

**Response** `200`:

```json
{
  "clientId": "96c4f390-67f5-4687-8376-8c7c400972a2",
  "granularity": "scan",
  "sites": [
    {
      "blogId": "71fb73bd-ec69-491b-8026-0a0c3ea1d32f",
      "domain": "crostapizza.store",
      "points": [
        { "date": "2026-05-01T04:00:00.000Z", "score": 82 },
        { "date": "2026-06-01T04:00:00.000Z", "score": 91 },
        { "date": "2026-07-01T04:00:00.000Z", "score": 98 }
      ]
    }
  ]
}
```

With `?granularity=week`, each `date` is the ISO week-start (Monday, UTC) and
each `score` is that week's average overall score, rounded to a whole number.

| Field                | Type          | Notes |
|----------------------|---------------|-------|
| `granularity`        | string        | echoes the requested bucket size (`scan` or `week`) |
| `sites[].blogId`     | string (UUID) | site id |
| `sites[].domain`     | string        | |
| `sites[].points[].date`  | string    | ISO 8601 — scan timestamp (`scan`) or week-start (`week`) |
| `sites[].points[].score` | number    | overall SEO score, 0–100 — per-scan value, or the week's average |

**Errors:** `400` when `clientId` or `blogId` isn't a valid UUID.

---

## Examples

### cURL

```bash
# List clients
curl -H "Authorization: Bearer $MARKETING_API_KEY" \
  https://netgrid-16f6.onrender.com/api/v1/clients

# Resolve a user to their client by email
curl -H "Authorization: Bearer $MARKETING_API_KEY" \
  "https://netgrid-16f6.onrender.com/api/v1/clients?email=owner@pizzacrosta.ca"

# One client with sites + scores + third-party metrics
curl -H "Authorization: Bearer $MARKETING_API_KEY" \
  https://netgrid-16f6.onrender.com/api/v1/clients/96c4f390-67f5-4687-8376-8c7c400972a2

# A client's published posts (with live URLs + per-post traffic)
curl -H "Authorization: Bearer $MARKETING_API_KEY" \
  "https://netgrid-16f6.onrender.com/api/v1/clients/96c4f390-67f5-4687-8376-8c7c400972a2/posts?limit=20"

# Daily traffic for the last 30 days
curl -H "Authorization: Bearer $MARKETING_API_KEY" \
  "https://netgrid-16f6.onrender.com/api/v1/clients/96c4f390-67f5-4687-8376-8c7c400972a2/traffic?granularity=day&days=30"

# Weekly-average SEO score history
curl -H "Authorization: Bearer $MARKETING_API_KEY" \
  "https://netgrid-16f6.onrender.com/api/v1/clients/96c4f390-67f5-4687-8376-8c7c400972a2/seo-history?granularity=week"

# Network overview totals
curl -H "Authorization: Bearer $MARKETING_API_KEY" \
  https://netgrid-16f6.onrender.com/api/v1/summary
```

### Node (marketing app backend)

```ts
const BASE = process.env.NETGRID_API_URL;   // https://netgrid-16f6.onrender.com
const KEY = process.env.NETGRID_API_KEY;     // = netgrid's MARKETING_API_KEY

async function getClientDashboard(email: string) {
  const headers = { Authorization: `Bearer ${KEY}` };

  // 1. Resolve the logged-in user to their netgrid client
  const list = await fetch(
    `${BASE}/api/v1/clients?email=${encodeURIComponent(email)}`,
    { headers },
  ).then((r) => r.json());

  const client = list.clients[0];
  if (!client) return null;

  // 2. Pull sites + SEO scores for that client
  return fetch(`${BASE}/api/v1/clients/${client.id}`, { headers }).then((r) =>
    r.json(),
  );
}
```

---

## Notes

- **Read-only.** Responses are field-whitelisted — platform credentials
  (WordPress passwords, Shopify tokens/secrets), internal notes, custom
  prompts, and cost/token economics are never exposed.
- All timestamps are ISO 8601 (UTC).
- **Pagination:** `/clients/{id}/posts` is paginated (`limit`/`offset`). The
  `/clients` list is not paginated — it returns all clients (fine for the
  current count; add paging if it grows large).
- **Traffic** counts posts published after tracking was enabled, plus site-wide
  (homepage / non-article) views on Shopify stores with the netgrid theme block
  installed. `0` until traffic accrues.

## Roadmap (not yet implemented)

- **SEO sub-scores** — per-site breakdown (meta / content / technical / links /
  images), complementing the overall score-over-time series already available
  at `/clients/{id}/seo-history`.
- **Monthly reports** — the client-visible monthly performance summaries.
- Per-client API keys / rate limiting if the API is exposed more widely.
