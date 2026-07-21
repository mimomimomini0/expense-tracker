// FR-18 dispute-window alerts & unusual-item flags. Real-data layer pins the
// fixture set at a FIXED "today" (2026-07-21) so the assertions never rot;
// synthetic layer exercises each rule.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTxnDate } from "../src/dates.js";
import { computeDisputeAlerts, DISPUTE_WINDOW_DAYS, type FlagTxnInput } from "../src/flags.js";
import { extractionZ } from "../src/llm.js";
import { toSen } from "../src/money.js";
import { classifyTransaction } from "../src/typing.js";

const ROOT = path.resolve(import.meta.dirname, "..");

function loadInputs(): FlagTxnInput[] {
  const dir = path.join(ROOT, "fixtures", "extractions");
  const txns: FlagTxnInput[] = [];
  let sid = 0, tid = 0;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".extract.p1.json")).sort()) {
    const ext = extractionZ.parse(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).result);
    if (!ext.statement_date) continue;
    sid++;
    for (const card of ext.cards) {
      for (const t of card.transactions) {
        const type = classifyTransaction(t.description, t.direction);
        if (type !== "purchase" && type !== "cash_advance") continue;
        const d = resolveTxnDate(t.txn_date_raw, ext.statement_date);
        if (!d.iso) continue;
        txns.push({
          id: ++tid, statementId: sid, statementDate: ext.statement_date,
          txnDate: d.iso, description: t.description, amount: toSen(t.amount_rm),
          direction: t.direction, originalCurrency: t.original_currency ?? null,
        });
      }
    }
  }
  return txns;
}

describe("FR-18 on the real fixture set (today pinned to 2026-07-21)", () => {
  const alerts = computeDisputeAlerts(loadInputs(), "2026-07-21");

  it("exactly two statements have an open dispute window", () => {
    expect(alerts.map((a) => [a.statementDate, a.deadline, a.daysLeft])).toEqual([
      ["2026-07-08", "2026-07-22", 1],
      ["2026-07-15", "2026-07-29", 8],
    ]);
  });

  it("UOB 2026-07-08: four same-merchant-same-amount coffee rows flagged duplicate", () => {
    const uob = alerts[0]!;
    expect(uob.flagged.length).toBe(4);
    for (const f of uob.flagged) {
      expect(f.reasons).toEqual(["duplicate"]);
      expect(f.description).toContain("CBTL-SOLARIA SQUARE");
    }
  });

  it("RHB 2026-07-15: the China-trip FX rows flag, incl. the metro triple-charge", () => {
    const rhb = alerts[1]!;
    expect(rhb.flagged.length).toBe(6);
    const metro = rhb.flagged.filter((f) => f.description.startsWith("ALP*Shenzhen Metro"));
    expect(metro.length).toBe(3);
    for (const m of metro) {
      expect(m.reasons).toEqual(["first_seen", "foreign_currency", "duplicate"]);
    }
    expect(rhb.flagged.every((f) => f.reasons.length > 0)).toBe(true);
  });

  it("backfilled statements (windows long closed) raise nothing", () => {
    expect(alerts.some((a) => a.statementDate < "2026-07-01")).toBe(false);
  });
});

describe("FR-18 rules (synthetic)", () => {
  const txn = (over: Partial<FlagTxnInput>): FlagTxnInput => ({
    id: 1, statementId: 1, statementDate: "2026-07-15", txnDate: "2026-07-01",
    description: "STARBUCKS QUEENSBAY MY", amount: toSen(20),
    direction: "debit", originalCurrency: null, ...over,
  });

  it("no alert once the 14-day window has passed", () => {
    expect(computeDisputeAlerts([txn({})], "2026-07-30")).toEqual([]);
    // deadline day itself still alerts (daysLeft 0)
    expect(computeDisputeAlerts([txn({})], "2026-07-29")[0]!.daysLeft).toBe(0);
    expect(DISPUTE_WINDOW_DAYS).toBe(14);
  });

  it("first_seen compares against EARLIER statements only", () => {
    const rows = [
      txn({ id: 1, statementId: 1, statementDate: "2026-06-15", txnDate: "2026-06-01" }),
      txn({ id: 2, statementId: 2, statementDate: "2026-07-15", txnDate: "2026-07-01" }),
      txn({ id: 3, statementId: 2, statementDate: "2026-07-15", txnDate: "2026-07-02", description: "BRAND NEW SHOP KL MY", amount: toSen(99) }),
    ];
    const alerts = computeDisputeAlerts(rows, "2026-07-20");
    expect(alerts.length).toBe(1); // June window closed
    const flagged = alerts[0]!.flagged;
    expect(flagged.map((f) => f.id)).toEqual([3]); // Starbucks known from June
    expect(flagged[0]!.reasons).toEqual(["first_seen"]);
  });

  it("duplicate needs same merchant AND same amount; credits are never flagged", () => {
    const rows = [
      txn({ id: 1, txnDate: "2026-07-01", amount: toSen(20) }),
      txn({ id: 2, txnDate: "2026-07-03", amount: toSen(20) }),
      txn({ id: 3, txnDate: "2026-07-05", amount: toSen(25) }), // different price — not a dup
      txn({ id: 4, txnDate: "2026-07-06", amount: toSen(20), direction: "credit" }),
    ];
    const flagged = computeDisputeAlerts(rows, "2026-07-20")[0]!.flagged;
    const dupIds = flagged.filter((f) => f.reasons.includes("duplicate")).map((f) => f.id);
    expect(dupIds).toEqual([1, 2]);
    expect(flagged.some((f) => f.id === 4)).toBe(false);
  });
});
