"use server";

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";

export type EditableField = "category_id" | "business_tag" | "notes";

const EDITABLE_FIELDS: ReadonlySet<string> = new Set([
  "category_id",
  "business_tag",
  "notes"
]);

/** FR-15: every edit to category / business tag / notes updates the row AND
 *  writes an edit_log entry. Extracted values are immutable — only these
 *  three fields can be edited here. */
export async function updateTxnField(
  txnId: number,
  field: EditableField,
  value: string | number | null
): Promise<void> {
  if (!EDITABLE_FIELDS.has(field)) {
    throw new Error(`Field "${field}" is not editable`);
  }

  const supabase = getSupabase();
  const { data: row, error: fetchError } = await supabase
    .from("transactions")
    .select("id, category_id, business_tag, notes")
    .eq("id", txnId)
    .single();
  if (fetchError || !row) {
    throw new Error(fetchError?.message ?? "Transaction not found");
  }

  const oldValue = row[field];
  let patch: Record<string, unknown>;
  if (field === "category_id") {
    const categoryId = value == null || value === "" ? null : Number(value);
    if (categoryId == null || !Number.isFinite(categoryId)) {
      throw new Error("A category is required");
    }
    patch = { category_id: categoryId, category_source: "user", edited: true };
  } else if (field === "business_tag") {
    const tag = typeof value === "string" && value.trim() !== "" ? value : "personal";
    patch = { business_tag: tag, business_tag_overridden: true, edited: true };
  } else {
    const notes =
      typeof value === "string" && value.trim() !== "" ? value.trim() : null;
    patch = { notes, edited: true };
  }

  const { error: updateError } = await supabase
    .from("transactions")
    .update(patch)
    .eq("id", txnId);
  if (updateError) throw new Error(updateError.message);

  const { error: logError } = await supabase.from("edit_log").insert({
    entity: "transaction",
    entity_id: txnId,
    field,
    old_value: oldValue == null ? null : String(oldValue),
    new_value: patch[field] == null ? null : String(patch[field]),
    action: "edit"
  });
  if (logError) throw new Error(logError.message);

  revalidatePath("/transactions");
  revalidatePath("/queue");
}
