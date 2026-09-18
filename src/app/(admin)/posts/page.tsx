import { db } from "@/lib/db";
import { blogs, clients, postVerifications } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/helpers";
import { desc, eq, sql } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import Link from "next/link";
import { formatPostingPlan, normalizePostingPlan } from "@/lib/posting-plan";

function formatDateTime(value: Date | string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDate(value: Date | string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function PostsPage() {
  await requireAdmin();

  // Pull every verification newest-first joined with blog/client info, then
  // dedupe per blog in JS so each blog contributes only its LATEST status.
  // Avoids the previous bug where stats counted historical rows multiple times
  // and only reflected the paginated first 25.
  const allVerifications = await db
    .select({
      verification: postVerifications,
      blogDomain: blogs.domain,
      clientName: clients.name,
      postingPlan: blogs.postingPlan,
    })
    .from(postVerifications)
    .innerJoin(blogs, eq(postVerifications.blogId, blogs.id))
    .innerJoin(clients, eq(postVerifications.clientId, clients.id))
    .orderBy(desc(postVerifications.checkedAt))
    .limit(2000);

  const seenBlogs = new Set<string>();
  const latestPerBlog: typeof allVerifications = [];
  for (const row of allVerifications) {
    if (seenBlogs.has(row.verification.blogId)) continue;
    seenBlogs.add(row.verification.blogId);
    latestPerBlog.push(row);
  }

  const onScheduleCount = latestPerBlog.filter((r) => r.verification.onSchedule).length;
  const offScheduleCount = latestPerBlog.length - onScheduleCount;

  // Total checks across history (independent of dedup) — for context.
  const [{ total: totalChecks }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(postVerifications);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Post Schedule Verification</h1>
        <p className="text-muted-foreground">
          Monitor posting compliance across all blogs. Each blog shows its latest verification.
        </p>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Blogs Tracked</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{latestPerBlog.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">On Schedule</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-green-600">{onScheduleCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Off Schedule</CardTitle>
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${offScheduleCount > 0 ? "text-red-600" : ""}`}>
              {offScheduleCount}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Total Checks</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{totalChecks}</p>
            <p className="text-xs text-muted-foreground mt-1">across all history</p>
          </CardContent>
        </Card>
      </div>

      {/* Current state per blog */}
      <Card>
        <CardHeader>
          <CardTitle>Current Status per Blog</CardTitle>
          <CardDescription>
            The most recent verification for each blog. Blogs that have never been checked
            don&apos;t appear here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {latestPerBlog.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No post verifications yet. The cron at <code>/api/cron/post-verification</code>{" "}
              runs every 6 hours, or you can trigger one manually from a blog&apos;s detail page.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Blog</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Frequency</TableHead>
                  <TableHead>Last Post</TableHead>
                  <TableHead>Days Since</TableHead>
                  <TableHead>Posts in Period</TableHead>
                  <TableHead>Last Checked</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {latestPerBlog.map(
                  ({ verification, blogDomain, clientName, postingPlan }) => (
                    <TableRow key={verification.id}>
                      <TableCell>
                        <Link
                          href={`/blogs/${verification.blogId}`}
                          className="font-medium hover:underline"
                        >
                          {blogDomain}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{clientName}</TableCell>
                      <TableCell>
                        <Badge variant={verification.onSchedule ? "default" : "destructive"}>
                          {verification.onSchedule ? "On Schedule" : "Behind"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatPostingPlan(normalizePostingPlan(postingPlan))}
                      </TableCell>
                      <TableCell className="max-w-[240px] truncate">
                        {verification.latestPostTitle || "—"}
                      </TableCell>
                      <TableCell
                        className={
                          verification.daysSinceLastPost !== null &&
                          verification.daysSinceLastPost > 7
                            ? "font-medium text-red-600"
                            : "text-muted-foreground"
                        }
                      >
                        {verification.daysSinceLastPost ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {verification.postsInPeriod ?? 0}
                        {verification.expectedPosts != null && (
                          <span className="text-xs"> / {verification.expectedPosts}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDateTime(verification.checkedAt)}
                      </TableCell>
                    </TableRow>
                  ),
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Recent check history (chronological feed, all blogs) */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Check History</CardTitle>
          <CardDescription>
            Last {Math.min(allVerifications.length, 50)} verification runs across all blogs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {allVerifications.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No history yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Blog</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Days Since Post</TableHead>
                  <TableHead>Check Type</TableHead>
                  <TableHead>Checked</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allVerifications.slice(0, 50).map(({ verification, blogDomain }) => (
                  <TableRow key={verification.id}>
                    <TableCell className="font-medium">{blogDomain}</TableCell>
                    <TableCell>
                      <Badge
                        variant={verification.onSchedule ? "default" : "destructive"}
                      >
                        {verification.onSchedule ? "On Schedule" : "Behind"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {verification.daysSinceLastPost ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground capitalize">
                      {verification.checkType ?? "scheduled"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDate(verification.checkedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}