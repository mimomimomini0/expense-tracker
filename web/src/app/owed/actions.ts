"use server";

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";

async function logEdit(id: number, field: string, oldVal: string | null, newVal: string | null) {
  await getSupabase().from("edit_log").insert({
    entity: "transaction", entity_id: id, field,
    old_value: oldVal, new_value: newVal, action: "edit",
  });
}

/** Set / clear "for whom" on a Paying-on-Behalf transaction. */
export async function setOnBehalfParty(formData: FormData): Promise<void> {
  const id = Number(formData.get("txnId"));
  const party = String(formData.get("party") ?? "").trim() || null;
  if (!Number.isFinite(id)) throw new Error("bad id");
  const supabase = getSupabase();
  const prev = await supabase.from("transactions").select("on_behalf_party").eq("id", id).single();
  if (prev.error) throw new Error(prev.error.message);
  const upd = await supabase.from("transactions").update({ on_behalf_party: party }).eq("id", id);
  if (upd.error) throw new Error(upd.error.message);
  await logEdit(id, "on_behalf_party", (prev.data.on_behalf_party as string) ?? null, party);
  revalidatePath("/owed");
}

/** One-tap mark repaid (records the date) or revert to owed. */
export async function setOnBehalfStatus(formData: FormData): Promise<void> {
  const id = Number(formData.get("txnId"));
  const repaid = String(formData.get("repaid")) === "1";
  if (!Number.isFinite(id)) throw new Error("bad id");
  const upd = await getSupabase().from("transactions").update({
    on_behalf_status: repaid ? "repaid" : "owed",
    on_behalf_repaid_at: repaid ? new Date().toISOString() : null,
  }).eq("id", id);
  if (upd.error) throw new Error(upd.error.message);
  await logEdit(id, "on_behalf_status", repaid ? "owed" : "repaid", repaid ? "repaid" : "owed");
  revalidatePath("/owed");
}
