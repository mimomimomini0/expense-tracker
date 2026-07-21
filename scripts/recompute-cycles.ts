// Repair pass after fixing the listTransactions 1000-row truncation:
// recompute payment cycles + instalment plans for every card and report
// exactly what changed. User-recorded payments are preserved by design.
//   npx tsx scripts/recompute-cycles.ts
import { SupabaseStore } from "../src/store-supabase.js";
import { recomputePaymentCycles } from "../src/payments.js";
import { recomputeInstalmentPlans } from "../src/instalments.js";

const store = new SupabaseStore();
const before = await store.listPaymentCycles();
const cards = await store.listCardAccounts();

for (const card of cards) {
  await recomputePaymentCycles(store, card.id);
  await recomputeInstalmentPlans(store, card.id);
}

const after = await store.listPaymentCycles();
const key = (c: { card_account_id: number; statement_id: number }) => `${c.card_account_id}:${c.statement_id}`;
const beforeMap = new Map(before.map((c) => [key(c), c]));
let changed = 0;
for (const c of after) {
  const b = beforeMap.get(key(c));
  if (!b) { changed++; console.log(`NEW cycle card ${c.card_account_id} stmt ${c.statement_id}: ${c.status} paid ${c.amount_paid / 100}`); continue; }
  if (b.status !== c.status || b.amount_paid !== c.amount_paid) {
    changed++;
    console.log(`CHANGED card ${c.card_account_id} stmt ${c.statement_id}: ${b.status} (RM ${b.amount_paid / 100}) -> ${c.status} (RM ${c.amount_paid / 100})`);
  }
}
console.log(`cycles: ${before.length} before, ${after.length} after, ${changed} corrected`);

const plans = await store.client.from("instalment_plans").select("plan_name,months_elapsed,total_months");
console.log("instalment plans:", (plans.data ?? []).map((p) => `${p.plan_name} ${p.months_elapsed}/${p.total_months}`).join(", "));
