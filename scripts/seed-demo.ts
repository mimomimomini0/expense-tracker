// Seed a DEMO database with a believable fictional person's finances, so
// friends/family can explore the whole app without touching real data.
//
// SAFETY: this targets a SEPARATE demo Supabase project via DEMO_SUPABASE_URL /
// DEMO_SUPABASE_SERVICE_ROLE_KEY — never the real one. It refuses to run unless
// those are set, differ from the real SUPABASE_URL, and you pass --yes.
//
//   # validate the generator with no DB and no credentials:
//   npx tsx scripts/seed-demo.ts --dry-run
//
//   # seed the demo project (fill in the demo project's URL + service key):
//   DEMO_SUPABASE_URL=https://xxxx.supabase.co \
//   DEMO_SUPABASE_SERVICE_ROLE_KEY=eyJ... \
//   npx tsx scripts/seed-demo.ts --yes
//
// The fake statements are run through the REAL importPdf pipeline (date
// resolution, arithmetic reconciliation, typing, payment-cycle + instalment
// recompute), so the data behaves exactly like imported statements. Categories
// are assigned directly afterwards (no LLM). No Anthropic key is needed.

import { DateTime } from "luxon";
import { MemoryStore } from "../src/store.js";
import { importPdf } from "../src/pipeline.js";
import { sha256 } from "../src/llm.js";
import type { Store } from "../src/store.js";
import type {
  Extractor, LlmCallOutcome,
} from "../src/llm.js";
import type {
  ExtractedCard, ExtractedTransaction, ExtractionResult, GateResult,
} from "../src/types.js";

const DRY = process.argv.includes("--dry-run");
const YES = process.argv.includes("--yes");
const FORCE = process.argv.includes("--force");

// ---------------- deterministic RNG (reproducible seeds) ----------------
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260722);
const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!;
const jitter = (base: number, spread: number) => base + Math.floor((rnd() - 0.5) * 2 * spread);

// ---------------- merchant catalogue (amounts in sen) ----------------
interface Merchant { name: string; cat: string; base: number; spread: number; }
const CATALOG: Merchant[] = [
  { name: "STARBUCKS KLCC", cat: "F&B / Restaurants", base: 2100, spread: 800 },
  { name: "MCDONALD'S", cat: "F&B / Restaurants", base: 2500, spread: 1200 },
  { name: "SUSHI KING", cat: "F&B / Restaurants", base: 4500, spread: 2000 },
  { name: "GRABFOOD", cat: "F&B / Restaurants", base: 3800, spread: 1800 },
  { name: "NANDOS", cat: "F&B / Restaurants", base: 6500, spread: 2500 },
  { name: "TEALIVE", cat: "F&B / Restaurants", base: 1500, spread: 600 },
  { name: "JAYA GROCER", cat: "Groceries", base: 12000, spread: 6000 },
  { name: "LOTUS'S", cat: "Groceries", base: 9000, spread: 5000 },
  { name: "VILLAGE GROCER", cat: "Groceries", base: 14000, spread: 7000 },
  { name: "AEON BIG", cat: "Groceries", base: 8500, spread: 4000 },
  { name: "SHELL SELECT", cat: "Transport & Fuel", base: 9000, spread: 3000 },
  { name: "PETRONAS", cat: "Transport & Fuel", base: 8500, spread: 3000 },
  { name: "GRAB RIDE", cat: "Transport & Fuel", base: 1800, spread: 1200 },
  { name: "LAZADA", cat: "Online Purchases", base: 7500, spread: 5000 },
  { name: "SHOPEE", cat: "Online Purchases", base: 6000, spread: 4500 },
  { name: "AMAZON SG", cat: "Online Purchases", base: 9000, spread: 6000 },
  { name: "UNIQLO", cat: "Retail & Shopping", base: 12000, spread: 6000 },
  { name: "H&M", cat: "Retail & Shopping", base: 10000, spread: 5000 },
  { name: "MR DIY", cat: "Retail & Shopping", base: 3500, spread: 2500 },
  { name: "PADINI CONCEPT", cat: "Retail & Shopping", base: 15000, spread: 8000 },
  { name: "GUARDIAN", cat: "Health & Pharmacy", base: 4500, spread: 2500 },
  { name: "WATSONS", cat: "Health & Pharmacy", base: 5500, spread: 3000 },
  { name: "CARING PHARMACY", cat: "Health & Pharmacy", base: 6500, spread: 3500 },
  { name: "TENAGA NASIONAL", cat: "Utilities", base: 18000, spread: 6000 },
  { name: "AIR SELANGOR", cat: "Utilities", base: 4500, spread: 1500 },
  { name: "MAXIS POSTPAID", cat: "Telco", base: 12800, spread: 0 },
  { name: "UNIFI FIBRE", cat: "Telco", base: 13900, spread: 0 },
  { name: "CELEBRITY FITNESS", cat: "Fitness & Sports", base: 15900, spread: 0 },
  { name: "DECATHLON", cat: "Fitness & Sports", base: 9000, spread: 6000 },
  { name: "TOYS R US", cat: "Kids & Family", base: 12000, spread: 7000 },
  { name: "PRUDENTIAL", cat: "Insurance", base: 28000, spread: 0 },
  { name: "IKEA DAMANSARA", cat: "Home & Renovation", base: 22000, spread: 12000 },
  { name: "ACE HARDWARE", cat: "Home & Renovation", base: 8000, spread: 5000 },
  { name: "PET LOVERS CENTRE", cat: "Pets", base: 9500, spread: 4000 },
  { name: "GSC CINEMA", cat: "Lifestyle & Leisure", base: 4800, spread: 2000 },
  { name: "KLCC PARKING", cat: "Parking", base: 1500, spread: 800 },
];
// Recurring subscriptions (fixed amounts) — detected by the /subscriptions view.
const SUBS: Record<string, Merchant[]> = {
  CIMB: [
    { name: "NETFLIX.COM", cat: "Subscriptions", base: 4500, spread: 0 },
    { name: "SPOTIFY", cat: "Subscriptions", base: 1590, spread: 0 },
    { name: "APPLE ICLOUD", cat: "Subscriptions", base: 1190, spread: 0 },
  ],
  MAYBANK: [
    { name: "YOUTUBE PREMIUM", cat: "Subscriptions", base: 1790, spread: 0 },
    { name: "CHATGPT PLUS", cat: "Subscriptions", base: 9000, spread: 0 },
  ],
};
// "Paying on Behalf" — outstanding reimbursements on the /owed page.
const ON_BEHALF: { name: string; party: string; base: number }[] = [
  { name: "WAH LEE HARDWARE", party: "Dad", base: 301600 },
  { name: "DELL MALAYSIA", party: "Brother", base: 890900 },
];

const merchantCat = new Map<string, string>();
for (const m of [...CATALOG, ...SUBS.CIMB!, ...SUBS.MAYBANK!]) merchantCat.set(m.name, m.cat);
merchantCat.set("AGODA.COM", "Travel Expenses");
merchantCat.set("SHENZHEN METRO", "Travel Expenses");
for (const o of ON_BEHALF) merchantCat.set(o.name, "Paying on Behalf");

/** Category name for a description, or null (payments/refunds/fees stay null). */
function catForDesc(desc: string): string | null {
  if (merchantCat.has(desc)) return merchantCat.get(desc)!;
  if (/^EP-SHOPEE/.test(desc)) return "Retail & Shopping";
  return null;
}

// ---------------- cards ----------------
interface CardCfg {
  bank: string; last4: string; holder: string; limit: number; rate: number;
  latestOffsetDays: number; subsKey: keyof typeof SUBS; instalment: boolean;
}
const CARDS: CardCfg[] = [
  { bank: "CIMB", last4: "4521", holder: "ALEX TAN", limit: 30000, rate: 15.0, latestOffsetDays: 26, subsKey: "CIMB", instalment: true },
  { bank: "MAYBANK", last4: "8830", holder: "ALEX TAN", limit: 20000, rate: 17.0, latestOffsetDays: 12, subsKey: "MAYBANK", instalment: false },
];
const MONTHS = 10; // statements per card

// ---------------- statement generation ----------------
type Row = ExtractedTransaction;
const debit = (desc: string, sen: number, ccy: string | null = null, orig: number | null = null): Row => ({
  txn_date_raw: "", posting_date_raw: null, description: desc, amount_rm: sen / 100,
  direction: "debit", original_currency: ccy, original_amount: orig,
});
const credit = (desc: string, sen: number): Row => ({
  txn_date_raw: "", posting_date_raw: null, description: desc, amount_rm: sen / 100,
  direction: "credit", original_currency: null, original_amount: null,
});

function buildStatement(card: CardCfg, stmtDate: DateTime, idx: number, openingSen: number): ExtractionResult {
  const rows: Row[] = [];
  const dayIn = (n: number) => stmtDate.minus({ days: n }).toISODate()!;

  // pay the prior balance in full
  if (openingSen > 0) rows.push({ ...credit("PAYMENT - THANK YOU", openingSen), txn_date_raw: dayIn(28) });

  // recurring subscriptions
  for (const s of SUBS[card.subsKey]!) rows.push({ ...debit(s.name, s.base), txn_date_raw: dayIn(20) });

  // random purchases
  const n = 6 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    const m = pick(CATALOG);
    rows.push({ ...debit(m.name, Math.max(500, jitter(m.base, m.spread))), txn_date_raw: dayIn(2 + Math.floor(rnd() * 25)) });
  }

  // occasional refund / fee
  if (idx % 3 === 1) rows.push({ ...credit("REFUND - LAZADA", jitter(4000, 2000)), txn_date_raw: dayIn(10) });
  if (idx % 4 === 0) rows.push({ ...debit(idx === 0 ? "ANNUAL FEE 2026" : "SERVICE TAX SST", idx === 0 ? 15000 : jitter(900, 400)), txn_date_raw: dayIn(1) });

  // instalment plan (CIMB): starts at statement idx 2, NN increments, 12-month plan
  if (card.instalment && idx >= 2) {
    const nn = idx - 1; // idx2 -> 01, idx9 -> 08
    rows.push({ ...debit(`EP-SHOPEE-12MTHS : ${String(nn).padStart(2, "0")}/12`, 25000), txn_date_raw: dayIn(15) });
  }

  // on-behalf reimbursements (a couple over the history)
  if (idx === 4) { const o = ON_BEHALF[0]!; rows.push({ ...debit(o.name, o.base), txn_date_raw: dayIn(12) }); }
  if (idx === 6) { const o = ON_BEHALF[1]!; rows.push({ ...debit(o.name, o.base), txn_date_raw: dayIn(9) }); }

  // dispute-window items on the most-recent statement if it's within 14 days
  const daysAgo = Math.round(DateTime.now().diff(stmtDate, "days").days);
  if (idx === MONTHS - 1 && daysAgo <= 14) {
    rows.push({ ...debit("AGODA.COM", 48500, "SGD", 145.0), txn_date_raw: dayIn(4) });
    rows.push({ ...debit("SHENZHEN METRO", 1200, "CNY", 18.5), txn_date_raw: dayIn(3) });
    rows.push({ ...debit("STARBUCKS KLCC", 2100), txn_date_raw: dayIn(2) });
    rows.push({ ...debit("STARBUCKS KLCC", 2100), txn_date_raw: dayIn(2) }); // duplicate
  }

  let credits = 0, debits = 0;
  for (const r of rows) { const s = Math.round(r.amount_rm * 100); if (r.direction === "credit") credits += s; else debits += s; }
  const closingSen = openingSen - credits + debits;
  const minDueSen = Math.max(5000, Math.round(closingSen * 0.05));

  const instalmentSummaries = card.instalment && idx >= 2
    ? [{ plan_name: "EP-SHOPEE-12MTHS", total_months: 12, monthly_amount_rm: 250, principal_rm: 3000, outstanding_principal_rm: (12 - (idx - 1)) * 250 }]
    : [];

  const cardOut: ExtractedCard = {
    card_number_masked: `**** **** **** ${card.last4}`,
    last4: card.last4, holder_name: card.holder,
    opening_balance_rm: openingSen / 100, closing_balance_rm: closingSen / 100,
    minimum_due_rm: minDueSen / 100, credit_limit_rm: card.limit,
    retail_interest_rate_pct: card.rate,
    summary_totals: { total_debits_rm: debits / 100, total_credits_rm: credits / 100, retail_purchase_rm: null, cash_advance_rm: null },
    instalment_summaries: instalmentSummaries,
    transactions: rows,
  };
  return {
    doc_type: "credit_card_statement", bank: card.bank,
    statement_date: stmtDate.toISODate(),
    payment_due_date_raw: stmtDate.plus({ days: 20 }).toISODate(),
    statement_period_start: stmtDate.minus({ months: 1 }).plus({ days: 1 }).toISODate(),
    statement_period_end: stmtDate.toISODate(),
    cards: [cardOut],
  };
}

// ---------------- stub extractor (no LLM) ----------------
const ZERO = { model: "demo-seed", tokensIn: 0, tokensOut: 0, estCostUsd: 0, estCostRm: 0, fromCache: true };
class StubExtractor implements Extractor {
  constructor(private byHash: Map<string, ExtractionResult>) {}
  async gate(_pdf: Buffer, _hash: string): Promise<LlmCallOutcome<GateResult>> {
    return { result: { doc_type: "credit_card_statement", bank_guess: null, reason: "demo" }, usage: ZERO };
  }
  async extract(_pdf: Buffer, hash: string): Promise<LlmCallOutcome<ExtractionResult>> {
    const r = this.byHash.get(hash);
    if (!r) throw new Error(`no demo statement for hash ${hash}`);
    return { result: r, usage: ZERO };
  }
  async escalate(pdf: Buffer, hash: string): Promise<LlmCallOutcome<ExtractionResult>> {
    return this.extract(pdf, hash);
  }
}

async function generate(store: Store): Promise<void> {
  const byHash = new Map<string, ExtractionResult>();
  const stub = new StubExtractor(byHash);
  let count = 0;
  for (const card of CARDS) {
    const latest = DateTime.now().minus({ days: card.latestOffsetDays }).startOf("day");
    let openingSen = 0;
    for (let idx = 0; idx < MONTHS; idx++) {
      const stmtDate = latest.minus({ months: MONTHS - 1 - idx });
      const result = buildStatement(card, stmtDate, idx, openingSen);
      openingSen = Math.round(result.cards[0]!.closing_balance_rm * 100);
      const filename = `${card.bank}_${card.last4}_${result.statement_date}.pdf`;
      const pdf = Buffer.from(`demo|${filename}`);
      byHash.set(sha256(pdf), result);
      const outcome = await importPdf(store, stub, filename, pdf);
      if (outcome.outcome !== "parsed_ok") {
        throw new Error(`statement ${filename} did not commit: ${outcome.outcome} — ${outcome.detail ?? ""}`);
      }
      count++;
    }
  }
  console.log(`imported ${count} statements across ${CARDS.length} cards`);
}

/** Assign categories (+ on-behalf) directly on the demo DB. */
async function assignCategories(client: {
  from: (t: string) => any;
}): Promise<void> {
  const cats = await client.from("categories").select("id,name_en").is("user_id", null);
  if (cats.error) throw new Error(`fetch categories: ${cats.error.message}`);
  const catId = new Map<string, number>();
  for (const c of cats.data as { id: number; name_en: string }[]) catId.set(c.name_en, c.id);

  const txns: { id: number; description_raw: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await client.from("transactions").select("id,description_raw").order("id").range(from, from + 999);
    if (page.error) throw new Error(`fetch transactions: ${page.error.message}`);
    txns.push(...(page.data ?? []));
    if ((page.data ?? []).length < 1000) break;
  }

  // group txn ids by target category
  const byCat = new Map<string, number[]>();
  const onBehalf: { id: number; party: string }[] = [];
  for (const t of txns) {
    const cat = catForDesc(t.description_raw);
    if (!cat || !catId.has(cat)) continue;
    (byCat.get(cat) ?? byCat.set(cat, []).get(cat)!).push(t.id);
    if (cat === "Paying on Behalf") {
      const party = /WAH LEE/.test(t.description_raw) ? "Dad" : "Brother";
      onBehalf.push({ id: t.id, party });
    }
  }
  let updated = 0;
  for (const [cat, ids] of byCat) {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const r = await client.from("transactions")
        .update({ category_id: catId.get(cat), category_source: "learned" }).in("id", chunk);
      if (r.error) throw new Error(`update ${cat}: ${r.error.message}`);
      updated += chunk.length;
    }
  }
  for (const ob of onBehalf) {
    const r = await client.from("transactions")
      .update({ on_behalf_party: ob.party, on_behalf_status: "owed" }).eq("id", ob.id);
    if (r.error) throw new Error(`update on-behalf ${ob.id}: ${r.error.message}`);
  }
  console.log(`categorised ${updated} transactions (${onBehalf.length} owed-to-me)`);
}

// ---------------- dry-run summary ----------------
async function summary(store: MemoryStore): Promise<void> {
  const txns = await store.listTransactions();
  const byType = new Map<string, number>();
  for (const t of txns) byType.set(t.txn_type, (byType.get(t.txn_type) ?? 0) + 1);
  const cycles = await store.listPaymentCycles();
  const plans = await store.listInstalmentPlans();
  const cat = new Map<string, number>();
  for (const t of txns) { const c = catForDesc(t.description_raw); if (c) cat.set(c, (cat.get(c) ?? 0) + 1); }
  const badDelta = (await store.listStatementCards()).filter((sc) => sc.reconciliation_delta !== 0);
  console.log("\n--- DRY RUN SUMMARY (in-memory, no DB) ---");
  console.log("statements:", (await store.listStatements()).length, "| statement-cards:", (await store.listStatementCards()).length, "| transactions:", txns.length);
  console.log("txn types:", JSON.stringify(Object.fromEntries(byType)));
  console.log("payment cycles:", cycles.length, "statuses:", JSON.stringify(Object.fromEntries(cycles.reduce((m, c) => m.set(c.status, (m.get(c.status) ?? 0) + 1), new Map()))));
  console.log("instalment plans:", plans.map((p) => `${p.plan_name} ${p.months_elapsed}/${p.total_months}`).join(", ") || "none");
  console.log("categories that will be assigned:", JSON.stringify(Object.fromEntries([...cat].sort((a, b) => b[1] - a[1]))));
  console.log("reconciliation mismatches:", badDelta.length, badDelta.length ? "(BUG — should be 0)" : "(all reconcile ✓)");
}

// ---------------- main ----------------
async function main() {
  if (DRY) {
    const store = new MemoryStore();
    await generate(store);
    await summary(store);
    return;
  }

  const realUrl = process.env.SUPABASE_URL;
  const demoUrl = process.env.DEMO_SUPABASE_URL;
  const demoKey = process.env.DEMO_SUPABASE_SERVICE_ROLE_KEY;
  if (!demoUrl || !demoKey) {
    console.error("Set DEMO_SUPABASE_URL and DEMO_SUPABASE_SERVICE_ROLE_KEY (the DEMO project's values).");
    console.error("Tip: run with --dry-run first to preview the data with no DB/credentials.");
    process.exit(1);
  }
  if (realUrl && realUrl === demoUrl) {
    console.error("Refusing to run: DEMO_SUPABASE_URL equals your real SUPABASE_URL. Point it at a SEPARATE demo project.");
    process.exit(1);
  }
  if (!YES) {
    console.error(`This will seed demo data into: ${demoUrl}`);
    console.error("Re-run with --yes to proceed.");
    process.exit(1);
  }

  // Point the engine's Supabase client at the DEMO project (overrides whatever
  // dotenv loaded from the real .env). Import the store AFTER this.
  process.env.SUPABASE_URL = demoUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = demoKey;
  const { SupabaseStore } = await import("../src/store-supabase.js");
  const store = new SupabaseStore();

  const existing = await store.listStatements();
  if (existing.length > 0 && !FORCE) {
    console.error(`Demo DB already has ${existing.length} statements. Use a fresh project, or pass --force to add anyway.`);
    process.exit(1);
  }

  console.log(`Seeding demo data into ${demoUrl} ...`);
  await generate(store);
  await assignCategories(store.client);
  console.log("\nDone. The demo database is ready — point a demo deployment at it.");
}

main().catch((e) => { console.error(e); process.exit(1); });
