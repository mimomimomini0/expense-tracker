// FR-4d continuation detection against the live database:
//   npx tsx scripts/detect-continuations.ts           -> report only
//   npx tsx scripts/detect-continuations.ts --apply   -> also link the confident ones
import { SupabaseStore } from "../src/store-supabase.js";
import { detectContinuations } from "../src/continuation.js";

const APPLY = process.argv.includes("--apply");
const store = new SupabaseStore();
const found = detectContinuations(
  await store.listCardAccounts(), await store.listStatements(), await store.listStatementCards(),
);
if (found.length === 0) {
  console.log("no continuation candidates detected in the current data.");
  console.log("(expected while the 2025 statements are missing — the 2024 cards' closings");
  console.log(" cannot hand off to the 2026 cards' openings across the gap; detection");
  console.log(" re-runs automatically on every future backfill.)");
  process.exit(0);
}
for (const d of found) {
  console.log(`${d.confident ? "CONFIDENT" : "PROPOSAL "} ...${d.predecessor.last4} -> ...${d.successor.last4}: ${d.reason}`);
  if (d.confident && APPLY) {
    await store.linkCardContinuation(d.successor.id, d.predecessor.id);
    console.log("  linked.");
  }
}
if (!APPLY && found.some((d) => d.confident)) {
  console.log("\nrun with --apply to write the confident links.");
}
