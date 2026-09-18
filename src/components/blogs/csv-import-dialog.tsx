"use client";

import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Upload, FileText, Loader2 } from "lucide-react";
import { importBlogsFromCsv } from "@/lib/actions/blog-actions";
import { parseBlogCsv, type BlogInsert, type CsvError } from "@/lib/services/csv-parser";
import { toast } from "sonner";
import type { CsvImportResult } from "@/lib/types";

interface CsvImportDialogProps {
  clientId: string;
}

type ImportStep = "upload" | "preview" | "results";

export function CsvImportDialog({ clientId }: CsvImportDialogProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<ImportStep>("upload");
  const [csvContent, setCsvContent] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [previewRows, setPreviewRows] = useState<BlogInsert[]>([]);
  const [previewErrors, setPreviewErrors] = useState<CsvError[]>([]);
  const [importResult, setImportResult] = useState<CsvImportResult | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const reset = () => {
    setStep("upload");
    setCsvContent("");
    setFileName("");
    setPreviewRows([]);
    setPreviewErrors([]);
    setImportResult(null);
  };

  const processFile = (file: File) => {
    if (!file.name.endsWith(".csv")) {
      toast.error("Please upload a CSV file");
      return;
    }

    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      setCsvContent(text);

      // Parse for preview
      const { valid, errors } = parseBlogCsv(text, clientId);
      setPreviewRows(valid);
      setPreviewErrors(errors);
      setStep("preview");
    };
    reader.readAsText(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const handleImport = () => {
    startTransition(async () => {
      const result = await importBlogsFromCsv(clientId, csvContent);
      setImportResult(result);
      setStep("results");

      if (result.successCount > 0) {
        toast.success(`${result.successCount} blog(s) imported successfully`);
        router.refresh();
      }
      if (result.failedCount > 0) {
        toast.error(`${result.failedCount} row(s) failed to import`);
      }
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Upload className="size-4" data-icon="inline-start" />
          Import CSV
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Blogs from CSV</DialogTitle>
          <DialogDescription>
            Upload a CSV file to bulk-import blogs. Required columns: domain,
            wp_url, wp_username, wp_app_password, seo_plugin. Cadence: either
            posting_days (e.g. &quot;Mon Wed Fri&quot;, optionally with
            posts_per_day) or posting_frequency (e.g. &quot;3 per week&quot;,
            &quot;2 per day&quot;). A bare number is rejected — state the unit.
          </DialogDescription>
        </DialogHeader>

        {/* Step: Upload */}
        {step === "upload" && (
          <div
            className={`flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-8 transition-colors ${
              isDragOver
                ? "border-primary bg-primary/5"
                : "border-muted-foreground/25 hover:border-muted-foreground/50"
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
          >
            <FileText className="size-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Drag and drop a CSV file here, or click to browse
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              Choose File
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleFileInput}
            />
          </div>
        )}

        {/* Step: Preview */}
        {step === "preview" && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm">
              <FileText className="size-4 text-muted-foreground" />
              <span className="font-medium">{fileName}</span>
              <span className="text-muted-foreground">
                -- {previewRows.length} valid row(s), {previewErrors.length} error(s)
              </span>
            </div>

            {previewErrors.length > 0 && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950">
                <p className="text-sm font-medium text-red-800 dark:text-red-200 mb-2">
                  Validation Errors
                </p>
                <ul className="space-y-1">
                  {previewErrors.map((err, i) => (
                    <li key={i} className="text-xs text-red-700 dark:text-red-300">
                      Row {err.row}, {err.field}: {err.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {previewRows.length > 0 && (
              <div className="max-h-60 overflow-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Domain</TableHead>
                      <TableHead>WP URL</TableHead>
                      <TableHead>SEO Plugin</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewRows.map((row, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-medium">{row.domain}</TableCell>
                        <TableCell className="text-muted-foreground max-w-[200px] truncate">
                          {row.wpUrl || "--"}
                        </TableCell>
                        <TableCell>{row.seoPlugin}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={reset}>
                Back
              </Button>
              <Button
                onClick={handleImport}
                disabled={previewRows.length === 0 || isPending}
              >
                {isPending && (
                  <Loader2 className="size-4 animate-spin" data-icon="inline-start" />
                )}
                Import {previewRows.length} Blog(s)
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step: Results */}
        {step === "results" && importResult && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div className="rounded-lg border p-3 text-center">
                <p className="text-2xl font-bold">{importResult.totalRows}</p>
                <p className="text-xs text-muted-foreground">Total</p>
              </div>
              <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-center dark:border-green-900 dark:bg-green-950">
                <p className="text-2xl font-bold text-green-700">{importResult.successCount}</p>
                <p className="text-xs text-muted-foreground">Imported</p>
              </div>
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-center dark:border-red-900 dark:bg-red-950">
                <p className="text-2xl font-bold text-red-700">{importResult.failedCount}</p>
                <p className="text-xs text-muted-foreground">Failed</p>
              </div>
            </div>

            {importResult.errors.length > 0 && (
              <div className="max-h-40 overflow-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Row</TableHead>
                      <TableHead>Field</TableHead>
                      <TableHead>Error</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {importResult.errors.map((err, i) => (
                      <TableRow key={i}>
                        <TableCell>{err.row}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{err.field}</Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {err.message}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Close
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
