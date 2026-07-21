// Connection probe: insert -> read -> delete one row in banks via the service key.
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

const ins = await db.from("banks").insert({ name: "__CONNECTION_TEST__" }).select().single();
if (ins.error) {
  console.error("INSERT failed:", ins.error.message);
  process.exit(1);
}
console.log("insert ok, id =", ins.data.id);

const sel = await db.from("banks").select("id,name").eq("name", "__CONNECTION_TEST__");
if (sel.error) {
  console.error("SELECT failed:", sel.error.message);
  process.exit(1);
}
console.log("select ok, rows =", sel.data.length);

const del = await db.from("banks").delete().eq("name", "__CONNECTION_TEST__");
if (del.error) {
  console.error("DELETE failed:", del.error.message);
  process.exit(1);
}
console.log("delete ok — Supabase connection fully working");
