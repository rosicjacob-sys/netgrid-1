import type { AxiosInstance } from "axios";
import {
  createClient,
  formatError,
  DEFAULT_API_VERSION,
  type ShopifyCreds,
} from "./shopify-client";

/**
 * Shopify theme (Asset API) client. Separate from shopify-client.ts because it
 * needs the `read_themes` / `write_themes` scopes the content client doesn't —
 * blog publishing only needs read_content / write_content.
 *
 * The one capability this exposes today is injecting an idempotent,
 * netgrid-managed SEO block into the theme head. It surfaces the OG `article:*`
 * tags and a JSON-LD BlogPosting block that the stock Shopify meta-tags snippet
 * drops — every value maps to something the publishing flow already sends per
 * post (author, tags, publish date, featured image, SEO title/description).
 *
 * Safety properties for a network of many stores:
 *   - Targets only the PUBLISHED theme (role: "main").
 *   - Never overwrites the merchant's markup — it appends/updates a single
 *     marker-delimited block, leaving everything else byte-for-byte.
 *   - Idempotent — re-running replaces the block in place (or no-ops when the
 *     content is already current), so it's safe to run on every store, repeatedly.
 */

const THEME_TIMEOUT_MS = 20000;

// v3 (T02): removed the site-wide page-view beacon and the CTA-rewriting
// script. Both pointed every storefront page at one shared netgrid host.
export const SEO_BLOCK_VERSION = 3;
const MARKER_BEGIN = `{%- comment -%} BEGIN netgrid-seo v${SEO_BLOCK_VERSION} — managed by netgrid; do not edit {%- endcomment -%}`;
const MARKER_END = `{%- comment -%} END netgrid-seo v${SEO_BLOCK_VERSION} {%- endcomment -%}`;
// Matches any prior version's block so an upgrade replaces it instead of
// stacking. Spans the opening `{%- comment -%}` of the BEGIN marker through the
// closing `{%- endcomment -%}` of the END marker. Note the final tag is
// `endcomment`, not `comment` — both markers are full self-closing comments.
// Non-global so `.test()` is stateless; a fresh global clone is used for
// replacement to avoid the lastIndex footgun.
const ANY_BLOCK_SRC =
  String.raw`\{%-?\s*comment\s*-?%\}\s*BEGIN netgrid-seo v\d+[\s\S]*?END netgrid-seo v\d+\s*\{%-?\s*endcomment\s*-?%\}`;
const ANY_BLOCK_TEST = new RegExp(ANY_BLOCK_SRC);
function anyBlockRe(): RegExp {
  return new RegExp(ANY_BLOCK_SRC, "g");
}

const SNIPPET_KEY = "snippets/meta-tags.liquid";
const LAYOUT_KEY = "layout/theme.liquid";

interface ShopifyTheme {
  id: number;
  name: string;
  role: string; // "main" = published, "unpublished", "demo", "development"
}

export interface SeoBlockOptions {
  /**
   * Emit an apple-touch-icon <link> from settings.favicon (site-wide). Set when
   * the theme doesn't already output one, so we don't duplicate it.
   */
  includeFavicon?: boolean;
  /**
   * Emit a <meta name="description"> from page_description (site-wide). Set ONLY
   * when the theme has NO description tag of its own — otherwise we repoint the
   * theme's existing tag instead, to avoid a duplicate description meta.
   */
  includeDescription?: boolean;
}

/**
 * The self-contained Liquid block we inject. The favicon + description lines
 * (when enabled) render site-wide; the OG / JSON-LD section is guarded to
 * article pages. Safe to live anywhere inside <head> (meta-tags.liquid already
 * runs there).
 *
 * T02: the block no longer contains the site-wide page-view beacon or the
 * CTA-rewriting script — both pointed every storefront page at one shared
 * netgrid host. Existing stores are upgraded by re-running applyThemeSeoFix /
 * optimizeThemeSeo (SEO_BLOCK_VERSION bump).
 */
export function buildSeoMetaBlock(opts: SeoBlockOptions = {}): string {
  const faviconLine = opts.includeFavicon
    ? `
{%- if settings.favicon != blank -%}
  <link rel="icon" type="image/png" href="{{ settings.favicon | image_url: width: 32, height: 32 }}">
  <link rel="apple-touch-icon" sizes="180x180" href="{{ settings.favicon | image_url: width: 180, height: 180 }}">
{%- endif -%}`
    : "";
  const descriptionLine = opts.includeDescription
    ? `
{%- if page_description != blank -%}
  <meta name="description" content="{{ page_description | strip_html | truncate: 150 | escape }}">
{%- endif -%}`
    : "";
  return `${MARKER_BEGIN}${faviconLine}${descriptionLine}
{%- if request.page_type == 'article' and article -%}
  {%- if article.published_at -%}
    <meta property="article:published_time" content="{{ article.published_at | date: '%Y-%m-%dT%H:%M:%SZ' }}">
  {%- endif -%}
  {%- if article.updated_at -%}
    <meta property="article:modified_time" content="{{ article.updated_at | date: '%Y-%m-%dT%H:%M:%SZ' }}">
  {%- endif -%}
  {%- if article.author != blank -%}
    <meta property="article:author" content="{{ article.author | escape }}">
  {%- endif -%}
  {%- for tag in article.tags -%}
    <meta property="article:tag" content="{{ tag | escape }}">
  {%- endfor -%}
  {%- if article.image -%}
    <meta name="twitter:image" content="{{ article.image | image_url: width: 1200 | prepend: 'https:' }}">
  {%- endif -%}
  <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      "headline": {{ article.title | strip_html | truncate: 110 | json }},
      "description": {{ page_description | default: article.excerpt_or_content | strip_html | truncate: 200 | json }},
      {%- if article.image %}
        "image": {{ article.image | image_url: width: 1200 | prepend: 'https:' | json }},
      {%- endif %}
      "datePublished": {{ article.published_at | date: '%Y-%m-%dT%H:%M:%SZ' | json }},
      "dateModified": {{ article.updated_at | date: '%Y-%m-%dT%H:%M:%SZ' | json }},
      "author": { "@type": "Person", "name": {{ article.author | default: shop.name | json }} },
      "publisher": { "@type": "Organization", "name": {{ shop.name | json }} },
      "mainEntityOfPage": { "@type": "WebPage", "@id": {{ canonical_url | json }} }
    }
  </script>
{%- endif -%}
${MARKER_END}`;
}

/** Resolve the published ("main") theme for a store. */
export async function getMainTheme(
  creds: ShopifyCreds,
  apiVersion: string = DEFAULT_API_VERSION,
  client?: AxiosInstance,
): Promise<{ id: number; name: string } | null> {
  const c = client ?? (await createClient(creds, apiVersion, THEME_TIMEOUT_MS));
  const res = await c.get<{ themes: ShopifyTheme[] }>("/themes.json");
  const main = res.data.themes.find((t) => t.role === "main");
  return main ? { id: main.id, name: main.name } : null;
}

/**
 * Read a single theme asset by key. Returns its text value, or null if the
 * asset doesn't exist on this theme (e.g. a vintage theme with no
 * snippets/meta-tags.liquid).
 */
export async function getThemeAsset(
  creds: ShopifyCreds,
  themeId: number,
  key: string,
  apiVersion: string = DEFAULT_API_VERSION,
  client?: AxiosInstance,
): Promise<string | null> {
  const c = client ?? (await createClient(creds, apiVersion, THEME_TIMEOUT_MS));
  try {
    const res = await c.get<{ asset: { value?: string; key: string } }>(
      `/themes/${themeId}/assets.json`,
      { params: { "asset[key]": key } },
    );
    return res.data.asset.value ?? null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Write (upsert) a theme asset's text value. */
export async function putThemeAsset(
  creds: ShopifyCreds,
  themeId: number,
  key: string,
  value: string,
  apiVersion: string = DEFAULT_API_VERSION,
  client?: AxiosInstance,
): Promise<void> {
  const c = client ?? (await createClient(creds, apiVersion, THEME_TIMEOUT_MS));
  await c.put(`/themes/${themeId}/assets.json`, {
    asset: { key, value },
  });
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "response" in err &&
    (err as { response?: { status?: number } }).response?.status === 404
  );
}

/**
 * Upsert the marker-delimited block into an existing asset's source:
 *   - If a (possibly older-version) block is already present, replace it.
 *   - Otherwise append the block (it lives in <head> either way).
 * Returns null when the source already contains exactly this block — the
 * caller should then skip the write (idempotent no-op).
 */
function upsertBlock(source: string, block: string): string | null {
  if (ANY_BLOCK_TEST.test(source)) {
    const next = source.replace(anyBlockRe(), block);
    return next === source ? null : next;
  }
  const trimmed = source.replace(/\s*$/, "");
  return `${trimmed}\n\n${block}\n`;
}

/**
 * Inject the block into layout/theme.liquid right before </head> — the
 * fallback path for themes that have no snippets/meta-tags.liquid. Replaces an
 * existing block in place when present.
 */
function upsertBlockInLayout(source: string, block: string): string | null {
  if (ANY_BLOCK_TEST.test(source)) {
    const next = source.replace(anyBlockRe(), block);
    return next === source ? null : next;
  }
  const headClose = /<\/head>/i;
  if (!headClose.test(source)) return null; // no head to inject into
  return source.replace(headClose, `${block}\n</head>`);
}

export interface ThemeSeoResult {
  success: boolean;
  message: string;
  themeId?: number;
  themeName?: string;
  targetAsset?: string;
  action?: "created" | "updated" | "unchanged" | "skipped";
}

/**
 * Idempotently install the netgrid SEO block into a store's published theme.
 * Prefers snippets/meta-tags.liquid; falls back to layout/theme.liquid.
 */
export async function injectSeoMetaTags(
  creds: ShopifyCreds,
  apiVersion: string = DEFAULT_API_VERSION,
): Promise<ThemeSeoResult> {
  try {
    const client = await createClient(creds, apiVersion, THEME_TIMEOUT_MS);

    const theme = await getMainTheme(creds, apiVersion, client);
    if (!theme) {
      return { success: false, message: "No published (main) theme found for this store." };
    }

    const block = buildSeoMetaBlock();

    // Preferred target: the meta-tags snippet, which already runs in <head>.
    const snippet = await getThemeAsset(creds, theme.id, SNIPPET_KEY, apiVersion, client);
    if (snippet !== null) {
      const hadBlock = ANY_BLOCK_TEST.test(snippet);
      const next = upsertBlock(snippet, block);
      if (next === null) {
        return {
          success: true,
          message: `Theme "${theme.name}" already has the current SEO block — no change.`,
          themeId: theme.id,
          themeName: theme.name,
          targetAsset: SNIPPET_KEY,
          action: "unchanged",
        };
      }
      await putThemeAsset(creds, theme.id, SNIPPET_KEY, next, apiVersion, client);
      return {
        success: true,
        message: `SEO block ${hadBlock ? "updated" : "added"} in ${SNIPPET_KEY} on theme "${theme.name}".`,
        themeId: theme.id,
        themeName: theme.name,
        targetAsset: SNIPPET_KEY,
        action: hadBlock ? "updated" : "created",
      };
    }

    // Fallback: inject into the layout head.
    const layout = await getThemeAsset(creds, theme.id, LAYOUT_KEY, apiVersion, client);
    if (layout === null) {
      return {
        success: false,
        message: `Theme "${theme.name}" has neither ${SNIPPET_KEY} nor ${LAYOUT_KEY} — cannot inject SEO tags.`,
        themeId: theme.id,
        themeName: theme.name,
      };
    }
    const hadBlock = ANY_BLOCK_TEST.test(layout);
    const next = upsertBlockInLayout(layout, block);
    if (next === null) {
      // Either unchanged, or no </head> to anchor to.
      if (hadBlock) {
        return {
          success: true,
          message: `Theme "${theme.name}" already has the current SEO block — no change.`,
          themeId: theme.id,
          themeName: theme.name,
          targetAsset: LAYOUT_KEY,
          action: "unchanged",
        };
      }
      return {
        success: false,
        message: `Could not find </head> in ${LAYOUT_KEY} on theme "${theme.name}".`,
        themeId: theme.id,
        themeName: theme.name,
        targetAsset: LAYOUT_KEY,
        action: "skipped",
      };
    }
    await putThemeAsset(creds, theme.id, LAYOUT_KEY, next, apiVersion, client);
    return {
      success: true,
      message: `SEO block ${hadBlock ? "updated" : "added"} in ${LAYOUT_KEY} on theme "${theme.name}".`,
      themeId: theme.id,
      themeName: theme.name,
      targetAsset: LAYOUT_KEY,
      action: hadBlock ? "updated" : "created",
    };
  } catch (error) {
    return { success: false, message: formatError(error) };
  }
}

export interface ThemeOptimizeResult extends ThemeSeoResult {
  /** Human-readable list of what the optimize pass changed. */
  details?: string[];
}

/**
 * One-pass theme SEO optimization that mirrors the manual theme edits that
 * lift Shopify SEO scores:
 *   1. <meta name="description"> — repoint an existing one to page_description
 *      (netgrid's capped SEO value), or inject one when the theme has none.
 *   2. apple-touch-icon favicon — emitted from settings.favicon when absent.
 *   3. OG article:* tags + JSON-LD BlogPosting on article pages.
 *
 * Single read-modify-write on the published theme's meta-tags snippet (or the
 * layout head as a fallback). Idempotent: the managed block is stripped and
 * re-added each run, and description repointing is a no-op once already done.
 * Also patches the layout <title> once to drop the theme's " – Shop Name"
 * suffix on article pages (see patchTitleSuffix) so netgrid's capped SEO title
 * renders without the suffix that pushes blog titles over the pixel limit.
 */
// Marker left inside the patched <title> so the strip is idempotent (we detect
// it and skip re-patching on subsequent runs).
const TITLE_PATCH_MARKER = "netgrid:title";

/**
 * Strip the theme's " – Shop Name" suffix from the <title> on ARTICLE pages
 * only. Most Shopify themes build `<title>{{ page_title }} &ndash; {{ shop.name }}</title>`
 * (or similar), which pushes blog-post titles over the 580px audit limit even
 * when netgrid already writes a capped SEO title. We wrap the existing <title>
 * inner in a page-type conditional: article pages emit bare `{{ page_title }}`
 * (which is netgrid's SEO title_tag when set), every other page keeps the
 * theme's original markup untouched. Idempotent via TITLE_PATCH_MARKER; a no-op
 * when there's no <title> to patch.
 */
function patchTitleSuffix(layout: string): {
  next: string;
  changed: boolean;
  note: string;
} {
  if (layout.includes(TITLE_PATCH_MARKER)) {
    return {
      next: layout,
      changed: false,
      note: "title suffix already stripped on article pages",
    };
  }
  const match = layout.match(/<title>([\s\S]*?)<\/title>/i);
  if (!match) {
    return {
      next: layout,
      changed: false,
      note: "no <title> tag in layout — suffix not changed",
    };
  }
  const inner = match[1];
  const replacement =
    `<title>{%- comment -%}${TITLE_PATCH_MARKER}{%- endcomment -%}` +
    `{%- if request.page_type == 'article' -%}{{ page_title }}` +
    `{%- else -%}${inner}{%- endif -%}</title>`;
  return {
    next: layout.replace(match[0], replacement),
    changed: true,
    note: "stripped shop-name suffix from <title> on article pages",
  };
}

export async function optimizeThemeSeo(
  creds: ShopifyCreds,
  apiVersion: string = DEFAULT_API_VERSION,
): Promise<ThemeOptimizeResult> {
  try {
    const client = await createClient(creds, apiVersion, THEME_TIMEOUT_MS);
    const theme = await getMainTheme(creds, apiVersion, client);
    if (!theme) {
      return { success: false, message: "No published (main) theme found for this store." };
    }

    // Prefer the meta-tags snippet; fall back to the layout head.
    let asset = SNIPPET_KEY;
    let usingLayout = false;
    let source = await getThemeAsset(creds, theme.id, SNIPPET_KEY, apiVersion, client);
    if (source === null) {
      source = await getThemeAsset(creds, theme.id, LAYOUT_KEY, apiVersion, client);
      asset = LAYOUT_KEY;
      usingLayout = true;
    }
    if (source === null) {
      return {
        success: false,
        message: `Theme "${theme.name}" has neither ${SNIPPET_KEY} nor ${LAYOUT_KEY} — cannot optimize.`,
        themeId: theme.id,
        themeName: theme.name,
      };
    }

    // Strip any prior managed block first so we don't match our OWN injected
    // description tag when repointing, and so the block is re-added cleanly.
    const body = source.replace(anyBlockRe(), "").replace(/\n{3,}/g, "\n\n");

    const details: string[] = [];

    // 1. Description: repoint the theme's own tag, or inject one if absent.
    const hasOwnDescription = new RegExp(DESC_META_RE.source, "gis").test(body);
    let repointed = 0;
    let repatchedBody = body;
    if (hasOwnDescription) {
      repatchedBody = body.replace(new RegExp(DESC_META_RE.source, "gis"), (_m, prefix) => {
        repointed += 1;
        return `${prefix}"${PAGE_DESC_EXPR}"`;
      });
      details.push(
        `repointed ${repointed} existing description tag${repointed === 1 ? "" : "s"} to page_description`,
      );
    } else {
      details.push("injected <meta name=\"description\"> from page_description");
    }

    // 2. Favicon: add <link rel="icon"> + apple-touch-icon only if the theme
    //    has no icon link at all (matches rel="icon", "shortcut icon", or
    //    "apple-touch-icon"). Both render from settings.favicon, so the store
    //    must still have a favicon set in the Shopify theme editor.
    const hasFavicon = /rel=["'][^"']*icon[^"']*["']/i.test(body);
    if (!hasFavicon) details.push("added favicon + apple-touch-icon");

    const block = buildSeoMetaBlock({
      includeFavicon: !hasFavicon,
      includeDescription: !hasOwnDescription,
    });
    details.push("added OG article tags + JSON-LD schema");

    // 3. Re-add the managed block (append for the snippet, before </head> for
    //    the layout).
    let next: string | null;
    if (usingLayout) {
      next = upsertBlockInLayout(repatchedBody, block);
      if (next === null) {
        return {
          success: false,
          message: `Could not find </head> in ${LAYOUT_KEY} on theme "${theme.name}".`,
          themeId: theme.id,
          themeName: theme.name,
          targetAsset: LAYOUT_KEY,
          action: "skipped",
        };
      }
    } else {
      next = `${repatchedBody.replace(/\s*$/, "")}\n\n${block}\n`;
    }

    // 4. Strip the shop-name suffix from <title> on article pages. The <title>
    //    lives in the LAYOUT — patch `next` directly when we're already editing
    //    the layout, otherwise read+write the layout as a second asset.
    let layoutTitleWritten = false;
    try {
      if (usingLayout) {
        const patched = patchTitleSuffix(next);
        next = patched.next;
        details.push(patched.note);
      } else {
        const layoutSource = await getThemeAsset(
          creds,
          theme.id,
          LAYOUT_KEY,
          apiVersion,
          client,
        );
        if (layoutSource === null) {
          details.push(`title suffix: ${LAYOUT_KEY} not found — skipped`);
        } else {
          const patched = patchTitleSuffix(layoutSource);
          if (patched.changed) {
            await putThemeAsset(
              creds,
              theme.id,
              LAYOUT_KEY,
              patched.next,
              apiVersion,
              client,
            );
            layoutTitleWritten = true;
          }
          details.push(patched.note);
        }
      }
    } catch (err) {
      details.push(`title suffix: layout patch skipped (${formatError(err)})`);
    }

    const primaryChanged = next !== source;
    if (!primaryChanged && !layoutTitleWritten) {
      return {
        success: true,
        message: `Theme "${theme.name}" is already optimized — no change.`,
        themeId: theme.id,
        themeName: theme.name,
        targetAsset: asset,
        action: "unchanged",
        details,
      };
    }

    if (primaryChanged) {
      await putThemeAsset(creds, theme.id, asset, next, apiVersion, client);
    }
    return {
      success: true,
      message: `Optimized theme "${theme.name}" SEO${primaryChanged ? ` in ${asset}` : ""}${layoutTitleWritten && asset !== LAYOUT_KEY ? ` + ${LAYOUT_KEY} title` : ""}.`,
      themeId: theme.id,
      themeName: theme.name,
      targetAsset: asset,
      action: "updated",
      details,
    };
  } catch (error) {
    return { success: false, message: formatError(error) };
  }
}

export interface ThemeSeoInspection {
  success: boolean;
  message: string;
  themeId?: number;
  themeName?: string;
  /** Which asset the meta tags were found in. */
  asset?: string;
  /** Lines from the theme that set/derive the <meta name="description">. */
  descriptionLines?: string[];
  /** Lines that build the <title> (to see the shop-name suffix). */
  titleLines?: string[];
  /**
   * Best-effort verdict on where the rendered meta description comes from:
   *  - "seo_field"  → uses page_description / metafields.global.description_tag
   *                   (correct — renders netgrid's capped value)
   *  - "body"       → uses article.content / excerpt_or_content (WRONG — this
   *                   is why audits see the long body text)
   *  - "excerpt"    → uses article.excerpt (renders summary_html)
   *  - "unknown"    → couldn't classify; inspect the lines manually
   */
  descriptionSource?: "seo_field" | "body" | "excerpt" | "unknown";
}

/**
 * Read-only diagnostic: pull the published theme's meta-tags source and show
 * exactly how it builds the <meta name="description"> and <title>. This turns
 * the recurring "meta description too long" question into ground truth —
 * netgrid always sends a capped description_tag, so if the audit still sees the
 * body, it's because the theme sources the description from the article body
 * instead of the SEO field. This pinpoints the line to patch.
 */
export async function inspectThemeSeo(
  creds: ShopifyCreds,
  apiVersion: string = DEFAULT_API_VERSION,
): Promise<ThemeSeoInspection> {
  try {
    const client = await createClient(creds, apiVersion, THEME_TIMEOUT_MS);
    const theme = await getMainTheme(creds, apiVersion, client);
    if (!theme) {
      return { success: false, message: "No published (main) theme found for this store." };
    }

    // The description tag is usually in the meta-tags snippet; some themes
    // inline it in the layout head instead.
    let asset = SNIPPET_KEY;
    let source = await getThemeAsset(creds, theme.id, SNIPPET_KEY, apiVersion, client);
    if (source === null || !/name=["']description["']|og:description/i.test(source)) {
      const layout = await getThemeAsset(creds, theme.id, LAYOUT_KEY, apiVersion, client);
      if (layout && /name=["']description["']|og:description/i.test(layout)) {
        asset = LAYOUT_KEY;
        source = layout;
      }
    }
    if (source === null) {
      return {
        success: false,
        message: `Theme "${theme.name}" has no ${SNIPPET_KEY} or readable ${LAYOUT_KEY}.`,
        themeId: theme.id,
        themeName: theme.name,
      };
    }

    const lines = source.split("\n");
    // Capture the description/og:description lines plus a little context (the
    // assign that feeds them, e.g. `assign og_description = ...`).
    const descriptionLines = lines.filter((l) =>
      /name=["']description["']|og:description|twitter:description|page_description|og_description/i.test(l),
    ).map((l) => l.trim());
    const titleLines = lines.filter((l) =>
      /<title|page_title|shop\.name/i.test(l),
    ).map((l) => l.trim());

    const blob = descriptionLines.join("\n").toLowerCase();
    let descriptionSource: ThemeSeoInspection["descriptionSource"] = "unknown";
    if (/article\.content|excerpt_or_content/.test(blob)) descriptionSource = "body";
    else if (/article\.excerpt/.test(blob)) descriptionSource = "excerpt";
    else if (/page_description|description_tag/.test(blob)) descriptionSource = "seo_field";

    return {
      success: true,
      message: `Read meta tags from ${asset} on theme "${theme.name}".`,
      themeId: theme.id,
      themeName: theme.name,
      asset,
      descriptionLines,
      titleLines,
      descriptionSource,
    };
  } catch (error) {
    return { success: false, message: formatError(error) };
  }
}

// The authoritative SEO description source: the article/page's
// "Search engine listing" meta description (global.description_tag), exposed
// in Liquid as `page_description`. netgrid always writes a pixel-capped value
// here, so pointing the tags at it makes the rendered meta description match
// the audited limit. shop.description is a sane store-level fallback.
const PAGE_DESC_EXPR = "{{ page_description | default: shop.description | escape }}";
// Rewrites the content="" of a description / og:description / twitter:description
// <meta> tag, whatever expression it currently uses (article.content, excerpt,
// a custom assign, etc.). Tag-spanning via [^>] (covers newlines); Liquid
// {{ }} contains no '>' so the content capture is safe.
const DESC_META_RE =
  /(<meta\b[^>]*?(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]*?content=)"[^"]*"/gis;

/**
 * Repoint the theme's <meta name="description"> (+ og/twitter description) at
 * `page_description` so the rendered meta description is netgrid's capped SEO
 * value instead of the article body. Idempotent — re-running is a no-op once
 * the tags already use page_description. Read-modify-write on the live asset,
 * so it patches the theme's ACTUAL markup rather than an assumed shape.
 */
export async function fixThemeMetaDescription(
  creds: ShopifyCreds,
  apiVersion: string = DEFAULT_API_VERSION,
): Promise<ThemeSeoResult> {
  try {
    const client = await createClient(creds, apiVersion, THEME_TIMEOUT_MS);
    const theme = await getMainTheme(creds, apiVersion, client);
    if (!theme) {
      return { success: false, message: "No published (main) theme found for this store." };
    }

    // Find the asset that actually emits the description meta tags.
    let asset = SNIPPET_KEY;
    let source = await getThemeAsset(creds, theme.id, SNIPPET_KEY, apiVersion, client);
    if (source === null || !DESC_META_RE.test(source)) {
      DESC_META_RE.lastIndex = 0;
      const layout = await getThemeAsset(creds, theme.id, LAYOUT_KEY, apiVersion, client);
      if (layout && new RegExp(DESC_META_RE.source, "gis").test(layout)) {
        asset = LAYOUT_KEY;
        source = layout;
      }
    }
    DESC_META_RE.lastIndex = 0;
    if (source === null) {
      return {
        success: false,
        message: `Theme "${theme.name}" has no ${SNIPPET_KEY} or readable ${LAYOUT_KEY}.`,
        themeId: theme.id,
        themeName: theme.name,
      };
    }

    let count = 0;
    const next = source.replace(new RegExp(DESC_META_RE.source, "gis"), (_m, prefix) => {
      count += 1;
      return `${prefix}"${PAGE_DESC_EXPR}"`;
    });

    if (count === 0) {
      return {
        success: false,
        message: `No <meta name="description"> tag found in ${asset} on theme "${theme.name}". Run Inspect to see how the theme builds it.`,
        themeId: theme.id,
        themeName: theme.name,
        targetAsset: asset,
        action: "skipped",
      };
    }
    if (next === source) {
      return {
        success: true,
        message: `Theme "${theme.name}" already sources the meta description from page_description — no change.`,
        themeId: theme.id,
        themeName: theme.name,
        targetAsset: asset,
        action: "unchanged",
      };
    }

    await putThemeAsset(creds, theme.id, asset, next, apiVersion, client);
    return {
      success: true,
      message: `Repointed ${count} description tag${count === 1 ? "" : "s"} to page_description in ${asset} on theme "${theme.name}".`,
      themeId: theme.id,
      themeName: theme.name,
      targetAsset: asset,
      action: "updated",
    };
  } catch (error) {
    return { success: false, message: formatError(error) };
  }
}

// ─── Related-posts block (internal semantic linking) ────────────────────────
// Renders a client-facing "Related posts" list on article pages from the
// custom.netgrid_related_posts metafield the linking service writes. Installing
// the snippet + a render call into the article template means we never re-push
// post bodies to keep internal links fresh — just the metafield.

const RELATED_SNIPPET_KEY = "snippets/netgrid-related-posts.liquid";
const RELATED_MARK = "netgrid-related-render";
const RELATED_RENDER_BLOCK =
  `{%- comment -%} ${RELATED_MARK}:start {%- endcomment -%}\n` +
  `{% render 'netgrid-related-posts' %}\n` +
  `{%- comment -%} ${RELATED_MARK}:end {%- endcomment -%}`;
// Article template candidates: Online Store 2.0 section first, then vintage.
const ARTICLE_TEMPLATE_KEYS = [
  "sections/main-article.liquid",
  "templates/article.liquid",
];

// Per-store cache of the last install attempt (success OR failure), so we hit
// the Asset API at most once per store per TTL and can report a store's status
// without re-attempting on every post. A failure is retried after the TTL (or
// a deploy), so fixing a scope reflects without waiting forever.
const relatedInstallCache = new Map<
  string,
  { result: RelatedBlockResult; expiresAt: number }
>();
const RELATED_CACHE_TTL_MS = 30 * 60 * 1000;

function buildRelatedSnippet(): string {
  return [
    "{%- assign nx_related = article.metafields.custom.netgrid_related_posts.value -%}",
    "{%- if nx_related and nx_related.size > 0 -%}",
    '  <div class="netgrid-related-posts" data-netgrid="related-posts">',
    "    <h3>Related posts</h3>",
    "    <ul>",
    "      {%- for nx_item in nx_related -%}",
    '        <li><a href="{{ nx_item.url }}">{{ nx_item.title }}</a></li>',
    "      {%- endfor -%}",
    "    </ul>",
    "  </div>",
    "{%- endif -%}",
  ].join("\n");
}

export interface RelatedBlockResult {
  ok: boolean;
  message: string;
  action?: "installed" | "unchanged" | "snippet-only";
}

/**
 * Idempotently install the "Related posts" snippet + a render call in the
 * published theme's article template. Cached per store for the process. If the
 * article template can't be auto-located, the snippet is still written and the
 * caller is told to add the render call manually.
 */
export async function ensureRelatedPostsBlock(
  creds: ShopifyCreds,
  apiVersion: string = DEFAULT_API_VERSION,
): Promise<RelatedBlockResult> {
  const cacheKey = creds.storeUrl;
  const hit = relatedInstallCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.result;

  const result = await runEnsureRelatedPostsBlock(creds, apiVersion);
  relatedInstallCache.set(cacheKey, {
    result,
    expiresAt: Date.now() + RELATED_CACHE_TTL_MS,
  });
  return result;
}

async function runEnsureRelatedPostsBlock(
  creds: ShopifyCreds,
  apiVersion: string,
): Promise<RelatedBlockResult> {
  try {
    const client = await createClient(creds, apiVersion, THEME_TIMEOUT_MS);
    const theme = await getMainTheme(creds, apiVersion, client);
    if (!theme) return { ok: false, message: "No published theme found" };

    // 1. Upsert the snippet (safe to overwrite — it's ours).
    await putThemeAsset(creds, theme.id, RELATED_SNIPPET_KEY, buildRelatedSnippet(), apiVersion, client);

    // 2. Ensure a render call sits right after the article body.
    for (const key of ARTICLE_TEMPLATE_KEYS) {
      const source = await getThemeAsset(creds, theme.id, key, apiVersion, client);
      if (source === null) continue;
      if (source.includes(`${RELATED_MARK}:start`)) {
        return { ok: true, message: `render call present in ${key}`, action: "unchanged" };
      }
      const m = source.match(/\{\{-?\s*article\.content\s*-?\}\}/);
      if (!m) continue;
      const at = (m.index ?? 0) + m[0].length;
      const next = `${source.slice(0, at)}\n${RELATED_RENDER_BLOCK}${source.slice(at)}`;
      await putThemeAsset(creds, theme.id, key, next, apiVersion, client);
      return { ok: true, message: `installed in ${key}`, action: "installed" };
    }

    return {
      ok: false,
      message:
        "Snippet installed but the article template's {{ article.content }} wasn't found — add {% render 'netgrid-related-posts' %} to the article template manually.",
      action: "snippet-only",
    };
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    const message =
      status === 403
        ? "Token lacks the write_themes scope — enable read_themes + write_themes and reinstall the app."
        : formatError(err);
    return { ok: false, message };
  }
}
