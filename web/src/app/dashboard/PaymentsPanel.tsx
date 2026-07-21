import { getTranslations } from "next-intl/server";
import type { UpcomingPayment } from "@/lib/payments-data";
import { formatRM } from "@/lib/format";
import { recordPayment } from "./actions";

/** FR-9 Upcoming Payments panel. Color coding per spec: green >7 days,
 *  amber <=7, red <=2 or overdue — status palette, always icon + label,
 *  never color alone. */
export default async function PaymentsPanel({ payments }: { payments: UpcomingPayment[] }) {
  const t = await getTranslations("payments");

  if (payments.length === 0) return null;

  const urgency = (p: UpcomingPayment): { cls: string; icon: string; label: string } => {
    if (p.status !== "unpaid") {
      return {
        cls: "ok",
        icon: "✓",
        label:
          p.status === "paid_full" ? t("status.paidFull")
          : p.status === "paid_minimum" ? t("status.paidMinimum")
          : t("status.paidOther"),
      };
    }
    if (p.daysRemaining < 0) return { cls: "critical", icon: "!", label: t("status.overdue", { days: -p.daysRemaining }) };
    if (p.daysRemaining <= 2) return { cls: "critical", icon: "!", label: t("status.dueIn", { days: p.daysRemaining }) };
    if (p.daysRemaining <= 7) return { cls: "warning", icon: "▲", label: t("status.dueIn", { days: p.daysRemaining }) };
    return { cls: "ok", icon: "✓", label: t("status.dueIn", { days: p.daysRemaining }) };
  };

  return (
    <section className="viz-card">
      <h2>{t("title")}</h2>
      <div className="table-wrap">
        <table className="data mini payments">
          <thead>
            <tr>
              <th>{t("card")}</th>
              <th className="amount-cell">{t("balance")}</th>
              <th className="amount-cell">{t("minimum")}</th>
              <th>{t("dueDate")}</th>
              <th>{t("statusHead")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => {
              const u = urgency(p);
              return (
                <tr key={p.cycleId}>
                  <td className="nowrap">{p.cardLabel}</td>
                  <td className="amount-cell">{formatRM(p.statementBalance)}</td>
                  <td className="amount-cell">{p.minimumDue != null ? formatRM(p.minimumDue) : "—"}</td>
                  <td className="nowrap">{p.dueDate}</td>
                  <td>
                    <span className={`status-chip ${u.cls}`}>
                      <i aria-hidden="true">{u.icon}</i> {u.label}
                    </span>
                    {p.status !== "unpaid" && (p.autoDetected || p.recordedAt != null) && (
                      <div className="stat-sub">
                        {formatRM(p.amountPaid)}{" "}
                        {p.autoDetected ? t("autoDetected") : t("manualRecorded")}
                      </div>
                    )}
                  </td>
                  <td>
                    {p.status === "unpaid" && (
                      <details className="record-payment">
                        <summary className="btn">{t("record.button")}</summary>
                        <form action={recordPayment} className="record-form">
                          <input type="hidden" name="cycleId" value={p.cycleId} />
                          {/* Full payment: pre-selected, visually primary (spec) */}
                          <label className="option primary">
                            <input type="radio" name="mode" value="full" defaultChecked />
                            {t("record.full")} · {formatRM(p.statementBalance)}
                          </label>
                          {p.minimumDue != null && (
                            <label className="option">
                              <input type="radio" name="mode" value="minimum" />
                              {t("record.minimum")} · {formatRM(p.minimumDue)}
                            </label>
                          )}
                          <label className="option">
                            <input type="radio" name="mode" value="other" />
                            {t("record.other")}
                            <input type="number" name="amount" min="0.01" step="0.01" placeholder="RM" />
                          </label>
                          <p className="interest-note">{t("record.interestNote")}</p>
                          <button type="submit" className="btn">{t("record.save")}</button>
                        </form>
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
