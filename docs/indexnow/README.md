# IndexNow

How NetGrid tells Bing, Yandex, Seznam, Naver, Yep and DuckDuckGo about a new
post the moment it publishes — and why Shopify is deliberately excluded.

Google is **not** in that list. Google has never supported IndexNow, and its
unauthenticated sitemap-ping endpoint was retired in 2023. The Google path is
Search Console sitemap submission — see `src/lib/services/indexing-onboarding.ts`.

## The rule everything here exists to satisfy

IndexNow is a proof-of-control protocol. You invent a key, publish it as a
plain-text file named `{key}.txt`, and tell the API where it is. The receiving
engine fetches that URL and checks three things:

1. the response is **HTTP 200**;
2. the content type is **`text/*`**;
3. the body **is exactly the key** — not a page that contains it.

And then the part that the previous implementation missed: **the key file's
directory scopes what it authorises.** A key at
`https://example.com/wp-content/uploads/2026/08/KEY.txt` authorises submissions
for `/wp-content/uploads/2026/08/**` and nothing else. Post permalinks are at
the site root, so the key file must be at the site root.

That is the whole reason this MU-plugin exists: WordPress will not let the REST
API write a file to the document root, and the media library is a subdirectory.

## Install (one time, per WordPress site)

```bash
scp docs/indexnow/netgrid-indexnow.php \
    user@host:/var/www/example.com/wp-content/mu-plugins/netgrid-indexnow.php
```

Create `wp-content/mu-plugins/` if it does not exist. The file must sit
**directly** in it — WordPress does not recurse into subdirectories.

Confirm WordPress loaded it:

```bash
curl -sS -u "$WP_USER:$WP_APP_PASSWORD" \
  https://example.com/wp-json/netgrid/v1/indexnow-key
# 200 {"key":"","key_location":"","home_url":"https://example.com/"}
# 404 {"code":"rest_no_route"}  -> the file is not in mu-plugins/
```

After that one-time drop, NetGrid sets and rotates the key itself through the
REST route. You never touch the file again.

### Capability requirement

The account whose application password NetGrid stores (`blogs.wp_username` /
`blogs.wp_app_password`) needs `manage_options` — i.e. Administrator. For sites
where NetGrid authenticates as an Editor, drop this in a site plugin:

```php
add_filter('netgrid_indexnow_capability', fn() => 'edit_posts');
```

### Hosts that serve `.txt` from disk

Some managed hosts add an nginx `location ~ \.txt$` block that serves `.txt`
straight from disk and 404s without invoking PHP. On those hosts the plugin
loads, the REST route works, and the key file still 404s.

This is caught, not silently accepted: `verifyKeyFile()` fetches the file after
every deploy and records the failure as `index_ping_events.outcome = 'failed'`
with `http_status = 404`. For such a site, either point
`blogs.indexnow_key_location` at an edge-served URL, or leave the site
sitemap-only.

## Why every blog has its own key

The key file is public by design, at a guessable URL, on every domain we
operate. A single network-wide key would turn *"is this domain part of the
network?"* into one unauthenticated GET, and hand every receiving engine the
adjacency list for the whole network for free.

Keys live in `blogs.indexnow_key`, one per blog, minted on first use. The old
`INDEXNOW_KEY` environment variable is **no longer read anywhere** — delete it
from Render after running the backfill.

## Shopify is sitemap-only

This is a decision, not an omission. Shopify cannot host a spec-compliant key
file at a path that covers `/blogs/*` article URLs:

| Option | Why it fails |
|---|---|
| Page at `/pages/indexnow-key` (what the old code did) | Fails twice: the body is a full themed HTML document served as `text/html`, and `/pages/` does not contain `/blogs/…` article URLs. |
| Alternate page template emitting only the key | Fixes the body, not the scope. Still under `/pages/`, still `text/html`. |
| An article named `{key}.txt` inside the blog | Impossible. Shopify slugifies handles to `[a-z0-9-]`; the required dot cannot survive. |
| A URL redirect from `/{key}.txt` | The target is still a themed HTML route, so the fetched body is still not the key. Redirect-following is not guaranteed by the spec either. |
| A file at the storefront root | Shopify serves exactly two operator-controlled root text routes, `/robots.txt` and `/sitemap.xml`. Arbitrary root paths are not available on any plan. |
| Edge rule on the merchant's own domain (Cloudflare Worker / Rules) serving `/{key}.txt` as `text/plain` | **Works**, but is per-merchant infrastructure outside NetGrid's control. Supported via the `blogs.indexnow_key_location` override column, opt-in only. |

So Shopify blogs get Google via Search Console sitemap submission, and Bing via
a one-time sitemap submission in Bing Webmaster Tools. The deployer records
`outcome = 'skipped'` for them, which is deliberately excluded from the failure
alert counts.

## Verifying a site end to end

```bash
# 1. The key file is a key file.
curl -sS -i https://example.com/$(psql "$DATABASE_URL" -At \
  -c "SELECT indexnow_key FROM blogs WHERE domain = 'example.com'").txt
# Expect: 200, Content-Type: text/plain, body === the key, nothing else.

# 2. What the network actually thinks.
psql "$DATABASE_URL" -c "
  SELECT b.domain, e.channel, e.outcome, e.http_status, left(e.error, 80)
  FROM index_ping_events e JOIN blogs b ON b.id = e.blog_id
  WHERE e.created_at > now() - interval '24 hours'
  ORDER BY e.created_at DESC LIMIT 50;"
```

`outcome = 'skipped'` is not a failure. `outcome = 'failed'` with
`http_status = 404` on channel `indexnow_deploy` means the MU-plugin rollout
has not reached that site, or the host serves `.txt` from disk.

## Kill switch

`INDEXNOW_DISABLED=1` on the web service stops all IndexNow traffic without a
redeploy. Skipped pings are still recorded, so the gap is visible afterwards.
