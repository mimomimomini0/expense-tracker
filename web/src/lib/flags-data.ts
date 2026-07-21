import "server-only";
import { getSupabase } from "./supabase";
import { klToday } from "./payments-data";
// pure engine, imported directly (same pattern as recurring detection)
import { computeDisputeAlerts, type DisputeAlert, type FlagTxnInput } from "../../../src/flags";

export type { DisputeAlert };

/** FR-18: dispute alerts for statements whose 14-day window is open today.
 *  Purchases/cash advances only — instalments, fees and payments are expected
 *  charges (an instalment's NN/MM token would false-flag "first seen"). */
export async function getDisputeAlerts(): Promise<DisputeAlert[]> {
  const supabase = getSupabase();
  const txns: FlagTxnInput[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("transactions")
      .select("id,txn_date,description_raw,amount_rm,direction,original_currency,txn_type,statement_cards(statement_id,statements(statement_date))")
      .in("txn_type", ["purchase", "cash_advance"])
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as unknown as {
      id: number; txn_date: string; description_raw: string; amount_rm: number;
      direction: "debit" | "credit"; original_currency: string | null;
      statement_cards: { statement_id: number; statements: { statement_date: string } | null } | null;
    }[]) {
      const st = r.statement_cards;
      if (!st?.statements) continue;
      txns.push({
        id: r.id,
        statementId: st.statement_id,
        statementDate: st.statements.statement_date,
        txnDate: r.txn_date,
        description: r.description_raw,
        amount: Math.round(Number(r.amount_rm) * 100),
        direction: r.direction,
        originalCurrency: r.original_currency,
      });
    }
    if ((data ?? []).length < 1000) break;
  }
  const alerts = computeDisputeAlerts(txns, klToday());

  // drop rows the owner already reviewed & dismissed (stored in edit_log —
  // the dismissal IS the audit record of that review)
  const dismissed = new Set<number>();
  const dq = await supabase.from("edit_log")
    .select("entity_id").eq("entity", "transaction")
    .eq("field", "dispute_flag").eq("new_value", "dismissed");
  if (!dq.error) for (const r of dq.data ?? []) dismissed.add(r.entity_id as number);
  for (const a of alerts) {
    a.flagged = a.flagged.filter((f) => !dismissed.has(f.id));
  }
  return alerts;
}
