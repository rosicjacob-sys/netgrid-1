/**
 * Build ShopifyCreds from a blogs row.
 *
 * One implementation. This logic was duplicated in gsc-verifier.ts and
 * open-coded at three more call sites (platform-client.ts, blog-actions.ts
 * twice), each re-deriving the same default: blogs.shopify_auth_mode is
 * NULLABLE, and a null means client_credentials — matching the DB default.
 * Get that wrong in one copy and that subsystem silently stops authenticating
 * for every legacy-token store, or vice versa.
 *
 * Returns null when the row cannot produce usable credentials, which every
 * caller treats as "skip this blog", never as an error.
 *
 * Plain module, no "use server" — imported by server actions, services and
 * standalone tsx scripts alike.
 */

import type { blogs as blogsTable } from "@/lib/db/schema";
import type { ShopifyCreds } from "@/lib/services/shopify-client";

type Blog = typeof blogsTable.$inferSelect;

export function shopifyCredsFromBlog(blog: Blog): ShopifyCreds | null {
  if (!blog.shopifyStoreUrl) return null;

  // Null means client_credentials: that is the column's DB default, and the
  // mode every blog created since the Dev Dashboard migration uses.
  const mode = blog.shopifyAuthMode ?? "client_credentials";

  if (mode === "legacy_token") {
    if (!blog.shopifyAdminApiToken) return null;
    return {
      mode: "legacy_token",
      storeUrl: blog.shopifyStoreUrl,
      adminToken: blog.shopifyAdminApiToken,
    };
  }

  if (!blog.shopifyClientId || !blog.shopifyClientSecret) return null;
  return {
    mode: "client_credentials",
    storeUrl: blog.shopifyStoreUrl,
    clientId: blog.shopifyClientId,
    clientSecret: blog.shopifyClientSecret,
  };
}
