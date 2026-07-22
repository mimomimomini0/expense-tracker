// Summary report workbook (spec FR-11): period totals by category, by card,
// and by business tag, plus the monthly series. Follows the UI language.
//   GET /dashboard/report?from=&to=&card=&ew=
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import ExcelJS from "exceljs";
import { getDashboardData } from "@/lib/dashboard-data";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sp = req.nextUrl.searchParams;
  const now = new Date();
  // reporting periods default to the calendar year (spec)
  const from = sp.get("from") ?? `${now.getUTCFullYear()}-01-01`;
  const to = sp.get("to") ?? now.toISOString().slice(0, 10);
  const filters = {
    from, to,
    cards: sp.getAll("card").filter((c) => c !== ""),
    ewallet: sp.get("ew") !== "0",
  };

  const locale = ((await cookies()).get("NEXT_LOCALE")?.value === "zh" ? "zh" : "en") as "en" | "zh";
  const t = await getTranslations({ locale, namespace: "report" });
  const td = await getTranslations({ locale, namespace: "dashboard" });

  const data = await getDashboardData(filters);
  const money = "#,##0.00";

  const wb = new ExcelJS.Workbook();

  // ---- Summary ----
  const sum = wb.addWorksheet(t("sheets.summary"));
  sum.columns = [{ width: 32 }, { width: 18 }];
  const addKV = (k: string, v: string | number, fmt?: string) => {
    const row = sum.addRow([k, v]);
    if (fmt) row.getCell(2).numFmt = fmt;
  };
  addKV(t("period"), `${from} — ${to}`);
  sum.addRow([]);
  addKV(td("tiles.totalSpending"), data.totals.spending, money);
  if (data.totals.ewallet > 0) addKV(t("ewalletIncluded"), data.totals.ewallet, money);
  addKV(td("tiles.fees"), data.totals.fees, money);
  addKV(td("tiles.refunds"), data.totals.refunds, money);
  addKV(td("tiles.walletTransfers"), data.totals.walletTransfers, money);
  sum.addRow([]);
  sum.addRow([t("notes.transfers")]);
  sum.addRow([t("notes.refunds")]);
  sum.getColumn(1).font = { size: 11 };

  // ---- Monthly ----
  const mo = wb.addWorksheet(t("sheets.monthly"));
  mo.columns = [
    { header: td("monthly.month"), width: 10 },
    { header: td("monthly.spending"), width: 14 },
    { header: td("monthly.fees"), width: 14 },
    { header: td("monthly.refunds"), width: 14 },
  ];
  mo.getRow(1).font = { bold: true };
  for (const m of data.months) mo.addRow([m.month, m.spending, m.fees, m.refunds]);
  for (const c of [2, 3, 4]) mo.getColumn(c).numFmt = money;

  // ---- By category ----
  const cat = wb.addWorksheet(t("sheets.byCategory"));
  cat.columns = [
    { header: td("categories.category"), width: 26 },
    { header: td("categories.amount"), width: 14 },
    { header: "%", width: 8 },
  ];
  cat.getRow(1).font = { bold: true };
  for (const s of data.categories) {
    const name = s.key === "__uncategorised"
      ? td("uncategorised")
      : locale === "zh" && s.name_zh ? s.name_zh : s.name_en;
    cat.addRow([name, s.total, data.totals.spending > 0 ? s.total / data.totals.spending : 0]);
  }
  cat.getColumn(2).numFmt = money;
  cat.getColumn(3).numFmt = "0.0%";

  // ---- By card ----
  const card = wb.addWorksheet(t("sheets.byCard"));
  card.columns = [
    { header: t("columns.card"), width: 22 },
    { header: td("monthly.spending"), width: 14 },
    { header: td("monthly.fees"), width: 14 },
    { header: td("monthly.refunds"), width: 14 },
  ];
  card.getRow(1).font = { bold: true };
  for (const b of data.byCard) {
    card.addRow([b.cardId == null ? t("ewalletRow") : b.label, b.spending, b.fees, b.refunds]);
  }
  for (const c of [2, 3, 4]) card.getColumn(c).numFmt = money;

  // ---- By business tag ----
  const tag = wb.addWorksheet(t("sheets.byTag"));
  tag.columns = [
    { header: t("columns.tag"), width: 20 },
    { header: td("monthly.spending"), width: 14 },
  ];
  tag.getRow(1).font = { bold: true };
  for (const b of data.byTag) tag.addRow([b.tag, b.spending]);
  tag.getColumn(2).numFmt = money;

  const buf = await wb.xlsx.writeBuffer();
  return new NextResponse(Buffer.from(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="expense-report-${from}-to-${to}.xlsx"`,
    },
  });
}
