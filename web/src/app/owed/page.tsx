import { getTranslations } from "next-intl/server";
import { getOnBehalfData, type OnBehalfData } from "@/lib/onbehalf-data";
import { formatRM } from "@/lib/format";
import { setOnBehalfParty, setOnBehalfStatus } from "./actions";

export const dynamic = "force-dynamic";

/** FR-21 "Owed to me": outstanding Paying-on-Behalf spend totalled per person,
 *  with one-tap mark-as-repaid and a "for whom" field on each item. */
export default async function OwedPage() {
  const t = await getTranslations("owed");
  const tc = await getTranslations("common");

  let data: OnBehalfData | null = null;
  let loadError: string | null = null;
  try {
    data = await getOnBehalfData();
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }
  if (loadError || !data) {
    return (<><h1>{t("title")}</h1><p className="error-box">{tc("loadError", { message: loadError ?? "?" })}</p></>);
  }

  const outstanding = data.items.filter((i) => i.status !== "repaid");
  const repaid = data.items.filter((i) => i.status === "repaid");

  return (
    <>
      <h1>{t("title")}</h1>

      {data.items.length === 0 ? (
        <p className="inline-note">{t("empty")}</p>
      ) : (
        <>
          <div className="kpi-row">
            <div className="stat-tile hero">
              <div className="stat-label">{t("tiles.outstanding")}</div>
              <div className="stat-value">{formatRM(data.totalOutstanding)}</div>
              <div className="stat-sub">{t("tiles.outstandingNote", { count: outstanding.length })}</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">{t("tiles.repaid")}</div>
              <div className="stat-value">{formatRM(data.totalRepaid)}</div>
            </div>
          </div>

          {data.perPerson.length > 0 && (
            <section className="viz-card">
              <h2>{t("perPerson")}</h2>
              <ul className="owed-people">
                {data.perPerson.map((p) => (
                  <li key={p.party || "__none"}>
                    <span className="owed-name">{p.party || t("unassigned")}</span>
                    <span className="muted">{t("itemCount", { count: p.count })}</span>
                    <b>{formatRM(p.outstanding)}</b>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="viz-card">
            <h2>{t("outstandingTitle")}</h2>
            {outstanding.length === 0 ? (
              <p className="muted">{t("allRepaid")}</p>
            ) : (
              <div className="table-wrap">
                <table className="data mini owed-table">
                  <thead>
                    <tr>
                      <th>{t("cols.date")}</th>
                      <th>{t("cols.description")}</th>
                      <th className="amount-cell">{t("cols.amount")}</th>
                      <th>{t("cols.forWhom")}</th>
                      <th>{t("cols.action")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outstanding.map((it) => (
                      <tr key={it.id}>
                        <td className="nowrap">{it.txnDate}</td>
                        <td><span className="desc-raw">{it.description}</span><div className="stat-sub">{it.cardLabel}</div></td>
                        <td className="amount-cell">{formatRM(it.amount)}</td>
                        <td>
                          <form action={setOnBehalfParty} className="party-form">
                            <input type="hidden" name="txnId" value={it.id} />
                            <input type="text" name="party" defaultValue={it.party ?? ""}
                              placeholder={t("forWhomPlaceholder")} className="party-input" />
                            <button type="submit" className="btn-secondary dismiss-btn">{t("save")}</button>
                          </form>
                        </td>
                        <td>
                          <form action={setOnBehalfStatus}>
                            <input type="hidden" name="txnId" value={it.id} />
                            <input type="hidden" name="repaid" value="1" />
                            <button type="submit" className="btn">{t("markRepaid")}</button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {repaid.length > 0 && (
            <section className="viz-card">
              <h2>{t("repaidTitle")}</h2>
              <div className="table-wrap">
                <table className="data mini owed-table">
                  <thead>
                    <tr>
                      <th>{t("cols.date")}</th>
                      <th>{t("cols.description")}</th>
                      <th className="amount-cell">{t("cols.amount")}</th>
                      <th>{t("cols.forWhom")}</th>
                      <th>{t("cols.repaidOn")}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {repaid.map((it) => (
                      <tr key={it.id}>
                        <td className="nowrap">{it.txnDate}</td>
                        <td><span className="desc-raw">{it.description}</span></td>
                        <td className="amount-cell">{formatRM(it.amount)}</td>
                        <td>{it.party || t("unassigned")}</td>
                        <td className="nowrap">{it.repaidAt ? it.repaidAt.slice(0, 10) : "—"}</td>
                        <td>
                          <form action={setOnBehalfStatus}>
                            <input type="hidden" name="txnId" value={it.id} />
                            <input type="hidden" name="repaid" value="0" />
                            <button type="submit" className="btn-secondary dismiss-btn">{t("undo")}</button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}
