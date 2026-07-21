// FR-4 cross-statement chain reconciliation.
// Warnings are COMPUTED from stored statement_cards on demand — never stored —
// so they auto-resolve the moment a missing statement is imported and
// re-evaluate whenever a neighbor arrives, in any import order.

import type { Store } from "./store.js";
import type { ChainWarning } from "./types.js";
import { daysBetween } from "./dates.js";
import { formatRm } from "./money.js";

// Adjacent monthly statements are ~28-31 days apart. Anything wider means a
// statement is missing; equal closing/opening must also hold.
const MAX_ADJACENT_DAYS = 45;

/**
 * FR-4d: group card accounts into logical TIMELINES by following
 * continues_card_id links (successor -> predecessor). A replacement card's
 * statements are chained onto its predecessor's, so the boundary between the
 * two card numbers gets the same closing == opening check as any other pair,
 * and only the earliest statement of the whole timeline is exempt.
 */
function buildTimelines(cards: { id: number; continues_card_id: number | null }[]): number[][] {
  const successorOf = new Map<number, number>(); // predecessor id -> successor id
  for (const c of cards) {
    if (c.continues_card_id != null && c.continues_card_id !== c.id && !successorOf.has(c.continues_card_id)) {
      successorOf.set(c.continues_card_id, c.id);
    }
  }
  const timelines: number[][] = [];
  // roots: cards that do not continue anything (or whose predecessor is unknown)
  for (const c of cards) {
    if (c.continues_card_id != null && cards.some((o) => o.id === c.continues_card_id)) continue;
    const timeline: number[] = [];
    const seen = new Set<number>(); // cycle guard
    let cur: number | undefined = c.id;
    while (cur != null && !seen.has(cur)) {
      seen.add(cur);
      timeline.push(cur);
      cur = successorOf.get(cur);
    }
    timelines.push(timeline);
  }
  // defensive: a pure cycle (every card continues another) has no root; emit
  // each member standalone rather than dropping its statements from checking
  const covered = new Set(timelines.flat());
  for (const c of cards) if (!covered.has(c.id)) timelines.push([c.id]);
  return timelines;
}

export async function computeChainWarnings(store: Store): Promise<ChainWarning[]> {
  const banks = await store.listBanks();
  const cards = await store.listCardAccounts();
  const statements = await store.listStatements();
  const stmtCards = await store.listStatementCards();

  const warnings: ChainWarning[] = [];

  for (const timeline of buildTimelines(cards)) {
    const members = timeline.map((id) => cards.find((c) => c.id === id)!);
    const entries = stmtCards
      .filter((sc) => timeline.includes(sc.card_account_id))
      .map((sc) => {
        const st = statements.find((s) => s.id === sc.statement_id)!;
        return { sc, date: st.statement_date };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    // earliest statement of the TIMELINE is exempt from the backward check
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1]!;
      const next = entries[i]!;
      const gapDays = daysBetween(prev.date, next.date);
      const balanceMismatch = next.sc.opening_balance !== prev.sc.closing_balance;
      const dateGap = gapDays > MAX_ADJACENT_DAYS;
      if (dateGap || balanceMismatch) {
        const parts: string[] = [];
        if (dateGap) parts.push(`${Math.round(gapDays)} days between statements`);
        if (balanceMismatch) {
          parts.push(
            `opening ${formatRm(next.sc.opening_balance)} != prior closing ${formatRm(prev.sc.closing_balance)}`,
          );
        }
        const card = members.find((m) => m.id === next.sc.card_account_id)!;
        const bank = banks.find((b) => b.id === card.bank_id);
        const crossesCards = next.sc.card_account_id !== prev.sc.card_account_id;
        if (crossesCards) {
          const prevCard = members.find((m) => m.id === prev.sc.card_account_id)!;
          parts.push(`at the continuation boundary ...${prevCard.last4} -> ...${card.last4}`);
        }
        warnings.push({
          card_account_id: card.id,
          bank: bank?.name ?? "?",
          last4: card.last4,
          from_statement_date: prev.date,
          to_statement_date: next.date,
          kind: "gap_or_out_of_sequence",
          detail: `gap detected — statement missing or out of sequence (${parts.join("; ")})`,
        });
      }
    }
  }
  return warnings;
}
