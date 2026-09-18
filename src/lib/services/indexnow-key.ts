/**
 * Per-blog IndexNow key material.
 *
 * --- The rule this module exists to enforce ---
 *
 * IndexNow scopes a key file to its own directory. A key served at
 *
 *     https://example.com/wp-content/uploads/2026/08/KEY.txt
 *
 * authorises submissions for https://example.com/wp-content/uploads/2026/08/**
 * and NOTHING ELSE. Post permalinks are at the site root, so the key file
 * must be at the site root:
 *
 *     https://example.com/KEY.txt   ->   body is exactly "KEY", text/plain
 *
 * Three conditions, all required: HTTP 200; a text/* content type; a body
 * whose trimmed content IS the key. A themed HTML page that merely contains
 * the key does not satisfy the third.
 *
 * --- Why per-blog keys ---
 *
 * The key file is public by design at a guessable URL on every domain we
 * operate. One key across the network turns "is this domain part of the
 * network?" into a single unauthenticated GET, and hands every receiving
 * engine the adjacency list for free. See docs/indexnow/README.md.
 */

import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { blogs as blogsTable } from "@/lib/db/schema";

type Blog = typeof blogsTable.$inferSelect;

/** IndexNow allows [a-zA-Z0-9-], 8-128 chars. 32 hex chars = 128 bits. */
const KEY_RE = /^[a-zA-Z0-9-]{8,128}$/;
const KEY_FETCH_TIMEOUT_MS = 8000;
const USER_AGENT = "NetgridIndexNowBot/1.0 (+https://netgrid.app)";

export function generateIndexNowKey(): string {
  return randomBytes(16).toString("hex");
}

export function isValidIndexNowKey(key: string): boolean {
  return KEY_RE.test(key);
}

/**
 * Normalise blogs.domain ("Example.com", "https://example.com/",
 * "example.com:8080") to a bare public hostname, or null when the stored
 * value cannot be one. Mirrors the guard in toCanonicalUrl
 * (services/canonical-url.ts) — IndexNow refuses IPs and ports outright.
 */
export function canonicalHost(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const clean = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  if (
    !clean ||
    /^[\d.]+$/.test(clean) ||
    clean.includes(":") ||
    !clean.includes(".")
  ) {
    return null;
  }
  return clean;
}

/** The only spec-compliant location: the key file at the document root. */
export function keyLocationForHost(host: string, key: string): string {
  return `https://${host}/${key}.txt`;
}

export interface KeyFileCheck {
  ok: boolean;
  status: number | null;
  contentType: string | null;
  /** First 200 chars of the response body, for the failure record. */
  bodyExcerpt: string;
  /** Human-readable failure cause; undefined when ok. */
  reason?: string;
}

/**
 * Fetch the key file the way a verifier does and assert all three required
 * properties. Never throws — network errors come back as ok:false.
 */
export async function verifyKeyFile(
  keyLocation: string,
  key: string,
): Promise<KeyFileCheck> {
  try {
    const res = await fetch(keyLocation, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(KEY_FETCH_TIMEOUT_MS),
    });
    const contentType = res.headers.get("content-type");
    const body = await res.text().catch(() => "");
    const bodyExcerpt = body.slice(0, 200);

    if (res.status !== 200) {
      return {
        ok: false,
        status: res.status,
        contentType,
        bodyExcerpt,
        reason: `HTTP ${res.status} at ${keyLocation}`,
      };
    }
    if (!contentType || !/^text\//i.test(contentType.trim())) {
      return {
        ok: false,
        status: 200,
        contentType,
        bodyExcerpt,
        reason: `content-type is "${contentType ?? "(none)"}", expected text/plain`,
      };
    }
    if (body.trim() !== key) {
      return {
        ok: false,
        status: 200,
        contentType,
        bodyExcerpt,
        reason:
          "body is not exactly the key (a page that merely contains the key is not a key file)",
      };
    }
    return { ok: true, status: 200, contentType, bodyExcerpt };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: null,
      contentType: null,
      bodyExcerpt: "",
      reason: msg,
    };
  }
}

/**
 * This blog's key + key location, minting and persisting one on first use.
 * Returns null when blogs.domain is not a usable public hostname, since there
 * is then nowhere to host a key file.
 */
export async function getOrCreateBlogKey(
  blog: Blog,
): Promise<{ key: string; keyLocation: string } | null> {
  const host = canonicalHost(blog.domain);
  if (!host) return null;

  const existing = blog.indexnowKey?.trim() ?? "";
  const key = isValidIndexNowKey(existing) ? existing : generateIndexNowKey();
  const keyLocation =
    blog.indexnowKeyLocation?.trim() || keyLocationForHost(host, key);

  if (key !== blog.indexnowKey || keyLocation !== blog.indexnowKeyLocation) {
    await db
      .update(blogsTable)
      .set({
        indexnowKey: key,
        indexnowKeyLocation: keyLocation,
        updatedAt: new Date(),
      })
      .where(eq(blogsTable.id, blog.id));
  }

  return { key, keyLocation };
}

/** Stamp a successful verification so the daily sweep can skip fresh blogs. */
export async function markKeyVerified(blogId: string): Promise<void> {
  await db
    .update(blogsTable)
    .set({ indexnowKeyVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(blogsTable.id, blogId));
}
