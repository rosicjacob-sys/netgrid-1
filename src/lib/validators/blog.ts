import { z } from "zod";
import { MAX_POSTS_PER_DAY, MAX_POSTS_PER_WEEK } from "@/lib/posting-plan";

const domainRegex =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

// ─── Helpers ────────────────────────────────────────────────────────────────

const isValidUrl = (s: string): boolean => {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
};

// Optional string: pre-normalises empty strings / null / undefined to
// undefined BEFORE the inner schema runs. This avoids Zod 4's stricter
// behaviour around union+transform where "" was being rejected as
// "Invalid input" on optional fields the user left blank.
const optionalString = z.preprocess(
  (v) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") return v;
    const trimmed = v.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  },
  z.string().optional(),
);

// Optional string with a max length: same empty-friendly pattern, capped.
const optionalStringMax = (max: number, message: string) =>
  z.preprocess(
    (v) => {
      if (v === undefined || v === null) return undefined;
      if (typeof v !== "string") return v;
      const trimmed = v.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    },
    z.string().max(max, message).optional(),
  );

// Optional URL: same empty-friendly pattern; non-empty values must parse
// as a URL.
const optionalUrl = z.preprocess(
  (v) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") return v;
    const trimmed = v.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  },
  z
    .string()
    .refine((s) => isValidUrl(s), { message: "Must be a valid URL" })
    .optional(),
);

// Optional 2-letter country code: same empty-friendly pattern, uppercased
// before validation so "ca" and "CA" are equivalent.
const optionalCountryCode = z.preprocess(
  (v) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") return v;
    const trimmed = v.trim();
    return trimmed.length === 0 ? undefined : trimmed.toUpperCase();
  },
  z
    .string()
    .regex(/^[A-Z]{2}$/, "Use a 2-letter country code (e.g. CA, US)")
    .optional(),
);

// Posting days: array of ISO weekdays (1=Mon … 7=Sun), deduplicated and
// sorted ascending so the DB always sees a clean array.
//
// The three states are DISTINCT and must stay that way:
//   undefined → field absent from the payload → leave the stored plan alone
//   []        → operator explicitly cleared the schedule → write an empty plan
//   [1,3,5]   → Mon/Wed/Fri
//
// An invalid weekday is an error, not something to drop silently — dropping
// it is how a blog ends up with a schedule nobody chose.
const postingDays = z
  .union([z.array(z.union([z.string(), z.number()])), z.undefined(), z.null()])
  // Validation happens BEFORE the transform, not inside it: a failed check
  // short-circuits parsing, so the transform below only ever sees clean input.
  .superRefine((v, ctx) => {
    if (v === undefined || v === null) return;
    for (const x of v) {
      const n = typeof x === "number" ? x : Number(x);
      if (!Number.isInteger(n) || n < 1 || n > 7) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid posting day "${String(x)}" — use 1 (Mon) through 7 (Sun)`,
        });
      }
    }
  })
  .transform((v) => {
    if (v === undefined) return undefined;
    if (v === null) return [] as number[];
    const nums = v.map((x) => (typeof x === "number" ? x : Number(x)));
    return Array.from(new Set<number>(nums)).sort((a, b) => a - b);
  });

// Posts published on each selected day. Blank/absent means 1.
const postsPerDayField = z
  .union([z.string(), z.number(), z.undefined(), z.null()])
  .transform((v) => {
    if (v === undefined || v === null || v === "") return 1;
    return typeof v === "number" ? v : Number(v);
  })
  .refine((v) => Number.isInteger(v) && v >= 1 && v <= MAX_POSTS_PER_DAY, {
    message: `Posts per day must be a whole number between 1 and ${MAX_POSTS_PER_DAY}`,
  });

// ─── Create Schema ──────────────────────────────────────────────────────────

export const createBlogSchema = z
  .object({
    clientId: z.string().uuid("Invalid client ID"),
    domain: z
      .string()
      .min(1, "Domain is required")
      .regex(domainRegex, "Invalid domain format (e.g. example.com)"),

    platform: z.enum(["wordpress", "shopify"]).default("wordpress"),

    // WordPress fields
    wpUrl: optionalUrl,
    wpUsername: optionalString,
    wpAppPassword: optionalString,
    seoPlugin: z.enum(["yoast", "rankmath", "none"]).optional().default("none"),

    // Shopify fields — apiVersion + blogId removed (locked to defaults
    // internally; not user-configurable any more).
    shopifyAuthMode: z
      .enum(["legacy_token", "client_credentials"])
      .optional()
      .default("client_credentials"),
    shopifyStoreUrl: optionalString.refine(
      (v) =>
        v === undefined ||
        /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(v) ||
        /^https?:\/\//i.test(v),
      { message: "Use format: mystore.myshopify.com" },
    ),
    shopifyAdminApiToken: optionalString,
    shopifyClientId: optionalString,
    shopifyClientSecret: optionalString,

    // Posting cadence. These two fields are combined into the canonical
    // blogs.posting_plan by buildPostingPlan() in blog-actions.ts. The
    // legacy postingFrequency string is gone — it meant posts-per-DAY to
    // the publisher and nothing at all to anybody else.
    postingDays: postingDays,
    postsPerDay: postsPerDayField,

    status: z
      .enum(["active", "paused", "setup", "decommissioned"])
      .optional()
      .default("setup"),
    notesInternal: optionalString,

    // Local keyword-targeted content (see docs/local-keyword-content-plan.md).
    // city is the feature's on/off switch — leave it blank to keep this blog
    // on the ordinary topic-ideation flow. Always operator-entered; the form
    // only ever *suggests* a brand name from the domain, never the city.
    city: optionalString,
    region: optionalString,
    countryCode: optionalCountryCode,
    brandName: optionalString,

    // Shopify homepage SEO — pushed to the shop's global.title_tag /
    // global.description_tag metafields. Capped to what those fields render
    // usefully as (Google truncates well before either limit anyway).
    homepageMetaTitle: optionalStringMax(70, "Keep it under 70 characters"),
    homepageMetaDescription: optionalStringMax(320, "Keep it under 320 characters"),
  })
  .superRefine((data, ctx) => {
    // ── Cadence must be schedulable ──────────────────────────────────────
    // Enforced for every status, not just "active": a draft with an
    // impossible schedule becomes an unpublishable active blog the moment
    // someone flips the status, and nothing re-validates on that flip.
    const days = data.postingDays ?? [];
    const perDay = data.postsPerDay ?? 1;
    const weekly = days.length * perDay;
    if (weekly > MAX_POSTS_PER_WEEK) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["postsPerDay"],
        message: `That schedule is ${weekly} posts/week; the maximum is ${MAX_POSTS_PER_WEEK}`,
      });
    }
    // An ACTIVE blog with no posting days can never publish. That silence
    // is the defect this validation exists to prevent — refuse it at the
    // door rather than discovering it in a cron JSON body months later.
    if (data.status === "active" && days.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["postingDays"],
        message:
          "Pick at least one posting day — an active blog with no posting days will never publish",
      });
    }

    // Only enforce credentials when activating the blog AND only for the
    // selected platform. The form clears opposite-platform fields before
    // submission, but this guards against direct API callers too.
    if (data.status !== "active") return;

    if (data.platform === "wordpress") {
      if (!data.wpUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["wpUrl"],
          message: "WordPress URL is required to activate",
        });
      }
      if (!data.wpAppPassword) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["wpAppPassword"],
          message: "WordPress application password is required to activate",
        });
      }
    } else if (data.platform === "shopify") {
      if (!data.shopifyStoreUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["shopifyStoreUrl"],
          message: "Shopify store URL is required to activate",
        });
      }

      if (data.shopifyAuthMode === "legacy_token") {
        if (!data.shopifyAdminApiToken) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["shopifyAdminApiToken"],
            message: "Admin API token is required to activate",
          });
        }
      } else {
        if (!data.shopifyClientId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["shopifyClientId"],
            message: "Client ID is required to activate",
          });
        }
        if (!data.shopifyClientSecret) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["shopifyClientSecret"],
            message: "Client Secret is required to activate",
          });
        }
      }
    }
  });

// ─── Update Schema ──────────────────────────────────────────────────────────

export const updateBlogSchema = z.object({
  clientId: z.string().uuid("Invalid client ID").optional(),
  domain: z
    .string()
    .min(1, "Domain is required")
    .regex(domainRegex, "Invalid domain format (e.g. example.com)")
    .optional(),
  platform: z.enum(["wordpress", "shopify"]).optional(),

  wpUrl: optionalUrl,
  wpUsername: optionalString,
  wpAppPassword: optionalString,
  seoPlugin: z.enum(["yoast", "rankmath", "none"]).optional(),

  shopifyAuthMode: z.enum(["legacy_token", "client_credentials"]).optional(),
  shopifyStoreUrl: optionalString,
  shopifyAdminApiToken: optionalString,
  shopifyClientId: optionalString,
  shopifyClientSecret: optionalString,

  postingDays: postingDays,
  postsPerDay: postsPerDayField,
  status: z.enum(["active", "paused", "setup", "decommissioned"]).optional(),
  notesInternal: optionalString,

  city: optionalString,
  region: optionalString,
  countryCode: optionalCountryCode,
  brandName: optionalString,

  homepageMetaTitle: optionalStringMax(70, "Keep it under 70 characters"),
  homepageMetaDescription: optionalStringMax(320, "Keep it under 320 characters"),
}).superRefine((data, ctx) => {
  // Same cadence rules as createBlogSchema. postingDays === undefined here
  // means "not submitted" — leave the stored plan alone and skip the check.
  //
  // NOTE: attaching .superRefine turns updateBlogSchema into a ZodEffects.
  // safeParse still works (that is the only way it is used), but .partial(),
  // .pick() and .extend() no longer exist on it.
  if (data.postingDays === undefined) return;
  const days = data.postingDays;
  const perDay = data.postsPerDay ?? 1;
  const weekly = days.length * perDay;
  if (weekly > MAX_POSTS_PER_WEEK) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["postsPerDay"],
      message: `That schedule is ${weekly} posts/week; the maximum is ${MAX_POSTS_PER_WEEK}`,
    });
  }
  if (data.status === "active" && days.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["postingDays"],
      message:
        "Pick at least one posting day — an active blog with no posting days will never publish",
    });
  }
});

export type CreateBlogInput = z.infer<typeof createBlogSchema>;
export type UpdateBlogInput = z.infer<typeof updateBlogSchema>;
