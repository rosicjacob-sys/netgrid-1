/**
 * T02 §6.2 step 7 — remove the homepage tracker from every ACTIVE WordPress
 * blog (the script equivalent of removeWpHomepageTracker, which is the same
 * logic the admin button runs). Verify-after-every-write; hard-stop on any
 * anomaly; idempotent — a second run reports "unchanged".
 *
 *   1. read the site's reading settings (static homepage only)
 *   2. fetch the homepage content
 *   3. strip the <!-- netgrid:homepage-tracker --> block
 *   4. repoint /r/blog/{blogId} hrefs at the client's destination
 *      (UTM-tagged, rel="sponsored noopener")
 *   5. write back, then RE-FETCH and verify: no block, no /r/blog/ href
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { blogs, clients } from "../src/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  getReadingSettings,
  getPageRawContent,
  updatePageContent,
} from "../src/lib/services/wp-client";
import { blogCtaRedirectUrl } from "../src/lib/services/link-tracker";
import { effectiveCtaDestination } from "../src/lib/content/cta-target";
import { COMMERCIAL_LINK_REL, withUtm } from "../src/lib/content/outbound-links";

const BLOCK_RE =
  /<!-- netgrid:homepage-tracker -->[\s\S]*?<!-- \/netgrid:homepage-tracker -->/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function safeAttrUrl(url: string): string {
  return url
    .replace(/&/g, "&amp;")
    .replace(/"/g, "%22")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
}

function restoreCtaHrefs(
  html: string,
  redirectUrl: string,
  destination: string,
): { html: string; count: number } {
  const hrefRe = new RegExp(`href\\s*=\\s*(["'])${escapeRegExp(redirectUrl)}\\1`, "i");
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

async function main() {
  const rows = await db
    .select({
      id: blogs.id, domain: blogs.domain,
      wpUrl: blogs.wpUrl, wpUsername: blogs.wpUsername, wpAppPassword: blogs.wpAppPassword,
      niche: clients.niche, ctaUrl: clients.ctaUrl,
    })
    .from(blogs)
    .innerJoin(clients, eq(clients.id, blogs.clientId))
    .where(eq(blogs.platform, "wordpress"));
  console.log(`WordPress blogs: ${rows.length}\n`);

  let removed = 0, unchanged = 0, noStatic = 0, failed = 0;

  for (const b of rows) {
    console.log(`-- ${b.domain}`);
    if (!b.wpUrl || !b.wpUsername || !b.wpAppPassword) {
      console.log("   missing credentials — skip");
      failed++;
      continue;
    }
    const creds = [b.wpUrl, b.wpUsername, b.wpAppPassword] as const;
    try {
      const settings = await getReadingSettings(...creds);
      if (!settings) { console.log("   could not read reading settings — skip"); failed++; continue; }
      if (settings.showOnFront !== "page" || !settings.pageOnFront) {
        console.log("   homepage is the post index — nothing was ever installed");
        noStatic++;
        continue;
      }
      const pageId = settings.pageOnFront;
      const raw = await getPageRawContent(...creds, pageId);
      if (raw === null) { console.log(`   could not read page #${pageId} — skip`); failed++; continue; }
      if (!BLOCK_RE.test(raw)) {
        console.log("   no tracker block present — already clean");
        unchanged++;
        continue;
      }

      const destination = effectiveCtaDestination({
        niche: b.niche, blogDomain: b.domain, ctaUrl: b.ctaUrl,
      });
      let next = raw.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n");
      let restored = 0;
      if (destination) {
        const r = restoreCtaHrefs(
          next, blogCtaRedirectUrl(b.id),
          withUtm(destination, { blogDomain: b.domain, medium: "homepage_cta" }),
        );
        next = r.html;
        restored = r.count;
      }

      const ok = await updatePageContent(...creds, pageId, next);
      if (!ok) { console.log(`   write failed (page #${pageId}) — untouched`); failed++; continue; }

      // VERIFY: re-fetch and confirm clean.
      const after = await getPageRawContent(...creds, pageId);
      if (after === null) { console.log("   !! could not re-fetch after write — STOP"); process.exit(2); }
      const blockGone = !BLOCK_RE.test(after);
      const hrefsGone = !after.includes(blogCtaRedirectUrl(b.id));
      if (!blockGone || !hrefsGone) {
        console.log(`   !! VERIFICATION FAILED (blockGone=${blockGone} hrefsGone=${hrefsGone}) — STOP`);
        process.exit(2);
      }
      console.log(`   REMOVED + VERIFIED (page #${pageId}): block stripped, ${restored} CTA link(s) repointed`);
      removed++;
    } catch (e) {
      console.log(`   error: ${(e as Error).message.slice(0, 70)} — skip`);
      failed++;
    }
  }

  console.log(`\n=== WP HOMEPAGE RESULT ===`);
  console.log(`removed+verified : ${removed}`);
  console.log(`already clean    : ${unchanged}`);
  console.log(`no static page   : ${noStatic}`);
  console.log(`failed           : ${failed}`);
}

main().catch((e) => { console.error("[FATAL]", e.message); process.exit(1); });
