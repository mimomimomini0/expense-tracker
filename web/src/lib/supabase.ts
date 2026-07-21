import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env";

/** Fixed single-user owner UUID (matches schema defaults). */
export const OWNER_USER_ID = "00000000-0000-0000-0000-000000000001";

let client: SupabaseClient | null = null;

/** Server-only Supabase client using the service-role key. Lazy so that
 *  `next build` never needs credentials (all pages are force-dynamic). */
export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
  }
  return client;
}

/** True when the error means the table has not been created yet
 *  (Phase 2b addendum SQL not run). */
export function isMissingTableError(error: {
  code?: string;
  message?: string;
}): boolean {
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /could not find the table|does not exist/i.test(error.message ?? "")
  );
}
