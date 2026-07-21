import { getTranslations } from "next-intl/server";
import { getSupabase } from "@/lib/supabase";
import { formatRM } from "@/lib/format";

/** Phase 4: per-user API cost view + backup/export-all (spec settings). */
export default async function SystemSection() {
  const t = await getTranslations("system");

  let totalUsd = 0, totalRm = 0, calls = 0;
  const byPurpose = new Map<string, { calls: number; usd: number }>();
  try {
    const supabase = getSupabase();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("api_cost_log")
        .select("purpose,est_cost_usd,est_cost_rm")
        .order("id")
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as { purpose: string; est_cost_usd: number; est_cost_rm: number }[]) {
        calls++;
        totalUsd += Number(r.est_cost_usd);
        totalRm += Number(r.est_cost_rm);
        const p = byPurpose.get(r.purpose) ?? { calls: 0, usd: 0 };
        p.calls++;
        p.usd += Number(r.est_cost_usd);
        byPurpose.set(r.purpose, p);
      }
      if ((data ?? []).length < 1000) break;
    }
  } catch {
    return null; // cost log unavailable — hide rather than break settings
  }

  return (
    <>
      <section className="panel">
        <h2>{t("apiCosts.title")}</h2>
        <p className="muted">
          {t("apiCosts.total", { calls, usd: totalUsd.toFixed(2), rm: formatRM(totalRm) })}
        </p>
        <table className="data mini api-costs">
          <thead>
            <tr>
              <th>{t("apiCosts.purpose")}</th>
              <th className="amount-cell">{t("apiCosts.calls")}</th>
              <th className="amount-cell">USD</th>
            </tr>
          </thead>
          <tbody>
            {[...byPurpose.entries()].sort((a, b) => b[1].usd - a[1].usd).map(([purpose, v]) => (
              <tr key={purpose}>
                <td>{purpose}</td>
                <td className="amount-cell">{v.calls}</td>
                <td className="amount-cell">{v.usd.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>{t("backup.title")}</h2>
        <p className="inline-note">{t("backup.note")}</p>
        <a className="btn" href="/onboarding/backup" download>
          {t("backup.download")}
        </a>
      </section>
    </>
  );
}
