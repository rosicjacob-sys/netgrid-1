import axios, { type AxiosInstance, type AxiosError } from "axios";
import type {
  ConnectionResult,
  PublishPostInput,
  PublishPostResult,
} from "@/lib/types";
import { getClientCredentialsToken } from "./shopify-token-cache";
import { compressImageDataUri } from "./image-compress";

export const DEFAULT_API_VERSION = "2024-07";
const DEFAULT_TIMEOUT_MS = 15000;
const PUBLISH_TIMEOUT_MS = 30000; // longer for image fetching

export type ShopifyCreds =
  | { mode: "legacy_token"; storeUrl: string; adminToken: string }
  | {
      mode: "client_credentials";
      storeUrl: string;
      clientId: string;
      clientSecret: string;
    };

export interface ShopifyArticle {
  id: number;
  title: string;
  body_html: string;
  author: string;
  blog_id: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  handle: string;
  tags: string;
  summary_html: string | null;
  user_id: number | null;
  template_suffix: string | null;
}

export interface ShopifyBlog {
  id: number;
  title: string;
  handle: string;
  created_at: string;
  updated_at: string;
}

export interface ShopifyShop {
  id: number;
  name: string;
  email: string;
  domain: string;
  myshopify_domain: string;
  plan_name: string;
  plan_display_name: string;
}

export function normalizeStoreUrl(storeUrl: string): string {
  let url = storeUrl.trim().replace(/\/+$/, "");
  url = url.replace(/^https?:\/\//i, "");
  return url;
}

async function resolveAccessToken(creds: ShopifyCreds): Promise<string> {
  if (creds.mode === "legacy_token") return creds.adminToken;
  const shop = normalizeStoreUrl(creds.storeUrl);
  const { token } = await getClientCredentialsToken({
    shop,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
  });
  return token;
}

export async function createClient(
  creds: ShopifyCreds,
  apiVersion: string = DEFAULT_API_VERSION,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<AxiosInstance> {
  const host = normalizeStoreUrl(creds.storeUrl);
  const token = await resolveAccessToken(creds);

  const client = axios.create({
    baseURL: `https://${host}/admin/api/${apiVersion}`,
    timeout: timeoutMs,
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
  });

  // 429 retry interceptor honoring Retry-After header (single retry)
  client.interceptors.response.use(
    (res) => res,
    async (err: AxiosError) => {
      const cfg = err.config as (typeof err.config & { __retried?: boolean }) | undefined;
      if (err.response?.status === 429 && cfg && !cfg.__retried) {
        const retryAfter = Number(err.response.headers["retry-after"] ?? 2);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        cfg.__retried = true;
        return client.request(cfg);
      }
      return Promise.reject(err);
    },
  );

  return client;
}

export function formatError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axiosErr = error as AxiosError<{
      errors?: string | Record<string, string[]>;
    }>;
    if (axiosErr.response) {
      const status = axiosErr.response.status;
      const data = axiosErr.response.data;
      if (status === 401) {
        return "Authentication failed. Check your Shopify credentials.";
      }
      if (status === 403) {
        return "Token lacks required scopes. Enable read_content and write_content for blog articles.";
      }
      if (status === 404) {
        return "Shopify store or resource not found. Verify the store URL.";
      }
      if (status === 429) {
        return "Shopify rate limit hit. Try again shortly.";
      }
      if (typeof data?.errors === "string") return data.errors;
      if (data?.errors && typeof data.errors === "object") {
        return Object.entries(data.errors)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
          .join("; ");
      }
      return `Shopify returned HTTP ${status}`;
    }
    if (axiosErr.code === "ECONNABORTED") {
      return "Connection timed out. Shopify may be slow or unreachable.";
    }
    if (axiosErr.code === "ENOTFOUND" || axiosErr.code === "ECONNREFUSED") {
      return "Cannot reach the Shopify store. Check the store URL.";
    }
    return axiosErr.message;
  }
  if (error instanceof Error) return error.message;
  return "An unknown error occurred";
}

/**
 * Fetch an image from any URL (following redirects) and return it as base64
 * so it can be sent inline as `article.image.attachment`. This avoids letting
 * Shopify's image fetcher deal with redirects, signed/expiring URLs, or
 * placeholder services like picsum that 302 to a CDN host.
 *
 * Returns null on any failure — caller can fall back to passing the URL as
 * `src` (which works for some direct image URLs).
 */
async function fetchImageAsBase64(url: string): Promise<{
  attachment: string;
  filename: string;
} | null> {
  const extMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/pjpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
  };

  // Fast path: data: URI from Imagen. Decode inline without an HTTP fetch.
  // Format: data:<mediatype>;base64,<data>
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;,]+)(;base64)?,(.+)$/);
    if (!match) {
      console.warn(`[shopify] Malformed data URI`);
      return null;
    }
    const mime = match[1].toLowerCase();
    const isBase64 = Boolean(match[2]);
    if (!mime.startsWith("image/")) {
      console.warn(`[shopify] data: URI not an image (${mime})`);
      return null;
    }
    const ext = extMap[mime] ?? "jpg";
    const filename = `featured-${Date.now()}.${ext}`;
    if (isBase64) {
      return { attachment: match[3], filename };
    }
    const buf = Buffer.from(decodeURIComponent(match[3]), "binary");
    return { attachment: buf.toString("base64"), filename };
  }

  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      console.warn(`[shopify] Image fetch failed (${res.status}): ${url}`);
      return null;
    }

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.startsWith("image/")) {
      console.warn(`[shopify] Not an image (${contentType}): ${url}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 100) {
      console.warn(
        `[shopify] Image suspiciously small (${buffer.length}b): ${url}`,
      );
      return null;
    }

    const mime = contentType.split(";")[0].trim();
    const ext = extMap[mime] ?? "jpg";
    const filename = `featured-${Date.now()}.${ext}`;

    return {
      attachment: buffer.toString("base64"),
      filename,
    };
  } catch (err) {
    console.warn(`[shopify] Image fetch threw: ${url}`, err);
    return null;
  }
}

/**
 * Remove the legacy "IndexNow Verification" Page (handle `indexnow-key`) that
 * a previous implementation published on every storefront.
 *
 * That page could never satisfy IndexNow: the protocol wants a plain-text file
 * whose body IS the key, and a Shopify Page renders as a full themed HTML
 * document served as text/html; and articles live under /blogs/*, which a key
 * at /pages/* does not authorise. Shopify cannot host a spec-compliant key
 * file at all, so Shopify blogs are sitemap-only — see docs/indexnow/README.md
 * for the full option analysis.
 *
 * The page also matters because it was real and published: reachable by anyone
 * who guesses the handle, and listed in the store's /sitemap.xml, since
 * Shopify includes published pages there.
 *
 * Returns true when a page was deleted, false when there was nothing to
 * delete. Used by the one-off backfill (src/lib/db/backfill-indexnow.ts).
 */
export async function deleteIndexNowKeyPage(
  creds: ShopifyCreds,
  apiVersion: string = DEFAULT_API_VERSION,
): Promise<boolean> {
  const client = await createClient(creds, apiVersion);
  const handle = "indexnow-key";

  const search = await client.get<{ pages: Array<{ id: number; handle: string }> }>(
    `/pages.json`,
    { params: { handle, fields: "id,handle" } },
  );
  const existing = (search.data.pages || []).find((p) => p.handle === handle);
  if (!existing) return false;

  await client.delete(`/pages/${existing.id}.json`);
  return true;
}

/**
 * Verify Shopify credentials by hitting the shop info endpoint.
 */
export async function testConnection(
  creds: ShopifyCreds,
  apiVersion: string = DEFAULT_API_VERSION,
): Promise<ConnectionResult> {
  try {
    const client = await createClient(creds, apiVersion);
    const res = await client.get<{ shop: ShopifyShop }>("/shop.json");
    const shop = res.data.shop;
    return {
      success: true,
      platform: "shopify",
      message: `Connected to ${shop.name} (${shop.myshopify_domain})`,
      shopifyStoreName: shop.name,
      shopifyPlan: shop.plan_display_name,
    };
  } catch (error) {
    return {
      success: false,
      platform: "shopify",
      message: formatError(error),
    };
  }
}

/**
 * Set the storefront's homepage SEO title/description. Shopify's "Homepage
 * title / meta description" (Online Store → Preferences) is backed by
 * shop-level metafields — same global.title_tag / global.description_tag
 * convention netgrid already writes for articles, just owned by the shop
 * itself instead of a specific resource. Unlike article updates (where
 * nested metafields on the article PUT upsert by namespace+key), the
 * top-level /metafields.json endpoint has no parent resource to nest
 * under, so an existing shop metafield must be looked up by namespace+key
 * and updated by id; only a genuinely missing key gets created.
 */
export async function updateShopSeoMetafields(
  creds: ShopifyCreds,
  input: { metaTitle?: string; metaDescription?: string },
  apiVersion: string = DEFAULT_API_VERSION,
): Promise<PublishPostResult> {
  const wanted: Array<{ key: string; value: string }> = [];
  if (input.metaTitle && input.metaTitle.trim()) {
    wanted.push({ key: "title_tag", value: input.metaTitle.trim() });
  }
  if (input.metaDescription && input.metaDescription.trim()) {
    wanted.push({ key: "description_tag", value: input.metaDescription.trim() });
  }
  if (wanted.length === 0) {
    return { success: true, message: "Nothing to update" };
  }

  try {
    const client = await createClient(creds, apiVersion);

    const existing = await client.get<{
      metafields: Array<{ id: number; key: string }>;
    }>("/metafields.json", { params: { namespace: "global" } });
    const existingIdByKey = new Map(
      existing.data.metafields
        .filter((m) => m.key === "title_tag" || m.key === "description_tag")
        .map((m) => [m.key, m.id]),
    );

    for (const w of wanted) {
      const existingId = existingIdByKey.get(w.key);
      if (existingId) {
        await client.put(`/metafields/${existingId}.json`, {
          metafield: { id: existingId, value: w.value, type: "single_line_text_field" },
        });
      } else {
        await client.post("/metafields.json", {
          metafield: {
            namespace: "global",
            key: w.key,
            value: w.value,
            type: "single_line_text_field",
          },
        });
      }
    }

    return { success: true, message: "Homepage SEO updated on Shopify" };
  } catch (error) {
    return { success: false, message: formatError(error) };
  }
}

export async function listBlogs(
  creds: ShopifyCreds,
  apiVersion: string = DEFAULT_API_VERSION,
): Promise<ShopifyBlog[]> {
  const client = await createClient(creds, apiVersion);
  const res = await client.get<{ blogs: ShopifyBlog[] }>("/blogs.json");
  return res.data.blogs;
}

export async function getBlog(
  creds: ShopifyCreds,
  blogId: string,
  apiVersion: string = DEFAULT_API_VERSION,
): Promise<ShopifyBlog | null> {
  try {
    const client = await createClient(creds, apiVersion);
    const res = await client.get<{ blog: ShopifyBlog }>(
      `/blogs/${blogId}.json`,
    );
    return res.data.blog;
  } catch {
    return null;
  }
}

export async function fetchRecentArticles(
  creds: ShopifyCreds,
  apiVersion: string = DEFAULT_API_VERSION,
  blogId?: string,
  count: number = 5,
): Promise<ShopifyArticle[]> {
  const client = await createClient(creds, apiVersion);

  let targetBlogId = blogId;
  if (!targetBlogId) {
    const blogs = await listBlogs(creds, apiVersion);
    if (blogs.length === 0) return [];
    targetBlogId = String(blogs[0].id);
  }

  const res = await client.get<{ articles: ShopifyArticle[] }>(
    `/blogs/${targetBlogId}/articles.json`,
    { params: { limit: count, order: "published_at desc" } },
  );
  return res.data.articles;
}

/**
 * Fetch every published article on a Shopify blog. Follows the cursor-based
 * pagination in Shopify's `Link` header (max 250 per page). Caps at 50 pages
 * (12,500 articles) to avoid runaway loops on misconfigured stores.
 */
export async function fetchAllLiveArticles(
  creds: ShopifyCreds,
  apiVersion: string = DEFAULT_API_VERSION,
  blogId?: string,
): Promise<ShopifyArticle[]> {
  const client = await createClient(creds, apiVersion);

  let targetBlogId = blogId;
  if (!targetBlogId) {
    const blogs = await listBlogs(creds, apiVersion);
    if (blogs.length === 0) return [];
    targetBlogId = String(blogs[0].id);
  }

  const MAX_PAGES = 50;
  const all: ShopifyArticle[] = [];

  // First page: relative URL + query params.
  let url: string | null = `/blogs/${targetBlogId}/articles.json`;
  let params: Record<string, string | number> | undefined = {
    limit: 250,
    published_status: "published",
    order: "published_at desc",
  };

      for (let page = 0; page < MAX_PAGES && url; page++) {
    const res = await client.get<{ articles: ShopifyArticle[] }>(
      url,
      params ? { params } : undefined,
    );
    all.push(...res.data.articles);

    // Subsequent pages: Shopify returns a `Link` header with an absolute URL
    // for the next page (containing the `page_info` cursor). When we follow
    // it, the cursor encodes filters/order, so we drop our params.
    // Cast through unknown because axios's RawAxiosHeaders union includes
    // null and AxiosHeaderValue, which our string-keyed accessor can't
    // narrow. We only read two known keys ("link" / "Link") as strings.
    const headers = res.headers as unknown as Record<string, string | undefined>;
    const linkHeader = headers["link"] ?? headers["Link"];
    const nextMatch = linkHeader?.match(/<([^>]+)>;\s*rel="next"/);
    if (nextMatch) {
      url = nextMatch[1];
      params = undefined;
    } else {
      url = null;
    }
  }

  return all;
}

export interface CreateArticleOptions {
  blogId?: string;
  blogHandle?: string; // pre-cached on Blog row to skip a roundtrip
  apiVersion?: string;
}

// ── Shopify Files (GraphQL) — for body-image hosting ─────────────────────────
//
// Article body_html is capped at 1 MB by Shopify. A single base64-encoded
// Nano Banana image (~700KB-1.5MB) embedded inline blows past that. To
// keep the 2-images-per-post feature, we upload body images to Shopify
// Files via the GraphQL Admin API and replace the data: URI with the
// returned cdn.shopify.com URL before sending the article.
//
// The flow is a three-leg dance per file:
//   1. stagedUploadsCreate    → returns presigned URL + form params
//   2. PUT multipart to that URL → uploads the actual bytes
//   3. fileCreate              → registers the file, returns CDN url
// Then we poll fileCreate's status until it's READY.

interface ShopifyFileUploadResult {
  cdnUrl: string;
}

/** Decode a `data:image/...;base64,...` URI into bytes + meta. */
function decodeDataUri(
  dataUri: string,
): { mime: string; buffer: Buffer; ext: string } | null {
  const match = dataUri.match(/^data:([^;,]+)(;base64)?,(.+)$/);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const isBase64 = Boolean(match[2]);
  if (!mime.startsWith("image/")) return null;
  const buffer = isBase64
    ? Buffer.from(match[3], "base64")
    : Buffer.from(decodeURIComponent(match[3]), "binary");
  const extMap: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
  };
  return { mime, buffer, ext: extMap[mime] ?? "jpg" };
}

/**
 * Upload a single data: URI image to Shopify Files. Returns the CDN URL
 * on success, or null on any failure — caller decides whether to fall
 * back to stripping the image.
 *
 * Uses the GraphQL Admin API (REST has no Files endpoint).
 */
async function uploadDataUriToShopifyFiles(
  creds: ShopifyCreds,
  dataUri: string,
  apiVersion: string = DEFAULT_API_VERSION,
): Promise<ShopifyFileUploadResult | null> {
  const decoded = decodeDataUri(dataUri);
  if (!decoded) {
    console.warn("[shopify-files] Could not decode data URI");
    return null;
  }
  const filename = `post-body-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${decoded.ext}`;

  let host: string;
  let token: string;
  try {
    host = normalizeStoreUrl(creds.storeUrl);
    token = await resolveAccessToken(creds);
  } catch (err) {
    console.warn("[shopify-files] Token resolve failed:", err);
    return null;
  }

  const graphqlUrl = `https://${host}/admin/api/${apiVersion}/graphql.json`;

  // 1. stagedUploadsCreate — get a presigned upload target.
  const stagedQuery = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
  `;
  const stagedInput = [
    {
      resource: "FILE",
      filename,
      mimeType: decoded.mime,
      fileSize: String(decoded.buffer.length),
      httpMethod: "POST",
    },
  ];

  let stagedRes: Response;
  try {
    stagedRes = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: stagedQuery, variables: { input: stagedInput } }),
    });
  } catch (err) {
    console.warn("[shopify-files] stagedUploadsCreate request failed:", err);
    return null;
  }

  if (!stagedRes.ok) {
    console.warn(`[shopify-files] stagedUploadsCreate HTTP ${stagedRes.status}`);
    return null;
  }

  type StagedTarget = {
    url: string;
    resourceUrl: string;
    parameters: { name: string; value: string }[];
  };
  type StagedResp = {
    data?: {
      stagedUploadsCreate?: {
        stagedTargets?: StagedTarget[];
        userErrors?: { field: string[]; message: string }[];
      };
    };
    errors?: { message: string }[];
  };
  const stagedJson = (await stagedRes.json()) as StagedResp;
  if (stagedJson.errors && stagedJson.errors.length > 0) {
    const accessDenied = stagedJson.errors.some(
      (e) => e.message && /access denied|ACCESS_DENIED/i.test(e.message),
    );
    if (accessDenied) {
      console.warn(
        "[shopify-files] ACCESS_DENIED on stagedUploadsCreate.\n" +
          "  → Body images cannot be uploaded to Shopify Files because the\n" +
          "    access token lacks the 'write_files' scope.\n" +
          "  → To enable: Shopify admin → Settings → Apps and sales channels →\n" +
          "    Develop apps → [your app] → Configuration → Admin API access scopes,\n" +
          "    enable 'write_files' (also enable 'read_files' if not already),\n" +
          "    then click 'Install app' (or 'Update') to generate a new token.\n" +
          "  → Update the new token in NetGrid: Blogs → [blog] → Connection.\n" +
          "  → Until then, body images will be stripped at publish time so\n" +
          "    body_html stays under Shopify's 1 MB cap. The hero (featured)\n" +
          "    image is unaffected — it uses a different field.",
      );
    } else {
      console.warn(
        "[shopify-files] stagedUploadsCreate GraphQL errors:",
        stagedJson.errors,
      );
    }
    return null;
  }
  const target = stagedJson.data?.stagedUploadsCreate?.stagedTargets?.[0];
  const userErrors = stagedJson.data?.stagedUploadsCreate?.userErrors ?? [];
  if (!target || userErrors.length > 0) {
    console.warn(
      "[shopify-files] stagedUploadsCreate userErrors:",
      userErrors,
    );
    return null;
  }

  // 2. POST multipart to the staged URL. Parameters MUST come before
  //    the file field per S3 presigned-POST contract.
  const form = new FormData();
  for (const p of target.parameters) {
    form.append(p.name, p.value);
  }
  const blob = new Blob([new Uint8Array(decoded.buffer)], { type: decoded.mime });
  form.append("file", blob, filename);

  let uploadRes: Response;
  try {
    uploadRes = await fetch(target.url, { method: "POST", body: form });
  } catch (err) {
    console.warn("[shopify-files] staged upload PUT failed:", err);
    return null;
  }
  if (!uploadRes.ok) {
    console.warn(`[shopify-files] staged upload HTTP ${uploadRes.status}`);
    return null;
  }

  // 3. fileCreate — register the uploaded resource as a Shopify file.
  const fileCreateQuery = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
          ... on MediaImage {
            image { url }
          }
        }
        userErrors { field message }
      }
    }
  `;
  const fileCreateInput = [
    {
      contentType: "IMAGE",
      originalSource: target.resourceUrl,
      alt: "post body image",
    },
  ];

  let createRes: Response;
  try {
    createRes = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: fileCreateQuery, variables: { files: fileCreateInput } }),
    });
  } catch (err) {
    console.warn("[shopify-files] fileCreate request failed:", err);
    return null;
  }
  if (!createRes.ok) {
    console.warn(`[shopify-files] fileCreate HTTP ${createRes.status}`);
    return null;
  }
  type FileCreateResp = {
    data?: {
      fileCreate?: {
        files?: {
          id: string;
          fileStatus: string;
          image?: { url?: string };
        }[];
        userErrors?: { field: string[]; message: string }[];
      };
    };
    errors?: { message: string }[];
  };
  const createJson = (await createRes.json()) as FileCreateResp;
  if (createJson.errors && createJson.errors.length > 0) {
    console.warn("[shopify-files] fileCreate GraphQL errors:", createJson.errors);
    return null;
  }
  const file = createJson.data?.fileCreate?.files?.[0];
  const ferrs = createJson.data?.fileCreate?.userErrors ?? [];
  if (!file || ferrs.length > 0) {
    console.warn("[shopify-files] fileCreate userErrors:", ferrs);
    return null;
  }

  // 4. Poll for READY — fileCreate returns immediately, but Shopify
  //    processes the image asynchronously. Poll the file by id until
  //    image.url is populated. Bail after ~10s — caller falls back.
  const fileId = file.id;
  if (file.image?.url) {
    return { cdnUrl: file.image.url };
  }

  const pollQuery = `
    query fileById($id: ID!) {
      node(id: $id) {
        ... on MediaImage {
          fileStatus
          image { url }
        }
      }
    }
  `;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const pollRes = await fetch(graphqlUrl, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: pollQuery, variables: { id: fileId } }),
      });
      if (!pollRes.ok) continue;
      type PollResp = {
        data?: {
          node?: { fileStatus?: string; image?: { url?: string } };
        };
      };
      const pollJson = (await pollRes.json()) as PollResp;
      const node = pollJson.data?.node;
      if (node?.image?.url) return { cdnUrl: node.image.url };
      if (node?.fileStatus === "FAILED") {
        console.warn("[shopify-files] file processing FAILED");
        return null;
      }
    } catch {
      // continue polling
    }
  }
  console.warn("[shopify-files] file did not become READY within 10s");
  return null;
}

/**
 * Walk body HTML for <img src="data:image/...">, upload each to
 * Shopify Files, and swap the src for the returned CDN URL. If any
 * upload fails, that <img> is stripped entirely as a safety net so
 * body_html stays under Shopify's 1 MB cap.
 *
 * Returns the rewritten body HTML.
 */
async function rewriteBodyDataUrisToShopifyUrls(
  creds: ShopifyCreds,
  body: string,
  apiVersion: string,
): Promise<string> {
  // Match <img ... src="data:image/...;base64,...." ...> (single OR double
  // quoted). Lazy on closing > so we don't accidentally span tags.
  const imgRegex =
    /<img\s+([^>]*?)src=(['"])(data:image\/[^'"]+)\2([^>]*)>/gi;
  const matches: Array<{ full: string; before: string; uri: string; after: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = imgRegex.exec(body)) !== null) {
    matches.push({ full: m[0], before: m[1], uri: m[3], after: m[4] });
  }
  if (matches.length === 0) return body;

  console.info(
    `[shopify-files] Found ${matches.length} data: URI image(s) in body, uploading…`,
  );

  let rewritten = body;
  for (const match of matches) {
    const result = await uploadDataUriToShopifyFiles(creds, match.uri, apiVersion);
    if (result) {
      const replacement = `<img ${match.before}src="${result.cdnUrl}"${match.after}>`;
      rewritten = rewritten.replace(match.full, replacement);
      console.info(`[shopify-files] Uploaded → ${result.cdnUrl}`);
      continue;
    }

    // Upload failed (commonly because the access token lacks write_files).
    // Fall back: try to compress the image small enough to inline under
    // Shopify's 1 MB body_html cap.
    const compressed = await compressImageDataUri(match.uri, {
      maxBytes: 500 * 1024, // leave headroom for the rest of body_html
      maxWidth: 1024,
      quality: 72,
    });
    if (compressed) {
      const replacement = `<img ${match.before}src="${compressed}"${match.after}>`;
      rewritten = rewritten.replace(match.full, replacement);
      console.info(
        `[shopify-files] Upload unavailable; inlining compressed JPEG (${Math.round(compressed.length / 1024)} KB)`,
      );
      continue;
    }

    // Both upload AND compression failed — strip the img to keep body_html
    // under the cap. Wrap in a comment for traceability.
    rewritten = rewritten.replace(
      match.full,
      "<!-- body image: upload + compression both failed; stripped to fit body_html limit -->",
    );
    console.warn(
      "[shopify-files] Upload + compression both failed; img stripped from body",
    );
  }

  return rewritten;
}

/**
 * Publish or draft an article to a Shopify blog.
 *
 * If `input.featuredImageUrl` is set, we download the image bytes ourselves
 * (following redirects) and send them inline as `article.image.attachment`
 * (base64). This avoids Shopify having to fetch the URL — important because
 * Shopify's image fetcher does not follow redirects, and many image sources
 * (picsum.photos, DALL-E, signed S3 URLs) either redirect or expire quickly.
 *
 * Falls back to `image.src` if the byte fetch fails for any reason.
 *
 * Any data: URI <img> tags in the body HTML are uploaded to Shopify Files
 * via GraphQL and rewritten to CDN URLs before publish, to keep body_html
 * under Shopify's 1 MB cap.
 *
 * Returns the article's canonical URL: /blogs/{blogHandle}/{articleHandle}
 */

/** Stable non-crypto hash, seeded per-blog so the byline varies site-to-site. */
function shopifyHashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Per-blog author byline. Shopify stamps "Shopify API" on every article
 * created via the Admin API unless an `author` is supplied — the same byline
 * across the whole network is a glaring footprint. We derive a stable human
 * name from the store identity so each blog has its own consistent author,
 * while different blogs get different names. Same store → same author always.
 */
const AUTHOR_FIRST = [
  "Emma", "Liam", "Olivia", "Noah", "Ava", "Ethan", "Sophia", "Mason",
  "Isabella", "Lucas", "Mia", "Henry", "Charlotte", "Jack", "Amelia",
  "Owen", "Harper", "Leo", "Grace", "Daniel", "Chloe", "Nathan", "Lily",
  "Adam", "Hannah", "Caleb", "Zoe", "Ryan", "Nora", "Eli",
];
const AUTHOR_LAST = [
  "Bennett", "Carter", "Reed", "Hayes", "Brooks", "Morgan", "Foster",
  "Price", "Hughes", "Coleman", "Walsh", "Porter", "Sutton", "Lane",
  "Wells", "Hart", "Frost", "Dawson", "Cross", "Sloan", "Marsh", "Quinn",
  "Vance", "Boyd", "Nash", "Ellis", "Webb", "Shaw", "Fox", "Burke",
];
function authorNameForStore(seed: string): string {
  const h = shopifyHashSeed(seed);
  const first = AUTHOR_FIRST[h % AUTHOR_FIRST.length];
  const last = AUTHOR_LAST[(h >> 5) % AUTHOR_LAST.length];
  return `${first} ${last}`;
}
export async function createArticle(
  creds: ShopifyCreds,
  input: PublishPostInput,
  options: CreateArticleOptions = {},
): Promise<PublishPostResult & { blogHandle?: string }> {
  const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;

  try {
    const client = await createClient(creds, apiVersion, PUBLISH_TIMEOUT_MS);

    let targetBlogId = options.blogId;
    let blogHandle = options.blogHandle;

    // Resolve missing blog id and/or handle in a single /blogs.json call
    if (!targetBlogId || !blogHandle) {
      const blogs = await listBlogs(creds, apiVersion);
      if (blogs.length === 0) {
        return {
          success: false,
          message: "No blogs exist on this Shopify store. Create one first.",
        };
      }

      const targetBlog = targetBlogId
        ? blogs.find((b) => String(b.id) === targetBlogId) ?? blogs[0]
        : blogs[0];

      targetBlogId = String(targetBlog.id);
      blogHandle = targetBlog.handle;
    }

    const published = (input.status ?? "publish") === "publish";

    // Build the image payload: prefer base64 attachment, fall back to src.
    let imagePayload: Record<string, unknown> | undefined;
    let imageMode: "attachment" | "src" | "none" = "none";

    if (input.featuredImageUrl) {
      const fetched = await fetchImageAsBase64(input.featuredImageUrl);
      if (fetched) {
        imagePayload = {
          attachment: fetched.attachment,
          filename: fetched.filename,
          alt: input.title,
        };
        imageMode = "attachment";
      } else {
        imagePayload = { src: input.featuredImageUrl, alt: input.title };
        imageMode = "src";
      }
    }

    // Rewrite any embedded data: URI images in the body to Shopify CDN
    // URLs (or strip if upload fails). Keeps body_html under 1 MB.
    const rewrittenBody = await rewriteBodyDataUrisToShopifyUrls(
      creds,
      input.content,
      apiVersion,
    );

    // SEO metafields. Shopify's Online Store theme renders these as the
    // article's <title> and <meta name="description">:
    //   namespace "global", key "title_tag"        → SEO title
    //   namespace "global", key "description_tag"   → SEO meta description
    // Without them the theme falls back to the raw article title and no
    // meta description at all (the "meta description is missing" audit error).
    const metafields: Array<{
      namespace: string;
      key: string;
      value: string;
      type: string;
    }> = [];
    if (input.metaTitle && input.metaTitle.trim()) {
      metafields.push({
        namespace: "global",
        key: "title_tag",
        value: input.metaTitle.trim(),
        type: "single_line_text_field",
      });
    }
    if (input.metaDescription && input.metaDescription.trim()) {
      metafields.push({
        namespace: "global",
        key: "description_tag",
        value: input.metaDescription.trim(),
        type: "single_line_text_field",
      });
    }

    const res = await client.post<{ article: ShopifyArticle }>(
      `/blogs/${targetBlogId}/articles.json`,
      {
        article: {
          title: input.title,
          author: (input.author && input.author.trim()) ||
            authorNameForStore(blogHandle || creds.storeUrl),
          body_html: rewrittenBody,
          summary_html: input.excerpt,
          tags: input.tags?.join(", "),
          published,
          // Explicit keyword-first handle from the caller.
          // Omitted → Shopify derives the handle from the title.
          ...(input.slug && input.slug.trim() && { handle: input.slug.trim() }),
          ...(imagePayload && { image: imagePayload }),
          ...(metafields.length > 0 && { metafields }),
        },
      },
    );

    const article = res.data.article;
    const storeHost = normalizeStoreUrl(creds.storeUrl);

    const imageNote =
      imageMode === "attachment"
        ? " with cover image (uploaded)"
        : imageMode === "src"
          ? " with cover image (linked)"
          : "";

    return {
      success: true,
      message: `Article "${article.title}" ${
        published ? "published" : "saved as draft"
      }${imageNote}`,
      postId: article.id,
      postUrl: `https://${storeHost}/blogs/${blogHandle}/${article.handle}`,
      blogHandle,
      // Metafields ride along inside the article POST. Shopify accepts the
      // article and silently discards metafields it rejects, so a 2xx here
      // is not confirmation that global.title_tag / global.description_tag
      // were set. Reading them back is a second API call per publish —
      // deliberately out of scope for T22; T14 owns that decision.
      metaStatus: metafields.length > 0 ? "unverified" : "skipped",
    };
  } catch (error) {
    return { success: false, message: formatError(error) };
  }
}

/**
 * Resolve the numeric blog id for a store. Prefers a cached handle (one
 * /blogs.json call), falls back to the first blog. Used by the SEO backfill
 * so we resolve once per blog instead of per article.
 */
// Blog-id resolution requires a GET /blogs.json round-trip. Batch jobs (e.g.
// semantic linking) resolve the same store's blog id for many posts in quick
// succession, which used to hammer Shopify's REST limit. Cache the result
// per store+handle for a few minutes — blogs rarely change and a stale entry
// just means one extra lookup after it expires.
const blogIdCache = new Map<
  string,
  { value: { blogId: string; blogHandle: string }; expiresAt: number }
>();
const BLOG_ID_TTL_MS = 10 * 60 * 1000;

export async function resolveBlogId(
  creds: ShopifyCreds,
  blogHandle?: string | null,
  apiVersion: string = DEFAULT_API_VERSION,
): Promise<{ blogId: string; blogHandle: string } | null> {
  const cacheKey = `${normalizeStoreUrl(creds.storeUrl)}::${blogHandle ?? ""}`;
  const hit = blogIdCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const blogs = await listBlogs(creds, apiVersion);
  if (blogs.length === 0) return null;
  const target =
    (blogHandle && blogs.find((b) => b.handle === blogHandle)) || blogs[0];
  const value = { blogId: String(target.id), blogHandle: target.handle };
  blogIdCache.set(cacheKey, { value, expiresAt: Date.now() + BLOG_ID_TTL_MS });
  return value;
}

/** Fetch a single article (includes body_html) by blog + article id. */
export async function getArticle(
  creds: ShopifyCreds,
  blogId: string,
  articleId: string | number,
  apiVersion: string = DEFAULT_API_VERSION,
): Promise<ShopifyArticle | null> {
  return (await getArticleResult(creds, blogId, articleId, apiVersion)).article;
}

/**
 * Like getArticle, but surfaces WHY a fetch failed instead of collapsing
 * everything to null. Lets callers distinguish a deleted article (404 Not
 * Found) from a permissions problem (403 → "enable read_content/write_content")
 * — e.g. the semantic-linking diagnostics.
 */
export async function getArticleResult(
  creds: ShopifyCreds,
  blogId: string,
  articleId: string | number,
  apiVersion: string = DEFAULT_API_VERSION,
): Promise<{ article: ShopifyArticle | null; error?: string }> {
  try {
    const client = await createClient(creds, apiVersion);
    const res = await client.get<{ article: ShopifyArticle }>(
      `/blogs/${blogId}/articles/${articleId}.json`,
    );
    return { article: res.data.article };
  } catch (error) {
    return { article: null, error: formatError(error) };
  }
}

/** Permanently delete an article from a blog. */
export async function deleteArticle(
  creds: ShopifyCreds,
  blogId: string,
  articleId: string | number,
  apiVersion: string = DEFAULT_API_VERSION,
): Promise<{ deleted: boolean; message?: string }> {
  try {
    const client = await createClient(creds, apiVersion, PUBLISH_TIMEOUT_MS);
    await client.delete(`/blogs/${blogId}/articles/${articleId}.json`);
    return { deleted: true };
  } catch (error) {
    return { deleted: false, message: formatError(error) };
  }
}

/**
 * Update an existing article's body and/or SEO metafields. Used by the SEO
 * backfill to retroactively fix already-published posts:
 *   - bodyHtml         → replace body_html (e.g. after demoting body H1s)
 *   - metaTitle        → global.title_tag metafield (<title>)
 *   - metaDescription  → global.description_tag metafield (meta description)
 *
 * Only the provided fields are sent. Shopify upserts metafields by
 * namespace+key, so re-running is idempotent.
 */
export async function updateArticle(
  creds: ShopifyCreds,
  blogId: string,
  articleId: string | number,
  input: {
    bodyHtml?: string;
    metaTitle?: string;
    metaDescription?: string;
    /** Sets the article excerpt (summary_html) — Shopify's teaser/fallback meta. */
    excerptHtml?: string;
    blogHandle?: string;
    /**
     * Additional metafields to set on the article, beyond the SEO
     * title/description ones derived from metaTitle/metaDescription. Used by
     * semantic linking to write custom.netgrid_related_posts (a JSON list of
     * related articles) so themes/tooling can read it.
     */
    extraMetafields?: Array<{
      namespace: string;
      key: string;
      value: string;
      type: string;
    }>;
  },
  apiVersion: string = DEFAULT_API_VERSION,
): Promise<PublishPostResult> {
  try {
    const client = await createClient(creds, apiVersion, PUBLISH_TIMEOUT_MS);

    const metafields: Array<{
      namespace: string;
      key: string;
      value: string;
      type: string;
    }> = [];
    if (input.extraMetafields && input.extraMetafields.length > 0) {
      metafields.push(...input.extraMetafields);
    }
    if (input.metaTitle && input.metaTitle.trim()) {
      metafields.push({
        namespace: "global",
        key: "title_tag",
        value: input.metaTitle.trim(),
        type: "single_line_text_field",
      });
    }
    if (input.metaDescription && input.metaDescription.trim()) {
      metafields.push({
        namespace: "global",
        key: "description_tag",
        value: input.metaDescription.trim(),
        type: "single_line_text_field",
      });
    }

    const article: Record<string, unknown> = { id: Number(articleId) };
    if (input.bodyHtml !== undefined) article.body_html = input.bodyHtml;
    if (input.excerptHtml !== undefined && input.excerptHtml.trim()) {
      article.summary_html = input.excerptHtml.trim();
    }
    if (metafields.length > 0) article.metafields = metafields;

    const res = await client.put<{ article: ShopifyArticle }>(
      `/blogs/${blogId}/articles/${articleId}.json`,
      { article },
    );
    const a = res.data.article;
    const storeHost = normalizeStoreUrl(creds.storeUrl);
    return {
      success: true,
      message: `Article "${a.title}" updated`,
      postId: a.id,
      postUrl: input.blogHandle
        ? `https://${storeHost}/blogs/${input.blogHandle}/${a.handle}`
        : `https://${storeHost}/blogs/${a.handle}`,
    };
  } catch (error) {
    return { success: false, message: formatError(error) };
  }
}