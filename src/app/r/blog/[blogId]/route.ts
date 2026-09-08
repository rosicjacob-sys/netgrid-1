import { NextResponse } from "next/server";
import { resolveBlogRedirect, logLinkEvent } from "@/lib/services/link-tracker";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Never let a crawler index or follow a legacy tracked redirect (T02). */
function noIndex(res: NextResponse): NextResponse {
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}

/**
 * GET /r/blog/{blogId} — site-wide tracked CTA redirect. Logs a "cta_click"
 * (no postId) and 302s to the blog's client CTA URL. Used for CTA links on
 * non-post pages such as the homepage. Falls back to the site root when the
 * blog/CTA is missing or the destination isn't a safe http(s) URL.
 *
 * Every response carries X-Robots-Tag: noindex, nofollow (T02): this endpoint
 * is linked from client sites, so it is crawler-discoverable from external
 * domains; the header is the belt to robots.txt's braces.
 */
export async function GET(
  request: Request,
  { params }: { params: { blogId: string } },
) {
  const { blogId } = params;
  const home = new URL("/", request.url);

  if (!UUID_RE.test(blogId)) {
    return noIndex(NextResponse.redirect(home, 302));
  }

  const ctx = await resolveBlogRedirect(blogId);
  await logLinkEvent({
    postId: null,
    blogId: ctx?.blogId,
    clientId: ctx?.clientId,
    type: "cta_click",
    referrer: request.headers.get("referer"),
    userAgent: request.headers.get("user-agent"),
  });

  const dest = ctx?.ctaUrl?.trim();
  if (dest && /^https?:\/\//i.test(dest)) {
    return noIndex(NextResponse.redirect(dest, 302));
  }
  return noIndex(NextResponse.redirect(home, 302));
}
