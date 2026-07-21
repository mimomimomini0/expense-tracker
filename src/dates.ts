// FR-3 date resolution. All arithmetic in Asia/Kuala_Lumpur.
// Statement dates arrive as full ISO dates (printed on the statement).
// Transaction/due dates arrive as raw printed strings and are resolved by
// anchoring to the statement date. Deterministic, no LLM involvement.

import { DateTime } from "luxon";

export const ZONE = "Asia/Kuala_Lumpur";

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
};

export interface ResolvedDate {
  iso: string | null; // YYYY-MM-DD
  flagged: boolean;   // true when zero or multiple interpretations satisfy the window
  reason?: string;
}

function dt(iso: string): DateTime {
  return DateTime.fromISO(iso, { zone: ZONE });
}

function make(year: number, month: number, day: number): DateTime | null {
  const d = DateTime.fromObject({ year, month, day }, { zone: ZONE });
  return d.isValid ? d : null;
}

interface RawParts {
  day: number;
  month: number;
  year: number | null;
  // true when the raw form was digit/digit so day and month could be swapped
  dayMonthAmbiguous: boolean;
}

// Parse the printed form into candidate (day, month, year?) tuples.
// "19 APR" | "27 Jun" | "19 APR 2026" | "04/08/2026" | "07/03" | "2026-04-05"
export function parseRawDateParts(raw: string): RawParts[] {
  const s = raw.trim().toUpperCase();

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    return [{ day: +m[3]!, month: +m[2]!, year: +m[1]!, dayMonthAmbiguous: false }];
  }

  m = s.match(/^(\d{1,2})[ .-]?([A-Z]{3,4})[ .-]?(\d{2,4})?$/);
  if (m) {
    const month = MONTHS[m[2]!];
    if (!month) return [];
    let year: number | null = null;
    if (m[3]) year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return [{ day: +m[1]!, month, year, dayMonthAmbiguous: false }];
  }

  m = s.match(/^([A-Z]{3,4})[ .-]?(\d{1,2})[ ,.-]*(\d{2,4})?$/);
  if (m) {
    const month = MONTHS[m[1]!];
    if (!month) return [];
    let year: number | null = null;
    if (m[3]) year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return [{ day: +m[2]!, month, year, dayMonthAmbiguous: false }];
  }

  // compact DDMM with no separator ("2303" = 23/03) — RHB's 2024 layout.
  // Malaysian statements print day-month; the compact form gets ONLY that
  // reading (a month-day alternative would falsely flag every early-month
  // row as ambiguous). An impossible month simply yields no candidate.
  m = s.match(/^(\d{2})(\d{2})$/);
  if (m) {
    return [{ day: +m[1]!, month: +m[2]!, year: null, dayMonthAmbiguous: false }];
  }

  m = s.match(/^(\d{1,2})[\/](\d{1,2})(?:[\/](\d{2,4}))?$/);
  if (m) {
    const a = +m[1]!;
    const b = +m[2]!;
    let year: number | null = null;
    if (m[3]) year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const out: RawParts[] = [];
    // dd/mm reading (Malaysian statements print dd/mm)
    if (b >= 1 && b <= 12) out.push({ day: a, month: b, year, dayMonthAmbiguous: a <= 12 && a !== b });
    // mm/dd reading — a distinct alternative only when a can be a month and the
    // date differs; invalid day/month combos are dropped by make()
    if (a >= 1 && a <= 12 && a !== b) out.push({ day: b, month: a, year, dayMonthAmbiguous: true });
    return out;
  }

  return [];
}

function candidatesWithYears(parts: RawParts[], years: number[]): DateTime[] {
  const out: DateTime[] = [];
  for (const p of parts) {
    const yearList = p.year !== null ? [p.year] : years;
    for (const y of yearList) {
      const d = make(y, p.month, p.day);
      if (d) out.push(d);
    }
  }
  // dedupe identical dates (e.g. palindromic 05/05)
  const seen = new Set<string>();
  return out.filter((d) => {
    const k = d.toISODate()!;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Resolve a transaction date. Window: must fall inside the statement period,
 * approximated as [statement_date - 45 days, statement_date]. Year rule for
 * month-name forms: month <= statement month -> statement year, else year - 1.
 */
export function resolveTxnDate(raw: string, statementIso: string): ResolvedDate {
  const stmt = dt(statementIso);
  const parts = parseRawDateParts(raw);
  if (parts.length === 0) return { iso: null, flagged: true, reason: `unparseable date "${raw}"` };

  const years = [stmt.year, stmt.year - 1];
  const all = candidatesWithYears(parts, years);

  const windowStart = stmt.minus({ days: 45 });
  const inWindow = all.filter((d) => d >= windowStart && d <= stmt);

  if (inWindow.length === 1) return { iso: inWindow[0]!.toISODate()!, flagged: false };
  if (inWindow.length === 0) {
    // FR-3: dates resolving outside period +/- 45 days flag the statement.
    // Pick the closest interpretation for record-keeping but flag it.
    const best = all.sort(
      (a, b) => Math.abs(a.diff(stmt, "days").days) - Math.abs(b.diff(stmt, "days").days),
    )[0];
    return {
      iso: best ? best.toISODate()! : null,
      flagged: true,
      reason: `"${raw}" resolves outside the statement window`,
    };
  }
  return { iso: null, flagged: true, reason: `"${raw}" is ambiguous within the statement window` };
}

/**
 * Resolve a payment due date. Window: 10-30 days AFTER the statement date.
 * Crosses the year boundary forward (Dec statement -> Jan due date, year + 1).
 */
export function resolveDueDate(raw: string, statementIso: string): ResolvedDate {
  const stmt = dt(statementIso);
  const parts = parseRawDateParts(raw);
  if (parts.length === 0) return { iso: null, flagged: true, reason: `unparseable due date "${raw}"` };

  const years = [stmt.year, stmt.year + 1];
  const all = candidatesWithYears(parts, years);

  const lo = stmt.plus({ days: 10 });
  const hi = stmt.plus({ days: 30 });
  const inWindow = all.filter((d) => d >= lo && d <= hi);

  if (inWindow.length === 1) return { iso: inWindow[0]!.toISODate()!, flagged: false };
  if (inWindow.length === 0) {
    return { iso: null, flagged: true, reason: `due date "${raw}" has no reading 10-30 days after statement` };
  }
  return { iso: null, flagged: true, reason: `due date "${raw}" is ambiguous` };
}

export function daysBetween(isoA: string, isoB: string): number {
  return dt(isoB).diff(dt(isoA), "days").days;
}
