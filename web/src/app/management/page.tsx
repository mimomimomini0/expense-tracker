import { getLocale, getTranslations } from "next-intl/server";
import { getSupabase } from "@/lib/supabase";
import QueueSection from "./QueueSection";
import MerchantBoard, { type BoardColumn } from "./MerchantBoard";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const normalize = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();

/** Management tab (owner request 2026-07-21): the group-confirmation queue
 *  plus the merchants-by-category board with drag recategorisation. */
export default async function ManagementPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const rawTab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab = rawTab === "merchants" ? "merchants" : "confirm";

  const locale = await getLocale();
  const t = await getTranslations("management");
  const tc = await getTranslations("common");

  let board: BoardColumn[] = [];
  let loadError: string | null = null;
  if (tab === "merchants") {
    try {
      board = await buildBoard(locale);
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <>
      <h1>{t("title")}</h1>
      <nav className="subtabs">
        <a className={tab === "confirm" ? "active" : ""} href="/management?tab=confirm">
          {t("tabs.confirm")}
        </a>
        <a className={tab === "merchants" ? "active" : ""} href="/management?tab=merchants">
          {t("tabs.merchants")}
        </a>
      </nav>

      {tab === "confirm" ? (
        <QueueSection />
      ) : loadError ? (
        <p className="error-box">{tc("loadError", { message: loadError })}</p>
      ) : (
        <MerchantBoard columns={board} />
      )}
    </>
  );
}

async function buildBoard(locale: string): Promise<BoardColumn[]> {
  const supabase = getSupabase();
  const [catsQ, rulesQ] = await Promise.all([
    supabase.from("categories").select("id,name_en,name_zh,sort_order").is("user_id", null).order("sort_order"),
    supabase.from("merchant_rules").select("merchant_pattern,category_id,confirmed_at"),
  ]);
  if (catsQ.error) throw new Error(catsQ.error.message);
  if (rulesQ.error) throw new Error(rulesQ.error.message);

  // per-rule transaction counts, longest-pattern-wins (mirrors the engine)
  const patterns = (rulesQ.data ?? []).map((r) => normalize(r.merchant_pattern as string));
  const counts = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    const page = await supabase.from("transactions").select("description_raw").order("id").range(from, from + 999);
    if (page.error) throw new Error(page.error.message);
    for (const row of (page.data ?? []) as { description_raw: string }[]) {
      const d = normalize(row.description_raw);
      const best = patterns.filter((p) => d.startsWith(p)).sort((a, b) => b.length - a.length)[0];
      if (best) counts.set(best, (counts.get(best) ?? 0) + 1);
    }
    if ((page.data ?? []).length < 1000) break;
  }

  return (catsQ.data ?? []).map((c) => ({
    id: c.id as number,
    name: locale === "zh" && c.name_zh ? (c.name_zh as string) : (c.name_en as string),
    merchants: (rulesQ.data ?? [])
      .filter((r) => r.category_id === c.id)
      .map((r) => ({
        pattern: r.merchant_pattern as string,
        count: counts.get(normalize(r.merchant_pattern as string)) ?? 0,
        confirmed: r.confirmed_at != null,
      }))
      .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern)),
  }));
}
