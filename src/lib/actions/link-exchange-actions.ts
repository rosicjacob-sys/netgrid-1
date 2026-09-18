"use server";

import { db } from "@/lib/db";
import {
  blogs,
  clients,
  linkExchangeEdges,
  linkExchangeLoops,
} from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/helpers";
import { alias } from "drizzle-orm/pg-core";
import { desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

/**
 * Opt a client OUT of the retired link-exchange network (T03).
 *
 * Enabling is refused: the engine is retired and setting the flag would do
 * nothing except mislead whoever set it. Leaving a switch in the UI that
 * silently does nothing is a trap for the next operator, so this fails loudly
 * instead. The caller (components/link-exchange/client-opt-in-toggle.tsx)
 * already reverts the switch and toasts the message on `success: false`, so no
 * component change is needed.
 *
 * Disabling still works, so the flag can be cleaned up by hand.
 */
export async function setClientLinkExchange(
  clientId: string,
  enabled: boolean,
): Promise<{ success: boolean; message: string }> {
  await requireAdmin();

  if (enabled) {
    return {
      success: false,
      message:
        "The link exchange is retired and cannot be re-enabled from the UI.",
    };
  }

  await db
    .update(clients)
    .set({ linkExchangeEnabled: false, updatedAt: new Date() })
    .where(eq(clients.id, clientId));
  revalidatePath("/link-exchange");
  return { success: true, message: "Client removed from the network" };
}

export interface LinkExchangeEdgeRow {
  id: string;
  loopId: string;
  position: number;
  sourceDomain: string;
  targetDomain: string;
  anchorText: string;
  anchorType: string;
  status: string;
  targetUrl: string | null;
  failureReason: string | null;
}

export interface LinkExchangeOverview {
  clients: Array<{
    id: string;
    name: string;
    status: string | null;
    enabled: boolean;
  }>;
  loops: Array<{
    id: string;
    niche: string | null;
    clientName: string;
    edges: LinkExchangeEdgeRow[];
  }>;
  stats: {
    enabledClients: number;
    activeLoops: number;
    edgesPlaced: number;
    edgesPending: number;
  };
}

export async function getLinkExchangeOverview(): Promise<LinkExchangeOverview> {
  await requireAdmin();

  const clientRows = await db
    .select({
      id: clients.id,
      name: clients.name,
      status: clients.status,
      enabled: clients.linkExchangeEnabled,
    })
    .from(clients)
    .orderBy(clients.name);

  const sourceBlog = alias(blogs, "source_blog");
  const targetBlog = alias(blogs, "target_blog");

  const edgeRows = await db
    .select({
      id: linkExchangeEdges.id,
      loopId: linkExchangeEdges.loopId,
      niche: linkExchangeLoops.niche,
      clientName: clients.name,
      position: linkExchangeEdges.position,
      sourceDomain: sourceBlog.domain,
      targetDomain: targetBlog.domain,
      anchorText: linkExchangeEdges.anchorText,
      anchorType: linkExchangeEdges.anchorType,
      status: linkExchangeEdges.status,
      targetUrl: linkExchangeEdges.targetUrl,
      failureReason: linkExchangeEdges.failureReason,
    })
    .from(linkExchangeEdges)
    .innerJoin(linkExchangeLoops, eq(linkExchangeEdges.loopId, linkExchangeLoops.id))
    .innerJoin(sourceBlog, eq(linkExchangeEdges.sourceBlogId, sourceBlog.id))
    .innerJoin(targetBlog, eq(linkExchangeEdges.targetBlogId, targetBlog.id))
    .innerJoin(clients, eq(sourceBlog.clientId, clients.id))
    .where(eq(linkExchangeLoops.status, "active"))
    .orderBy(desc(linkExchangeLoops.createdAt), linkExchangeEdges.position);

  const loopMap = new Map<
    string,
    { id: string; niche: string | null; clientName: string; edges: LinkExchangeEdgeRow[] }
  >();
  for (const r of edgeRows) {
    let loop = loopMap.get(r.loopId);
    if (!loop) {
      loop = { id: r.loopId, niche: r.niche, clientName: r.clientName, edges: [] };
      loopMap.set(r.loopId, loop);
    }
    loop.edges.push({
      id: r.id,
      loopId: r.loopId,
      position: r.position,
      sourceDomain: r.sourceDomain,
      targetDomain: r.targetDomain,
      anchorText: r.anchorText,
      anchorType: r.anchorType,
      status: r.status,
      targetUrl: r.targetUrl,
      failureReason: r.failureReason,
    });
  }

  const [{ placed, pending }] = await db
    .select({
      placed: sql<number>`count(*) filter (where ${linkExchangeEdges.status} = 'placed')::int`,
      pending: sql<number>`count(*) filter (where ${linkExchangeEdges.status} = 'pending')::int`,
    })
    .from(linkExchangeEdges);

  return {
    clients: clientRows.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      enabled: c.enabled,
    })),
    loops: Array.from(loopMap.values()),
    stats: {
      enabledClients: clientRows.filter((c) => c.enabled).length,
      activeLoops: loopMap.size,
      edgesPlaced: placed ?? 0,
      edgesPending: pending ?? 0,
    },
  };
}
