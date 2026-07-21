"use server";

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";
import { merchantKey } from "@/lib/merchant-key";

/** FR-7 confirmation: one click clears a whole merchant group.
 *  1. insert a merchant_rules row (pattern = group key, confirmed now,
 *     created_from_txn_id = first row of the group),
 *  2. update ALL transactions in the group (category, source 'user',
 *     needs_confirmation false),
 *  3. write edit_log entries (FR-15). */
export async function confirmGroup(
  groupKey: string,
  categoryId: number
): Promise<void> {
  if (!Number.isFinite(categoryId)) throw new Error("A category is required");

  const supabase = getSupabase();

  // Recompute the group server-side from current data — never trust the
  // client's row list.
  const { data: pending, error: fetchError } = await supabase
    .from("transactions")
    .select("id, description_raw, category_id")
    .eq("needs_confirmation", true)
    .order("id", { ascending: true });
  if (fetchError) throw new Error(fetchError.message);

  const group = (pending ?? []).filter(
    (row) => merchantKey(row.description_raw) === groupKey
  );
  if (group.length === 0) {
    // Group already cleared (double click / another tab) — nothing to do.
    revalidatePath("/queue");
    return;
  }

  // 1. merchant rule (upsert so re-confirming a key updates the rule).
  const { error: ruleError } = await supabase.from("merchant_rules").upsert(
    {
      merchant_pattern: groupKey,
      category_id: categoryId,
      created_from_txn_id: group[0].id,
      confirmed_at: new Date().toISOString()
    },
    { onConflict: "user_id,merchant_pattern" }
  );
  if (ruleError) throw new Error(ruleError.message);

  // 2. clear the whole group.
  const ids = group.map((row) => row.id);
  const { error: updateError } = await supabase
    .from("transactions")
    .update({
      category_id: categoryId,
      category_source: "user",
      needs_confirmation: false
    })
    .in("id", ids);
  if (updateError) throw new Error(updateError.message);

  // 3. audit trail — one edit_log row per transaction.
  const { error: logError } = await supabase.from("edit_log").insert(
    group.map((row) => ({
      entity: "transaction",
      entity_id: row.id,
      field: "category_id",
      old_value: row.category_id == null ? null : String(row.category_id),
      new_value: String(categoryId),
      action: "edit"
    }))
  );
  if (logError) throw new Error(logError.message);

  revalidatePath("/queue");
  revalidatePath("/transactions");
}
