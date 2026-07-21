import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";

export const LOCALES = ["en", "zh"] as const;
export type AppLocale = (typeof LOCALES)[number];

export default getRequestConfig(async () => {
  // Cookie-based locale, no URL prefixes (next-intl "without i18n routing").
  const store = await cookies();
  const cookieLocale = store.get("NEXT_LOCALE")?.value;
  const locale: AppLocale = cookieLocale === "zh" ? "zh" : "en";

  return {
    locale,
    timeZone: "Asia/Kuala_Lumpur",
    messages: (await import(`../../messages/${locale}.json`)).default
  };
});
