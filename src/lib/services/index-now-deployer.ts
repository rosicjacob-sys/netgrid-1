/**
 * Make each blog's IndexNow key file reachable at its DOCUMENT ROOT, and
 * return the URL to pass as `keyLocation` on the ping.
 *
 * --- What changed and why ---
 *
 * Previously this uploaded the key into the WordPress media library
 * (/wp-content/uploads/YYYY/MM/{key}.txt) and published a Shopify Page at
 * /pages/indexnow-key. IndexNow scopes a key file to its own directory, so
 * neither location authorised a single post URL, and the Shopify "key file"
 * was a themed HTML document rather than a text file whose body is the key.
 * Both paths are gone.
 *
 *   WordPress -> POST the key to the NetGrid MU-plugin, which serves
 *                https://{domain}/{key}.txt as text/plain. We then FETCH that
 *                URL and assert 200 / text/* / body === key before returning
 *                it, because a host that serves *.txt from disk will accept
 *                the REST call and still 404 the file.
 *   Shopify   -> not supported. Shopify cannot host a spec-compliant key file
 *                at a path that covers /blogs/* article URLs. Sitemap-only.
 *
 * --- Caching ---
 *
 * The old cache stored failures forever (no TTL, process lifetime), so one
 * transient timeout disabled IndexNow for a blog until the Render service
 * restarted — and because failures were console.warn only, invisibly. The
 * cache now expires: 6h on success, 10min on failure.
 *
 * Failure is non-fatal: the publish has already succeeded by the time this
 * runs. Every outcome is recorded in index_ping_events so it is queryable and
 * alertable.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { blogs as blogsTable } from "@/lib/db/schema";
import {
  setIndexNowKeyViaMuPlugin,
  MuPluginMissingError,
} from "@/lib/services/wp-client";
import {
  getOrCreateBlogKey,
  markKeyVerified,
  verifyKeyFile,
} from "@/lib/services/indexnow-key";
import { recordIndexEvent } from "@/lib/services/index-events";

type Blog = typeof blogsTable.$inferSelect;

const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const FAILURE_TTL_MS = 10 * 60 * 1000; // 10min

interface CacheEntry {
  value: DeployedKey | null;
  expiresAt: number;
}

/**
 * Process-memory cache, keyed by blog id. Unlike the previous version this has
 * a TTL on BOTH branches, so a transient failure costs at most 10 minutes of
 * IndexNow coverage instead of the rest of the process lifetime.
 */
const keyLocationCache = new Map<string, CacheEntry>();

/**
 * Both halves of the material the pinger needs. Returning the key here — not
 * just the location — is deliberate: the caller holds a Blog row that was read
 * BEFORE this function possibly minted and persisted a key, so reading
 * `blog.indexnowKey` after the fact would see a stale null and mint a second,
 * conflicting key.
 */
export interface DeployedKey {
  key: string;
  keyLocation: string;
}

/**
 * Ensure this blog's key file is live and verified, and return the key plus
 * its URL. Returns null when the platform is unsupported, credentials are
 * missing, the domain is unusable, or verification failed.
 *
 * Safe on the publish hot path: cache hits do no network IO, and the cold path
 * is bounded by the two 8-10s timeouts below.
 */
export async function ensureIndexNowKeyDeployed(
  blog: Blog,
): Promise<DeployedKey | null> {
  const now = Date.now();
  const cached = keyLocationCache.get(blog.id);
  if (cached && cached.expiresAt > now) return cached.value;

  let result: DeployedKey | null = null;
  try {
    result = await deployAndVerify(blog);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[indexnow-deploy] FAILED for ${blog.domain} (${blog.platform}): ${msg.slice(0, 200)}`,
    );
    await recordIndexEvent({
      blogId: blog.id,
      channel: "indexnow_deploy",
      outcome: "failed",
      error: msg,
    });
  }

  keyLocationCache.set(blog.id, {
    value: result,
    expiresAt: now + (result ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
  });
  return result;
}

async function deployAndVerify(blog: Blog): Promise<DeployedKey | null> {
  if (blog.platform === "shopify") {
    // Not a failure — a documented platform limitation. Recorded as "skipped"
    // so it never shows up in the failure alert counts.
    await recordIndexEvent({
      blogId: blog.id,
      channel: "indexnow_deploy",
      outcome: "skipped",
      error:
        "Shopify cannot host a spec-compliant IndexNow key file covering /blogs/* — sitemap-only",
    });
    return null;
  }
  if (blog.platform !== "wordpress") {
    await recordIndexEvent({
      blogId: blog.id,
      channel: "indexnow_deploy",
      outcome: "skipped",
      error: `unknown platform "${blog.platform}"`,
    });
    return null;
  }
  if (!blog.wpUrl || !blog.wpUsername || !blog.wpAppPassword) {
    await recordIndexEvent({
      blogId: blog.id,
      channel: "indexnow_deploy",
      outcome: "skipped",
      error: "WordPress credentials incomplete (wpUrl / wpUsername / wpAppPassword)",
    });
    return null;
  }

  const material = await getOrCreateBlogKey(blog);
  if (!material) {
    await recordIndexEvent({
      blogId: blog.id,
      channel: "indexnow_deploy",
      outcome: "skipped",
      error: `blogs.domain ("${blog.domain}") is not a usable public hostname`,
    });
    return null;
  }
  const { key, keyLocation } = material;

  // 1. Tell the MU-plugin which key to serve. Idempotent (update_option).
  try {
    await setIndexNowKeyViaMuPlugin(
      blog.wpUrl,
      blog.wpUsername,
      blog.wpAppPassword,
      key,
    );
  } catch (err) {
    const isMissing = err instanceof MuPluginMissingError;
    await recordIndexEvent({
      blogId: blog.id,
      channel: "indexnow_deploy",
      outcome: "failed",
      keyLocation,
      httpStatus: isMissing ? 404 : null,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // 2. Verify it the way a search engine will. This is the step whose absence
  //    let the old implementation report success for years.
  const check = await verifyKeyFile(keyLocation, key);
  if (!check.ok) {
    await recordIndexEvent({
      blogId: blog.id,
      channel: "indexnow_deploy",
      outcome: "failed",
      keyLocation,
      httpStatus: check.status,
      error: `key file not valid: ${check.reason ?? "unknown"} (body: ${check.bodyExcerpt})`,
    });
    return null;
  }

  await markKeyVerified(blog.id);
  await recordIndexEvent({
    blogId: blog.id,
    channel: "indexnow_deploy",
    outcome: "ok",
    keyLocation,
    httpStatus: 200,
  });
  console.info(`[indexnow-deploy] ${blog.domain} key file verified at ${keyLocation}`);
  return { key, keyLocation };
}

/** Reload a blog row — used by the daily sweep after a key rotation. */
export async function reloadBlog(blogId: string): Promise<Blog | null> {
  const [row] = await db
    .select()
    .from(blogsTable)
    .where(eq(blogsTable.id, blogId));
  return row ?? null;
}

/** Test hook — clear the in-process cache. */
export function _clearIndexNowDeployCache(): void {
  keyLocationCache.clear();
}
