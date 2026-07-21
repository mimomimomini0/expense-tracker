// FR-20 cost-of-credit analytics + interest-tier tracking. Pure and
// dependency-free (the web app imports this file directly).

export interface FeeRow {
  cardId: number;
  date: string; // YYYY-MM-DD
  amount: number; // sen
  description: string;
}

export interface FeeSummary {
  total: number;
  count: number;
  byYear: { year: string; total: number; count: number }[];
  byCard: { cardId: number; total: number; count: number; byYear: Record<string, number> }[];
}

/** Totals of fee_interest rows (late charges, finance charges, service tax,
 *  annual fees) — "what your cards cost you". */
export function summarizeFees(rows: FeeRow[]): FeeSummary {
  const byYear = new Map<string, { total: number; count: number }>();
  const byCard = new Map<number, { total: number; count: number; byYear: Record<string, number> }>();
  let total = 0;
  for (const r of rows) {
    total += r.amount;
    const year = r.date.slice(0, 4);
    const y = byYear.get(year) ?? { total: 0, count: 0 };
    y.total += r.amount; y.count++;
    byYear.set(year, y);
    const c = byCard.get(r.cardId) ?? { total: 0, count: 0, byYear: {} };
    c.total += r.amount; c.count++;
    c.byYear[year] = (c.byYear[year] ?? 0) + r.amount;
    byCard.set(r.cardId, c);
  }
  return {
    total,
    count: rows.length,
    byYear: [...byYear.entries()].map(([year, v]) => ({ year, ...v })).sort((a, b) => a.year.localeCompare(b.year)),
    byCard: [...byCard.entries()].map(([cardId, v]) => ({ cardId, ...v })).sort((a, b) => b.total - a.total),
  };
}

export interface TierPoint {
  cardId: number;
  statementDate: string;
  rate: number; // percent as printed, e.g. 15
}

export interface TierHistory {
  cardId: number;
  history: { statementDate: string; rate: number; worsened: boolean }[];
  /** the card's LATEST statement worsened vs the one before — alert (FR-20) */
  latestWorsened: boolean;
}

/** Per-card printed-rate history; each point is flagged when the rate rose
 *  versus the previous statement of the same card. */
export function trackTiers(points: TierPoint[]): TierHistory[] {
  const byCard = new Map<number, TierPoint[]>();
  for (const p of points) {
    if (!byCard.has(p.cardId)) byCard.set(p.cardId, []);
    byCard.get(p.cardId)!.push(p);
  }
  const out: TierHistory[] = [];
  for (const [cardId, list] of byCard) {
    list.sort((a, b) => a.statementDate.localeCompare(b.statementDate));
    const history = list.map((p, i) => ({
      statementDate: p.statementDate,
      rate: p.rate,
      worsened: i > 0 && p.rate > list[i - 1]!.rate,
    }));
    out.push({
      cardId,
      history,
      latestWorsened: history.length > 0 && history[history.length - 1]!.worsened,
    });
  }
  return out.sort((a, b) => Number(b.latestWorsened) - Number(a.latestWorsened) || a.cardId - b.cardId);
}
