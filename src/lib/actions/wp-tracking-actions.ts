"use server";

import { db } from "@/lib/db";
import { blogs, clients } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/helpers";
import {
  getReadingSettings,
  getPageRawContent,
  updatePageContent,
} from "@/lib/services/wp-client";
import { blogCtaRedirectUrl } from "@/lib/services/link-tracker";
import { effectiveCtaDestination } from "@/lib/content/cta-target";
import { COMMERCIAL_LINK_REL, withUtm } from "@/lib/content/outbound-links";

export interface WpHomepageTrackerResult {
  success: boolean;
  message: string;
  action?: "removed" | "unchanged";
}

const BLOCK_RE =
  /<!-- netgrid:homepage-tracker -->[\s\S]*?<!-- \/netgrid:homepage-tracker -->/g;

/** Escape a URL for a double-quoted HTML attribute (UTMs introduce "&"). */
function safeAttrUrl(url: string): string {
  return url
    .replace(/&/g, "&amp;")
    .replace(/"/g, "%22")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Repoint homepage links that were rewritten to the netgrid blog-level redirect
 * back at the client's own destination, tagged for attribution and marked
 * rel="sponsored noopener". Inverse of the rewriteCtaHrefs this file used to
 * ship; idempotent, because once repointed the redirect URL no longer matches.
 */
function restoreCtaHrefs(
  html: string,
  redirectUrl: string,
  destination: string,
): { html: string; count: number } {
  const hrefRe = new RegExp(
    `href\\s*=\\s*(["'])${escapeRegExp(redirectUrl)}\\1`,
    "i",
  );
  const relRe = /\srel\s*=\s*(["'])[^"']*\1/i;
  const href = safeAttrUrl(destination);
  let count = 0;
  const out = html.replace(/<a\b[^>]*>/gi, (tag) => {
    if (!hrefRe.test(tag)) return tag;
    count++;
    let next = tag.replace(hrefRe, (_m, q) => `href=${q}${href}${q}`);
    next = relRe.test(next)
      ? next.replace(relRe, (_m, q) => ` rel=${q}${COMMERCIAL_LINK_REL}${q}`)
      : next.replace(/^<a\b/i, `<a rel="${COMMERCIAL_LINK_REL}"`);
    return next;
  });
  return { html: out, count };
}

/**
 * Remove netgrid's site-wide tracking from a WordPress blog's static homepage
 * (T02): strip the managed pixel block and repoint any homepage anchor that was
 * rewritten to /r/blog/{blogId} back at the client's own destination.
 *
 * Only works when the site uses a static Page as its homepage (Settings →
 * Reading), which is the same constraint the installer had. Idempotent — a
 * second run reports "unchanged".
 */
export async function removeWpHomepageTracker(
  blogId: string,
): Promise<WpHomepageTrackerResult> {
  await requireAdmin();

  const [blog] = await db
    .select()
    .from(blogs)
    .where(eq(blogs.id, blogId))
    .limit(1);

  if (!blog) return { success: false, message: "Blog not found." };
  if (blog.platform !== "wordpress") {
    return {
      success: false,
      message: "Homepage tracking here is for WordPress blogs.",
    };
  }
  if (!blog.wpUrl || !blog.wpUsername || !blog.wpAppPassword) {
    return {
      success: false,
      message: "This blog is missing WordPress URL / credentials.",
    };
  }

  const creds = [blog.wpUrl, blog.wpUsername, blog.wpAppPassword] as const;

  const settings = await getReadingSettings(...creds);
  if (!settings) {
    return {
      success: false,
      message:
        "Could not read the site's reading settings (needs an admin application password).",
    };
  }
  if (settings.showOnFront !== "page" || !settings.pageOnFront) {
    return {
      success: true,
      message:
        "The homepage is the blog post index, not a static page — no netgrid block was ever installed there.",
      action: "unchanged",
    };
  }

  const pageId = settings.pageOnFront;
  const raw = await getPageRawContent(...creds, pageId);
  if (raw === null) {
    return {
      success: false,
      message: `Could not read the homepage (page #${pageId}).`,
    };
  }

  // The destination the redirect resolved to at click time. Mirrors
  // link-tracker.resolveBlogRedirect exactly: peptides use the blog's own
  // domain, every other niche the client's ctaUrl — and, as there, WITHOUT
  // gating on ctaEnabled, so a client who later toggled the CTA off still gets
  // their links restored instead of stranded on /r/blog/{blogId}.
  const [client] = await db
    .select({ niche: clients.niche, ctaUrl: clients.ctaUrl })
    .from(clients)
    .where(eq(clients.id, blog.clientId))
    .limit(1);
  const destination = effectiveCtaDestination({
    niche: client?.niche,
    blogDomain: blog.domain,
    ctaUrl: client?.ctaUrl,
  });

  let next = raw.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n");
  let restored = 0;
  if (destination) {
    const r = restoreCtaHrefs(
      next,
      blogCtaRedirectUrl(blogId),
      withUtm(destination, {
        blogDomain: blog.domain,
        medium: "homepage_cta",
      }),
    );
    next = r.html;
    restored = r.count;
  }

  if (next.trim() === raw.trim()) {
    return {
      success: true,
      message: "Homepage carries no netgrid tracking — nothing to remove.",
      action: "unchanged",
    };
  }

  const ok = await updatePageContent(...creds, pageId, next);
  if (!ok) {
    return {
      success: false,
      message: `Failed to update the homepage (page #${pageId}). Check that the user can edit pages.`,
    };
  }

  const note =
    restored > 0
      ? ` ${restored} CTA link${restored === 1 ? "" : "s"} now point directly at the client.`
      : destination
        ? " No redirect-wrapped CTA links were present."
        : " No CTA destination is configured for this client, so no links were repointed.";

  return {
    success: true,
    message: `Netgrid homepage tracking removed (page #${pageId}).${note}`,
    action: "removed",
  };
}