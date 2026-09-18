/**
 * Get a blog's sitemap into Google Search Console, once, at onboarding — and
 * prove it landed.
 *
 * Google has supported no unauthenticated sitemap ping since 2023, so this is
 * the only programmatic path. It is deliberately idempotent and cheap to
 * re-run: sitemaps.submit is a PUT, and re-submitting an already-known sitemap
 * is a no-op that refreshes lastSubmitted.
 *
 * Called from createBlog (fire-and-forget) and from the daily
 * /api/cron/index-submit sweep, which is the durable path — a floating promise
 * in a server action can be cut short when the request ends, so the sweep is
 * what guarantees eventual submission.
 *
 * Uses T04's gsc-client rather than a second Search Console client: one
 * implementation, one auth path, one retry policy.
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { blogs as blogsTable } from "@/lib/db/schema";
import { canonicalHost } from "@/lib/services/indexnow-key";
import { discoverSitemap } from "@/lib/services/sitemap-discovery";
import {
  addSite,
  getSitemapStatus,
  gscConfigured,
  submitSitemap,
  urlPrefixProperty,
} from "@/lib/services/gsc-client";
import { recordIndexEvent } from "@/lib/services/index-events";

export interface SitemapSubmitResult {
  ok: boolean;
  sitemapUrl?: string;
  message: string;
}

export async function ensureSitemapSubmitted(
  blogId: string,
  opts: { force?: boolean } = {},
): Promise<SitemapSubmitResult> {
  const [blog] = await db
    .select()
    .from(blogsTable)
    .where(eq(blogsTable.id, blogId));
  if (!blog) return { ok: false, message: "Blog not found" };

  // Same kill switch as the rest of the GSC surface: with no service account
  // configured every Google call is a no-op, and that is a deliberate state,
  // not a failure worth alerting on.
  if (!gscConfigured()) {
    await recordIndexEvent({
      blogId: blog.id,
      channel: "gsc_sitemap",
      outcome: "skipped",
      error: "GSC service account not configured",
    });
    return { ok: false, message: "Search Console is not configured" };
  }

  if (!opts.force && blog.sitemapSubmittedAt) {
    return {
      ok: true,
      sitemapUrl: blog.sitemapUrl ?? undefined,
      message: "Already submitted",
    };
  }

  const host = canonicalHost(blog.domain);
  if (!host) {
    return await fail(
      blog.id,
      `blogs.domain ("${blog.domain}") is not a usable public hostname`,
    );
  }

  // 1. Find a sitemap that actually returns sitemap XML.
  const platform = blog.platform === "shopify" ? "shopify" : "wordpress";
  const discovery = await discoverSitemap(host, platform);
  if (!discovery.sitemapUrl) {
    const detail = discovery.attempts
      .map((a) => `${a.url} -> ${a.reason ?? "?"}`)
      .join("; ");
    return await fail(blog.id, `no reachable sitemap. Tried: ${detail}`);
  }
  const sitemapUrl = discovery.sitemapUrl;

  // The property identifier must match Search Console byte for byte. Prefer
  // the one T04 already provisioned for this blog; fall back to the URL-prefix
  // form for blogs provisioned before that column existed.
  const siteUrl = blog.gscSiteUrl?.trim() || urlPrefixProperty(host);

  // 2. Make sure the property exists. Harmless when it already does; on an
  //    unverified property this succeeds but the submit below still 403s,
  //    which is the signal that a human must verify ownership.
  try {
    await addSite(siteUrl);
  } catch (err) {
    console.warn(
      `[gsc] sites.add for ${siteUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 3. Submit.
  try {
    await submitSitemap(siteUrl, sitemapUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = /\b403\b|permission/i.test(message)
      ? " — the service account is probably not a Full user on this verified property (see T04 / T15 §4.3)"
      : "";
    return await fail(
      blog.id,
      `sitemaps.submit failed${hint}: ${message}`,
      sitemapUrl,
    );
  }

  // 4. Read it back. Acceptance only means "accepted"; the status call is what
  //    proves Search Console has the entry on the property.
  const status = await getSitemapStatus(siteUrl, sitemapUrl);

  await db
    .update(blogsTable)
    .set({
      sitemapUrl,
      sitemapSubmittedAt: new Date(),
      sitemapSubmitError: null,
      updatedAt: new Date(),
    })
    .where(eq(blogsTable.id, blog.id));

  await recordIndexEvent({
    blogId: blog.id,
    channel: "gsc_sitemap",
    outcome: "ok",
    targetUrl: sitemapUrl,
    httpStatus: 200,
    error: status ? null : "submitted, but sitemaps.get returned no entry",
  });

  return {
    ok: true,
    sitemapUrl,
    message: `Submitted ${sitemapUrl} to ${siteUrl}`,
  };
}

async function fail(
  blogId: string,
  message: string,
  sitemapUrl?: string,
  httpStatus?: number,
): Promise<SitemapSubmitResult> {
  await db
    .update(blogsTable)
    .set({ sitemapSubmitError: message.slice(0, 2000), updatedAt: new Date() })
    .where(eq(blogsTable.id, blogId));

  await recordIndexEvent({
    blogId,
    channel: "gsc_sitemap",
    outcome: "failed",
    targetUrl: sitemapUrl ?? null,
    httpStatus: httpStatus ?? null,
    error: message,
  });

  console.warn(`[gsc] ${blogId}: ${message}`);
  return { ok: false, message };
}
