import "server-only";
import { getSupabase } from "./supabase";
// the engine module is pure and dependency-free — imported directly so the
// web view and the harness-tested detector can never drift apart
import { detectRecurring, monthlyCommitment, type Recurrence } from "../../../src/recurring";

export type { Recurrence };
export { monthlyCommitment };

/** All purchase rows -> recurrence detection (FR-19). */
export async function getRecurrences(): Promise<Recurrence[]> {
  const supabase = getSupabase();
  const rows: { description: string; date: string; amount: number }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("transactions")
      .select("txn_date,description_raw,amount_rm")
      .eq("txn_type", "purchase")
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { txn_date: string; description_raw: string; amount_rm: number }[]) {
      rows.push({
        description: r.description_raw,
        date: r.txn_date,
        amount: Math.round(Number(r.amount_rm) * 100),
      });
    }
    if ((data ?? []).length < 1000) break;
  }
  return detectRecurring(rows);
}
