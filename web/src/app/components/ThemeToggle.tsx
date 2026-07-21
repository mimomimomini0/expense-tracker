"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { setTheme } from "../actions";

/** Day / Dark / System selector. The server stamps html[data-theme] from the
 *  THEME cookie; System removes the attribute and the OS setting decides. */
export default function ThemeToggle({ current }: { current: "light" | "dark" | "system" }) {
  const t = useTranslations("theme");
  const [pending, startTransition] = useTransition();

  const switchTo = (theme: "light" | "dark" | "system") =>
    startTransition(async () => {
      await setTheme(theme);
    });

  const options: { value: "light" | "dark" | "system"; icon: string }[] = [
    { value: "light", icon: "☀" },
    { value: "dark", icon: "☾" },
    { value: "system", icon: "◐" },
  ];

  return (
    <div className="theme-toggle" role="group" aria-label={t("label")}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={current === o.value ? "active" : ""}
          disabled={pending}
          title={t(o.value)}
          aria-label={t(o.value)}
          onClick={() => switchTo(o.value)}
        >
          {o.icon}
        </button>
      ))}
    </div>
  );
}
