// FR-18 dispute-window alert & unusual-item flags. Pure and dependency-free
// (the web app imports this file directly).
//
// Malaysian card statements are legally conclusive if discrepancies are not
// reported within 14 CALENDAR DAYS of the statement date. For every statement
// whose window is still open "today", the flags below nudge the user's review.
// A statement whose window already closed (normal during backfill) raises
// nothing. Flags are informational — never auto-disputes.

export const DISPUTE_WINDOW_DAYS = 14;

export interface FlagTxnInput {
  id: number;
  statementId: number;
  statementDate: string; // YYYY-MM-DD
  txnDate: string;
  description: string;
  amount: number; // sen, positive
  direction: "debit" | "credit";
  originalCurrency: string | null;
}

export type FlagReason = "first_seen" | "foreign_currency" | "duplicate";

export interface FlaggedTxn {
  id: number;
  description: string;
  txnDate: string;
  amount: number;
  reasons: FlagReason[];
}

export interface DisputeAlert {
  statementId: number;
  statementDate: string;
  deadline: string; // statementDate + 14d
  daysLeft: number; // >= 0 while open
  flagged: FlaggedTxn[];
}

const COUNTRY_TAIL = /\s+(MY|SG|CN|HK|TW|US|SE|GB|AU|JP|TH|ID)\.?$/;
const merchantOf = (d: string) =>
  d.toUpperCase().replace(/\s+/g, " ").trim().replace(COUNTRY_TAIL, "");

const dayMs = 86_400_000;
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso) + n * dayMs).toISOString().slice(0, 10);

/**
 * Compute dispute alerts for every statement whose 14-day window is still
 * open at `todayIso`. "First seen" compares against merchants on statements
 * with an EARLIER statement date (the user's whole history at that point).
 * Only debits are flagged — a credit is money coming back.
 */
export function computeDisputeAlerts(txns: FlagTxnInput[], todayIso: string): DisputeAlert[] {
  const statements = new Map<number, { date: string; rows: FlagTxnInput[] }>();
  for (const t of txns) {
    if (!statements.has(t.statementId)) {
      statements.set(t.statementId, { date: t.statementDate, rows: [] });
    }
    statements.get(t.statementId)!.rows.push(t);
  }

  const alerts: DisputeAlert[] = [];
  for (const [statementId, st] of statements) {
    const deadline = addDays(st.date, DISPUTE_WINDOW_DAYS);
    const daysLeft = Math.round((Date.parse(deadline) - Date.parse(todayIso)) / dayMs);
    if (daysLeft < 0) continue; // window closed — no alert (backfill rule)

    // merchants seen on any EARLIER statement
    const seenBefore = new Set<string>();
    for (const other of statements.values()) {
      if (other.date >= st.date) continue;
      for (const r of other.rows) seenBefore.add(merchantOf(r.description));
    }

    // duplicate = same merchant AND same amount, >= 2 debit rows in THIS statement
    const dupCounts = new Map<string, number>();
    for (const r of st.rows) {
      if (r.direction !== "debit") continue;
      const k = `${merchantOf(r.description)}|${r.amount}`;
      dupCounts.set(k, (dupCounts.get(k) ?? 0) + 1);
    }

    const flagged: FlaggedTxn[] = [];
    for (const r of st.rows) {
      if (r.direction !== "debit") continue;
      const reasons: FlagReason[] = [];
      if (!seenBefore.has(merchantOf(r.description))) reasons.push("first_seen");
      if (r.originalCurrency != null) reasons.push("foreign_currency");
      if ((dupCounts.get(`${merchantOf(r.description)}|${r.amount}`) ?? 0) >= 2) {
        reasons.push("duplicate");
      }
      if (reasons.length > 0) {
        flagged.push({
          id: r.id, description: r.description, txnDate: r.txnDate,
          amount: r.amount, reasons,
        });
      }
    }

    alerts.push({ statementId, statementDate: st.date, deadline, daysLeft, flagged });
  }

  return alerts.sort((a, b) => a.daysLeft - b.daysLeft);
}
