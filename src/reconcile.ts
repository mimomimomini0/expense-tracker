// FR-4 arithmetic reconciliation — the trust layer.
// opening - credits + debits must equal closing, exactly, in sen.

import type { Sen } from "./money.js";
import { toSen } from "./money.js";
import type { ExtractedCard } from "./types.js";

export interface CardReconciliation {
  last4: string;
  opening: Sen;
  closing: Sen;
  totalDebits: Sen;
  totalCredits: Sen;
  computedClosing: Sen;
  delta: Sen; // computedClosing - closing; 0 means exact
  secondaryMismatches: string[]; // printed summary totals that do not cross-check
}

export function reconcileCard(card: ExtractedCard): CardReconciliation {
  const opening = toSen(card.opening_balance_rm);
  const closing = toSen(card.closing_balance_rm);
  let debits = 0;
  let credits = 0;
  for (const t of card.transactions) {
    const amt = toSen(t.amount_rm);
    if (t.direction === "debit") debits += amt;
    else credits += amt;
  }
  const computedClosing = opening - credits + debits;

  const secondaryMismatches: string[] = [];
  const s = card.summary_totals;
  if (s) {
    if (s.total_debits_rm != null && toSen(s.total_debits_rm) !== debits) {
      secondaryMismatches.push(
        `printed total debits ${s.total_debits_rm} != extracted debits ${debits / 100}`,
      );
    }
    if (s.total_credits_rm != null && toSen(s.total_credits_rm) !== credits) {
      secondaryMismatches.push(
        `printed total credits ${s.total_credits_rm} != extracted credits ${credits / 100}`,
      );
    }
    if (s.retail_purchase_rm != null) {
      // Retail purchase total should equal the sum of purchase-like debit rows
      // (excludes fees/interest/cash advance). Checked loosely as a secondary
      // signal: it must not exceed total debits.
      if (toSen(s.retail_purchase_rm) > debits) {
        secondaryMismatches.push(
          `printed retail purchase ${s.retail_purchase_rm} exceeds extracted debits`,
        );
      }
    }
  }

  return {
    last4: card.last4,
    opening,
    closing,
    totalDebits: debits,
    totalCredits: credits,
    computedClosing,
    delta: computedClosing - closing,
  secondaryMismatches,
  };
}
