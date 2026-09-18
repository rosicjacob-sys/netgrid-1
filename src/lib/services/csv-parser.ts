import type { SeoPlugin } from "@/lib/types";
import {
  buildPostingPlan,
  planForPostsPerDay,
  planForPostsPerWeek,
  postsPerWeek,
  MAX_POSTS_PER_DAY,
  MAX_POSTS_PER_WEEK,
  WEEKLY_SPREAD,
} from "@/lib/posting-plan";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BlogInsert {
  clientId: string;
  domain: string;
  wpUrl: string | null;
  wpUsername: string | null;
  wpAppPassword: string | null;
  seoPlugin: SeoPlugin;
  /** Canonical cadence, integer[7]. See src/lib/posting-plan.ts. */
  postingPlan: number[];
  status: "setup";
}

export interface CsvError {
  row: number;
  field: string;
  message: string;
}

export interface CsvParseResult {
  valid: BlogInsert[];
  errors: CsvError[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const REQUIRED_COLUMNS = [
  "domain",
  "wp_url",
  "wp_username",
  "wp_app_password",
  "seo_plugin",
] as const;

// Cadence columns. At least one of posting_days / posting_frequency must be
// present in the header; posts_per_day is always optional.
const CADENCE_COLUMNS = [
  "posting_days",
  "posting_frequency",
  "posts_per_day",
] as const;

const KNOWN_COLUMNS = [...REQUIRED_COLUMNS, ...CADENCE_COLUMNS] as const;

const DOMAIN_REGEX = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const URL_REGEX = /^https?:\/\/.+/;
const VALID_SEO_PLUGINS: SeoPlugin[] = ["yoast", "rankmath", "none"];

// Weekday names accepted in the posting_days column.
const DAY_TOKENS: Record<string, number> = {
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
  sun: 7, sunday: 7,
};

// posting_frequency must state its unit. Anchored on purpose: the old
// publisher used an UNANCHORED /...day/i search, so "2 posts per day, 5 days
// per week" silently became 14 posts/week.
const PER_DAY_RE = /^(\d+)\s*(?:x|\/|\s)*(?:posts?\s*)?(?:per\s*)?day$/i;
const PER_WEEK_RE = /^(\d+)\s*(?:x|\/|\s)*(?:posts?\s*)?(?:per\s*)?week$/i;
const BARE_NUMBER_RE = /^\d+$/;

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        fields.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

function validateDomain(value: string): boolean {
  return DOMAIN_REGEX.test(value);
}

function validateUrl(value: string): boolean {
  if (!value) return true; // optional
  return URL_REGEX.test(value);
}

function validateSeoPlugin(value: string): value is SeoPlugin {
  return VALID_SEO_PLUGINS.includes(value as SeoPlugin);
}

type CadenceResult = { plan: number[] } | { error: string };

/**
 * Turn the three cadence cells into a canonical posting plan, or into the
 * exact message the operator needs to fix their sheet.
 *
 * Nothing here guesses. A cell that could mean two different schedules is an
 * error, because the person who wrote it is right here and can be asked.
 *
 * NOTE the deliberate split with migration 0043: the migration interprets a
 * historical bare number as posts-per-WEEK because that data already exists
 * and cannot be re-asked. An import is a live human, so it is refused here.
 */
function parseCadence(
  postingDaysRaw: string,
  postsPerDayRaw: string,
  postingFrequencyRaw: string,
): CadenceResult {
  // posts_per_day first — it modifies the posting_days branch below.
  let perDay = 1;
  const ppd = postsPerDayRaw.trim();
  if (ppd) {
    if (!BARE_NUMBER_RE.test(ppd)) {
      return {
        error: `Invalid posts_per_day "${ppd}" — use a whole number between 1 and ${MAX_POSTS_PER_DAY}`,
      };
    }
    perDay = parseInt(ppd, 10);
    if (perDay < 1 || perDay > MAX_POSTS_PER_DAY) {
      return {
        error: `posts_per_day "${ppd}" is out of range — use 1 to ${MAX_POSTS_PER_DAY}`,
      };
    }
  }

  // 1. posting_days wins whenever it is filled in.
  const daysCell = postingDaysRaw.trim();
  if (daysCell) {
    const tokens = daysCell.split(/[,;/|\s]+/).filter(Boolean);
    const days: number[] = [];
    for (const tok of tokens) {
      const d = DAY_TOKENS[tok.toLowerCase()];
      if (!d) {
        return {
          error: `Invalid posting day "${tok}" — use Mon, Tue, Wed, Thu, Fri, Sat or Sun`,
        };
      }
      days.push(d);
    }
    const plan = buildPostingPlan(days, perDay);
    const weekly = postsPerWeek(plan);
    if (weekly > MAX_POSTS_PER_WEEK) {
      return {
        error: `That schedule is ${weekly} posts/week; the maximum is ${MAX_POSTS_PER_WEEK}`,
      };
    }
    return { plan };
  }

  // 2. posting_frequency, which must state its unit.
  const freq = postingFrequencyRaw.trim();
  if (!freq) {
    return {
      error:
        'posting_frequency is required — use "N per week", "N per day", "weekly", "daily", or fill in a posting_days column (e.g. "Mon Wed Fri")',
    };
  }

  const perDayMatch = freq.match(PER_DAY_RE);
  if (perDayMatch) {
    const n = parseInt(perDayMatch[1], 10);
    const plan = planForPostsPerDay(n);
    if (!plan) {
      return {
        error: `posting_frequency "${freq}" asks for ${n} posts/day; the maximum is ${MAX_POSTS_PER_DAY}`,
      };
    }
    if (postsPerWeek(plan) > MAX_POSTS_PER_WEEK) {
      return {
        error: `posting_frequency "${freq}" is ${postsPerWeek(plan)} posts/week; the maximum is ${MAX_POSTS_PER_WEEK}`,
      };
    }
    return { plan };
  }

  const perWeekMatch = freq.match(PER_WEEK_RE);
  if (perWeekMatch) {
    const n = parseInt(perWeekMatch[1], 10);
    const plan = planForPostsPerWeek(n);
    if (!plan) {
      return {
        error: `posting_frequency "${freq}" cannot be scheduled — more than 7 posts/week must be written as "N per day"`,
      };
    }
    return { plan };
  }

  const lower = freq.toLowerCase();
  if (lower === "weekly") return { plan: buildPostingPlan(WEEKLY_SPREAD[1], 1) };
  if (lower === "daily") return { plan: buildPostingPlan(WEEKLY_SPREAD[7], 1) };

  if (BARE_NUMBER_RE.test(freq)) {
    return {
      error:
        `posting_frequency "${freq}" is ambiguous — it used to be read as ${freq} posts per DAY ` +
        `(${parseInt(freq, 10) * 7}/week). Write "${freq} per week" or "${freq} per day".`,
    };
  }

  return {
    error: `Unrecognised posting_frequency "${freq}" — use "N per week", "N per day", "weekly", "daily", or a posting_days column`,
  };
}

// ─── Parser ─────────────────────────────────────────────────────────────────

/**
 * Parse a CSV string into validated blog insert records.
 * Returns valid rows ready for database insertion and any validation errors.
 */
export function parseBlogCsv(csvContent: string, clientId: string): CsvParseResult {
  const lines = csvContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) {
    return {
      valid: [],
      errors: [{ row: 0, field: "file", message: "CSV must have a header row and at least one data row" }],
    };
  }

  // Parse and validate header
  const headerLine = lines[0];
  const headers = parseCSVLine(headerLine).map((h) => h.toLowerCase().trim());

  const missingColumns = REQUIRED_COLUMNS.filter((col) => !headers.includes(col));
  if (missingColumns.length > 0) {
    return {
      valid: [],
      errors: [
        {
          row: 0,
          field: "header",
          message: `Missing required columns: ${missingColumns.join(", ")}`,
        },
      ],
    };
  }

  // Cadence is mandatory, but either column may supply it.
  if (!headers.includes("posting_days") && !headers.includes("posting_frequency")) {
    return {
      valid: [],
      errors: [
        {
          row: 0,
          field: "header",
          message:
            'Missing cadence column: add "posting_days" (e.g. "Mon Wed Fri") or "posting_frequency" (e.g. "3 per week")',
        },
      ],
    };
  }

  // Build column index map. Absent optional columns map to -1.
  const colIndex: Record<string, number> = {};
  for (const col of KNOWN_COLUMNS) {
    colIndex[col] = headers.indexOf(col);
  }

  const valid: BlogInsert[] = [];
  const errors: CsvError[] = [];

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const rowNum = i + 1; // 1-based, accounting for header
    const fields = parseCSVLine(lines[i]);
    const rowErrors: CsvError[] = [];

    // idx >= 0 guard matters now that columns are optional: indexOf returns
    // -1 for an absent column, and fields[-1] is undefined.
    const getValue = (col: string): string => {
      const idx = colIndex[col];
      return idx !== undefined && idx >= 0 && idx < fields.length
        ? fields[idx].trim()
        : "";
    };

    const domain = getValue("domain");
    const wpUrl = getValue("wp_url");
    const wpUsername = getValue("wp_username");
    const wpAppPassword = getValue("wp_app_password");
    const seoPluginRaw = getValue("seo_plugin").toLowerCase() || "none";

    // Validate domain (required)
    if (!domain) {
      rowErrors.push({ row: rowNum, field: "domain", message: "Domain is required" });
    } else if (!validateDomain(domain)) {
      rowErrors.push({ row: rowNum, field: "domain", message: `Invalid domain format: ${domain}` });
    }

    // Validate wp_url
    if (wpUrl && !validateUrl(wpUrl)) {
      rowErrors.push({ row: rowNum, field: "wp_url", message: `Invalid URL format: ${wpUrl}` });
    }

    // Validate seo_plugin
    if (!validateSeoPlugin(seoPluginRaw)) {
      rowErrors.push({
        row: rowNum,
        field: "seo_plugin",
        message: `Invalid SEO plugin: ${seoPluginRaw}. Must be yoast, rankmath, or none`,
      });
    }

    // Validate cadence. An un-schedulable row is rejected here rather than
    // imported as a blog that can never publish.
    const cadence = parseCadence(
      getValue("posting_days"),
      getValue("posts_per_day"),
      getValue("posting_frequency"),
    );
    if ("error" in cadence) {
      rowErrors.push({
        row: rowNum,
        field: headers.includes("posting_days") ? "posting_days" : "posting_frequency",
        message: cadence.error,
      });
    }

    if (rowErrors.length > 0 || "error" in cadence) {
      errors.push(...rowErrors);
    } else {
      valid.push({
        clientId,
        domain,
        wpUrl: wpUrl || null,
        wpUsername: wpUsername || null,
        wpAppPassword: wpAppPassword || null,
        seoPlugin: seoPluginRaw as SeoPlugin,
        postingPlan: cadence.plan,
        status: "setup",
      });
    }
  }

  return { valid, errors };
}
