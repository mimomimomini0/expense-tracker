import { SupabaseStore } from "../src/store-supabase.js";
const db = new SupabaseStore().client;
const pc = await db.from("payment_cycles").select("*", { count: "exact" }).order("due_date", { ascending: false }).limit(5);
console.log("payment_cycles count:", pc.count, pc.error?.message ?? "");
for (const r of pc.data ?? []) console.log(JSON.stringify(r));
