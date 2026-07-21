// Quick exact counts (bypasses the 1000-row default page size).
import { SupabaseStore } from "../src/store-supabase.js";
const db = new SupabaseStore().client;
for (const table of ["statements", "statement_cards", "transactions", "ewallet_transactions", "merchant_rules"]) {
  const r = await db.from(table).select("id", { count: "exact", head: true });
  console.log(`${table}: ${r.count}${r.error ? " ERR " + r.error.message : ""}`);
}
const pend = await db.from("transactions").select("id", { count: "exact", head: true }).eq("needs_confirmation", true);
console.log(`pending confirmation: ${pend.count}`);
