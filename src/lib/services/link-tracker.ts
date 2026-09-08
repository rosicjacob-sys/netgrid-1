// No `import "server-only"` here on purpose — see
// src/lib/content/client-keywords.ts for the reasoning: every consumer is an
// API route handler, a "use server" action, or a standalone tsx script,
// never a client component, and the real `server-only` package throws under
// plain Node execution.
import { db } from "@/lib/db";
import { linkEvents, generatedPosts, clients, blogs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { effectiveCtaDestination } from "@/lib/content/cta-target";
import { recordPipelineError } from "@/lib/services/run-telemetry";

/**
 * LEGACY netgrid-hosted link tracking. RETIRED by T02 — do not add callers.
 *
 * Published posts used to embed a 1x1 pixel at /api/track/px/{postId} and route
 * their CTA through /r/{postId}. Both put ONE shared host into the HTML of
 * every site in the network, which is the strongest footprint a private blog
 * network can emit. New posts link directly to the client with UTM parameters
 * (see src/lib/content/outbound-links.ts).
 *
 * What survives here and why:
 *   - getAppBaseUrl        — still used for the in-post registration form's
 *                            action URL (/api/register/{blogId}).
 *   - ctaRedirectUrl,
 *     blogCtaRedirectUrl   — the reverse backfill rebuilds the OLD href so it
 *                            can find and repoint it. Not emitted into any new
 *                            markup.
 *   - logLinkEvent + the resolvers — the /r and /api/track routes stay live so
 *                            links on posts not yet repaired still land on the
 *                            client instead of 404ing. Delete once the counting
 *                            SQL in T02 §6 reports zero affected posts.
 */

export function getAppBaseUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL || "https://netgrid-16f6.onrender.com";
  return raw.replace(/\/+$/, "");
}

export function ctaRedirectUrl(postId: string): string {
  return `${getAppBaseUrl()}/r/${postId}`;
}

/**
 * Blog-level tracked CTA redirect. Logs a cta_click (no postId) and 302s to the
 * client's CTA URL — the site-wide analogue of /r/{postId}. Used for CTA links
 * on non-post pages (e.g. the homepage) that point at the client's CTA.
 */
export function blogCtaRedirectUrl(blogId: string): string {
  return `${getAppBaseUrl()}/r/blog/${blogId}`;
}

export type LinkEventType = "view" | "cta_click";

/** Best-effort append to the traffic log — never throws to the caller. */
export async function logLinkEvent(input: {
  postId?: string | null;
  blogId?: string | null;
  clientId?: string | null;
  type: LinkEventType;
  referrer?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  try {
    await db.insert(linkEvents).values({
      postId: input.postId ?? null,
      blogId: input.blogId ?? null,
      clientId: input.clientId ?? null,
      type: input.type,
      referrer: input.referrer?.slice(0, 2000) ?? null,
      userAgent: input.userAgent?.slice(0, 1000) ?? null,
    });
  } catch (err) {
    // Silent loss here means the view / CTA-click analytics the client is
    // billed on simply never arrive.
    recordPipelineError({
      site: "link-tracker.logEvent",
      code: "LINK_EVENT_LOG_FAILED",
      severity: "error",
      message: `log failed: ${err instanceof Error ? err.message : String(err)}`,
      context: { type: input.type },
    });
  }
}

export interface PostRedirectContext {
  postId: string;
  blogId: string | null;
  clientId: string | null;
  ctaUrl: string | null;
}

/** Resolve a blog → its client, for attributing a site-wide (postId-less) view. */
export async function resolveBlogClient(
  blogId: string,
): Promise<{ blogId: string; clientId: string } | null> {
  try {
    const [row] = await db
      .select({ blogId: blogs.id, clientId: blogs.clientId })
      .from(blogs)
      .where(eq(blogs.id, blogId))
      .limit(1);
    return row ?? null;
  } catch (err) {
    recordPipelineError({
      site: "link-tracker.resolveBlogClient",
      code: "LINK_RESOLVE_FAILED",
      severity: "error",
      message: `resolve blog failed: ${err instanceof Error ? err.message : String(err)}`,
      blogId,
    });
    return null;
  }
}

/**
 * Resolve a blog → its client + the CTA destination, for a site-wide redirect.
 * Peptides blogs resolve to their own domain (per blog); all other niches use
 * the client's manually-entered CTA URL. See effectiveCtaDestination.
 */
export async function resolveBlogRedirect(
  blogId: string,
): Promise<{ blogId: string; clientId: string; ctaUrl: string | null } | null> {
  try {
    const [row] = await db
      .select({
        blogId: blogs.id,
        clientId: blogs.clientId,
        domain: blogs.domain,
        niche: clients.niche,
        ctaUrl: clients.ctaUrl,
      })
      .from(blogs)
      .leftJoin(clients, eq(blogs.clientId, clients.id))
      .where(eq(blogs.id, blogId))
      .limit(1);
    if (!row) return null;
    return {
      blogId: row.blogId,
      clientId: row.clientId,
      ctaUrl: effectiveCtaDestination({
        niche: row.niche,
        blogDomain: row.domain,
        ctaUrl: row.ctaUrl,
      }),
    };
  } catch (err) {
    // A failure here sends the visitor nowhere.
    recordPipelineError({
      site: "link-tracker.resolveBlogRedirect",
      code: "LINK_RESOLVE_FAILED",
      severity: "error",
      message: `resolve blog redirect failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      blogId,
    });
    return null;
  }
}

/**
 * Resolve a generated post → its blog/client + the CTA destination. Peptides
 * posts resolve to their blog's own domain (per blog); all other niches use the
 * client's manually-entered CTA URL. See effectiveCtaDestination.
 */
export async function resolvePostRedirect(
  postId: string,
): Promise<PostRedirectContext | null> {
  try {
    const [row] = await db
      .select({
        postId: generatedPosts.id,
        blogId: generatedPosts.blogId,
        clientId: generatedPosts.clientId,
        domain: blogs.domain,
        niche: clients.niche,
        ctaUrl: clients.ctaUrl,
      })
      .from(generatedPosts)
      .leftJoin(clients, eq(generatedPosts.clientId, clients.id))
      .leftJoin(blogs, eq(generatedPosts.blogId, blogs.id))
      .where(eq(generatedPosts.id, postId))
      .limit(1);
    if (!row) return null;
    return {
      postId: row.postId,
      blogId: row.blogId,
      clientId: row.clientId,
      ctaUrl: effectiveCtaDestination({
        niche: row.niche,
        blogDomain: row.domain,
        ctaUrl: row.ctaUrl,
      }),
    };
  } catch (err) {
    // A failure here sends the visitor nowhere.
    recordPipelineError({
      site: "link-tracker.resolvePostRedirect",
      code: "LINK_RESOLVE_FAILED",
      severity: "error",
      message: `resolve failed: ${err instanceof Error ? err.message : String(err)}`,
      postId,
    });
    return null;
  }
}
