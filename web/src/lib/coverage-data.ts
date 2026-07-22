import "server-only";
import { getSupabase } from "./supabase";

/** Statement-coverage matrix (owner request 2026-07-21): how many statements
 *  were uploaded in each calendar month, so a "0" or a low month flags a
 *  missing upload at a glance. Each cell carries the list of statements for
 *  the hover note. Grouped by the STATEMENT date's year/month. */

export interface CoverageCell {
  count: number;
  statements: string[]; // "CIMB ••2225 — 2026-05-19" style labels
}

export interface CoverageYear {
  year: number;
  months: CoverageCell[]; // 12 cells, Jan..Dec
  total: number;
}

export async function getStatementCoverage(): Promise<CoverageYear[]> {
  const supabase = getSupabase();

  const cardsQ = await supabase.from("card_accounts").select("id,last4,display_name,banks(name)");
  if (cardsQ.error) throw new Error(cardsQ.error.message);
  const cardLabel = new Map<number, string>();
  for (const c of (cardsQ.data ?? []) as unknown as { id: number; last4: string; display_name: string | null; banks: { name: string } | null }[]) {
    cardLabel.set(c.id, c.display_name ?? `${c.banks?.name ?? "?"} ••${c.last4}`);
  }

  // a statement can hold several cards; label by its distinct cards
  const scQ = await supabase.from("statement_cards").select("statement_id,card_account_id");
  if (scQ.error) throw new Error(scQ.error.message);
  const cardsByStmt = new Map<number, number[]>();
  for (const r of (scQ.data ?? []) as { statement_id: number; card_account_id: number }[]) {
    if (!cardsByStmt.has(r.statement_id)) cardsByStmt.set(r.statement_id, []);
    cardsByStmt.get(r.statement_id)!.push(r.card_account_id);
  }

  const stmtQ = await supabase.from("statements")
    .select("id,statement_date,filename").order("statement_date");
  if (stmtQ.error) throw new Error(stmtQ.error.message);

  const byYear = new Map<number, CoverageCell[]>();
  const ensureYear = (year: number) => {
    if (!byYear.has(year)) {
      byYear.set(year, Array.from({ length: 12 }, () => ({ count: 0, statements: [] })));
    }
    return byYear.get(year)!;
  };

  for (const s of (stmtQ.data ?? []) as { id: number; statement_date: string; filename: string }[]) {
    const year = Number(s.statement_date.slice(0, 4));
    const monthIdx = Number(s.statement_date.slice(5, 7)) - 1;
    const cell = ensureYear(year)[monthIdx]!;
    cell.count++;
    const cards = (cardsByStmt.get(s.id) ?? []).map((id) => cardLabel.get(id) ?? `#${id}`);
    const who = cards.length > 0 ? [...new Set(cards)].join(", ") : s.filename;
    cell.statements.push(`${who} — ${s.statement_date}`);
  }

  return [...byYear.entries()]
    .map(([year, months]) => ({
      year,
      months,
      total: months.reduce((s, c) => s + c.count, 0),
    }))
    .sort((a, b) => b.year - a.year);
}

// ---------- per-bank coverage (owner request 2026-07-22) ----------
// One statement from a bank usually covers all its cards, so coverage is
// tracked per BANK per month. Missing months are flagged; a flag can be
// dismissed ("unflag" / "unflag forever") — persisted in edit_log
// (field='coverage_dismiss', entity_id=bankId, new_value=YYYY-MM) so no new
// table is needed.

export interface BankMonth { ym: string; present: boolean; dismissed: boolean; }
export interface BankCoverage {
  bankId: number;
  bankName: string;
  cards: string[]; // last4 list
  monthsCovered: number;
  latestDate: string | null;
  months: BankMonth[]; // earliest present month .. current month
  missingActive: number; // non-dismissed missing months
  behind: boolean; // a recent month (this/last) is missing and not dismissed
}

const nextYm = (ym: string): string => {
  let [y, m] = ym.split("-").map(Number) as [number, number];
  m += 1; if (m > 12) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
};
const prevYm = (ym: string): string => {
  let [y, m] = ym.split("-").map(Number) as [number, number];
  m -= 1; if (m < 1) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
};

export async function getBankCoverage(todayIso?: string): Promise<BankCoverage[]> {
  const supabase = getSupabase();
  const todayYm = (todayIso ?? new Date().toISOString().slice(0, 10)).slice(0, 7);

  const banksQ = await supabase.from("banks").select("id,name");
  if (banksQ.error) throw new Error(banksQ.error.message);
  const cardsQ = await supabase.from("card_accounts").select("last4,bank_id");
  if (cardsQ.error) throw new Error(cardsQ.error.message);
  const stmtQ = await supabase.from("statements").select("bank_id,statement_date");
  if (stmtQ.error) throw new Error(stmtQ.error.message);
  const dq = await supabase.from("edit_log").select("entity_id,new_value").eq("field", "coverage_dismiss");
  if (dq.error) throw new Error(dq.error.message);

  const dismissed = new Set<string>();
  for (const d of (dq.data ?? []) as { entity_id: number; new_value: string }[]) {
    dismissed.add(`${d.entity_id}:${d.new_value}`);
  }
  const monthsByBank = new Map<number, Set<string>>();
  const latestByBank = new Map<number, string>();
  for (const s of (stmtQ.data ?? []) as { bank_id: number; statement_date: string }[]) {
    const ym = s.statement_date.slice(0, 7);
    if (!monthsByBank.has(s.bank_id)) monthsByBank.set(s.bank_id, new Set());
    monthsByBank.get(s.bank_id)!.add(ym);
    const cur = latestByBank.get(s.bank_id);
    if (!cur || s.statement_date > cur) latestByBank.set(s.bank_id, s.statement_date);
  }
  const cardsByBank = new Map<number, string[]>();
  for (const c of (cardsQ.data ?? []) as { last4: string; bank_id: number }[]) {
    if (!cardsByBank.has(c.bank_id)) cardsByBank.set(c.bank_id, []);
    cardsByBank.get(c.bank_id)!.push(c.last4);
  }

  const recent = new Set([todayYm, prevYm(todayYm)]);
  const out: BankCoverage[] = [];
  for (const b of (banksQ.data ?? []) as { id: number; name: string }[]) {
    const present = monthsByBank.get(b.id);
    if (!present || present.size === 0) continue; // nothing uploaded — nothing to track
    const earliest = [...present].sort()[0]!;
    const months: BankMonth[] = [];
    for (let ym = earliest; ym <= todayYm; ym = nextYm(ym)) {
      const isPresent = present.has(ym);
      months.push({ ym, present: isPresent, dismissed: !isPresent && dismissed.has(`${b.id}:${ym}`) });
    }
    const missingActive = months.filter((m) => !m.present && !m.dismissed).length;
    const behind = months.some((m) => recent.has(m.ym) && !m.present && !m.dismissed);
    out.push({
      bankId: b.id, bankName: b.name,
      cards: [...new Set(cardsByBank.get(b.id) ?? [])].sort(),
      monthsCovered: present.size, latestDate: latestByBank.get(b.id) ?? null,
      months, missingActive, behind,
    });
  }
  out.sort((a, b) => Number(b.behind) - Number(a.behind) || a.bankName.localeCompare(b.bankName));
  return out;
}
