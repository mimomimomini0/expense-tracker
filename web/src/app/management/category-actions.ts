"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSupabase } from "@/lib/supabase";

function done(): void {
  revalidatePath("/management");
  revalidatePath("/transactions");
  revalidatePath("/dashboard");
}

export async function addCategory(formData: FormData): Promise<void> {
  const name_en = String(formData.get("name_en") ?? "").trim();
  const name_zh = String(formData.get("name_zh") ?? "").trim() || null;
  if (!name_en) throw new Error("name required");
  const { error } = await getSupabase().from("categories")
    .insert({ name_en, name_zh, sort_order: 175 });
  if (error) redirect("/management?tab=categories&error=duplicate");
  done();
}

export async function renameCategory(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const name_en = String(formData.get("name_en") ?? "").trim();
  const name_zh = String(formData.get("name_zh") ?? "").trim() || null;
  if (!Number.isFinite(id) || !name_en) throw new Error("bad rename");
  const { error } = await getSupabase().from("categories")
    .update({ name_en, name_zh }).eq("id", id);
  if (error) redirect("/management?tab=categories&error=duplicate");
  done();
}

/** Delete only when NOTHING references the category — transactions keep
 *  their history; a used category can be renamed, never silently emptied. */
export async function deleteCategory(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) throw new Error("bad id");
  const supabase = getSupabase();
  const [tx, rules] = await Promise.all([
    supabase.from("transactions").select("id", { count: "exact", head: true }).eq("category_id", id),
    supabase.from("merchant_rules").select("id", { count: "exact", head: true }).eq("category_id", id),
  ]);
  if ((tx.count ?? 0) > 0 || (rules.count ?? 0) > 0) {
    redirect("/management?tab=categories&error=inuse");
  }
  const { error } = await supabase.from("categories").delete().eq("id", id);
  if (error) throw new Error(error.message);
  done();
}
