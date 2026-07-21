// FR-19 recurring/subscription detection. Layer 1 replays the real cached
// fixture set (pins computed 2026-07-21, cross-checked by hand: YouTube
// Premium's RM 33.90 -> 41.90 price rise is visible in the raw 2024 rows);
// layer 2 exercises each rule synthetically.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTxnDate } from "../src/dates.js";
import { extractionZ } from "../src/llm.js";
import { toSen } from "../src/money.js";
import {
  detectRecurring, monthlyCommitment, recurrenceKey, type RecurringInput,
} from "../src/recurring.js";
import { classifyTransaction } from "../src/typing.js";

const ROOT = path.resolve(import.meta.dirname, "..");

function loadPurchases(): RecurringInput[] {
  const dir = path.join(ROOT, "fixtures", "extractions");
  const rows: RecurringInput[] = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".extract.p1.json"))) {
    const ext = extractionZ.parse(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).result);
    if (!ext.statement_date) continue;
    for (const card of ext.cards) {
      for (const t of card.transactions) {
        if (classifyTransaction(t.description, t.direction) !== "purchase") continue;
        const d = resolveTxnDate(t.txn_date_raw, ext.statement_date);
        if (!d.iso) continue;
        rows.push({ description: t.description, date: d.iso, amount: toSen(t.amount_rm) });
      }
    }
  }
  return rows;
}

describe("recurring detection on the real fixture set", () => {
  const recs = detectRecurring(loadPurchases());
  const byKey = (k: string) => recs.find((r) => r.key === k);

  it("finds exactly 12 monthly recurrences", () => {
    expect(recs.length).toBe(12);
  });

  it("catches the YouTube Premium price rise (RM 33.90 -> 41.90, 9 charges)", () => {
    const yt = byKey("GOOGLE YOUTUBEPREMIUM")!;
    expect(yt.occurrences).toBe(9);
    expect(yt.cadenceDays).toBe(31);
    expect(yt.amountStable).toBe(true);
    expect(yt.priceChange).toEqual({ from: toSen(33.9), to: toSen(41.9) });
  });

  it("merges punctuation variants: TRADINGVIEWV*PRODUCT joins TRADINGVIEWVPRODUCT (8 charges, one chain)", () => {
    const tv = byKey("TRADINGVIEWVPRODUCT TV.SUPPORT")!;
    expect(tv.occurrences).toBe(8);
    expect(tv.priceChange).toEqual({ from: toSen(10.8), to: toSen(10.91) });
  });

  it("labels usage-based bills variable (Digi) — never a fixed commitment", () => {
    const digi = byKey("DIGI RPS SHAH ALAM")!;
    expect(digi.amountStable).toBe(false);
    expect(digi.priceChange).toBeNull();
  });

  it("a monthly-visited bakery is detected but variable, and never counts as commitment", () => {
    const bakery = byKey("BAKESTONE SDN. BHD. PULAU PINANG")!;
    expect(bakery.active).toBe(true);
    expect(bakery.amountStable).toBe(false);
    // every FIXED subscription chain ends in 2024 (the 2025 statements are
    // missing), so the honest active commitment today is zero
    expect(monthlyCommitment(recs)).toBe(0);
  });

  it("all fixed subscriptions read as ended across the missing-2025 gap", () => {
    for (const r of recs.filter((x) => x.amountStable)) {
      expect(r.active, r.key).toBe(false);
    }
  });
});

describe("recurrence rules (synthetic)", () => {
  const charge = (date: string, amount: number, desc = "NETFLIX.COM LOS GATOS SG"): RecurringInput => ({
    description: desc, date, amount: toSen(amount),
  });

  it("recurrenceKey drops per-charge reference tokens (Spotify) and punctuation", () => {
    expect(recurrenceKey("Spotify P424943C90 Stockholm SE"))
      .toBe(recurrenceKey("Spotify P4364BE8C9 Stockholm SE"));
    expect(recurrenceKey("TRADINGVIEWV*PRODUCT TV.SUPPORT"))
      .toBe(recurrenceKey("TRADINGVIEWVPRODUCT TV.SUPPORT"));
  });

  it("needs at least 3 charges on a 25-35 day cadence", () => {
    expect(detectRecurring([charge("2026-01-05", 54.9), charge("2026-02-05", 54.9)])).toEqual([]);
    const three = detectRecurring([
      charge("2026-01-05", 54.9), charge("2026-02-05", 54.9), charge("2026-03-05", 54.9),
      charge("2026-03-20", 12, "SOME CAFE PENANG MY"),
    ]);
    expect(three.length).toBe(1);
    expect(three[0]!.occurrences).toBe(3);
    expect(three[0]!.active).toBe(true);
  });

  it("weekly charges are frequent, not recurring-monthly", () => {
    const weekly = ["2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26", "2026-02-02"]
      .map((d) => charge(d, 20, "GRAB-EC PETALING JAYAMY"));
    expect(detectRecurring(weekly)).toEqual([]);
  });

  it("a >35-day gap breaks the chain; the longest run wins", () => {
    const rows = [
      charge("2025-01-05", 54.9), charge("2025-02-05", 54.9), charge("2025-03-05", 54.9),
      // 3-month hole (cancelled, resubscribed)
      charge("2025-06-20", 54.9), charge("2025-07-20", 54.9),
      charge("2025-08-20", 54.9), charge("2025-09-20", 54.9),
    ];
    const recs = detectRecurring(rows);
    expect(recs.length).toBe(1);
    expect(recs[0]!.occurrences).toBe(4); // the later, longer run
    expect(recs[0]!.firstSeen).toBe("2025-06-20");
  });

  it("goes inactive when the last charge is older than the activity window", () => {
    const rows = [
      charge("2026-01-05", 54.9), charge("2026-02-05", 54.9), charge("2026-03-05", 54.9),
      charge("2026-06-01", 99, "SOMETHING ELSE ENTIRELY KL MY"), // newest data point
    ];
    expect(detectRecurring(rows)[0]!.active).toBe(false);
  });

  it("monthly commitment counts only active AND fixed-price recurrences", () => {
    const rows = [
      charge("2026-05-05", 54.9), charge("2026-06-05", 54.9), charge("2026-07-05", 54.9),
      charge("2026-05-10", 30, "VARIABLE CAFE PENANG MY"),
      charge("2026-06-10", 90, "VARIABLE CAFE PENANG MY"),
      charge("2026-07-10", 15, "VARIABLE CAFE PENANG MY"),
    ];
    const recs = detectRecurring(rows);
    expect(recs.length).toBe(2);
    expect(monthlyCommitment(recs)).toBe(toSen(54.9)); // café excluded
  });
});
