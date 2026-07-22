// Phase 4 backup/export-all: one JSON file with every table's rows.
// PDFs stay in Supabase storage (and Dropbox); this is the DATA backup.
import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const TABLES = [
  "banks", "card_accounts", "statements", "statement_cards", "transactions",
  // learned merchant → category rules + merge/rename aliases: the "self-learned"
  // knowledge that must survive a reinstall and travel with the backup
  "categories", "merchant_rules", "merchant_aliases",
  "instalment_plans", "payment_cycles",
  "upload_rejections", "edit_log", "api_cost_log",
  "ewallet_accounts", "ewallet_cards", "ewallet_statements", "ewallet_transactions",
  "companies", "user_profiles",
];

export async function GET(): Promise<NextResponse> {
  const supabase = getSupabase();
  const dump: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    const rows: unknown[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from(table).select("*").order("id").range(from, from + 999);
      if (error) {
        // user_profiles has no id column; retry unordered once, else skip
        const retry = await supabase.from(table).select("*").range(from, from + 999);
        if (retry.error) break;
        rows.push(...(retry.data ?? []));
        if ((retry.data ?? []).length < 1000) break;
        continue;
      }
      rows.push(...(data ?? []));
      if ((data ?? []).length < 1000) break;
    }
    dump[table] = rows;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(JSON.stringify({ exported_at: new Date().toISOString(), tables: dump }, null, 1), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="expense-tracker-backup-${stamp}.json"`,
    },
  });
}
