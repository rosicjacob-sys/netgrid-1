/**
 * Search Console property provisioning — one verified property per blog.
 *
 * WHY THIS IS NOT A COPY OF index-now-deployer.ts
 * -----------------------------------------------
 * IndexNow lets the key file live at ANY path on the host, which is exactly
 * what makes wp-client.uploadIndexNowKeyFile (media library ->
 * /wp-content/uploads/YYYY/MM/{key}.txt) and
 * shopify-client.ensureIndexNowKeyPage (a Page -> /pages/indexnow-key) work at
 * all. Google's HTML-file verification has no keyLocation field: it fetches
 * {property}/google{token}.html at the document root and nothing else. Neither
 * existing helper can write there, so the FILE method is unusable with the
 * credentials NetGrid holds.
 *
 * What we do instead, per platform:
 *
 *   Shopify    META     Inject <meta name="google-site-verification"> into
 *                       the published theme's head, using the same
 *                       marker-block technique as
 *                       shopify-theme-client.injectSeoMetaTags.
 *                       Fully automatic. Produces a URL-prefix property.
 *
 *   WordPress  DNS_TXT  An application password cannot write site-wide <head>
 *                       markup and cannot install a custom plugin (core's
 *                       /wp/v2/plugins installs only from the wordpress.org
 *                       directory, by slug). So we fetch the TXT value, store
 *                       it on the blog row, and report "pending_dns". An
 *                       operator (or a registrar-API script) publishes it.
 *                       Produces a Domain property, which covers www,
 *                       non-www, http, https and every subdomain at once.
 *
 * Every cron run re-attempts verification for pending blogs, so a TXT record
 * added by hand today is picked up automatically tomorrow with no further
 * action and no manual re-trigger.
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { blogs as blogsTable } from "@/lib/db/schema";
import {
  addSite,
  domainProperty,
  getVerificationToken,
  GscError,
  gscConfigured,
  submitSitemap,
  urlPrefixProperty,
  verifyOwnership,
  type GscVerificationMethod,
} from "@/lib/services/gsc-client";
import { DEFAULT_API_VERSION, type ShopifyCreds } from "@/lib/services/shopify-client";
import {
  getMainTheme,
  getThemeAsset,
  putThemeAsset,
} from "@/lib/services/shopify-theme-client";

type Blog = typeof blogsTable.$inferSelect;

const SNIPPET_KEY = "snippets/meta-tags.liquid";
const LAYOUT_KEY = "layout/theme.liquid";

/** Bump when the injected block changes so existing stores get re-patched. */
export const GSC_BLOCK_VERSION = 1;

// Distinct markers from shopify-theme-client's "netgrid-seo" block. That block's
// regex matches "BEGIN netgrid-seo v\d+" only, and this one matches
// "BEGIN netgrid-gsc v\d+" only, so the two coexist in the same asset and
// neither ever clobbers the other. Do NOT generalise either marker to
// "netgrid-*": one subsystem would silently delete the other's block on its
// next write, and the affected stores would lose Search Console ownership with
// no error raised anywhere.
const MARKER_BEGIN = `{%- comment -%} BEGIN netgrid-gsc v${GSC_BLOCK_VERSION} — managed by netgrid; do not edit {%- endcomment -%}`;
const MARKER_END = `{%- comment -%} END netgrid-gsc v${GSC_BLOCK_VERSION} {%- endcomment -%}`;
const ANY_BLOCK_SRC =
  String.raw`\{%-?\s*comment\s*-?%\}\s*BEGIN netgrid-gsc v\d+[\s\S]*?END netgrid-gsc v\d+\s*\{%-?\s*endcomment\s*-?%\}`;
const ANY_BLOCK_TEST = new RegExp(ANY_BLOCK_SRC);
function anyBlockRe(): RegExp {
  return new RegExp(ANY_BLOCK_SRC, "g");
}

function buildGscBlock(metaTag: string): string {
  return `${MARKER_BEGIN}\n${metaTag}\n${MARKER_END}`;
}

/** Replace an existing block (any version) or append. Returns null when the
 * source already contains exactly this block — caller skips the write. */
function upsertBlock(source: string, block: string): string | null {
  if (ANY_BLOCK_TEST.test(source)) {
    const next = source.replace(anyBlockRe(), block);
    return next === source ? null : next;
  }
  const trimmed = source.replace(/\s*$/, "");
  return `${trimmed}\n\n${block}\n`;
}

/** Layout fallback: inject immediately before </head>. Mirrors
 * shopify-theme-client, including its one ambiguity — null means either
 * "already current" OR "no </head> found". We treat both as "nothing to write"
 * and let verifyOwnership be the real check: if the tag never landed,
 * verification simply fails and the blog stays pending. */
function upsertBlockInLayout(source: string, block: string): string | null {
  if (ANY_BLOCK_TEST.test(source)) {
    const next = source.replace(anyBlockRe(), block);
    return next === source ? null : next;
  }
  const headClose = /<\/head>/i;
  if (!headClose.test(source)) return null;
  return source.replace(headClose, `${block}\n</head>`);
}

/**
 * Build ShopifyCreds from a blog row. Mirrors the private helper in
 * index-now-deployer.ts; duplicated rather than imported because that function
 * is not exported. T15 consolidates the two.
 */
function shopifyCredsFromBlog(blog: Blog): ShopifyCreds | null {
  if (!blog.shopifyStoreUrl) return null;
  const mode = blog.shopifyAuthMode ?? "client_credentials";
  if (mode === "legacy_token") {
    if (!blog.shopifyAdminApiToken) return null;
    return {
      mode: "legacy_token",
      storeUrl: blog.shopifyStoreUrl,
      adminToken: blog.shopifyAdminApiToken,
    };
  }
  if (!blog.shopifyClientId || !blog.shopifyClientSecret) return null;
  return {
    mode: "client_credentials",
    storeUrl: blog.shopifyStoreUrl,
    clientId: blog.shopifyClientId,
    clientSecret: blog.shopifyClientSecret,
  };
}

/**
 * Idempotently place the google-site-verification meta tag in the store's
 * published theme. Prefers snippets/meta-tags.liquid (already runs inside
 * <head>), falls back to layout/theme.liquid — the same order and the same
 * asset keys injectSeoMetaTags uses.
 *
 * Requires the write_themes scope. A store connected with content-only scopes
 * throws a 403 here, which surfaces as a "failed" provision result.
 */
async function ensureGscMetaTag(creds: ShopifyCreds, metaTag: string): Promise<void> {
  const theme = await getMainTheme(creds, DEFAULT_API_VERSION);
  if (!theme) {
    throw new GscError("No published (main) theme found for this store");
  }

  const block = buildGscBlock(metaTag);

  const snippet = await getThemeAsset(creds, theme.id, SNIPPET_KEY, DEFAULT_API_VERSION);
  if (snippet !== null) {
    const next = upsertBlock(snippet, block);
    if (next !== null) {
      await putThemeAsset(creds, theme.id, SNIPPET_KEY, next, DEFAULT_API_VERSION);
    }
    return;
  }

  const layout = await getThemeAsset(creds, theme.id, LAYOUT_KEY, DEFAULT_API_VERSION);
  if (layout === null) {
    throw new GscError(
      "Theme has neither snippets/meta-tags.liquid nor layout/theme.liquid",
    );
  }
  const next = upsertBlockInLayout(layout, block);
  if (next === null) return;
  await putThemeAsset(creds, theme.id, LAYOUT_KEY, next, DEFAULT_API_VERSION);
}

/**
 * The sitemap URL for a blog. Identical derivation to the one already used for
 * llms.txt — Shopify serves /sitemap.xml, WordPress (Yoast/RankMath) serves
 * /sitemap_index.xml.
 */
export function sitemapUrlForBlog(blog: Pick<Blog, "domain" | "platform">): string {
  return blog.platform === "shopify"
    ? `https://${blog.domain}/sitemap.xml`
    : `https://${blog.domain}/sitemap_index.xml`;
}

/** Which property type / verification method this blog's platform supports.
 * If you later gain DNS control of the Shopify domains, return "DNS_TXT"
 * unconditionally here — Domain properties are strictly better and nothing
 * else in this subsystem needs to change. */
export function methodForBlog(blog: Pick<Blog, "platform">): GscVerificationMethod {
  return blog.platform === "shopify" ? "META" : "DNS_TXT";
}

export interface GscProvisionResult {
  blogId: string;
  domain: string;
  status: "verified" | "already_verified" | "pending_dns" | "skipped" | "failed";
  siteUrl?: string;
  method?: GscVerificationMethod;
  /** DNS_TXT only — the exact TXT value an operator must publish at the apex. */
  token?: string;
  message?: string;
}

/**
 * Provision (or re-attempt provisioning of) one blog's Search Console property.
 * Safe to call repeatedly: token fetch is idempotent, the theme write is
 * marker-delimited, sites.add tolerates an existing property, and an already
 * verified blog short-circuits after a sitemap catch-up.
 *
 * Never throws. Failure is a result value, because the callers are a cron batch
 * and a fire-and-forget hook inside blog creation.
 */
export async function provisionGscProperty(blog: Blog): Promise<GscProvisionResult> {
  const base = { blogId: blog.id, domain: blog.domain };

  if (!gscConfigured()) {
    return { ...base, status: "skipped", message: "GSC service account not configured" };
  }

  if (blog.gscVerifiedAt && blog.gscSiteUrl) {
    // Already ours. Catch up the sitemap if that step never completed.
    if (!blog.gscSitemapSubmittedAt) {
      try {
        await submitSitemap(blog.gscSiteUrl, sitemapUrlForBlog(blog));
        const now = new Date();
        await db
          .update(blogsTable)
          .set({ gscSitemapSubmittedAt: now, updatedAt: now })
          .where(eq(blogsTable.id, blog.id));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[gsc-verify] sitemap submit failed for ${blog.domain}: ${msg.slice(0, 200)}`);
      }
    }
    return { ...base, status: "already_verified", siteUrl: blog.gscSiteUrl };
  }

  const method = methodForBlog(blog);
  const siteUrl =
    method === "DNS_TXT" ? domainProperty(blog.domain) : urlPrefixProperty(blog.domain);

  let token: string | undefined;
  try {
    token = await getVerificationToken(blog.domain, method);

    // Persist the token BEFORE attempting verification. For DNS it IS the
    // operator deliverable, and the worklist query reads it from here — a blog
    // stuck pending must still expose its TXT value.
    await db
      .update(blogsTable)
      .set({
        gscSiteUrl: siteUrl,
        gscVerificationMethod: method,
        gscVerificationToken: token,
        updatedAt: new Date(),
      })
      .where(eq(blogsTable.id, blog.id));

    if (method === "META") {
      const creds = shopifyCredsFromBlog(blog);
      if (!creds) {
        return {
          ...base,
          status: "failed",
          method,
          siteUrl,
          message: "Shopify credentials missing on blog row",
        };
      }
      await ensureGscMetaTag(creds, token);
    }

    // For DNS_TXT this succeeds only once the record is live. Until then Google
    // answers 400 and we fall through to the pending_dns branch below.
    await verifyOwnership(blog.domain, method);

    // Verified owner — register the property. An already-registered property
    // answers 403/409 here, which is success as far as we are concerned.
    try {
      await addSite(siteUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.info(`[gsc-verify] sites.add ${siteUrl}: ${msg.slice(0, 160)}`);
    }

    const now = new Date();
    let sitemapAt: Date | null = null;
    try {
      await submitSitemap(siteUrl, sitemapUrlForBlog(blog));
      sitemapAt = now;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[gsc-verify] sitemap submit failed for ${blog.domain}: ${msg.slice(0, 200)}`);
    }

    await db
      .update(blogsTable)
      .set({ gscVerifiedAt: now, gscSitemapSubmittedAt: sitemapAt, updatedAt: now })
      .where(eq(blogsTable.id, blog.id));

    console.info(`[gsc-verify] ${blog.domain} verified via ${method} as ${siteUrl}`);
    return { ...base, status: "verified", siteUrl, method };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (method === "DNS_TXT") {
      // Expected until the operator publishes the record. Info, not warn —
      // 1,400 WordPress blogs would otherwise emit 1,400 warnings a day.
      return { ...base, status: "pending_dns", method, siteUrl, token, message };
    }
    console.warn(`[gsc-verify] FAILED for ${blog.domain} (${method}): ${message.slice(0, 200)}`);
    return { ...base, status: "failed", method, siteUrl, token, message };
  }
}

/**
 * Batch entry point for the cron (/api/cron/gsc-sync?verify=1). Deliberately
 * SEQUENTIAL: the META path writes a theme asset, and Shopify's Asset API is
 * rate-limited per store and unforgiving of concurrent writes to the same
 * theme — two concurrent writes to one theme file interleave and lose a block.
 * Verification is a once-per-blog cost, so throughput is irrelevant.
 */
export async function provisionPendingProperties(
  limit = 50,
): Promise<GscProvisionResult[]> {
  if (!gscConfigured()) return [];
  const rows = await db
    .select()
    .from(blogsTable)
    .where(and(eq(blogsTable.status, "active"), isNull(blogsTable.gscVerifiedAt)))
    .orderBy(asc(blogsTable.createdAt))
    .limit(limit);

  const out: GscProvisionResult[] = [];
  for (const blog of rows) {
    out.push(await provisionGscProperty(blog));
  }
  return out;
}
