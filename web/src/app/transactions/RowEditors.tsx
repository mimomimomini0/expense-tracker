"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { updateTxnField } from "./actions";

type Props = {
  txnId: number;
  categoryId: number | null;
  businessTag: string;
  businessTagOverridden: boolean;
  notes: string | null;
  categoryOptions: { id: number; name: string }[];
  tagOptions: { value: string; label: string }[];
};

/** The three editable cells of a transaction row (category, business tag,
 *  notes). Each change goes through the audited server action. */
export default function RowEditors({
  txnId,
  categoryId,
  businessTag,
  businessTagOverridden,
  notes,
  categoryOptions,
  tagOptions
}: Props) {
  const t = useTranslations("transactions");
  const [pending, startTransition] = useTransition();
  const [notesDraft, setNotesDraft] = useState(notes ?? "");

  const submit = (field: "category_id" | "business_tag" | "notes", value: string) =>
    startTransition(async () => {
      await updateTxnField(txnId, field, value);
    });

  const saveNotes = () => {
    if ((notes ?? "") !== notesDraft.trim()) submit("notes", notesDraft);
  };

  const tagValues = tagOptions.map((o) => o.value);

  return (
    <>
      <td>
        <select
          value={categoryId == null ? "" : String(categoryId)}
          disabled={pending}
          aria-label={t("table.category")}
          onChange={(e) => {
            if (e.target.value !== "") submit("category_id", e.target.value);
          }}
        >
          {categoryId == null && (
            <option value="" disabled>
              {t("selectCategory")}
            </option>
          )}
          {categoryOptions.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name}
            </option>
          ))}
        </select>
      </td>
      <td>
        <select
          value={businessTag}
          disabled={pending}
          aria-label={t("table.businessTag")}
          onChange={(e) => submit("business_tag", e.target.value)}
        >
          {/* keep a non-listed stored tag selectable (e.g. archived company) */}
          {!tagValues.includes(businessTag) && (
            <option value={businessTag}>{businessTag}</option>
          )}
          {tagOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {businessTagOverridden && (
          <span
            className="chip overridden"
            style={{ marginLeft: "0.3rem" }}
            title={t("markers.tagOverridden")}
          >
            {t("markers.tagOverridden")}
          </span>
        )}
      </td>
      <td>
        <input
          type="text"
          className="notes-input"
          value={notesDraft}
          placeholder={t("notesPlaceholder")}
          disabled={pending}
          aria-label={t("table.notes")}
          onChange={(e) => setNotesDraft(e.target.value)}
          onBlur={saveNotes}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </td>
    </>
  );
}
