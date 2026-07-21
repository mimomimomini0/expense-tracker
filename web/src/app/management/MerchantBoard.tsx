"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { moveMerchantRule } from "./actions";

export interface BoardMerchant {
  pattern: string;
  count: number;
  confirmed: boolean;
}
export interface BoardColumn {
  id: number;
  name: string;
  merchants: BoardMerchant[];
}

/** Merchants-by-category board: every category is a column, every merchant
 *  rule a draggable pill. Dropping a pill on another column moves the rule
 *  AND all its transactions (server action). */
export default function MerchantBoard({ columns }: { columns: BoardColumn[] }) {
  const t = useTranslations("management.board");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [overCol, setOverCol] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onDrop = (e: React.DragEvent, categoryId: number) => {
    e.preventDefault();
    setOverCol(null);
    const pattern = e.dataTransfer.getData("text/merchant-pattern");
    if (!pattern) return;
    const fromCol = columns.find((c) => c.merchants.some((m) => m.pattern === pattern));
    if (fromCol?.id === categoryId) return; // dropped where it already lives
    setError(null);
    startTransition(async () => {
      try {
        await moveMerchantRule(pattern, categoryId);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <>
      <p className="inline-note">{t("hint")}</p>
      {error && <p className="error-box">{error}</p>}
      <div className={`board${pending ? " board-busy" : ""}`}>
        {columns.map((col) => (
          <section
            key={col.id}
            className={`board-col${overCol === col.id ? " drag-over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setOverCol(col.id); }}
            onDragLeave={() => setOverCol((c) => (c === col.id ? null : c))}
            onDrop={(e) => onDrop(e, col.id)}
          >
            <h3>
              {col.name} <span className="muted">({col.merchants.length})</span>
            </h3>
            {col.merchants.length === 0 ? (
              <p className="board-empty">{t("empty")}</p>
            ) : (
              <ul>
                {col.merchants.map((m) => (
                  <li
                    key={m.pattern}
                    className="merchant-pill"
                    draggable={!pending}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/merchant-pattern", m.pattern);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    title={t("pillTitle", { count: m.count })}
                  >
                    {/* merchant patterns derive from raw descriptions — never translated */}
                    <span className="pill-name">{m.pattern}</span>
                    <span className="pill-count">{m.count}</span>
                    {!m.confirmed && <span className="pill-seeded">{t("seeded")}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </>
  );
}
