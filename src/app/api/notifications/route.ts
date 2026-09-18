import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/config";
import { db } from "@/lib/db";
import {
  blogs,
  messages,
  generatedPosts,
  seoIssues,
  indexPingEvents,
} from "@/lib/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";

export interface NotificationItem {
  type: string;
  count: number;
  label: string;
  href: string;
  /** Optional severity for UI colour: critical | warning | info */
  severity: "critical" | "warning" | "info";
}

export interface NotificationsResponse {
  total: number;
  items: NotificationItem[];
}

export async function GET() {
  const session = await getServerSession(authOptions);
  const role = (session?.user as { role?: string } | undefined)?.role;
  if (!session?.user || (role !== "admin" && role !== "super_admin")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 24h ago — used to scope "recent failures"
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    unreadMessages,
    offScheduleResult,
    recentFailedPublishes,
    criticalSeoIssues,
    unscheduledBlogs,
    recentIndexFailures,
  ] = await Promise.all([
    // Messages from clients that admin hasn't read yet
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.readByAdmin, false),
          eq(messages.senderRole, "client"),
        ),
      ),

    // Off-schedule count from the LATEST verification per blog. DISTINCT ON
    // walks the (blog_id, checked_at desc) index so we never sort the full
    // history in memory.
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(
        sql`(
          SELECT DISTINCT ON (blog_id) blog_id, on_schedule
          FROM post_verifications
          ORDER BY blog_id, checked_at DESC
        ) latest`,
      )
      .where(sql`latest.on_schedule = false`),

    db
      .select({ count: sql<number>`count(*)::int` })
      .from(generatedPosts)
      .where(
        and(
          eq(generatedPosts.status, "failed"),
          gte(generatedPosts.createdAt, dayAgo),
        ),
      ),

    db
      .select({ count: sql<number>`count(*)::int` })
      .from(seoIssues)
      .where(
        and(
          eq(seoIssues.severity, "critical"),
          sql`${seoIssues.status} IN ('detected', 'queued')`,
        ),
      ),
    // Active blogs with an empty posting_plan. These can never publish —
    // the auto-publish cron excludes them from its candidate query — so
    // this is a hard configuration fault, not a transient state.
    // Backed by blogs_unscheduled_idx (partial index on the zero plan).
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(blogs)
      .where(
        and(
          eq(blogs.status, "active"),
          sql`${blogs.postingPlan} = '{0,0,0,0,0,0,0}'::integer[]`,
        ),
      ),
    // Indexing failures in the last 24h. "skipped" is excluded on purpose:
    // Shopify blogs skip IndexNow by design and must not raise an alert.
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(indexPingEvents)
      .where(
        and(
          eq(indexPingEvents.outcome, "failed"),
          gte(indexPingEvents.createdAt, dayAgo),
        ),
      ),
  ]);

  const offScheduleCount = Number(offScheduleResult[0]?.count ?? 0);

  const items: NotificationItem[] = [
    {
      type: "messages",
      count: unreadMessages[0]?.count ?? 0,
      label: "Unread client messages",
      href: "/messages",
      severity: "info",
    },
    {
      type: "unscheduled_blogs",
      count: unscheduledBlogs[0]?.count ?? 0,
      label: "Active blogs with no posting plan",
      href: "/blogs",
      severity: "critical",
    },
    {
      type: "off_schedule",
      count: offScheduleCount,
      label: "Blogs off posting schedule",
      href: "/posts",
      severity: "warning",
    },
    {
      type: "failed_publishes",
      count: recentFailedPublishes[0]?.count ?? 0,
      label: "Failed auto-publishes (24h)",
      href: "/blogs",
      severity: "warning",
    },
    {
      type: "critical_seo",
      count: criticalSeoIssues[0]?.count ?? 0,
      label: "Critical SEO issues",
      href: "/seo/fix-queue",
      severity: "critical",
    },
    {
      type: "indexing_failures",
      count: recentIndexFailures[0]?.count ?? 0,
      label: "Indexing failures (24h)",
      href: "/blogs",
      severity: "warning",
    },
  ];

  // Total only counts non-zero items so an idle inbox shows nothing
  const total = items.reduce((sum, item) => sum + item.count, 0);

  return NextResponse.json<NotificationsResponse>({ total, items });
}
