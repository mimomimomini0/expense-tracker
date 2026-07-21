"use server";

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";

/** FR-18: owner reviewed a flagged row and cleared it. The edit_log row IS
 *  the audit trail of that review. */
export async function dismissDisputeFlag(formData: FormData): Promise<void> {
  const id = Number(formData.get("txnId"));
  if (!Number.isFinite(id)) throw new Error("bad transaction id");
  const { error } = await getSupabase().from("edit_log").insert({
    entity: "transaction", entity_id: id,
    field: "dispute_flag", old_value: "flagged", new_value: "dismissed",
    action: "edit",
  });
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

/** Dismiss EVERY flagged row of one statement at once (owner request). */
export async function dismissAllDisputeFlags(formData: FormData): Promise<void> {
  const ids = String(formData.get("txnIds") ?? "")
    .split(",").map(Number).filter(Number.isFinite);
  if (ids.length === 0) return;
  const { error } = await getSupabase().from("edit_log").insert(
    ids.map((id) => ({
      entity: "transaction", entity_id: id,
      field: "dispute_flag", old_value: "flagged", new_value: "dismissed",
      action: "edit",
    })),
  );
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

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
