"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { setLocale } from "../actions";

export default function LocaleToggle({ current }: { current: string }) {
  const t = useTranslations("locale");
  const [pending, startTransition] = useTransition();

  const switchTo = (locale: "en" | "zh") =>
    startTransition(async () => {
      await setLocale(locale);
    });

  return (
    <div className="locale-toggle" role="group" aria-label={t("label")}>
      <button
        type="button"
        className={current === "en" ? "active" : ""}
        disabled={pending}
        onClick={() => switchTo("en")}
      >
        {t("en")}
      </button>
      <button
        type="button"
        className={current === "zh" ? "active" : ""}
        disabled={pending}
        onClick={() => switchTo("zh")}
      >
        {t("zh")}
      </button>
    </div>
  );
}
