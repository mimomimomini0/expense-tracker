// FR-9: a payment the user RECORDED must survive recomputePaymentCycles
// (imports recompute cycles per card; "no statement evidence yet" must never
// erase the user's recording — but real statement evidence beats it).

import { describe, expect, it } from "vitest";
import { recomputePaymentCycles } from "../src/payments.js";
import { MemoryStore } from "../src/store.js";
import { toSen } from "../src/money.js";

async function seedStatement(
  store: MemoryStore, bankId: number, cardId: number, date: string, due: string | null,
  openingRm: number, closingRm: number, minimumRm: number | null,
) {
  const st = await store.insertStatement({
    bank_id: bankId, filename: `${date}.pdf`, file_hash: `h-${cardId}-${date}`,
    statement_date: date, period_start: null, period_end: null, payment_due_date: due,
    status: "parsed_ok", model_version: "t", prompt_version: "p1",
    retry_count: 0, review_reason: null, raw_extraction_json: "{}",
  });
  const sc = await store.insertStatementCard({
    statement_id: st.id, card_account_id: cardId,
    opening_balance: toSen(openingRm), closing_balance: toSen(closingRm),
    minimum_due: minimumRm != null ? toSen(minimumRm) : null, credit_limit: null,
    retail_interest_rate: null, summary_totals_json: null,
    instalment_summaries_json: null, reconciliation_delta: 0,
  });
  return { st, sc };
}

describe("payment recording survives recompute", () => {
  it("keeps a user-recorded payment when no statement evidence exists", async () => {
    const store = new MemoryStore();
    const bank = await store.getOrCreateBank("RHB");
    const card = await store.createCardAccount(bank.id, "3799", null);
    const { st } = await seedStatement(store, bank.id, card.id, "2026-07-15", "2026-08-04", 466.11, 513.36, 289.53);

    await recomputePaymentCycles(store, card.id);
    let cycles = await store.listPaymentCycles();
    expect(cycles.length).toBe(1);
    expect(cycles[0]!.status).toBe("unpaid");

    // user records full payment (what the web UI's server action does)
    await store.replacePaymentCycles(card.id, [{
      statement_id: st.id, due_date: "2026-08-04",
      statement_balance: toSen(513.36), minimum_due: toSen(289.53),
      status: "paid_full", amount_paid: toSen(513.36),
      paid_recorded_at: "2026-07-21T10:00:00Z", auto_detected: false,
    }]);

    // an unrelated recompute (e.g. another statement imported) must NOT erase it
    await recomputePaymentCycles(store, card.id);
    cycles = await store.listPaymentCycles();
    expect(cycles.length).toBe(1);
    expect(cycles[0]!.status).toBe("paid_full");
    expect(cycles[0]!.amount_paid).toBe(toSen(513.36));
    expect(cycles[0]!.paid_recorded_at).toBe("2026-07-21T10:00:00Z");
  });

  it("statement evidence (auto-detection) beats the manual recording", async () => {
    const store = new MemoryStore();
    const bank = await store.getOrCreateBank("RHB");
    const card = await store.createCardAccount(bank.id, "3799", null);
    const jul = await seedStatement(store, bank.id, card.id, "2026-07-15", "2026-08-04", 466.11, 513.36, 289.53);

    // user records "other" amount first
    await recomputePaymentCycles(store, card.id);
    await store.replacePaymentCycles(card.id, [{
      statement_id: jul.st.id, due_date: "2026-08-04",
      statement_balance: toSen(513.36), minimum_due: toSen(289.53),
      status: "paid_other", amount_paid: toSen(100),
      paid_recorded_at: "2026-07-21T10:00:00Z", auto_detected: false,
    }]);

    // next statement arrives showing the REAL payment of the full balance
    const aug = await seedStatement(store, bank.id, card.id, "2026-08-15", "2026-09-04", 513.36, 200, 100);
    await store.insertTransactions([{
      statement_card_id: aug.sc.id, card_account_id: card.id,
      txn_date: "2026-08-01", posting_date: null,
      description_raw: "PYMT VIA SA/CA ACCOUNT-THK YOU", amount: toSen(513.36),
      direction: "credit", original_currency: null, original_amount: null,
      txn_type: "payment",
    }]);

    await recomputePaymentCycles(store, card.id);
    const julCycle = (await store.listPaymentCycles()).find((c) => c.statement_id === jul.st.id)!;
    expect(julCycle.status).toBe("paid_full");
    expect(julCycle.amount_paid).toBe(toSen(513.36));
    expect(julCycle.auto_detected).toBe(true);
    expect(julCycle.paid_recorded_at).toBeNull(); // superseded by evidence
  });
});
