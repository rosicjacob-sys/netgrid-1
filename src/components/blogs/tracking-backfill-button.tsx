"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { removeBlogTracking } from "@/lib/actions/tracking-backfill-actions";
import type { TrackingRemovalResult } from "@/lib/actions/tracking-backfill-actions";
import { History, CheckCircle2, XCircle, Loader2 } from "lucide-react";

interface TrackingBackfillButtonProps {
  blogId: string;
}

export function TrackingBackfillButton({ blogId }: TrackingBackfillButtonProps) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<TrackingRemovalResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run(dryRun: boolean) {
    setResult(null);
    setError(null);
    start(async () => {
      try {
        setResult(await removeBlogTracking(blogId, { dryRun }));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Tracking removal failed");
      }
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Remove the shared-host tracking footprint (T02) from this blog&apos;s
        published posts: repoints every netgrid redirect link directly at the
        client&apos;s site (UTM-tagged, rel=&quot;sponsored noopener&quot;) and
        strips the tracking pixel. <strong>Dry run first</strong> — the live
        run rewrites published post bodies. Reads each live post and only
        writes when something changes — safe to re-run. Processes the newest
        ~60 posts per run; if more remain, just run it again.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => run(true)} disabled={pending} variant="outline">
          {pending ? (
            <Loader2 className="size-4 animate-spin" data-icon="inline-start" />
          ) : (
            <History className="size-4" data-icon="inline-start" />
          )}
          Dry run (no writes)
        </Button>
        <Button onClick={() => run(false)} disabled={pending}>
          {pending ? (
            <Loader2 className="size-4 animate-spin" data-icon="inline-start" />
          ) : (
            <History className="size-4" data-icon="inline-start" />
          )}
          Remove tracking on published posts
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950">
          <XCircle className="mt-0.5 size-5 shrink-0 text-red-600" />
          <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
        </div>
      )}

      {result && (
        <div className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-900 dark:bg-green-950">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-green-600" />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-green-800 dark:text-green-200">
              {result.dryRun ? "Dry run — " : ""}
              {result.updated} {result.dryRun ? "would update" : "updated"} ·{" "}
              {result.skipped} already clean · {result.failed} failed
              {result.unresolved > 0
                ? ` · ${result.unresolved} unresolved (no CTA destination set)`
                : ""}
            </p>
            <p className="text-muted-foreground">
              {result.linksRepointed} link
              {result.linksRepointed === 1 ? "" : "s"} repointed to the client
              · {result.pixelsRemoved} tracking pixel
              {result.pixelsRemoved === 1 ? "" : "s"} removed. Processed{" "}
              {result.total} published post{result.total === 1 ? "" : "s"}.
              {result.remaining > 0
                ? ` ${result.remaining} more remain — run again to finish them.`
                : " All published posts covered."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
