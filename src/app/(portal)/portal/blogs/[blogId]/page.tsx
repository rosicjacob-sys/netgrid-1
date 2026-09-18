import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { blogs, seoScans, postVerifications } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { formatPostingPlan, normalizePostingPlan } from "@/lib/posting-plan";

interface Props {
  params: { blogId: string };
}

function scoreColor(score: number | null | undefined) {
  if (score == null) return "text-muted-foreground";
  if (score >= 80) return "text-green-600";
  if (score >= 60) return "text-yellow-600";
  return "text-red-600";
}

export default async function PortalBlogDetailPage({ params }: Props) {
  const session = await getSession();
  if (!session || !session.user.clientId) redirect("/login");

  const [blog] = await db
    .select()
    .from(blogs)
    .where(
      and(
        eq(blogs.id, params.blogId),
        eq(blogs.clientId, session.user.clientId),
      ),
    )
    .limit(1);

  if (!blog) notFound();

  const [latestScan, recentVerifications] = await Promise.all([
    db
      .select()
      .from(seoScans)
      .where(eq(seoScans.blogId, blog.id))
      .orderBy(desc(seoScans.scannedAt))
      .limit(1),
    db
      .select()
      .from(postVerifications)
      .where(eq(postVerifications.blogId, blog.id))
      .orderBy(desc(postVerifications.checkedAt))
      .limit(5),
  ]);

  const scan = latestScan[0];
  const siteUrl =
    blog.platform === "shopify"
      ? `https://${blog.shopifyStoreUrl?.replace(/^https?:\/\//i, "")}`
      : blog.wpUrl ?? `https://${blog.domain}`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/portal/blogs">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="size-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">{blog.domain}</h1>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Badge variant="outline" className="capitalize">
                {blog.platform}
              </Badge>
              <span>&middot;</span>
              <span className="capitalize">{blog.status}</span>
            </div>
          </div>
        </div>
        {siteUrl && (
          <a href={siteUrl} target="_blank" rel="noopener noreferrer">
            <Button variant="outline" size="sm">
              <ExternalLink className="size-4" data-icon="inline-start" />
              Visit site
            </Button>
          </a>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Overall SEO</CardDescription>
            <CardTitle className={`text-3xl ${scoreColor(blog.currentSeoScore)}`}>
              {blog.currentSeoScore ?? "—"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Posting Schedule</CardDescription>
            <CardTitle className="text-xl">
              {formatPostingPlan(normalizePostingPlan(blog.postingPlan))}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Last Post</CardDescription>
            <CardTitle className="text-sm truncate">
              {blog.lastPostTitle ?? "No posts yet"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Last Scan</CardDescription>
            <CardTitle className="text-sm">
              {blog.lastSeoScanAt
                ? new Date(blog.lastSeoScanAt).toLocaleDateString()
                : "Not yet scanned"}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {scan && (
        <Card>
          <CardHeader>
            <CardTitle>SEO Breakdown</CardTitle>
            <CardDescription>
              From the most recent scan on{" "}
              {new Date(scan.scannedAt).toLocaleDateString()}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <ScoreTile label="Meta" value={scan.metaScore} />
              <ScoreTile label="Content" value={scan.contentScore} />
              <ScoreTile label="Technical" value={scan.technicalScore} />
              <ScoreTile label="Links" value={scan.linkScore} />
              <ScoreTile label="Images" value={scan.imageScore} />
            </div>
            <div className="mt-6 grid gap-3 text-sm sm:grid-cols-3">
              <Stat label="Pages crawled" value={scan.pagesCrawled ?? 0} />
              <Stat label="Critical issues" value={scan.criticalIssues ?? 0} />
              <Stat label="Warnings" value={scan.warnings ?? 0} />
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent Posting Activity</CardTitle>
          <CardDescription>
            Automated checks we run to confirm posts are going out on schedule
          </CardDescription>
        </CardHeader>
        <CardContent>
          {recentVerifications.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No checks yet. First check runs within 24 hours of setup.
            </p>
          ) : (
            <div className="space-y-2">
              {recentVerifications.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center justify-between border-b last:border-0 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {v.latestPostTitle ?? "—"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Checked {new Date(v.checkedAt).toLocaleDateString()}
                      {v.daysSinceLastPost != null &&
                        ` · ${v.daysSinceLastPost}d since last post`}
                    </p>
                  </div>
                  <Badge variant={v.onSchedule ? "default" : "destructive"}>
                    {v.onSchedule ? "On schedule" : "Behind"}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ScoreTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-4 text-center">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={`text-2xl font-bold ${scoreColor(value)}`}>{value}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}
