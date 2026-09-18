import { notFound } from "next/navigation";
import Link from "next/link";
import { getBlog, getClientsForSelect } from "@/lib/actions/blog-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { CredentialDisplay } from "@/components/blogs/credential-display";
import { WpConnectionTest } from "@/components/blogs/wp-connection-test";
import { ThemeSeoButton } from "@/components/blogs/theme-seo-button";
import { WpHomepageTrackerButton } from "@/components/blogs/wp-homepage-tracker-button";
import { TrackingBackfillButton } from "@/components/blogs/tracking-backfill-button";
import { BlogForm } from "@/components/blogs/blog-form";
import { PersonaCard } from "@/components/content/persona-card";
import type { GeneratedPersona } from "@/lib/content/types";
import { StyleProfilePanel } from "@/components/blogs/style-profile-panel";
import { getStyleProfileForBlog } from "@/lib/actions/style-profile-actions";
import {
  formatPostingPlan,
  normalizePostingPlan,
  planToFormValues,
} from "@/lib/posting-plan";
import {
  ArrowLeft,
  Pencil,
  Globe,
  ShieldCheck,
  Calendar,
  FileText,
  BarChart3,
  ShoppingBag,
  Newspaper,
  History,
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────────────

interface BlogDetailPageProps {
  params: { blogId: string };
  searchParams: {
    edit?: string;
  };
}

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  paused: "secondary",
  setup: "outline",
  decommissioned: "destructive",
};

function formatDate(value: string | Date | null): string {
  if (!value) return "--";
  const d = typeof value === "string" ? new Date(value) : value;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="space-y-0.5">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <p className="text-sm">{value || "--"}</p>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default async function BlogDetailPage({
  params,
  searchParams,
}: BlogDetailPageProps) {
  const blog = await getBlog(params.blogId);

  if ("error" in blog) {
    notFound();
  }

  const isEditMode = searchParams.edit === "true";

  // In edit mode, show form
  if (isEditMode) {
    const clients = await getClientsForSelect();
    return (
      <div className="space-y-6 max-w-3xl">
        <div className="flex items-center gap-3">
          <Link href={`/blogs/${params.blogId}`}>
            <Button variant="ghost" size="sm">
              <ArrowLeft className="size-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Edit {blog.domain}</h1>
            <p className="text-muted-foreground">Update blog configuration</p>
          </div>
        </div>

        <BlogForm
          mode="edit"
          blogId={params.blogId}
          clients={clients}
          defaultValues={{
            clientId: blog.clientId,
            domain: blog.domain,
            platform: (blog.platform as "wordpress" | "shopify") || "wordpress",
            // WordPress
            wpUrl: blog.wpUrl || "",
            wpUsername: blog.wpUsername || "",
            wpAppPassword: blog.wpAppPassword || "",
            seoPlugin: (blog.seoPlugin as "yoast" | "rankmath" | "none") || "none",
            // Shopify (Dev Dashboard / client_credentials)
            shopifyStoreUrl: blog.shopifyStoreUrl || "",
            shopifyClientId: blog.shopifyClientId || "",
            shopifyClientSecret: blog.shopifyClientSecret || "",
            // Posting cadence + status
            postingDays: planToFormValues(normalizePostingPlan(blog.postingPlan)).days,
            postsPerDay: planToFormValues(normalizePostingPlan(blog.postingPlan))
              .postsPerDay,
            status: (blog.status as "active" | "paused" | "setup" | "decommissioned") || "active",
            notesInternal: blog.notesInternal || "",
            // Local keyword-targeted content
            city: blog.city || "",
            region: blog.region || "",
            countryCode: blog.countryCode || "",
            brandName: blog.brandName || "",
          }}
        />
      </div>
    );
  }

  // Style profile (peptide blogs only — returns null otherwise).
  const styleProfile = await getStyleProfileForBlog(params.blogId).catch(() => null);

  const isShopify = blog.platform === "shopify";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-3">
          <Link href={`/clients/${blog.clientId}/blogs`}>
            <Button variant="ghost" size="sm">
              <ArrowLeft className="size-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">{blog.domain}</h1>
              <Badge variant={STATUS_VARIANTS[blog.status ?? "setup"] ?? "outline"}>
                {blog.status ?? "setup"}
              </Badge>
              <Badge variant="outline" className="capitalize">
                {blog.platform}
              </Badge>
            </div>
            <p className="text-muted-foreground">
              Client: {blog.clientName}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <WpConnectionTest blogId={params.blogId} />
          <Link href={`/blogs/${params.blogId}/posts`}>
            <Button variant="outline">
              <Newspaper className="size-4" data-icon="inline-start" />
              View Posts
            </Button>
          </Link>
          <Link href={`/blogs/${params.blogId}?edit=true`}>
            <Button variant="outline">
              <Pencil className="size-4" data-icon="inline-start" />
              Edit
            </Button>
          </Link>
        </div>
      </div>

      <PersonaCard
        blogId={params.blogId}
        initialPersona={
          (styleProfile?.generatedPersona as GeneratedPersona | null) ?? null
        }
        initialSeed={styleProfile?.generatedPersonaSeed ?? null}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Identity */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="size-4" />
              Identity
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <InfoRow label="Domain" value={blog.domain} />
            <InfoRow label="Platform" value={blog.platform} />
            {isShopify ? (
              <>
                <InfoRow label="Shopify Store URL" value={blog.shopifyStoreUrl} />
              </>
            ) : (
              <>
                <InfoRow label="WordPress URL" value={blog.wpUrl} />
                <InfoRow label="SEO Plugin" value={blog.seoPlugin} />
              </>
            )}
            <InfoRow label="Status" value={blog.status} />
          </CardContent>
        </Card>

        {/* Credentials (platform-aware) */}
        {isShopify ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShoppingBag className="size-4" />
                Shopify Credentials
              </CardTitle>
              <CardDescription>
                Dev Dashboard auth — Client ID + Client Secret from your
                Shopify custom app.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <InfoRow label="Store URL" value={blog.shopifyStoreUrl} />
              <InfoRow label="Client ID" value={blog.shopifyClientId} />
              <CredentialDisplay
                label="Client Secret"
                value={blog.shopifyClientSecret}
              />
            </CardContent>
          </Card>
        ) : null}

        {/* Theme SEO (Shopify only) */}
        {isShopify ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShoppingBag className="size-4" />
                Theme SEO
              </CardTitle>
              <CardDescription>
                Push the OG article tags + JSON-LD schema into this store&apos;s
                published theme. Requires the app&apos;s read_themes /
                write_themes scopes.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ThemeSeoButton blogId={params.blogId} />
            </CardContent>
          </Card>
        ) : null}

        {!isShopify ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="size-4" />
                WordPress Credentials
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <CredentialDisplay label="Username" value={blog.wpUsername} />
              <CredentialDisplay label="Application Password" value={blog.wpAppPassword} />
            </CardContent>
          </Card>
        ) : null}

        {!isShopify ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="size-4" />
                Homepage tracking
              </CardTitle>
              <CardDescription>
                Count visitors who land on the site&apos;s homepage without
                opening a blog post. Requires a static-page homepage.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <WpHomepageTrackerButton blogId={params.blogId} />
            </CardContent>
          </Card>
        ) : null}

        {/* Backfill tracking into already-published posts (both platforms) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History className="size-4" />
              Backfill post tracking
            </CardTitle>
            <CardDescription>
              Add the tracked CTA + page-view pixel to posts published before
              tracking existed, so their traffic starts counting.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TrackingBackfillButton blogId={params.blogId} />
          </CardContent>
        </Card>

        {/* Posting Config */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="size-4" />
              Posting Configuration
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <InfoRow
              label="Posting schedule"
              value={formatPostingPlan(normalizePostingPlan(blog.postingPlan))}
            />
            <InfoRow
              label="Last Post Verified"
              value={formatDate(blog.lastPostVerifiedAt)}
            />
            <InfoRow label="Last Post Title" value={blog.lastPostTitle} />
          </CardContent>
        </Card>

        {/* SEO Snapshot */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="size-4" />
              SEO Snapshot
            </CardTitle>
            <CardDescription>Latest SEO scan results</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <InfoRow
              label="Current Score"
              value={
                blog.currentSeoScore !== null
                  ? `${blog.currentSeoScore}/100`
                  : null
              }
            />
            <InfoRow
              label="Last Scan"
              value={formatDate(blog.lastSeoScanAt)}
            />
          </CardContent>
        </Card>

        {/* Notes */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="size-4" />
              Internal Notes
            </CardTitle>
          </CardHeader>
          <CardContent>
            {blog.notesInternal ? (
              <p className="text-sm whitespace-pre-wrap">{blog.notesInternal}</p>
            ) : (
              <p className="text-sm text-muted-foreground">No notes</p>
            )}
          </CardContent>
        </Card>

        {/* Style profile (peptide blogs only) */}
        {styleProfile && <StyleProfilePanel profile={styleProfile} />}
      </div>

     
    </div>
  );
}