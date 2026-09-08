// T02 §7.4/§7.6 — verify the first posts published AFTER the code deploy.
// Finds posts published after the deploy timestamp, fetches the LIVE page,
// and checks: no /r/ href, no pixel, direct client link with 4 UTMs,
// &amp; escaping, rel=sponsored noopener. READ ONLY.
import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

// The T02 deploy (commit 3efc9b8) went live around this time on Render.
const DEPLOY_AT = "2026-09-08T12:30:00Z";

async function main() {
  const rows = await sql`
    SELECT gp.id, gp.external_post_url, gp.published_at, gp.body, b.domain, b.platform
    FROM generated_posts gp
    JOIN blogs b ON b.id = gp.blog_id
    WHERE gp.status = 'published'
      AND gp.external_post_url IS NOT NULL
      AND gp.published_at > ${DEPLOY_AT}
    ORDER BY gp.published_at ASC
    LIMIT 6`;
  if (rows.length === 0) {
    console.log("No posts published after the deploy yet — nothing to verify. Re-run later.");
    return;
  }
  console.log(`posts published since ${DEPLOY_AT}: ${rows.length} (checking first 6)\n`);

  for (const r of rows as Array<Record<string, string>>) {
    console.log(`===== ${r.domain} (${r.platform}) =====`);
    console.log(`  url: ${r.external_post_url}`);
    console.log(`  published: ${r.published_at}`);

    // DB-side check (what the generator wrote):
    const dbBody = r.body ?? "";
    console.log(`  DB body: netgrid refs=${(dbBody.match(/netgrid-16f6/g) ?? []).length}, utm_campaign=${(dbBody.match(/utm_campaign=netgrid_content/g) ?? []).length}`);

    // Live-page check (what Google sees):
    try {
      const res = await fetch(r.external_post_url, {
        redirect: "follow",
        headers: { "user-agent": "Mozilla/5.0 (compatible; NetGridAudit/1.0)" },
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) { console.log(`  LIVE: HTTP ${res.status} — skip\n`); continue; }
      const html = (await res.text()).replace(/\s+/g, " ");
      const netgridHits = (html.match(/netgrid-16f6/g) ?? []).length;
      const pixelHits = (html.match(/\/api\/track\/px\//g) ?? []).length;
      const redirectHits = (html.match(/\/r\/[0-9a-f]{8}-[0-9a-f]{4}/g) ?? []).length;
      const utmHits = (html.match(/utm_campaign=netgrid_content/g) ?? []).length;
      const sponsoredHits = (html.match(/sponsored noopener/g) ?? []).length;
      const ampOk = html.includes("utm_campaign=netgrid_content&amp;") || utmHits === 0;
      console.log(`  LIVE page (${html.length} chars):`);
      console.log(`    netgrid host refs : ${netgridHits}   (body must be 0; theme <script> may be 1 until swept)`);
      console.log(`    tracking pixels   : ${pixelHits}   (must be 0)`);
      console.log(`    /r/ redirect hrefs: ${redirectHits}   (must be 0)`);
      console.log(`    UTM-tagged links  : ${utmHits}   (>=1 expected)`);
      console.log(`    sponsored rel     : ${sponsoredHits}   (>=1 expected)`);
      console.log(`    &amp; escaping    : ${ampOk ? "OK" : "BARE & FOUND — sanitizer mangled it"}`);
      if (netgridHits > 0) {
        const ctx = [...html.matchAll(/.{60}netgrid-16f6.{70}/g)].slice(0, 2);
        ctx.forEach((m) => console.log(`    context: ...${m[0]}...`));
      }
      const anchor = html.match(/<a[^>]*utm_campaign=netgrid_content[^>]*>/)?.[0];
      if (anchor) console.log(`    sample CTA: ${anchor.slice(0, 260)}`);
    } catch (e) {
      console.log(`  LIVE fetch failed: ${(e as Error).message.slice(0, 70)}`);
    }
    console.log("");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
