// Apply the owner's recorded decisions from the 2026-07-20 Q&A round:
//   Q1 — wallet top-ups (TNG EWALLET / TNG-EWALLET / GRABPAY) are TRANSFERS:
//        new system category "Wallet Transfers", excluded from spending
//        totals in Phase 3 reports (own series, like payments/refunds).
//   Q2 — EP-OGAWA instalment -> Health & Pharmacy.
// Inserts the category + confirmed merchant rules; classify-persist then
// propagates them to every matching row. Idempotent.
import { SupabaseStore } from "../src/store-supabase.js";

const db = new SupabaseStore().client;

// Wallet Transfers system category (matches schema-phase2.sql seed)
const existing = await db.from("categories").select("id").eq("name_en", "Wallet Transfers").is("user_id", null).maybeSingle();
if (existing.error) throw new Error(existing.error.message);
let walletCatId = existing.data?.id as number | undefined;
if (walletCatId == null) {
  const ins = await db.from("categories")
    .insert({ name_en: "Wallet Transfers", name_zh: "钱包转账", sort_order: 175 })
    .select("id").single();
  if (ins.error) throw new Error(ins.error.message);
  walletCatId = ins.data.id as number;
  console.log(`created system category "Wallet Transfers" (id ${walletCatId})`);
} else {
  console.log(`category "Wallet Transfers" already exists (id ${walletCatId})`);
}

const health = await db.from("categories").select("id").eq("name_en", "Health & Pharmacy").is("user_id", null).single();
if (health.error) throw new Error(health.error.message);

const rules: { merchant_pattern: string; category_id: number }[] = [
  { merchant_pattern: "TNG EWALLET", category_id: walletCatId }, // Q1
  { merchant_pattern: "TNG-EWALLET", category_id: walletCatId }, // Q1 (2024 hyphenated print)
  { merchant_pattern: "GRABPAY", category_id: walletCatId },     // Q1
  { merchant_pattern: "EP-OGAWA", category_id: health.data.id }, // Q2
];
for (const r of rules) {
  const up = await db.from("merchant_rules").upsert(
    { ...r, confirmed_at: new Date().toISOString() },
    { onConflict: "user_id,merchant_pattern" },
  );
  if (up.error) throw new Error(`rule ${r.merchant_pattern}: ${up.error.message}`);
  console.log(`rule confirmed: ${r.merchant_pattern} -> category ${r.category_id}`);
}
console.log("done — now run: npx tsx scripts/classify-persist.ts");
