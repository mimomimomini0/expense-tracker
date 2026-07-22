import { getTranslations } from "next-intl/server";
import { login } from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Single-user password login. Phone-first layout (one centered card). */
export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const t = await getTranslations("login");
  const error = typeof sp.error === "string" ? sp.error : null;

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>{t("title")}</h1>
        {error && <p className="error-box">{t(`errors.${error}`)}</p>}
        <form action={login} className="login-form">
          <label className="stack-label">
            {t("password")}
            <input
              type="password" name="password" required autoFocus
              autoComplete="current-password"
            />
          </label>
          <button type="submit" className="btn">{t("signIn")}</button>
        </form>
      </div>
    </div>
  );
}
