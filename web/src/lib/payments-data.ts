import "server-only";
import { getSupabase } from "./supabase";

/** FR-9 Upcoming Payments. The engine (src/payments.ts) computes cycles and
 *  auto-detects payments from the following statement; this layer only picks
 *  what the dashboard shows: each card's LATEST cycle, kept while its due
 *  date is near — within 45 days past or any time in the future. All date
 *  arithmetic is Asia/Kuala_Lumpur (spec §9: a reminder on the wrong calendar
 *  day is a core-purpose defect). */

export type CycleStatus = "unpaid" | "paid_full" | "paid_minimum" | "paid_other" | "overdue";

export interface UpcomingPayment {
  cycleId: number;
  cardId: number;
  cardLabel: string;
  statementBalance: number;
  minimumDue: number | null;
  dueDate: string;
  daysRemaining: number; // negative = overdue
  status: Exclude<CycleStatus, "overdue">;
  autoDetected: boolean;
  amountPaid: number;
  recordedAt: string | null;
}

export function klToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
}

function daysFromToday(iso: string): number {
  const ms = Date.parse(iso) - Date.parse(klToday());
  return Math.round(ms / 86_400_000);
}

export async function getUpcomingPayments(): Promise<UpcomingPayment[]> {
  const supabase = getSupabase();
  const [cyclesQ, cardsQ] = await Promise.all([
    supabase.from("payment_cycles")
      .select("id,card_account_id,statement_id,due_date,statement_balance,minimum_due,status,amount_paid,paid_recorded_at,auto_detected"),
    supabase.from("card_accounts").select("id,last4,display_name,banks(name)"),
  ]);
  if (cyclesQ.error) throw new Error(cyclesQ.error.message);
  if (cardsQ.error) throw new Error(cardsQ.error.message);

  type Cy = {
    id: number; card_account_id: number; due_date: string | null;
    statement_balance: number; minimum_due: number | null; status: string;
    amount_paid: number; paid_recorded_at: string | null; auto_detected: boolean;
  };
  // latest cycle per card, by due date
  const latest = new Map<number, Cy>();
  for (const c of (cyclesQ.data ?? []) as unknown as Cy[]) {
    if (!c.due_date) continue;
    const cur = latest.get(c.card_account_id);
    if (!cur || c.due_date > cur.due_date!) latest.set(c.card_account_id, c);
  }

  const out: UpcomingPayment[] = [];
  for (const c of latest.values()) {
    const days = daysFromToday(c.due_date!);
    if (days < -45) continue; // stale history (old replaced cards) — not actionable
    const card = (cardsQ.data ?? []).find((x) => x.id === c.card_account_id) as
      | { id: number; last4: string; display_name: string | null; banks: { name: string } | null }
      | undefined;
    out.push({
      cycleId: c.id,
      cardId: c.card_account_id,
      cardLabel: card?.display_name ?? `${card?.banks?.name ?? "?"} ••${card?.last4 ?? "????"}`,
      statementBalance: Number(c.statement_balance),
      minimumDue: c.minimum_due == null ? null : Number(c.minimum_due),
      dueDate: c.due_date!,
      daysRemaining: days,
      status: c.status as UpcomingPayment["status"],
      autoDetected: c.auto_detected,
      amountPaid: Number(c.amount_paid),
      recordedAt: c.paid_recorded_at,
    });
  }
  // most urgent first: unpaid overdue, then unpaid by days remaining, then settled
  return out.sort((a, b) => {
    const ua = a.status === "unpaid" ? 0 : 1;
    const ub = b.status === "unpaid" ? 0 : 1;
    return ua - ub || a.daysRemaining - b.daysRemaining;
  });
}

export interface DueDateEntry {
  cycleId: number;
  cardLabel: string;
  dueDate: string; // YYYY-MM-DD
  statementBalance: number;
  status: string;
  daysRemaining: number;
}

/** Every payment cycle whose due date falls inside [fromIso, toIso] — the
 *  due-date calendar's data. Includes settled cycles (shown green). */
export async function getDueDatesInRange(fromIso: string, toIso: string): Promise<DueDateEntry[]> {
  const supabase = getSupabase();
  const [cyclesQ, cardsQ] = await Promise.all([
    supabase.from("payment_cycles")
      .select("id,card_account_id,due_date,statement_balance,status")
      .gte("due_date", fromIso).lte("due_date", toIso),
    supabase.from("card_accounts").select("id,last4,display_name,banks(name)"),
  ]);
  if (cyclesQ.error) throw new Error(cyclesQ.error.message);
  if (cardsQ.error) throw new Error(cardsQ.error.message);
  return ((cyclesQ.data ?? []) as unknown as {
    id: number; card_account_id: number; due_date: string;
    statement_balance: number; status: string;
  }[]).map((c) => {
    const card = (cardsQ.data ?? []).find((x) => x.id === c.card_account_id) as
      | { last4: string; display_name: string | null; banks: { name: string } | null }
      | undefined;
    return {
      cycleId: c.id,
      cardLabel: card?.display_name ?? `${card?.banks?.name ?? "?"} ••${card?.last4 ?? "????"}`,
      dueDate: c.due_date,
      statementBalance: Number(c.statement_balance),
      status: c.status,
      daysRemaining: Math.round((Date.parse(c.due_date) - Date.parse(klToday())) / 86_400_000),
    };
  }).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

/** The single most urgent actionable payment, for the site-wide banner. */
export async function getBannerPayment(): Promise<UpcomingPayment | null> {
  try {
    const all = await getUpcomingPayments();
    return all.find((p) => p.status === "unpaid" && p.daysRemaining <= 7) ?? null;
  } catch {
    return null; // the banner must never take a page down
  }
}
