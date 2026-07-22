"use server";

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";

/** Dismiss a missing-statement flag for a (bank, month). "unflag" and
 *  "unflag forever" both hide the flag; forever is recorded in old_value for
 *  the audit trail. Stored in edit_log (no new table) with entity_id = bankId
 *  and new_value = the YYYY-MM. flags-data / coverage-data read these back. */
export async function dismissCoverageFlag(formData: FormData): Promise<void> {
  const bankId = Number(formData.get("bankId"));
  const scope = String(formData.get("scope") ?? "").trim(); // YYYY-MM
  const forever = String(formData.get("forever")) === "1";
  if (!Number.isFinite(bankId) || !/^\d{4}-\d{2}$/.test(scope)) return;
  const { error } = await getSupabase().from("edit_log").insert({
    entity: "statement", entity_id: bankId,
    field: "coverage_dismiss", old_value: forever ? "forever" : "once", new_value: scope,
    action: "force_accept",
  });
  if (error) throw new Error(error.message);
  revalidatePath("/duedates");
}
