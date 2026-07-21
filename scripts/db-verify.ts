// Post-import verification: row counts + PDF storage check.
import { SupabaseStore } from "../src/store-supabase.js";

const store = new SupabaseStore();
const db = store.client;

for (const table of [
  "banks", "card_accounts", "statements", "statement_cards", "transactions",
  "instalment_plans", "payment_cycles", "upload_rejections", "api_cost_log",
]) {
  const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
  console.log(`${table.padEnd(20)} ${error ? "ERROR " + error.message : count + " rows"}`);
}

const { data: stmts } = await db.from("statements").select("filename,pdf_storage_path").order("id");
const withPdf = (stmts ?? []).filter((s) => s.pdf_storage_path);
console.log(`\nstatements with stored PDF: ${withPdf.length}/${stmts?.length ?? 0}`);

const { data: files } = await db.storage.from("statements").list("", { limit: 100 });
console.log(`storage bucket folders: ${files?.length ?? 0}`);

// paginated: the table exceeds the 1000-row default page size since the backfill
const sums: { txn_type: string; amount_rm: number }[] = [];
for (let from = 0; ; from += 1000) {
  const page = await db.from("transactions").select("txn_type, amount_rm").order("id").range(from, from + 999);
  if (page.error) throw new Error(page.error.message);
  sums.push(...(page.data as { txn_type: string; amount_rm: number }[]));
  if ((page.data ?? []).length < 1000) break;
}
const byType = new Map<string, { n: number; total: number }>();
for (const t of sums) {
  const e = byType.get(t.txn_type) ?? { n: 0, total: 0 };
  e.n++; e.total += Number(t.amount_rm);
  byType.set(t.txn_type, e);
}
console.log("\ntransactions by type:");
for (const [k, v] of [...byType.entries()].sort()) {
  console.log(`  ${k.padEnd(14)} ${String(v.n).padStart(4)} rows   RM ${v.total.toFixed(2)}`);
}
