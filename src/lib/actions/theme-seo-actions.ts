"use server";

import { db } from "@/lib/db";
import { blogs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/helpers";
import { buildShopifyCreds } from "@/lib/services/platform-client";
import {
  injectSeoMetaTags,
  inspectThemeSeo as inspectThemeSeoClient,
  fixThemeMetaDescription as fixThemeMetaDescriptionClient,
  optimizeThemeSeo as optimizeThemeSeoClient,
  type ThemeSeoResult,
  type ThemeSeoInspection,
  type ThemeOptimizeResult,
} from "@/lib/services/shopify-theme-client";

/** Shared: load a Shopify blog and build its API creds, or return an error. */
async function shopifyCredsForBlog(blogId: string) {
  const [blog] = await db
    .select()
    .from(blogs)
    .where(eq(blogs.id, blogId))
    .limit(1);
  if (!blog) return { ok: false as const, message: "Blog not found." };
  if (blog.platform !== "shopify") {
    return { ok: false as const, message: "Theme SEO fixes only apply to Shopify blogs." };
  }
  const built = buildShopifyCreds(blog);
  if (!built.ok) return { ok: false as const, message: built.message };
  return { ok: true as const, creds: built.creds, clientId: blog.clientId };
}

/**
 * Install (or update) the netgrid SEO block in a Shopify store's published
 * theme. Idempotent — safe to re-run; replaces the managed block in place.
 *
 * T02: the block carries no tracking — re-running on a store that still has a
 * v2 block swaps the beacon-bearing version for the clean v3 one.
 *
 * Requires the Shopify app to have the read_themes / write_themes scopes.
 */
export async function applyThemeSeoFix(
  blogId: string,
): Promise<ThemeSeoResult> {
  await requireAdmin();

  const [blog] = await db
    .select()
    .from(blogs)
    .where(eq(blogs.id, blogId))
    .limit(1);

  if (!blog) {
    return { success: false, message: "Blog not found." };
  }
  if (blog.platform !== "shopify") {
    return {
      success: false,
      message: "Theme SEO fixes only apply to Shopify blogs.",
    };
  }

  const built = buildShopifyCreds(blog);
  if (!built.ok) {
    return { success: false, message: built.message };
  }

  return injectSeoMetaTags(built.creds);
}

/**
 * One-click theme SEO optimization: meta description (repoint or inject),
 * apple-touch-icon favicon, and OG + JSON-LD article schema — the programmatic
 * equivalent of the manual theme.liquid / meta-tags.liquid edits that lift the
 * SEO score. Idempotent. Requires read_themes / write_themes / write_theme_code.
 */
export async function optimizeThemeSeo(
  blogId: string,
): Promise<ThemeOptimizeResult> {
  await requireAdmin();
  const r = await shopifyCredsForBlog(blogId);
  if (!r.ok) return { success: false, message: r.message };
  return optimizeThemeSeoClient(r.creds);
}

/**
 * Read-only: report how the store's published theme builds its
 * <meta name="description"> and <title>, so we know whether it uses the SEO
 * field (correct) or the article body (the cause of "meta description too
 * long"). Requires read_themes.
 */
export async function inspectThemeSeo(
  blogId: string,
): Promise<ThemeSeoInspection> {
  await requireAdmin();
  const r = await shopifyCredsForBlog(blogId);
  if (!r.ok) return { success: false, message: r.message };
  return inspectThemeSeoClient(r.creds);
}

/**
 * Repoint the theme's meta description tags at page_description (netgrid's
 * capped SEO value) so the rendered <meta name="description"> stops using the
 * article body. Idempotent. Requires read_themes / write_themes.
 */
export async function fixThemeMetaDescription(
  blogId: string,
): Promise<ThemeSeoResult> {
  await requireAdmin();
  const r = await shopifyCredsForBlog(blogId);
  if (!r.ok) return { success: false, message: r.message };
  return fixThemeMetaDescriptionClient(r.creds);
}
