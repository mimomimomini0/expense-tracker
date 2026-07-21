import { getTranslations } from "next-intl/server";
import { getRecurrences, monthlyCommitment, type Recurrence } from "@/lib/recurring-data";
import { formatRM } from "@/lib/format";

export const dynamic = "force-dynamic";

/** FR-19 Active Subscriptions view: monthly-cadence merchants detected from
 *  the statements — fixed-price subscriptions (with price-change flags) and
 *  variable recurring bills, plus the total monthly recurring commitment. */
export default async function SubscriptionsPage() {
  const t = await getTranslations("subscriptions");
  const tc = await getTranslations("common");

  let recs: Recurrence[] = [];
  let loadError: string | null = null;
  try {
    recs = await getRecurrences();
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

  const stable = recs.filter((r) => r.amountStable);
  const variable = recs.filter((r) => !r.amountStable);
  const activeStable = stable.filter((r) => r.active);
  const commitment = monthlyCommitment(recs);

  const rm = (sen: number) => formatRM(sen / 100);

  const table = (rows: Recurrence[], emptyKey: string) =>
    rows.length === 0 ? (
      <p className="muted">{t(emptyKey)}</p>
    ) : (
      <div className="table-wrap">
        <table className="data mini subs">
          <thead>
            <tr>
              <th>{t("cols.merchant")}</th>
              <th className="amount-cell">{t("cols.amount")}</th>
              <th>{t("cols.cadence")}</th>
              <th>{t("cols.charges")}</th>
              <th>{t("cols.period")}</th>
              <th>{t("cols.status")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>
                  {/* merchant descriptors — never translated */}
                  <a className="desc-raw" href={`/transactions?merchant=${encodeURIComponent(r.displayName)}`}>
                    {r.displayName}
                  </a>
                  {r.priceChange && (
                    <div className="chips">
                      <span className="chip pending">
                        {t("priceChange", { from: rm(r.priceChange.from), to: rm(r.priceChange.to) })}
                      </span>
                    </div>
                  )}
                </td>
                <td className="amount-cell">{rm(r.typicalAmount)}</td>
                <td className="nowrap">{t("cadence", { days: r.cadenceDays })}</td>
                <td>{r.occurrences}</td>
                <td className="nowrap">{r.firstSeen} — {r.lastSeen}</td>
                <td>
                  <span className={`status-chip ${r.active ? "ok" : ""}`}>
                    {r.active ? "✓ " : ""}{r.active ? t("active") : t("ended")}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <>
      <h1>{t("title")}</h1>

      <div className="kpi-row">
        <div className="stat-tile hero">
          <div className="stat-label">{t("tiles.commitment")}</div>
          <div className="stat-value">{rm(commitment)}</div>
          <div className="stat-sub">{t("tiles.commitmentNote", { count: activeStable.length })}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-label">{t("tiles.detected")}</div>
          <div className="stat-value">{recs.length}</div>
          <div className="stat-sub">{t("tiles.detectedNote")}</div>
        </div>
      </div>

      <p className="inline-note">{t("gapNote")}</p>

      <section className="viz-card">
        <h2>{t("sections.subscriptions")}</h2>
        {table(stable, "emptySubs")}
      </section>

      <section className="viz-card">
        <h2>{t("sections.variable")}</h2>
        <p className="inline-note">{t("variableNote")}</p>
        {table(variable, "emptyVariable")}
      </section>
    </>
  );
}
