import { getTranslations } from "next-intl/server";
import { getAliasMap, aliasesAvailable } from "@/lib/aliases";
import { getRawMerchantList } from "@/lib/data";
import { mergeMerchants, renameAlias, removeAliasMember } from "./alias-actions";

/** Merge & rename merchants (owner request 2026-07-21): terminal-name
 *  variants (CB&TL / CBTL / MYCBTL) collapse under one canonical name.
 *  Read-time mapping — reversible, applies to future imports. */
export default async function AliasSection() {
  const t = await getTranslations("management.aliases");

  if (!(await aliasesAvailable())) {
    return <p className="notice">{t("schemaMissing")}</p>;
  }

  const [aliases, raw] = await Promise.all([getAliasMap(), getRawMerchantList()]);
  const groups = new Map<string, { key: string; count: number }[]>();
  for (const [key, canonical] of aliases) {
    if (!groups.has(canonical)) groups.set(canonical, []);
    groups.get(canonical)!.push({ key, count: raw.find((r) => r.key === key)?.count ?? 0 });
  }
  const unaliased = raw.filter((r) => !aliases.has(r.key));

  return (
    <>
      <section className="panel">
        <h2>{t("existingTitle")}</h2>
        {groups.size === 0 ? (
          <p className="muted">{t("noneYet")}</p>
        ) : (
          [...groups.entries()].map(([canonical, members]) => (
            <div key={canonical} className="alias-group">
              <form action={renameAlias} className="row-form">
                <input type="hidden" name="from" value={canonical} />
                {/* canonical names derive from merchant descriptors — never translated */}
                <input type="text" name="to" defaultValue={canonical} className="grow" />
                <button type="submit" className="btn-secondary">{t("rename")}</button>
              </form>
              <ul className="alias-members">
                {members.map((m) => (
                  <li key={m.key}>
                    <span className="desc-raw">{m.key}</span>
                    <span className="muted">{m.count}</span>
                    <form action={removeAliasMember}>
                      <input type="hidden" name="key" value={m.key} />
                      <button type="submit" className="chip-x" aria-label={t("remove")}>×</button>
                    </form>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      <section className="panel">
        <h2>{t("createTitle")}</h2>
        <p className="inline-note">{t("createNote")}</p>
        <form action={mergeMerchants} className="merge-form">
          <label className="stack-label">
            {t("canonical")}
            <input type="text" name="canonical" required placeholder="CBTL" />
          </label>
          <div className="merge-list">
            {unaliased.map((m) => (
              <label key={m.key} className="multiselect-option">
                <span className="desc-raw">{m.key}</span>
                <span className="muted">{m.count}</span>
                <input type="checkbox" name="member" value={m.key} />
              </label>
            ))}
          </div>
          <button type="submit" className="btn">{t("merge")}</button>
        </form>
      </section>
    </>
  );
}
