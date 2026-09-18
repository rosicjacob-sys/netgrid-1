import axios, { type AxiosInstance, type AxiosError } from "axios";
import { recordPipelineError } from "@/lib/services/run-telemetry";
import type {
  WpConnectionResult,
  SeoPlugin,
  PublishPostInput,
  PublishPostResult,
  MetaWriteStatus,
} from "@/lib/types";
import { compressImageDataUri } from "./image-compress";
import { verifyLiveMeta } from "./wp-meta-verify";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WpPost {
  id: number;
  date: string;
  date_gmt: string;
  modified: string;
  modified_gmt: string;
  slug: string;
  status: string;
  title: { rendered: string };
  content: { rendered: string };
  excerpt: { rendered: string };
  link: string;
  featured_media: number;
  categories: number[];
  tags: number[];
  yoast_head_json?: Record<string, unknown>;
  rank_math_meta?: Record<string, unknown>;
}

export interface WpUser {
  id: number;
  name: string;
  slug: string;
  roles: string[];
  capabilities?: Record<string, boolean>;
}

export interface YoastHeadData {
  title?: string;
  description?: string;
  og_title?: string;
  og_description?: string;
  og_image?: Array<{ url: string }>;
  robots?: Record<string, string>;
  canonical?: string;
  schema?: Record<string, unknown>;
}

export interface RankMathHeadData {
  head: string;
  success: boolean;
}

export interface RankMathMeta {
  rank_math_title?: string;
  rank_math_description?: string;
  rank_math_focus_keyword?: string;
  rank_math_robots?: string[];
  rank_math_canonical_url?: string;
  rank_math_schema_article_type?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const WP_TIMEOUT_MS = 10000;

function createBasicAuth(username: string, appPassword: string): string {
  return `Basic ${Buffer.from(`${username}:${appPassword}`).toString("base64")}`;
}

function createClient(wpUrl: string, username: string, appPassword: string): AxiosInstance {
  const baseURL = wpUrl.replace(/\/+$/, "");
  return axios.create({
    baseURL,
    timeout: WP_TIMEOUT_MS,
    headers: {
      Authorization: createBasicAuth(username, appPassword),
      "Content-Type": "application/json",
    },
  });
}

/**
 * Outcome of writing SEO meta to a WordPress post (T14).
 *
 * `status` is the existing MetaWriteStatus the publish counters read.
 * `verified` is the only claim worth making about whether the meta is LIVE:
 *   true  - confirmed on the live page
 *   false - the page was fetched and shows something else
 *   null  - not checked (draft, no public URL, or the page was unreachable)
 *
 * A "written" status now requires verified === true. Everything else that was
 * accepted by WordPress but not confirmed is "unverified", because a 2xx from
 * a meta write proves nothing — see updateYoastMeta.
 */
export interface SeoMetaResult {
  status: MetaWriteStatus;
  verified: boolean | null;
  plugin: SeoPlugin;
  message: string;
}

function normalizeWpUrl(wpUrl: string): string {
  return wpUrl.replace(/\/+$/, "");
}

function formatError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axiosErr = error as AxiosError<{ message?: string; code?: string }>;
    if (axiosErr.response) {
      const status = axiosErr.response.status;
      const data = axiosErr.response.data;
      if (status === 401 || status === 403) {
        return "Authentication failed. Check WordPress username and application password.";
      }
      if (status === 404) {
        return "WordPress REST API endpoint not found. Ensure WP REST API is enabled.";
      }
      return data?.message || `WordPress returned HTTP ${status}`;
    }
    if (axiosErr.code === "ECONNABORTED") {
      return "Connection timed out. The WordPress site may be unreachable.";
    }
    if (axiosErr.code === "ENOTFOUND" || axiosErr.code === "ECONNREFUSED") {
      return "Cannot reach the WordPress site. Check the URL.";
    }
    return axiosErr.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "An unknown error occurred";
}

// ─── WordPress REST API Client ──────────────────────────────────────────────

/**
 * Test WordPress REST API connection by fetching the authenticated user.
 */
export async function testConnection(
  wpUrl: string,
  username: string,
  appPassword: string
): Promise<WpConnectionResult> {
  const baseURL = normalizeWpUrl(wpUrl);
  const endpoint = `${baseURL}/wp-json/wp/v2/users/me`;
  const authHeader = createBasicAuth(username, appPassword);

  console.log("[wp.testConnection] GET", endpoint, {
    username,
    pwLen: appPassword.length,
  });

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      redirect: "follow",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    console.log("[wp.testConnection] network error:", msg);
    return { success: false, message: `Cannot reach WordPress: ${msg}` };
  }

  console.log("[wp.testConnection] response", {
    status: response.status,
    finalUrl: response.url,
    server: response.headers.get("server"),
  });

  if (!response.ok) {
    let body = "";
    try { body = await response.text(); } catch {}
    console.log("[wp.testConnection] error body:", body.slice(0, 500));

    let wpCode: string | undefined;
    let wpMessage: string | undefined;
    try {
      const parsed = JSON.parse(body) as { code?: string; message?: string };
      wpCode = parsed.code;
      wpMessage = parsed.message;
    } catch {}

    if (response.status === 401 || response.status === 403) {
      if (wpCode) {
        return { success: false, message: `${wpCode}: ${wpMessage || "Authentication failed"}` };
      }
      return {
        success: false,
        message: "Authentication failed. Verify username, application password, and that your host does not strip the Authorization header.",
      };
    }
    if (response.status === 404) {
      return { success: false, message: "WordPress REST API endpoint not found. Ensure WP REST API is enabled." };
    }
    return { success: false, message: wpMessage || `WordPress returned HTTP ${response.status}` };
  }

  const user = (await response.json()) as WpUser;
  const userRole = user.roles?.[0] || "unknown";

  const wpVersion =
    response.headers.get("x-wp-version") ||
    response.headers.get("x-powered-by") ||
    undefined;

  let seoPlugin: SeoPlugin = "none";
  try {
    const client = createClient(wpUrl, username, appPassword);
    await client.get("/wp-json/yoast/v1/get_head", { params: { url: baseURL }, timeout: 5000 });
    seoPlugin = "yoast";
  } catch {
    try {
      const client = createClient(wpUrl, username, appPassword);
      await client.get("/wp-json/rankmath/v1/getHead", { params: { url: baseURL }, timeout: 5000 });
      seoPlugin = "rankmath";
    } catch {}
  }

  // Is the netgrid-seo-bridge MU-plugin installed? Without it, Yoast's
  // _yoast_wpseo_* post meta is not registered for REST and every meta write
  // this app makes is discarded with a 200 (see updateYoastMeta). null means
  // "not installed" — that blog still needs the T14 rollout.
  let seoBridgeVersion: string | null = null;
  try {
    const client = createClient(wpUrl, username, appPassword);
    const probe = await client.get<{ bridge_version?: string }>(
      "/wp-json/netgrid/v1/seo-bridge",
      { timeout: 5000, validateStatus: () => true },
    );
    if (probe.status < 400 && typeof probe.data?.bridge_version === "string") {
      seoBridgeVersion = probe.data.bridge_version;
    }
  } catch {}

  console.log("[wp.testConnection] success", {
    user: user.name,
    role: userRole,
    seoPlugin,
    seoBridgeVersion,
  });

  return {
    success: true,
    message: `Connected as ${user.name} (${userRole})`,
    wpVersion: wpVersion || undefined,
    seoPlugin,
    seoBridgeVersion,
    userRole,
  };
}


/** Stable non-crypto hash, seeded per-blog so markup varies site-to-site. */
function wpHashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Per-blog hero <figure> markup. A network where every WordPress hero is
 * `<figure class="post-hero-image" style="margin:0 0 1.5em;">` is a trivial
 * HTML fingerprint. Each blog (keyed by its wpUrl) gets a stable class +
 * inline-style variant so the serialized markup differs site-to-site while
 * still rendering as a full-width hero. Same blog → same markup always.
 */
function buildHeroFigure(seed: string, src: string, safeAlt: string): string {
  const CLASS = [
    "post-hero-image",
    "article-hero",
    "entry-hero",
    "post-featured",
    "hero-figure",
    "lead-image",
    "post-cover",
    "featured-figure",
  ];
  const FIG_MARGIN = ["0 0 1.5em", "0 0 1.75rem", "0 0 1.25em 0", "0 0 2em"];
  const IMG_STYLE = [
    "width:100%;height:auto;display:block;",
    "display:block;max-width:100%;height:auto;",
    "width:100%;height:auto;",
  ];
  const h = wpHashSeed(seed);
  const cls = CLASS[h % CLASS.length];
  const margin = FIG_MARGIN[(h >> 3) % FIG_MARGIN.length];
  const imgStyle = IMG_STYLE[(h >> 5) % IMG_STYLE.length];
  return (
    `<figure class="${cls}" style="margin:${margin};">` +
    `<img src="${src}" alt="${safeAlt}" style="${imgStyle}" /></figure>`
  );
}

/**
 * Create a new WordPress post. If `input.featuredImageUrl` is set, the image
 * is uploaded to the Media Library first and its ID is attached as
 * `featured_media`.
 */
export async function createPost(
  wpUrl: string,
  username: string,
  appPassword: string,
  input: PublishPostInput,
  options: { seoPlugin?: SeoPlugin } = {},
): Promise<PublishPostResult> {
  try {
    const client = createClient(wpUrl, username, appPassword);

    // Upload the featured image up-front (best-effort — if it fails we still
    // publish the post, just without a featured image). We keep BOTH the
    // media id (for featured_media / og:image / listings) AND the public
    // source URL (to embed inline at the top of the post body — see below).
    let featuredMediaId: number | undefined;
    let featuredSourceUrl: string | undefined;
    if (input.featuredImageUrl) {
      try {
        const uploaded = await uploadMediaFromUrl(
          wpUrl,
          username,
          appPassword,
          input.featuredImageUrl,
          { filename: input.title, altText: input.title },
        );
        featuredMediaId = uploaded.id;
        featuredSourceUrl = uploaded.sourceUrl;
      } catch (err) {
        console.warn(
          "[wp.createPost] featured image upload failed, continuing without it:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Rewrite any <img src="data:image/..."> in the body to WP Media
    // Library URLs (or strip on upload failure). Keeps the post payload
    // small enough that shared hosts with PHP post_max_size = 2M don't
    // reject the request — and avoids embedding huge base64 into the
    // editor where it would slow Gutenberg / Classic editor loads.
    let rewrittenBody = await rewriteBodyDataUrisToWpUrls(
      wpUrl,
      username,
      appPassword,
      input.content,
      input.title,
    );

    // Embed the hero image at the TOP of the post body. Many WordPress
    // themes don't render featured_media on single posts (it only shows
    // in archives/listings), so the post would look imageless to a
    // reader. Prepending the hero as a <figure> guarantees it's visible
    // in the post content itself. featured_media is still set below for
    // og:image, RSS, and theme listings.
    if (featuredSourceUrl) {
      const safeAlt = (input.title || "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .slice(0, 200);
      const heroFigure = buildHeroFigure(wpUrl, featuredSourceUrl, safeAlt);
      rewrittenBody = heroFigure + rewrittenBody;
    }

    const wpStatus = (input.status ?? "publish") === "publish" ? "publish" : "draft";
    const res = await client.post<WpPost>("/wp-json/wp/v2/posts", {
      title: input.title,
      content: rewrittenBody,
      excerpt: input.excerpt,
      status: wpStatus,
      // Explicit keyword-first slug from the caller.
      // Omitted → WordPress derives the slug from the title.
      ...(input.slug && input.slug.trim() && { slug: input.slug.trim() }),
      ...(featuredMediaId !== undefined && { featured_media: featuredMediaId }),
    });

    // Write SEO meta title/description to whichever plugin the site runs, then
    // CONFIRM it on the live page. A 200 from WordPress proves nothing — see
    // writeWpSeoMeta. A meta failure must not fail an otherwise-published post,
    // but it is now loud in the logs and carried on the result instead of being
    // reported as "(SEO meta set)".
    const seoMeta = await writeWpSeoMeta(
      wpUrl,
      username,
      appPassword,
      res.data.id,
      {
        metaTitle: input.metaTitle,
        metaDescription: input.metaDescription,
        focusKeyword: input.tags?.[0],
      },
      options.seoPlugin ?? "none",
      // Drafts have no publicly fetchable URL - skip verification for them.
      { postUrl: wpStatus === "publish" ? res.data.link : null },
    );

    return {
      success: true,
      message: `Post "${res.data.title.rendered}" ${
        wpStatus === "publish" ? "published" : "saved as draft"
      }${featuredMediaId ? " with featured image" : ""}${describeSeoMeta(seoMeta)}`,
      postId: res.data.id,
      postUrl: res.data.link,
      metaStatus: seoMeta.status,
      seoMetaVerified: seoMeta.verified,
      seoMetaMessage: seoMeta.message || undefined,
    };
  } catch (error) {
    return { success: false, message: formatError(error) };
  }
}

/**
 * Fetch a post's public permalink and status. Used by updatePostSeo so meta
 * verification has a URL to check when the caller did not supply one. Returns
 * nulls on any failure - verification then reports "unverifiable" rather than
 * failing the update.
 */
export async function getPostLink(
  wpUrl: string,
  username: string,
  appPassword: string,
  postId: number,
): Promise<{ link: string | null; status: string | null }> {
  try {
    const client = createClient(wpUrl, username, appPassword);
    const res = await client.get<{ link?: string; status?: string }>(
      `/wp-json/wp/v2/posts/${postId}`,
      {
        params: { context: "edit", _fields: "id,link,status" },
        validateStatus: () => true,
      },
    );
    if (res.status >= 400) return { link: null, status: null };
    return { link: res.data.link ?? null, status: res.data.status ?? null };
  } catch {
    return { link: null, status: null };
  }
}

/**
 * Write the SEO meta title/description to whichever SEO plugin the site runs,
 * then CONFIRM it on the live page (T14).
 *
 * Routing:
 *   - "rankmath" -> /rankmath/v1/updateMeta (rank_math_* fields)
 *   - "yoast"    -> post `meta` update with _yoast_wpseo_* keys, which requires
 *                   the netgrid-seo-bridge MU-plugin on the site
 *   - "none"     -> no-op (a plugin-less site has no REST surface for head
 *                   meta; the theme owns <title>)
 *
 * The first tag (if any) is used as the focus keyword.
 *
 * Best-effort in the sense that a meta failure never fails an already-published
 * post - but NOT best-effort in what it reports. A 200 from WordPress is not a
 * success (see updateYoastMeta), so the only thing that returns status
 * "written" is a live <head> that matches. Everything accepted but unconfirmed
 * is "unverified"; everything else is logged at error level with the post id,
 * the site, and what the page actually shows.
 */
async function writeWpSeoMeta(
  wpUrl: string,
  username: string,
  appPassword: string,
  postId: number,
  meta: { metaTitle?: string; metaDescription?: string; focusKeyword?: string },
  seoPlugin: SeoPlugin,
  options: { postUrl?: string | null; verify?: boolean } = {},
): Promise<SeoMetaResult> {
  const metaTitle = meta.metaTitle?.trim();
  const metaDescription = meta.metaDescription?.trim();

  const skipped = (message: string): SeoMetaResult => ({
    status: "skipped",
    verified: null,
    plugin: seoPlugin,
    message,
  });

  if (!metaTitle && !metaDescription) {
    return skipped("No meta title or description supplied");
  }
  if (seoPlugin === "none") {
    // A plugin-less site has no REST surface that can accept a head meta
    // description. This is a real coverage gap, not a non-event — it is
    // what wp-seo-injector.ts exists to work around. Record it so the
    // operator can see how much of the fleet is affected.
    recordPipelineError({
      site: "wp-client.writeWpSeoMeta",
      code: "META_WRITE_SKIPPED",
      severity: "warn",
      message: `No SEO plugin on ${wpUrl} — head meta cannot be written via REST`,
      context: { wpUrl, postId },
    });
    return skipped("Blog has no SEO plugin - nothing to write");
  }

  const focusKw = meta.focusKeyword?.trim();
  const site = normalizeWpUrl(wpUrl);

  try {
    if (seoPlugin === "rankmath") {
      await updateRankMathMeta(wpUrl, username, appPassword, postId, {
        ...(metaTitle && { rank_math_title: metaTitle }),
        ...(metaDescription && { rank_math_description: metaDescription }),
        ...(focusKw && { rank_math_focus_keyword: focusKw }),
      });
    } else {
      await updateYoastMeta(wpUrl, username, appPassword, postId, {
        ...(metaTitle && { yoast_wpseo_title: metaTitle }),
        ...(metaDescription && { yoast_wpseo_metadesc: metaDescription }),
        ...(focusKw && { yoast_wpseo_focuskw: focusKw }),
      });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    recordPipelineError({
      site: "wp-client.writeWpSeoMeta",
      code: "META_WRITE_FAILED",
      severity: "error",
      message: `SEO meta write failed (post still published): ${detail}`,
      context: { wpUrl, postId, seoPlugin },
    });
    console.error(
      `[wp.seoMeta] ${seoPlugin} WRITE FAILED post=${postId} site=${site}: ${detail}`,
    );
    return {
      status: "failed",
      verified: null,
      plugin: seoPlugin,
      message: `SEO meta write failed: ${detail}`,
    };
  }

  const postUrl = options.postUrl?.trim();
  if (options.verify === false || !postUrl) {
    return {
      status: "unverified",
      verified: null,
      plugin: seoPlugin,
      message: "SEO meta written (not verified - no public URL)",
    };
  }

  const check = await verifyLiveMeta(postUrl, {
    title: metaTitle,
    description: metaDescription,
  });

  if (check.verified === true) {
    return {
      status: "written",
      verified: true,
      plugin: seoPlugin,
      message: "SEO meta written and verified on the live page",
    };
  }

  if (check.verified === null) {
    console.warn(
      `[wp.seoMeta] ${seoPlugin} UNVERIFIABLE post=${postId} url=${postUrl}: ${check.reason}`,
    );
    return {
      status: "unverified",
      verified: null,
      plugin: seoPlugin,
      message: `SEO meta written but unverifiable: ${check.reason}`,
    };
  }

  // Fetched and wrong: the write did not land. This is the failure mode that
  // used to report "(SEO meta set)".
  recordPipelineError({
    site: "wp-client.writeWpSeoMeta",
    code: "META_NOT_LIVE",
    severity: "error",
    message: `SEO meta written but the live page does not show it: ${check.reason}`,
    context: { wpUrl, postId, seoPlugin, postUrl, attempts: check.attempts },
  });
  console.error(
    `[wp.seoMeta] ${seoPlugin} NOT LIVE post=${postId} url=${postUrl} ` +
      `attempts=${check.attempts}: ${check.reason}`,
  );
  return {
    status: "failed",
    verified: false,
    plugin: seoPlugin,
    message: `SEO meta written but NOT LIVE: ${check.reason}`,
  };
}

/** Human-readable suffix appended to publish/update messages. */
function describeSeoMeta(result: SeoMetaResult): string {
  if (result.status === "skipped") return "";
  if (result.verified === true) return " (SEO meta verified live)";
  if (result.verified === false) return " (SEO META NOT LIVE - see logs)";
  if (result.status === "unverified") return " (SEO meta written, unverified)";
  return " (SEO meta write FAILED)";
}

/**
 * Fetch the rendered content HTML of a post by id. Used by the SEO backfill
 * to read the live body (with media-library URLs already in place) so it can
 * demote duplicate H1s without touching images. Returns null on failure.
 */
export async function getPostContentById(
  wpUrl: string,
  username: string,
  appPassword: string,
  postId: number,
): Promise<string | null> {
  try {
    const client = createClient(wpUrl, username, appPassword);
    const res = await client.get<WpPost>(`/wp-json/wp/v2/posts/${postId}`, {
      params: { context: "edit", _fields: "id,content" },
      validateStatus: () => true,
    });
    if (res.status >= 400) return null;
    // context=edit exposes content.raw; fall back to rendered.
    const content = res.data.content as { rendered?: string; raw?: string };
    return content?.raw ?? content?.rendered ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the site's reading settings — specifically how the homepage is built.
 * `showOnFront` is "page" when a static Page is the homepage (then
 * `pageOnFront` is that page's id) or "posts" when the homepage is the blog
 * index. Requires a user who can manage_options (the app-password admin).
 */
export async function getReadingSettings(
  wpUrl: string,
  username: string,
  appPassword: string,
): Promise<{ showOnFront: string | null; pageOnFront: number | null } | null> {
  try {
    const client = createClient(wpUrl, username, appPassword);
    const res = await client.get<{
      show_on_front?: string;
      page_on_front?: number;
    }>("/wp-json/wp/v2/settings", { validateStatus: () => true });
    if (res.status >= 400) return null;
    return {
      showOnFront: res.data.show_on_front ?? null,
      pageOnFront: res.data.page_on_front ?? null,
    };
  } catch {
    return null;
  }
}

/** Raw (unrendered) content of a Page, or null. */
export async function getPageRawContent(
  wpUrl: string,
  username: string,
  appPassword: string,
  pageId: number,
): Promise<string | null> {
  try {
    const client = createClient(wpUrl, username, appPassword);
    const res = await client.get<WpPost>(`/wp-json/wp/v2/pages/${pageId}`, {
      params: { context: "edit", _fields: "id,content" },
      validateStatus: () => true,
    });
    if (res.status >= 400) return null;
    const content = res.data.content as { rendered?: string; raw?: string };
    return content?.raw ?? content?.rendered ?? null;
  } catch {
    return null;
  }
}

/** Overwrite a Page's content. Returns true on success. */
export async function updatePageContent(
  wpUrl: string,
  username: string,
  appPassword: string,
  pageId: number,
  content: string,
): Promise<boolean> {
  try {
    const client = createClient(wpUrl, username, appPassword);
    const res = await client.post(
      `/wp-json/wp/v2/pages/${pageId}`,
      { content },
      { validateStatus: () => true },
    );
    return res.status < 400;
  } catch {
    return false;
  }
}

/**
 * Backfill an existing post's SEO fields: optionally replace the body (after
 * H1 demotion) and write the meta title/description to the site's SEO plugin,
 * then verify it on the live page. Mirrors what createPost does at publish
 * time.
 *
 * Callers that already know the post's public URL should pass `input.postUrl`;
 * otherwise one extra GET resolves it, and only when a meta write is actually
 * going to happen.
 */
export async function updatePostSeo(
  wpUrl: string,
  username: string,
  appPassword: string,
  postId: number,
  input: {
    content?: string;
    metaTitle?: string;
    metaDescription?: string;
    focusKeyword?: string;
    /** Public URL of the post, if the caller already has it. */
    postUrl?: string;
  },
  seoPlugin: SeoPlugin,
): Promise<PublishPostResult> {
  try {
    if (input.content !== undefined) {
      await updatePost(wpUrl, username, appPassword, postId, {
        content: input.content,
      });
    }

    const willWriteMeta =
      seoPlugin !== "none" &&
      Boolean(input.metaTitle?.trim() || input.metaDescription?.trim());

    let postUrl: string | null = input.postUrl?.trim() || null;
    if (!postUrl && willWriteMeta) {
      const looked = await getPostLink(wpUrl, username, appPassword, postId);
      // Only a published post has a fetchable URL worth verifying.
      postUrl = looked.status === "publish" ? looked.link : null;
    }

    const seoMeta = await writeWpSeoMeta(
      wpUrl,
      username,
      appPassword,
      postId,
      {
        metaTitle: input.metaTitle,
        metaDescription: input.metaDescription,
        focusKeyword: input.focusKeyword,
      },
      seoPlugin,
      { postUrl },
    );
    return {
      success: true,
      message: `Post ${postId} updated${describeSeoMeta(seoMeta)}`,
      postId,
      ...(postUrl ? { postUrl } : {}),
      metaStatus: seoMeta.status,
      seoMetaVerified: seoMeta.verified,
      seoMetaMessage: seoMeta.message || undefined,
    };
  } catch (error) {
    return { success: false, message: formatError(error) };
  }
}

/**
 * Thrown when a site does not have the NetGrid IndexNow MU-plugin installed.
 * Distinct from a generic failure because the remedy is a one-time file drop
 * by whoever controls the hosting, not a retry.
 */
export class MuPluginMissingError extends Error {
  constructor(public readonly siteUrl: string) {
    super(
      `NetGrid IndexNow MU-plugin is not installed on ${siteUrl} — ` +
        `POST /wp-json/netgrid/v1/indexnow-key returned 404. Copy ` +
        `docs/indexnow/netgrid-indexnow.php into wp-content/mu-plugins/.`,
    );
    this.name = "MuPluginMissingError";
  }
}

/**
 * Set (or rotate) this site's IndexNow key via the NetGrid MU-plugin, which
 * then serves it at the DOCUMENT ROOT as text/plain.
 *
 * Replaces the previous media-library upload. That approach put the key at
 * `/wp-content/uploads/YYYY/MM/{key}.txt`, and IndexNow scopes a key file to
 * its own directory — so it authorised nothing but the uploads folder, while
 * every URL we submit is a root-level permalink. Every WordPress ping was
 * being rejected. (The old code also matched its idempotency check with
 * `source_url.includes(key)`, so a WordPress-deduplicated `{key}-1.txt` was
 * returned as the key location; IndexNow requires the file to be named
 * exactly `{key}.txt`.)
 *
 * Idempotent: the plugin does update_option, so repeat calls with the same key
 * are a no-op. The caller (index-now-deployer) is responsible for verifying
 * the file is actually reachable afterwards — a site whose nginx config serves
 * *.txt from disk will accept this call and still 404 the file.
 *
 * Throws MuPluginMissingError on 404, or Error(formatError(...)) otherwise.
 */
export async function setIndexNowKeyViaMuPlugin(
  wpUrl: string,
  username: string,
  appPassword: string,
  key: string,
): Promise<{ keyLocation: string; homeUrl: string }> {
  const client = createClient(wpUrl, username, appPassword);
  try {
    const res = await client.post<{
      key: string;
      key_location: string;
      home_url: string;
    }>(`/wp-json/netgrid/v1/indexnow-key`, { key });

    const data = res.data;
    if (
      !data ||
      typeof data.key_location !== "string" ||
      data.key_location === "" ||
      data.key !== key
    ) {
      throw new Error(
        `MU-plugin returned an unexpected payload: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }
    return { keyLocation: data.key_location, homeUrl: data.home_url };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      throw new MuPluginMissingError(normalizeWpUrl(wpUrl));
    }
    if (error instanceof Error && !axios.isAxiosError(error)) throw error;
    throw new Error(formatError(error));
  }
}

/**
 * Download an image from a public URL and upload it to the WordPress Media
 * Library. Returns the new media row. The caller can pass `id` to the post's
 * `featured_media` field.
 *
 * Requires the authenticated user to have the `upload_files` capability
 * (admins/editors do by default; authors do; contributors do NOT).
 */
export async function uploadMediaFromUrl(
  wpUrl: string,
  username: string,
  appPassword: string,
  imageUrl: string,
  options: { filename?: string; altText?: string; caption?: string } = {},
): Promise<{ id: number; sourceUrl: string }> {
  const extMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };

  // 1. Resolve image bytes — either decode a data: URI inline (Imagen output
  //    without Bunny re-host) or fetch the URL.
  let buffer: Buffer;
  let contentType: string;

  if (imageUrl.startsWith("data:")) {
    const match = imageUrl.match(/^data:([^;,]+)(;base64)?,(.+)$/);
    if (!match) {
      throw new Error("Malformed data URI for featured image");
    }
    contentType = match[1].toLowerCase();
    if (!contentType.startsWith("image/")) {
      throw new Error(`data: URI is not an image (${contentType})`);
    }
    buffer = match[2]
      ? Buffer.from(match[3], "base64")
      : Buffer.from(decodeURIComponent(match[3]), "binary");
  } else {
    const imageRes = await fetch(imageUrl, { redirect: "follow" });
    if (!imageRes.ok) {
      throw new Error(`Failed to download image (${imageRes.status}) from ${imageUrl}`);
    }
    const arrayBuffer = await imageRes.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
    contentType = imageRes.headers.get("content-type") || "image/jpeg";
  }

  const ext = extMap[contentType] || contentType.split("/")[1] || "jpg";
  const safeFilename = (options.filename || `hero-${Date.now()}`)
    .replace(/[^a-z0-9._-]/gi, "-")
    .slice(0, 80);
  const filename = safeFilename.endsWith(`.${ext}`) ? safeFilename : `${safeFilename}.${ext}`;

  // 2. POST the binary to /wp/v2/media
  const client = createClient(wpUrl, username, appPassword);
  const uploadRes = await client.post<{ id: number; source_url: string }>(
    "/wp-json/wp/v2/media",
    buffer,
    {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    },
  );

  // 3. Set alt text / caption on the uploaded media (optional)
  if (options.altText || options.caption) {
    try {
      await client.post(`/wp-json/wp/v2/media/${uploadRes.data.id}`, {
        ...(options.altText && { alt_text: options.altText }),
        ...(options.caption && { caption: options.caption }),
      });
    } catch {
      // Metadata update failure is non-fatal — the image itself uploaded fine.
    }
  }

  return { id: uploadRes.data.id, sourceUrl: uploadRes.data.source_url };
}

/**
 * Fetch recent posts from a WordPress site.
 */
export async function fetchRecentPosts(
  wpUrl: string,
  username: string,
  appPassword: string,
  count: number = 5
): Promise<WpPost[]> {
  const client = createClient(wpUrl, username, appPassword);
  const res = await client.get<WpPost[]>("/wp-json/wp/v2/posts", {
    params: {
      per_page: count,
      orderby: "date",
      order: "desc",
      _fields: "id,date,date_gmt,modified,slug,status,title,link,excerpt,featured_media,categories,tags",
    },
  });
  return res.data;
}

/**
 * Fetch posts with pagination + full content. Returns the page of posts plus
 * the total counts from WordPress's response headers.
 */
export async function fetchPosts(
  wpUrl: string,
  username: string,
  appPassword: string,
  options: {
    page?: number;
    perPage?: number;
    /** WP statuses to include. Authenticated requests default to publish only;
     *  pass ["publish","draft","pending","private","future"] to see all. */
    statuses?: string[];
    search?: string;
  } = {},
): Promise<{ posts: WpPost[]; total: number; totalPages: number }> {
  const { page = 1, perPage = 20, statuses, search } = options;
  const client = createClient(wpUrl, username, appPassword);

  const params: Record<string, string | number> = {
    page,
    per_page: perPage,
    orderby: "date",
    order: "desc",
    context: "edit",
    _fields:
      "id,date,date_gmt,modified,slug,status,title,content,excerpt,link,featured_media,categories,tags",
  };
  if (statuses && statuses.length > 0) params.status = statuses.join(",");
  if (search) params.search = search;

  const res = await client.get<WpPost[]>("/wp-json/wp/v2/posts", {
    params,
    validateStatus: () => true,
  });

  // WP returns 400 if `page` is past the last page — return empty rather than
  // throw, since "page 2 of an empty list" is a reasonable thing to ask.
  if (res.status === 400) {
    return { posts: [], total: 0, totalPages: 0 };
  }
  if (res.status >= 400) {
    throw new Error(formatError({ response: res, isAxiosError: true } as never));
  }

  const total = parseInt((res.headers?.["x-wp-total"] as string | undefined) ?? "0", 10);
  const totalPages = parseInt(
    (res.headers?.["x-wp-totalpages"] as string | undefined) ?? "0",
    10,
  );

  return { posts: res.data, total, totalPages };
}

/**
 * Delete a WordPress post. By default sends to trash; pass force=true to skip
 * trash and delete permanently.
 */
export async function deletePost(
  wpUrl: string,
  username: string,
  appPassword: string,
  postId: number,
  force: boolean = false,
): Promise<{ deleted: boolean; permanently: boolean }> {
  const client = createClient(wpUrl, username, appPassword);
  const res = await client.delete<{ deleted?: boolean; previous?: WpPost } | WpPost>(
    `/wp-json/wp/v2/posts/${postId}`,
    { params: force ? { force: true } : {} },
  );
  // Trash response: the post itself with status=trash. Force response:
  // { deleted: true, previous: WpPost }.
  if (force) {
    const data = res.data as { deleted?: boolean };
    return { deleted: Boolean(data.deleted), permanently: true };
  }
  return { deleted: true, permanently: false };
}

export async function findPostByUrl(
  wpUrl: string,
  username: string,
  appPassword: string,
  pageUrl: string,
): Promise<WpPost | null> {
  let slug = "";
  try {
    const u = new URL(pageUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    slug = parts[parts.length - 1] || "";
  } catch {
    return null;
  }
  if (!slug) return null;

  const client = createClient(wpUrl, username, appPassword);
  const res = await client.get<WpPost[]>("/wp-json/wp/v2/posts", {
    params: {
      slug,
      per_page: 1,
      _fields:
        "id,slug,title,content,excerpt,link,status,date_gmt,modified_gmt",
    },
    validateStatus: () => true,
  });

  if (res.status >= 400 || !Array.isArray(res.data)) return null;
  return res.data[0] ?? null;
}

/**
 * Update an existing WordPress post.
 */
export async function updatePost(
  wpUrl: string,
  username: string,
  appPassword: string,
  postId: number,
  data: Partial<{
    title: string;
    content: string;
    excerpt: string;
    status: string;
    slug: string;
    meta: Record<string, unknown>;
  }>
): Promise<WpPost> {
  const client = createClient(wpUrl, username, appPassword);
  const res = await client.post<WpPost>(`/wp-json/wp/v2/posts/${postId}`, data);
  return res.data;
}

/**
 * Update alt text for a WordPress media item.
 */
export async function updateMediaAltText(
  wpUrl: string,
  username: string,
  appPassword: string,
  mediaId: number,
  altText: string
): Promise<{ id: number; alt_text: string }> {
  const client = createClient(wpUrl, username, appPassword);
  const res = await client.post(`/wp-json/wp/v2/media/${mediaId}`, {
    alt_text: altText,
  });
  return { id: res.data.id, alt_text: res.data.alt_text };
}

/**
 * Get Yoast SEO metadata for a URL.
 */
export async function getYoastMeta(
  wpUrl: string,
  username: string,
  appPassword: string,
  url: string
): Promise<YoastHeadData> {
  const client = createClient(wpUrl, username, appPassword);
  const res = await client.get<{ json: YoastHeadData }>("/wp-json/yoast/v1/get_head", {
    params: { url },
  });
  return res.data.json;
}

/**
 * Yoast's post-meta keys. Yoast prefixes every metabox field with
 * WPSEO_Meta::$meta_prefix ("_yoast_wpseo_"), which makes them PROTECTED meta:
 * is_protected_meta() returns true, so map_meta_cap() refuses edit_post_meta
 * unless the key was registered with an auth_callback.
 *
 * The public-facing parameter names on updateYoastMeta stay unprefixed so the
 * existing call sites (writeWpSeoMeta, seo-autofix.ts) do not change.
 */
const YOAST_META_KEYS: Record<string, string> = {
  yoast_wpseo_title: "_yoast_wpseo_title",
  yoast_wpseo_metadesc: "_yoast_wpseo_metadesc",
  yoast_wpseo_focuskw: "_yoast_wpseo_focuskw",
  yoast_wpseo_canonical: "_yoast_wpseo_canonical",
};

/**
 * Update Yoast SEO metadata on a post.
 *
 * Writes the underscore-prefixed keys Yoast actually reads, via the standard
 * `meta` object on /wp/v2/posts. This only works when the netgrid-seo-bridge
 * MU-plugin is installed on the site (docs/wordpress/netgrid-seo-bridge.php) —
 * Yoast itself registers none of these keys for REST, and WordPress discards
 * unregistered meta keys with a 200 rather than an error.
 *
 * The previous implementation could not work for three independent reasons:
 * it sent yoast_head_json (a read-only computed field with no update_callback,
 * skipped silently by WP_REST_Controller), it sent unprefixed key names Yoast
 * never reads, and even the right names would have been dropped because
 * WP_REST_Meta_Fields::update_value() iterates the REGISTERED meta registry
 * rather than the request body. All three failed with HTTP 200.
 *
 * Two guards against silent failure remain:
 *   1. Non-2xx throws with the WordPress error body attached.
 *   2. The update response carries context=edit, so its `meta` object lists the
 *      post's registered meta. If NONE of our keys came back, the bridge is not
 *      installed and the write was discarded — we throw and say so.
 *
 * NOTE: this is still not proof the meta RENDERS. Yoast serves <head> from its
 * indexable cache. verifyLiveMeta() in wp-meta-verify.ts is the real check.
 */
export async function updateYoastMeta(
  wpUrl: string,
  username: string,
  appPassword: string,
  postId: number,
  meta: {
    yoast_wpseo_title?: string;
    yoast_wpseo_metadesc?: string;
    yoast_wpseo_focuskw?: string;
    yoast_wpseo_canonical?: string;
  }
): Promise<WpPost> {
  const payload: Record<string, string> = {};
  for (const [publicKey, metaKey] of Object.entries(YOAST_META_KEYS)) {
    const value = meta[publicKey as keyof typeof meta];
    if (typeof value === "string" && value.trim()) {
      payload[metaKey] = value.trim();
    }
  }
  if (Object.keys(payload).length === 0) {
    throw new Error("updateYoastMeta called with no writable fields");
  }

  const client = createClient(wpUrl, username, appPassword);
  const res = await client.post<WpPost & { meta?: Record<string, unknown> }>(
    `/wp-json/wp/v2/posts/${postId}`,
    { meta: payload },
    { validateStatus: () => true },
  );

  if (res.status >= 400) {
    const body = JSON.stringify(res.data ?? {}).slice(0, 300);
    throw new Error(`Yoast meta write returned HTTP ${res.status}: ${body}`);
  }

  const echoed = res.data?.meta ?? {};
  const sent = Object.keys(payload);
  const landed = sent.filter((key) => key in echoed);
  if (landed.length === 0) {
    throw new Error(
      `WordPress accepted the request but returned none of [${sent.join(", ")}] ` +
        `in post.meta - the netgrid-seo-bridge MU-plugin is not installed on ` +
        `${normalizeWpUrl(wpUrl)}, so Yoast meta is not REST-writable there.`,
    );
  }

  return res.data;
}

/**
 * Get RankMath SEO metadata for a URL.
 */
export async function getRankMathMeta(
  wpUrl: string,
  username: string,
  appPassword: string,
  url: string
): Promise<RankMathHeadData> {
  const client = createClient(wpUrl, username, appPassword);
  const res = await client.get<RankMathHeadData>("/wp-json/rankmath/v1/getHead", {
    params: { url },
  });
  return res.data;
}

/**
 * Update RankMath SEO metadata on a post.
 */
export async function updateRankMathMeta(
  wpUrl: string,
  username: string,
  appPassword: string,
  postId: number,
  meta: RankMathMeta
): Promise<{ success: boolean }> {
  const client = createClient(wpUrl, username, appPassword);
  const res = await client.post<{ success: boolean }>("/wp-json/rankmath/v1/updateMeta", {
    objectID: postId,
    objectType: "post",
    meta,
  });
  return res.data;
}

// ─── Validation & Diagnostics ───────────────────────────────────────────────

export interface AppPasswordValidation {
  isValid: boolean;
  format: "WordPress Application Password" | "Unknown format";
  issues: string[];
}

/**
 * Validate the format of a WordPress Application Password.
 * Real app passwords are 24 alphanumeric characters split into 6 groups of 4
 * separated by single spaces — 29 characters total.
 */
export function validateApplicationPassword(password: string): AppPasswordValidation {
  const issues: string[] = [];
  const wpFormat = /^[a-zA-Z0-9]{4} [a-zA-Z0-9]{4} [a-zA-Z0-9]{4} [a-zA-Z0-9]{4} [a-zA-Z0-9]{4} [a-zA-Z0-9]{4}$/;

  if (password.length !== 29) {
    issues.push(`Length should be 29 characters, got ${password.length}`);
  }
  if (!wpFormat.test(password)) {
    issues.push("Does not match WordPress Application Password format (xxxx xxxx xxxx xxxx xxxx xxxx)");
  }
  if (!/^[a-zA-Z0-9 ]+$/.test(password)) {
    issues.push("Contains invalid characters (only alphanumeric and spaces allowed)");
  }

  return {
    isValid: issues.length === 0,
    format: wpFormat.test(password) ? "WordPress Application Password" : "Unknown format",
    issues,
  };
}

export interface DiagnosticResult {
  restApiAvailable: boolean;
  authenticationWorking: boolean;
  userInfo?: WpUser;
  errors: string[];
  recommendations: string[];
}

/**
 * Rich diagnostic test that separates REST-API availability from authentication,
 * and surfaces actionable recommendations per failure mode.
 */
export async function diagnosticTest(
  wpUrl: string,
  username: string,
  appPassword: string,
): Promise<DiagnosticResult> {
  const errors: string[] = [];
  const recommendations: string[] = [];
  let restApiAvailable = false;
  let authenticationWorking = false;
  let userInfo: WpUser | undefined;

  const baseURL = normalizeWpUrl(wpUrl);

  // 1. REST API availability (unauthenticated probe)
  try {
    const res = await axios.get(`${baseURL}/wp-json/wp/v2/`, {
      timeout: WP_TIMEOUT_MS,
      headers: { "Content-Type": "application/json" },
      validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 300) {
      restApiAvailable = true;
    } else {
      errors.push(`REST API not available: HTTP ${res.status}`);
      recommendations.push("Enable the WordPress REST API or check if a security plugin is blocking /wp-json/");
    }
  } catch (err) {
    errors.push(`Network error reaching REST API: ${err instanceof Error ? err.message : "unknown"}`);
    recommendations.push("Check that the WordPress URL is correct and the site is publicly reachable");
  }

  // 2. Authentication probe
  try {
    const client = createClient(wpUrl, username, appPassword);
    const res = await client.get<WpUser>("/wp-json/wp/v2/users/me", {
      validateStatus: () => true,
    });

    if (res.status >= 200 && res.status < 300) {
      authenticationWorking = true;
      userInfo = res.data;
    } else {
      switch (res.status) {
        case 401:
          errors.push("Authentication failed — invalid username or Application Password");
          recommendations.push("Verify the WordPress username is correct");
          recommendations.push("Regenerate the Application Password and copy it exactly (including spaces)");
          recommendations.push("Confirm the Application Password has not been revoked");
          recommendations.push('If on Dreamhost, add to .htaccess: SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1');
          break;
        case 403:
          errors.push("Authenticated but the user lacks permissions");
          recommendations.push("Ensure the WordPress user has the edit_posts or publish_posts capability");
          break;
        case 404:
          errors.push("WordPress REST API endpoint /wp/v2/users/me not found");
          recommendations.push("Update WordPress and confirm the REST API is enabled");
          break;
        default:
          errors.push(`Unexpected authentication response: HTTP ${res.status}`);
          recommendations.push("Check WordPress error logs for details");
      }
    }

    const server = (res.headers?.server as string | undefined)?.toLowerCase();
    if (server?.includes("litespeed")) {
      recommendations.push("LiteSpeed server detected — review LiteSpeed Cache REST API exclusions");
    }
    const platform = (res.headers?.platform as string | undefined)?.toLowerCase();
    if (platform === "hostinger") {
      recommendations.push("Hostinger hosting detected — check their security rules for external API access");
    }
  } catch (err) {
    errors.push(`Authentication probe error: ${err instanceof Error ? err.message : "unknown"}`);
  }

  return { restApiAvailable, authenticationWorking, userInfo, errors, recommendations };
}

export interface PublishPermissionsResult {
  canPublish: boolean;
  roles: string[];
  message: string;
}

/**
 * Verify the authenticated user has a role that allows publishing.
 */
export async function verifyPublishPermissions(
  wpUrl: string,
  username: string,
  appPassword: string,
): Promise<PublishPermissionsResult> {
  try {
    const client = createClient(wpUrl, username, appPassword);
    const res = await client.get<WpUser>("/wp-json/wp/v2/users/me", {
      params: { context: "edit" },
    });
    const roles = res.data.roles ?? [];
    const canPublish = roles.some((r) =>
      ["administrator", "editor", "author"].includes(r),
    );
    return {
      canPublish,
      roles,
      message: canPublish
        ? "User has publishing permissions"
        : `User roles (${roles.join(", ") || "none"}) do not include publishing permissions`,
    };
  } catch (error) {
    return {
      canPublish: false,
      roles: [],
      message: formatError(error),
    };
  }
}

/**
 * Create a throwaway draft post to confirm the publish pipeline works end-to-end.
 */
export async function createTestDraft(
  wpUrl: string,
  username: string,
  appPassword: string,
): Promise<{ success: boolean; postId?: number; message: string }> {
  const result = await createPost(wpUrl, username, appPassword, {
    title: "Test Draft — Netgrid Connection Check",
    content: "<p>Automated test draft created by Netgrid to verify publishing. Safe to delete.</p>",
    excerpt: "Automated connection test draft.",
    status: "draft",
  });
  if (!result.success) {
    return { success: false, message: result.message };
  }
  return {
    success: true,
    postId: typeof result.postId === "number" ? result.postId : undefined,
    message: `Test draft created (ID: ${result.postId})`,
  };
}

/**
 * Walk post body for <img src="data:image/...">, upload each to the WP
 * Media Library, and swap the src for the returned source_url. If any
 * upload fails, that <img> is stripped entirely so the post body stays
 * lean.
 */
async function rewriteBodyDataUrisToWpUrls(
  wpUrl: string,
  username: string,
  appPassword: string,
  body: string,
  postTitle: string,
): Promise<string> {
  const imgRegex =
    /<img\s+([^>]*?)src=(['"])(data:image\/[^'"]+)\2([^>]*)>/gi;
  const matches: Array<{ full: string; before: string; uri: string; after: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = imgRegex.exec(body)) !== null) {
    matches.push({ full: m[0], before: m[1], uri: m[3], after: m[4] });
  }
  if (matches.length === 0) return body;

  console.info(
    `[wp-media] Found ${matches.length} data: URI image(s) in body, uploading…`,
  );

  let rewritten = body;
  for (const match of matches) {
    try {
      const uploaded = await uploadMediaFromUrl(
        wpUrl,
        username,
        appPassword,
        match.uri,
        { filename: `body-${Date.now()}`, altText: postTitle },
      );
      const replacement = `<img ${match.before}src="${uploaded.sourceUrl}"${match.after}>`;
      rewritten = rewritten.replace(match.full, replacement);
      console.info(`[wp-media] Uploaded → ${uploaded.sourceUrl}`);
      continue;
    } catch (err) {
      console.warn(
        "[wp-media] Body image upload failed:",
        err instanceof Error ? err.message : err,
      );
    }

    // Upload failed (often because the user lacks upload_files capability
    // — contributors don't have it, only authors/editors/admins do).
    // Try to inline a compressed JPEG so the post still has the image.
    const compressed = await compressImageDataUri(match.uri, {
      maxBytes: 500 * 1024,
      maxWidth: 1024,
      quality: 72,
    });
    if (compressed) {
      const replacement = `<img ${match.before}src="${compressed}"${match.after}>`;
      rewritten = rewritten.replace(match.full, replacement);
      console.info(
        `[wp-media] Upload unavailable; inlining compressed JPEG (${Math.round(compressed.length / 1024)} KB)`,
      );
      continue;
    }

    rewritten = rewritten.replace(
      match.full,
      "<!-- body image: upload + compression both failed; stripped -->",
    );
    console.warn(
      "[wp-media] Upload + compression both failed; img stripped from body",
    );
  }

  return rewritten;
}