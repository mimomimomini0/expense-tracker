import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { NextIntlClientProvider } from "next-intl";
import { cookies } from "next/headers";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { getBannerPayment } from "@/lib/payments-data";
import { authEnabled, currentUser } from "@/lib/auth";
import { formatRM } from "@/lib/format";
import { logout } from "./login/actions";
import LocaleToggle from "./components/LocaleToggle";
import PwaRegister from "./components/PwaRegister";
import ThemeToggle from "./components/ThemeToggle";
import "./globals.css";

export const dynamic = "force-dynamic";

export const viewport = {
  themeColor: "#0f6b4f",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5
};

export const metadata: Metadata = {
  title: "Expense Tracker",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Expenses", statusBarStyle: "default" }
};

export default async function RootLayout({
  children
}: {
  children: ReactNode;
}) {
  const locale = await getLocale();
  const messages = await getMessages();
  const tApp = await getTranslations("app");
  const tNav = await getTranslations("nav");
  const tPay = await getTranslations("payments");
  // The nav + due-payment banner are app chrome — only for signed-in users.
  // On the login page (unauthenticated) we render nothing but the login card,
  // and we never even fetch payment data, so nothing leaks pre-auth.
  const signedIn = Boolean(await currentUser());
  const banner = signedIn ? await getBannerPayment() : null; // null on error — never blocks a page
  const themeCookie = (await cookies()).get("THEME")?.value;
  const theme = themeCookie === "light" || themeCookie === "dark" ? themeCookie : undefined;

  return (
    <html lang={locale} data-theme={theme}>
      <body>
        <NextIntlClientProvider messages={messages}>
          {signedIn && (
            <header className="site-header">
              <div className="brand">{tApp("title")}</div>
              <nav>
                <Link href="/dashboard">{tNav("dashboard")}</Link>
                <Link href="/transactions">{tNav("transactions")}</Link>
                <Link href="/duedates">{tNav("duedates")}</Link>
                <Link href="/subscriptions">{tNav("subscriptions")}</Link>
                <Link href="/costs">{tNav("costs")}</Link>
                <Link href="/owed">{tNav("owed")}</Link>
                <Link href="/management">{tNav("management")}</Link>
                <Link href="/onboarding">{tNav("onboarding")}</Link>
              </nav>
              <ThemeToggle current={theme ?? "system"} />
              <LocaleToggle current={locale} />
              {authEnabled() && (
                <form action={logout}>
                  <button type="submit" className="btn-secondary logout-btn">
                    {tNav("logout")}
                  </button>
                </form>
              )}
            </header>
          )}
          <PwaRegister />
          {signedIn && banner && (
            <Link href="/dashboard" className={`due-banner ${banner.daysRemaining <= 2 ? "critical" : "warning"}`}>
              <i aria-hidden="true">{banner.daysRemaining <= 2 ? "!" : "▲"}</i>{" "}
              {banner.daysRemaining < 0
                ? tPay("banner.overdue", { card: banner.cardLabel, amount: formatRM(banner.statementBalance), days: -banner.daysRemaining })
                : tPay("banner.due", { card: banner.cardLabel, amount: formatRM(banner.statementBalance), days: banner.daysRemaining })}
            </Link>
          )}
          <main>{children}</main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
