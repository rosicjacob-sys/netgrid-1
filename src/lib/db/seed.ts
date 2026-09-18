/**
 * Database seed script — populates users, clients, and sample blogs.
 *
 * Run from project root:
 *   set DATABASE_URL=postgres://...    (Windows cmd)
 *   npx tsx src/lib/db/seed.ts
 *
 * Idempotent: skips rows that already exist (matched by unique field).
 */

import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { users, clients, blogs } from "./schema";
import { buildPostingPlan } from "../posting-plan";

const ADMIN_EMAIL = "admin@netgrid.app";
const ADMIN_PASSWORD = "admin123";

async function seedAdmin() {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, ADMIN_EMAIL));

  if (existing) {
    console.log(`  [skip] admin user ${ADMIN_EMAIL} already exists`);
    return existing.id;
  }

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  const [row] = await db
    .insert(users)
    .values({
      email: ADMIN_EMAIL,
      name: "Admin User",
      passwordHash,
      role: "super_admin",
    })
    .returning({ id: users.id });

  console.log(`  [new]  admin → ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  return row.id;
}

const SAMPLE_CLIENTS = [
  {
    name: "Acme SaaS Inc",
    contactName: "Jane Doe",
    contactEmail: "jane@acmesaas.com",
    contactPhone: "+1-555-0101",
    niche: "SaaS",
    totalBlogsTarget: 10,
    status: "active" as const,
    notesInternal: "Premium plan — VIP support priority.",
  },
  {
    name: "BrightStore Commerce",
    contactName: "Mark Lee",
    contactEmail: "mark@brightstore.com",
    contactPhone: "+1-555-0202",
    niche: "E-commerce",
    totalBlogsTarget: 5,
    status: "active" as const,
  },
  {
    name: "VitalityHealth Co",
    contactName: "Sarah Chen",
    contactEmail: "sarah@vitality.health",
    contactPhone: "+1-555-0303",
    niche: "Health & Wellness",
    totalBlogsTarget: 8,
    status: "onboarding" as const,
    notesInternal: "New client — onboarding in progress. Setup fee pending.",
  },
  {
    name: "FinanceForward",
    contactName: "Tom Wilson",
    contactEmail: "tom@financeforward.io",
    contactPhone: "+1-555-0404",
    niche: "Finance",
    totalBlogsTarget: 3,
    status: "active" as const,
    notesInternal: "Payment 30 days overdue. Follow up with Tom.",
  },
  {
    name: "Wanderlust Travel",
    contactName: "Emma Rodriguez",
    contactEmail: "emma@wanderlust.travel",
    contactPhone: "+1-555-0505",
    niche: "Travel",
    totalBlogsTarget: 6,
    status: "paused" as const,
    notesInternal: "Paused for seasonal slow period; resume in June.",
  },
];

async function seedClients() {
  const clientIds: Record<string, string> = {};

  for (const client of SAMPLE_CLIENTS) {
    const [existing] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.name, client.name));

    if (existing) {
      console.log(`  [skip] client ${client.name}`);
      clientIds[client.name] = existing.id;
      continue;
    }

    const [row] = await db
      .insert(clients)
      .values(client)
      .returning({ id: clients.id });

    clientIds[client.name] = row.id;
    console.log(`  [new]  client ${client.name}`);
  }

  return clientIds;
}

async function seedClientUsers(clientIds: Record<string, string>) {
  const portalUsers = [
    {
      email: "jane@acmesaas.com",
      name: "Jane Doe",
      clientName: "Acme SaaS Inc",
    },
    {
      email: "mark@brightstore.com",
      name: "Mark Lee",
      clientName: "BrightStore Commerce",
    },
  ];

  for (const u of portalUsers) {
    const clientId = clientIds[u.clientName];
    if (!clientId) continue;

    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, u.email));

    if (existing) {
      console.log(`  [skip] portal user ${u.email}`);
      continue;
    }

    await db.insert(users).values({
      email: u.email,
      name: u.name,
      role: "client",
      clientId,
    });
    console.log(`  [new]  portal user ${u.email} (magic-link only)`);
  }
}

async function seedBlogs(clientIds: Record<string, string>) {
  const sampleBlogs = [
    {
      clientName: "Acme SaaS Inc",
      domain: "acme-insights.com",
      platform: "wordpress" as const,
      wpUrl: "https://acme-insights.com",
      seoPlugin: "yoast" as const,
      // ISO weekdays (1=Mon … 7=Sun) — "3x per week" → Mon, Wed, Fri
      postingPlan: buildPostingPlan([1, 3, 5]),
      status: "active" as const,
    },
    {
      clientName: "Acme SaaS Inc",
      domain: "acme-devblog.io",
      platform: "wordpress" as const,
      wpUrl: "https://acme-devblog.io",
      seoPlugin: "rankmath" as const,
      // "Weekly" → once per week on Wednesday
      postingPlan: buildPostingPlan([3]),
      status: "active" as const,
    },
    {
      clientName: "BrightStore Commerce",
      domain: "brightstore-guide.shop",
      platform: "shopify" as const,
      shopifyStoreUrl: "brightstore.myshopify.com",
      // "2x per week" → Tue + Thu
      postingPlan: buildPostingPlan([2, 4]),
      status: "active" as const,
    },
    {
      clientName: "VitalityHealth Co",
      domain: "vitality-wellness.co",
      platform: "wordpress" as const,
      wpUrl: "https://vitality-wellness.co",
      seoPlugin: "yoast" as const,
      // "Weekly" → once per week on Tuesday
      postingPlan: buildPostingPlan([2]),
      status: "setup" as const,
    },
  ];

  for (const blog of sampleBlogs) {
    const clientId = clientIds[blog.clientName];
    if (!clientId) continue;

    const [existing] = await db
      .select({ id: blogs.id })
      .from(blogs)
      .where(eq(blogs.domain, blog.domain));

    if (existing) {
      console.log(`  [skip] blog ${blog.domain}`);
      continue;
    }

    const { clientName: _clientName, ...rest } = blog;
    void _clientName;
    await db.insert(blogs).values({ clientId, ...rest });
    console.log(`  [new]  blog ${blog.domain}`);
  }
}

async function main() {
  console.log("→ Seeding admin user");
  await seedAdmin();

  console.log("→ Seeding clients");
  const clientIds = await seedClients();

  console.log("→ Seeding portal users");
  await seedClientUsers(clientIds);

  console.log("→ Seeding sample blogs");
  await seedBlogs(clientIds);

  console.log("\nDone. Log in at /login with:");
  console.log(`  email:    ${ADMIN_EMAIL}`);
  console.log(`  password: ${ADMIN_PASSWORD}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
