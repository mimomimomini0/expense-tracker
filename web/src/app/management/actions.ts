"use server";

import { revalidatePath } from "next/cache";
import { getSupabase } from "@/lib/supabase";

const normalize = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();

/** Owner drags a merchant to another category on the Management board:
 *  1. the merchant rule moves (confirmed_at stamped — this IS a user decision),
 *  2. every transaction whose BEST-matching rule is this pattern follows
 *     (category_source 'user', cleared from the queue),
 *  3. each change lands in edit_log (FR-15).
 *  Longest-pattern-wins matching mirrors the classification engine, so a row
 *  covered by a more specific rule never moves by accident. */
export async function moveMerchantRule(pattern: string, toCategoryId: number): Promise<void> {
  if (!pattern || !Number.isFinite(toCategoryId)) throw new Error("bad arguments");
  const supabase = getSupabase();

  const rulesQ = await supabase.from("merchant_rules").select("merchant_pattern,category_id");
  if (rulesQ.error) throw new Error(rulesQ.error.message);
  const patterns = (rulesQ.data ?? []).map((r) => normalize(r.merchant_pattern as string));
  if (!patterns.includes(normalize(pattern))) throw new Error("unknown merchant rule");

  const upd = await supabase.from("merchant_rules")
    .update({ category_id: toCategoryId, confirmed_at: new Date().toISOString() })
    .eq("merchant_pattern", pattern)
    .select("id");
  if (upd.error) throw new Error(upd.error.message);
  if ((upd.data ?? []).length !== 1) throw new Error("rule update matched no row");

  // rows whose best (longest) matching rule is this pattern
  type Row = { id: number; description_raw: string; category_id: number | null };
  const target = normalize(pattern);
  const affected: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await supabase.from("transactions")
      .select("id,description_raw,category_id").order("id").range(from, from + 999);
    if (page.error) throw new Error(page.error.message);
    for (const row of (page.data ?? []) as Row[]) {
      const d = normalize(row.description_raw);
      if (!d.startsWith(target)) continue;
      const best = patterns
        .filter((p) => d.startsWith(p))
        .sort((a, b) => b.length - a.length)[0];
      if (best === target) affected.push(row);
    }
    if ((page.data ?? []).length < 1000) break;
  }

  for (let i = 0; i < affected.length; i += 100) {
    const chunk = affected.slice(i, i + 100);
    const u = await supabase.from("transactions")
      .update({ category_id: toCategoryId, category_source: "user", needs_confirmation: false })
      .in("id", chunk.map((r) => r.id));
    if (u.error) throw new Error(u.error.message);
    const log = await supabase.from("edit_log").insert(chunk.map((r) => ({
      entity: "transaction",
      entity_id: r.id,
      field: "category_id",
      old_value: r.category_id == null ? null : String(r.category_id),
      new_value: String(toCategoryId),
      action: "edit",
    })));
    if (log.error) throw new Error(log.error.message);
  }

  revalidatePath("/management");
  revalidatePath("/transactions");
  revalidatePath("/dashboard");
}
