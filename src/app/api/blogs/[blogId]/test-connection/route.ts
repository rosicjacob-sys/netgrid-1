import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/config";
import { db } from "@/lib/db";
import { blogs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { testConnection } from "@/lib/services/platform-client";

export async function POST(
  request: NextRequest,
  { params }: { params: { blogId: string } },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const role = (session.user as { role?: string }).role;
  if (role !== "super_admin" && role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { blogId } = params;

  const [blog] = await db
    .select({
      id: blogs.id,
      platform: blogs.platform,
      wpUrl: blogs.wpUrl,
      wpUsername: blogs.wpUsername,
      wpAppPassword: blogs.wpAppPassword,
      shopifyStoreUrl: blogs.shopifyStoreUrl,
      shopifyAdminApiToken: blogs.shopifyAdminApiToken,
    })
    .from(blogs)
    .where(eq(blogs.id, blogId));

  if (!blog) {
    return NextResponse.json({ error: "Blog not found" }, { status: 404 });
  }

  const result = await testConnection(blog);

  if (result.success) {
    await db
      .update(blogs)
      .set({
        ...(result.seoPlugin ? { seoPlugin: result.seoPlugin } : {}),
        // undefined => Shopify (leave alone); null => WP without the bridge.
        ...(result.seoBridgeVersion !== undefined
          ? { seoBridgeVersion: result.seoBridgeVersion }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(blogs.id, blogId));
  }

  return NextResponse.json(result);
}
