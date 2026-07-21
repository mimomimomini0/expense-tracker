import { getTranslations } from "next-intl/server";
import type { DisputeAlert } from "@/lib/flags-data";
import { formatRM } from "@/lib/format";
import { dismissDisputeFlag } from "./actions";

/** FR-18: "Dispute window closes [date] — review flagged items now."
 *  Rendered only while at least one statement's 14-day window is open. */
export default async function DisputePanel({ alerts }: { alerts: DisputeAlert[] }) {
  const t = await getTranslations("dispute");
  if (alerts.length === 0) return null;

  return (
    <section className="viz-card dispute-card">
      <h2>{t("title")}</h2>
      {alerts.map((a) => (
        <div key={a.statementId} className="dispute-stmt">
          <p className={`dispute-deadline ${a.daysLeft <= 2 ? "critical" : "warning"}`}>
            <i aria-hidden="true">{a.daysLeft <= 2 ? "!" : "▲"}</i>{" "}
            {t("deadline", { statement: a.statementDate, deadline: a.deadline, days: a.daysLeft })}
          </p>
          {a.flagged.length === 0 ? (
            <p className="muted">{t("nothingFlagged")}</p>
          ) : (
            <ul className="dispute-list">
              {a.flagged.map((f) => (
                <li key={f.id}>
                  <span className="nowrap">{f.txnDate}</span>
                  {/* raw descriptions — never translated */}
                  <span className="desc-raw">{f.description}</span>
                  <span className="amount">{formatRM(f.amount / 100)}</span>
                  <span className="chips">
                    {f.reasons.map((r) => (
                      <span key={r} className="chip pending">{t(`reasons.${r}`)}</span>
                    ))}
                  </span>
                  <form action={dismissDisputeFlag} className="dismiss-form">
                    <input type="hidden" name="txnId" value={f.id} />
                    <button type="submit" className="btn-secondary dismiss-btn">
                      {t("dismiss")}
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      <p className="stat-sub">{t("note")}</p>
    </section>
  );
}
