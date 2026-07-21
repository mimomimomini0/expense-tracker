// One-off: remove needs_review statement rows so a re-run of backfill.ts can
// re-import them from cache with the fixed DDMM date resolution.
import { SupabaseStore } from "../src/store-supabase.js";

const store = new SupabaseStore();
const all = await store.listStatements();
const reviews = all.filter((s) => s.status === "needs_review");
for (const s of reviews) {
  console.log(`deleting needs_review statement ${s.id}: ${s.filename} (${s.statement_date})`);
  await store.deleteStatement(s.id);
}
console.log(`deleted ${reviews.length} needs_review statements`);
