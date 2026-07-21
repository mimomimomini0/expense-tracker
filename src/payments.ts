// FR-9 payment auto-detection (Phase 1 subset needed by the harness).
// A cycle may be settled by MULTIPLE payments: the detection SUMS all rows
// typed `payment` in the FOLLOWING statement (refund CRs excluded by typing),
// and compares the cumulative total against the prior cycle's statement
// balance. Prepayment (sum > balance) still resolves paid_full.
// Cycles are recomputed from all stored statements — order independent.

import type { Store } from "./store.js";
import type { PaymentCycleRow } from "./types.js";
import { daysBetween } from "./dates.js";

const MAX_ADJACENT_DAYS = 45;

export async function recomputePaymentCycles(store: Store, cardAccountId: number): Promise<void> {
  const statements = await store.listStatements();
  const stmtCards = (await store.listStatementCards()).filter(
    (sc) => sc.card_account_id === cardAccountId,
  );
  const txns = (await store.listTransactions()).filter((t) => t.card_account_id === cardAccountId);
  // FR-9: a payment the USER recorded must survive a recompute — statement
  // evidence (auto-detection) beats it, but "no evidence yet" never erases it
  const recorded = new Map(
    (await store.listPaymentCycles())
      .filter((c) => c.card_account_id === cardAccountId && c.paid_recorded_at != null)
      .map((c) => [c.statement_id, c]),
  );

  const entries = stmtCards
    .map((sc) => ({ sc, st: statements.find((s) => s.id === sc.statement_id)! }))
    .filter((e) => e.st)
    .sort((a, b) => a.st.statement_date.localeCompare(b.st.statement_date));

  const cycles: Omit<PaymentCycleRow, "id" | "card_account_id">[] = [];

  for (let i = 0; i < entries.length; i++) {
    const cur = entries[i]!;
    const next = entries[i + 1];
    const balance = cur.sc.closing_balance;
    const minimum = cur.sc.minimum_due;

    let amountPaid = 0;
    let detected = false;
    if (next && daysBetween(cur.st.statement_date, next.st.statement_date) <= MAX_ADJACENT_DAYS) {
      // the following statement exists — sum its payment rows
      amountPaid = txns
        .filter((t) => t.statement_card_id === next.sc.id && t.txn_type === "payment")
        .reduce((sum, t) => sum + t.amount, 0);
      detected = true;
    }

    let status: PaymentCycleRow["status"];
    if (balance <= 0) {
      status = "paid_full"; // nothing owed (zero or CR balance)
    } else if (detected && amountPaid >= balance) {
      status = "paid_full";
    } else if (detected && minimum != null && amountPaid >= minimum) {
      status = "paid_minimum";
    } else if (detected && amountPaid > 0) {
      status = "paid_other";
    } else {
      status = "unpaid";
    }

    const manual = recorded.get(cur.st.id);
    if (status === "unpaid" && manual) {
      // no statement evidence (yet) — the user's recorded payment stands
      cycles.push({
        statement_id: cur.st.id,
        due_date: cur.st.payment_due_date,
        statement_balance: balance,
        minimum_due: minimum,
        status: manual.status,
        amount_paid: manual.amount_paid,
        paid_recorded_at: manual.paid_recorded_at,
        auto_detected: false,
      });
      continue;
    }

    cycles.push({
      statement_id: cur.st.id,
      due_date: cur.st.payment_due_date,
      statement_balance: balance,
      minimum_due: minimum,
      status,
      amount_paid: amountPaid,
      paid_recorded_at: null,
      auto_detected: detected,
    });
  }

  await store.replacePaymentCycles(cardAccountId, cycles);
}
