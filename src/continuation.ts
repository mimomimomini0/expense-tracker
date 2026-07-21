// FR-4d continuation auto-detection (owner clarification, 21 Jul 2026):
// a replacement card keeps arriving in the SAME statement series — the old
// card's section stops, the new number's section starts, and the balance
// carries over. So continuation is DETECTABLE from the data: same bank, the
// old card's last printed closing equals the new card's first printed
// opening, and the two never overlap afterwards. The system auto-links the
// unambiguous non-zero handoffs and only surfaces the rest as proposals —
// the card number itself stays on every row, so nothing loses attribution.
//
// Conservative by design:
//  - a ZERO-balance handoff matches any fresh card, so it is never
//    auto-linked (proposal only);
//  - a candidate matching more than one predecessor/successor links nothing;
//  - cards that keep appearing after the candidate successor starts are
//    concurrent (principal + supplementary), never a continuation.

import type { CardAccountRow, StatementCardRow, StatementRow } from "./types.js";
import { formatRm } from "./money.js";

export interface ContinuationCandidate {
  predecessor: CardAccountRow;
  successor: CardAccountRow;
  handoffBalance: number; // sen — predecessor's last closing == successor's first opening
  predecessorLastDate: string;
  successorFirstDate: string;
  confident: boolean; // true -> safe to auto-link
  reason: string;
}

interface CardSpan {
  card: CardAccountRow;
  firstDate: string;
  lastDate: string;
  firstOpening: number;
  lastClosing: number;
}

export function detectContinuations(
  cards: CardAccountRow[],
  statements: StatementRow[],
  stmtCards: StatementCardRow[],
): ContinuationCandidate[] {
  const dateOf = new Map(statements.map((s) => [s.id, s.statement_date]));

  const spans: CardSpan[] = [];
  for (const card of cards) {
    const entries = stmtCards
      .filter((sc) => sc.card_account_id === card.id)
      .map((sc) => ({ sc, date: dateOf.get(sc.statement_id)! }))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (entries.length === 0) continue;
    spans.push({
      card,
      firstDate: entries[0]!.date,
      lastDate: entries[entries.length - 1]!.date,
      firstOpening: entries[0]!.sc.opening_balance,
      lastClosing: entries[entries.length - 1]!.sc.closing_balance,
    });
  }

  const candidates: ContinuationCandidate[] = [];
  for (const pred of spans) {
    if (cards.some((c) => c.continues_card_id === pred.card.id)) continue; // already continued
    for (const succ of spans) {
      if (pred.card.id === succ.card.id) continue;
      if (pred.card.bank_id !== succ.card.bank_id) continue;
      if (succ.card.continues_card_id != null) continue; // already linked
      // successor must start when (or after) the predecessor stops — a
      // same-date pair is the mid-cycle replacement printed in one statement
      // document; anything overlapping is concurrent cards (principal +
      // supplementary), never a continuation
      if (succ.firstDate < pred.lastDate) continue;
      if (succ.firstOpening !== pred.lastClosing) continue;
      candidates.push({
        predecessor: pred.card,
        successor: succ.card,
        handoffBalance: pred.lastClosing,
        predecessorLastDate: pred.lastDate,
        successorFirstDate: succ.firstDate,
        confident: pred.lastClosing !== 0,
        reason:
          pred.lastClosing === 0
            ? "zero-balance handoff — any fresh card matches, owner should confirm"
            : `closing ${formatRm(pred.lastClosing)} on ...${pred.card.last4} (${pred.lastDate}) carried into ...${succ.card.last4} (${succ.firstDate})`,
      });
    }
  }

  // uniqueness: a predecessor or successor involved in >1 candidate is
  // ambiguous — demote ALL of its candidates to proposals
  const predCount = new Map<number, number>();
  const succCount = new Map<number, number>();
  for (const c of candidates) {
    predCount.set(c.predecessor.id, (predCount.get(c.predecessor.id) ?? 0) + 1);
    succCount.set(c.successor.id, (succCount.get(c.successor.id) ?? 0) + 1);
  }
  for (const c of candidates) {
    if (predCount.get(c.predecessor.id)! > 1 || succCount.get(c.successor.id)! > 1) {
      if (c.confident) {
        c.confident = false;
        c.reason += " | ambiguous: multiple matching candidates";
      }
    }
  }
  return candidates;
}
