import { getTranslations } from "next-intl/server";
import { getSupabase } from "@/lib/supabase";
import { addCategory, renameCategory, deleteCategory } from "./category-actions";

/** Category management (owner request 2026-07-21): add / rename / delete.
 *  Delete is blocked while transactions or merchant rules use the category. */
export default async function CategorySection({ error }: { error: string | null }) {
  const t = await getTranslations("management.categories");
  const supabase = getSupabase();

  const catsQ = await supabase.from("categories")
    .select("id,name_en,name_zh,sort_order").is("user_id", null).order("sort_order");
  if (catsQ.error) return <p className="error-box">{catsQ.error.message}</p>;

  // usage counts so the UI can say which are deletable
  const counts = new Map<number, number>();
  for (let from = 0; ; from += 1000) {
    const page = await supabase.from("transactions")
      .select("category_id").not("category_id", "is", null).order("id").range(from, from + 999);
    if (page.error) break;
    for (const r of (page.data ?? []) as { category_id: number }[]) {
      counts.set(r.category_id, (counts.get(r.category_id) ?? 0) + 1);
    }
    if ((page.data ?? []).length < 1000) break;
  }

  return (
    <>
      {error && <p className="error-box">{t(`errors.${error}`)}</p>}
      <section className="panel">
        <h2>{t("listTitle")}</h2>
        <p className="inline-note">{t("note")}</p>
        {(catsQ.data ?? []).map((c) => (
          <div key={c.id} className="row-form">
            <form action={renameCategory} className="row-form cat-row">
              <input type="hidden" name="id" value={c.id} />
              <input type="text" name="name_en" defaultValue={c.name_en} className="grow" />
              <input type="text" name="name_zh" defaultValue={c.name_zh ?? ""} placeholder="中文" />
              <button type="submit" className="btn-secondary">{t("save")}</button>
            </form>
            <span className="muted nowrap">{t("used", { count: counts.get(c.id) ?? 0 })}</span>
            {(counts.get(c.id) ?? 0) === 0 && (
              <form action={deleteCategory}>
                <input type="hidden" name="id" value={c.id} />
                <button type="submit" className="btn-secondary danger">{t("delete")}</button>
              </form>
            )}
          </div>
        ))}
      </section>
      <section className="panel">
        <h2>{t("addTitle")}</h2>
        <form action={addCategory} className="row-form">
          <input type="text" name="name_en" required placeholder={t("nameEn")} className="grow" />
          <input type="text" name="name_zh" placeholder="中文（可选）" />
          <button type="submit" className="btn">{t("add")}</button>
        </form>
      </section>
    </>
  );
}
