"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Eye,
  ExternalLink,
  Gauge,
  Loader2,
  Pencil,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  deleteBlogLivePost,
  deleteBlogLivePosts,
  deleteGeneratedPost,
  deleteGeneratedPosts,
  editBlogLivePost,
  getGeneratedPostContent,
  publishGeneratedPost,
  retryGeneratedPost,
  regenerateBlogPost,
  updateGeneratedPostContent,
  type BlogGeneratedPostRow,
  type BlogLivePostRow,
  type GeneratedPostContent,
} from "@/lib/actions/blog-actions";
import { scanGeneratedPost } from "@/lib/actions/post-seo-actions";
import { BulkDeleteBar } from "@/components/ui/bulk-delete-bar";
import { useRowSelection } from "@/lib/hooks/use-row-selection";
import { GeneratePostButton } from "./generate-post-button";
import { ArticlePreviewHtml } from "./article-preview-html";

// ─── Helpers ────────────────────────────────────────────────────────────────

const GENERATED_STATUS_VARIANTS: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "outline",
  generating: "secondary",
  generated: "secondary",
  publishing: "secondary",
  published: "default",
  failed: "destructive",
};

const LIVE_STATUS_VARIANTS: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  publish: "default",
  draft: "outline",
  pending: "secondary",
  private: "secondary",
  future: "secondary",
  trash: "destructive",
};

// Data-URI `<img>` tags embedded in generated post bodies (the body image
// from Nano Banana lives inline as base64) make the edit textarea
// unreadable — a single tag can be hundreds of KB of `src="data:..."`
// characters. We swap each tag for a short `[[IMAGE_N]]` marker while
// editing and restore the original tags on save. If the user deletes the
// marker, the image is dropped from the saved body — that's intentional.
const DATA_URI_IMG_RE =
  /<img\b[^>]*src=["']data:image\/[^"']+["'][^>]*\/?>/gi;
const IMAGE_MARKER_RE = /\[\[IMAGE_(\d+)\]\]/g;

function extractDataUriImages(html: string): {
  text: string;
  images: string[];
} {
  const images: string[] = [];
  const text = html.replace(DATA_URI_IMG_RE, (match) => {
    images.push(match);
    return `[[IMAGE_${images.length}]]`;
  });
  return { text, images };
}

function restoreDataUriImages(text: string, images: string[]): string {
  return text.replace(IMAGE_MARKER_RE, (_full, n) => {
    const idx = parseInt(n, 10) - 1;
    return images[idx] ?? "";
  });
}

function extractImgSrcFromTag(tag: string): string | null {
  const m = tag.match(/src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function extractImgAltFromTag(tag: string): string {
  const m = tag.match(/alt=["']([^"']*)["']/i);
  return m ? m[1] : "";
}

function formatDateTime(
  value: string | Date | null | undefined,
): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Per-row actions for the Generated tab ──────────────────────────────────

function GeneratedRowActions({
  row,
  onView,
  onEdit,
  onDelete,
  viewLoadingId,
  editLoadingId,
}: {
  row: BlogGeneratedPostRow;
  onView: (row: BlogGeneratedPostRow) => void;
  onEdit: (row: BlogGeneratedPostRow) => void;
  onDelete: (row: BlogGeneratedPostRow) => void;
  // ID of the row whose body is currently being fetched (if any) — lets
  // this specific eye button show a spinner instead of the icon.
  viewLoadingId: string | null;
  editLoadingId: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const isPublished = row.status === "published";
  const isFailed = row.status === "failed";
  const isInFlight =
    row.status === "publishing" || row.status === "generating";
  const canPublish = row.status === "generated" || row.status === "pending";
  // Body only exists once Claude has finished generating. Pending and
  // in-flight rows have nothing to show yet.
  const canView =
    row.status !== "pending" && row.status !== "generating";
  // Editing only makes sense for content that's ready to publish but
  // hasn't gone live. Published rows can be edited from the Live tab;
  // in-flight rows must wait.
  const canEdit = row.status === "generated" || row.status === "failed";
  // Regenerate is only meaningful once a post is live — it rewrites the
  // article (picking up the latest generator improvements) and updates the
  // SAME external post in place.
  const canRegenerate = isPublished && !!row.externalPostId;
  const viewPending = viewLoadingId === row.id;
  const editPending = editLoadingId === row.id;

  const handlePublish = () => {
    start(async () => {
      const t = toast.loading(isFailed ? "Retrying…" : "Publishing…");
      const res = isFailed
        ? await retryGeneratedPost(row.id)
        : await publishGeneratedPost(row.id);

      if (res.success) toast.success(res.message, { id: t });
      else toast.error(res.message, { id: t });

      router.refresh();
    });
  };

  const handleRegenerate = () => {
    if (
      !window.confirm(
        "Regenerate this post and update the live page (same URL)? The current content will be replaced.",
      )
    ) {
      return;
    }
    start(async () => {
      const t = toast.loading("Regenerating…", {
        description: "Rewriting the article and updating the live post.",
      });
      const res = await regenerateBlogPost(row.id);
      if (res.success) toast.success(res.message, { id: t });
      else toast.error(res.message, { id: t });
      router.refresh();
    });
  };

  const handleScanSeo = () => {
    start(async () => {
      const t = toast.loading("Scanning SEO…", {
        description: "Auditing this post's meta, headings and images.",
      });
      const res = await scanGeneratedPost(row.id);
      if (res.success) {
        toast.success(res.message, {
          id: t,
          description:
            res.metaSource === "stored"
              ? "Live page wasn't reachable — scanned the stored content."
              : undefined,
        });
      } else {
        toast.error(res.message, { id: t });
      }
      router.refresh();
    });
  };

  return (
    <div className="flex items-center justify-end gap-1">
      {canView && (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onView(row)}
          disabled={viewPending}
          title="View generated content"
        >
          {viewPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Eye className="size-4" />
          )}
        </Button>
      )}

      {canEdit && (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onEdit(row)}
          disabled={editPending}
          title="Edit generated content"
        >
          {editPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Pencil className="size-4" />
          )}
        </Button>
      )}

      {(canPublish || isFailed) && (
        <Button
          size="sm"
          variant={isFailed ? "outline" : "default"}
          onClick={handlePublish}
          disabled={pending}
          title={isFailed ? "Retry publish" : "Publish to live"}
        >
          {pending ? (
            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
          ) : (
            <Send className="mr-1.5 size-3.5" />
          )}
          {isFailed ? "Retry" : "Publish"}
        </Button>
      )}

      {isInFlight && !pending && (
        <Button size="sm" variant="outline" disabled>
          <Loader2 className="mr-1.5 size-3.5 animate-spin" />
          {row.status === "generating" ? "Generating…" : "Publishing…"}
        </Button>
      )}

      {isPublished && (
        <Button
          variant="ghost"
          size="icon"
          onClick={handleScanSeo}
          disabled={pending}
          title="Scan this post for SEO issues"
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Gauge className="size-4" />
          )}
        </Button>
      )}

      {canRegenerate && (
        <Button
          variant="ghost"
          size="icon"
          onClick={handleRegenerate}
          disabled={pending}
          title="Regenerate & update the live post"
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
        </Button>
      )}

      {isPublished && row.externalPostUrl && (
        <a
          href={row.externalPostUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex"
        >
          <Button variant="ghost" size="icon" title="Open live post">
            <ExternalLink className="size-4" />
          </Button>
        </a>
      )}

      <Button
        variant="ghost"
        size="icon"
        onClick={() => onDelete(row)}
        disabled={pending || isInFlight}
        title={
          isPublished
            ? "Delete post (app + live site)"
            : "Delete generated post"
        }
        className="text-destructive hover:text-destructive"
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

interface Props {
  blogId: string;
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
  /** Per-post views/clicks, keyed by generated-post id. */
  trafficByPost?: Record<string, { views: number; clicks: number }>;
}

export function BlogPostsPanel({
  blogId,
  generated,
  live,
  trafficByPost = {},
}: Props) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const genSel = useRowSelection(generated.map((r) => r.id));
  const liveSel = useRowSelection(live.posts.map((p) => p.id));

  async function batchDeleteGen() {
    const res = await deleteGeneratedPosts(genSel.ids, true);
    if (res.success) toast.success(res.message);
    else toast.error(res.message);
    genSel.clear();
    router.refresh();
  }

  async function batchDeleteLive() {
    const res = await deleteBlogLivePosts(blogId, liveSel.ids, false);
    if (res.success) toast.success(res.message);
    else toast.error(res.message);
    liveSel.clear();
    router.refresh();
  }

  // Edit dialog state
  const [editing, setEditing] = useState<BlogLivePostRow | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editStatus, setEditStatus] = useState<
    "publish" | "draft" | "pending" | "private"
  >("publish");
  const [savingEdit, setSavingEdit] = useState(false);

  // Delete confirmation state (Live tab)
  const [deleting, setDeleting] = useState<BlogLivePostRow | null>(null);
  const [forceDelete, setForceDelete] = useState(false);
  const [deletingPending, setDeletingPending] = useState(false);

  // Delete confirmation state (Generated tab)
  const [deletingGen, setDeletingGen] = useState<BlogGeneratedPostRow | null>(
    null,
  );
  const [deleteGenLive, setDeleteGenLive] = useState(true);
  const [deleteGenPending, setDeleteGenPending] = useState(false);

  // View-generated-post dialog state. Body/excerpt/meta are not in the
  // table row payload — fetched on demand when the eye icon is clicked.
  const [viewingRow, setViewingRow] = useState<BlogGeneratedPostRow | null>(
    null,
  );
  const [viewContent, setViewContent] = useState<GeneratedPostContent | null>(
    null,
  );
  const [viewLoading, setViewLoading] = useState(false);

  async function openView(row: BlogGeneratedPostRow) {
    setViewingRow(row);
    setViewContent(null);
    setViewLoading(true);
    const result = await getGeneratedPostContent(row.id);
    if ("error" in result) {
      toast.error(result.error);
      setViewingRow(null);
      setViewLoading(false);
      return;
    }
    setViewContent(result);
    setViewLoading(false);
  }

  // Edit-generated-post dialog state. Like view, the full body isn't in
  // the row payload so we fetch on click and pre-fill the form fields.
  const [editingGenRow, setEditingGenRow] = useState<BlogGeneratedPostRow | null>(
    null,
  );
  const [editGenLoading, setEditGenLoading] = useState(false);
  const [editGenSaving, setEditGenSaving] = useState(false);
  const [editGenTitle, setEditGenTitle] = useState("");
  const [editGenBody, setEditGenBody] = useState("");
  const [editGenExcerpt, setEditGenExcerpt] = useState("");
  const [editGenMetaTitle, setEditGenMetaTitle] = useState("");
  const [editGenMetaDescription, setEditGenMetaDescription] = useState("");
  const [editGenKeywords, setEditGenKeywords] = useState("");
  // Original `<img src="data:...">` tags pulled out of the body so the
  // textarea shows short `[[IMAGE_N]]` markers instead of huge base64
  // blobs. Restored verbatim on save.
  const [editGenImages, setEditGenImages] = useState<string[]>([]);

  async function openEditGen(row: BlogGeneratedPostRow) {
    setEditingGenRow(row);
    setEditGenLoading(true);
    setEditGenTitle("");
    setEditGenBody("");
    setEditGenExcerpt("");
    setEditGenMetaTitle("");
    setEditGenMetaDescription("");
    setEditGenKeywords("");
    setEditGenImages([]);

    const result = await getGeneratedPostContent(row.id);
    if ("error" in result) {
      toast.error(result.error);
      setEditingGenRow(null);
      setEditGenLoading(false);
      return;
    }
    const { text, images } = extractDataUriImages(result.body ?? "");
    setEditGenTitle(result.title ?? "");
    setEditGenBody(text);
    setEditGenImages(images);
    setEditGenExcerpt(result.excerpt ?? "");
    setEditGenMetaTitle(result.metaTitle ?? "");
    setEditGenMetaDescription(result.metaDescription ?? "");
    setEditGenKeywords(result.keywords.join(", "));
    setEditGenLoading(false);
  }

  async function handleSaveEditGen() {
    if (!editingGenRow) return;
    setEditGenSaving(true);
    const result = await updateGeneratedPostContent(editingGenRow.id, {
      title: editGenTitle,
      body: restoreDataUriImages(editGenBody, editGenImages),
      excerpt: editGenExcerpt,
      metaTitle: editGenMetaTitle,
      metaDescription: editGenMetaDescription,
      keywords: editGenKeywords
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    });
    setEditGenSaving(false);
    if (result.success) {
      toast.success(result.message);
      setEditingGenRow(null);
      router.refresh();
    } else {
      toast.error(result.message);
    }
  }

  function openEdit(post: BlogLivePostRow) {
    setEditing(post);
    setEditTitle(post.title);
    setEditContent("");
    setEditStatus(
      (["publish", "draft", "pending", "private"] as const).includes(
        post.status as "publish" | "draft" | "pending" | "private",
      )
        ? (post.status as "publish" | "draft" | "pending" | "private")
        : "publish",
    );
  }

  async function handleSaveEdit() {
    if (!editing) return;
    setSavingEdit(true);
    const payload: Parameters<typeof editBlogLivePost>[2] = {
      status: editStatus,
    };
    if (editTitle.trim() && editTitle !== editing.title)
      payload.title = editTitle.trim();
    if (editContent.trim()) payload.content = editContent;

    const result = await editBlogLivePost(blogId, editing.id, payload);
    setSavingEdit(false);
    if (result.success) {
      toast.success(result.message);
      setEditing(null);
      router.refresh();
    } else {
      toast.error(result.message);
    }
  }

  async function handleConfirmDelete() {
    if (!deleting) return;
    setDeletingPending(true);
    const result = await deleteBlogLivePost(blogId, deleting.id, forceDelete);
    setDeletingPending(false);
    if (result.success) {
      toast.success(result.message);
      setDeleting(null);
      setForceDelete(false);
      router.refresh();
    } else {
      toast.error(result.message);
    }
  }

  function openDeleteGen(row: BlogGeneratedPostRow) {
    // Default to also removing the live post for published rows.
    setDeleteGenLive(true);
    setDeletingGen(row);
  }

  async function handleConfirmDeleteGen() {
    if (!deletingGen) return;
    const isPublished = deletingGen.status === "published";
    setDeleteGenPending(true);
    const result = await deleteGeneratedPost(
      deletingGen.id,
      isPublished ? deleteGenLive : false,
    );
    setDeleteGenPending(false);
    if (result.success) {
      toast.success(result.message);
      setDeletingGen(null);
      router.refresh();
    } else {
      toast.error(result.message);
    }
  }

  function handleRefresh() {
    startRefresh(() => router.refresh());
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="size-4" />
              Posts
            </CardTitle>
            <CardDescription>
              Auto-generated posts from this app + live posts from the
              destination site.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <GeneratePostButton blogId={blogId} />
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              {refreshing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Refresh
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <Tabs defaultValue="generated">
          <TabsList>
            <TabsTrigger value="generated">
              Generated ({generated.length})
            </TabsTrigger>
            <TabsTrigger value="live">
              Live on{" "}
              {live.platform === "wordpress" ? "WordPress" : live.platform} (
              {live.total})
            </TabsTrigger>
          </TabsList>

          {/* Generated tab */}
          <TabsContent value="generated" className="pt-4">
            {generated.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No generated posts yet. Click <strong>Generate post</strong>{" "}
                above to create one.
              </p>
            ) : (
              <>
                {genSel.count > 0 && (
                  <div className="mb-3">
                    <BulkDeleteBar
                      count={genSel.count}
                      noun="post"
                      description={`This deletes ${genSel.count} generated post${genSel.count === 1 ? "" : "s"} from the app, and removes the live copy for any that are published. This can't be undone.`}
                      onClear={genSel.clear}
                      onConfirm={batchDeleteGen}
                    />
                  </div>
                )}
                <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[40px]">
                      <Checkbox
                        aria-label="Select all generated posts"
                        checked={
                          genSel.allSelected
                            ? true
                            : genSel.someSelected
                              ? "indeterminate"
                              : false
                        }
                        onCheckedChange={(v) => genSel.toggleAll(v === true)}
                      />
                    </TableHead>
                    <TableHead>Topic / Title</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Words</TableHead>
                    <TableHead>SEO</TableHead>
                    <TableHead>
                      <span
                        title="Historic page views · CTA clicks. Netgrid-side tracking was retired 2026-09-08 (T02) — these numbers no longer grow; current traffic lives in the client's own GA4/Shopify analytics."
                      >
                        Traffic*
                      </span>
                    </TableHead>
                    <TableHead>Published</TableHead>
                    <TableHead>Auto?</TableHead>
                    <TableHead className="w-[180px] text-right">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {generated.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Checkbox
                          aria-label={`Select ${row.title || row.topic}`}
                          checked={genSel.isSelected(row.id)}
                          onCheckedChange={(v) => genSel.toggle(row.id, v === true)}
                        />
                      </TableCell>
                      <TableCell className="max-w-md">
                        <div className="space-y-1">
                          <p className="line-clamp-1 text-sm font-medium">
                            {row.title || row.topic}
                          </p>
                          {row.title && row.title !== row.topic && (
                            <p className="line-clamp-1 text-xs text-muted-foreground">
                              {row.topic}
                            </p>
                          )}
                          {row.failureReason && (
                            <p className="line-clamp-2 text-xs text-destructive">
                              {row.failureReason}
                            </p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            GENERATED_STATUS_VARIANTS[row.status] ?? "outline"
                          }
                        >
                          {row.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.wordCount ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.seoScore ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {(() => {
                          const t = trafficByPost[row.id];
                          if (!t || (t.views === 0 && t.clicks === 0)) return "—";
                          return (
                            <span title="page views · CTA clicks">
                              {t.views.toLocaleString()} v ·{" "}
                              {t.clicks.toLocaleString()} c
                            </span>
                          );
                        })()}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDateTime(row.publishedAt)}
                      </TableCell>
                      <TableCell>
                        {row.isAutoGenerated ? (
                          <Badge variant="outline" className="text-xs">
                            cron
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            manual
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <GeneratedRowActions
                          row={row}
                          onView={openView}
                          onEdit={openEditGen}
                          onDelete={openDeleteGen}
                          viewLoadingId={viewLoading ? viewingRow?.id ?? null : null}
                          editLoadingId={editGenLoading ? editingGenRow?.id ?? null : null}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </>
            )}
          </TabsContent>

          {/* Live tab */}
          <TabsContent value="live" className="pt-4">
            {!live.available ? (
              <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
                <p className="text-sm text-muted-foreground">
                  {live.error ?? "Live posts unavailable."}
                </p>
              </div>
            ) : live.posts.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No posts found on the live site.
              </p>
            ) : (
              <>
                {liveSel.count > 0 && (
                  <div className="mb-3">
                    <BulkDeleteBar
                      count={liveSel.count}
                      noun="post"
                      description={`This deletes ${liveSel.count} post${liveSel.count === 1 ? "" : "s"} from the live ${live.platform === "wordpress" ? "WordPress" : live.platform} site. WordPress posts go to trash; Shopify articles are removed permanently.`}
                      onClear={liveSel.clear}
                      onConfirm={batchDeleteLive}
                    />
                  </div>
                )}
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[40px]">
                        <Checkbox
                          aria-label="Select all live posts"
                          checked={
                            liveSel.allSelected
                              ? true
                              : liveSel.someSelected
                                ? "indeterminate"
                                : false
                          }
                          onCheckedChange={(v) => liveSel.toggleAll(v === true)}
                        />
                      </TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Published</TableHead>
                      <TableHead>Modified</TableHead>
                      <TableHead className="w-[140px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {live.posts.map((post) => (
                      <TableRow key={post.id}>
                        <TableCell>
                          <Checkbox
                            aria-label={`Select ${post.title}`}
                            checked={liveSel.isSelected(post.id)}
                            onCheckedChange={(v) => liveSel.toggle(post.id, v === true)}
                          />
                        </TableCell>
                        <TableCell className="max-w-md">
                          <div className="space-y-1">
                            <p className="line-clamp-1 text-sm font-medium">
                              {post.title}
                            </p>
                            {post.excerpt && (
                              <p className="line-clamp-2 text-xs text-muted-foreground">
                                {post.excerpt}
                              </p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              LIVE_STATUS_VARIANTS[post.status] ?? "outline"
                            }
                          >
                            {post.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDateTime(post.date)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDateTime(post.modified)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <a
                              href={post.link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex"
                            >
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Open"
                              >
                                <ExternalLink className="size-4" />
                              </Button>
                            </a>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => openEdit(post)}
                              title="Edit"
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setDeleting(post)}
                              title="Delete"
                              className="text-destructive hover:text-destructive"
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {live.totalPages > 1 && (
                  <p className="pt-3 text-xs text-muted-foreground">
                    Page {live.page} of {live.totalPages} · {live.total} total
                    posts on the live site
                  </p>
                )}
              </>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>

      {/* View generated post dialog */}
      <Dialog
        open={viewingRow !== null}
        onOpenChange={(open) => {
          if (!open) {
            setViewingRow(null);
            setViewContent(null);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto p-0">
          {/* The visible dialog title is the article H1 itself (rendered
              further down). This header is kept only so the Radix dialog
              has an accessible label and a description for screen readers. */}
          <DialogHeader className="sr-only">
            <DialogTitle>
              {viewContent?.title ?? viewingRow?.title ?? viewingRow?.topic ?? "Generated post"}
            </DialogTitle>
            <DialogDescription>
              Preview of the generated article as it would appear when published.
            </DialogDescription>
          </DialogHeader>

          {viewLoading || !viewContent ? (
            <div className="flex items-center justify-center py-24">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* ── Article preview (looks like the published page) ── */}
              <article className="px-8 pt-8 pb-6">
                {viewContent.featuredImageUrl && (
                  // Featured image is a data: URI authored by Nano Banana.
                  // next/image isn't needed and would require remote-pattern
                  // config for data URIs.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={viewContent.featuredImageUrl}
                    alt={viewContent.title ?? viewContent.topic}
                    className="mb-6 w-full rounded-md border"
                  />
                )}

                <h1 className="text-3xl font-bold leading-tight tracking-tight">
                  {viewContent.title ?? viewContent.topic}
                </h1>

                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                  <span>
                    {formatDateTime(
                      viewContent.publishedAt ?? viewContent.createdAt,
                    )}
                  </span>
                  {viewContent.wordCount != null && (
                    <>
                      <span aria-hidden>·</span>
                      <span>{viewContent.wordCount} words</span>
                    </>
                  )}
                </div>

                {viewContent.excerpt && (
                  <p className="mt-4 text-lg italic leading-relaxed text-muted-foreground">
                    {viewContent.excerpt}
                  </p>
                )}

                {viewContent.failureReason && (
                  <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                    {viewContent.failureReason}
                  </div>
                )}

                <div className="mt-6">
                  {viewContent.body ? (
                    <ArticlePreviewHtml html={viewContent.body} />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No body content stored for this post.
                    </p>
                  )}
                </div>
              </article>

              {/* ── Admin details (not visible to readers of the live post) ── */}
              <div className="border-t bg-muted/30 px-8 py-5">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Admin details
                </p>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge
                    variant={
                      GENERATED_STATUS_VARIANTS[viewContent.status] ?? "outline"
                    }
                  >
                    {viewContent.status}
                  </Badge>
                  {viewContent.seoScore != null && (
                    <span className="text-muted-foreground">
                      SEO {viewContent.seoScore}
                    </span>
                  )}
                  <span className="text-muted-foreground">
                    Generated {formatDateTime(viewContent.createdAt)}
                  </span>
                  {viewContent.publishedAt && (
                    <span className="text-muted-foreground">
                      · Published {formatDateTime(viewContent.publishedAt)}
                    </span>
                  )}
                </div>

                {(viewContent.metaTitle ||
                  viewContent.metaDescription ||
                  viewContent.keywords.length > 0 ||
                  (viewingRow?.title &&
                    viewingRow.topic !== viewingRow.title)) && (
                  <div className="mt-3 space-y-2 text-sm">
                    {viewingRow?.title &&
                      viewingRow.topic !== viewingRow.title && (
                        <div>
                          <span className="text-xs font-medium text-muted-foreground">
                            Topic:{" "}
                          </span>
                          <span>{viewingRow.topic}</span>
                        </div>
                      )}
                    {viewContent.metaTitle && (
                      <div>
                        <span className="text-xs font-medium text-muted-foreground">
                          Meta title:{" "}
                        </span>
                        <span>{viewContent.metaTitle}</span>
                      </div>
                    )}
                    {viewContent.metaDescription && (
                      <div>
                        <span className="text-xs font-medium text-muted-foreground">
                          Meta description:{" "}
                        </span>
                        <span>{viewContent.metaDescription}</span>
                      </div>
                    )}
                    {viewContent.keywords.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-xs font-medium text-muted-foreground">
                          Keywords:
                        </span>
                        {viewContent.keywords.map((kw) => (
                          <Badge
                            key={kw}
                            variant="outline"
                            className="text-xs font-normal"
                          >
                            {kw}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          <DialogFooter className="border-t px-6 py-4">
            {viewContent?.externalPostUrl && (
              <a
                href={viewContent.externalPostUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex"
              >
                <Button variant="outline">
                  <ExternalLink className="mr-2 size-4" />
                  Open live post
                </Button>
              </a>
            )}
            <Button
              variant="outline"
              onClick={() => {
                setViewingRow(null);
                setViewContent(null);
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit generated post dialog (pre-publish) */}
      <Dialog
        open={editingGenRow !== null}
        onOpenChange={(open) => {
          if (!open && !editGenSaving) {
            setEditingGenRow(null);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit generated post</DialogTitle>
            <DialogDescription>
              Changes are saved to the stored draft. The next publish will use
              the edited content.
            </DialogDescription>
          </DialogHeader>

          {editGenLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-gen-title">Title</Label>
                <Input
                  id="edit-gen-title"
                  value={editGenTitle}
                  onChange={(e) => setEditGenTitle(e.target.value)}
                  disabled={editGenSaving}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-gen-body">Body</Label>

                {editGenImages.length > 0 && (
                  <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      Inline images — keep the{" "}
                      <code className="rounded bg-muted px-1 text-[10px]">
                        [[IMAGE_N]]
                      </code>{" "}
                      marker in the body to keep the image; delete it to drop
                      the image; move it to reposition.
                    </p>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      {editGenImages.map((tag, i) => {
                        const src = extractImgSrcFromTag(tag);
                        const alt = extractImgAltFromTag(tag);
                        const marker = `[[IMAGE_${i + 1}]]`;
                        if (!src) return null;
                        return (
                          <div key={i} className="space-y-1">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={src}
                              alt={alt}
                              className="aspect-video w-full rounded-md border object-cover"
                            />
                            <code className="block text-[10px] text-muted-foreground">
                              {marker}
                            </code>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <Tabs defaultValue="source">
                  <TabsList>
                    <TabsTrigger value="source">Source</TabsTrigger>
                    <TabsTrigger value="preview">Preview</TabsTrigger>
                  </TabsList>

                  <TabsContent value="source" className="pt-2">
                    <Textarea
                      id="edit-gen-body"
                      rows={16}
                      className="font-mono text-xs"
                      value={editGenBody}
                      onChange={(e) => setEditGenBody(e.target.value)}
                      disabled={editGenSaving}
                    />
                    <p className="mt-2 text-xs text-muted-foreground">
                      Word count auto-recalculates on save.
                    </p>
                  </TabsContent>

                  <TabsContent value="preview" className="pt-2">
                    <div className="rounded-md border bg-background p-6">
                      <ArticlePreviewHtml
                        html={restoreDataUriImages(editGenBody, editGenImages)}
                      />
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Live preview — shows exactly how the body will render
                      when published.
                    </p>
                  </TabsContent>
                </Tabs>
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-gen-excerpt">Excerpt</Label>
                <Textarea
                  id="edit-gen-excerpt"
                  rows={2}
                  value={editGenExcerpt}
                  onChange={(e) => setEditGenExcerpt(e.target.value)}
                  disabled={editGenSaving}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="edit-gen-meta-title">Meta title</Label>
                  <Input
                    id="edit-gen-meta-title"
                    value={editGenMetaTitle}
                    onChange={(e) => setEditGenMetaTitle(e.target.value)}
                    disabled={editGenSaving}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-gen-keywords">
                    Keywords{" "}
                    <span className="font-normal text-muted-foreground">
                      (comma-separated)
                    </span>
                  </Label>
                  <Input
                    id="edit-gen-keywords"
                    value={editGenKeywords}
                    onChange={(e) => setEditGenKeywords(e.target.value)}
                    disabled={editGenSaving}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-gen-meta-description">
                  Meta description
                </Label>
                <Textarea
                  id="edit-gen-meta-description"
                  rows={2}
                  value={editGenMetaDescription}
                  onChange={(e) => setEditGenMetaDescription(e.target.value)}
                  disabled={editGenSaving}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditingGenRow(null)}
              disabled={editGenSaving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSaveEditGen}
              disabled={editGenSaving || editGenLoading}
            >
              {editGenSaving && (
                <Loader2 className="mr-2 size-4 animate-spin" />
              )}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit post</DialogTitle>
            <DialogDescription>
              Changes are pushed to the live site immediately.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-title">Title</Label>
              <Input
                id="edit-title"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-content">
                Content (HTML){" "}
                <span className="font-normal text-muted-foreground">
                  — leave blank to keep the existing content
                </span>
              </Label>
              <Textarea
                id="edit-content"
                rows={10}
                placeholder="Paste new HTML content here, or leave blank to only update title/status."
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-status">Status</Label>
              <Select
                value={editStatus}
                onValueChange={(v) =>
                  setEditStatus(v as "publish" | "draft" | "pending" | "private")
                }
              >
                <SelectTrigger id="edit-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="publish">Published</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="private">Private</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditing(null)}
              disabled={savingEdit}
            >
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={savingEdit}>
              {savingEdit && <Loader2 className="mr-2 size-4 animate-spin" />}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
            setForceDelete(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete post?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.title ? (
                <span>
                  &ldquo;{deleting.title}&rdquo; will be{" "}
                  {live.platform === "shopify"
                    ? "permanently deleted from your Shopify store"
                    : forceDelete
                      ? "permanently deleted"
                      : "moved to the WordPress trash"}
                  .
                </span>
              ) : (
                "This will be removed from the live site."
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* Shopify has no trash — deletion is always permanent, so the
              trash toggle only applies to WordPress. */}
          {live.platform !== "shopify" && (
            <div className="flex items-center gap-2 rounded-md border p-3 text-sm">
              <input
                id="force-delete"
                type="checkbox"
                checked={forceDelete}
                onChange={(e) => setForceDelete(e.target.checked)}
                className="size-4"
              />
              <label htmlFor="force-delete" className="text-sm">
                Skip the trash and delete permanently
              </label>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={deletingPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              {live.platform === "shopify" || forceDelete
                ? "Delete permanently"
                : "Move to trash"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation — Generated tab */}
      <AlertDialog
        open={deletingGen !== null}
        onOpenChange={(open) => {
          if (!open && !deleteGenPending) setDeletingGen(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete generated post?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{deletingGen?.title || deletingGen?.topic}&rdquo; will be
              removed from this app.
              {deletingGen?.status === "published" &&
                deletingGen?.externalPostId &&
                deleteGenLive && (
                  <>
                    {" "}
                    The live post will also be permanently deleted from the
                    destination site.
                  </>
                )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deletingGen?.status === "published" &&
            deletingGen?.externalPostId && (
              <div className="flex items-center gap-2 rounded-md border p-3 text-sm">
                <input
                  id="delete-gen-live"
                  type="checkbox"
                  checked={deleteGenLive}
                  onChange={(e) => setDeleteGenLive(e.target.checked)}
                  className="size-4"
                />
                <label htmlFor="delete-gen-live" className="text-sm">
                  Also delete the live post from the site (uncheck to only remove
                  the app record)
                </label>
              </div>
            )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteGenPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDeleteGen}
              disabled={deleteGenPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteGenPending && (
                <Loader2 className="mr-2 size-4 animate-spin" />
              )}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
