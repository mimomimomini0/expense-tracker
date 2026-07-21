// Export the CURRENT filtered transactions view (spec FR-11):
//   GET /transactions/export?format=csv|xlsx&<same filters as the page>
// Headers follow the active UI language (owner decision Q10 round 1).
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import ExcelJS from "exceljs";
import { getAllTransactions, getCategories, type TxnRow } from "@/lib/data";
import { cardLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

function many(params: URLSearchParams, key: string): string[] {
  return params.getAll(key).filter((s) => s !== "");
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sp = req.nextUrl.searchParams;
  const format = sp.get("format") === "xlsx" ? "xlsx" : "csv";
  const SORTS = ["date_desc", "date_asc", "amount_desc", "amount_asc"];
  const filters = {
    card: sp.get("card") ?? undefined,
    categories: many(sp, "category"),
    merchant: sp.get("merchant") ?? undefined,
    txnTypes: many(sp, "txn_type"),
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    sort: (SORTS.includes(sp.get("sort") ?? "") ? sp.get("sort") : "date_desc") as
      | "date_desc" | "date_asc" | "amount_desc" | "amount_asc",
  };

  const locale = ((await cookies()).get("NEXT_LOCALE")?.value === "zh" ? "zh" : "en") as "en" | "zh";
  const t = await getTranslations({ locale, namespace: "export" });
  const tt = await getTranslations({ locale, namespace: "txnType" });

  const [rows, categories] = await Promise.all([getAllTransactions(filters), getCategories()]);
  const catName = new Map(
    categories.map((c) => [c.id, locale === "zh" && c.name_zh ? c.name_zh : c.name_en]),
  );

  const headers = [
    t("columns.date"), t("columns.card"), t("columns.description"),
    t("columns.amount"), t("columns.currency"), t("columns.originalAmount"),
    t("columns.type"), t("columns.category"), t("columns.businessTag"),
    t("columns.notes"),
  ];
  const record = (r: TxnRow): (string | number | null)[] => [
    r.txn_date,
    cardLabel(r.card),
    r.description_raw, // verbatim, never translated
    r.direction === "credit" ? -r.amount_rm : r.amount_rm,
    r.original_currency,
    r.original_amount,
    tt(r.txn_type),
    r.category_id != null ? catName.get(r.category_id) ?? String(r.category_id) : "",
    r.business_tag,
    r.notes ?? "",
  ];

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `transactions-${stamp}.${format}`;

  if (format === "csv") {
    const esc = (v: string | number | null) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // UTF-8 BOM so Excel opens Chinese text correctly
    const csv = "﻿" + [headers, ...rows.map(record)]
      .map((line) => line.map(esc).join(","))
      .join("\r\n");
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(t("transactionsSheet"));
  ws.columns = headers.map((h, i) => ({
    header: h,
    width: [12, 18, 44, 12, 9, 12, 12, 20, 14, 24][i],
  }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(record(r));
  ws.getColumn(4).numFmt = "#,##0.00";
  ws.getColumn(6).numFmt = "#,##0.00";
  const buf = await wb.xlsx.writeBuffer();
  return new NextResponse(Buffer.from(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
