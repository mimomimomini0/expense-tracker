import { getLocale, getTranslations } from "next-intl/server";
import {
  buildTagOptions,
  getCards,
  getCompanies,
  getProfile,
  type CardAccount,
  type Company,
  type UserProfile
} from "@/lib/data";
import { cardLabel } from "@/lib/format";
import {
  addCompany,
  renameCompany,
  saveCardSettings,
  saveProfile,
  setCompanyArchived
} from "./actions";
import SystemSection from "./SystemSection";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const locale = await getLocale();
  const t = await getTranslations("onboarding");
  const tc = await getTranslations("common");

  let cards: CardAccount[] = [];
  let companies: Company[] = [];
  let profile: UserProfile | null = null;
  let profileMissing = false;
  let companiesMissing = false;
  let loadError: string | null = null;
  try {
    const [cardsR, companiesR, profileR] = await Promise.all([
      getCards(),
      getCompanies(),
      getProfile()
    ]);
    cards = cardsR;
    companies = companiesR.companies;
    companiesMissing = companiesR.missing;
    profile = profileR.profile;
    profileMissing = profileR.missing;
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

  const tagOptions = buildTagOptions(companies, tc("personal"));

  return (
    <>
      <h1>{t("title")}</h1>

      {(profileMissing || companiesMissing) && (
        <p className="notice">{tc("missingProfileTables")}</p>
      )}

      {/* ---------- profile ---------- */}
      {!profileMissing && (
        <section className="panel">
          <h2>{t("profile.title")}</h2>
          <form action={saveProfile}>
            <div className="form-grid">
              <label>
                {t("profile.language")}
                <select
                  name="language"
                  defaultValue={profile?.language === "zh" ? "zh" : locale}
                >
                  <option value="en">{t("profile.languageEn")}</option>
                  <option value="zh">{t("profile.languageZh")}</option>
                </select>
              </label>
              <label>
                {t("profile.displayName")}
                <input
                  type="text"
                  name="display_name"
                  defaultValue={profile?.display_name ?? ""}
                />
              </label>
              <label>
                {t("profile.reminderEmail")}
                <input
                  type="email"
                  name="reminder_email"
                  defaultValue={profile?.reminder_email ?? ""}
                />
              </label>
            </div>
            <button type="submit">{t("profile.save")}</button>
          </form>
        </section>
      )}

      {/* ---------- companies ---------- */}
      {!companiesMissing && (
        <section className="panel">
          <h2>{t("companies.title")}</h2>
          <p className="inline-note">{t("companies.intro")}</p>

          {companies.length === 0 && (
            <p className="muted">{t("companies.empty")}</p>
          )}

          {companies.map((company) => (
            <div
              key={company.id}
              className={`row-form${company.archived ? " company-archived" : ""}`}
            >
              <form
                action={renameCompany}
                style={{ display: "flex", gap: "0.5rem", flex: 1, alignItems: "end", flexWrap: "wrap" }}
              >
                <input type="hidden" name="id" value={company.id} />
                <label className="stack-label grow">
                  {t("companies.name")}
                  {/* company names are user data — shown verbatim */}
                  <input type="text" name="name" defaultValue={company.name} required />
                </label>
                <label className="stack-label">
                  {t("companies.label")}
                  <input type="text" name="label" defaultValue={company.label ?? ""} />
                </label>
                <button type="submit">{t("companies.rename")}</button>
              </form>
              <form action={setCompanyArchived}>
                <input type="hidden" name="id" value={company.id} />
                <input type="hidden" name="archived" value={company.archived ? "0" : "1"} />
                <button type="submit" className="btn-secondary">
                  {company.archived ? t("companies.restore") : t("companies.archive")}
                </button>
              </form>
              {company.archived && (
                <span className="chip pending">{t("companies.archived")}</span>
              )}
            </div>
          ))}

          <form action={addCompany} className="row-form">
            <label className="stack-label grow">
              {t("companies.name")}
              <input type="text" name="name" required />
            </label>
            <label className="stack-label">
              {t("companies.label")}
              <input type="text" name="label" />
            </label>
            <button type="submit">{t("companies.add")}</button>
          </form>
        </section>
      )}

      {/* ---------- per-card settings ---------- */}
      <section className="panel">
        <h2>{t("cards.title")}</h2>
        <p className="inline-note">{t("cards.intro")}</p>

        {cards.length === 0 && <p className="muted">{t("cards.empty")}</p>}

        {cards.map((card) => (
          <form action={saveCardSettings} className="row-form" key={card.id}>
            <input type="hidden" name="id" value={card.id} />
            <span className="grow">
              {/* bank name + last4 are raw data — never translated */}
              <strong>{cardLabel(card)}</strong>
              <span className="muted"> ({card.bank_name} ••{card.last4})</span>
            </span>
            <label className="stack-label">
              {t("cards.displayName")}
              <input
                type="text"
                name="display_name"
                defaultValue={card.display_name ?? ""}
                placeholder={t("cards.displayNamePlaceholder")}
              />
            </label>
            <label className="stack-label">
              {t("cards.defaultTag")}
              <select
                name="default_business_tag"
                defaultValue={card.default_business_tag}
              >
                {!tagOptions.some((o) => o.value === card.default_business_tag) && (
                  <option value={card.default_business_tag}>
                    {card.default_business_tag}
                  </option>
                )}
                {tagOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">{t("cards.save")}</button>
          </form>
        ))}
      </section>

      <SystemSection />
    </>
  );
}
