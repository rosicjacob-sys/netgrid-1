/**
 * Print the fully composed system prompt for a synthetic blog in any
 * registered niche. No database, no API calls.
 *
 *   npx tsx scripts/preview-prompt.ts roofing "Metal vs asphalt in Quebec winters"
 *   npx tsx scripts/preview-prompt.ts loans
 *   npx tsx scripts/preview-prompt.ts peptides "BPC-157 and tendon repair"
 */
import {
  assignProfile,
  emptyNetworkState,
} from "../src/lib/content/assignment/algorithm";
import { composeForPost } from "../src/lib/content/composer/compose";
import { NICHES } from "../src/lib/content/libraries/niches";

const nicheKey = process.argv[2] ?? "roofing";
const topic = process.argv[3] ?? "How to choose a contractor without getting burned";

if (!NICHES[nicheKey]) {
  console.error(
    `Unknown niche "${nicheKey}". Known keys:\n  ${Object.keys(NICHES).join("\n  ")}`,
  );
  process.exit(1);
}

const profile = assignProfile(
  "00000000-0000-4000-8000-0000000000aa",
  emptyNetworkState(),
  { nicheKey },
);

console.log("PROFILE");
console.log(
  `  subNiche=${profile.subNicheId} voice=${profile.voiceId} ` +
    `skeleton=${profile.skeletonId} cadence=${profile.cadenceId} ` +
    `tagSet=${profile.tagSetId} strictness=${profile.scrubberStrictness}`,
);
console.log(`  structuralPool=${JSON.stringify(profile.structuralPool)}`);
console.log(`  compliancePhraseIds=${JSON.stringify(profile.compliancePhraseIds)}`);

const composed = composeForPost({ profile, topic, nicheLabel: nicheKey });
console.log(`\nTEMPLATE DRAWN: ${composed.template.code} ${composed.template.name}`);
console.log("\n──────── SYSTEM PROMPT ────────\n");
console.log(composed.systemPrompt);
