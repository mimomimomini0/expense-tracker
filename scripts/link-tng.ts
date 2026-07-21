// Transfer-linking pass against Supabase (run after import-tng.ts):
//   npx tsx scripts/link-tng.ts
//
// Reads e-wallet reload rows + credit-card transactions, runs the conservative
// matchers in src/links.ts, and fills linked_transaction_id /
// linked_ewallet_transaction_id for EXACT, unambiguous matches only.
// Idempotent: never overwrites an existing link; re-running reports instead.

import { SupabaseStore } from "../src/store-supabase.js";
import {
  isEwalletTopup, linkInterCardTransfers, linkReloadsToCardTxns, type LinkableCardTxn,
} from "../src/links.js";
import type { ResolvedTngRow } from "../src/tng.js";

const store = new SupabaseStore();
const db = store.client;
const sen = (v: unknown) => Math.round(Number(v) * 100);
const rm = (s: number) => (s / 100).toFixed(2);

// ---- load e-wallet rows (with their DB ids and existing links) ----
const cardsQ = await db.from("ewallet_cards").select("id,card_serial");
if (cardsQ.error) throw new Error(`ewallet_cards: ${cardsQ.error.message}`);
const serialOf = new Map((cardsQ.data ?? []).map((c) => [c.id as number, c.card_serial as string]));

const ewRows: Record<string, unknown>[] = [];
for (let from = 0; ; from += 1000) {
  const page = await db.from("ewallet_transactions")
    .select("id,ewallet_card_id,trans_no,trans_date,trans_datetime,posted_date,kind,trans_type_raw,sector,description,reload_source,amount_rm,balance_after_rm,linked_transaction_id,linked_ewallet_transaction_id")
    .order("id").range(from, from + 999);
  if (page.error) throw new Error(`ewallet_transactions: ${page.error.message}`);
  ewRows.push(...(page.data as Record<string, unknown>[]));
  if ((page.data ?? []).length < 1000) break;
}
const ewQ = { data: ewRows };

const idOf = new Map<ResolvedTngRow, number>();
const existingCardLink = new Map<ResolvedTngRow, number | null>();
const existingInterLink = new Map<ResolvedTngRow, number | null>();
const rows: ResolvedTngRow[] = (ewQ.data ?? []).map((r) => {
  const row: ResolvedTngRow = {
    card_serial: serialOf.get(r.ewallet_card_id as number) ?? String(r.ewallet_card_id),
    trans_no: r.trans_no,
    trans_date: r.trans_date,
    trans_datetime: r.trans_datetime ?? `${r.trans_date} 00:00:00`,
    posted_date: r.posted_date,
    kind: r.kind,
    trans_type_raw: r.trans_type_raw,
    sector: r.sector,
    description: r.description,
    reload_source: r.reload_source,
    amount: sen(r.amount_rm),
    balance_after: sen(r.balance_after_rm),
  };
  idOf.set(row, r.id as number);
  existingCardLink.set(row, r.linked_transaction_id as number | null);
  existingInterLink.set(row, r.linked_ewallet_transaction_id as number | null);
  return row;
});
console.log(`loaded ${rows.length} e-wallet rows (${rows.filter((r) => r.kind === "reload").length} reloads)`);

// ---- load credit-card transactions (paginated) ----
const txRows: Record<string, unknown>[] = [];
for (let from = 0; ; from += 1000) {
  const page = await db.from("transactions")
    .select("id,txn_date,description_raw,amount_rm,direction,card_account_id")
    .order("id").range(from, from + 999);
  if (page.error) throw new Error(`transactions: ${page.error.message}`);
  txRows.push(...(page.data as Record<string, unknown>[]));
  if ((page.data ?? []).length < 1000) break;
}
const txQ = { data: txRows };
const cardTxns: LinkableCardTxn[] = (txQ.data ?? []).map((t) => ({
  id: t.id as number,
  txn_date: t.txn_date as string,
  description: t.description_raw as string,
  amount: sen(t.amount_rm),
  direction: t.direction as "debit" | "credit",
}));
console.log(`loaded ${cardTxns.length} card transactions`);

// ---- match ----
const report = linkReloadsToCardTxns(rows, cardTxns);
const interLinks = linkInterCardTransfers(rows);

let written = 0, kept = 0, conflicts = 0;

for (const l of report.links) {
  const ewId = idOf.get(l.reload)!;
  const existing = existingCardLink.get(l.reload);
  if (existing != null) {
    if (existing === l.txn.id) kept++;
    else { conflicts++; console.log(`CONFLICT: ewallet txn ${ewId} already linked to card txn ${existing}, matcher says ${l.txn.id} — left untouched, review manually`); }
    continue;
  }
  const upd = await db.from("ewallet_transactions")
    .update({ linked_transaction_id: l.txn.id }).eq("id", ewId).is("linked_transaction_id", null);
  if (upd.error) throw new Error(`link update ${ewId}: ${upd.error.message}`);
  written++;
  console.log(`linked: reload ${l.reload.trans_date} RM${rm(l.reload.amount)} (card ${l.reload.card_serial}) -> card txn ${l.txn.id} "${l.txn.description}" (${l.daysApart}d apart)`);
}

for (const l of interLinks) {
  const ewId = idOf.get(l.reload)!;
  const srcId = idOf.get(l.source)!;
  const existing = existingInterLink.get(l.reload);
  if (existing != null) {
    if (existing === srcId) kept++;
    else { conflicts++; console.log(`CONFLICT: ewallet txn ${ewId} already inter-linked to ${existing}, matcher says ${srcId} — left untouched`); }
    continue;
  }
  const upd = await db.from("ewallet_transactions")
    .update({ linked_ewallet_transaction_id: srcId }).eq("id", ewId).is("linked_ewallet_transaction_id", null);
  if (upd.error) throw new Error(`inter-link update ${ewId}: ${upd.error.message}`);
  written++;
  console.log(`inter-card link: reload ${l.reload.trans_datetime} RM${rm(l.reload.amount)} on ${l.reload.card_serial} <- ${l.source.card_serial} (${l.minutesApart.toFixed(1)} min apart)`);
}

// ---- report ----
console.log(`\nlinks written: ${written} | already correct: ${kept} | conflicts: ${conflicts}`);

const byReason = new Map<string, number>();
for (const u of report.unmatchedReloads) byReason.set(u.reason, (byReason.get(u.reason) ?? 0) + 1);
console.log(`unlinked reloads: ${report.unmatchedReloads.length}`,
  Object.fromEntries(byReason));
for (const u of report.unmatchedReloads.filter((x) => x.reason === "ambiguous")) {
  console.log(`  NEEDS REVIEW (ambiguous): reload ${u.reload.trans_date} RM${rm(u.reload.amount)} on ${u.reload.card_serial} — candidates: ${u.candidates.map((c) => `txn ${c.id} ${c.txn_date}`).join(", ")}`);
}

if (report.topupsWithoutReload.length > 0) {
  const total = report.topupsWithoutReload.reduce((a, t) => a + t.amount, 0);
  console.log(`\neWallet APP top-ups on card statements (no matching card reload — these fund the`);
  console.log(`app balance and are TRANSFERS, currently counted as card purchases): ${report.topupsWithoutReload.length} rows, RM ${rm(total)}`);
  for (const t of report.topupsWithoutReload) {
    console.log(`  txn ${t.id} | ${t.txn_date} | ${t.description} | RM ${rm(t.amount)}`);
  }
  console.log(`-> double-counting note: TNG Usage rows are already expenses; treating these`);
  console.log(`   top-ups as expenses too would double count the same ringgit. Decision on`);
  console.log(`   how to categorise app top-ups belongs to Phase 2 (categories).`);
}

const stillTng = cardTxns.filter((t) => t.direction === "debit" && isEwalletTopup(t.description)).length;
console.log(`\nTNG-pattern card debits in DB total: ${stillTng}`);
