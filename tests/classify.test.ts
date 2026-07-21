// Harness for FR-7 classification. Layer 1 replays the REAL fixture
// extractions (cached, deterministic, no API) and pins the hand-verifiable
// classification facts; layer 2 exercises each engine rule synthetically.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTO_ASSIGN_CONFIDENCE, buildConfirmationQueue, classifyRow, findRule,
  merchantKey, NoopSuggester, ruleFromConfirmation, SEED_RULES,
  type CategorySuggester, type Classification,
} from "../src/classify.js";
import { extractionZ } from "../src/llm.js";
import { classifyTransaction } from "../src/typing.js";
import type { TxnType } from "../src/types.js";

const ROOT = path.resolve(import.meta.dirname, "..");

interface RealRow { description: string; txnType: TxnType }

function loadRealRows(): RealRow[] {
  const dir = path.join(ROOT, "fixtures", "extractions");
  const rows: RealRow[] = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".extract.p1.json"))) {
    const ext = extractionZ.parse(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).result);
    for (const card of ext.cards) {
      for (const t of card.transactions) {
        rows.push({ description: t.description, txnType: classifyTransaction(t.description, t.direction) });
      }
    }
  }
  return rows;
}

async function classifyAll(rows: RealRow[]) {
  const suggester = new NoopSuggester();
  const out: { row: RealRow; c: Classification }[] = [];
  for (const row of rows) {
    out.push({ row, c: await classifyRow(row.description, row.txnType, SEED_RULES, suggester) });
  }
  return out;
}

// Pins re-computed 2026-07-20 after the 29-statement backfill grew the cached
// fixture set from 16 to 45 statements (363 -> 1,505 rows). Values derived
// deterministically from the cache and cross-checked by hand where itemizable.
describe("classification of the real fixture set (1,505 rows, seeds only, no LLM)", () => {
  it("pins the exact distribution: 628 auto-assigned, 83 payments uncategorised, 794 queued", async () => {
    const rows = loadRealRows();
    expect(rows.length).toBe(1505);
    const all = await classifyAll(rows);

    const payments = all.filter((x) => !x.c.queued && x.c.category === null);
    const assigned = all.filter((x) => !x.c.queued && x.c.category !== null);
    const queued = all.filter((x) => x.c.queued);
    expect(payments.length).toBe(83);
    expect(assigned.length).toBe(628);
    expect(queued.length).toBe(794);

    // every uncategorised non-queued row is a payment — nothing falls through silently
    for (const p of payments) expect(p.row.txnType).toBe("payment");

    const count = (cat: string) => assigned.filter((x) => x.c.category === cat).length;
    expect(count("Bank Fees & Interest")).toBe(14);
    expect(count("Online Purchases")).toBe(86);
    expect(count("Subscriptions")).toBe(28);
    expect(count("Refunds")).toBe(29);
  });

  it("keeps wallet top-ups (TNG EWALLET, GRABPAY) and instalments in the queue — owner decisions, never guesses", async () => {
    const all = await classifyAll(loadRealRows());
    const queuedDesc = all.filter((x) => x.c.queued).map((x) => x.row.description);
    // 9 "TNG EWALLET" + 3 hyphenated "TNG-EWALLET" (RHB/CIMB 2024 print variants)
    expect(queuedDesc.filter((d) => /^TNG[ -]EWALLET/.test(d)).length).toBe(12);
    expect(queuedDesc.filter((d) => d.startsWith("GRABPAY")).length).toBe(83);
    expect(queuedDesc.filter((d) => d.startsWith("EP-OGAWA")).length).toBe(3);
  });

  it("groups the queue by identical merchant: 310 groups, largest is 83x GRABPAY-EC", async () => {
    const all = await classifyAll(loadRealRows());
    const queue = buildConfirmationQueue(
      all.filter((x) => x.c.queued).map((x) => ({
        row: x.row, description: x.row.description,
        suggestion: x.c.confidence != null && x.c.category != null
          ? { category: x.c.category, confidence: x.c.confidence } : null,
      })),
    );
    expect(queue.length).toBe(310);
    expect(queue[0]!.merchant).toBe("GRABPAY-EC PETALING JAYAMY");
    expect(queue[0]!.rows.length).toBe(83);
    // one confirmation clears all rows of the group (FR-7 bulk confirm)
    expect(queue.reduce((a, g) => a + g.rows.length, 0)).toBe(794);
  });
});

describe("engine rules (synthetic)", () => {
  const noop = new NoopSuggester();

  it("merchantKey groups across the trailing country token only", () => {
    expect(merchantKey("LAZADA KUALA LUMPUR MY")).toBe("LAZADA KUALA LUMPUR");
    expect(merchantKey("Netflix.com Los Gatos SG")).toBe("NETFLIX.COM LOS GATOS");
    // different location strings stay distinct — only IDENTICAL merchants group
    expect(merchantKey("CBTL-SSQ BAYAN LEPAS MY")).not.toBe(merchantKey("CBTL-SOLARIA SQUARE BAYAN LEPAS MY"));
  });

  it("longest matching rule wins", () => {
    const rules = [
      { merchant_pattern: "GRAB", category: "Other" as const },
      { merchant_pattern: "GRAB RIDES", category: "Transport & Fuel" as const },
    ];
    expect(findRule("Grab Rides-EC Petaling Jaya MY", rules)!.category).toBe("Transport & Fuel");
  });

  it("type-driven categories precede merchant rules (a Lazada refund is a Refund, not Online Purchases)", async () => {
    const c = await classifyRow("LAZADA KUALA LUMPUR MY", "refund", SEED_RULES, noop);
    expect(c.category).toBe("Refunds");
    expect(c.source).toBe("type");
  });

  it("payments carry no category and never enter the queue", async () => {
    const c = await classifyRow("PYMT VIA SA/CA ACCOUNT-THK YOU 0907", "payment", SEED_RULES, noop);
    expect(c).toEqual({ category: null, source: null, confidence: null, rule: null, queued: false });
  });

  it("a high-confidence LLM suggestion auto-assigns; low confidence queues WITH the recommendation", async () => {
    const hi: CategorySuggester = { suggest: async () => ({ category: "F&B / Restaurants", confidence: 0.93 }) };
    const lo: CategorySuggester = { suggest: async () => ({ category: "F&B / Restaurants", confidence: 0.4 }) };
    const a = await classifyRow("UNKNOWN KOPITIAM PENANG MY", "purchase", SEED_RULES, hi);
    expect(a.queued).toBe(false);
    expect(a.source).toBe("llm");
    expect(a.confidence).toBeGreaterThanOrEqual(AUTO_ASSIGN_CONFIDENCE);
    const b = await classifyRow("UNKNOWN KOPITIAM PENANG MY", "purchase", SEED_RULES, lo);
    expect(b.queued).toBe(true);
    expect(b.category).toBe("F&B / Restaurants"); // shown as recommendation in the queue
  });

  it("a confirmation becomes a rule and the merchant never asks again", async () => {
    const before = await classifyRow("DOZO SUMMERSKYE SB BAYAN LEPAS MY", "purchase", SEED_RULES, noop);
    expect(before.queued).toBe(true);
    const learned = ruleFromConfirmation(merchantKey("DOZO SUMMERSKYE SB BAYAN LEPAS MY"), "F&B / Restaurants");
    const after = await classifyRow("DOZO SUMMERSKYE SB BAYAN LEPAS MY", "purchase",
      [...SEED_RULES, learned], noop);
    expect(after.queued).toBe(false);
    expect(after.category).toBe("F&B / Restaurants");
    expect(after.source).toBe("rule");
  });
});
