import { getTranslations } from "next-intl/server";
import { requestOtp, verifyCode } from "./actions";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Phase 4 passwordless login: email -> 6-digit OTP -> session. Phone-first
 *  layout (a single centered card). */
export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const t = await getTranslations("login");
  const sent = sp.sent === "1";
  const email = typeof sp.email === "string" ? sp.email : "";
  const error = typeof sp.error === "string" ? sp.error : null;

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>{t("title")}</h1>
        {error && <p className="error-box">{t(`errors.${error}`)}</p>}
        {!sent ? (
          <form action={requestOtp} className="login-form">
            <label className="stack-label">
              {t("email")}
              <input type="email" name="email" required autoFocus autoComplete="email" />
            </label>
            <button type="submit" className="btn">{t("sendCode")}</button>
          </form>
        ) : (
          <form action={verifyCode} className="login-form">
            <p className="muted">{t("codeSent", { email })}</p>
            <input type="hidden" name="email" value={email} />
            <label className="stack-label">
              {t("code")}
              <input
                type="text" name="code" required autoFocus
                inputMode="numeric" pattern="\d{6}" maxLength={6}
                autoComplete="one-time-code" className="otp-input"
              />
            </label>
            <button type="submit" className="btn">{t("verify")}</button>
            <a className="muted" href="/login">{t("startOver")}</a>
          </form>
        )}
      </div>
    </div>
  );
}
