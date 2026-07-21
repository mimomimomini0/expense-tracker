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
