// Import the TNG fixture into Supabase (run after schema-ewallet.sql is applied):
//   npx tsx scripts/import-tng.ts
import fs from "node:fs";
import path from "node:path";
import { CachingExtractor, sha256, PROMPT_VERSION } from "../src/llm.js";
import { parseTngPdf } from "../src/tng.js";
import { SupabaseStore } from "../src/store-supabase.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const file = "TransactionHistory_153975159.pdf";
const pdf = fs.readFileSync(path.join(ROOT, "fixtures", "tng", file));
const hash = sha256(pdf);

const store = new SupabaseStore();
const db = store.client;

const dup = await db.from("ewallet_statements").select("id").eq("file_hash", hash).maybeSingle();
if (dup.error) throw new Error(`duplicate check: ${dup.error.message} — did you run schema-ewallet.sql?`);
if (dup.data) {
  console.log("already imported (duplicate file hash) — nothing changed");
  process.exit(0);
}

const result = await parseTngPdf(new CachingExtractor(), file, pdf, hash);
console.log("parse outcome:", result.outcome, result.detail ?? "");
if (result.outcome !== "parsed_ok") process.exit(1);
const ext = result.extraction!;

const acc = await db.from("ewallet_accounts")
  .upsert({ provider: ext.provider ?? "Touch 'n Go", account_no: ext.account_no!, registered_name: ext.registered_name },
    { onConflict: "user_id,provider,account_no" })
  .select("id").single();
if (acc.error) throw new Error(acc.error.message);

const stmt = await db.from("ewallet_statements").insert({
  ewallet_account_id: acc.data.id, filename: file, file_hash: hash,
  period_start: ext.period_start, period_end: ext.period_end,
  status: "parsed_ok", model_version: result.usages.extract?.model, prompt_version: PROMPT_VERSION,
}).select("id").single();
if (stmt.error) throw new Error(stmt.error.message);

const cardIds = new Map<string, number>();
for (const card of ext.cards) {
  const c = await db.from("ewallet_cards")
    .upsert({ ewallet_account_id: acc.data.id, card_serial: card.card_serial, card_type: card.card_type },
      { onConflict: "user_id,ewallet_account_id,card_serial" })
    .select("id").single();
  if (c.error) throw new Error(c.error.message);
  cardIds.set(card.card_serial, c.data.id);
}

const rows = result.rows.map((r) => ({
  ewallet_statement_id: stmt.data.id,
  ewallet_card_id: cardIds.get(r.card_serial)!,
  trans_no: r.trans_no,
  trans_date: r.trans_date,
  trans_datetime: r.trans_datetime.replace(" ", "T") + "+08:00",
  posted_date: r.posted_date,
  kind: r.kind,
  trans_type_raw: r.trans_type_raw,
  sector: r.sector,
  description: r.description,
  reload_source: r.reload_source,
  amount_rm: r.amount / 100,
  balance_after_rm: r.balance_after / 100,
}));
for (let i = 0; i < rows.length; i += 100) {
  const ins = await db.from("ewallet_transactions").insert(rows.slice(i, i + 100));
  if (ins.error) throw new Error(ins.error.message);
}

const storagePath = await store.storePdf(hash, file, pdf);
await db.from("ewallet_statements").update({ pdf_storage_path: storagePath }).eq("id", stmt.data.id);

console.log(`persisted: ${ext.cards.length} cards, ${rows.length} transactions, PDF at ${storagePath}`);
const usage = rows.filter((r) => r.kind === "usage").reduce((a, r) => a + r.amount_rm, 0);
const reload = rows.filter((r) => r.kind === "reload").reduce((a, r) => a + r.amount_rm, 0);
console.log(`expenses (usage): RM ${usage.toFixed(2)} | transfers (reload): RM ${reload.toFixed(2)}`);
