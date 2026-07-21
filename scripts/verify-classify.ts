// Verify persisted classification state (paginated — the table exceeds the
// 1000-row default page size since the backfill).
import { SupabaseStore } from "../src/store-supabase.js";
const db = new SupabaseStore().client;
const cats = await db.from("categories").select("id,name_en").is("user_id", null);
if (cats.error) throw new Error(cats.error.message);
type Row = { category_id: number | null; needs_confirmation: boolean; category_source: string | null };
const rows: Row[] = [];
for (let from = 0; ; from += 1000) {
  const page = await db.from("transactions")
    .select("category_id,needs_confirmation,category_source")
    .order("id").range(from, from + 999);
  if (page.error) throw new Error(page.error.message);
  rows.push(...(page.data as Row[]));
  if ((page.data ?? []).length < 1000) break;
}
const name = new Map(cats.data.map((c) => [c.id as number, c.name_en as string]));
const counts = new Map<string, number>();
const bySource = new Map<string, number>();
let pending = 0, nullCat = 0;
for (const t of rows) {
  if (t.needs_confirmation) pending++;
  bySource.set(t.category_source ?? "none", (bySource.get(t.category_source ?? "none") ?? 0) + 1);
  if (t.category_id == null) { nullCat++; continue; }
  counts.set(name.get(t.category_id)!, (counts.get(name.get(t.category_id)!) ?? 0) + 1);
}
console.log("total:", rows.length);
console.log("assigned:", [...counts.entries()].sort((a, b) => b[1] - a[1]));
console.log("by source:", Object.fromEntries(bySource));
console.log("no category:", nullCat, "| pending confirmation:", pending);
