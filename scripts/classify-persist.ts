// FR-7 classification persistence pass:
//   npx tsx scripts/classify-persist.ts
//
// 1. Seeds merchant_rules from SEED_RULES (skips patterns already present, so
//    user re-mappings are never clobbered).
// 2. Classifies every stored transaction with the deterministic engine
//    (type-driven -> merchant rules -> queue; NO LLM calls) and writes
//    category_id / category_source / needs_confirmation.
// 3. NEVER touches rows with category_source = 'user' — user decisions are
//    permanent until the user changes them.
//
// Idempotent: re-running after new rules are confirmed re-classifies only
// non-user rows, which is exactly how confirmed rules propagate.

import { SupabaseStore } from "../src/store-supabase.js";
import {
  classifyRow, buildConfirmationQueue, NoopSuggester, SEED_RULES,
  type MerchantRule, type CategoryName,
} from "../src/classify.js";
import { classifyTransaction } from "../src/typing.js";
import type { TxnType } from "../src/types.js";

const db = new SupabaseStore().client;

// ---- categories: name -> id ----
const catQ = await db.from("categories").select("id,name_en").is("user_id", null);
if (catQ.error) throw new Error(`categories: ${catQ.error.message} — is schema-phase2.sql applied?`);
const catId = new Map<string, number>((catQ.data ?? []).map((c) => [c.name_en as string, c.id as number]));
for (const r of SEED_RULES) {
  if (!catId.has(r.category)) throw new Error(`seed category "${r.category}" missing from categories table`);
}

// ---- seed merchant_rules (existing patterns win) ----
const mrQ = await db.from("merchant_rules").select("id,merchant_pattern,category_id");
if (mrQ.error) throw new Error(`merchant_rules: ${mrQ.error.message}`);
const existingPatterns = new Set((mrQ.data ?? []).map((r) => (r.merchant_pattern as string).toUpperCase()));
const toSeed = SEED_RULES.filter((r) => !existingPatterns.has(r.merchant_pattern.toUpperCase()));
if (toSeed.length > 0) {
  const ins = await db.from("merchant_rules").insert(
    toSeed.map((r) => ({ merchant_pattern: r.merchant_pattern, category_id: catId.get(r.category)! })),
  );
  if (ins.error) throw new Error(`seed merchant_rules: ${ins.error.message}`);
}
console.log(`merchant_rules: ${mrQ.data?.length ?? 0} existing, ${toSeed.length} seeded`);

// ---- effective rule set = ALL rules now in the DB (seeded + user-confirmed) ----
const allRulesQ = await db.from("merchant_rules").select("merchant_pattern,category_id");
if (allRulesQ.error) throw new Error(allRulesQ.error.message);
const idToName = new Map<number, string>([...catId.entries()].map(([n, i]) => [i, n]));
const rules: MerchantRule[] = (allRulesQ.data ?? []).map((r) => ({
  merchant_pattern: (r.merchant_pattern as string).toUpperCase(),
  category: idToName.get(r.category_id as number) as CategoryName,
}));

// ---- classify every transaction (paginated: > 1000 rows after backfill) ----
type TxRow = {
  id: number; description_raw: string; direction: "debit" | "credit";
  txn_type: TxnType | null; category_id: number | null;
  category_source: string | null; needs_confirmation: boolean;
};
const txRows: TxRow[] = [];
for (let from = 0; ; from += 1000) {
  const page = await db.from("transactions")
    .select("id,description_raw,direction,txn_type,category_id,category_source,needs_confirmation")
    .order("id").range(from, from + 999);
  if (page.error) throw new Error(`transactions: ${page.error.message}`);
  txRows.push(...(page.data as TxRow[]));
  if ((page.data ?? []).length < 1000) break;
}
const suggester = new NoopSuggester();

let updated = 0, skippedUser = 0, unchanged = 0, queued = 0;
const pendingForQueue: { row: number; description: string; suggestion: null }[] = [];

for (const t of txRows) {
  if (t.category_source === "user") { skippedUser++; continue; }
  const txnType = t.txn_type ?? classifyTransaction(t.description_raw, t.direction);
  const c = await classifyRow(t.description_raw, txnType, rules, suggester);
  const newCategoryId = c.category ? catId.get(c.category)! : null;
  const newSource = c.category ? "learned" : null; // type- and rule-driven both persist as 'learned'
  if (c.queued) { queued++; pendingForQueue.push({ row: t.id as number, description: t.description_raw as string, suggestion: null }); }

  const same = t.category_id === newCategoryId &&
    (t.category_source ?? null) === newSource &&
    t.needs_confirmation === c.queued;
  if (same) { unchanged++; continue; }

  // guard: never touch user-set rows. NB: .neq() alone would silently skip
  // NULL category_source rows (SQL three-valued logic), so include is.null.
  const upd = await db.from("transactions").update({
    category_id: newCategoryId,
    category_source: newSource,
    needs_confirmation: c.queued,
  }).eq("id", t.id)
    .or("category_source.is.null,category_source.neq.user")
    .select("id");
  if (upd.error) throw new Error(`update txn ${t.id}: ${upd.error.message}`);
  if ((upd.data ?? []).length !== 1) throw new Error(`update txn ${t.id}: expected 1 row, got ${upd.data?.length ?? 0}`);
  updated++;
}

console.log(`transactions: ${txRows.length} total | ${updated} updated | ${unchanged} unchanged | ${skippedUser} user-set (untouched) | ${queued} queued for confirmation`);

const queue = buildConfirmationQueue(pendingForQueue);
console.log(`confirmation queue: ${queue.length} merchant groups`);
for (const g of queue.slice(0, 10)) console.log(`  ${String(g.rows.length).padStart(2)}x ${g.merchant}`);
if (queue.length > 10) console.log(`  ... and ${queue.length - 10} more groups`);
