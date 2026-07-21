"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { confirmGroup } from "./actions";

type Props = {
  groupKey: string;
  categoryOptions: { id: number; name: string }[];
  suggestion: { id: number; confidence: number } | null;
};

export default function GroupConfirm({ groupKey, categoryOptions, suggestion }: Props) {
  const t = useTranslations("queue");
  const tc = useTranslations("common");
  // an LLM recommendation preselects the dropdown; the user still confirms
  const [categoryId, setCategoryId] = useState(
    suggestion ? String(suggestion.id) : ""
  );
  const [pending, startTransition] = useTransition();
  const suggestedName = suggestion
    ? categoryOptions.find((c) => c.id === suggestion.id)?.name
    : undefined;

  return (
    <div className="queue-actions">
      {suggestion && suggestedName ? (
        <span className="muted" style={{ fontSize: "0.78rem" }}>
          {t("suggested", {
            name: suggestedName,
            percent: Math.round(suggestion.confidence * 100)
          })}
        </span>
      ) : null}
      <select
        value={categoryId}
        disabled={pending}
        aria-label={t("selectCategory")}
        onChange={(e) => setCategoryId(e.target.value)}
      >
        <option value="" disabled>
          {t("selectCategory")}
        </option>
        {categoryOptions.map((c) => (
          <option key={c.id} value={String(c.id)}>
            {c.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn"
        disabled={pending || categoryId === ""}
        onClick={() =>
          startTransition(async () => {
            await confirmGroup(groupKey, Number(categoryId));
          })
        }
      >
        {pending ? tc("saving") : t("confirm")}
      </button>
    </div>
  );
}
