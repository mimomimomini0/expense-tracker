"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getSupabase, OWNER_USER_ID } from "@/lib/supabase";

function text(value: FormDataEntryValue | null): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return s === "" ? null : s;
}

// ---------- profile (FR-14) ----------

export async function saveProfile(formData: FormData): Promise<void> {
  const language = formData.get("language") === "zh" ? "zh" : "en";
  const supabase = getSupabase();
  const { error } = await supabase.from("user_profiles").upsert(
    {
      user_id: OWNER_USER_ID,
      language,
      display_name: text(formData.get("display_name")),
      reminder_email: text(formData.get("reminder_email"))
    },
    { onConflict: "user_id" }
  );
  if (error) throw new Error(error.message);

  // Keep the UI language in sync with the saved preference.
  const store = await cookies();
  store.set("NEXT_LOCALE", language, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax"
  });
  revalidatePath("/", "layout");
}

// ---------- companies (add / rename / archive — never delete) ----------

export async function addCompany(formData: FormData): Promise<void> {
  const name = text(formData.get("name"));
  if (!name) return;
  const supabase = getSupabase();
  const { error } = await supabase
    .from("companies")
    .insert({ name, label: text(formData.get("label")), archived: false });
  if (error) throw new Error(error.message);
  revalidatePath("/onboarding");
  revalidatePath("/transactions");
}

export async function renameCompany(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const name = text(formData.get("name"));
  if (!Number.isFinite(id) || !name) return;
  const supabase = getSupabase();
  const { error } = await supabase
    .from("companies")
    .update({ name, label: text(formData.get("label")) })
    .eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/onboarding");
  revalidatePath("/transactions");
}

export async function setCompanyArchived(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const archived = formData.get("archived") === "1";
  const supabase = getSupabase();
  const { error } = await supabase
    .from("companies")
    .update({ archived })
    .eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/onboarding");
  revalidatePath("/transactions");
}

// ---------- per-card settings ----------

export async function saveCardSettings(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!Number.isFinite(id)) return;
  const tag = text(formData.get("default_business_tag")) ?? "personal";
  const supabase = getSupabase();
  const { error } = await supabase
    .from("card_accounts")
    .update({
      display_name: text(formData.get("display_name")),
      default_business_tag: tag
    })
    .eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/onboarding");
  revalidatePath("/transactions");
}
