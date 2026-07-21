"use server";

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";

/** FR-9 payment recording. Full / minimum / other — the amounts come from the
 *  cycle row itself, never from hidden form fields. A cycle whose payment was
 *  AUTO-DETECTED from statement evidence is immutable here. Re-recording a
 *  manual entry is allowed (the user correcting themselves). */
export async function recordPayment(formData: FormData): Promise<void> {
  const cycleId = Number(formData.get("cycleId"));
  const mode = String(formData.get("mode") ?? "full");
  if (!Number.isFinite(cycleId)) throw new Error("bad cycle id");

  const supabase = getSupabase();
  const { data: cycle, error } = await supabase
    .from("payment_cycles")
    .select("id,statement_balance,minimum_due,auto_detected")
    .eq("id", cycleId)
    .single();
  if (error) throw new Error(error.message);
  if (cycle.auto_detected) throw new Error("cycle already settled by statement evidence");

  const balance = Number(cycle.statement_balance);
  const minimum = cycle.minimum_due == null ? null : Number(cycle.minimum_due);

  let amount: number;
  let status: "paid_full" | "paid_minimum" | "paid_other";
  if (mode === "full") {
    amount = balance;
    status = "paid_full";
  } else if (mode === "minimum") {
    if (minimum == null) throw new Error("no minimum printed for this cycle");
    amount = minimum;
    status = "paid_minimum";
  } else {
    amount = Number(formData.get("amount"));
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("enter a valid amount");
    status = amount >= balance ? "paid_full" : "paid_other";
  }

  const upd = await supabase.from("payment_cycles").update({
    status,
    amount_paid: amount,
    paid_recorded_at: new Date().toISOString(),
  }).eq("id", cycleId).eq("auto_detected", false);
  if (upd.error) throw new Error(upd.error.message);

  revalidatePath("/dashboard");
  revalidatePath("/", "layout");
}
