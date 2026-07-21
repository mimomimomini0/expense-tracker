import "server-only";
import { getSupabase } from "./supabase";

/** FR-21 "Paying on Behalf" reimbursement lifecycle. Every transaction in the
 *  "Paying on Behalf" category is money the owner fronted for someone; it is
 *  OUTSTANDING until marked repaid. The category id is resolved by name so a
 *  rename never breaks this. */

export interface OnBehalfItem {
  id: number;
  txnDate: string;
  description: string;
  amount: number; // RM
  cardLabel: string;
  party: string | null;
  status: "owed" | "repaid";
  repaidAt: string | null;
}

export interface PersonTotal {
  party: string; // "" bucket = not yet assigned
  outstanding: number;
  count: number;
}

export interface OnBehalfData {
  items: OnBehalfItem[]; // newest first
  perPerson: PersonTotal[]; // outstanding grouped by party, largest first
  totalOutstanding: number;
  totalRepaid: number;
  categoryMissing: boolean;
}

export async function getOnBehalfData(): Promise<OnBehalfData> {
  const supabase = getSupabase();
  const empty: OnBehalfData = {
    items: [], perPerson: [], totalOutstanding: 0, totalRepaid: 0, categoryMissing: false,
  };

  const catQ = await supabase.from("categories")
    .select("id").eq("name_en", "Paying on Behalf").is("user_id", null).maybeSingle();
  if (catQ.error) throw new Error(catQ.error.message);
  if (!catQ.data) return { ...empty, categoryMissing: true };

  const cardsQ = await supabase.from("card_accounts").select("id,last4,display_name,banks(name)");
  if (cardsQ.error) throw new Error(cardsQ.error.message);
  const cardLabel = new Map<number, string>();
  for (const c of (cardsQ.data ?? []) as unknown as { id: number; last4: string; display_name: string | null; banks: { name: string } | null }[]) {
    cardLabel.set(c.id, c.display_name ?? `${c.banks?.name ?? "?"} ••${c.last4}`);
  }

  const txQ = await supabase.from("transactions")
    .select("id,txn_date,description_raw,amount_rm,card_account_id,on_behalf_party,on_behalf_status,on_behalf_repaid_at")
    .eq("category_id", catQ.data.id)
    .order("txn_date", { ascending: false });
  if (txQ.error) throw new Error(txQ.error.message);

  const items: OnBehalfItem[] = (txQ.data ?? []).map((t) => ({
    id: t.id as number,
    txnDate: t.txn_date as string,
    description: t.description_raw as string,
    amount: Number(t.amount_rm),
    cardLabel: cardLabel.get(t.card_account_id as number) ?? "?",
    party: (t.on_behalf_party as string) ?? null,
    status: (t.on_behalf_status as "owed" | "repaid") ?? "owed", // default outstanding
    repaidAt: (t.on_behalf_repaid_at as string) ?? null,
  }));

  const byPerson = new Map<string, PersonTotal>();
  let totalOutstanding = 0;
  let totalRepaid = 0;
  for (const it of items) {
    if (it.status === "repaid") { totalRepaid += it.amount; continue; }
    totalOutstanding += it.amount;
    const key = it.party ?? "";
    const p = byPerson.get(key) ?? { party: key, outstanding: 0, count: 0 };
    p.outstanding += it.amount; p.count++;
    byPerson.set(key, p);
  }

  return {
    items,
    perPerson: [...byPerson.values()].sort((a, b) => b.outstanding - a.outstanding),
    totalOutstanding,
    totalRepaid,
    categoryMissing: false,
  };
}
