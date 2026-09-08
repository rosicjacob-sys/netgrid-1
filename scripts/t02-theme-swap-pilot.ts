/**
 * T02 §6.2 step 6 (PILOT, one store): swap the v2 managed theme block (with
 * its shared-host beacon + CTA-rewriting script) for the clean v3 block, on
 * claringtonpeptides.ca only. Uses the local v3 shopify-theme-client — the
 * deployed app still ships v2 until the T02 code is pushed.
 *
 * This is the same write applyThemeSeoFix makes from the admin UI:
 * idempotent upsert of the marker-delimited block in snippets/meta-tags.liquid.
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { blogs } from "../src/lib/db/schema";
import { eq } from "drizzle-orm";
import { buildShopifyCreds } from "../src/lib/services/platform-client";
import { injectSeoMetaTags } from "../src/lib/services/shopify-theme-client";

async function main() {
  const [blog] = await db
    .select()
    .from(blogs)
    .where(eq(blogs.domain, "claringtonpeptides.ca"))
    .limit(1);
  if (!blog) throw new Error("blog not found");
  const built = buildShopifyCreds(blog);
  if (!built.ok) throw new Error(built.message);
  const result = await injectSeoMetaTags(built.creds);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error("[FATAL]", e.message);
  process.exit(1);
});
