import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { blogs } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatPostingPlan, normalizePostingPlan } from "@/lib/posting-plan";

function seoBadgeColor(score: number | null) {
  if (score === null) return "bg-gray-100 text-gray-800";
  if (score >= 80) return "bg-green-100 text-green-800";
  if (score >= 60) return "bg-yellow-100 text-yellow-800";
  return "bg-red-100 text-red-800";
}

export default async function PortalBlogsPage() {
  const session = await getSession();
  if (!session || !session.user.clientId) redirect("/login");

  const rows = await db
    .select({
      id: blogs.id,
      domain: blogs.domain,
      platform: blogs.platform,
      status: blogs.status,
      currentSeoScore: blogs.currentSeoScore,
      postingPlan: blogs.postingPlan,
      lastPostTitle: blogs.lastPostTitle,
      lastPostVerifiedAt: blogs.lastPostVerifiedAt,
    })
    .from(blogs)
    .where(and(eq(blogs.clientId, session.user.clientId), eq(blogs.status, "active")))
    .orderBy(desc(blogs.createdAt));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Your Blogs</h1>
        <p className="text-muted-foreground">
          The blog network we manage on your behalf
        </p>
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12 text-muted-foreground">
            No active blogs yet. Your blog network is being set up.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {rows.map((blog) => (
            <Link key={blog.id} href={`/portal/blogs/${blog.id}`}>
              <Card className="hover:bg-muted/50 transition-colors cursor-pointer h-full">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base truncate">
                      {blog.domain}
                    </CardTitle>
                    <Badge variant="outline" className="capitalize shrink-0">
                      {blog.platform}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">SEO Score</span>
                    <Badge className={seoBadgeColor(blog.currentSeoScore)}>
                      {blog.currentSeoScore ?? "—"}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Schedule</span>
                    <span className="text-sm">
                      {formatPostingPlan(normalizePostingPlan(blog.postingPlan))}
                    </span>
                  </div>
                  {blog.lastPostTitle && (
                    <div className="border-t pt-2">
                      <p className="text-xs text-muted-foreground">Latest post</p>
                      <p className="text-sm truncate">{blog.lastPostTitle}</p>
                      {blog.lastPostVerifiedAt && (
                        <p className="text-xs text-muted-foreground">
                          {new Date(blog.lastPostVerifiedAt).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
