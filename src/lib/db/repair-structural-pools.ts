/**
 * One-shot repair for style profiles assigned before the composer fix (T13).
 *
 *   1. structural_pool — every non-peptide profile was written with an empty
 *      array because buildStructuralPool filtered on subNicheFit at all three
 *      tiers and no template declares a sub-niche above 13. Peptide sub-niche
 *      13 got a one-element pool for the same reason. Both are rebuilt.
 *   2. skeleton_id — rows whose stored skeleton is now rejected by the voice
 *      or sub-niche guard (chiefly skeleton 11, which is peptide-only prose
 *      and declares subNiches [4, 10]) are re-picked.
 *
 * Run from the project root with DATABASE_URL set:
 *   npx tsx src/lib/db/repair-structural-pools.ts --dry-run
 *   npx tsx src/lib/db/repair-structural-pools.ts
 *
 * Idempotent — clean rows are skipped, so re-running is safe.
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import { styleProfiles } from "./schema";
import {
  buildStructuralPool,
  emptyNetworkState,
  pickSkeleton,
} from "../content/assignment/algorithm";
import { SeededRng } from "../content/assignment/draw-helpers";
import {
  isSkeletonCompatibleWithSubNiche,
  isSkeletonCompatibleWithVoice,
} from "../content/libraries/compatibility";
import type {
  CadenceId,
  ScrubberStrictness,
  SkeletonId,
  SubNicheId,
  TagSetId,
  VoiceId,
} from "../content/types";

const DRY_RUN = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const rows = await db.select().from(styleProfiles);

  let poolsFixed = 0;
  let skeletonsFixed = 0;
  const sample: string[] = [];

  for (const row of rows) {
    const updates: Partial<{ structuralPool: number[]; skeletonId: number }> = {};

    // 1. Structural pool
    const pool = row.structuralPool ?? [];
    if (pool.length < 3) {
      // Distinct seed suffix so the repair draw is deterministic and does not
      // simply replay the original (broken) sequence.
      const rng = new SeededRng(`${row.assignmentSeed ?? row.blogId}:pool-repair`);
      const rebuilt = buildStructuralPool(
        rng,
        row.voiceId as VoiceId,
        row.subNicheId as SubNicheId,
        row.tagSetId as TagSetId,
      );
      if (rebuilt.length >= 3) {
        updates.structuralPool = rebuilt;
        poolsFixed++;
      }
    }

    // 2. Skeleton — only the two HARD guards. Cadence and strictness are soft
    // gates at assign time, so an existing row failing only those is left
    // alone rather than churned.
    const skeletonId = row.skeletonId as SkeletonId;
    const skeletonOk =
      isSkeletonCompatibleWithVoice(skeletonId, row.voiceId as VoiceId) &&
      isSkeletonCompatibleWithSubNiche(skeletonId, row.subNicheId as SubNicheId);
    if (!skeletonOk) {
      const rng = new SeededRng(
        `${row.assignmentSeed ?? row.blogId}:skeleton-repair`,
      );
      updates.skeletonId = pickSkeleton(
        rng,
        emptyNetworkState(),
        row.voiceId as VoiceId,
        row.subNicheId as SubNicheId,
        row.cadenceId as CadenceId,
        row.scrubberStrictness as ScrubberStrictness,
      );
      skeletonsFixed++;
    }

    if (Object.keys(updates).length === 0) continue;

    if (sample.length < 10) {
      sample.push(
        `${row.blogId} [${row.nicheKey} / sub ${row.subNicheId}] ` +
          `pool ${JSON.stringify(pool)} -> ${JSON.stringify(updates.structuralPool ?? pool)}` +
          (updates.skeletonId
            ? `, skeleton ${row.skeletonId} -> ${updates.skeletonId}`
            : ""),
      );
    }

    if (!DRY_RUN) {
      await db
        .update(styleProfiles)
        .set(updates)
        .where(eq(styleProfiles.blogId, row.blogId));
    }
  }

  console.log(
    `Scanned ${rows.length} profile(s). ` +
      `Pools rebuilt: ${poolsFixed}. Skeletons re-picked: ${skeletonsFixed}.` +
      (DRY_RUN ? " (dry run — nothing written)" : ""),
  );
  if (sample.length > 0) {
    console.log("\nSample:");
    for (const s of sample) console.log(`  ${s}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Repair failed:", err);
    process.exit(1);
  });
