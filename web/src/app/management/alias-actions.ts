"use server";

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";

function done(): void {
  revalidatePath("/management");
  revalidatePath("/transactions");
}

/** Merge: every selected merchant key maps to one canonical name. */
export async function mergeMerchants(formData: FormData): Promise<void> {
  const canonical = String(formData.get("canonical") ?? "").trim().toUpperCase();
  const keys = formData.getAll("member").map(String).filter(Boolean);
  if (!canonical || keys.length === 0) throw new Error("pick merchants and a name");
  const supabase = getSupabase();
  const { error } = await supabase.from("merchant_aliases").upsert(
    keys.map((merchant_key) => ({ merchant_key, canonical })),
    { onConflict: "user_id,merchant_key" },
  );
  if (error) throw new Error(error.message);
  done();
}

export async function renameAlias(formData: FormData): Promise<void> {
  const from = String(formData.get("from") ?? "");
  const to = String(formData.get("to") ?? "").trim().toUpperCase();
  if (!from || !to) throw new Error("bad rename");
  const { error } = await getSupabase()
    .from("merchant_aliases").update({ canonical: to }).eq("canonical", from);
  if (error) throw new Error(error.message);
  done();
}

export async function removeAliasMember(formData: FormData): Promise<void> {
  const key = String(formData.get("key") ?? "");
  if (!key) throw new Error("bad key");
  const { error } = await getSupabase()
    .from("merchant_aliases").delete().eq("merchant_key", key);
  if (error) throw new Error(error.message);
  done();
}
