// FR-4d continuation auto-detection (owner clarification 2026-07-21): a
// replacement card arrives in the same statement series with the balance
// carried over, so the system detects the handoff instead of asking.

import { describe, expect, it } from "vitest";
import { detectContinuations } from "../src/continuation.js";
import { MemoryStore } from "../src/store.js";
import { toSen } from "../src/money.js";

async function stmt(
  store: MemoryStore, bankId: number, cardId: number, date: string,
  openingRm: number, closingRm: number,
) {
  const st = await store.insertStatement({
    bank_id: bankId, filename: `${cardId}-${date}.pdf`, file_hash: `h-${cardId}-${date}`,
    statement_date: date, period_start: null, period_end: null, payment_due_date: null,
    status: "parsed_ok", model_version: "test", prompt_version: "p1",
    retry_count: 0, review_reason: null, raw_extraction_json: "{}",
  });
  await store.insertStatementCard({
    statement_id: st.id, card_account_id: cardId,
    opening_balance: toSen(openingRm), closing_balance: toSen(closingRm),
    minimum_due: null, credit_limit: null, retail_interest_rate: null,
    summary_totals_json: null, instalment_summaries_json: null, reconciliation_delta: 0,
  });
}

async function detect(store: MemoryStore) {
  return detectContinuations(
    await store.listCardAccounts(),
    await store.listStatements(),
    await store.listStatementCards(),
  );
}

describe("continuation auto-detection", () => {
  it("detects a non-zero balance handoff and marks it confident", async () => {
    const store = new MemoryStore();
    const bank = await store.getOrCreateBank("RHB");
    const oldCard = await store.createCardAccount(bank.id, "3799", null);
    const newCard = await store.createCardAccount(bank.id, "1784", null);
    await stmt(store, bank.id, oldCard.id, "2026-05-15", 1345.8, 466.11);
    await stmt(store, bank.id, oldCard.id, "2026-06-15", 466.11, 513.36);
    await stmt(store, bank.id, newCard.id, "2026-07-15", 513.36, 892.4);
    const found = await detect(store);
    expect(found.length).toBe(1);
    expect(found[0]!.predecessor.last4).toBe("3799");
    expect(found[0]!.successor.last4).toBe("1784");
    expect(found[0]!.confident).toBe(true);
    expect(found[0]!.handoffBalance).toBe(toSen(513.36));
  });

  it("detects a mid-cycle replacement printed in the SAME statement document", async () => {
    const store = new MemoryStore();
    const bank = await store.getOrCreateBank("RHB");
    const oldCard = await store.createCardAccount(bank.id, "3799", null);
    const newCard = await store.createCardAccount(bank.id, "1784", null);
    await stmt(store, bank.id, oldCard.id, "2026-06-15", 466.11, 513.36);
    // same statement date: old section closes, new section opens with the balance
    await stmt(store, bank.id, newCard.id, "2026-06-15", 513.36, 513.36);
    const found = await detect(store);
    expect(found.length).toBe(1);
    expect(found[0]!.confident).toBe(true);
  });

  it("a zero-balance handoff is a proposal, never confident", async () => {
    const store = new MemoryStore();
    const bank = await store.getOrCreateBank("UOB");
    const a = await store.createCardAccount(bank.id, "7388", null);
    const b = await store.createCardAccount(bank.id, "2485", null);
    await stmt(store, bank.id, a.id, "2024-12-08", 120, 0);
    await stmt(store, bank.id, b.id, "2026-01-08", 0, 250);
    const found = await detect(store);
    expect(found.length).toBe(1);
    expect(found[0]!.confident).toBe(false);
    expect(found[0]!.reason).toContain("zero-balance");
  });

  it("concurrent cards (principal + supplementary) are never continuations", async () => {
    const store = new MemoryStore();
    const bank = await store.getOrCreateBank("RHB");
    const a = await store.createCardAccount(bank.id, "7145", null);
    const b = await store.createCardAccount(bank.id, "2505", null);
    // b happens to open with a's closing balance, but both keep appearing
    await stmt(store, bank.id, a.id, "2024-01-15", 0, 500);
    await stmt(store, bank.id, b.id, "2024-02-15", 500, 600);
    await stmt(store, bank.id, a.id, "2024-03-15", 500, 700);
    expect(await detect(store)).toEqual([]);
  });

  it("different banks never match; balance mismatches never match", async () => {
    const store = new MemoryStore();
    const rhb = await store.getOrCreateBank("RHB");
    const uob = await store.getOrCreateBank("UOB");
    const a = await store.createCardAccount(rhb.id, "3799", null);
    const b = await store.createCardAccount(uob.id, "2485", null);
    const c = await store.createCardAccount(rhb.id, "1784", null);
    await stmt(store, rhb.id, a.id, "2026-06-15", 466.11, 513.36);
    await stmt(store, uob.id, b.id, "2026-07-08", 513.36, 100);   // right balance, wrong bank
    await stmt(store, rhb.id, c.id, "2026-07-15", 999.99, 1000);  // right bank, wrong balance
    expect(await detect(store)).toEqual([]);
  });

  it("ambiguous multi-candidate handoffs are demoted to proposals", async () => {
    const store = new MemoryStore();
    const bank = await store.getOrCreateBank("RHB");
    const pred = await store.createCardAccount(bank.id, "3799", null);
    const s1 = await store.createCardAccount(bank.id, "1784", null);
    const s2 = await store.createCardAccount(bank.id, "9999", null);
    await stmt(store, bank.id, pred.id, "2026-06-15", 400, 513.36);
    await stmt(store, bank.id, s1.id, "2026-07-15", 513.36, 600);
    await stmt(store, bank.id, s2.id, "2026-07-15", 513.36, 700);
    const found = await detect(store);
    expect(found.length).toBe(2);
    expect(found.every((f) => !f.confident)).toBe(true);
  });

  it("already-linked cards are skipped", async () => {
    const store = new MemoryStore();
    const bank = await store.getOrCreateBank("RHB");
    const oldCard = await store.createCardAccount(bank.id, "3799", null);
    const newCard = await store.createCardAccount(bank.id, "1784", null);
    await stmt(store, bank.id, oldCard.id, "2026-06-15", 466.11, 513.36);
    await stmt(store, bank.id, newCard.id, "2026-07-15", 513.36, 892.4);
    await store.linkCardContinuation(newCard.id, oldCard.id);
    expect(await detect(store)).toEqual([]);
  });
});
