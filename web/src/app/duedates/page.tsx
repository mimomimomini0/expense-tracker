import { getLocale, getTranslations } from "next-intl/server";
import {
  getDueDatesInRange, getUpcomingPayments, klToday,
  type DueDateEntry, type UpcomingPayment,
} from "@/lib/payments-data";
import { formatRM } from "@/lib/format";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** "Payment due dates" tab (owner request 2026-07-21): a month calendar with
 *  each card's due date marked, beside the per-card due list. All date
 *  arithmetic in Asia/Kuala_Lumpur. Weeks start Monday. */
export default async function DueDatesPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const locale = await getLocale();
  const t = await getTranslations("duedates");
  const tp = await getTranslations("payments");
  const tc = await getTranslations("common");

  const today = klToday(); // YYYY-MM-DD
  const rawMonth = Array.isArray(sp.month) ? sp.month[0] : sp.month;
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(rawMonth ?? "") ? rawMonth! : today.slice(0, 7);
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const firstIso = `${month}-01`;
  const lastIso = `${month}-${String(daysInMonth).padStart(2, "0")}`;
  // Monday-start offset: getUTCDay() 0=Sun..6=Sat -> 0=Mon..6=Sun
  const leading = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;

  let entries: DueDateEntry[] = [];
  let list: UpcomingPayment[] = [];
  let loadError: string | null = null;
  try {
    [entries, list] = await Promise.all([
      getDueDatesInRange(firstIso, lastIso),
      getUpcomingPayments(),
    ]);
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }
  if (loadError) {
    return (
      <>
        <h1>{t("title")}</h1>
        <p className="error-box">{tc("loadError", { message: loadError })}</p>
      </>
    );
  }

  const byDay = new Map<number, DueDateEntry[]>();
  for (const e of entries) {
    const d = Number(e.dueDate.slice(8, 10));
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(e);
  }

  const chipClass = (e: DueDateEntry) =>
    e.status !== "unpaid" ? "ok" : e.daysRemaining < 0 ? "critical" : e.daysRemaining <= 7 ? "warning" : "upcoming";

  const dtLocale = locale === "zh" ? "zh-CN" : "en-MY";
  const monthTitle = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(dtLocale, {
    year: "numeric", month: "long", timeZone: "UTC",
  });
  // Mon..Sun headers, localized
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(dtLocale, { weekday: "short", timeZone: "UTC" }),
  );

  const cells: (number | null)[] = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const statusLabel = (p: UpcomingPayment) =>
    p.status === "paid_full" ? tp("status.paidFull")
    : p.status === "paid_minimum" ? tp("status.paidMinimum")
    : p.status === "paid_other" ? tp("status.paidOther")
    : p.daysRemaining < 0 ? tp("status.overdue", { days: -p.daysRemaining })
    : tp("status.dueIn", { days: p.daysRemaining });

  return (
    <>
      <h1>{t("title")}</h1>
      <div className="duedates-layout">
        <section className="viz-card calendar-card">
          <div className="calendar-head">
            <a className="btn-secondary" href={`/duedates?month=${prev}`}>←</a>
            <h2>{monthTitle}</h2>
            <a className="btn-secondary" href={`/duedates?month=${next}`}>→</a>
          </div>
          <div className="calendar-grid">
            {weekdays.map((w) => (
              <div key={w} className="cal-weekday">{w}</div>
            ))}
            {cells.map((day, i) => {
              if (day == null) return <div key={`e${i}`} className="cal-cell empty" />;
              const iso = `${month}-${String(day).padStart(2, "0")}`;
              const dues = byDay.get(day) ?? [];
              return (
                <div key={iso} className={`cal-cell${iso === today ? " today" : ""}`}>
                  <span className="cal-day">{day}</span>
                  {dues.map((e) => (
                    <span key={e.cycleId} className={`due-chip ${chipClass(e)}`}
                      title={`${e.cardLabel} · ${formatRM(e.statementBalance)}`}>
                      {e.cardLabel.replace(/\s*••/, " ••")}
                      <b>{formatRM(e.statementBalance)}</b>
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
          <p className="muted cal-legend">
            <span className="due-chip ok">{t("legend.settled")}</span>
            <span className="due-chip upcoming">{t("legend.upcoming")}</span>
            <span className="due-chip warning">{t("legend.soon")}</span>
            <span className="due-chip critical">{t("legend.overdue")}</span>
          </p>
        </section>

        <section className="viz-card duelist-card">
          <h2>{t("listTitle")}</h2>
          {list.length === 0 ? (
            <p className="muted">{t("empty")}</p>
          ) : (
            <ul className="due-list">
              {list.map((p) => (
                <li key={p.cycleId}>
                  <div className="due-card-label">{p.cardLabel}</div>
                  <div className="due-line">
                    <span className="nowrap">{p.dueDate}</span>
                    <b>{formatRM(p.statementBalance)}</b>
                  </div>
                  <span className={`status-chip ${p.status !== "unpaid" ? "ok" : p.daysRemaining <= 2 ? "critical" : p.daysRemaining <= 7 ? "warning" : "ok"}`}>
                    {statusLabel(p)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="stat-sub">{t("listNote")}</p>
        </section>
      </div>
    </>
  );
}
