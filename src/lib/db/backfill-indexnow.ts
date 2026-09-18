/**
 * One-shot IndexNow repair (T15).
 *
 *   1. Mint a distinct key for every blog that lacks one, and set its
 *      key_location to the ONLY spec-compliant place: the document root.
 *   2. Delete the junk "IndexNow Verification" Page the old code published on
 *      every Shopify storefront (it was never a valid key file, it is publicly
 *      reachable, and Shopify lists published pages in /sitemap.xml).
 *   3. Report which WordPress sites still lack the MU-plugin, so the rollout
 *      has a worklist.
 *
 * Usage (from project root, DATABASE_URL required):
 *
 *   npm run db:backfill-indexnow
 *     Dry run. Reports what it would do and probes every WordPress site for
 *     the MU-plugin. Writes nothing.
 *
 *   npm run db:backfill-indexnow -- --apply
 *     Mints and persists keys, and deletes the Shopify pages.
 *
 * AFTER this runs and you are satisfied: delete the INDEXNOW_KEY environment
 * variable from the Render web service. Nothing reads it any more. Do it in
 * that order — the old value is the only way to find the junk media uploads
 * described at the bottom of the report.
 */

import { eq, ne } from "drizzle-orm";
import { db } from "./index";
import { blogs as blogsTable } from "./schema";
import {
  canonicalHost,
  generateIndexNowKey,
  isValidIndexNowKey,
  keyLocationForHost,
} from "../services/indexnow-key";
import { deleteIndexNowKeyPage } from "../services/shopify-client";
import { shopifyCredsFromBlog } from "../services/shopify-creds";

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(
    APPLY
      ? "=== IndexNow backfill — APPLYING ==="
      : "=== IndexNow backfill — DRY RUN (pass --apply to write) ===",
  );

  const rows = await db
    .select()
    .from(blogsTable)
    .where(ne(blogsTable.status, "decommissioned"));

  // ── 1. Keys ──────────────────────────────────────────────────────
  let minted = 0;
  let alreadyOk = 0;
  const unusableDomain: string[] = [];

  for (const blog of rows) {
    const host = canonicalHost(blog.domain);
    if (!host) {
      unusableDomain.push(blog.domain);
      continue;
    }
    const existing = blog.indexnowKey?.trim() ?? "";
    const expectedLocation = keyLocationForHost(host, existing);
    if (
      isValidIndexNowKey(existing) &&
      blog.indexnowKeyLocation === expectedLocation
    ) {
      alreadyOk++;
      continue;
    }

    const key = isValidIndexNowKey(existing) ? existing : generateIndexNowKey();
    const keyLocation = keyLocationForHost(host, key);
    minted++;
    if (APPLY) {
      await db
        .update(blogsTable)
        .set({ indexnowKey: key, indexnowKeyLocation: keyLocation, updatedAt: new Date() })
        .where(eq(blogsTable.id, blog.id));
    }
  }

  console.log(`\n[keys] ${alreadyOk} already correct`);
  console.log(`[keys] ${minted} ${APPLY ? "minted/repaired" : "would be minted/repaired"}`);
  if (unusableDomain.length > 0) {
    console.log(
      `[keys] ${unusableDomain.length} blog(s) have an unusable domain and can never host a key file:`,
    );
    for (const d of unusableDomain.slice(0, 20)) console.log(`         ${d}`);
  }

  // ── 2. Shopify junk pages ────────────────────────────────────────
  const shopify = rows.filter((b) => b.platform === "shopify");
  let deleted = 0;
  let noPage = 0;
  const pageErrors: string[] = [];

  for (const blog of shopify) {
    const creds = shopifyCredsFromBlog(blog);
    if (!creds) {
      pageErrors.push(`${blog.domain}: incomplete Shopify credentials`);
      continue;
    }
    if (!APPLY) continue;
    try {
      const removed = await deleteIndexNowKeyPage(creds);
      if (removed) deleted++;
      else noPage++;
    } catch (err) {
      pageErrors.push(
        `${blog.domain}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(`\n[shopify] ${shopify.length} storefront(s) considered`);
  if (APPLY) {
    console.log(`[shopify] ${deleted} "IndexNow Verification" page(s) deleted, ${noPage} had none`);
  } else {
    console.log(`[shopify] would probe each for a leftover "IndexNow Verification" page`);
  }
  for (const e of pageErrors.slice(0, 20)) console.log(`          ! ${e}`);

  // ── 3. MU-plugin worklist ────────────────────────────────────────
  const wordpress = rows.filter(
    (b) => b.platform === "wordpress" && b.wpUrl && b.wpUsername && b.wpAppPassword,
  );
  const missingPlugin: string[] = [];
  const hasPlugin: string[] = [];

  for (const blog of wordpress) {
    const auth = Buffer.from(`${blog.wpUsername}:${blog.wpAppPassword}`).toString("base64");
    const base = blog.wpUrl!.replace(/\/+$/, "");
    try {
      const res = await fetch(`${base}/wp-json/netgrid/v1/indexnow-key`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 200) hasPlugin.push(blog.domain);
      else missingPlugin.push(`${blog.domain} (HTTP ${res.status})`);
    } catch (err) {
      missingPlugin.push(
        `${blog.domain} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  console.log(`\n[mu-plugin] ${hasPlugin.length}/${wordpress.length} WordPress site(s) have it`);
  if (missingPlugin.length > 0) {
    console.log(`[mu-plugin] ${missingPlugin.length} still need docs/indexnow/netgrid-indexnow.php:`);
    for (const d of missingPlugin) console.log(`            ${d}`);
  }

  // ── 4. What is left for a human ──────────────────────────────────
  const legacyKey = process.env.INDEXNOW_KEY?.trim();
  console.log("\n=== Remaining manual steps ===");
  if (legacyKey) {
    console.log(
      `1. The old shared key is still set (INDEXNOW_KEY). Junk media uploads named\n` +
        `   "${legacyKey}.txt" exist in the media library of every WordPress site the\n` +
        `   old deployer touched. Find them with:\n` +
        `     GET {wpUrl}/wp-json/wp/v2/media?search=${legacyKey}\n` +
        `   then DELETE each id with ?force=true. They are harmless but public.\n` +
        `2. DELETE the INDEXNOW_KEY env var from the Render web service. Nothing\n` +
        `   reads it any more.`,
    );
  } else {
    console.log(
      "1. INDEXNOW_KEY is not set in this environment, so the subsystem was\n" +
        "   almost certainly never switched on and there is no junk to clean up.\n" +
        "   Confirm in the Render dashboard before concluding that.",
    );
  }
  console.log(
    "3. Roll docs/indexnow/netgrid-indexnow.php out to the sites listed above.",
  );

  if (!APPLY) {
    console.log("\n(DRY RUN — nothing was written. Re-run with --apply.)");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("backfill-indexnow failed:", err);
    process.exit(1);
  });
