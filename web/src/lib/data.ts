import "server-only";
import { getSupabase, isMissingTableError, OWNER_USER_ID } from "./supabase";
import { merchantKey } from "./merchant-key";
import { canonicalOf, getAliasMap } from "./aliases";

// ---------- types ----------

export type Category = {
  id: number;
  name_en: string;
  name_zh: string | null;
  sort_order: number;
};

export type Company = {
  id: number;
  name: string;
  label: string | null;
  archived: boolean;
};

export type CardAccount = {
  id: number;
  last4: string;
  display_name: string | null;
  default_business_tag: string;
  bank_name: string;
};

export type UserProfile = {
  user_id: string;
  language: string | null;
  display_name: string | null;
  reminder_email: string | null;
};

export type TxnRow = {
  id: number;
  txn_date: string;
  posting_date: string | null;
  description_raw: string;
  merchant_normalized: string | null;
  amount_rm: number;
  direction: "debit" | "credit";
  txn_type:
    | "purchase"
    | "refund"
    | "payment"
    | "fee_interest"
    | "instalment"
    | "cash_advance";
  category_id: number | null;
  category_source: "learned" | "llm" | "user" | null;
  confidence: number | null;
  business_tag: string;
  business_tag_overridden: boolean;
  notes: string | null;
  edited: boolean;
  needs_confirmation: boolean;
  original_currency: string | null;
  original_amount: number | null;
  card_account_id: number;
  card: { id: number; last4: string; display_name: string | null; bank_name: string };
};

export type TxnSort = "date_desc" | "date_asc" | "amount_desc" | "amount_asc";

export type TxnFilters = {
  card?: string;
  /** multiple category ids may be selected together (owner request 2026-07-21) */
  categories?: string[];
  /** merchant key (normalized description, country tail stripped) — matched
   *  in memory since the key cannot be computed in SQL (owner request) */
  merchant?: string;
  txnType?: string;
  from?: string;
  to?: string;
  /** view order (owner request 2026-07-21); default newest first */
  sort?: TxnSort;
};

function applySort<T extends { order: (col: string, opts?: { ascending: boolean }) => T }>(
  q: T,
  sort: TxnSort | undefined,
): T {
  switch (sort) {
    case "date_asc":
      return q.order("txn_date", { ascending: true }).order("id", { ascending: true });
    case "amount_desc":
      return q.order("amount_rm", { ascending: false }).order("id", { ascending: false });
    case "amount_asc":
      return q.order("amount_rm", { ascending: true }).order("id", { ascending: true });
    default: // date_desc
      return q.order("txn_date", { ascending: false }).order("id", { ascending: false });
  }
}

// ---------- helpers ----------

const TXN_SELECT = `id, txn_date, posting_date, description_raw, merchant_normalized,
  amount_rm, direction, txn_type, category_id, category_source, confidence,
  business_tag, business_tag_overridden, notes, edited, needs_confirmation,
  original_currency, original_amount, card_account_id,
  card_accounts ( id, last4, display_name, banks ( name ) )`;

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapTxn(row: any): TxnRow {
  const ca = row.card_accounts ?? {};
  return {
    ...row,
    amount_rm: Number(row.amount_rm),
    original_amount: row.original_amount == null ? null : Number(row.original_amount),
    card: {
      id: ca.id,
      last4: ca.last4 ?? "????",
      display_name: ca.display_name ?? null,
      bank_name: ca.banks?.name ?? "?"
    }
  } as TxnRow;
}

// ---------- queries ----------

export const TXN_PAGE_SIZE = 200;

export async function getTransactions(
  filters: TxnFilters,
  page = 1
): Promise<{ rows: TxnRow[]; total: number; page: number; pageCount: number }> {
  // merchant filtering happens in memory (the key is derived from the raw
  // description), so that path fetches the full filtered set and slices
  if (filters.merchant) {
    const all = await getAllTransactions(filters);
    const safePage = Math.max(1, page);
    const start = (safePage - 1) * TXN_PAGE_SIZE;
    return {
      rows: all.slice(start, start + TXN_PAGE_SIZE),
      total: all.length,
      page: safePage,
      pageCount: Math.max(1, Math.ceil(all.length / TXN_PAGE_SIZE)),
    };
  }
  const supabase = getSupabase();
  let query = supabase
    .from("transactions")
    .select(TXN_SELECT, { count: "exact" });
  if (filters.card) query = query.eq("card_account_id", Number(filters.card));
  if (filters.categories?.length) {
    query = query.in("category_id", filters.categories.map(Number));
  }
  if (filters.txnType) query = query.eq("txn_type", filters.txnType);
  if (filters.from) query = query.gte("txn_date", filters.from);
  if (filters.to) query = query.lte("txn_date", filters.to);
  const safePage = Math.max(1, page);
  const from = (safePage - 1) * TXN_PAGE_SIZE;
  const { data, error, count } = await applySort(query, filters.sort)
    .range(from, from + TXN_PAGE_SIZE - 1);
  if (error) throw new Error(error.message);
  const total = count ?? 0;
  return {
    rows: (data ?? []).map(mapTxn),
    total,
    page: safePage,
    pageCount: Math.max(1, Math.ceil(total / TXN_PAGE_SIZE))
  };
}

/** Every row of the filtered view (paginated fetch) — for exports and the
 *  in-memory merchant path. */
export async function getAllTransactions(filters: TxnFilters): Promise<TxnRow[]> {
  const supabase = getSupabase();
  const rows: TxnRow[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from("transactions").select(TXN_SELECT);
    if (filters.card) q = q.eq("card_account_id", Number(filters.card));
    if (filters.categories?.length) q = q.in("category_id", filters.categories.map(Number));
    if (filters.txnType) q = q.eq("txn_type", filters.txnType);
    if (filters.from) q = q.gte("txn_date", filters.from);
    if (filters.to) q = q.lte("txn_date", filters.to);
    const { data, error } = await applySort(q, filters.sort).range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []).map(mapTxn));
    if ((data ?? []).length < 1000) break;
  }
  if (filters.merchant) {
    // the selected value may be a canonical name (covering several terminal
    // spellings) or a raw key — match either
    const aliases = await getAliasMap();
    return rows.filter((r) => {
      const k = merchantKey(r.description_raw);
      return k === filters.merchant || canonicalOf(k, aliases) === filters.merchant;
    });
  }
  return rows;
}

/** Distinct merchant keys with row counts, most frequent first — feeds the
 *  merchant picker. Near-duplicate registrations (same shop, slightly
 *  different terminal name) appear as separate keys by design; aligning them
 *  is the Management tab's job. */
export async function getMerchantList(): Promise<{ key: string; count: number }[]> {
  const supabase = getSupabase();
  const aliases = await getAliasMap();
  const counts = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("transactions").select("description_raw").order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { description_raw: string }[]) {
      // merged variants collapse under their canonical name
      const k = canonicalOf(merchantKey(r.description_raw), aliases);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    if ((data ?? []).length < 1000) break;
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key.localeCompare(b.key)); // A→Z (owner request 2026-07-21)
}

/** Raw (pre-alias) merchant keys with counts — feeds the merge UI. */
export async function getRawMerchantList(): Promise<{ key: string; count: number }[]> {
  const supabase = getSupabase();
  const counts = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("transactions").select("description_raw").order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { description_raw: string }[]) {
      const k = merchantKey(r.description_raw);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    if ((data ?? []).length < 1000) break;
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export interface TxnStats {
  count: number;
  total: number;   // signed: debits positive, credits negative
  average: number; // per transaction, signed
  highest: number;
  lowest: number;
}

/** Summary over the ENTIRE filtered set (not just the visible page).
 *  Amounts are signed — credits (refunds, payments) count negative — so a
 *  category view of pure spending reads exactly as expected. */
export async function getTransactionStats(filters: TxnFilters): Promise<TxnStats | null> {
  const supabase = getSupabase();
  type Row = { amount_rm: number; direction: "debit" | "credit"; description_raw?: string };
  let rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from("transactions")
      .select(filters.merchant ? "amount_rm,direction,description_raw" : "amount_rm,direction");
    if (filters.card) q = q.eq("card_account_id", Number(filters.card));
    if (filters.categories?.length) q = q.in("category_id", filters.categories.map(Number));
    if (filters.txnType) q = q.eq("txn_type", filters.txnType);
    if (filters.from) q = q.gte("txn_date", filters.from);
    if (filters.to) q = q.lte("txn_date", filters.to);
    const { data, error } = await q.order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as unknown as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  if (filters.merchant) {
    const aliases = await getAliasMap();
    rows = rows.filter((r) => {
      const k = merchantKey(r.description_raw ?? "");
      return k === filters.merchant || canonicalOf(k, aliases) === filters.merchant;
    });
  }
  if (rows.length === 0) return null;
  const signed = rows.map((r) => (r.direction === "credit" ? -Number(r.amount_rm) : Number(r.amount_rm)));
  const total = signed.reduce((a, v) => a + v, 0);
  return {
    count: signed.length,
    total,
    average: total / signed.length,
    highest: Math.max(...signed),
    lowest: Math.min(...signed),
  };
}

export async function getQueueTransactions(): Promise<TxnRow[]> {
  // fetch ALL pending rows (paginated past the 1000-row default page size) —
  // the queue groups them server-side, so a silent cap would split groups
  const supabase = getSupabase();
  const rows: TxnRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("transactions")
      .select(TXN_SELECT)
      .eq("needs_confirmation", true)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []).map(mapTxn));
    if ((data ?? []).length < 1000) break;
  }
  return rows;
}

export async function getCategories(): Promise<Category[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("categories")
    .select("id, name_en, name_zh, sort_order")
    .order("name_en", { ascending: true }); // A→Z (owner request 2026-07-21)
  if (error) throw new Error(error.message);
  return (data ?? []) as Category[];
}

/** Sort category display options A→Z in the CURRENT locale (English rows are
 *  already A→Z from the query; this also alphabetises the zh names). */
export function sortCategoryOptions<T extends { name: string }>(opts: T[], locale: string): T[] {
  return [...opts].sort((a, b) => a.name.localeCompare(b.name, locale === "zh" ? "zh" : "en"));
}

export async function getCards(): Promise<CardAccount[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("card_accounts")
    .select("id, last4, display_name, default_business_tag, banks ( name )")
    .order("id", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((row: any) => ({
      id: row.id,
      last4: row.last4,
      display_name: row.display_name ?? null,
      default_business_tag: row.default_business_tag ?? "personal",
      bank_name: row.banks?.name ?? "?"
    }))
    // A→Z by the label the user sees (owner request 2026-07-21)
    .sort((a, b) =>
      (a.display_name ?? `${a.bank_name} ${a.last4}`).localeCompare(
        b.display_name ?? `${b.bank_name} ${b.last4}`, "en",
      ),
    );
}

/** companies MAY NOT EXIST yet (Phase 2b addendum). Degrades gracefully. */
export async function getCompanies(): Promise<{
  companies: Company[];
  missing: boolean;
}> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("companies")
    .select("id, name, label, archived")
    .order("name", { ascending: true });
  if (error) {
    if (isMissingTableError(error)) return { companies: [], missing: true };
    throw new Error(error.message);
  }
  return { companies: (data ?? []) as Company[], missing: false };
}

/** user_profiles MAY NOT EXIST yet (Phase 2b addendum). Degrades gracefully. */
export async function getProfile(): Promise<{
  profile: UserProfile | null;
  missing: boolean;
}> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("user_profiles")
    .select("user_id, language, display_name, reminder_email")
    .eq("user_id", OWNER_USER_ID)
    .maybeSingle();
  if (error) {
    if (isMissingTableError(error)) return { profile: null, missing: true };
    throw new Error(error.message);
  }
  return { profile: (data as UserProfile) ?? null, missing: false };
}

/** Business-tag options: 'personal' plus every unarchived company.
 *  Tag values are the company label (falling back to name) — stored verbatim,
 *  never translated. */
export function buildTagOptions(
  companies: Company[],
  personalLabel: string
): { value: string; label: string }[] {
  const options = [{ value: "personal", label: personalLabel }];
  for (const c of companies) {
    if (c.archived) continue;
    options.push({ value: c.label ?? c.name, label: c.name });
  }
  return options;
}
