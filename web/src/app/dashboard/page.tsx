import { getLocale, getTranslations } from "next-intl/server";
import { getCards } from "@/lib/data";
import { getDashboardData, getPeriodSpending, type DashboardData, type DashboardFilters } from "@/lib/dashboard-data";
import { getUpcomingPayments, type UpcomingPayment } from "@/lib/payments-data";
import { getDisputeAlerts, type DisputeAlert } from "@/lib/flags-data";
import { cardLabel, formatRM } from "@/lib/format";
import DisputePanel from "./DisputePanel";
import PaymentsPanel from "./PaymentsPanel";
import DetailsAutoClose from "../components/DetailsAutoClose";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s === "" ? undefined : s;
}

function many(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).filter((s) => s !== "");
}

/** default period: the last 12 calendar months including the current one */
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1))
    .toISOString().slice(0, 10);
  return { from, to };
}

// categorical slots in FIXED order — CSS variables so the light/dark values
// (both validated palettes) swap with the theme
const SLOTS = Array.from({ length: 8 }, (_, i) => `var(--s${i + 1})`);
const UNCAT_COLOR = "var(--ink-muted)"; // de-emphasis gray: "no identity", outside the slots
const S_SPENDING = SLOTS[0]!;
const S_FEES = SLOTS[1]!;
const S_REFUNDS = SLOTS[2]!;

function niceCeil(v: number): number {
  if (v <= 0) return 100;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * pow >= v) return m * pow;
  }
  return 10 * pow;
}

const monthShort = (m: string, locale: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString(locale === "zh" ? "zh-CN" : "en-MY", {
    month: "short", timeZone: "UTC",
  });

function monthEnd(m: string): string {
  const [y, mo] = [Number(m.slice(0, 4)), Number(m.slice(5, 7))];
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}

interface Period {
  label: string; sub: string | null; from: string; to: string;
  spending: number; fees: number; refunds: number;
}

/** Roll the monthly buckets up to the chosen granularity (FR-11). */
function aggregatePeriods(
  months: { month: string; spending: number; fees: number; refunds: number }[],
  gran: "month" | "quarter" | "year",
  locale: string,
): Period[] {
  if (gran === "month") {
    return months.map((m) => ({
      label: monthShort(m.month, locale),
      sub: m.month.endsWith("-01") ? m.month.slice(0, 4) : null,
      from: `${m.month}-01`, to: monthEnd(m.month),
      spending: m.spending, fees: m.fees, refunds: m.refunds,
    }));
  }
  const groups = new Map<string, Period>();
  const order: string[] = [];
  for (const m of months) {
    const y = m.month.slice(0, 4);
    const mo = Number(m.month.slice(5, 7));
    const key = gran === "year" ? y : `${y}-Q${Math.ceil(mo / 3)}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        label: gran === "year" ? y : `Q${Math.ceil(mo / 3)}`,
        sub: gran === "year" ? null : y,
        from: `${m.month}-01`, to: monthEnd(m.month),
        spending: 0, fees: 0, refunds: 0,
      };
      groups.set(key, g);
      order.push(key);
    }
    g.to = monthEnd(m.month); // extend to the latest month in the group
    g.spending += m.spending; g.fees += m.fees; g.refunds += m.refunds;
  }
  return order.map((k) => groups.get(k)!);
}

export default async function DashboardPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const def = defaultRange();
  const selectedCards = many(sp.card);
  const filters: DashboardFilters = {
    from: first(sp.from) ?? def.from,
    to: first(sp.to) ?? def.to,
    cards: selectedCards,
    ewallet: first(sp.ew) !== "0",
  };

  const GRANS = ["month", "quarter", "year"] as const;
  const granularity = (GRANS as readonly string[]).includes(first(sp.g) ?? "")
    ? (first(sp.g) as (typeof GRANS)[number])
    : "month";

  // prior window of equal length immediately before `from` (FR-17 comparison)
  const dayMs = 86_400_000;
  const fromMs = Date.parse(filters.from);
  const spanMs = Date.parse(filters.to) - fromMs;
  const prevFilters: DashboardFilters = {
    ...filters,
    to: new Date(fromMs - dayMs).toISOString().slice(0, 10),
    from: new Date(fromMs - dayMs - spanMs).toISOString().slice(0, 10),
  };

  const locale = await getLocale();
  const t = await getTranslations("dashboard");
  const tc = await getTranslations("common");

  let data: DashboardData | null = null;
  let cards: Awaited<ReturnType<typeof getCards>> = [];
  let payments: UpcomingPayment[] = [];
  let disputes: DisputeAlert[] = [];
  let prevSpending = 0;
  let loadError: string | null = null;
  try {
    [data, cards, payments, disputes, prevSpending] = await Promise.all([
      getDashboardData(filters), getCards(), getUpcomingPayments(), getDisputeAlerts(),
      getPeriodSpending(prevFilters),
    ]);
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }
  if (loadError || !data) {
    return (
      <>
        <h1>{t("title")}</h1>
        <p className="error-box">{tc("loadError", { message: loadError ?? "?" })}</p>
      </>
    );
  }

  const catName = (s: { name_en: string; name_zh: string | null; key: string }) =>
    s.key === "__uncategorised" ? t("uncategorised") : locale === "zh" && s.name_zh ? s.name_zh : s.name_en;

  const monthCount = data.months.length;
  const avg = monthCount > 0 ? data.totals.spending / monthCount : 0;

  // FR-17 comparison: this period's spending vs the equal-length prior window.
  // Spending UP is bad (red), DOWN is good (green).
  const spendDelta = prevSpending > 0
    ? { pct: ((data.totals.spending - prevSpending) / prevSpending) * 100, prev: prevSpending }
    : null;

  // ---------- outflow chart geometry (granularity-aware) ----------
  const periods = aggregatePeriods(data.months, granularity, locale);
  const PLOT_H = 220;
  const yMax = niceCeil(Math.max(1, ...periods.map((p) => Math.max(p.spending + p.fees, p.refunds))));
  const px = (v: number) => Math.round((v / yMax) * PLOT_H);
  const ticks = [0.25, 0.5, 0.75, 1].map((f) => yMax * f);
  const maxPeriod = periods.reduce(
    (best, p) => (p.spending + p.fees > best.spending + best.fees ? p : best),
    periods[0] ?? { spending: 0, fees: 0 } as Period,
  );

  // ---------- donut geometry: top 7 + Other ----------
  const TOP_N = 7;
  const topSlices = data.categories.slice(0, TOP_N);
  const tail = data.categories.slice(TOP_N);
  const tailTotal = tail.reduce((s, c) => s + c.total, 0);
  const donutTotal = data.totals.spending;
  interface Arc { label: string; value: number; color: string; href: string | null }
  const arcs: Arc[] = topSlices.map((s, i) => ({
    label: catName(s),
    value: s.total,
    color: s.key === "__uncategorised" ? UNCAT_COLOR : SLOTS[i]!,
    href: s.categoryId != null
      ? `/transactions?category=${s.categoryId}&from=${filters.from}&to=${filters.to}`
      : null,
  }));
  if (tailTotal > 0) arcs.push({ label: t("otherCategories", { count: tail.length }), value: tailTotal, color: SLOTS[7]!, href: null });

  const R = 84, HOLE = 52, CX = 100, CY = 100;
  let angle = -Math.PI / 2;
  const paths = arcs.map((a) => {
    const frac = donutTotal > 0 ? a.value / donutTotal : 0;
    const a0 = angle;
    const a1 = angle + frac * 2 * Math.PI;
    angle = a1;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (r: number, ang: number) => `${(CX + r * Math.cos(ang)).toFixed(2)} ${(CY + r * Math.sin(ang)).toFixed(2)}`;
    return {
      ...a,
      frac,
      d: `M ${p(R, a0)} A ${R} ${R} 0 ${large} 1 ${p(R, a1)} L ${p(HOLE, a1)} A ${HOLE} ${HOLE} 0 ${large} 0 ${p(HOLE, a0)} Z`,
    };
  });

  const util = data.utilization;
  const utilPct = util.totalLimit > 0 ? (util.totalClosing / util.totalLimit) * 100 : null;
  const meterColor =
    utilPct == null ? S_SPENDING
    : utilPct > 85 ? "var(--status-crit)"
    : utilPct > 60 ? "var(--status-warn)"
    : S_SPENDING;

  const qs = (over: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    for (const c of selectedCards) params.append("card", c);
    const merged = {
      from: filters.from, to: filters.to,
      ew: filters.ewallet ? undefined : "0",
      g: granularity === "month" ? undefined : granularity,
      ...over,
    };
    for (const [k, v] of Object.entries(merged)) if (v !== undefined) params.set(k, v);
    return params.toString();
  };

  return (
    <>
      <h1>{t("title")}</h1>
      <DetailsAutoClose />

      <form className="filters" action="/dashboard">
        <label>
          {t("filters.from")}
          <input type="date" name="from" defaultValue={filters.from} />
        </label>
        <label>
          {t("filters.to")}
          <input type="date" name="to" defaultValue={filters.to} />
        </label>
        <label>
          {t("filters.card")}
          {/* tick-box multi-select (owner request 2026-07-22): include/exclude
              cards for in-depth per-card analysis */}
          <details className="multiselect">
            <summary>
              {selectedCards.length === 0
                ? tc("all")
                : t("filters.cardsSelected", { count: selectedCards.length })}
            </summary>
            <div className="multiselect-options">
              <div className="ms-controls">
                <button type="button" data-ms-all>{tc("selectAll")}</button>
                <button type="button" data-ms-none>{tc("deselectAll")}</button>
              </div>
              {cards.map((c) => (
                <label key={c.id} className="multiselect-option">
                  <span>{cardLabel(c)}</span>
                  <input type="checkbox" name="card" value={String(c.id)}
                    defaultChecked={selectedCards.includes(String(c.id))} />
                </label>
              ))}
            </div>
          </details>
        </label>
        <label>
          {t("filters.ewallet")}
          <select name="ew" defaultValue={filters.ewallet ? "1" : "0"}>
            <option value="1">{t("filters.ewalletOn")}</option>
            <option value="0">{t("filters.ewalletOff")}</option>
          </select>
        </label>
        <label>
          {t("filters.granularity")}
          <select name="g" defaultValue={granularity}>
            <option value="month">{t("granularity.month")}</option>
            <option value="quarter">{t("granularity.quarter")}</option>
            <option value="year">{t("granularity.year")}</option>
          </select>
        </label>
        <button type="submit">{t("filters.apply")}</button>
        <a className="btn-secondary" href="/dashboard">{t("filters.reset")}</a>
        <a
          className="btn-secondary"
          href={`/dashboard/report?${qs({})}`}
          title={t("filters.reportTitle")}
        >
          {t("filters.report")}
        </a>
      </form>

      <div className="kpi-row">
        <div className="stat-tile hero">
          <div className="stat-label">{t("tiles.totalSpending")}</div>
          <div className="stat-value">{formatRM(data.totals.spending)}</div>
          {spendDelta && Math.abs(spendDelta.pct) >= 0.5 && (
            <div className={`stat-delta ${spendDelta.pct > 0 ? "bad" : "good"}`}>
              {spendDelta.pct > 0 ? "▲" : "▼"} {Math.abs(spendDelta.pct).toFixed(0)}%{" "}
              <span className="muted">{t("tiles.vsPrev")}</span>
            </div>
          )}
          {data.totals.ewallet > 0 && (
            <div className="stat-sub">{t("tiles.ewalletPart", { amount: formatRM(data.totals.ewallet) })}</div>
          )}
        </div>
        <div className="stat-tile">
          <div className="stat-label">{t("tiles.monthlyAverage")}</div>
          <div className="stat-value">{formatRM(avg)}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-label">{t("tiles.fees")}</div>
          <div className="stat-value">{formatRM(data.totals.fees)}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-label">{t("tiles.refunds")}</div>
          <div className="stat-value">{formatRM(data.totals.refunds)}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-label">{t("tiles.walletTransfers")}</div>
          <div className="stat-value">{formatRM(data.totals.walletTransfers)}</div>
          <div className="stat-sub">{t("tiles.walletNote")}</div>
        </div>
        {utilPct != null && (
          <div className="stat-tile">
            <div className="stat-label">{t("tiles.utilization")}</div>
            <div className="stat-value">{utilPct.toFixed(0)}%</div>
            <div className="meter" role="img" aria-label={`${utilPct.toFixed(0)}%`}>
              <div className="meter-fill" style={{ width: `${Math.min(100, utilPct)}%`, background: meterColor }} />
            </div>
            <div className="stat-sub">
              {t("tiles.utilizationDetail", { used: formatRM(util.totalClosing), limit: formatRM(util.totalLimit) })}
            </div>
          </div>
        )}
      </div>

      <DisputePanel alerts={disputes} />

      <PaymentsPanel payments={payments} />

      <section className="viz-card">
        <h2>{t("monthly.title")}</h2>
        <div className="legend">
          <span><i className="key" style={{ background: S_SPENDING }} />{t("monthly.spending")}</span>
          <span><i className="key" style={{ background: S_FEES }} />{t("monthly.fees")}</span>
          <span><i className="key" style={{ background: S_REFUNDS }} />{t("monthly.refunds")}</span>
        </div>
        <div className="columns-chart" style={{ height: PLOT_H + 28 }}>
          <div className="plot" style={{ height: PLOT_H }}>
            {ticks.map((v) => (
              <div key={v} className="gridline" style={{ bottom: px(v) }}>
                <span className="tick-label">{Math.round(v).toLocaleString()}</span>
              </div>
            ))}
            <div className="baseline" />
            <div className="bands">
              {periods.map((p, i) => {
                const title = p.sub ? `${p.label} ${p.sub}` : p.label;
                const tip = `${title}\n${t("monthly.spending")}: ${formatRM(p.spending)}\n${t("monthly.fees")}: ${formatRM(p.fees)}\n${t("monthly.refunds")}: ${formatRM(p.refunds)}`;
                return (
                  <a
                    key={`${p.from}-${i}`}
                    className="band"
                    data-tip={tip}
                    href={`/transactions?from=${p.from}&to=${p.to}`}
                  >
                    <div className="marks">
                      <div className="stack">
                        {p.fees > 0 && (
                          <div className="seg seg-top" style={{ height: Math.max(px(p.fees), 3), background: S_FEES }} />
                        )}
                        <div
                          className={p.fees > 0 ? "seg" : "seg seg-top"}
                          style={{ height: px(p.spending), background: S_SPENDING }}
                        />
                      </div>
                      {p.refunds > 0 && (
                        <div className="seg seg-top refund-col" style={{ height: Math.max(px(p.refunds), 3), background: S_REFUNDS }} />
                      )}
                    </div>
                    {p === maxPeriod && p.spending + p.fees > 0 && (
                      <span className="direct-label" style={{ bottom: px(p.spending + p.fees) + 4 }}>
                        {Math.round(p.spending + p.fees).toLocaleString()}
                      </span>
                    )}
                  </a>
                );
              })}
            </div>
          </div>
          <div className="month-labels">
            {periods.map((p, i) => (
              <span key={`${p.from}-${i}`} className="month-label">
                {p.label}
                {p.sub && <em>{p.sub}</em>}
              </span>
            ))}
          </div>
        </div>
        <details className="table-details">
          <summary>{t("monthly.tableToggle")}</summary>
          <table className="data mini">
            <thead>
              <tr>
                <th>{t("monthly.month")}</th>
                <th className="amount-cell">{t("monthly.spending")}</th>
                <th className="amount-cell">{t("monthly.fees")}</th>
                <th className="amount-cell">{t("monthly.refunds")}</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((p, i) => (
                <tr key={`${p.from}-${i}`}>
                  <td>{p.sub ? `${p.label} ${p.sub}` : p.label}</td>
                  <td className="amount-cell">{formatRM(p.spending)}</td>
                  <td className="amount-cell">{formatRM(p.fees)}</td>
                  <td className="amount-cell">{formatRM(p.refunds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>

      <section className="viz-card">
        <h2>{t("categories.title")}</h2>
        <div className="donut-row">
          <svg viewBox="0 0 200 200" className="donut" role="img" aria-label={t("categories.title")}>
            {paths.map((p) => {
              const shape = (
                <path d={p.d} fill={p.color} stroke="var(--surface, #fcfcfb)" strokeWidth="2">
                  <title>{`${p.label}: ${formatRM(p.value)} (${(p.frac * 100).toFixed(1)}%)`}</title>
                </path>
              );
              return p.href ? (
                <a key={p.label} href={p.href}>{shape}</a>
              ) : (
                <g key={p.label}>{shape}</g>
              );
            })}
            <text x={CX} y={CY - 4} textAnchor="middle" className="donut-center-value">
              {Math.round(donutTotal).toLocaleString()}
            </text>
            <text x={CX} y={CY + 14} textAnchor="middle" className="donut-center-label">
              {t("categories.centerLabel")}
            </text>
          </svg>
          <ul className="donut-legend">
            {paths.map((p) => (
              <li key={p.label}>
                <i className="key" style={{ background: p.color }} />
                {p.href ? <a href={p.href}>{p.label}</a> : <span>{p.label}</span>}
                <b>{formatRM(p.value)}</b>
                <span className="muted">{(p.frac * 100).toFixed(1)}%</span>
              </li>
            ))}
          </ul>
        </div>
        <details className="table-details" open={data.categories.length > TOP_N + 1}>
          <summary>{t("categories.tableToggle", { count: data.categories.length })}</summary>
          <table className="data mini">
            <thead>
              <tr>
                <th>{t("categories.category")}</th>
                <th className="amount-cell">{t("categories.amount")}</th>
                <th className="amount-cell">%</th>
              </tr>
            </thead>
            <tbody>
              {data.categories.map((s) => (
                <tr key={s.key}>
                  <td>
                    {s.categoryId != null ? (
                      <a href={`/transactions?${qs({ category: String(s.categoryId) })}`}>{catName(s)}</a>
                    ) : (
                      catName(s)
                    )}
                  </td>
                  <td className="amount-cell">{formatRM(s.total)}</td>
                  <td className="amount-cell">
                    {donutTotal > 0 ? ((s.total / donutTotal) * 100).toFixed(1) : "0.0"}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>
    </>
  );
}
