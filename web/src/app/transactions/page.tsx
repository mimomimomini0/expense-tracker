import { getLocale, getTranslations } from "next-intl/server";
import {
  buildTagOptions,
  getCards,
  getCategories,
  getCompanies,
  getMerchantList,
  getTransactions,
  getTransactionStats,
  sortCategoryOptions,
  type TxnRow,
  type TxnStats
} from "@/lib/data";
import { cardLabel, formatDate, formatRM } from "@/lib/format";
import DetailsAutoClose from "../components/DetailsAutoClose";
import RowEditors from "./RowEditors";

export const dynamic = "force-dynamic";

const TXN_TYPES = [
  "purchase",
  "refund",
  "payment",
  "fee_interest",
  "instalment",
  "cash_advance"
] as const;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s === "" ? undefined : s;
}

function many(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).filter((s) => s !== "");
}

export default async function TransactionsPage({
  searchParams
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const SORTS = ["date_desc", "date_asc", "amount_desc", "amount_asc"] as const;
  const sortParam = first(sp.sort);
  const sort = (SORTS as readonly string[]).includes(sortParam ?? "")
    ? (sortParam as (typeof SORTS)[number])
    : "date_desc";
  const filters = {
    card: first(sp.card),
    categories: many(sp.category),
    merchant: first(sp.merchant),
    txnTypes: many(sp.txn_type),
    from: first(sp.from),
    to: first(sp.to),
    sort
  };
  const requestedPage = Math.max(1, Number(first(sp.page) ?? "1") || 1);

  const locale = await getLocale();
  const t = await getTranslations("transactions");
  const tc = await getTranslations("common");
  const tt = await getTranslations("txnType");

  let txns: TxnRow[] = [];
  let total = 0;
  let page = requestedPage;
  let pageCount = 1;
  let stats: TxnStats | null = null;
  let categories: Awaited<ReturnType<typeof getCategories>> = [];
  let cards: Awaited<ReturnType<typeof getCards>> = [];
  let companies: Awaited<ReturnType<typeof getCompanies>>["companies"] = [];
  let merchants: Awaited<ReturnType<typeof getMerchantList>> = [];
  let loadError: string | null = null;
  try {
    const [txnsR, statsR, categoriesR, cardsR, companiesR, merchantsR] = await Promise.all([
      getTransactions(filters, requestedPage),
      getTransactionStats(filters),
      getCategories(),
      getCards(),
      getCompanies(),
      // merchant picker scoped to the current filters (owner request 2026-07-21)
      getMerchantList(filters)
    ]);
    txns = txnsR.rows;
    total = txnsR.total;
    page = txnsR.page;
    pageCount = txnsR.pageCount;
    stats = statsR;
    categories = categoriesR;
    cards = cardsR;
    companies = companiesR.companies; // missing table => empty list, personal only
    merchants = merchantsR;
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

  const catName = (c: { name_en: string; name_zh: string | null }) =>
    locale === "zh" && c.name_zh ? c.name_zh : c.name_en;
  const categoryOptions = sortCategoryOptions(
    categories.map((c) => ({ id: c.id, name: catName(c) })), locale,
  );
  const tagOptions = buildTagOptions(companies, tc("personal"));

  return (
    <>
      <h1>{t("title")}</h1>
      <DetailsAutoClose />

      <form className="filters" action="/transactions">
        <label>
          {t("filters.card")}
          <select name="card" defaultValue={filters.card ?? ""}>
            <option value="">{tc("all")}</option>
            {cards.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {cardLabel(c)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("filters.category")}
          {/* checkbox multi-select (owner request): plain <details>, the GET
              form submits every checked box as a repeated ?category= param */}
          <details className="multiselect">
            <summary>
              {filters.categories.length === 0
                ? tc("all")
                : t("filters.categoriesSelected", { count: filters.categories.length })}
            </summary>
            <div className="multiselect-options">
              <div className="ms-controls">
                <button type="button" data-ms-all>{t("filters.selectAll")}</button>
                <button type="button" data-ms-none>{t("filters.deselectAll")}</button>
              </div>
              {categoryOptions.map((c) => (
                // owner request: name on the left, tick box on the RIGHT
                <label key={c.id} className="multiselect-option">
                  <span>{c.name}</span>
                  <input
                    type="checkbox"
                    name="category"
                    value={String(c.id)}
                    defaultChecked={filters.categories.includes(String(c.id))}
                  />
                </label>
              ))}
            </div>
          </details>
        </label>
        <label>
          {t("filters.merchant")}
          <input
            type="text"
            name="merchant"
            list="merchant-list"
            defaultValue={filters.merchant ?? ""}
            placeholder={t("filters.merchantPlaceholder")}
          />
          <datalist id="merchant-list">
            {merchants.map((m) => (
              // merchant keys derive from raw descriptions — never translated
              <option key={m.key} value={m.key}>{`${m.key} (${m.count})`}</option>
            ))}
          </datalist>
        </label>
        <label>
          {t("filters.type")}
          {/* checkbox multi-select (owner request 2026-07-21): tick any types */}
          <details className="multiselect">
            <summary>
              {filters.txnTypes.length === 0
                ? tc("all")
                : t("filters.typesSelected", { count: filters.txnTypes.length })}
            </summary>
            <div className="multiselect-options">
              <div className="ms-controls">
                <button type="button" data-ms-all>{t("filters.selectAll")}</button>
                <button type="button" data-ms-none>{t("filters.deselectAll")}</button>
              </div>
              {TXN_TYPES.map((type) => (
                <label key={type} className="multiselect-option">
                  <span>{tt(type)}</span>
                  <input
                    type="checkbox"
                    name="txn_type"
                    value={type}
                    defaultChecked={filters.txnTypes.includes(type)}
                  />
                </label>
              ))}
            </div>
          </details>
        </label>
        <label>
          {t("filters.from")}
          <input type="date" name="from" defaultValue={filters.from ?? ""} />
        </label>
        <label>
          {t("filters.to")}
          <input type="date" name="to" defaultValue={filters.to ?? ""} />
        </label>
        <label>
          {t("filters.sort")}
          <select name="sort" defaultValue={filters.sort}>
            <option value="date_desc">{t("sort.dateDesc")}</option>
            <option value="date_asc">{t("sort.dateAsc")}</option>
            <option value="amount_desc">{t("sort.amountDesc")}</option>
            <option value="amount_asc">{t("sort.amountAsc")}</option>
          </select>
        </label>
        <button type="submit">{t("filters.apply")}</button>
        <a className="btn-secondary" href="/transactions">
          {t("filters.reset")}
        </a>
      </form>

      {(filters.categories.length > 0 || filters.merchant || filters.txnTypes.length > 0) && (
        <div className="filter-chips">
          {filters.txnTypes.map((ty) => (
            <span key={ty} className="filter-chip type-chip">
              {tt(ty)}
              <a
                href={buildQuery({ ...filters, txnTypes: filters.txnTypes.filter((x) => x !== ty) }, 1)}
                aria-label={t("filters.removeType", { name: tt(ty) })}
                className="chip-x"
              >
                ×
              </a>
            </span>
          ))}
          {filters.merchant && (
            <span className="filter-chip merchant-chip">
              {filters.merchant}
              <a
                href={buildQuery({ ...filters, merchant: undefined }, 1)}
                aria-label={t("filters.removeMerchant")}
                className="chip-x"
              >
                ×
              </a>
            </span>
          )}
          {filters.categories.map((id) => {
            const c = categoryOptions.find((x) => String(x.id) === id);
            return (
              <span key={id} className="filter-chip">
                {c?.name ?? id}
                <a
                  href={chipRemoveHref(filters, id)}
                  aria-label={t("filters.removeCategory", { name: c?.name ?? id })}
                  className="chip-x"
                >
                  ×
                </a>
              </span>
            );
          })}
          {filters.categories.length > 0 && (
            <a className="chip-clear" href={chipRemoveHref(filters, null)}>
              {t("filters.clearCategories")}
            </a>
          )}
        </div>
      )}

      {stats && (
        <>
          <div className="kpi-row stats-strip">
            <div className="stat-tile">
              <div className="stat-label">{t("stats.balance")}</div>
              <div className="stat-value">{formatRM(stats.balance)}</div>
              <div className="stat-sub">{t("stats.balanceNote")}</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">{t("stats.average")}</div>
              <div className="stat-value">{formatRM(stats.average)}</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">{t("stats.highest")}</div>
              <div className="stat-value">{formatRM(stats.highest)}</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">{t("stats.lowest")}</div>
              <div className="stat-value">{formatRM(stats.lowest)}</div>
            </div>
          </div>
          <div className="kpi-row stats-strip">
            <div className="stat-tile">
              <div className="stat-label">{t("stats.spent")}</div>
              <div className="stat-value">{formatRM(stats.spent)}</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">{t("stats.paid")}</div>
              <div className="stat-value">{formatRM(stats.paid)}</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">{t("stats.refunds")}</div>
              <div className="stat-value">{formatRM(stats.refunds)}</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">{t("stats.fees")}</div>
              <div className="stat-value">{formatRM(stats.fees)}</div>
            </div>
          </div>
        </>
      )}

      <p className="muted export-line">
        <span>
          {t("count", { count: total })}
          {pageCount > 1 && <> · {t("pager.pageOf", { page, pageCount })}</>}
        </span>
        {total > 0 && (
          <span className="export-links">
            <a className="btn-secondary" href={exportHref(filters, "csv")}>{t("export.csv")}</a>
            <a className="btn-secondary" href={exportHref(filters, "xlsx")}>{t("export.xlsx")}</a>
          </span>
        )}
      </p>

      {txns.length === 0 ? (
        <p className="muted">{t("empty")}</p>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t("table.date")}</th>
                <th>{t("table.card")}</th>
                <th>{t("table.description")}</th>
                <th className="amount-cell">{t("table.amount")}</th>
                <th>{t("table.type")}</th>
                <th>{t("table.category")}</th>
                <th>{t("table.businessTag")}</th>
                <th>{t("table.notes")}</th>
              </tr>
            </thead>
            <tbody>
              {txns.map((txn) => (
                <tr key={txn.id}>
                  <td className="nowrap">{formatDate(txn.txn_date)}</td>
                  <td className="nowrap">{cardLabel(txn.card)}</td>
                  <td>
                    {/* raw description — displayed verbatim, never translated */}
                    <div className="desc-raw">{txn.description_raw}</div>
                    {(txn.edited || txn.needs_confirmation) && (
                      <div className="chips">
                        {txn.needs_confirmation && (
                          <span className="chip pending">{t("markers.pending")}</span>
                        )}
                        {txn.edited && (
                          <span className="chip edited">{t("markers.edited")}</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="amount-cell">
                    <span
                      className={
                        txn.direction === "credit" ? "amount credit" : "amount"
                      }
                    >
                      {txn.direction === "credit" ? "−" : ""}
                      {formatRM(txn.amount_rm)}
                    </span>
                    {txn.original_currency && txn.original_amount != null && (
                      <span className="orig-amount">
                        {txn.original_currency} {txn.original_amount.toFixed(2)}
                      </span>
                    )}
                  </td>
                  <td className="nowrap">
                    <span className={`badge type-${txn.txn_type}`}>
                      {tt(txn.txn_type)}
                    </span>
                  </td>
                  <RowEditors
                    txnId={txn.id}
                    categoryId={txn.category_id}
                    businessTag={txn.business_tag}
                    businessTagOverridden={txn.business_tag_overridden}
                    notes={txn.notes}
                    categoryOptions={categoryOptions}
                    tagOptions={tagOptions}
                  />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pageCount > 1 && (
        <nav className="pager">
          {page > 1 && (
            <a className="btn-secondary" href={pageHref(filters, page - 1)}>
              {t("pager.prev")}
            </a>
          )}
          <span className="muted">{t("pager.pageOf", { page, pageCount })}</span>
          {page < pageCount && (
            <a className="btn-secondary" href={pageHref(filters, page + 1)}>
              {t("pager.next")}
            </a>
          )}
        </nav>
      )}
    </>
  );
}

type PageFilters = {
  card?: string; categories: string[]; merchant?: string; txnTypes: string[];
  from?: string; to?: string; sort?: string;
};

function buildQuery(filters: PageFilters, page: number): string {
  const params = new URLSearchParams();
  if (filters.card) params.set("card", filters.card);
  for (const c of filters.categories) params.append("category", c);
  if (filters.merchant) params.set("merchant", filters.merchant);
  for (const ty of filters.txnTypes) params.append("txn_type", ty);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.sort && filters.sort !== "date_desc") params.set("sort", filters.sort);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/transactions?${qs}` : "/transactions";
}

function pageHref(filters: PageFilters, page: number): string {
  return buildQuery(filters, page);
}

/** chip "×": drop one category (or all with null); resets to page 1 */
function chipRemoveHref(filters: PageFilters, removeId: string | null): string {
  return buildQuery(
    { ...filters, categories: removeId == null ? [] : filters.categories.filter((c) => c !== removeId) },
    1,
  );
}

/** export the CURRENT filtered view (all pages) as csv or xlsx */
function exportHref(filters: PageFilters, format: "csv" | "xlsx"): string {
  const base = buildQuery(filters, 1).replace("/transactions", "/transactions/export");
  return `${base}${base.includes("?") ? "&" : "?"}format=${format}`;
}
