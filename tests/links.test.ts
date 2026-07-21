// Harness for transfer-linking (src/links.ts). Two layers:
//   1. REAL DATA: replays the cached fixture extractions (no API) and asserts
//      the hand-verified linking facts of the owner's actual statements:
//      7 TNG-pattern top-ups on the CIMB card, ZERO direct reload<->card links
//      (every reload is app-funded via OTATNGD or terminal cash), zero
//      inter-card transfers in the sample TNG history.
//   2. RULES: synthetic rows proving each matching rule — exact amount only,
//      date window, unambiguity, direction, inter-card time tolerance.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTxnDate } from "../src/dates.js";
import { extractionZ, CachingExtractor, sha256 } from "../src/llm.js";
import {
  isEwalletTopup,
  linkInterCardTransfers,
  linkReloadsToCardTxns,
  type LinkableCardTxn,
} from "../src/links.js";
import { toSen } from "../src/money.js";
import { parseTngPdf, type ResolvedTngRow } from "../src/tng.js";

const ROOT = path.resolve(import.meta.dirname, "..");

function loadFixtureCardTxns(): LinkableCardTxn[] {
  const dir = path.join(ROOT, "fixtures", "extractions");
  const out: LinkableCardTxn[] = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".extract.p1.json"))) {
    const cached = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const ext = extractionZ.parse(cached.result);
    if (!ext.statement_date) continue;
    for (const card of ext.cards) {
      for (const t of card.transactions) {
        const d = resolveTxnDate(t.txn_date_raw, ext.statement_date);
        if (!d.iso) continue; // unresolved dates never reach the transactions table
        out.push({
          id: null,
          txn_date: d.iso,
          description: t.description,
          amount: toSen(t.amount_rm),
          direction: t.direction,
          bank: ext.bank ?? undefined,
          last4: card.last4,
        });
      }
    }
  }
  return out;
}

async function loadTngRows(): Promise<ResolvedTngRow[]> {
  const file = "TransactionHistory_153975159.pdf";
  const pdf = fs.readFileSync(path.join(ROOT, "fixtures", "tng", file));
  const result = await parseTngPdf(new CachingExtractor(), file, pdf, sha256(pdf));
  expect(result.outcome).toBe("parsed_ok");
  return result.rows;
}

describe("transfer-linking on the real fixture set (cached, deterministic)", () => {
  it("finds exactly the 12 TNG eWallet top-ups/payments (9 CIMB + 3 RHB), none elsewhere", () => {
    // re-pinned 2026-07-20 after the 29-statement backfill grew the cached
    // fixture set from 16 to 45 statements. Itemized by hand from the cache:
    // CIMB 300+200+300+200+202+101+202+202+101, RHB 200+7.07+8.48
    const txns = loadFixtureCardTxns();
    const topups = txns.filter((t) => t.direction === "debit" && isEwalletTopup(t.description));
    expect(topups.length).toBe(12);
    expect(new Set(topups.map((t) => t.bank))).toEqual(new Set(["CIMB", "RHB"]));
    expect(topups.reduce((a, t) => a + t.amount, 0)).toBe(toSen(2023.55));
  });

  it("links NO reload directly to a card transaction — every reload is app-funded or terminal cash", async () => {
    const rows = await loadTngRows();
    const report = linkReloadsToCardTxns(rows, loadFixtureCardTxns());

    // The card statements show APP top-ups (RM100+1% fee = RM101, RM202...);
    // the NFC card reloads are funded FROM the app balance, so no direct
    // card<->reload link exists in this data. The matcher must not invent one.
    expect(report.links).toEqual([]);

    const reasons = new Map<string, number>();
    for (const u of report.unmatchedReloads) {
      reasons.set(u.reason, (reasons.get(u.reason) ?? 0) + 1);
    }
    // 12 reloads on card 1113643631 (9 internet + 3 terminal), 3 internet on 2164085007
    expect(reasons.get("app_funded")).toBe(12);
    expect(reasons.get("terminal_cash")).toBe(3);
    expect(report.unmatchedReloads.length).toBe(15);

    // all 12 top-ups therefore remain app-level transfers awaiting review
    expect(report.topupsWithoutReload.length).toBe(12);
  });

  it("finds no inter-card transfer in the sample TNG history", async () => {
    expect(linkInterCardTransfers(await loadTngRows())).toEqual([]);
  });
});

// ---------------- rule-level tests (synthetic rows) ----------------

function reload(over: Partial<ResolvedTngRow>): ResolvedTngRow {
  return {
    card_serial: "1113643631",
    trans_no: null,
    trans_date: "2026-06-20",
    trans_datetime: "2026-06-20 14:27:21",
    posted_date: null,
    kind: "reload",
    trans_type_raw: "Reload",
    sector: "INTERNET RELOAD",
    description: "INTERNET RELOAD",
    reload_source: "INTERNET RELOAD",
    amount: toSen(100),
    balance_after: toSen(109.55),
    ...over,
  };
}

function usage(over: Partial<ResolvedTngRow>): ResolvedTngRow {
  return {
    ...reload({}),
    kind: "usage",
    trans_type_raw: "Usage",
    sector: "TOLL",
    description: "SOME TOLL",
    reload_source: null,
    ...over,
  };
}

function txn(over: Partial<LinkableCardTxn>): LinkableCardTxn {
  return {
    id: null,
    txn_date: "2026-06-19",
    description: "TNG EWALLET E-COMM KUALA LUMPUR MY",
    amount: toSen(100),
    direction: "debit",
    ...over,
  };
}

describe("isEwalletTopup", () => {
  it("matches the owner's real top-up descriptions and obvious TNG variants", () => {
    expect(isEwalletTopup("TNG EWALLET E-COMM KUALA LUMPUR MY")).toBe(true);
    expect(isEwalletTopup("TNG EWALLET E-COMM 2 KUALA LUMPU MY")).toBe(true);
    expect(isEwalletTopup("TNGDIGITAL SDN BHD KUALA LUMPUR")).toBe(true);
    expect(isEwalletTopup("TOUCH N GO SDN BHD")).toBe(true);
  });
  it("never fires on ordinary merchants", () => {
    expect(isEwalletTopup("LIGHTNING CAFE PENANG")).toBe(false);
    expect(isEwalletTopup("STARBUCKS QUEENSBAY")).toBe(false);
    expect(isEwalletTopup("WATSONS PARKING")).toBe(false);
  });
});

describe("linkReloadsToCardTxns rules", () => {
  it("links an exact-amount TNG debit inside the window", () => {
    const r = linkReloadsToCardTxns([reload({})], [txn({})]);
    expect(r.links.length).toBe(1);
    expect(r.links[0]!.daysApart).toBe(1);
    expect(r.unmatchedReloads).toEqual([]);
    expect(r.topupsWithoutReload).toEqual([]);
  });

  it("refuses amounts that differ — even by a 1% fee", () => {
    const r = linkReloadsToCardTxns([reload({})], [txn({ amount: toSen(101) })]);
    expect(r.links).toEqual([]);
    expect(r.unmatchedReloads[0]!.reason).toBe("app_funded");
    expect(r.topupsWithoutReload.length).toBe(1);
  });

  it("refuses matches outside the date window", () => {
    const r = linkReloadsToCardTxns([reload({})], [txn({ txn_date: "2026-06-14" })]);
    expect(r.links).toEqual([]);
  });

  it("ignores credit-direction and non-TNG transactions", () => {
    const r = linkReloadsToCardTxns(
      [reload({})],
      [txn({ direction: "credit" }), txn({ description: "STARBUCKS QUEENSBAY" })],
    );
    expect(r.links).toEqual([]);
    expect(r.topupsWithoutReload).toEqual([]); // neither qualifies as a top-up debit
  });

  it("reports a tie as ambiguous instead of guessing", () => {
    const a = txn({ txn_date: "2026-06-19" });
    const b = txn({ txn_date: "2026-06-21" }); // both 1 day away
    const r = linkReloadsToCardTxns([reload({})], [a, b]);
    expect(r.links).toEqual([]);
    expect(r.unmatchedReloads[0]!.reason).toBe("ambiguous");
    expect(r.unmatchedReloads[0]!.candidates.length).toBe(2);
  });

  it("prefers the closest date and assigns each transaction at most once", () => {
    const near = txn({ txn_date: "2026-06-20" });
    const far = txn({ txn_date: "2026-06-18" });
    const r1 = reload({});
    const r2 = reload({ trans_date: "2026-06-18", trans_datetime: "2026-06-18 09:00:00" });
    const r = linkReloadsToCardTxns([r1, r2], [near, far]);
    expect(r.links.length).toBe(2);
    const byReload = new Map(r.links.map((l) => [l.reload, l.txn]));
    expect(byReload.get(r1)).toBe(near);
    expect(byReload.get(r2)).toBe(far);
  });
});

describe("linkInterCardTransfers rules", () => {
  const receiver = () =>
    reload({ card_serial: "1113643631", trans_datetime: "2026-06-20 12:00:00", amount: toSen(50) });
  const funder = (dt: string, over: Partial<ResolvedTngRow> = {}) =>
    usage({ card_serial: "2164085007", trans_datetime: dt, amount: toSen(50), ...over });

  it("links an equal-amount debit on a sibling card within minutes", () => {
    const links = linkInterCardTransfers([receiver(), funder("2026-06-20 11:58:30")]);
    expect(links.length).toBe(1);
    expect(links[0]!.minutesApart).toBeCloseTo(1.5, 5);
  });

  it("refuses beyond the time tolerance, same-card rows, and unequal amounts", () => {
    expect(linkInterCardTransfers([receiver(), funder("2026-06-20 12:20:00")])).toEqual([]);
    expect(
      linkInterCardTransfers([receiver(), funder("2026-06-20 11:58:30", { card_serial: "1113643631" })]),
    ).toEqual([]);
    expect(
      linkInterCardTransfers([receiver(), funder("2026-06-20 11:58:30", { amount: toSen(49) })]),
    ).toEqual([]);
  });

  it("a tie between two sibling debits links nothing", () => {
    const links = linkInterCardTransfers([
      receiver(),
      funder("2026-06-20 11:59:00"),
      funder("2026-06-20 12:01:00"),
    ]);
    expect(links).toEqual([]);
  });
});
