"use client";

import { useState, useTransition, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MoreHorizontal,
  ExternalLink,
  Pencil,
  Wifi,
  Trash2,
  Search,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  Loader2,
  Download,
} from "lucide-react";
import { BulkDeleteBar } from "@/components/ui/bulk-delete-bar";
import { useRowSelection } from "@/lib/hooks/use-row-selection";
import {
  deleteBlog,
  deleteBlogs,
  testBlogConnection,
  exportBlogsCsv,
} from "@/lib/actions/blog-actions";
import type { BlogStatus } from "@/lib/types";
import { toast } from "sonner";
import { formatPostingPlan, normalizePostingPlan } from "@/lib/posting-plan";


// ─── Types ──────────────────────────────────────────────────────────────────

interface BlogRow {
  id: string;
  clientId: string;
  clientName: string;
  domain: string;
  wpUrl: string | null;
  city: string | null;
  status: string | null;
  currentSeoScore: number | null;
  lastPostVerifiedAt: Date | null;
  lastPostTitle: string | null;
  postingPlan: number[];
  createdAt: Date;
}

interface BlogTableProps {
  blogs: BlogRow[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  clientId?: string;
  showClientColumn?: boolean;
  rowTarget?: "detail" | "posts";
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  paused: "secondary",
  setup: "outline",
  decommissioned: "destructive",
};

function getSeoScoreColor(score: number | null): string {
  if (score === null) return "text-muted-foreground";
  if (score >= 90) return "text-green-700";
  if (score >= 80) return "text-green-600";
  if (score >= 70) return "text-yellow-600";
  if (score >= 60) return "text-yellow-700";
  if (score >= 40) return "text-orange-600";
  return "text-red-600";
}

function formatDate(date: Date | null): string {
  if (!date) return "--";
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Component ──────────────────────────────────────────────────────────────

export function BlogTable({
  blogs,
  totalCount,
  page,
  pageSize,
  totalPages,
  clientId,
  showClientColumn = true,
  rowTarget = "detail",
}: BlogTableProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [exporting, setExporting] = useState(false);
  const sel = useRowSelection(blogs.map((b) => b.id));

  const batchDelete = async () => {
    const res = await deleteBlogs(sel.ids);
    if (res.success) toast.success(res.message);
    else toast.error(res.message);
    sel.clear();
    router.refresh();
  };

  const buildUrl = useCallback(
    (params: Record<string, string | number>) => {
      const base = clientId ? `/clients/${clientId}/blogs` : "/blogs";
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value && value !== "all") {
          searchParams.set(key, String(value));
        }
      }
      const qs = searchParams.toString();
      return qs ? `${base}?${qs}` : base;
    },
    [clientId]
  );

  const handleSearch = () => {
    startTransition(() => {
      router.push(
        buildUrl({
          search,
          status: statusFilter,
          page: 1,
          pageSize,
        })
      );
    });
  };

  const handleStatusChange = (value: string) => {
    setStatusFilter(value);
    startTransition(() => {
      router.push(
        buildUrl({
          search,
          status: value,
          page: 1,
          pageSize,
        })
      );
    });
  };

  const handlePageChange = (newPage: number) => {
    startTransition(() => {
      router.push(
        buildUrl({
          search,
          status: statusFilter,
          page: newPage,
          pageSize,
        })
      );
    });
  };

  const handleTestConnection = async (blogId: string, domain: string) => {
    const t = toast.loading(`Testing connection to ${domain}…`);
    const result = await testBlogConnection(blogId);
    if (result.success) {
      toast.success(result.message, { id: t });
    } else {
      toast.error(result.message, { id: t });
    }
  };

  const handleDelete = async (blogId: string, domain: string) => {
    if (
      !window.confirm(
        `Permanently delete ${domain}?\n\nThis removes the blog from netgrid AND deletes every post we published to its live site (WordPress/Shopify). This can't be undone.`,
      )
    ) {
      return;
    }
    const t = toast.loading(`Deleting ${domain}…`);
    const result = await deleteBlog(blogId);
    if ("error" in result) {
      toast.error(result.error, { id: t });
    } else {
      const { deletedLivePosts = 0, failedLivePosts = 0 } = result;
      toast.success(
        `${domain} deleted` +
          (deletedLivePosts > 0
            ? ` · ${deletedLivePosts} live post${deletedLivePosts === 1 ? "" : "s"} removed`
            : "") +
          (failedLivePosts > 0
            ? ` · ${failedLivePosts} couldn't be removed from the site`
            : ""),
        { id: t },
      );
      router.refresh();
    }
  };

  const handleExport = async () => {
    setExporting(true);
    const toastId = toast.loading("Preparing export…");
    try {
      const res = await exportBlogsCsv({
        clientId,
        search: search || undefined,
        status: statusFilter !== "all" ? (statusFilter as BlogStatus) : undefined,
      });
      if (!res.success) {
        toast.error(res.message, { id: toastId });
        return;
      }
      const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Export ready", { id: toastId });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed", {
        id: toastId,
      });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 items-center gap-2">
          <div className="relative flex-1 max-w-sm">
            {isPending ? (
              <Loader2 className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 animate-spin text-muted-foreground" />
            ) : (
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            )}
            <Input
              placeholder="Search domains..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="pl-8"
              disabled={isPending}
            />
          </div>
          <Select
            value={statusFilter}
            onValueChange={handleStatusChange}
            disabled={isPending}
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
              <SelectItem value="setup">Setup</SelectItem>
              <SelectItem value="decommissioned">Decommissioned</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleExport} disabled={exporting}>
            {exporting ? (
              <Loader2 className="size-4 animate-spin" data-icon="inline-start" />
            ) : (
              <Download className="size-4" data-icon="inline-start" />
            )}
            Export CSV
          </Button>
          <Button
            onClick={() =>
              router.push(clientId ? `/blogs/new?clientId=${clientId}` : "/blogs/new")
            }
          >
            <Plus className="size-4" data-icon="inline-start" />
            Add Blog
          </Button>
        </div>
      </div>

      {/* Bulk actions */}
      {sel.count > 0 && (
        <BulkDeleteBar
          count={sel.count}
          noun="blog"
          description={`This permanently deletes ${sel.count} blog${sel.count === 1 ? "" : "s"} from netgrid AND every post published to their live sites (WordPress/Shopify). This can't be undone.`}
          onClear={sel.clear}
          onConfirm={batchDelete}
        />
      )}

      {/* Table */}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40px]">
                <Checkbox
                  aria-label="Select all blogs"
                  checked={
                    sel.allSelected
                      ? true
                      : sel.someSelected
                        ? "indeterminate"
                        : false
                  }
                  onCheckedChange={(v) => sel.toggleAll(v === true)}
                />
              </TableHead>
              <TableHead>
                <span className="inline-flex items-center gap-1">
                  Domain
                  <ArrowUpDown className="size-3 text-muted-foreground" />
                </span>
              </TableHead>
              {showClientColumn && <TableHead>Client</TableHead>}
              <TableHead>Location/City</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>SEO Score</TableHead>
              <TableHead>Last Post</TableHead>
              <TableHead>Frequency</TableHead>
              <TableHead className="w-[50px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {blogs.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={showClientColumn ? 8 : 7}
                  className="h-24 text-center text-muted-foreground"
                >
                  No blogs found.
                </TableCell>
              </TableRow>
            ) : (
              blogs.map((blog) => (
                <TableRow
                  key={blog.id}
                  className="cursor-pointer"
                  data-state={sel.isSelected(blog.id) ? "selected" : undefined}
                  onClick={() => router.push( rowTarget === "posts" ? `/blogs/${blog.id}/posts` : `/blogs/${blog.id}`)}
                >
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      aria-label={`Select ${blog.domain}`}
                      checked={sel.isSelected(blog.id)}
                      onCheckedChange={(v) => sel.toggle(blog.id, v === true)}
                    />
                  </TableCell>
                  <TableCell className="font-medium">{blog.domain}</TableCell>
                  {showClientColumn && (
                    <TableCell className="text-muted-foreground">
                      {blog.clientName}
                    </TableCell>
                  )}
                  <TableCell className="text-muted-foreground">
                    {blog.city || "--"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANTS[blog.status ?? "setup"] ?? "outline"}>
                      {blog.status ?? "setup"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className={`font-medium ${getSeoScoreColor(blog.currentSeoScore)}`}>
                      {blog.currentSeoScore !== null ? blog.currentSeoScore : "--"}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(blog.lastPostVerifiedAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatPostingPlan(normalizePostingPlan(blog.postingPlan))}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            router.push(rowTarget === "posts" ? `/blogs/${blog.id}/posts` : `/blogs/${blog.id}`);
                          }}
                        >
                          <ExternalLink className="size-4" />
                          {rowTarget === "posts" ? "View Posts" : "View Details"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            router.push(`/blogs/${blog.id}?edit=true`);
                          }}
                        >
                          <Pencil className="size-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            handleTestConnection(blog.id, blog.domain);
                          }}
                        >
                          <Wifi className="size-4" />
                          Test Connection
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(blog.id, blog.domain);
                          }}
                        >
                          <Trash2 className="size-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {(page - 1) * pageSize + 1}--
            {Math.min(page * pageSize, totalCount)} of {totalCount} blogs
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || isPending}
              onClick={() => handlePageChange(page - 1)}
            >
              <ChevronLeft className="size-4" />
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages || isPending}
              onClick={() => handlePageChange(page + 1)}
            >
              Next
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
