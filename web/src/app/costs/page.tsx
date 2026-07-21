import { getTranslations } from "next-intl/server";
import { getSupabase } from "@/lib/supabase";
import { formatRM } from "@/lib/format";
// pure engine, imported directly (same pattern as recurring/flags)
import {
  summarizeFees, trackTiers, type FeeRow, type TierPoint,
} from "../../../../src/cost-of-credit";

export const dynamic = "force-dynamic";

/** FR-20: "what your cards cost you" + printed interest-tier history with
 *  worsening alerts. */
export default async function CostsPage() {
  const t = await getTranslations("costs");
  const tc = await getTranslations("common");

  const supabase = getSupabase();
  let fees: FeeRow[] = [];
  const tiers: TierPoint[] = [];
  const labels = new Map<number, string>();
  let loadError: string | null = null;
  try {
    const cardsQ = await supabase.from("card_accounts").select("id,last4,display_name,banks(name)");
    if (cardsQ.error) throw new Error(cardsQ.error.message);
    for (const c of (cardsQ.data ?? []) as unknown as { id: number; last4: string; display_name: string | null; banks: { name: string } | null }[]) {
      labels.set(c.id, c.display_name ?? `${c.banks?.name ?? "?"} ••${c.last4}`);
    }
    const feeQ = await supabase.from("transactions")
      .select("card_account_id,txn_date,description_raw,amount_rm")
      .eq("txn_type", "fee_interest").order("id");
    if (feeQ.error) throw new Error(feeQ.error.message);
    fees = ((feeQ.data ?? []) as unknown as { card_account_id: number; txn_date: string; description_raw: string; amount_rm: number }[])
      .map((r) => ({
        cardId: r.card_account_id, date: r.txn_date,
        amount: Math.round(Number(r.amount_rm) * 100), description: r.description_raw,
      }));
    const scQ = await supabase.from("statement_cards")
      .select("card_account_id,statement_date,retail_interest_rate")
      .not("retail_interest_rate", "is", null).order("statement_date");
    if (scQ.error) throw new Error(scQ.error.message);
    for (const r of (scQ.data ?? []) as unknown as { card_account_id: number; statement_date: string; retail_interest_rate: number }[]) {
      tiers.push({ cardId: r.card_account_id, statementDate: r.statement_date, rate: Number(r.retail_interest_rate) });
    }
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }
  if (loadError) {
    return (<><h1>{t("title")}</h1><p className="error-box">{tc("loadError", { message: loadError })}</p></>);
  }

  const s = summarizeFees(fees);
  const th = trackTiers(tiers);
  const thisYear = new Date().getFullYear().toString();
  const yearTotal = s.byYear.find((y) => y.year === thisYear)?.total ?? 0;
  const years = s.byYear.map((y) => y.year);
  const worsenedCards = th.filter((x) => x.latestWorsened);
  const rm = (sen: number) => formatRM(sen / 100);

  return (
    <>
      <h1>{t("title")}</h1>

      {worsenedCards.length > 0 && (
        <p className="error-box">
          {t("worsenedAlert", {
            cards: worsenedCards.map((w) => labels.get(w.cardId) ?? w.cardId).join(", "),
          })}
        </p>
      )}

      <div className="kpi-row">
        <div className="stat-tile hero">
          <div className="stat-label">{t("tiles.allTime")}</div>
          <div className="stat-value">{rm(s.total)}</div>
          <div className="stat-sub">{t("tiles.rows", { count: s.count })}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-label">{t("tiles.thisYear", { year: thisYear })}</div>
          <div className="stat-value">{rm(yearTotal)}</div>
        </div>
      </div>

      <section className="viz-card">
        <h2>{t("byCard.title")}</h2>
        <div className="table-wrap">
          <table className="data mini">
            <thead>
              <tr>
                <th>{t("byCard.card")}</th>
                {years.map((y) => (<th key={y} className="amount-cell">{y}</th>))}
                <th className="amount-cell">{t("byCard.total")}</th>
              </tr>
            </thead>
            <tbody>
              {s.byCard.map((c) => (
                <tr key={c.cardId}>
                  <td className="nowrap">{labels.get(c.cardId) ?? c.cardId}</td>
                  {years.map((y) => (
                    <td key={y} className="amount-cell">{c.byYear[y] ? rm(c.byYear[y]!) : "—"}</td>
                  ))}
                  <td className="amount-cell"><b>{rm(c.total)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="stat-sub">{t("byCard.note")}</p>
      </section>

      <section className="viz-card">
        <h2>{t("tiers.title")}</h2>
        <p className="inline-note">{t("tiers.note")}</p>
        <div className="table-wrap">
          <table className="data mini">
            <thead>
              <tr>
                <th>{t("byCard.card")}</th>
                <th>{t("tiers.current")}</th>
                <th>{t("tiers.range")}</th>
                <th>{t("tiers.points")}</th>
                <th>{t("tiers.status")}</th>
              </tr>
            </thead>
            <tbody>
              {th.map((x) => {
                const rates = x.history.map((h) => h.rate);
                const latest = x.history[x.history.length - 1]!;
                return (
                  <tr key={x.cardId}>
                    <td className="nowrap">{labels.get(x.cardId) ?? x.cardId}</td>
                    <td>{latest.rate.toFixed(2)}%</td>
                    <td className="nowrap">{Math.min(...rates).toFixed(2)}–{Math.max(...rates).toFixed(2)}%</td>
                    <td>{x.history.length}</td>
                    <td>
                      <span className={`status-chip ${x.latestWorsened ? "critical" : "ok"}`}>
                        <i aria-hidden="true">{x.latestWorsened ? "!" : "✓"}</i>{" "}
                        {x.latestWorsened ? t("tiers.worsened") : t("tiers.steady")}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
