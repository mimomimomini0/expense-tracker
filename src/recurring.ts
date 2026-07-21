// FR-19 recurring/subscription detection. Pure and dependency-free (the web
// app imports this file directly), amounts in integer sen.
//
// A recurrence = one merchant charged on a monthly cadence: at least
// MIN_OCCURRENCES charges whose consecutive gaps all fall in
// [MIN_GAP_DAYS, MAX_GAP_DAYS]. Frequent merchants (grocers, tolls) fail the
// minimum gap; one-offs fail the count. Instalments are FR-6's domain and are
// excluded by the caller via txn_type.
//
// Merchant identity here is DELIBERATELY fuzzier than the classification
// merchant key: subscription descriptors often embed a per-charge reference
// ("Spotify P424943C90..."), so tokens containing digits are dropped from the
// grouping key. That can over-merge digit-heavy merchants (e.g. terminal
// codes), which is harmless: those fail the cadence test anyway.

export interface RecurringInput {
  description: string; // raw statement descriptor
  date: string; // YYYY-MM-DD (resolved)
  amount: number; // sen, positive
}

export interface Recurrence {
  key: string; // fuzzy grouping key
  displayName: string; // most frequent raw merchant form
  occurrences: number;
  cadenceDays: number; // median gap
  typicalAmount: number; // sen — median charge
  lastAmount: number; // sen — most recent charge
  firstSeen: string;
  lastSeen: string;
  /** charged within ACTIVE_WINDOW_DAYS of the newest transaction in the data */
  active: boolean;
  /** true = fixed-price subscription (all but at most one charge within 5% of
   *  the median); false = monthly cadence with varying amounts — a recurring
   *  BILL (usage-based telco) or a coincidence (a bakery visited monthly).
   *  Only stable recurrences count toward the monthly commitment. */
  amountStable: boolean;
  /** last charge differs from the median of the earlier ones by >1% */
  priceChange: { from: number; to: number } | null;
}

export const MIN_OCCURRENCES = 3;
export const MIN_GAP_DAYS = 25;
export const MAX_GAP_DAYS = 35;
export const ACTIVE_WINDOW_DAYS = 45;

const COUNTRY_TAIL = /\s+(MY|SG|CN|HK|TW|US|SE|GB|AU|JP|TH|ID)\.?$/;

/** Fuzzy recurrence key: uppercase, whitespace collapsed, country tail
 *  stripped, punctuation removed (TRADINGVIEWV*PRODUCT == TRADINGVIEWVPRODUCT),
 *  digit-bearing tokens dropped (per-charge references like Spotify's). */
export function recurrenceKey(description: string): string {
  const norm = description
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(COUNTRY_TAIL, "")
    .replace(/[^A-Z0-9&. ]/g, "");
  return norm
    .split(" ")
    .filter((tok) => tok.length > 0 && !/\d/.test(tok))
    .join(" ")
    .trim();
}

const dayMs = 86_400_000;
const gapDays = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / dayMs);

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export function detectRecurring(rows: RecurringInput[]): Recurrence[] {
  if (rows.length === 0) return [];
  const newest = rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0]!.date);

  const groups = new Map<string, RecurringInput[]>();
  for (const r of rows) {
    const k = recurrenceKey(r.description);
    if (!k) continue; // descriptor was all digits — nothing to identify
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }

  const out: Recurrence[] = [];
  for (const [key, list] of groups) {
    if (list.length < MIN_OCCURRENCES) continue;
    list.sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);

    // find the LONGEST run of consecutive monthly gaps ending at the most
    // recent charge — the data may hold an old ended chain plus a live one
    // (and gaps from missing statement years break chains, honestly)
    let runEnd = list.length - 1;
    let best: RecurringInput[] | null = null;
    while (runEnd >= 0) {
      let start = runEnd;
      while (start > 0) {
        const g = gapDays(list[start - 1]!.date, list[start]!.date);
        if (g < MIN_GAP_DAYS || g > MAX_GAP_DAYS) break;
        start--;
      }
      const run = list.slice(start, runEnd + 1);
      if (run.length >= MIN_OCCURRENCES && (best == null || run.length > best.length)) {
        best = run;
      }
      runEnd = start - 1;
    }
    if (!best) continue;

    const gaps = best.slice(1).map((r, i) => gapDays(best![i]!.date, r.date));
    const amounts = best.map((r) => r.amount);
    const last = best[best.length - 1]!;
    const med = median(amounts);

    // Stability = the charges form at most TWO tight price clusters (5% band),
    // and if two, ALL old-price charges precede ALL new-price charges — a
    // price change. A bakery's scatter makes >2 clusters; a usage-based bill
    // (telco) interleaves up and down; both read as variable.
    const sorted = [...amounts].sort((a, b) => a - b);
    const clusterBounds: { min: number; max: number }[] = [];
    for (const a of sorted) {
      const cur = clusterBounds[clusterBounds.length - 1];
      if (cur && a <= cur.min * 1.05) cur.max = a;
      else clusterBounds.push({ min: a, max: a });
    }
    const clusterOf = (a: number) => clusterBounds.findIndex((c) => a >= c.min && a <= c.max);
    const seq = best.map((r) => clusterOf(r.amount));
    const chronological = seq.every((c, i) => i === 0 || c === seq[i - 1] || (c !== seq[i - 1] && seq.slice(i).every((x) => x === c)));
    const amountStable =
      clusterBounds.length === 1 || (clusterBounds.length === 2 && chronological);

    let priceChange: { from: number; to: number } | null = null;
    if (amountStable && clusterBounds.length === 2) {
      const firstCluster = seq[0]!;
      const other = firstCluster === 0 ? 1 : 0;
      priceChange = {
        from: median(best.filter((_, i) => seq[i] === firstCluster).map((r) => r.amount)),
        to: median(best.filter((_, i) => seq[i] === other).map((r) => r.amount)),
      };
    } else if (amountStable) {
      const earlierMedian = median(amounts.slice(0, -1));
      if (Math.abs(last.amount - earlierMedian) > earlierMedian * 0.01) {
        priceChange = { from: earlierMedian, to: last.amount };
      }
    }

    // display name: most frequent full merchant form in the run
    const nameCounts = new Map<string, number>();
    for (const r of best) {
      const n = r.description.toUpperCase().replace(/\s+/g, " ").trim().replace(COUNTRY_TAIL, "");
      nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
    }
    const displayName = [...nameCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];

    out.push({
      key,
      displayName,
      occurrences: best.length,
      cadenceDays: median(gaps),
      typicalAmount: med,
      lastAmount: last.amount,
      firstSeen: best[0]!.date,
      lastSeen: last.date,
      active: gapDays(last.date, newest) <= ACTIVE_WINDOW_DAYS,
      amountStable,
      priceChange,
    });
  }

  return out.sort((a, b) =>
    Number(b.active) - Number(a.active) || b.typicalAmount - a.typicalAmount,
  );
}

/** Total monthly commitment of the ACTIVE, fixed-price recurrences, in sen.
 *  Variable-amount recurrences are excluded — their "typical" amount is not a
 *  commitment. */
export function monthlyCommitment(recs: Recurrence[]): number {
  return recs
    .filter((r) => r.active && r.amountStable)
    .reduce((s, r) => s + r.typicalAmount, 0);
}
