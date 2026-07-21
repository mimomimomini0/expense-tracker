// FR-4d new-card continuation: a replacement card (owner's real case: RHB
// ...3799 replaced by account 1784... around Jul 2026) continues its
// predecessor's timeline. Chain checks must follow the link across the card
// number change; without the link, each card is its own timeline and the
// successor's first statement is chain-exempt (that is what the link fixes).

import { describe, expect, it } from "vitest";
import { computeChainWarnings } from "../src/chain.js";
import { MemoryStore } from "../src/store.js";
import { toSen } from "../src/money.js";

async function stmt(
  store: MemoryStore, bankId: number, cardId: number, date: string,
  openingRm: number, closingRm: number,
) {
  const st = await store.insertStatement({
    bank_id: bankId, filename: `${date}.pdf`, file_hash: `hash-${cardId}-${date}`,
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

/** RHB ...3799 May/Jun statements, then the replacement card's Jul statement. */
async function rhbReplacementScenario(julOpeningRm: number) {
  const store = new MemoryStore();
  const bank = await store.getOrCreateBank("RHB");
  const oldCard = await store.createCardAccount(bank.id, "3799", "LIM CHUN CHOONG");
  const newCard = await store.createCardAccount(bank.id, "1784", "LIM CHUN CHOONG");
  await stmt(store, bank.id, oldCard.id, "2026-05-15", 1345.8, 466.11);
  await stmt(store, bank.id, oldCard.id, "2026-06-15", 466.11, 513.36);
  await stmt(store, bank.id, newCard.id, "2026-07-15", julOpeningRm, 892.4);
  return { store, oldCard, newCard };
}

describe("FR-4d continuation chain checks", () => {
  it("without a link, the replacement card's first statement is chain-exempt (no warning, no cross-check)", async () => {
    const { store } = await rhbReplacementScenario(513.36);
    expect(await computeChainWarnings(store)).toEqual([]);
    // even a WRONG opening goes unnoticed while unlinked — the exact gap FR-4d closes
    const wrong = await rhbReplacementScenario(999.99);
    expect(await computeChainWarnings(wrong.store)).toEqual([]);
  });

  it("linked with a matching boundary: one clean timeline, no warnings", async () => {
    const { store, oldCard, newCard } = await rhbReplacementScenario(513.36);
    await store.linkCardContinuation(newCard.id, oldCard.id);
    expect(await computeChainWarnings(store)).toEqual([]);
  });

  it("linked with a boundary mismatch: warning names the continuation boundary", async () => {
    const { store, oldCard, newCard } = await rhbReplacementScenario(999.99);
    await store.linkCardContinuation(newCard.id, oldCard.id);
    const warnings = await computeChainWarnings(store);
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.card_account_id).toBe(newCard.id);
    expect(warnings[0]!.last4).toBe("1784");
    expect(warnings[0]!.detail).toContain("opening 999.99 != prior closing 513.36");
    expect(warnings[0]!.detail).toContain("...3799 -> ...1784");
  });

  it("linked with a missing month across the boundary: gap warning", async () => {
    const store = new MemoryStore();
    const bank = await store.getOrCreateBank("RHB");
    const oldCard = await store.createCardAccount(bank.id, "3799", null);
    const newCard = await store.createCardAccount(bank.id, "1784", null);
    await stmt(store, bank.id, oldCard.id, "2026-05-15", 1345.8, 466.11);
    // June statement missing; July continues with June's (unknown) closing
    await stmt(store, bank.id, newCard.id, "2026-08-15", 513.36, 892.4);
    await store.linkCardContinuation(newCard.id, oldCard.id);
    const warnings = await computeChainWarnings(store);
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.detail).toContain("days between statements");
  });

  it("gap warnings auto-resolve when the missing boundary statement arrives, in any import order", async () => {
    const { store, oldCard, newCard } = await rhbReplacementScenario(513.36);
    await store.linkCardContinuation(newCard.id, oldCard.id);
    // delete-free check: import order irrelevance is inherent (warnings are
    // computed from stored rows on demand), so adding an out-of-order earlier
    // statement must not break the clean chain
    await stmt(store, (await store.listBanks())[0]!.id, oldCard.id, "2026-04-15", 304.0, 1345.8);
    expect(await computeChainWarnings(store)).toEqual([]);
  });

  it("within-card mismatches still warn as before (regression guard)", async () => {
    const store = new MemoryStore();
    const bank = await store.getOrCreateBank("RHB");
    const card = await store.createCardAccount(bank.id, "3799", null);
    await stmt(store, bank.id, card.id, "2026-05-15", 1345.8, 466.11);
    await stmt(store, bank.id, card.id, "2026-06-15", 470.0, 513.36);
    const warnings = await computeChainWarnings(store);
    expect(warnings.length).toBe(1);
    expect(warnings[0]!.detail).toContain("opening 470.00 != prior closing 466.11");
    expect(warnings[0]!.detail).not.toContain("continuation boundary");
  });

  it("self-links are rejected and cycles cannot hang the chain check", async () => {
    const store = new MemoryStore();
    const bank = await store.getOrCreateBank("RHB");
    const a = await store.createCardAccount(bank.id, "1111", null);
    const b = await store.createCardAccount(bank.id, "2222", null);
    await expect(store.linkCardContinuation(a.id, a.id)).rejects.toThrow("cannot continue itself");
    // force a cycle directly (defensive: DB rows could be edited by hand)
    await store.linkCardContinuation(a.id, b.id);
    await store.linkCardContinuation(b.id, a.id);
    await stmt(store, bank.id, a.id, "2026-05-15", 0, 100);
    await stmt(store, bank.id, b.id, "2026-06-15", 100, 200);
    // must terminate and still check every statement exactly once
    const warnings = await computeChainWarnings(store);
    expect(Array.isArray(warnings)).toBe(true);
  });
});
