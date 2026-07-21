import "server-only";
import { getSupabase, isMissingTableError } from "./supabase";

/** Merchant merge & rename (owner request 2026-07-21). Aliases map a variant
 *  merchant key (terminal-registration spelling) to a canonical display name.
 *  Applied at READ time everywhere merchants surface — reversible, and future
 *  imports inherit the mapping automatically. Returns an empty map until
 *  schema-phase2c.sql is pasted. */
export async function getAliasMap(): Promise<Map<string, string>> {
  try {
    const { data, error } = await getSupabase()
      .from("merchant_aliases").select("merchant_key,canonical");
    if (error) {
      if (isMissingTableError(error)) return new Map();
      throw new Error(error.message);
    }
    return new Map((data ?? []).map((r) => [r.merchant_key as string, r.canonical as string]));
  } catch {
    return new Map();
  }
}

export function canonicalOf(key: string, aliases: Map<string, string>): string {
  return aliases.get(key) ?? key;
}

export async function aliasesAvailable(): Promise<boolean> {
  const { error } = await getSupabase().from("merchant_aliases").select("id").limit(1);
  return !error;
}
