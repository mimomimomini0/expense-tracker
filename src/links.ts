// Transfer-linking for the TNG e-wallet input (owner request, 20 Jul 2026 —
// TNG-EWALLET-NOTES.md "double-counting guard"). Two independent matchers:
//
//   1. Reload <-> credit-card transaction: a reload funded DIRECTLY by a card
//      appears on that card's statement as a TNG-pattern purchase of the SAME
//      amount. Links are written only for exact-amount, unambiguous matches
//      inside a small date window — anything else is reported, never linked.
//      (In the owner's data, app top-ups carry a 1% fee — RM101 for RM100 —
//      and fund the eWallet APP balance, not an NFC card directly. Those are
//      surfaced as `topupsWithoutReload`, NOT force-matched to reloads.)
//
//   2. Inter-card: a reload on one TNG card matched by an equal-amount debit
//      row on a sibling card within minutes (e.g. card 2164085007 funding
//      card 1113643631). Same conservatism: exact amount, tight time window,
//      unambiguous, different cards.
//
// Pure of storage: callers feed rows in, links come out. Never silently wrong:
// every reload the matcher does NOT link is returned with the reason why.

import { daysBetween } from "./dates.js";
import type { Sen } from "./money.js";
import type { ResolvedTngRow } from "./tng.js";

export interface LinkableCardTxn {
  /** Supabase transactions.id when linking against the database; null in tests. */
  id: number | null;
  txn_date: string; // resolved YYYY-MM-DD
  description: string;
  amount: Sen;
  direction: "debit" | "credit";
  bank?: string;
  last4?: string;
}

/**
 * Does this credit-card transaction description look like a TNG eWallet
 * top-up / payment to TNG? Word-boundary on the bare TNG token so ordinary
 * merchants never false-positive.
 */
export function isEwalletTopup(description: string): boolean {
  const d = description.toUpperCase().replace(/\s+/g, " ").trim();
  return (
    /\bTNG\b/.test(d) ||
    d.includes("TNGDIGITAL") ||
    d.includes("TNG DIGITAL") ||
    d.includes("TOUCH N GO") ||
    d.includes("TOUCH 'N GO") ||
    d.includes("TOUCHNGO")
  );
}

export type UnmatchedReloadReason =
  | "app_funded" // INTERNET RELOAD via the eWallet app — no direct card txn exists
  | "terminal_cash" // SSK/terminal reload — cash, never on a card statement
  | "no_candidate" // card-linkable but nothing matched
  | "ambiguous"; // multiple equally-good card txns — needs review, no link

export interface ReloadCardLink {
  reload: ResolvedTngRow;
  txn: LinkableCardTxn;
  daysApart: number;
}

export interface UnmatchedReload {
  reload: ResolvedTngRow;
  reason: UnmatchedReloadReason;
  candidates: LinkableCardTxn[]; // populated for "ambiguous"
}

export interface ReloadLinkReport {
  links: ReloadCardLink[];
  unmatchedReloads: UnmatchedReload[];
  /** TNG-pattern card debits that matched no reload — eWallet APP top-ups. */
  topupsWithoutReload: LinkableCardTxn[];
}

function classifyUnlinked(reload: ResolvedTngRow): UnmatchedReloadReason {
  const src = (reload.reload_source ?? "").toUpperCase();
  if (src.includes("INTERNET")) return "app_funded";
  if (src.includes("SSK") || src.includes("TERMINAL")) return "terminal_cash";
  return "no_candidate";
}

/**
 * Match TNG reload rows against credit-card transactions. Exact amount,
 * TNG-pattern debit, |date difference| <= windowDays. Unique assignment by
 * closest date; a tie between candidates means NO link (needs review).
 */
export function linkReloadsToCardTxns(
  rows: ResolvedTngRow[],
  cardTxns: LinkableCardTxn[],
  windowDays = 3,
): ReloadLinkReport {
  const reloads = rows.filter((r) => r.kind === "reload");
  const topups = cardTxns.filter((t) => t.direction === "debit" && isEwalletTopup(t.description));

  interface Candidate { reload: ResolvedTngRow; txn: LinkableCardTxn; dist: number }
  const candidates: Candidate[] = [];
  for (const reload of reloads) {
    for (const txn of topups) {
      if (txn.amount !== reload.amount) continue;
      const dist = Math.abs(daysBetween(txn.txn_date, reload.trans_date));
      if (dist <= windowDays) candidates.push({ reload, txn, dist });
    }
  }
  candidates.sort((a, b) => a.dist - b.dist);

  const usedReloads = new Set<ResolvedTngRow>();
  const usedTxns = new Set<LinkableCardTxn>();
  const ambiguous = new Map<ResolvedTngRow, LinkableCardTxn[]>();
  const links: ReloadCardLink[] = [];

  for (const c of candidates) {
    if (usedReloads.has(c.reload) || usedTxns.has(c.txn)) continue;
    if (ambiguous.has(c.reload)) continue;
    // a tie: another unused candidate for the SAME reload at the SAME distance
    const ties = candidates.filter(
      (o) => o.reload === c.reload && o.txn !== c.txn && o.dist === c.dist && !usedTxns.has(o.txn),
    );
    if (ties.length > 0) {
      ambiguous.set(c.reload, [c.txn, ...ties.map((t) => t.txn)]);
      continue;
    }
    usedReloads.add(c.reload);
    usedTxns.add(c.txn);
    links.push({ reload: c.reload, txn: c.txn, daysApart: c.dist });
  }

  const unmatchedReloads: UnmatchedReload[] = reloads
    .filter((r) => !usedReloads.has(r))
    .map((r) =>
      ambiguous.has(r)
        ? { reload: r, reason: "ambiguous" as const, candidates: ambiguous.get(r)! }
        : { reload: r, reason: classifyUnlinked(r), candidates: [] },
    );

  return {
    links,
    unmatchedReloads,
    topupsWithoutReload: topups.filter((t) => !usedTxns.has(t)),
  };
}

// ---------------- inter-card transfers ----------------

export interface InterCardLink {
  reload: ResolvedTngRow; // the receiving side (kind "reload")
  source: ResolvedTngRow; // the funding side (a debit row on a DIFFERENT card)
  minutesApart: number;
}

function minutesBetween(aDatetime: string, bDatetime: string): number {
  // accepts both the extraction form "YYYY-MM-DD HH:MM:SS" (statement-local,
  // compared to its own kind) and DB timestamptz ISO strings
  const t = (s: string) => new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z").getTime();
  return Math.abs(t(aDatetime) - t(bDatetime)) / 60000;
}

/**
 * Match a reload on one card to an equal-amount debit (usage/other) row on a
 * DIFFERENT card of the same statement within toleranceMinutes. Unique
 * assignment by closest time; ties link nothing.
 */
export function linkInterCardTransfers(
  rows: ResolvedTngRow[],
  toleranceMinutes = 10,
): InterCardLink[] {
  const reloads = rows.filter((r) => r.kind === "reload");
  const debits = rows.filter((r) => r.kind !== "reload");

  interface Candidate { reload: ResolvedTngRow; source: ResolvedTngRow; dist: number }
  const candidates: Candidate[] = [];
  for (const reload of reloads) {
    for (const source of debits) {
      if (source.card_serial === reload.card_serial) continue;
      if (source.amount !== reload.amount) continue;
      const dist = minutesBetween(reload.trans_datetime, source.trans_datetime);
      if (dist <= toleranceMinutes) candidates.push({ reload, source, dist });
    }
  }
  candidates.sort((a, b) => a.dist - b.dist);

  const usedReloads = new Set<ResolvedTngRow>();
  const usedSources = new Set<ResolvedTngRow>();
  const links: InterCardLink[] = [];
  for (const c of candidates) {
    if (usedReloads.has(c.reload) || usedSources.has(c.source)) continue;
    const ties = candidates.filter(
      (o) => o.reload === c.reload && o.source !== c.source && o.dist === c.dist && !usedSources.has(o.source),
    );
    if (ties.length > 0) {
      usedReloads.add(c.reload); // ambiguous: block this reload from linking at all
      continue;
    }
    usedReloads.add(c.reload);
    usedSources.add(c.source);
    links.push({ reload: c.reload, source: c.source, minutesApart: c.dist });
  }
  return links;
}
