"use client";

import {
  useForm,
  type Resolver,
  type UseFormRegister,
  type FieldErrors,
  type Path,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { createBlogSchema, type CreateBlogInput } from "@/lib/validators/blog";
import { deriveBrandName } from "@/lib/content/brand";
import {
  createBlog,
  updateBlog,
  testShopifyConnection,
  pushHomepageSeo,
} from "@/lib/actions/blog-actions";
import { Button } from "@/components/ui/button";
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
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Loader2, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface ClientOption {
  id: string;
  name: string;
}

interface BlogFormProps {
  mode: "create" | "edit";
  blogId?: string;
  clients: ClientOption[];
  defaultValues?: Partial<CreateBlogInput>;
  defaultClientId?: string;
}

type TestResult =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; message: string }
  | { kind: "err"; message: string };

// ─── Constants ──────────────────────────────────────────────────────────────

// ISO weekday: 1 = Monday … 7 = Sunday
const DAYS_OF_WEEK = [
  { value: 1, label: "Mon", full: "Monday" },
  { value: 2, label: "Tue", full: "Tuesday" },
  { value: 3, label: "Wed", full: "Wednesday" },
  { value: 4, label: "Thu", full: "Thursday" },
  { value: 5, label: "Fri", full: "Friday" },
  { value: 6, label: "Sat", full: "Saturday" },
  { value: 7, label: "Sun", full: "Sunday" },
] as const;

// ─── Field (outside component to avoid remounting on every keystroke) ───────

interface FieldProps {
  label: string;
  name: Path<CreateBlogInput>;
  type?: string;
  placeholder?: string;
  register: UseFormRegister<CreateBlogInput>;
  errors: FieldErrors<CreateBlogInput>;
  valueAsNumber?: boolean;
}

function Field({
  label,
  name,
  type = "text",
  placeholder,
  register,
  errors,
  valueAsNumber,
}: FieldProps) {
  // `name` may resolve to a nested path like `postingFrequencyDays.0` because
  // the schema includes array fields. We only render <Field> for top-level
  // string/string-optional fields, so a string-indexed lookup is safe — but
  // TS can't narrow that from `Path<CreateBlogInput>`. Cast to a generic
  // record indexer to satisfy the type checker.
  const error = (errors as Record<string, { message?: unknown } | undefined>)[name];
  const errorMessage = typeof error?.message === "string" ? error.message : undefined;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        type={type}
        placeholder={placeholder}
        {...register(name, valueAsNumber ? { valueAsNumber: true } : {})}
      />
      {errorMessage && (
        <p className="text-xs text-destructive">{errorMessage}</p>
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeShopifyStoreUrl(raw: string): string {
  if (!raw) return raw;
  let s = raw.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/\/$/, "").split("/")[0];
  if (!s.includes(".") && s.length > 0) {
    s = `${s}.myshopify.com`;
  }
  return s;
}

// ─── BlogForm ───────────────────────────────────────────────────────────────

export function BlogForm({
  mode,
  blogId,
  clients,
  defaultValues,
  defaultClientId,
}: BlogFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [testResult, setTestResult] = useState<TestResult>({ kind: "idle" });
  const [homepageSeoPushing, setHomepageSeoPushing] = useState(false);

  // Coerce existing posting days into a clean array. Handles the migration
  // case where some rows may still come through as a single number.
  const initialPostingDays: number[] = Array.isArray(
    defaultValues?.postingFrequencyDays,
  )
    ? (defaultValues!.postingFrequencyDays as number[])
    : typeof defaultValues?.postingFrequencyDays === "number"
      ? [defaultValues.postingFrequencyDays as number]
      : [];

  const form = useForm<CreateBlogInput>({
    // Cast required because zod's z.infer (CreateBlogInput) is the OUTPUT type
    // — fields with .default() are non-optional after parsing — but
    // zodResolver internally uses the INPUT type where those fields are still
    // optional. The runtime behaviour is identical; only the static type
    // shape differs.
    resolver: zodResolver(createBlogSchema) as unknown as Resolver<CreateBlogInput>,
    defaultValues: {
      clientId: defaultClientId || defaultValues?.clientId || "",
      domain: defaultValues?.domain || "",
      platform: defaultValues?.platform || "wordpress",
      wpUrl: defaultValues?.wpUrl || "",
      wpUsername: defaultValues?.wpUsername || "",
      wpAppPassword: defaultValues?.wpAppPassword || "",
      seoPlugin: defaultValues?.seoPlugin || "none",
      shopifyAuthMode: "client_credentials" as const,
      // shopifyAdminApiToken intentionally hidden from the UI — Dev Dashboard
      // (client_credentials) is the only supported mode for new blogs.
      shopifyStoreUrl: defaultValues?.shopifyStoreUrl || "",
      shopifyAdminApiToken: defaultValues?.shopifyAdminApiToken || "",
      shopifyClientId: defaultValues?.shopifyClientId || "",
      shopifyClientSecret: defaultValues?.shopifyClientSecret || "",
      // Frequency is hardcoded to "weekly" — the picker now drives the schedule
      postingFrequency: "weekly",
      postingFrequencyDays: initialPostingDays,
      status: defaultValues?.status || "active",
      notesInternal: defaultValues?.notesInternal || "",
      city: defaultValues?.city || "",
      region: defaultValues?.region || "",
      countryCode: defaultValues?.countryCode || "",
      brandName: defaultValues?.brandName || "",
      homepageMetaTitle: defaultValues?.homepageMetaTitle || "",
      homepageMetaDescription: defaultValues?.homepageMetaDescription || "",
    },
  });

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    getValues,
    formState: { errors },
  } = form;

  const platform = watch("platform");
  const selectedDays = (watch("postingFrequencyDays") as number[] | undefined) ?? [];
  const domainValue = watch("domain");
  // Suggestion only — never written to the form until the operator types it
  // themselves. See lib/content/brand.ts for why this can't be authoritative.
  const suggestedBrandName = useMemo(
    () => deriveBrandName(domainValue) ?? undefined,
    [domainValue],
  );

  const toggleDay = (day: number) => {
    const current = (getValues("postingFrequencyDays") as number[] | undefined) ?? [];
    const next = current.includes(day)
      ? current.filter((d) => d !== day)
      : [...current, day].sort((a, b) => a - b);

    setValue("postingFrequencyDays", next as CreateBlogInput["postingFrequencyDays"], {
      shouldValidate: true,
      shouldDirty: true,
    });
  };

  const onSubmit = (data: CreateBlogInput) => {
    // Clear opposite-platform credentials so a Shopify save doesn't
    // accidentally validate WordPress fields (and vice versa). The UI
    // only shows one platform's section at a time, but react-hook-form
    // keeps the unrendered fields in state at their default values.
    const isShopify = data.platform === "shopify";
    const cleaned: CreateBlogInput = {
      ...data,
      // WordPress fields — keep only when platform is WordPress
      wpUrl: isShopify ? undefined : data.wpUrl,
      wpUsername: isShopify ? undefined : data.wpUsername,
      wpAppPassword: isShopify ? undefined : data.wpAppPassword,
      // Shopify fields — keep only when platform is Shopify
      shopifyStoreUrl: !isShopify
        ? undefined
        : data.shopifyStoreUrl
          ? normalizeShopifyStoreUrl(data.shopifyStoreUrl)
          : data.shopifyStoreUrl,
      shopifyAdminApiToken: !isShopify ? undefined : data.shopifyAdminApiToken,
      shopifyClientId: !isShopify ? undefined : data.shopifyClientId,
      shopifyClientSecret: !isShopify ? undefined : data.shopifyClientSecret,
      // Force frequency to "weekly" — UI doesn't expose other options
      postingFrequency: "weekly",
    };

    startTransition(async () => {
      const toastId = toast.loading(
        mode === "create" ? "Creating blog…" : "Saving changes…",
      );

      try {
        const result =
          mode === "create"
            ? await createBlog(cleaned)
            : await updateBlog(blogId!, cleaned);

        if ("error" in result) {
          // Surface server-side validation details — without this, users
          // see "Validation failed" with no hint which field broke. Maps
          // Zod's flattened fieldErrors back onto the form so each
          // invalid field also shows its message inline.
          const details = (
            result as {
              details?: Partial<Record<keyof CreateBlogInput, string[]>>;
            }
          ).details;
          if (details && typeof details === "object") {
            const fieldEntries = Object.entries(details).filter(
              ([, msgs]) => Array.isArray(msgs) && msgs.length > 0,
            );
            for (const [field, msgs] of fieldEntries) {
              form.setError(field as Path<CreateBlogInput>, {
                type: "server",
                message: (msgs as string[])[0],
              });
            }
            if (fieldEntries.length > 0) {
              const summary = fieldEntries
                .map(([f, msgs]) => `${f}: ${(msgs as string[])[0]}`)
                .slice(0, 3)
                .join(" · ");
              toast.error(`${result.error} — ${summary}`, { id: toastId });
              return;
            }
          }
          toast.error(result.error, { id: toastId });
          return;
        }

        toast.success(mode === "create" ? "Blog created" : "Blog updated", {
          id: toastId,
        });

        if (mode === "create" && "id" in result) {
          router.push(`/blogs/${result.id}`);
        } else {
          router.push(`/blogs/${blogId}`);
        }
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Something went wrong",
          { id: toastId },
        );
      }
    });
  };

  const onInvalid = (errs: FieldErrors<CreateBlogInput>) => {
    console.warn("Validation blocked submit:", errs);
    toast.error("Please fix the highlighted fields before saving");
  };

  const handleTestShopify = async () => {
    const v = getValues();
    setTestResult({ kind: "testing" });

    const normalized = normalizeShopifyStoreUrl(v.shopifyStoreUrl || "");

    const res = await testShopifyConnection({
      storeUrl: normalized,
      authMode: "client_credentials",
      clientId: v.shopifyClientId,
      clientSecret: v.shopifyClientSecret,
    });

    if (res.success) {
      setValue("shopifyStoreUrl", normalized, { shouldValidate: true });
      setTestResult({ kind: "ok", message: res.message });
    } else {
      setTestResult({ kind: "err", message: res.message });
    }
  };

  const handlePushHomepageSeo = async () => {
    if (!blogId) return;
    const v = getValues();
    setHomepageSeoPushing(true);
    const toastId = toast.loading("Saving and pushing homepage SEO…");
    try {
      const res = await pushHomepageSeo(blogId, {
        metaTitle: v.homepageMetaTitle,
        metaDescription: v.homepageMetaDescription,
      });
      if (res.success) {
        toast.success(res.message, { id: toastId });
      } else {
        toast.error(res.message, { id: toastId });
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to push homepage SEO",
        { id: toastId },
      );
    } finally {
      setHomepageSeoPushing(false);
    }
  };

  const errorCount = Object.keys(errors).length;

  return (
    <form
      onSubmit={handleSubmit(onSubmit, onInvalid)}
      className="space-y-6"
      noValidate
    >
      {/* Validation summary */}
      {errorCount > 0 && (
        <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-destructive">
              {errorCount === 1
                ? "1 field needs attention"
                : `${errorCount} fields need attention`}
            </p>
            <ul className="list-disc pl-5 text-xs text-destructive/90">
              {Object.entries(errors).map(([field, err]) => (
                <li key={field}>
                  <span className="font-mono">{field}</span>:{" "}
                  {(err as { message?: string })?.message ?? "invalid"}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Identity */}
      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
          <CardDescription>Basic blog identification</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="clientId">Client</Label>
            <Select
              value={watch("clientId")}
              onValueChange={(v) =>
                setValue("clientId", v, { shouldValidate: true })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a client" />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.clientId && (
              <p className="text-xs text-destructive">
                {errors.clientId.message}
              </p>
            )}
          </div>

          <Field
            label="Domain"
            name="domain"
            placeholder="example.com"
            register={register}
            errors={errors}
          />

          <div className="space-y-1.5">
            <Label htmlFor="status">Status</Label>
            <Select
              value={watch("status")}
              onValueChange={(v) =>
                setValue("status", v as CreateBlogInput["status"], {
                  shouldValidate: true,
                })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="paused">Paused</SelectItem>
                <SelectItem value="setup">Setup</SelectItem>
                <SelectItem value="decommissioned">Decommissioned</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Platform */}
      <Card>
        <CardHeader>
          <CardTitle>Platform</CardTitle>
          <CardDescription>
            Choose the CMS this blog publishes to
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() =>
                setValue("platform", "wordpress", { shouldValidate: true })
              }
              className={`flex flex-col items-start gap-1 rounded-lg border-2 p-4 text-left transition-colors ${
                platform === "wordpress"
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50"
              }`}
            >
              <span className="font-medium">WordPress</span>
              <span className="text-xs text-muted-foreground">
                Self-hosted or WP.com via REST API + Application Password
              </span>
            </button>
            <button
              type="button"
              onClick={() =>
                setValue("platform", "shopify", { shouldValidate: true })
              }
              className={`flex flex-col items-start gap-1 rounded-lg border-2 p-4 text-left transition-colors ${
                platform === "shopify"
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50"
              }`}
            >
              <span className="font-medium">Shopify</span>
              <span className="text-xs text-muted-foreground">
                Shopify store blog via Admin API
              </span>
            </button>
          </div>
        </CardContent>
      </Card>

      {/* WordPress */}
      {platform === "wordpress" && (
        <Card>
          <CardHeader>
            <CardTitle>WordPress Credentials</CardTitle>
            <CardDescription>
              Generate an Application Password under Users → Profile →
              Application Passwords.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <Field
              label="WordPress URL"
              name="wpUrl"
              placeholder="https://example.com"
              register={register}
              errors={errors}
            />
            <Field
              label="WP Username"
              name="wpUsername"
              placeholder="admin"
              register={register}
              errors={errors}
            />
            <Field
              label="WP Application Password"
              name="wpAppPassword"
              type="password"
              placeholder="xxxx xxxx xxxx xxxx"
              register={register}
              errors={errors}
            />
            <div className="space-y-1.5">
              <Label htmlFor="seoPlugin">SEO Plugin</Label>
              <Select
                value={watch("seoPlugin")}
                onValueChange={(v) =>
                  setValue("seoPlugin", v as CreateBlogInput["seoPlugin"], {
                    shouldValidate: true,
                  })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select SEO plugin" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="yoast">Yoast SEO</SelectItem>
                  <SelectItem value="rankmath">Rank Math</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Shopify */}
      {platform === "shopify" && (
        <Card>
          <CardHeader>
            <CardTitle>Shopify Credentials</CardTitle>
            <CardDescription>
              Create an app in Shopify&apos;s Dev Dashboard (Settings → Apps →
              Develop apps → Build apps in Dev Dashboard) and enable these
              Admin API scopes:
              <span className="mt-1 block">
                <strong>read_content</strong>, <strong>write_content</strong>{" "}
                (blog posts, pages &amp; their SEO meta) ·{" "}
                <strong>read_files</strong>, <strong>write_files</strong>{" "}
                (upload article images to the CDN) ·{" "}
                <strong>read_themes</strong>, <strong>write_themes</strong>,{" "}
                <strong>write_theme_code</strong> (SEO theme fixes — OG /
                JSON-LD injection).
              </span>
              <span className="mt-1 block">
                Install the app, then copy the Client ID and Client Secret from
                app Settings. After changing scopes later, reinstall the app so
                the new access token includes them.
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Store URL"
                name="shopifyStoreUrl"
                placeholder="mystore.myshopify.com"
                register={register}
                errors={errors}
              />
              <Field
                label="Client ID"
                name="shopifyClientId"
                placeholder="1a2b3c4d…"
                register={register}
                errors={errors}
              />
              <Field
                label="Client Secret"
                name="shopifyClientSecret"
                type="password"
                placeholder="shpss_xxxxxxxxxxxxxxxx"
                register={register}
                errors={errors}
              />
            </div>

            {/* Test connection */}
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleTestShopify}
                disabled={testResult.kind === "testing"}
              >
                {testResult.kind === "testing" && (
                  <Loader2 className="mr-2 size-3.5 animate-spin" />
                )}
                Test connection
              </Button>
              {testResult.kind === "ok" && (
                <span className="flex items-center gap-1.5 text-xs text-green-600">
                  <CheckCircle2 className="size-3.5" />
                  {testResult.message}
                </span>
              )}
              {testResult.kind === "err" && (
                <span className="flex items-center gap-1.5 text-xs text-destructive">
                  <XCircle className="size-3.5" />
                  {testResult.message}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Posting Config */}
      <Card>
        <CardHeader>
          <CardTitle>Posting Configuration</CardTitle>
          <CardDescription>
            Weekly schedule — pick which days posts should go out.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <Label>Frequency</Label>
              <span className="text-xs text-muted-foreground">
                Weekly (fixed)
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              All blogs run on a weekly cadence. Use the picker below to choose
              which days of the week to publish on.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Posting Days</Label>
            <div className="flex flex-wrap gap-2">
              {DAYS_OF_WEEK.map((day) => {
                const isSelected = selectedDays.includes(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    onClick={() => toggleDay(day.value)}
                    aria-pressed={isSelected}
                    aria-label={day.full}
                    className={`min-w-14 rounded-md border-2 px-3 py-2 text-sm font-medium transition-colors ${
                      isSelected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background hover:border-primary/50"
                    }`}
                  >
                    {day.label}
                  </button>
                );
              })}
            </div>
            {selectedDays.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No days selected — this blog won&apos;t be auto-scheduled.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {selectedDays.length} day{selectedDays.length === 1 ? "" : "s"}{" "}
                selected:{" "}
                {selectedDays
                  .map(
                    (d) =>
                      DAYS_OF_WEEK.find((x) => x.value === d)?.full ?? "",
                  )
                  .filter(Boolean)
                  .join(", ")}
              </p>
            )}
            {errors.postingFrequencyDays && (
              <p className="text-xs text-destructive">
                {(errors.postingFrequencyDays as { message?: string })?.message}
              </p>
            )}
          </div>

          {/* Hidden field — frequency is always "weekly" */}
          <input type="hidden" {...register("postingFrequency")} value="weekly" />
        </CardContent>
      </Card>

      {/* Local Targeting */}
      <Card>
        <CardHeader>
          <CardTitle>Local Targeting</CardTitle>
          <CardDescription>
            Leave City blank to keep this blog on ordinary topic ideation.
            Setting a City switches it to keyword+city targeted content once
            that path is live — see the local keyword content plan.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            label="City"
            name="city"
            placeholder="e.g. Montreal"
            register={register}
            errors={errors}
          />
          <Field
            label="Region / Province / State"
            name="region"
            placeholder="e.g. Quebec"
            register={register}
            errors={errors}
          />
          <Field
            label="Country Code"
            name="countryCode"
            placeholder="e.g. CA"
            register={register}
            errors={errors}
          />
          <Field
            label="Brand Name"
            name="brandName"
            placeholder={suggestedBrandName ?? "e.g. Montreal Peptides"}
            register={register}
            errors={errors}
          />
        </CardContent>
      </Card>

      {/* Homepage SEO (Shopify) */}
      <Card>
        <CardHeader>
          <CardTitle>Homepage SEO</CardTitle>
          <CardDescription>
            {platform === "shopify"
              ? "Sets the storefront homepage's <title> and meta description — Shopify's global.title_tag / description_tag metafields (Online Store → Preferences → Homepage)."
              : "Shopify only for now — for WordPress, set this in your SEO plugin's Homepage tab (Yoast/RankMath → Search Appearance)."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field
            label="Homepage Meta Title"
            name="homepageMetaTitle"
            placeholder="e.g. Buy Peptides Online | Montreal Peptides"
            register={register}
            errors={errors}
          />
          <div className="space-y-1.5">
            <Label htmlFor="homepageMetaDescription">Homepage Meta Description</Label>
            <Textarea
              id="homepageMetaDescription"
              rows={3}
              placeholder="e.g. Montreal Peptides ships research peptides across Canada with same-day tracking..."
              {...register("homepageMetaDescription")}
            />
            {errors.homepageMetaDescription && (
              <p className="text-xs text-destructive">
                {(errors.homepageMetaDescription as { message?: string })?.message}
              </p>
            )}
          </div>
          {mode === "edit" && blogId && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handlePushHomepageSeo}
              disabled={homepageSeoPushing || platform !== "shopify"}
            >
              {homepageSeoPushing && (
                <Loader2 className="mr-2 size-4 animate-spin" />
              )}
              Save &amp; push to Shopify
            </Button>
          )}
          {mode === "create" && (
            <p className="text-xs text-muted-foreground">
              Save the blog first, then push homepage SEO from its detail page.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Notes */}
      <Card>
        <CardHeader>
          <CardTitle>Internal Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            placeholder="Internal notes about this blog..."
            rows={4}
            {...register("notesInternal")}
          />
        </CardContent>
      </Card>

      <Separator />

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={isPending}>
          {isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
          {mode === "create" ? "Create Blog" : "Save Changes"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => router.back()}
          disabled={isPending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}