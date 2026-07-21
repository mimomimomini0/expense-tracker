import { getLocale, getTranslations } from "next-intl/server";
import { getCategories, getQueueTransactions, type TxnRow } from "@/lib/data";
import { formatDate, formatRM } from "@/lib/format";
import { merchantKey } from "@/lib/merchant-key";
import GroupConfirm from "../queue/GroupConfirm";

const SAMPLE_SIZE = 3;

export default async function QueueSection() {
  const locale = await getLocale();
  const t = await getTranslations("queue");
  const tc = await getTranslations("common");

  let rows: TxnRow[] = [];
  let categories: Awaited<ReturnType<typeof getCategories>> = [];
  let loadError: string | null = null;
  try {
    [rows, categories] = await Promise.all([
      getQueueTransactions(),
      getCategories()
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

  const categoryOptions = categories.map((c) => ({
    id: c.id,
    name: locale === "zh" && c.name_zh ? c.name_zh : c.name_en
  }));

  // Group by merchant key (uppercase, whitespace collapsed, trailing 2-letter
  // country token stripped).
  const groups = new Map<string, TxnRow[]>();
  for (const row of rows) {
    const key = merchantKey(row.description_raw);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  const groupList = [...groups.entries()]
    .map(([key, members]) => {
      // FR-7: a low-confidence LLM suggestion stays queued WITH its
      // recommendation (category_id + confidence written by the suggester
      // script). Surface the highest-confidence one as the preselection.
      const suggested = members
        .filter((r) => r.category_id != null && r.confidence != null)
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
      return {
        key,
        members,
        suggestion: suggested
          ? { id: suggested.category_id!, confidence: suggested.confidence! }
          : null,
        total: members.reduce(
          (sum, r) =>
            sum + (r.direction === "credit" ? -r.amount_rm : r.amount_rm),
          0
        )
      };
    })
    .sort((a, b) => b.members.length - a.members.length || a.key.localeCompare(b.key));

  return (
    <>
      <h1>{t("title")}</h1>
      <p className="inline-note">{t("intro")}</p>
      <p className="muted">{t("groups", { count: groupList.length })}</p>

      {groupList.length === 0 ? (
        <p className="muted">{t("empty")}</p>
      ) : (
        groupList.map((group) => (
          <section className="queue-group" key={group.key}>
            {/* merchant key derives from raw descriptions â€” never translated */}
            <div className="merchant">{group.key}</div>
            <div className="group-meta">
              <span>{t("rows", { count: group.members.length })}</span>
              <span>
                {t("total")}: {formatRM(group.total)}
              </span>
            </div>
            <div className="muted" style={{ fontSize: "0.78rem" }}>
              {t("sample")}
            </div>
            <ul className="queue-samples">
              {group.members.slice(0, SAMPLE_SIZE).map((row) => (
                <li key={row.id}>
                  <span className="nowrap">{formatDate(row.txn_date)}</span>
                  <span className="desc-raw">{row.description_raw}</span>
                  <span
                    className={
                      row.direction === "credit" ? "amount credit" : "amount"
                    }
                  >
                    {row.direction === "credit" ? "âˆ’" : ""}
                    {formatRM(row.amount_rm)}
                  </span>
                </li>
              ))}
            </ul>
            <GroupConfirm
              groupKey={group.key}
              categoryOptions={categoryOptions}
              suggestion={group.suggestion}
            />
          </section>
        ))
      )}
    </>
  );
}

