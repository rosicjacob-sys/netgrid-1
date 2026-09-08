"use server";

import { db } from "@/lib/db";
import { logScrubberVerdict } from "@/lib/content/scrubber";
import { blogs, clients, generatedPosts, blogKeywordTargets } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/helpers";
import { createBlogSchema, updateBlogSchema } from "@/lib/validators/blog";
import {
  testConnection as platformTestConnection,
  deletePublishedPost,
  resolveShopifyBlogId,
  type PlatformBlog,
} from "@/lib/services/platform-client";
import {
  regenerateAndUpdatePost,
  getRecentTitles,
} from "@/lib/actions/content-generation-actions";
import { getActiveKnowledgeForBlog } from "@/lib/actions/knowledge-actions";
import {
  testConnection as shopifyTestConnection,
  fetchAllLiveArticles as shopifyFetchAllLive,
  type ShopifyCreds,
} from "@/lib/services/shopify-client";
import {
  generateContent,
  ideateTopic,
  estimateImageCostUsd,
  normalizeMetaTitle,
  normalizeMetaDescription,
  type GenerateOptions,
  type Tone,
} from "@/lib/services/content-generator";
import { parseBlogCsv } from "@/lib/services/csv-parser";
import {
  assignProfileForBlogIfPeptides,
  getStyleProfileForBlog,
} from "@/lib/actions/style-profile-actions";
import { verticalForNiche } from "@/lib/content/verticals";

/**
 * Load the blog's style profile, lazily assigning one if the blog is a
 * peptide blog created before the style-profile system landed. This makes
 * the architecture work for existing blogs without a manual backfill step.
 *
 * Returns null only when the blog isn't peptide-niche or assignment fails.
 */
async function loadOrAssignStyleProfile(blogId: string) {
  let profile = await getStyleProfileForBlog(blogId);
  if (profile) return profile;

  const result = await assignProfileForBlogIfPeptides(blogId);
  if (result.success && result.assigned) {
    // Re-fetch to get the persisted row (assignment writes to DB; we want
    // the in-memory shape with all field types resolved).
    profile = await getStyleProfileForBlog(blogId);
  }
  return profile;
}
import { eq, and, like, sql, desc, asc, count, inArray, isNotNull } from "drizzle-orm";
import { DEFAULT_PAGE_SIZE } from "@/lib/constants";
import type {
  BlogStatus,
  WpConnectionResult,
  CsvImportResult,
  PublishPostInput,
  PublishPostResult,
} from "@/lib/types";
import {
  publishPost as platformPublishPost,
  updateHomepageSeo as platformUpdateHomepageSeo,
} from "@/lib/services/platform-client";
import * as wp from "@/lib/services/wp-client";
import { pingIndexNowFireAndForget } from "@/lib/services/index-now-pinger";
import { scanPostAfterPublishFireAndForget } from "@/lib/services/post-seo-runner";
import { relinkAfterPublishFireAndForget } from "@/lib/services/semantic-linking";
import { resolveNicheConfig } from "@/lib/content/niche-config-db";
import { effectiveBlogCta, blogDomainCtaUrl } from "@/lib/content/cta-target";
import { deriveBrandName } from "@/lib/content/brand";
import { hasPlaceholders, interpolatePromptPlaceholders } from "@/lib/content/prompt-placeholders";
import {
  claimKeywordTargetForBlog,
  markKeywordTargetGenerated,
  markKeywordTargetFailed,
  type ClaimedKeywordTarget,
} from "@/lib/actions/keyword-target-actions";
import { ctaColorHex } from "@/lib/content/cta-colors";
import { resolveNextPostLanguage } from "@/lib/content/post-language";
import { getAppBaseUrl } from "@/lib/services/link-tracker";
import { revalidatePath } from "next/cache";

// ─── Types ──────────────────────────────────────────────────────────────────

interface GetBlogsParams {
  clientId?: string;
  search?: string;
  status?: BlogStatus;
  page?: number;
  pageSize?: number;
  sortBy?: "domain" | "status" | "createdAt" | "currentSeoScore";
  sortOrder?: "asc" | "desc";
}

interface GetBlogsResult {
  blogs: Array<{
    id: string;
    clientId: string;
    clientName: string;
    domain: string;
    platform: string;
    wpUrl: string | null;
    seoPlugin: string | null;
    shopifyStoreUrl: string | null;
    city: string | null;
    postingFrequency: string | null;
    postingFrequencyDays: number[] | null;
    lastPostVerifiedAt: Date | null;
    lastPostTitle: string | null;
    currentSeoScore: number | null;
    lastSeoScanAt: Date | null;
    status: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const cleanValue = (v: string | undefined | null): string | null =>
  v && v.trim().length > 0 ? v.trim() : null;

const cleanValueOrUndefined = (
  v: string | undefined | null,
): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return v.trim().length > 0 ? v.trim() : null;
};

// Normalize a posting-days value into a clean int[] (1-7, deduped, sorted)
// or null when the user clears the schedule.
const cleanPostingDays = (
  v: number[] | null | undefined,
): number[] | null => {
  if (!v || v.length === 0) return null;
  const cleaned = Array.from(
    new Set(v.filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)),
  ).sort((a, b) => a - b);
  return cleaned.length > 0 ? cleaned : null;
};

// Postgres unique-violation
const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
};

// ─── Get Blogs (Paginated) ──────────────────────────────────────────────────

export async function getBlogs(
  params: GetBlogsParams = {},
): Promise<GetBlogsResult> {
  await requireAdmin();

  const {
    clientId,
    search,
    status,
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
    sortBy = "createdAt",
    sortOrder = "desc",
  } = params;

  const conditions = [];

  if (clientId) conditions.push(eq(blogs.clientId, clientId));
  if (status) conditions.push(eq(blogs.status, status));
  if (search) conditions.push(like(blogs.domain, `%${search}%`));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult] = await db
    .select({ total: count() })
    .from(blogs)
    .where(whereClause);

  const totalCount = countResult?.total ?? 0;
  const totalPages = Math.ceil(totalCount / pageSize);
  const offset = (page - 1) * pageSize;

  const sortColumnMap = {
    domain: blogs.domain,
    status: blogs.status,
    createdAt: blogs.createdAt,
    currentSeoScore: blogs.currentSeoScore,
  };
  const sortColumn = sortColumnMap[sortBy] || blogs.createdAt;
  const orderFn = sortOrder === "asc" ? asc : desc;

  const rows = await db
    .select({
      id: blogs.id,
      clientId: blogs.clientId,
      clientName: clients.name,
      domain: blogs.domain,
      platform: blogs.platform,
      wpUrl: blogs.wpUrl,
      seoPlugin: blogs.seoPlugin,
      shopifyStoreUrl: blogs.shopifyStoreUrl,
      city: blogs.city,
      postingFrequency: blogs.postingFrequency,
      postingFrequencyDays: blogs.postingFrequencyDays,
      lastPostVerifiedAt: blogs.lastPostVerifiedAt,
      lastPostTitle: blogs.lastPostTitle,
      currentSeoScore: blogs.currentSeoScore,
      lastSeoScanAt: blogs.lastSeoScanAt,
      status: blogs.status,
      createdAt: blogs.createdAt,
      updatedAt: blogs.updatedAt,
    })
    .from(blogs)
    .leftJoin(clients, eq(blogs.clientId, clients.id))
    .where(whereClause)
    .orderBy(orderFn(sortColumn))
    .limit(pageSize)
    .offset(offset);

  return {
    blogs: rows.map((r) => ({
      ...r,
      clientName: r.clientName ?? "Unknown Client",
    })),
    totalCount,
    page,
    pageSize,
    totalPages,
  };
}

// ─── Export Blogs (CSV) ──────────────────────────────────────────────────────

interface ExportBlogsParams {
  clientId?: string;
  search?: string;
  status?: BlogStatus;
}

export type ExportBlogsResult =
  | { success: true; csv: string; filename: string }
  | { success: false; message: string };

/** Hard cap so a runaway export can't hang the request — well above any
 * realistic network size (docs put the target ceiling at ~3,500 blogs). */
const EXPORT_ROW_CAP = 20000;

const CSV_WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Export the blogs matching the current list filters (same clientId/search/
 * status the table is showing) as CSV — every matching row, not just the
 * current page. Opens directly in Excel/Sheets.
 */
export async function exportBlogsCsv(
  params: ExportBlogsParams = {},
): Promise<ExportBlogsResult> {
  await requireAdmin();

  const { clientId, search, status } = params;
  const conditions = [];
  if (clientId) conditions.push(eq(blogs.clientId, clientId));
  if (status) conditions.push(eq(blogs.status, status));
  if (search) conditions.push(like(blogs.domain, `%${search}%`));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      domain: blogs.domain,
      clientName: clients.name,
      platform: blogs.platform,
      city: blogs.city,
      region: blogs.region,
      countryCode: blogs.countryCode,
      brandName: blogs.brandName,
      status: blogs.status,
      currentSeoScore: blogs.currentSeoScore,
      lastPostVerifiedAt: blogs.lastPostVerifiedAt,
      lastPostTitle: blogs.lastPostTitle,
      postingFrequency: blogs.postingFrequency,
      postingFrequencyDays: blogs.postingFrequencyDays,
      createdAt: blogs.createdAt,
    })
    .from(blogs)
    .leftJoin(clients, eq(blogs.clientId, clients.id))
    .where(whereClause)
    .orderBy(asc(blogs.domain))
    .limit(EXPORT_ROW_CAP);

  const header = [
    "Domain",
    "Client",
    "Platform",
    "City",
    "Region",
    "Country",
    "Brand Name",
    "Status",
    "SEO Score",
    "Last Post Date",
    "Last Post Title",
    "Posting Frequency",
    "Posting Days",
    "Created At",
  ];

  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    const days = (r.postingFrequencyDays ?? [])
      .filter((d): d is number => d >= 1 && d <= 7)
      .map((d) => CSV_WEEKDAY_SHORT[d - 1])
      .join(" ");
    const cells = [
      r.domain,
      r.clientName ?? "",
      r.platform ?? "",
      r.city ?? "",
      r.region ?? "",
      r.countryCode ?? "",
      r.brandName ?? "",
      r.status ?? "",
      r.currentSeoScore != null ? String(r.currentSeoScore) : "",
      r.lastPostVerifiedAt ? new Date(r.lastPostVerifiedAt).toISOString().slice(0, 10) : "",
      r.lastPostTitle ?? "",
      r.postingFrequency ?? "",
      days,
      new Date(r.createdAt).toISOString().slice(0, 10),
    ];
    lines.push(cells.map((c) => csvCell(c)).join(","));
  }

  return {
    success: true,
    csv: lines.join("\r\n"),
    filename: `netgrid-blogs-${new Date().toISOString().slice(0, 10)}.csv`,
  };
}

// ─── Get Blogs Grouped By Client (for the Blogs hub cards) ──────────────────

export interface ClientBlogGroup {
  clientId: string;
  clientName: string;
  clientStatus: string | null;
  totalBlogs: number;
  activeBlogs: number;
  avgSeoScore: number | null;
  lastPostAt: Date | null;
}

/**
 * One row per client that owns at least one blog, with rollup counts for the
 * Blogs hub card grid. Clicking a card drills into /clients/[id]/blogs, where
 * the per-client table + "Add Blog" live.
 */
export async function getBlogsByClient(): Promise<ClientBlogGroup[]> {
  await requireAdmin();

  const rows = await db
    .select({
      clientId: clients.id,
      clientName: clients.name,
      clientStatus: clients.status,
      totalBlogs: count(blogs.id),
      activeBlogs: sql<number>`count(*) filter (where ${blogs.status} = 'active')`,
      avgSeoScore: sql<number | null>`round(avg(${blogs.currentSeoScore}))`,
      lastPostAt: sql<Date | null>`max(${blogs.lastPostVerifiedAt})`,
    })
    .from(clients)
    .innerJoin(blogs, eq(blogs.clientId, clients.id))
    .groupBy(clients.id, clients.name, clients.status)
    .orderBy(asc(clients.name));

  return rows.map((r) => ({
    clientId: r.clientId,
    clientName: r.clientName,
    clientStatus: r.clientStatus,
    totalBlogs: Number(r.totalBlogs),
    activeBlogs: Number(r.activeBlogs),
    avgSeoScore: r.avgSeoScore === null ? null : Number(r.avgSeoScore),
    lastPostAt: r.lastPostAt ? new Date(r.lastPostAt) : null,
  }));
}

// ─── Get Single Blog ────────────────────────────────────────────────────────

export async function getBlog(id: string) {
  await requireAdmin();

  const [row] = await db
    .select({
      id: blogs.id,
      clientId: blogs.clientId,
      clientName: clients.name,
      domain: blogs.domain,
      platform: blogs.platform,
      wpUrl: blogs.wpUrl,
      wpUsername: blogs.wpUsername,
      wpAppPassword: blogs.wpAppPassword,
      seoPlugin: blogs.seoPlugin,
      shopifyAuthMode: blogs.shopifyAuthMode,
      shopifyStoreUrl: blogs.shopifyStoreUrl,
      shopifyAdminApiToken: blogs.shopifyAdminApiToken,
      shopifyClientId: blogs.shopifyClientId,
      shopifyClientSecret: blogs.shopifyClientSecret,
      shopifyBlogHandle: blogs.shopifyBlogHandle,
      shopifyGrantedScopes: blogs.shopifyGrantedScopes,
      postingFrequency: blogs.postingFrequency,
      postingFrequencyDays: blogs.postingFrequencyDays,
      lastPostVerifiedAt: blogs.lastPostVerifiedAt,
      lastPostTitle: blogs.lastPostTitle,
      currentSeoScore: blogs.currentSeoScore,
      lastSeoScanAt: blogs.lastSeoScanAt,
      status: blogs.status,
      notesInternal: blogs.notesInternal,
      city: blogs.city,
      region: blogs.region,
      countryCode: blogs.countryCode,
      brandName: blogs.brandName,
      homepageMetaTitle: blogs.homepageMetaTitle,
      homepageMetaDescription: blogs.homepageMetaDescription,
      createdAt: blogs.createdAt,
      updatedAt: blogs.updatedAt,
    })
    .from(blogs)
    .leftJoin(clients, eq(blogs.clientId, clients.id))
    .where(eq(blogs.id, id));

  if (!row) {
    return { error: "Blog not found" };
  }

  return {
    ...row,
    clientName: row.clientName ?? "Unknown Client",
  };
}

// ─── Create Blog ────────────────────────────────────────────────────────────

export async function createBlog(data: unknown) {
  await requireAdmin();

  const parsed = createBlogSchema.safeParse(data);
  if (!parsed.success) {
    return {
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    };
  }

  const input = parsed.data;

  try {
    const [inserted] = await db
      .insert(blogs)
      .values({
        clientId: input.clientId,
        domain: input.domain.trim().toLowerCase(),
        platform: input.platform ?? "wordpress",
        wpUrl: cleanValue(input.wpUrl),
        wpUsername: cleanValue(input.wpUsername),
        wpAppPassword: cleanValue(input.wpAppPassword),
        seoPlugin: input.seoPlugin,
        shopifyAuthMode: input.shopifyAuthMode ?? "client_credentials",
        shopifyStoreUrl: cleanValue(input.shopifyStoreUrl),
        shopifyAdminApiToken: cleanValue(input.shopifyAdminApiToken),
        shopifyClientId: cleanValue(input.shopifyClientId),
        shopifyClientSecret: cleanValue(input.shopifyClientSecret),
        // Frequency is now always "weekly" — fall back if the form omits it.
        postingFrequency: cleanValue(input.postingFrequency) ?? "weekly",
        postingFrequencyDays: cleanPostingDays(input.postingFrequencyDays),
        status: input.status,
        notesInternal: cleanValue(input.notesInternal),
        city: cleanValue(input.city),
        region: cleanValue(input.region),
        countryCode: cleanValue(input.countryCode),
        brandName: cleanValue(input.brandName),
        homepageMetaTitle: cleanValue(input.homepageMetaTitle),
        homepageMetaDescription: cleanValue(input.homepageMetaDescription),
      })
      .returning({ id: blogs.id });

    // Style-profile assignment runs only for peptide-niche clients and is
    // non-blocking — a failure here doesn't roll back the blog insert. Admin
    // can retry via the reassign action if needed.
    try {
      const profileResult = await assignProfileForBlogIfPeptides(inserted.id);
      if (!profileResult.success && profileResult.message) {
        console.warn(
          `Style profile assignment skipped for blog ${inserted.id}: ${profileResult.message}`,
        );
      }
    } catch (profileErr) {
      console.error("Style profile assignment threw:", profileErr);
    }

    revalidatePath("/blogs");
    return { id: inserted.id };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { error: "A blog with this domain already exists" };
    }
    console.error("createBlog failed:", err);
    return {
      error: err instanceof Error ? err.message : "Failed to create blog",
    };
  }
}

// ─── Update Blog ────────────────────────────────────────────────────────────

export async function updateBlog(id: string, data: unknown) {
  await requireAdmin();

  const parsed = updateBlogSchema.safeParse(data);
  if (!parsed.success) {
    return {
      error: "Validation failed",
      details: parsed.error.flatten().fieldErrors,
    };
  }

  const input = parsed.data;

  const updateData: Record<string, unknown> = { updatedAt: new Date() };

  if (input.clientId !== undefined) updateData.clientId = input.clientId;
  if (input.domain !== undefined)
    updateData.domain = input.domain.trim().toLowerCase();
  if (input.platform !== undefined) updateData.platform = input.platform;
  if (input.wpUrl !== undefined)
    updateData.wpUrl = cleanValueOrUndefined(input.wpUrl);
  if (input.wpUsername !== undefined)
    updateData.wpUsername = cleanValueOrUndefined(input.wpUsername);
  if (input.wpAppPassword !== undefined)
    updateData.wpAppPassword = cleanValueOrUndefined(input.wpAppPassword);
  if (input.seoPlugin !== undefined) updateData.seoPlugin = input.seoPlugin;
  if (input.shopifyAuthMode !== undefined)
    updateData.shopifyAuthMode = input.shopifyAuthMode;
  if (input.shopifyStoreUrl !== undefined)
    updateData.shopifyStoreUrl = cleanValueOrUndefined(input.shopifyStoreUrl);
  if (input.shopifyAdminApiToken !== undefined)
    updateData.shopifyAdminApiToken = cleanValueOrUndefined(
      input.shopifyAdminApiToken,
    );
  if (input.shopifyClientId !== undefined)
    updateData.shopifyClientId = cleanValueOrUndefined(input.shopifyClientId);
  if (input.shopifyClientSecret !== undefined)
    updateData.shopifyClientSecret = cleanValueOrUndefined(
      input.shopifyClientSecret,
    );
  if (input.postingFrequency !== undefined)
    updateData.postingFrequency = cleanValueOrUndefined(input.postingFrequency);
  if (input.postingFrequencyDays !== undefined)
    updateData.postingFrequencyDays = cleanPostingDays(
      input.postingFrequencyDays,
    );
  if (input.status !== undefined) updateData.status = input.status;
  if (input.notesInternal !== undefined)
    updateData.notesInternal = cleanValueOrUndefined(input.notesInternal);
  if (input.city !== undefined)
    updateData.city = cleanValueOrUndefined(input.city);
  if (input.region !== undefined)
    updateData.region = cleanValueOrUndefined(input.region);
  if (input.countryCode !== undefined)
    updateData.countryCode = cleanValueOrUndefined(input.countryCode);
  if (input.brandName !== undefined)
    updateData.brandName = cleanValueOrUndefined(input.brandName);
  if (input.homepageMetaTitle !== undefined)
    updateData.homepageMetaTitle = cleanValueOrUndefined(input.homepageMetaTitle);
  if (input.homepageMetaDescription !== undefined)
    updateData.homepageMetaDescription = cleanValueOrUndefined(
      input.homepageMetaDescription,
    );

  try {
    const result = await db
      .update(blogs)
      .set(updateData)
      .where(eq(blogs.id, id))
      .returning({ id: blogs.id });

    if (result.length === 0) {
      return { error: "Blog not found" };
    }

    revalidatePath("/blogs");
    revalidatePath(`/blogs/${id}`);
    return { success: true };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { error: "A blog with this domain already exists" };
    }
    console.error("updateBlog failed:", err);
    return {
      error: err instanceof Error ? err.message : "Failed to update blog",
    };
  }
}

// ─── Push Homepage SEO (Shopify) ────────────────────────────────────────────

export interface PushHomepageSeoResult {
  success: boolean;
  message: string;
}

/**
 * Persist a blog's homepage meta title/description and, for Shopify blogs,
 * push them live to the shop's global.title_tag / global.description_tag
 * metafields — the same fields Shopify's own "Homepage title & meta
 * description" preference (Online Store → Preferences) reads. WordPress
 * blogs still get the DB save (so the intent is captured), just no live
 * push yet — see updateHomepageSeo in platform-client.ts.
 */
export async function pushHomepageSeo(
  blogId: string,
  input: { metaTitle?: string; metaDescription?: string },
): Promise<PushHomepageSeoResult> {
  await requireAdmin();

  const [blog] = await db
    .select({
      id: blogs.id,
      platform: blogs.platform,
      shopifyAuthMode: blogs.shopifyAuthMode,
      shopifyStoreUrl: blogs.shopifyStoreUrl,
      shopifyAdminApiToken: blogs.shopifyAdminApiToken,
      shopifyClientId: blogs.shopifyClientId,
      shopifyClientSecret: blogs.shopifyClientSecret,
    })
    .from(blogs)
    .where(eq(blogs.id, blogId));

  if (!blog) {
    return { success: false, message: "Blog not found" };
  }

  await db
    .update(blogs)
    .set({
      homepageMetaTitle: cleanValue(input.metaTitle),
      homepageMetaDescription: cleanValue(input.metaDescription),
      updatedAt: new Date(),
    })
    .where(eq(blogs.id, blogId));

  revalidatePath(`/blogs/${blogId}`);

  if (blog.platform !== "shopify") {
    return {
      success: true,
      message: "Saved. WordPress homepage SEO isn't auto-pushed yet — set it in your SEO plugin's Homepage tab.",
    };
  }

  const push = await platformUpdateHomepageSeo(blog, {
    metaTitle: input.metaTitle,
    metaDescription: input.metaDescription,
  });

  return { success: push.success, message: push.message };
}

// ─── Delete Blog (Soft) ─────────────────────────────────────────────────────

/**
 * Permanently delete a blog: first delete every post we published to the live
 * site (WordPress posts / Shopify articles), then hard-delete the blog row from
 * our DB. The row delete cascades to the blog's generated posts, SEO scans /
 * issues, style profile, and knowledge docs (all FK onDelete: cascade).
 *
 * Live-post deletion is best-effort and reported back — a blog whose
 * credentials are gone, or a post already removed on the site, won't block the
 * teardown. Returns counts so the UI can tell the operator what happened.
 */
export async function deleteBlog(id: string) {
  await requireAdmin();

  const [blog] = await db.select().from(blogs).where(eq(blogs.id, id)).limit(1);
  if (!blog) {
    return { error: "Blog not found" };
  }

  // Posts we published to the live site, identified by their external id.
  const publishedPosts = await db
    .select({ externalPostId: generatedPosts.externalPostId })
    .from(generatedPosts)
    .where(
      and(
        eq(generatedPosts.blogId, id),
        isNotNull(generatedPosts.externalPostId),
      ),
    );

  const platformBlog: PlatformBlog = {
    platform: blog.platform,
    wpUrl: blog.wpUrl,
    wpUsername: blog.wpUsername,
    wpAppPassword: blog.wpAppPassword,
    seoPlugin: blog.seoPlugin,
    shopifyAuthMode: blog.shopifyAuthMode,
    shopifyStoreUrl: blog.shopifyStoreUrl,
    shopifyAdminApiToken: blog.shopifyAdminApiToken,
    shopifyClientId: blog.shopifyClientId,
    shopifyClientSecret: blog.shopifyClientSecret,
    shopifyBlogHandle: blog.shopifyBlogHandle,
  };

  // Resolve the Shopify blog id once so we don't re-resolve per article.
  let shopifyBlogId: string | undefined;
  if (blog.platform === "shopify" && publishedPosts.length > 0) {
    shopifyBlogId = (await resolveShopifyBlogId(platformBlog))?.blogId;
  }

  let deletedLive = 0;
  let failedLive = 0;
  for (const post of publishedPosts) {
    if (!post.externalPostId) continue;
    const res = await deletePublishedPost(
      platformBlog,
      post.externalPostId,
      shopifyBlogId,
    );
    if (res.deleted) deletedLive += 1;
    else failedLive += 1;
  }

  // Hard-delete the blog (cascades to posts, scans, issues, profile, docs).
  await db.delete(blogs).where(eq(blogs.id, id));

  revalidatePath("/blogs");
  return {
    success: true,
    deletedLivePosts: deletedLive,
    failedLivePosts: failedLive,
    totalLivePosts: publishedPosts.length,
  };
}

/**
 * Delete several blogs at once (multi-select batch delete). Each blog is torn
 * down through {@link deleteBlog} so its live posts are removed too; failures
 * are counted rather than aborting the batch.
 */
export async function deleteBlogs(
  ids: string[],
): Promise<{ success: boolean; deleted: number; failed: number; message: string }> {
  await requireAdmin();
  let deleted = 0;
  let failed = 0;
  for (const id of ids) {
    const res = await deleteBlog(id);
    if ("error" in res) failed += 1;
    else deleted += 1;
  }
  revalidatePath("/blogs");
  return {
    success: failed === 0,
    deleted,
    failed,
    message:
      `Deleted ${deleted} blog${deleted === 1 ? "" : "s"}` +
      (failed > 0 ? ` · ${failed} couldn't be deleted` : ""),
  };
}

// ─── Test Blog Connection (saved blog) ──────────────────────────────────────

export async function testBlogConnection(
  id: string,
): Promise<WpConnectionResult> {
  await requireAdmin();

  const [blog] = await db
    .select({
      platform: blogs.platform,
      wpUrl: blogs.wpUrl,
      wpUsername: blogs.wpUsername,
      wpAppPassword: blogs.wpAppPassword,
      shopifyAuthMode: blogs.shopifyAuthMode,
      shopifyStoreUrl: blogs.shopifyStoreUrl,
      shopifyAdminApiToken: blogs.shopifyAdminApiToken,
      shopifyClientId: blogs.shopifyClientId,
      shopifyClientSecret: blogs.shopifyClientSecret,
      shopifyBlogHandle: blogs.shopifyBlogHandle,
    })
    .from(blogs)
    .where(eq(blogs.id, id));

  if (!blog) {
    return { success: false, message: "Blog not found" };
  }

  const result = await platformTestConnection(blog);

  if (result.success) {
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (result.seoPlugin) {
      updateData.seoPlugin = result.seoPlugin;
    }
    await db.update(blogs).set(updateData).where(eq(blogs.id, id));
  }

  return result;
}

// ─── Test Shopify Connection (pre-save, from form) ──────────────────────────

export interface TestShopifyInput {
  storeUrl: string;
  authMode: "legacy_token" | "client_credentials";
  adminToken?: string;
  clientId?: string;
  clientSecret?: string;
}

export async function testShopifyConnection(input: TestShopifyInput) {
  await requireAdmin();

  if (!input.storeUrl) {
    return {
      success: false as const,
      platform: "shopify" as const,
      message: "Store URL is required",
    };
  }

  let creds: ShopifyCreds;

  if (input.authMode === "legacy_token") {
    if (!input.adminToken) {
      return {
        success: false as const,
        platform: "shopify" as const,
        message: "Admin API access token is required",
      };
    }
    creds = {
      mode: "legacy_token",
      storeUrl: input.storeUrl,
      adminToken: input.adminToken,
    };
  } else {
    if (!input.clientId || !input.clientSecret) {
      return {
        success: false as const,
        platform: "shopify" as const,
        message: "Client ID and Client Secret are required",
      };
    }
    creds = {
      mode: "client_credentials",
      storeUrl: input.storeUrl,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
    };
  }

  return shopifyTestConnection(creds);
}

// ─── Publish a Post / Article (ad-hoc input from a saved blog) ──────────────

export async function publishBlogPost(
  id: string,
  input: PublishPostInput,
): Promise<PublishPostResult> {
  await requireAdmin();

  const [row] = await db
    .select({
      domain: blogs.domain,
      platform: blogs.platform,
      city: blogs.city,
      wpUrl: blogs.wpUrl,
      wpUsername: blogs.wpUsername,
      wpAppPassword: blogs.wpAppPassword,
      shopifyAuthMode: blogs.shopifyAuthMode,
      shopifyStoreUrl: blogs.shopifyStoreUrl,
      shopifyAdminApiToken: blogs.shopifyAdminApiToken,
      shopifyClientId: blogs.shopifyClientId,
      shopifyClientSecret: blogs.shopifyClientSecret,
      shopifyBlogHandle: blogs.shopifyBlogHandle,
      clientStatus: clients.status,
    })
    .from(blogs)
    .innerJoin(clients, eq(blogs.clientId, clients.id))
    .where(eq(blogs.id, id));

  if (!row) {
    return { success: false, message: "Blog not found" };
  }

  if (row.clientStatus === "paused") {
    return { success: false, message: "This client is paused — publishing is disabled until it's unpaused." };
  }

  const result = await platformPublishPost(row, input);

  // After first successful Shopify publish, cache the resolved blog handle so
  // later publishes skip the listBlogs roundtrip.
  if (
    result.success &&
    row.platform === "shopify" &&
    !row.shopifyBlogHandle &&
    "blogHandle" in result &&
    typeof result.blogHandle === "string" &&
    result.blogHandle
  ) {
    try {
      await db
        .update(blogs)
        .set({
          shopifyBlogHandle: result.blogHandle,
          updatedAt: new Date(),
        })
        .where(eq(blogs.id, id));
    } catch (err) {
      // Cache miss is non-fatal — log and continue.
      console.warn("Failed to cache shopifyBlogHandle:", err);
    }
  }

  return result;
}

// ─── Generate a Blog Post (writes to generated_posts) ───────────────────────

export interface GeneratePostInput {
  blogId: string;
  topic?: string;          // if omitted, ideateTopic picks one based on niche + recent
  keywords?: string[];     // if omitted, derived from ideation or empty
  wordCount?: number;      // clamped 500-800 internally
  tone?: Tone;
  brandVoice?: string;
  targetAudience?: string;
  seoOptimized?: boolean;
  autoPublish?: boolean;   // if true, publishGeneratedPost runs immediately after
}

export type GenerateBlogPostResult =
  | {
      success: true;
      generatedPostId: string;
      publishResult?: PublishPostResult; // present when autoPublish was requested
    }
  | { success: false; message: string };

export async function generateBlogPost(
  input: GeneratePostInput,
): Promise<GenerateBlogPostResult> {
  await requireAdmin();

  // 1. Load blog + niche context
  const [blog] = await db
    .select({
      id: blogs.id,
      clientId: blogs.clientId,
      domain: blogs.domain,
      platform: blogs.platform,
      city: blogs.city,
      region: blogs.region,
      countryCode: blogs.countryCode,
      brandName: blogs.brandName,
      niche: clients.niche,
      languageMode: clients.languageMode,
      clientCustomPrompt: clients.customPrompt,
      clientStackPersona: clients.stackPersona,
      ctaEnabled: clients.ctaEnabled,
      ctaLabel: clients.ctaLabel,
      ctaUrl: clients.ctaUrl,
      ctaPlacement: clients.ctaPlacement,
      ctaColor: clients.ctaColor,
      registrationEnabled: clients.registrationFormEnabled,
      registrationPlacement: clients.registrationFormPlacement,
      clientStatus: clients.status,
    })
    .from(blogs)
    .leftJoin(clients, eq(blogs.clientId, clients.id))
    .where(eq(blogs.id, input.blogId));

  if (!blog) {
    return { success: false, message: "Blog not found" };
  }

  if (blog.clientStatus === "paused") {
    return { success: false, message: "This client is paused — content generation is disabled until it's unpaused." };
  }

  // 2. Load (or lazily assign) the blog's locked style profile FIRST so
  //    it can flow into both topic ideation AND article generation.
  //    Critical: without passing the profile into ideateTopic, every
  //    peptide blog's first post defaulted to BPC-157 (the first item
  //    in the generic peptides keyTopics list). The profile gives each
  //    blog a UNIQUE primary-compounds pair to anchor on.
  const styleProfile = await loadOrAssignStyleProfile(input.blogId);
  if (styleProfile) {
    console.info(
      `[generateBlogPost] Using style profile for ${blog.domain}: ` +
        `voice V${styleProfile.voiceId}, skeleton S${styleProfile.skeletonId}, ` +
        `cadence ${styleProfile.cadenceId}, sub-niche ${styleProfile.subNicheId}, ` +
        `strictness=${styleProfile.scrubberStrictness}, ` +
        `primary=${styleProfile.primaryCompounds.join("+")}`,
    );
  } else {
    console.info(
      `[generateBlogPost] No style profile for ${blog.domain} (niche="${blog.niche ?? "none"}") — using legacy prompt path`,
    );
  }

    // Resolve the post language ONCE so topic ideation and article generation
  // are in the SAME language. The per-client language toggle wins (en / fr /
  // strict en_fr alternation); when unset it falls back to the legacy
  // TLD/niche/vertical derivation.
  const verticalForPost = verticalForNiche(blog.niche);
  const postLanguage = await resolveNextPostLanguage({
    languageMode: blog.languageMode,
    blogId: input.blogId,
    verticalLanguage: verticalForPost?.language,
    domain: blog.domain,
    niche: blog.niche,
  });

  // 3. Topic — explicit or ideated from recent titles + style profile
  let topic = input.topic?.trim() || "";
  let keywords = input.keywords ?? [];

  // Custom prompts are client-wide. Resolved once here and reused for BOTH
  // topic ideation and article generation, so topics stay on-brand for the
  // brief instead of drifting to the niche's generic topics.
  let customPrompt = blog.clientCustomPrompt?.trim() || undefined;

  // Client Knowledge Base (client-wide + per-blog active docs). Previously the
  // manual "Generate post" path skipped this entirely — only the cron path used
  // it — so manual posts ignored uploaded briefs/keyword sheets. Fetch it here
  // and feed it into BOTH ideation and writing, matching the auto path.
  const knowledge = await getActiveKnowledgeForBlog(input.blogId);

  // Local keyword-targeted content (see docs/local-keyword-content-plan.md).
  // Claim the best pending keyword target for this blog — same gate as the
  // auto-publish path (runGenerateAndPublish): only when the caller hasn't
  // already supplied an explicit topic. Previously this manual "Generate
  // post" path never claimed from — or referenced — blog_keyword_targets at
  // all, so it ignored city/keyword assignment entirely.
  const claimedTarget: ClaimedKeywordTarget | undefined = topic
    ? undefined
    : await claimKeywordTargetForBlog(input.blogId);

  const brandName = blog.brandName || deriveBrandName(blog.domain) || undefined;
  const localTarget = claimedTarget
    ? {
        keyword: claimedTarget.keyword,
        city: claimedTarget.city,
        region: blog.region,
        countryCode: blog.countryCode,
        brandName,
        brandUrl: blogDomainCtaUrl(blog.domain) ?? undefined,
      }
    : undefined;

  // Custom prompts can reference {keyword}/{city}/{region}/{country}/{brand}/
  // {domain} — same interpolation the auto path uses. No-op when the prompt
  // has no placeholders.
  if (customPrompt && hasPlaceholders(customPrompt)) {
    customPrompt = await interpolatePromptPlaceholders(
      customPrompt,
      {
        clientId: blog.clientId,
        domain: blog.domain,
        city: blog.city,
        region: blog.region,
        countryCode: blog.countryCode,
        niche: blog.niche,
      },
      claimedTarget,
      brandName,
    );
  }

  // Tracks whether the post that ends up published actually targeted the
  // claimed keyword — set only when attempt 1 (below) succeeds using
  // localTarget. A fallback recovery attempt (a re-ideated, unrelated topic)
  // must not be reported back to the ledger as covering the claimed keyword.
  let generatedViaLocalTarget = false;

  if (!topic) {
    if (claimedTarget) {
      topic = claimedTarget.topicTitle;
      if (keywords.length === 0) keywords = [claimedTarget.keyword];
    } else {
      // Own + sibling-blog recent titles, so ideation avoids network-wide repeats.
      const recent = await getRecentTitles(input.blogId, blog.clientId);

      try {
        const idea = await ideateTopic(
          blog.niche,
          recent,
          {
            verticalKey: verticalForPost?.key ?? null,
            styleProfile: styleProfile ?? undefined,
            language: postLanguage,
            customPrompt,
            knowledge,
          },
        );
        topic = idea.topic;
        if (keywords.length === 0) keywords = idea.keywords;
      } catch (err) {
        return {
          success: false,
          message:
            err instanceof Error
              ? `Topic ideation failed: ${err.message}`
              : "Topic ideation failed",
        };
      }
    }
  }

  if (!topic) {
    return { success: false, message: "No topic provided and ideation returned empty" };
  }

  // 4. Insert "generating" placeholder so the row appears in the UI immediately
  const [pending] = await db
    .insert(generatedPosts)
    .values({
      blogId: input.blogId,
      clientId: blog.clientId,
      topic,
      keywords,
      status: "generating",
      language: postLanguage,
      isAutoGenerated: false,
    })
    .returning({ id: generatedPosts.id });

  revalidatePath(`/blogs/${input.blogId}`);
  revalidatePath(`/blogs/${input.blogId}/posts`);

    // Build the generation options once — only `topic` and `keywords` change
  // between attempts when we fall back to a fresh ideated topic.
  // Niche config from the editable `niches` DB table (falls back to code when
  // there's no row). Resolved once; reused across topic-recovery retries.
  const resolvedNiche = await resolveNicheConfig(blog.niche);
  // customPrompt resolved above (reused for ideation); persona-stack is client-level.
  const applyPersona = Boolean(customPrompt) && Boolean(blog.clientStackPersona);

  const buildOpts = (
    t: string,
    kw: string[],
    useLocalTarget: boolean,
  ): GenerateOptions => ({
    topic: t,
    keywords: kw,
    wordCount: input.wordCount ?? 700,
    tone: input.tone ?? "professional",
    niche: blog.niche,
    resolvedNiche,
    customPrompt,
    applyPersona,
    knowledgeSummaries: knowledge.summaries,
    brandVoice: input.brandVoice,
    targetAudience: input.targetAudience,
    seoOptimized: input.seoOptimized ?? true,
    styleProfile: styleProfile ?? undefined,
    verticalKey: verticalForPost?.key ?? null,
    language: postLanguage,
    // utm_source for the direct CTA / money links (T02).
    blogDomain: blog.domain,
    // blogs.brand_name verbatim — the local `brandName` const above falls back
    // to deriveBrandName() and must not reach the title tag.
    brandName: blog.brandName,
    localTarget: useLocalTarget ? localTarget : undefined,
    cta: effectiveBlogCta({
      niche: blog.niche,
      blogDomain: blog.domain,
      ctaEnabled: blog.ctaEnabled,
      ctaLabel: blog.ctaLabel,
      ctaUrl: blog.ctaUrl,
      ctaPlacement: blog.ctaPlacement,
      ctaColor: blog.ctaColor,
    }),
    registrationForm: blog.registrationEnabled
      ? {
          actionUrl: `${getAppBaseUrl()}/api/register/${input.blogId}`,
          placement: blog.registrationPlacement ?? "bottom",
          color: ctaColorHex(blog.ctaColor) ?? undefined,
        }
      : undefined,
    postId: pending.id,
  });

  // Generation with topic-level recovery.
  let result;
  const MAX_TOPIC_ATTEMPTS = 2;
  let currentTopic = topic;
  let currentKeywords = keywords;
  const failedAttempts: Array<{ topic: string; error: string }> = [];

  for (let attempt = 1; attempt <= MAX_TOPIC_ATTEMPTS; attempt++) {
    try {
      console.info(
        `[generateBlogPost] attempt ${attempt}/${MAX_TOPIC_ATTEMPTS} for ${blog.domain}: "${currentTopic}"`,
      );
      result = await generateContent(
        buildOpts(currentTopic, currentKeywords, attempt === 1),
      );
      if (attempt === 1 && claimedTarget) generatedViaLocalTarget = true;
      if (attempt > 1) {
        console.info(
          `[generateBlogPost] recovered on attempt ${attempt} with new topic`,
        );
      }
      break;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Content generation failed";
      failedAttempts.push({ topic: currentTopic, error: message });
      console.warn(
        `[generateBlogPost] attempt ${attempt} failed for "${currentTopic}": ${message.slice(0, 200)}`,
      );

      if (attempt === MAX_TOPIC_ATTEMPTS) {
        const combined = failedAttempts
          .map((a) => `"${a.topic}": ${a.error}`)
          .join(" | ");
        await db
          .update(generatedPosts)
          .set({
            status: "failed",
            failureReason: `All ${MAX_TOPIC_ATTEMPTS} topic attempts failed — ${combined}`,
            updatedAt: new Date(),
          })
          .where(eq(generatedPosts.id, pending.id));
        revalidatePath(`/blogs/${input.blogId}/posts`);
        if (claimedTarget) {
          await markKeywordTargetFailed(
            claimedTarget.id,
            `All ${MAX_TOPIC_ATTEMPTS} topic attempts failed — ${combined}`,
          );
        }
        return {
          success: false,
          message: `Generation failed on ${MAX_TOPIC_ATTEMPTS} different topics. Last error: ${message}`,
        };
      }

      try {
        const recent = await db
          .select({ title: generatedPosts.title })
          .from(generatedPosts)
          .where(eq(generatedPosts.blogId, input.blogId))
          .orderBy(desc(generatedPosts.createdAt))
          .limit(20);
        const recentTitles = [
          currentTopic,
          ...recent
            .map((r) => r.title)
            .filter((t): t is string => Boolean(t)),
        ];
        const newIdea = await ideateTopic(blog.niche, recentTitles, {
          verticalKey: verticalForPost?.key ?? null,
          styleProfile: styleProfile ?? undefined,
          language: postLanguage,
          customPrompt,
          knowledge,
        });
        if (!newIdea.topic || newIdea.topic.trim() === currentTopic.trim()) {
          throw new Error("Re-ideation returned an empty or duplicate topic");
        }
        currentTopic = newIdea.topic;
        currentKeywords = newIdea.keywords.length > 0
          ? newIdea.keywords
          : currentKeywords;
        await db
          .update(generatedPosts)
          .set({
            topic: currentTopic,
            keywords: currentKeywords,
            updatedAt: new Date(),
          })
          .where(eq(generatedPosts.id, pending.id));
        console.info(
          `[generateBlogPost] re-ideated topic: "${currentTopic}"`,
        );
      } catch (ideationErr) {
        const ideationMsg =
          ideationErr instanceof Error
            ? ideationErr.message
            : "Re-ideation failed";
        await db
          .update(generatedPosts)
          .set({
            status: "failed",
            failureReason: `Generation failed for "${currentTopic}": ${message}; re-ideation also failed: ${ideationMsg}`,
            updatedAt: new Date(),
          })
          .where(eq(generatedPosts.id, pending.id));
        revalidatePath(`/blogs/${input.blogId}/posts`);
        if (claimedTarget) {
          await markKeywordTargetFailed(
            claimedTarget.id,
            `Generation failed for "${currentTopic}": ${message}; re-ideation also failed: ${ideationMsg}`,
          );
        }
        return {
          success: false,
          message: `Both generation and re-ideation failed: ${message}; ${ideationMsg}`,
        };
      }
    }
  }

  if (!result) {
    // Unreachable in practice (the loop either breaks with a result or
    // returns inside the failure branches) but TypeScript needs the guard.
    return { success: false, message: "Generation pipeline exited without a result" };
  }

  // Local keyword-targeted content: resolve the claim now that generation is
  // done. A fallback recovery attempt published on an unrelated, re-ideated
  // topic never covered the claimed keyword, so the row goes straight back to
  // the pool ('failed', retryable) rather than waiting on publish. When the
  // claimed keyword WAS covered, leave the row 'generating' (claimed) — it's
  // only resolved to 'generated' once the post actually goes live, in
  // publishGeneratedPost below, since a draft left unpublished hasn't
  // actually delivered the keyword-targeted content yet.
  if (claimedTarget) {
    if (generatedViaLocalTarget) {
      await db
        .update(blogKeywordTargets)
        .set({ generatedPostId: pending.id, updatedAt: new Date() })
        .where(eq(blogKeywordTargets.id, claimedTarget.id));
    } else {
      await markKeywordTargetFailed(
        claimedTarget.id,
        "Fell back to a re-ideated topic after the keyword-target attempt failed",
      );
    }
  }

  // Cost log — per-post breakdown so the operator can spot drift fast.
  // text = Claude (Sonnet body + Haiku ideate/scene/etc., cache-aware).
  // images = estimated from GOOGLE_IMAGE_MODEL × #images actually produced
  // (Gemini doesn't report billable tokens, so this is a heuristic).
  {
    const textCost = Number(result.costUsd) || 0;
    const imageCount =
      (result.heroImageUrl ? 1 : 0) + (result.bodyImageUrl ? 1 : 0);
    const perImage = estimateImageCostUsd();
    const imageCost = imageCount * perImage;
    const total = textCost + imageCost;
    console.info(
      `[cost] ${blog.domain}: text=$${textCost.toFixed(4)} ` +
        `(${result.tokensUsed} tok), ` +
        `images=$${imageCost.toFixed(4)} (${imageCount}× @ $${perImage.toFixed(2)}), ` +
        `total=$${total.toFixed(4)}`,
    );
  }

  // 5. Persist generated content (incl. scrubber report when present)

  // 5. Persist generated content (incl. scrubber report when present)
  await db
    .update(generatedPosts)
    .set({
      title: result.title,
      body: result.content,
      excerpt: result.excerpt,
      metaTitle: result.metaTitle,
      metaDescription: result.metaDescription,
      featuredImageUrl: result.heroImageUrl ?? null,
      bodyImageUrl: result.bodyImageUrl ?? null,
      keywords: result.keywords,
      wordCount: result.wordCount,
      seoScore: result.seoScore,
      readabilityScore: result.readabilityScore,
      brandVoiceScore: result.brandVoiceScore,
      tokensUsed: result.tokensUsed,
      costUsd: result.costUsd.toString(),
      status: "generated",
      scrubberReport: result.scrubberReport ?? null,
      flaggedForReview: result.flaggedForReview ?? false,
      generatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(generatedPosts.id, pending.id));

  // Shadow-mode instrument (T07) — same call the auto-publish path makes, so
  // manual generations show up in the same [scrubber-gate] log stream.
  logScrubberVerdict({
    domain: blog.domain,
    generatedPostId: pending.id,
    strictness: styleProfile?.scrubberStrictness ?? null,
    verdict: result.scrubberVerdict,
    flaggedForReview: result.flaggedForReview ?? false,
    report: result.scrubberReport,
  });

  revalidatePath(`/blogs/${input.blogId}/posts`);

  // 6. Optional immediate publish
  if (input.autoPublish) {
    const publishResult = await publishGeneratedPost(pending.id);
    return {
      success: true,
      generatedPostId: pending.id,
      publishResult,
    };
  }

  return { success: true, generatedPostId: pending.id };
}

// ─── Trigger posts for a whole client (multi-blog) ──────────────────────────

export interface TriggerClientPostsInput {
  clientId: string;
  /** The blogs the operator picked in the site selector. */
  blogIds: string[];
  /** Push each post live right after generation (defaults to true). */
  autoPublish?: boolean;
}

export interface TriggerClientPostResult {
  blogId: string;
  domain: string;
  /** Generation succeeded. */
  generated: boolean;
  /** Publish succeeded — only meaningful when autoPublish was requested. */
  published: boolean;
  message: string;
}

export interface TriggerClientPostsResult {
  success: boolean;
  results: TriggerClientPostResult[];
  generatedCount: number;
  publishedCount: number;
  failedCount: number;
  message: string;
}

/**
 * Fan a single "trigger posts" action across the sites the operator selected
 * for a client. Each site gets ONE freshly generated post (topic auto-picked
 * from the niche/custom-prompt + recent posts), optionally published live.
 *
 * Blogs are processed sequentially so a burst of image + publish calls doesn't
 * hammer the model and destination hosts all at once. One blog failing never
 * aborts the rest — every selected site is attempted and reported on.
 */
export async function triggerClientPosts(
  input: TriggerClientPostsInput,
): Promise<TriggerClientPostsResult> {
  await requireAdmin();

  const autoPublish = input.autoPublish ?? true;

  // Resolve the picked blogs, scoped to this client so a stray/foreign blogId
  // can't be smuggled in. Keeps us from generating against another client's site.
  const picked = input.blogIds.filter(Boolean);
  if (picked.length === 0) {
    return {
      success: false,
      results: [],
      generatedCount: 0,
      publishedCount: 0,
      failedCount: 0,
      message: "No sites selected.",
    };
  }

  const rows = await db
    .select({ id: blogs.id, domain: blogs.domain })
    .from(blogs)
    .where(
      and(eq(blogs.clientId, input.clientId), inArray(blogs.id, picked)),
    );

  const domainById = new Map(rows.map((r) => [r.id, r.domain]));
  const validIds = rows.map((r) => r.id);

  if (validIds.length === 0) {
    return {
      success: false,
      results: [],
      generatedCount: 0,
      publishedCount: 0,
      failedCount: 0,
      message: "None of the selected sites belong to this client.",
    };
  }

  const results: TriggerClientPostResult[] = [];

  for (const blogId of validIds) {
    const domain = domainById.get(blogId) ?? blogId.slice(0, 8);
    try {
      const res = await generateBlogPost({ blogId, autoPublish });
      if (!res.success) {
        results.push({
          blogId,
          domain,
          generated: false,
          published: false,
          message: res.message,
        });
        continue;
      }

      const published = autoPublish
        ? res.publishResult?.success ?? false
        : false;
      const message = autoPublish
        ? res.publishResult
          ? res.publishResult.message
          : "Generated (no publish result returned)."
        : "Generated as draft.";

      results.push({ blogId, domain, generated: true, published, message });
    } catch (e) {
      results.push({
        blogId,
        domain,
        generated: false,
        published: false,
        message: e instanceof Error ? e.message : "Unexpected error",
      });
    }
  }

  const generatedCount = results.filter((r) => r.generated).length;
  const publishedCount = results.filter((r) => r.published).length;
  const failedCount = results.filter((r) => !r.generated).length;

  revalidatePath(`/clients/${input.clientId}`);

  const summary = autoPublish
    ? `${publishedCount}/${validIds.length} published` +
      (failedCount > 0 ? `, ${failedCount} failed` : "")
    : `${generatedCount}/${validIds.length} generated` +
      (failedCount > 0 ? `, ${failedCount} failed` : "");

  return {
    success: failedCount === 0,
    results,
    generatedCount,
    publishedCount,
    failedCount,
    message: summary,
  };
}

// ─── Publish a Generated Post (from generated_posts table) ──────────────────

export async function publishGeneratedPost(
  generatedPostId: string,
): Promise<PublishPostResult> {
  await requireAdmin();

  const [post] = await db
    .select({
      id: generatedPosts.id,
      blogId: generatedPosts.blogId,
      title: generatedPosts.title,
      body: generatedPosts.body,
      excerpt: generatedPosts.excerpt,
      metaTitle: generatedPosts.metaTitle,
      metaDescription: generatedPosts.metaDescription,
      featuredImageUrl: generatedPosts.featuredImageUrl,
      keywords: generatedPosts.keywords,
      status: generatedPosts.status,
    })
    .from(generatedPosts)
    .where(eq(generatedPosts.id, generatedPostId));

  if (!post) {
    return { success: false, message: "Generated post not found" };
  }

  if (post.status === "published") {
    return { success: false, message: "Post is already published" };
  }

  if (post.status === "publishing") {
    return {
      success: false,
      message: "Post is already being published — try again in a moment",
    };
  }

  if (!post.title || !post.body) {
    await db
      .update(generatedPosts)
      .set({
        status: "failed",
        failureReason: "Missing title or body — cannot publish",
        updatedAt: new Date(),
      })
      .where(eq(generatedPosts.id, generatedPostId));
    return {
      success: false,
      message: "Generated post is missing title or body",
    };
  }

  // Mark as publishing so concurrent triggers don't double-publish.
  await db
    .update(generatedPosts)
    .set({ status: "publishing", updatedAt: new Date() })
    .where(eq(generatedPosts.id, generatedPostId));

  // Convert keywords (jsonb) → string[] for tags
  let tags: string[] | undefined;
  if (Array.isArray(post.keywords)) {
    tags = post.keywords.filter(
      (k): k is string => typeof k === "string" && k.trim().length > 0,
    );
  }

  // SEO title + meta description. These were previously selected but dropped
  // here, so the platform never received global.title_tag / description_tag
  // (Shopify) or the Yoast/RankMath fields (WP) — leaving the theme to
  // auto-derive an over-length <title> (article title + store suffix) and a
  // body-sourced meta description, tripping the 580px / 1000px audit limits.
  // Normalize at publish so even older rows (stored before the caps existed,
  // or with an empty meta) are clamped; the helpers are idempotent.
  // Operator-confirmed store name for the " | {brand}" meta-title suffix.
  // Null means no suffix; deriveBrandName() is deliberately NOT used here
  // (src/lib/content/brand.ts:1-14 — it is a form-prefill suggestion only).
  const [brandRow] = await db
    .select({ brandName: blogs.brandName })
    .from(blogs)
    .where(eq(blogs.id, post.blogId))
    .limit(1);
  const metaTitle = normalizeMetaTitle(
    post.metaTitle,
    post.title,
    undefined,
    brandRow?.brandName,
  );
  const metaDescription = normalizeMetaDescription(
    post.metaDescription,
    post.excerpt ?? "",
  );

  const input: PublishPostInput = {
    title: post.title,
    content: post.body,
    excerpt: post.excerpt ?? undefined,
    status: "publish",
    tags,
    featuredImageUrl: post.featuredImageUrl ?? undefined,
    metaTitle: metaTitle || undefined,
    metaDescription: metaDescription || undefined,
  };

  const result = await publishBlogPost(post.blogId, input);

  if (result.success) {
    await db
      .update(generatedPosts)
      .set({
        status: "published",
        externalPostId: result.postId ? String(result.postId) : null,
        externalPostUrl: result.postUrl ?? null,
        publishedAt: new Date(),
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(eq(generatedPosts.id, generatedPostId));

    // Stamp last-post fields on the blog row so dashboards stay fresh.
        // Stamp last-post fields on the blog row so dashboards stay fresh.
    await db
      .update(blogs)
      .set({
        lastPostTitle: post.title,
        lastPostVerifiedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(blogs.id, post.blogId));

    revalidatePath(`/blogs/${post.blogId}`);
    revalidatePath("/blogs");

    // IndexNow ping — fire-and-forget. Auto-deploys the key file on the
    // blog's domain via the platform's API on first publish, then POSTs
    // to api.indexnow.org. Covers Bing, Yandex, Seznam, Naver, Yep,
    // DuckDuckGo in one call. No-op when INDEXNOW_KEY is unset.
    console.info(
      `[indexnow] step 7 reached: postUrl=${result.postUrl ?? "(empty!)"}`,
    );
    if (result.postUrl) {
      const [fullBlog] = await db
        .select()
        .from(blogs)
        .where(eq(blogs.id, post.blogId));
      if (fullBlog) {
        pingIndexNowFireAndForget(fullBlog, result.postUrl);
      } else {
        console.warn(
          `[indexnow] SKIP — could not reload blog row for ping`,
        );
      }
    } else {
      console.warn(
        `[indexnow] SKIP — publish.postUrl is empty (platform returned no URL)`,
      );
    }

    // Per-post SEO scan — once a post is live, audit that specific page.
    // Fire-and-forget so a slow/blocked scan never delays the publish.
    scanPostAfterPublishFireAndForget(generatedPostId);

    // Semantic linking — embed this post and inject a "Related posts" block
    // (and, on Shopify, the related-posts metafield), plus refresh its
    // neighbours' links. Fire-and-forget; no-op when OPENAI_API_KEY is unset.
    relinkAfterPublishFireAndForget(generatedPostId);

    // Local keyword-targeted content: this is the single choke point every
    // publish path goes through (immediate "Generate & publish" and a later
    // manual "Publish" of a draft alike), so it's also where a claimed
    // ledger row gets resolved to 'generated' — only once the post has
    // actually gone live, per docs/local-keyword-content-plan.md.
    await resolveKeywordTargetForPublishedPost(generatedPostId, true);
  } else {
    await db
      .update(generatedPosts)
      .set({
        status: "failed",
        failureReason: result.message,
        updatedAt: new Date(),
      })
      .where(eq(generatedPosts.id, generatedPostId));

    await resolveKeywordTargetForPublishedPost(
      generatedPostId,
      false,
      `Publish failed: ${result.message}`,
    );
  }

  return result;
}

/**
 * Resolve any claimed (status='generating') keyword-target ledger row linked
 * to this generated post — set by generateBlogPost right after a successful,
 * on-target generation. No-op when this post never claimed a target (the
 * common case for blogs with no city assigned).
 */
async function resolveKeywordTargetForPublishedPost(
  generatedPostId: string,
  published: boolean,
  failureReason?: string,
): Promise<void> {
  const [claimed] = await db
    .select({ id: blogKeywordTargets.id })
    .from(blogKeywordTargets)
    .where(
      and(
        eq(blogKeywordTargets.generatedPostId, generatedPostId),
        eq(blogKeywordTargets.status, "generating"),
      ),
    )
    .limit(1);
  if (!claimed) return;

  if (published) {
    await markKeywordTargetGenerated(claimed.id, generatedPostId);
  } else {
    await markKeywordTargetFailed(
      claimed.id,
      failureReason ?? "Publish failed",
    );
  }
}

// ─── Retry a Failed Generated Post ──────────────────────────────────────────

export async function retryGeneratedPost(
  generatedPostId: string,
): Promise<PublishPostResult> {
  await requireAdmin();

  // Load the failed row to decide what kind of retry this is:
  //
  //   Case A — title/body are missing: generation never produced content
  //     (Claude bad JSON, scene summarizer crash, image fetch timeout
  //     mid-generation, etc.). Just flipping status to "generated" would
  //     fail again at publishGeneratedPost's "Missing title or body" guard.
  //     Re-run generateBlogPost with the original topic + keywords so the
  //     content actually gets produced this time.
  //
  //   Case B — content exists, publish failed: classic publish-side retry.
  //     Flip status back to "generated" and let publishGeneratedPost do
  //     its thing.
  const [post] = await db
    .select({
      id: generatedPosts.id,
      blogId: generatedPosts.blogId,
      topic: generatedPosts.topic,
      keywords: generatedPosts.keywords,
      title: generatedPosts.title,
      body: generatedPosts.body,
      status: generatedPosts.status,
    })
    .from(generatedPosts)
    .where(eq(generatedPosts.id, generatedPostId));

  if (!post) {
    return { success: false, message: "Generated post not found" };
  }

  // Case A: re-run the full generation pipeline with the saved topic.
  if (!post.title || !post.body) {
    const savedKeywords = Array.isArray(post.keywords)
      ? post.keywords.filter(
          (k): k is string => typeof k === "string" && k.trim().length > 0,
        )
      : [];

    // Remove the stale placeholder row so generateBlogPost can insert a
    // fresh "generating" row without duplicate-topic clutter in the UI.
    await db
      .delete(generatedPosts)
      .where(eq(generatedPosts.id, generatedPostId));

    revalidatePath(`/blogs/${post.blogId}/posts`);

    const regen = await generateBlogPost({
      blogId: post.blogId,
      topic: post.topic ?? undefined,
      keywords: savedKeywords,
      autoPublish: true,
    });

    if (!regen.success) {
      return { success: false, message: regen.message };
    }

    // generateBlogPost(autoPublish=true) returns the nested publishResult.
    // Surface it so the caller still sees the real publish outcome.
    return (
      regen.publishResult ?? {
        success: true,
        message: "Regenerated successfully (publish pending)",
      }
    );
  }

  // Case B: content exists, just publish-side retry.
  await db
    .update(generatedPosts)
    .set({
      status: "generated",
      failureReason: null,
      updatedAt: new Date(),
    })
    .where(eq(generatedPosts.id, generatedPostId));

  return publishGeneratedPost(generatedPostId);
}

/**
 * Regenerate a published post in place and update the live external post,
 * so it picks up the latest generator improvements. Thin wrapper that maps
 * thrown errors to a result the UI can toast.
 */
export async function regenerateBlogPost(
  generatedPostId: string,
): Promise<{ success: boolean; message: string }> {
  try {
    const r = await regenerateAndUpdatePost(generatedPostId);
    // The live page changed in place — re-audit it. Fire-and-forget.
    if (r.success) {
      scanPostAfterPublishFireAndForget(generatedPostId);
      // Body changed → re-embed and refresh related links.
      relinkAfterPublishFireAndForget(generatedPostId);
    }
    return { success: r.success, message: r.message };
  } catch (e) {
    return {
      success: false,
      message: e instanceof Error ? e.message : "Regenerate failed",
    };
  }
}

// ─── Import Blogs from CSV (batched) ────────────────────────────────────────

export async function importBlogsFromCsv(
  clientId: string,
  csvContent: string,
): Promise<CsvImportResult> {
  await requireAdmin();

  const { valid, errors: parseErrors } = parseBlogCsv(csvContent, clientId);

  const result: CsvImportResult = {
    totalRows: valid.length + parseErrors.length,
    successCount: 0,
    failedCount: parseErrors.length,
    errors: parseErrors.map((e) => ({
      row: e.row,
      field: e.field,
      message: e.message,
    })),
  };

  if (valid.length === 0) {
    return result;
  }

  // Normalize domains for comparison
  const normalized = valid.map((row, idx) => ({
    ...row,
    domain: row.domain.trim().toLowerCase(),
    _rowIndex: idx + 2, // +2 for header + 1-index
  }));

  // 1. Detect duplicates within the CSV itself
  const seenInCsv = new Map<string, number>();
  const dedupedRows: typeof normalized = [];
  for (const row of normalized) {
    const firstSeenAt = seenInCsv.get(row.domain);
    if (firstSeenAt !== undefined) {
      result.failedCount++;
      result.errors.push({
        row: row._rowIndex,
        field: "domain",
        message: `Duplicate domain in CSV (also on row ${firstSeenAt}): ${row.domain}`,
      });
      continue;
    }
    seenInCsv.set(row.domain, row._rowIndex);
    dedupedRows.push(row);
  }

  if (dedupedRows.length === 0) {
    result.totalRows = result.successCount + result.failedCount;
    return result;
  }

  // 2. One round trip to find existing domains
  const existing = await db
    .select({ domain: blogs.domain })
    .from(blogs)
    .where(
      inArray(
        blogs.domain,
        dedupedRows.map((r) => r.domain),
      ),
    );

  const existingSet = new Set(existing.map((r) => r.domain));

  const toInsert: typeof dedupedRows = [];
  for (const row of dedupedRows) {
    if (existingSet.has(row.domain)) {
      result.failedCount++;
      result.errors.push({
        row: row._rowIndex,
        field: "domain",
        message: `Domain already exists: ${row.domain}`,
      });
      continue;
    }
    toInsert.push(row);
  }

  // 3. Bulk insert in a single round trip (chunked to stay under param limits)
  if (toInsert.length > 0) {
    const CHUNK_SIZE = 500;
    for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
      const chunk = toInsert.slice(i, i + CHUNK_SIZE);
      try {
        const inserted = await db
          .insert(blogs)
          .values(
            chunk.map((row) => ({
              clientId: row.clientId,
              domain: row.domain,
              wpUrl: row.wpUrl,
              wpUsername: row.wpUsername,
              wpAppPassword: row.wpAppPassword,
              seoPlugin: row.seoPlugin,
              postingFrequency: row.postingFrequency,
              status: "setup" as const,
            })),
          )
          .returning({ id: blogs.id });

        result.successCount += inserted.length;
      } catch (err) {
        // Bulk insert failed — fall back to row-by-row for this chunk only,
        // so we can report which specific rows broke.
        console.error("Bulk insert chunk failed, falling back per-row:", err);
        for (const row of chunk) {
          try {
            await db.insert(blogs).values({
              clientId: row.clientId,
              domain: row.domain,
              wpUrl: row.wpUrl,
              wpUsername: row.wpUsername,
              wpAppPassword: row.wpAppPassword,
              seoPlugin: row.seoPlugin,
              postingFrequency: row.postingFrequency,
              status: "setup",
            });
            result.successCount++;
          } catch (rowErr) {
            result.failedCount++;
            result.errors.push({
              row: row._rowIndex,
              field: "insert",
              message:
                rowErr instanceof Error
                  ? rowErr.message
                  : "Database insert failed",
            });
          }
        }
      }
    }
  }

  result.totalRows = result.successCount + result.failedCount;

  if (result.successCount > 0) {
    revalidatePath("/blogs");
  }

  return result;
}

// ─── Get All Clients (for selectors) ────────────────────────────────────────

export async function getClientsForSelect() {
  await requireAdmin();

  const rows = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .orderBy(asc(clients.name));

  return rows;
}

// ─── Posts: live (WordPress REST) + generated (our DB) ──────────────────────

export interface BlogGeneratedPostRow {
  id: string;
  topic: string;
  title: string | null;
  status: string;
  wordCount: number | null;
  seoScore: number | null;
  featuredImageUrl: string | null;
  externalPostId: string | null;
  externalPostUrl: string | null;
  failureReason: string | null;
  isAutoGenerated: boolean | null;
  generatedAt: Date | null;
  publishedAt: Date | null;
  createdAt: Date;
}

export interface BlogLivePostRow {
  id: number;
  title: string;
  excerpt: string;
  status: string;
  link: string;
  date: string;
  modified: string;
}

export interface BlogPostsResult {
  generated: BlogGeneratedPostRow[];
  live: {
    available: boolean;
    platform: string;
    posts: BlogLivePostRow[];
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
    error?: string;
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export async function getBlogPosts(
  blogId: string,
  options: { livePage?: number; livePerPage?: number } = {},
): Promise<BlogPostsResult> {
  await requireAdmin();

  const { livePage = 1, livePerPage = 20 } = options;

  const [blog] = await db
    .select({
      platform: blogs.platform,
      // WordPress
      wpUrl: blogs.wpUrl,
      wpUsername: blogs.wpUsername,
      wpAppPassword: blogs.wpAppPassword,
      // Shopify (both auth modes)
      shopifyAuthMode: blogs.shopifyAuthMode,
      shopifyStoreUrl: blogs.shopifyStoreUrl,
      shopifyAdminApiToken: blogs.shopifyAdminApiToken,
      shopifyClientId: blogs.shopifyClientId,
      shopifyClientSecret: blogs.shopifyClientSecret,
    })
    .from(blogs)
    .where(eq(blogs.id, blogId))
    .limit(1);

  if (!blog) throw new Error("Blog not found");

  const generatedRows = await db
    .select({
      id: generatedPosts.id,
      topic: generatedPosts.topic,
      title: generatedPosts.title,
      status: generatedPosts.status,
      wordCount: generatedPosts.wordCount,
      seoScore: generatedPosts.seoScore,
      featuredImageUrl: generatedPosts.featuredImageUrl,
      externalPostId: generatedPosts.externalPostId,
      externalPostUrl: generatedPosts.externalPostUrl,
      failureReason: generatedPosts.failureReason,
      isAutoGenerated: generatedPosts.isAutoGenerated,
      generatedAt: generatedPosts.generatedAt,
      publishedAt: generatedPosts.publishedAt,
      createdAt: generatedPosts.createdAt,
    })
    .from(generatedPosts)
    .where(eq(generatedPosts.blogId, blogId))
    .orderBy(desc(generatedPosts.createdAt))
    .limit(50);

  const live: BlogPostsResult["live"] = {
    available: false,
    platform: blog.platform,
    posts: [],
    page: livePage,
    perPage: livePerPage,
    total: 0,
    totalPages: 0,
  };

  if (
    blog.platform === "wordpress" &&
    blog.wpUrl &&
    blog.wpUsername &&
    blog.wpAppPassword
  ) {
    try {
      const result = await wp.fetchPosts(
        blog.wpUrl,
        blog.wpUsername,
        blog.wpAppPassword,
        {
          page: livePage,
          perPage: livePerPage,
          statuses: ["publish", "future", "draft", "pending", "private"],
        },
      );
      live.available = true;
      live.total = result.total;
      live.totalPages = result.totalPages;
      live.posts = result.posts.map((p) => ({
        id: p.id,
        title: stripHtml(p.title?.rendered ?? ""),
        excerpt: stripHtml(p.excerpt?.rendered ?? "").slice(0, 240),
        status: p.status,
        link: p.link,
        date: p.date,
        modified: p.modified,
      }));
    } catch (err) {
      live.error =
        err instanceof Error ? err.message : "Failed to fetch WordPress posts";
    }
  } else if (blog.platform === "wordpress") {
    live.error = "WordPress credentials not configured";
  } else if (blog.platform === "shopify") {
    // Build creds for either auth mode and fetch every live article.
    // Shopify's REST API doesn't paginate by page-number, so we pull
    // everything once and slice client-side. Cheap for typical blog sizes.
    const mode = blog.shopifyAuthMode ?? "client_credentials";
    let creds: ShopifyCreds | null = null;

    if (!blog.shopifyStoreUrl) {
      live.error = "Shopify store URL not configured";
    } else if (mode === "legacy_token") {
      if (!blog.shopifyAdminApiToken) {
        live.error = "Shopify Admin API token not configured";
      } else {
        creds = {
          mode: "legacy_token",
          storeUrl: blog.shopifyStoreUrl,
          adminToken: blog.shopifyAdminApiToken,
        };
      }
    } else {
      if (!blog.shopifyClientId || !blog.shopifyClientSecret) {
        live.error = "Shopify Client ID and Client Secret not configured";
      } else {
        creds = {
          mode: "client_credentials",
          storeUrl: blog.shopifyStoreUrl,
          clientId: blog.shopifyClientId,
          clientSecret: blog.shopifyClientSecret,
        };
      }
    }

    if (creds) {
      try {
        const articles = await shopifyFetchAllLive(creds);

          const storeHost = (blog.shopifyStoreUrl ?? "")
          .trim()
          .replace(/^https?:\/\//i, "")
          .replace(/\/+$/, "");

        const all = articles.map((a) => ({
          id: a.id,
          title: a.title,
          excerpt: stripHtml(a.summary_html || a.body_html || "").slice(0, 240),
          status: a.published_at ? "publish" : "draft",
          link: storeHost
            ? `https://${storeHost}/blogs/${a.blog_id}/${a.handle}`
            : "",
          date: a.published_at ?? a.created_at,
          modified: a.updated_at,
        }));

        live.available = true;
        live.total = all.length;
        live.totalPages = Math.max(1, Math.ceil(all.length / livePerPage));
        const start = (livePage - 1) * livePerPage;
        live.posts = all.slice(start, start + livePerPage);
      } catch (err) {
        live.error =
          err instanceof Error ? err.message : "Failed to fetch Shopify posts";
      }
    }
  } else {
    live.error = `Live post management is not yet supported on ${blog.platform}`;
  }

  return { generated: generatedRows, live };
}

export interface GeneratedPostContent {
  id: string;
  topic: string;
  title: string | null;
  body: string | null;
  excerpt: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  keywords: string[];
  featuredImageUrl: string | null;
  wordCount: number | null;
  seoScore: number | null;
  status: string;
  externalPostUrl: string | null;
  failureReason: string | null;
  createdAt: Date;
  publishedAt: Date | null;
}

export async function getGeneratedPostContent(
  postId: string,
): Promise<GeneratedPostContent | { error: string }> {
  await requireAdmin();

  const [row] = await db
    .select({
      id: generatedPosts.id,
      topic: generatedPosts.topic,
      title: generatedPosts.title,
      body: generatedPosts.body,
      excerpt: generatedPosts.excerpt,
      metaTitle: generatedPosts.metaTitle,
      metaDescription: generatedPosts.metaDescription,
      keywords: generatedPosts.keywords,
      featuredImageUrl: generatedPosts.featuredImageUrl,
      wordCount: generatedPosts.wordCount,
      seoScore: generatedPosts.seoScore,
      status: generatedPosts.status,
      externalPostUrl: generatedPosts.externalPostUrl,
      failureReason: generatedPosts.failureReason,
      createdAt: generatedPosts.createdAt,
      publishedAt: generatedPosts.publishedAt,
    })
    .from(generatedPosts)
    .where(eq(generatedPosts.id, postId))
    .limit(1);

  if (!row) return { error: "Post not found" };

  return {
    ...row,
    keywords: Array.isArray(row.keywords)
      ? (row.keywords as unknown[]).map((k) => String(k))
      : [],
  };
}

/**
 * Edit a generated post that hasn't been published yet. Updates the stored
 * title/body/excerpt/meta/keywords on the row so the next publish (whether
 * triggered by the cron or by the user clicking Publish) uses the edited
 * content. Recomputes wordCount from the new body.
 *
 * Refuses to edit posts in transient states (`generating`, `publishing`)
 * or already-published rows — editing a published post here wouldn't
 * affect the live site, which would be misleading.
 */
export async function updateGeneratedPostContent(
  postId: string,
  data: {
    title?: string;
    body?: string;
    excerpt?: string;
    metaTitle?: string;
    metaDescription?: string;
    keywords?: string[];
  },
): Promise<{ success: boolean; message: string }> {
  await requireAdmin();

  const [post] = await db
    .select({
      id: generatedPosts.id,
      blogId: generatedPosts.blogId,
      status: generatedPosts.status,
    })
    .from(generatedPosts)
    .where(eq(generatedPosts.id, postId))
    .limit(1);

  if (!post) return { success: false, message: "Generated post not found" };

  if (post.status === "publishing" || post.status === "generating") {
    return {
      success: false,
      message: `Post is currently ${post.status} — wait for it to finish before editing`,
    };
  }

  if (post.status === "published") {
    return {
      success: false,
      message:
        "Post is already published — edit the live version from the Live tab instead",
    };
  }

  const update: Record<string, unknown> = { updatedAt: new Date() };

  if (data.title !== undefined) update.title = data.title.trim() || null;
  if (data.body !== undefined) {
    const body = data.body;
    update.body = body;
    // Recompute word count from the new body so the table reflects reality.
    const text = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    update.wordCount = text
      ? text.split(" ").filter((w) => w.length > 0).length
      : 0;
  }
  if (data.excerpt !== undefined) update.excerpt = data.excerpt.trim() || null;
  if (data.metaTitle !== undefined)
    update.metaTitle = data.metaTitle.trim() || null;
  if (data.metaDescription !== undefined)
    update.metaDescription = data.metaDescription.trim() || null;
  if (data.keywords !== undefined) {
    const cleaned = data.keywords
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    update.keywords = cleaned.length > 0 ? cleaned : null;
  }

  await db
    .update(generatedPosts)
    .set(update)
    .where(eq(generatedPosts.id, postId));

  revalidatePath(`/blogs/${post.blogId}/posts`);
  revalidatePath(`/blogs/${post.blogId}`);

  return { success: true, message: "Generated post updated" };
}

export async function editBlogLivePost(
  blogId: string,
  postId: number,
  data: {
    title?: string;
    content?: string;
    excerpt?: string;
    status?: "publish" | "draft" | "pending" | "private";
  },
): Promise<{ success: boolean; message: string }> {
  await requireAdmin();

  const [blog] = await db
    .select({
      platform: blogs.platform,
      wpUrl: blogs.wpUrl,
      wpUsername: blogs.wpUsername,
      wpAppPassword: blogs.wpAppPassword,
    })
    .from(blogs)
    .where(eq(blogs.id, blogId))
    .limit(1);

  if (!blog) return { success: false, message: "Blog not found" };
  if (blog.platform !== "wordpress") {
    return {
      success: false,
      message: `Editing not supported on ${blog.platform} yet`,
    };
  }
  if (!blog.wpUrl || !blog.wpUsername || !blog.wpAppPassword) {
    return { success: false, message: "WordPress credentials not configured" };
  }

  try {
    await wp.updatePost(
      blog.wpUrl,
      blog.wpUsername,
      blog.wpAppPassword,
      postId,
      data,
    );
    revalidatePath(`/blogs/${blogId}`);
    return { success: true, message: "Post updated" };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : "Update failed",
    };
  }
}

export async function deleteBlogLivePost(
  blogId: string,
  postId: number,
  force: boolean = false,
): Promise<{ success: boolean; message: string }> {
  await requireAdmin();

  const [blog] = await db
    .select()
    .from(blogs)
    .where(eq(blogs.id, blogId))
    .limit(1);

  if (!blog) return { success: false, message: "Blog not found" };

  // Shopify: articles are deleted via the Admin API (no trash — always
  // permanent). postId is the live article id from the "Live on shopify" tab.
  if (blog.platform === "shopify") {
    const platformBlog: PlatformBlog = {
      platform: blog.platform,
      wpUrl: blog.wpUrl,
      wpUsername: blog.wpUsername,
      wpAppPassword: blog.wpAppPassword,
      seoPlugin: blog.seoPlugin,
      shopifyAuthMode: blog.shopifyAuthMode,
      shopifyStoreUrl: blog.shopifyStoreUrl,
      shopifyAdminApiToken: blog.shopifyAdminApiToken,
      shopifyClientId: blog.shopifyClientId,
      shopifyClientSecret: blog.shopifyClientSecret,
      shopifyBlogHandle: blog.shopifyBlogHandle,
    };
    const res = await deletePublishedPost(platformBlog, String(postId));
    if (!res.deleted) {
      return { success: false, message: res.message ?? "Delete failed" };
    }
    revalidatePath(`/blogs/${blogId}`);
    return { success: true, message: "Article deleted" };
  }

  if (blog.platform !== "wordpress") {
    return {
      success: false,
      message: `Deletion not supported on ${blog.platform} yet`,
    };
  }
  if (!blog.wpUrl || !blog.wpUsername || !blog.wpAppPassword) {
    return { success: false, message: "WordPress credentials not configured" };
  }

  try {
    const result = await wp.deletePost(
      blog.wpUrl,
      blog.wpUsername,
      blog.wpAppPassword,
      postId,
      force,
    );
    revalidatePath(`/blogs/${blogId}`);
    return {
      success: true,
      message: result.permanently
        ? "Post permanently deleted"
        : "Post moved to trash",
    };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : "Delete failed",
    };
  }
}

/**
 * Delete a GENERATED post (the "Generated" tab). Always removes the app's
 * generated_posts row. When the post is published and `deleteLive` is set, the
 * live post is also deleted from the destination site first (full teardown, the
 * same behaviour as the Live tab's delete) — if that live delete fails we abort
 * and keep the row so nothing is silently orphaned. Drafts/failed/pending rows
 * (no live post) just drop the row.
 */
export async function deleteGeneratedPost(
  generatedPostId: string,
  deleteLive: boolean = true,
): Promise<{ success: boolean; message: string }> {
  await requireAdmin();

  const [post] = await db
    .select({
      id: generatedPosts.id,
      blogId: generatedPosts.blogId,
      status: generatedPosts.status,
      externalPostId: generatedPosts.externalPostId,
    })
    .from(generatedPosts)
    .where(eq(generatedPosts.id, generatedPostId))
    .limit(1);

  if (!post) return { success: false, message: "Generated post not found" };

  const hasLivePost =
    post.status === "published" && Boolean(post.externalPostId);

  if (hasLivePost && deleteLive) {
    const [blog] = await db
      .select()
      .from(blogs)
      .where(eq(blogs.id, post.blogId))
      .limit(1);
    if (!blog) return { success: false, message: "Blog not found" };

    const platformBlog: PlatformBlog = {
      platform: blog.platform,
      wpUrl: blog.wpUrl,
      wpUsername: blog.wpUsername,
      wpAppPassword: blog.wpAppPassword,
      seoPlugin: blog.seoPlugin,
      shopifyAuthMode: blog.shopifyAuthMode,
      shopifyStoreUrl: blog.shopifyStoreUrl,
      shopifyAdminApiToken: blog.shopifyAdminApiToken,
      shopifyClientId: blog.shopifyClientId,
      shopifyClientSecret: blog.shopifyClientSecret,
      shopifyBlogHandle: blog.shopifyBlogHandle,
    };
    const res = await deletePublishedPost(
      platformBlog,
      String(post.externalPostId),
    );
    if (!res.deleted) {
      return {
        success: false,
        message: `Live post not deleted (${res.message ?? "unknown error"}) — kept the record so you can retry`,
      };
    }
  }

  await db.delete(generatedPosts).where(eq(generatedPosts.id, generatedPostId));
  revalidatePath(`/blogs/${post.blogId}`);
  return {
    success: true,
    message:
      hasLivePost && deleteLive
        ? "Post deleted from the app and the live site"
        : "Post deleted",
  };
}

/**
 * Batch-delete GENERATED posts (the "Generated" tab). Each row goes through
 * {@link deleteGeneratedPost} so published rows tear down their live copy first
 * when `deleteLive` is set; a live-delete failure keeps that one row and is
 * counted rather than aborting the batch.
 */
export async function deleteGeneratedPosts(
  ids: string[],
  deleteLive: boolean = true,
): Promise<{ success: boolean; deleted: number; failed: number; message: string }> {
  await requireAdmin();
  let deleted = 0;
  let failed = 0;
  for (const id of ids) {
    const res = await deleteGeneratedPost(id, deleteLive);
    if (res.success) deleted += 1;
    else failed += 1;
  }
  return {
    success: failed === 0,
    deleted,
    failed,
    message:
      `Deleted ${deleted} post${deleted === 1 ? "" : "s"}` +
      (failed > 0 ? ` · ${failed} kept (live delete failed)` : ""),
  };
}

/**
 * Batch-delete LIVE posts (the "Live" tab). Each id is removed from the
 * destination site through {@link deleteBlogLivePost}; failures are counted.
 */
export async function deleteBlogLivePosts(
  blogId: string,
  postIds: number[],
  force: boolean = false,
): Promise<{ success: boolean; deleted: number; failed: number; message: string }> {
  await requireAdmin();
  let deleted = 0;
  let failed = 0;
  for (const postId of postIds) {
    const res = await deleteBlogLivePost(blogId, postId, force);
    if (res.success) deleted += 1;
    else failed += 1;
  }
  revalidatePath(`/blogs/${blogId}`);
  return {
    success: failed === 0,
    deleted,
    failed,
    message:
      `Deleted ${deleted} post${deleted === 1 ? "" : "s"}` +
      (failed > 0 ? ` · ${failed} failed` : ""),
  };
}
