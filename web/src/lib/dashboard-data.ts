import "server-only";
import { getSupabase } from "./supabase";
import { ewalletSectorCategory } from "./ewallet-categories";

/** Dashboard aggregation (Phase 3, FR-10/FR-11 subset — owner Q7: charts first).
 *
 *  Money semantics (owner decisions):
 *   - spending = purchase + instalment + cash_advance debits, EXCLUDING rows
 *     categorised "Wallet Transfers" (Q1: transfers, own line, never expenses)
 *   - fees (fee_interest) and refunds are their OWN series — never netted
 *   - payments are excluded entirely
 *   - TNG e-wallet USAGE rows count as spending with sector-mapped categories
 *     (Q3); they are excluded when a specific card filter is active, since
 *     they belong to no credit card.
 */

export interface DashboardFilters {
  from: string; // YYYY-MM-DD inclusive
  to: string;   // YYYY-MM-DD inclusive
  card?: string;      // card_account_id as string
  ewallet: boolean;   // include e-wallet usage rows
}

export interface MonthBucket {
  month: string; // YYYY-MM
  spending: number;
  fees: number;
  refunds: number;
}

export interface CategorySlice {
  key: string;       // name_en or "__uncategorised"
  name_en: string;
  name_zh: string | null;
  categoryId: number | null;
  total: number;
}

export interface UtilizationCard {
  cardId: number;
  label: string;
  closing: number;
  limit: number;
}

export interface CardBucket {
  cardId: number | null; // null = e-wallet spending (no credit card)
  label: string;
  spending: number;
  fees: number;
  refunds: number;
}

export interface DashboardData {
  months: MonthBucket[];
  categories: CategorySlice[]; // sorted desc by total, ALL of them
  totals: { spending: number; fees: number; refunds: number; walletTransfers: number; ewallet: number };
  byCard: CardBucket[]; // sorted desc by spending (for the summary report)
  byTag: { tag: string; spending: number }[];
  utilization: { cards: UtilizationCard[]; totalClosing: number; totalLimit: number };
}

const PAGE = 1000;

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

function monthsBetween(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  let [y, m] = [Number(fromIso.slice(0, 4)), Number(fromIso.slice(5, 7))];
  const [ey, em] = [Number(toIso.slice(0, 4)), Number(toIso.slice(5, 7))];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

export async function getDashboardData(filters: DashboardFilters): Promise<DashboardData> {
  const supabase = getSupabase();

  const cats = await supabase.from("categories").select("id,name_en,name_zh").is("user_id", null);
  if (cats.error) throw new Error(cats.error.message);
  const catById = new Map(
    (cats.data ?? []).map((c) => [c.id as number, { name_en: c.name_en as string, name_zh: c.name_zh as string | null }]),
  );
  const walletTransfersId = (cats.data ?? []).find((c) => c.name_en === "Wallet Transfers")?.id as number | undefined;

  type Tx = {
    txn_date: string; amount_rm: number; direction: "debit" | "credit";
    txn_type: string; category_id: number | null; card_account_id: number;
    business_tag: string;
  };
  const txns = await fetchAll<Tx>((a, b) => {
    let q = supabase.from("transactions")
      .select("txn_date,amount_rm,direction,txn_type,category_id,card_account_id,business_tag")
      .gte("txn_date", filters.from).lte("txn_date", filters.to);
    if (filters.card) q = q.eq("card_account_id", Number(filters.card));
    return q.order("id").range(a, b);
  });

  const monthKeys = monthsBetween(filters.from, filters.to);
  const byMonth = new Map<string, MonthBucket>(
    monthKeys.map((m) => [m, { month: m, spending: 0, fees: 0, refunds: 0 }]),
  );
  const catTotals = new Map<string, CategorySlice>();
  const totals = { spending: 0, fees: 0, refunds: 0, walletTransfers: 0, ewallet: 0 };
  const cardTotals = new Map<number | null, CardBucket>();
  const tagTotals = new Map<string, number>();
  const cardBucket = (cardId: number | null): CardBucket => {
    let b = cardTotals.get(cardId);
    if (!b) {
      b = { cardId, label: "", spending: 0, fees: 0, refunds: 0 };
      cardTotals.set(cardId, b);
    }
    return b;
  };

  const addCat = (categoryId: number | null, amount: number) => {
    const info = categoryId != null ? catById.get(categoryId) : undefined;
    const key = info ? info.name_en : "__uncategorised";
    const slice = catTotals.get(key) ?? {
      key,
      name_en: info?.name_en ?? "__uncategorised",
      name_zh: info?.name_zh ?? null,
      categoryId: categoryId ?? null,
      total: 0,
    };
    slice.total += amount;
    catTotals.set(key, slice);
  };

  for (const t of txns) {
    const bucket = byMonth.get(t.txn_date.slice(0, 7));
    if (!bucket) continue;
    const amount = Number(t.amount_rm);
    if (t.txn_type === "payment") continue;
    if (t.txn_type === "refund") {
      bucket.refunds += amount; totals.refunds += amount;
      cardBucket(t.card_account_id).refunds += amount;
      continue;
    }
    if (t.txn_type === "fee_interest") {
      bucket.fees += amount; totals.fees += amount;
      cardBucket(t.card_account_id).fees += amount;
      continue;
    }
    // purchase / instalment / cash_advance
    if (walletTransfersId != null && t.category_id === walletTransfersId) {
      totals.walletTransfers += amount;
      continue; // transfers are never spending (Q1)
    }
    bucket.spending += amount;
    totals.spending += amount;
    cardBucket(t.card_account_id).spending += amount;
    tagTotals.set(t.business_tag, (tagTotals.get(t.business_tag) ?? 0) + amount);
    addCat(t.category_id, amount);
  }

  if (filters.ewallet && !filters.card) {
    type Ew = { trans_date: string; amount_rm: number; kind: string; sector: string | null };
    const ew = await fetchAll<Ew>((a, b) =>
      supabase.from("ewallet_transactions")
        .select("trans_date,amount_rm,kind,sector")
        .eq("kind", "usage")
        .gte("trans_date", filters.from).lte("trans_date", filters.to)
        .order("id").range(a, b),
    );
    for (const r of ew) {
      const bucket = byMonth.get(r.trans_date.slice(0, 7));
      if (!bucket) continue;
      const amount = Number(r.amount_rm);
      bucket.spending += amount;
      totals.spending += amount;
      totals.ewallet += amount;
      cardBucket(null).spending += amount; // e-wallet: its own row in "by card"
      tagTotals.set("personal", (tagTotals.get("personal") ?? 0) + amount);
      const name = ewalletSectorCategory(r.sector);
      const cat = name ? (cats.data ?? []).find((c) => c.name_en === name) : undefined;
      addCat((cat?.id as number | undefined) ?? null, amount);
    }
  }

  // credit utilization: latest statement per card that prints a credit limit
  type Sc = { card_account_id: number; closing_balance: number; credit_limit: number | null; statement_date: string };
  const scQ = await supabase.from("statement_cards")
    .select("card_account_id,closing_balance,credit_limit,statement_date");
  if (scQ.error) throw new Error(scQ.error.message);
  const cardsQ = await supabase.from("card_accounts")
    .select("id,last4,display_name,banks(name)");
  if (cardsQ.error) throw new Error(cardsQ.error.message);
  const latest = new Map<number, Sc>();
  for (const sc of (scQ.data ?? []) as unknown as Sc[]) {
    if (filters.card && sc.card_account_id !== Number(filters.card)) continue;
    const cur = latest.get(sc.card_account_id);
    if (!cur || sc.statement_date > cur.statement_date) latest.set(sc.card_account_id, sc);
  }
  const utilCards: UtilizationCard[] = [];
  for (const [cardId, sc] of latest) {
    if (sc.credit_limit == null || Number(sc.credit_limit) <= 0) continue;
    const card = (cardsQ.data ?? []).find((c) => c.id === cardId) as
      | { id: number; last4: string; display_name: string | null; banks: { name: string } | null }
      | undefined;
    utilCards.push({
      cardId,
      label: card?.display_name ?? `${card?.banks?.name ?? "?"} ••${card?.last4 ?? "????"}`,
      closing: Math.max(0, Number(sc.closing_balance)),
      limit: Number(sc.credit_limit),
    });
  }
  utilCards.sort((a, b) => b.closing / b.limit - a.closing / a.limit);

  // resolve card labels for the by-card buckets (null = e-wallet; caller
  // substitutes the localized label)
  for (const b of cardTotals.values()) {
    if (b.cardId == null) continue;
    const card = (cardsQ.data ?? []).find((c) => c.id === b.cardId) as
      | { id: number; last4: string; display_name: string | null; banks: { name: string } | null }
      | undefined;
    b.label = card?.display_name ?? `${card?.banks?.name ?? "?"} ••${card?.last4 ?? "????"}`;
  }

  return {
    months: monthKeys.map((m) => byMonth.get(m)!),
    categories: [...catTotals.values()].sort((a, b) => b.total - a.total),
    totals,
    byCard: [...cardTotals.values()].sort((a, b) => b.spending - a.spending),
    byTag: [...tagTotals.entries()]
      .map(([tag, spending]) => ({ tag, spending }))
      .sort((a, b) => b.spending - a.spending),
    utilization: {
      cards: utilCards,
      totalClosing: utilCards.reduce((s, c) => s + c.closing, 0),
      totalLimit: utilCards.reduce((s, c) => s + c.limit, 0),
    },
  };
}
