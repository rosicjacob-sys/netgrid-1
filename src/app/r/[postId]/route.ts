import { NextResponse } from "next/server";
import { resolvePostRedirect, logLinkEvent } from "@/lib/services/link-tracker";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * GET /r/{postId} — tracked CTA redirect. Logs a "cta_click" and 302s to the
 * post's client CTA URL. Falls back to the site root when the post/CTA is
 * missing or the destination isn't a safe http(s) URL.
 *
 * Every response carries X-Robots-Tag: noindex, nofollow (T02). This endpoint
 * is linked from the published HTML of every client site, so it is reachable
 * by crawlers from ~1,500 external domains; the header is the belt to
 * robots.txt's braces and also covers crawlers that fetched the URL before
 * reading robots.txt.
 */
/** Never let a crawler index or follow a legacy tracked redirect (T02). */
function noIndex(res: NextResponse): NextResponse {
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}
export async function GET(
  request: Request,
  { params }: { params: { postId: string } },
) {
  const { postId } = params;
  const home = new URL("/", request.url);
  if (!UUID_RE.test(postId)) {
    return noIndex(NextResponse.redirect(home, 302));
  }
  const ctx = await resolvePostRedirect(postId);
  await logLinkEvent({
    postId,
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
