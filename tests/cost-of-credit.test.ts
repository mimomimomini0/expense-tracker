// FR-20 cost-of-credit + tier tracking. Real-data pins from the cached
// fixture set (cross-checked against db-verify's fee totals) + synthetic
// worsening rules.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTxnDate } from "../src/dates.js";
import { extractionZ } from "../src/llm.js";
import { toSen } from "../src/money.js";
import { summarizeFees, trackTiers, type FeeRow, type TierPoint } from "../src/cost-of-credit.js";
import { classifyTransaction } from "../src/typing.js";

const ROOT = path.resolve(import.meta.dirname, "..");

function loadReal(): { fees: FeeRow[]; tiers: TierPoint[] } {
  const dir = path.join(ROOT, "fixtures", "extractions");
  const fees: FeeRow[] = [];
  const tiers: TierPoint[] = [];
  const cardIds = new Map<string, number>();
  const cid = (k: string) => {
    if (!cardIds.has(k)) cardIds.set(k, cardIds.size + 1);
    return cardIds.get(k)!;
  };
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".extract.p1.json")).sort()) {
    const ext = extractionZ.parse(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).result);
    if (!ext.statement_date) continue;
    for (const card of ext.cards) {
      const id = cid(`${ext.bank}:${card.last4}`);
      if (card.retail_interest_rate_pct != null) {
        tiers.push({ cardId: id, statementDate: ext.statement_date, rate: card.retail_interest_rate_pct });
      }
      for (const t of card.transactions) {
        if (classifyTransaction(t.description, t.direction) !== "fee_interest") continue;
        const d = resolveTxnDate(t.txn_date_raw, ext.statement_date);
        fees.push({ cardId: id, date: d.iso ?? ext.statement_date, amount: toSen(t.amount_rm), description: t.description });
      }
    }
  }
  return { fees, tiers };
}

describe("FR-20 on the real fixture set", () => {
  const { fees, tiers } = loadReal();

  it("what the cards cost: 14 fee rows, RM 532.85 (2024: 279.29, 2026: 253.56)", () => {
    const s = summarizeFees(fees);
    expect(s.count).toBe(14);
    expect(s.total).toBe(toSen(532.85));
    expect(s.byYear.map((y) => [y.year, y.total])).toEqual([
      ["2024", toSen(279.29)],
      ["2026", toSen(253.56)],
    ]);
    expect(s.byCard[0]!.total).toBe(toSen(267.85)); // CIMB — the costliest card
  });

  it("59 printed rates across 6 cards — all steady at 15%, no worsening", () => {
    expect(tiers.length).toBe(59);
    const th = trackTiers(tiers);
    expect(th.length).toBe(6);
    for (const t of th) {
      expect(t.latestWorsened).toBe(false);
      expect(t.history.every((h) => h.rate === 15)).toBe(true);
    }
  });
});

describe("tier rules (synthetic)", () => {
  it("flags a rise vs the PREVIOUS statement, per card; improvement is not flagged", () => {
    const th = trackTiers([
      { cardId: 1, statementDate: "2026-05-15", rate: 15 },
      { cardId: 1, statementDate: "2026-06-15", rate: 17 }, // worsened
      { cardId: 1, statementDate: "2026-07-15", rate: 15 }, // improved — no flag
      { cardId: 2, statementDate: "2026-07-15", rate: 18 }, // first point — no baseline
    ]);
    const c1 = th.find((t) => t.cardId === 1)!;
    expect(c1.history.map((h) => h.worsened)).toEqual([false, true, false]);
    expect(c1.latestWorsened).toBe(false);
    expect(th.find((t) => t.cardId === 2)!.latestWorsened).toBe(false);
  });

  it("latestWorsened alerts when the newest statement is the worse one", () => {
    const th = trackTiers([
      { cardId: 1, statementDate: "2026-06-15", rate: 15 },
      { cardId: 1, statementDate: "2026-07-15", rate: 17 },
    ]);
    expect(th[0]!.latestWorsened).toBe(true);
  });
});
