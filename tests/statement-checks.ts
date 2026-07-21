// Machine-checkable encodings of the per-statement "assertions" prose in
// fixture-ground-truth.json. Keyed by fixture filename. All amounts asserted
// in sen against hand-verified ground-truth values (never pipeline output).

import { expect } from "vitest";
import type { MemoryStore } from "../src/store.js";
import type { StatementRow, StatementCardRow, TransactionRow } from "../src/types.js";

export interface StmtCtx {
  store: MemoryStore;
  stmt: StatementRow;
  /** statement_cards of this statement keyed by last4, with their transactions */
  card(last4: string): { sc: StatementCardRow; txns: TransactionRow[] };
  hasCard(last4: string): boolean;
  /** all transactions of this statement (all card sections) */
  allTxns(): TransactionRow[];
}

const sen = (rm: number) => Math.round(rm * 100);

function find(txns: TransactionRow[], pred: (t: TransactionRow) => boolean): TransactionRow[] {
  return txns.filter(pred);
}

function expectTxn(
  txns: TransactionRow[],
  amountRm: number,
  opts: { type?: string; direction?: string; descLike?: RegExp; currency?: string; original?: number; count?: number },
): TransactionRow[] {
  const matches = find(
    txns,
    (t) =>
      t.amount === sen(amountRm) &&
      (opts.type === undefined || t.txn_type === opts.type) &&
      (opts.direction === undefined || t.direction === opts.direction) &&
      (opts.descLike === undefined || opts.descLike.test(t.description_raw)) &&
      (opts.currency === undefined || t.original_currency === opts.currency) &&
      (opts.original === undefined || t.original_amount === opts.original),
  );
  const wanted = opts.count ?? 1;
  expect(
    matches.length,
    `expected ${wanted} txn(s) of RM ${amountRm} matching ${JSON.stringify({ ...opts, descLike: opts.descLike?.source })}, found ${matches.length}`,
  ).toBe(wanted);
  return matches;
}

async function cycleFor(store: MemoryStore, bank: string, stmtDate: string) {
  const banks = await store.listBanks();
  const statements = await store.listStatements();
  const cycles = await store.listPaymentCycles();
  const bankRow = banks.find((b) => b.name.toUpperCase().includes(bank.toUpperCase()));
  const st = statements.find((s) => s.bank_id === bankRow?.id && s.statement_date === stmtDate);
  expect(st, `statement ${bank} ${stmtDate} should exist for cycle check`).toBeTruthy();
  const cycle = cycles.find((c) => c.statement_id === st!.id);
  expect(cycle, `payment cycle for ${bank} ${stmtDate} should exist`).toBeTruthy();
  return cycle!;
}

export const EXTRA_CHECKS: Record<string, (ctx: StmtCtx) => Promise<void> | void> = {
  // ---- CIMB 2024 set ----

  "eStatement20240119.pdf": (ctx) => {
    // Opening 0.01 with a 3.69 CR payment mid-cycle — no sign errors
    const { txns } = ctx.card("2225");
    expectTxn(txns, 3.69, { direction: "credit", type: "payment" });
  },

  "eStatement20240219.pdf": async (ctx) => {
    const { txns } = ctx.card("2225");
    expectTxn(txns, 1500.0, { type: "payment", descLike: /DUITNOW/i });
    expectTxn(txns, 1000.0, { type: "payment" });
    // prepayment: 2500 > prior balance 1397.84 -> prior cycle resolves paid_full
    const cycle = await cycleFor(ctx.store, "CIMB", "2024-01-19");
    expect(cycle.status).toBe("paid_full");
    expect(cycle.amount_paid).toBe(sen(2500.0));
  },

  "eStatement20240319.pdf": async (ctx) => {
    const { txns } = ctx.card("2225");
    // ground truth: "Payment 4019.91 exactly equals prior balance -> paid_full".
    // (The statement also carries a second 300.00 payment on 02 MAR; cumulative
    // detection legitimately includes it — FR-9.)
    expectTxn(txns, 4019.91, { type: "payment" });
    // TWD FX via numeric ISO code 901
    expectTxn(txns, 674.65, { currency: "TWD", original: 4440.0 });
    const cycle = await cycleFor(ctx.store, "CIMB", "2024-02-19");
    expect(cycle.status).toBe("paid_full");
    expect(cycle.amount_paid).toBeGreaterThanOrEqual(sen(4019.91));
  },

  "eStatement20240419.pdf": async (ctx) => {
    const { txns } = ctx.card("2225");
    // CRITICAL refund fixture: two Lazada CRs reverse PRIOR-statement purchases
    expectTxn(txns, 3090.31, { type: "refund", direction: "credit" });
    expectTxn(txns, 3229.74, { type: "refund", direction: "credit" });
    expectTxn(txns, 33.8, { type: "fee_interest", descLike: /FINANCE/i });
    // Mar cycle auto-detection must EXCLUDE the 6320.05 of refunds
    const cycle = await cycleFor(ctx.store, "CIMB", "2024-03-19");
    expect(cycle.amount_paid).toBe(sen(1240.0 + 1023.9));
  },

  "eStatement20240519.pdf": (ctx) => {
    const { txns } = ctx.card("2225");
    expectTxn(txns, 128.92, { type: "payment" });
    expectTxn(txns, 5.49, { type: "fee_interest", descLike: /FINANCE/i });
  },

  "eStatement20240619.pdf": (ctx) => {
    const { txns } = ctx.card("2225");
    // three separate payment rows, two of them same-day same-amount
    expectTxn(txns, 600.0, { type: "payment", count: 2 });
    expectTxn(txns, 1990.0, { type: "payment" });
    // HKD FX via numeric ISO code 344
    expectTxn(txns, 24.53, { currency: "HKD", original: 40.0 });
  },

  // ---- CIMB 2026 set ----

  "eStatement20260519.pdf": (ctx) => {
    const { txns } = ctx.card("2225");
    expect(txns.length, "31 transaction rows").toBe(31);
    expectTxn(txns, 71.83, { type: "fee_interest", descLike: /LATE/i });
    expectTxn(txns, 120.57, { type: "fee_interest", descLike: /FINANCE/i });
    // two-line FX: Alipay*Taobao
    expectTxn(txns, 443.36, { currency: "CNY", original: 749.22 });
  },

  "eStatement20260619.pdf": async (ctx) => {
    const { txns } = ctx.card("2225");
    // four different payment formats in one statement — all typed payment
    expectTxn(txns, 3900.0, { type: "payment", descLike: /CASH PAYMENT/i });
    expectTxn(txns, 2800.0, { type: "payment", descLike: /DUITNOW/i });
    expectTxn(txns, 9000.0, { type: "payment", descLike: /CLICKS/i });
    expectTxn(txns, 3515.66, { type: "payment", descLike: /CLICKS/i });
    expectTxn(txns, 11.16, { type: "fee_interest", descLike: /FINANCE/i });
    // cumulative payments 19215.66 > prior balance 13374.87 -> paid_full
    const cycle = await cycleFor(ctx.store, "CIMB", "2026-05-19");
    expect(cycle.status).toBe("paid_full");
    expect(cycle.amount_paid).toBe(sen(3900 + 2800 + 9000 + 3515.66));
  },

  // ---- RHB 2026 chain ----

  "RHB_4258608307183799_20260101.pdf": (ctx) => {
    // CR opening balance stored NEGATIVE is asserted generically (opening -127.02).
    const { txns } = ctx.card("3799");
    // YEAR BOUNDARY: Dec rows -> Dec 2025, Jan rows -> Jan 2026
    const dec = txns.filter((t) => t.txn_date.slice(5, 7) === "12");
    expect(dec.length, "statement must contain December transactions").toBeGreaterThan(0);
    for (const t of dec) expect(t.txn_date.slice(0, 4), t.description_raw).toBe("2025");
    for (const t of txns.filter((t) => t.txn_date.slice(5, 7) === "01")) {
      expect(t.txn_date.slice(0, 4), t.description_raw).toBe("2026");
    }
    // Supplementary card 2505: 3 purchases + payment 235.40 CR -> closes 0.00
    const supp = ctx.card("2505");
    expect(supp.txns.length).toBe(4);
    expectTxn(supp.txns, 74.1, { direction: "debit", type: "purchase" });
    expectTxn(supp.txns, 27.1, { direction: "debit", type: "purchase" });
    expectTxn(supp.txns, 134.2, { direction: "debit", type: "purchase" });
    expectTxn(supp.txns, 235.4, { direction: "credit", type: "payment" });
    expect(supp.sc.closing_balance).toBe(0);
  },

  "RHB_4258608307183799_20260301.pdf": (ctx) => {
    // supplementary 2505: zero activity — section parsed, no phantom rows
    const supp = ctx.card("2505");
    expect(supp.sc.opening_balance).toBe(0);
    expect(supp.sc.closing_balance).toBe(0);
    expect(supp.txns.length).toBe(0);
  },

  "RHB_4258608307183799_20260401.pdf": (ctx) => {
    const { txns } = ctx.card("3799");
    expectTxn(txns, 25.0, { type: "fee_interest", descLike: /SERVICE TAX/i });
    // due date 05/05/2026 palindromic — asserted generically via due_date match
  },

  "RHB_4258608307183799_20260501.pdf": async (ctx) => {
    const { txns } = ctx.card("3799");
    expectTxn(txns, 277.75, { type: "instalment", descLike: /01\/36/ });
    // two-line FX rows
    expectTxn(txns, 3306.82, { currency: "CNY", original: 5572.63, descLike: /WEIXIN/i });
    expectTxn(txns, 4022.42, { currency: "CNY", original: 6778.55 });
    // supp card 2505: service tax 25.00 + payment 25.00 CR -> closes 0.00
    const supp = ctx.card("2505");
    expectTxn(supp.txns, 25.0, { type: "fee_interest", direction: "debit" });
    expectTxn(supp.txns, 25.0, { type: "payment", direction: "credit" });
    expect(supp.sc.closing_balance).toBe(0);
  },

  "RHB_4258608307183799_20260601.pdf": (ctx) => {
    const { txns } = ctx.card("3799");
    expectTxn(txns, 277.75, { type: "instalment", descLike: /02\/36/ });
  },

  "RHB_4258608307183799_20260701.pdf": (ctx) => {
    const { txns } = ctx.card("3799");
    expectTxn(txns, 277.75, { type: "instalment", descLike: /03\/36/ });
    // merchant-named CR is a refund, not a payment
    expectTxn(txns, 470.57, { type: "refund", descLike: /WEIXIN/i });
    expectTxn(txns, 150.0, { type: "payment" });
    expectTxn(txns, 320.0, { type: "payment" });
  },
};

/** Extra checks keyed by (bank, statement_date) for the UOB file whose name is machine-generated. */
export const UOB_CHECK = (ctx: StmtCtx): void => {
  const { sc, txns } = ctx.card("2485");
  const purchases = txns.filter((t) => t.txn_type === "purchase");
  expect(purchases.length, "8 retail rows").toBe(8);
  const retailSum = purchases.reduce((s, t) => s + t.amount, 0);
  expect(retailSum, "retail rows sum 203.40").toBe(sen(203.4));
  // secondary cross-check against the printed Retail Purchase total
  const summary = sc.summary_totals_json ? JSON.parse(sc.summary_totals_json) : null;
  expect(summary?.retail_purchase_rm, "printed Retail Purchase total extracted").toBe(203.4);
  expectTxn(txns, 200.0, { type: "payment", direction: "credit" });
  // no posting-date column -> posting date nullable
  for (const t of txns) expect(t.posting_date).toBeNull();
};
