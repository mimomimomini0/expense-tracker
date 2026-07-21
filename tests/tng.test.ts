// Regression harness for the Touch 'n Go e-wallet input type. Asserts against
// fixture-ground-truth-tng.json (printed per-card summaries, owner-verifiable),
// never against pipeline output. Replays the cached extraction.

import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CachingExtractor, sha256 } from "../src/llm.js";
import { parseTngPdf, type TngImportResult } from "../src/tng.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const gt = JSON.parse(fs.readFileSync(path.join(ROOT, "fixture-ground-truth-tng.json"), "utf8"));
const sen = (rm: number) => Math.round(rm * 100);
const squash = (s: string) => s.replace(/\s+/g, "").toUpperCase();

interface TngCardGt {
  card_serial: string;
  reload_count: number; reload_total: number;
  usage_count: number; usage_total: number;
  other_charges: number; closing_balance: number; derived_opening_balance: number;
}
interface TngGt {
  file: string; provider: string; account_no: string; registered_name: string;
  period_start: string; period_end: string;
  cards: TngCardGt[];
  spot_checks: {
    card_serial: string; trans_date: string; type: "usage" | "reload"; sector: string;
    exit_contains?: string; amount: number; balance_after: number;
  }[];
}

describe.each(gt.statements as TngGt[])("TNG statement $file", (s) => {
  let result: TngImportResult;

  beforeAll(async () => {
    const pdfPath = path.join(ROOT, "fixtures", "tng", s.file);
    if (!fs.existsSync(pdfPath)) throw new Error(`missing TNG fixture ${s.file}`);
    const pdf = fs.readFileSync(pdfPath);
    result = await parseTngPdf(new CachingExtractor(), s.file, pdf, sha256(pdf));
  });

  it("passes the gate as an e-wallet statement and reaches parsed_ok", () => {
    expect(result.outcome, result.detail ?? "").toBe("parsed_ok");
    expect(result.extraction!.account_no).toBe(s.account_no);
    expect(result.extraction!.period_start).toBe(s.period_start);
    expect(result.extraction!.period_end).toBe(s.period_end);
    expect(result.cards.map((c) => c.card_serial).sort()).toEqual(
      s.cards.map((c) => c.card_serial).sort(),
    );
  });

  describe.each(gt.statements.flatMap((st: TngGt) => st.cards) as TngCardGt[])(
    "card $card_serial",
    (cardGt) => {
      it("reconciles the running-balance chain and printed summary exactly", () => {
        const c = result.cards.find((x) => x.card_serial === cardGt.card_serial)!;
        expect(c, `card ${cardGt.card_serial} present`).toBeTruthy();
        expect(c.problems).toEqual([]);
        expect(c.ok).toBe(true);
        const cardRows = result.rows.filter((r) => r.card_serial === cardGt.card_serial);
        expect(c.chainChecked, "every consecutive row pair verified").toBe(cardRows.length - 1);
        expect(c.closingBalance, "closing balance").toBe(sen(cardGt.closing_balance));
        expect(c.derivedOpeningBalance, "derived opening balance").toBe(sen(cardGt.derived_opening_balance));
      });

      it("matches the hand-verified counts and totals; reloads never count as expenses", () => {
        const c = result.cards.find((x) => x.card_serial === cardGt.card_serial)!;
        expect(c.usageCount, "usage count").toBe(cardGt.usage_count);
        expect(c.usageTotal, "usage total").toBe(sen(cardGt.usage_total));
        expect(c.reloadCount, "reload count").toBe(cardGt.reload_count);
        expect(c.reloadTotal, "reload total").toBe(sen(cardGt.reload_total));
        expect(c.otherTotal, "other charges").toBe(sen(cardGt.other_charges));
        // the expense set is exactly the usage rows; reloads are transfers
        const rows = result.rows.filter((r) => r.card_serial === cardGt.card_serial);
        const expenses = rows.filter((r) => r.kind === "usage");
        expect(expenses.reduce((a, r) => a + r.amount, 0)).toBe(sen(cardGt.usage_total));
        for (const t of rows.filter((r) => r.kind === "reload")) {
          expect(t.reload_source, `reload ${t.trans_datetime} carries its source`).toBeTruthy();
        }
      });
    },
  );

  it("satisfies the spot checks (dates, sector, Exit-Location description, balances)", () => {
    for (const check of s.spot_checks) {
      const matches = result.rows.filter(
        (r) =>
          r.card_serial === check.card_serial &&
          r.trans_date === check.trans_date &&
          r.kind === check.type &&
          r.amount === sen(check.amount) &&
          r.balance_after === sen(check.balance_after),
      );
      expect(matches.length, JSON.stringify(check)).toBeGreaterThanOrEqual(1);
      const row = matches[0]!;
      expect(squash(row.sector ?? ""), `sector of ${check.trans_date}`).toContain(squash(check.sector));
      if (check.exit_contains) {
        expect(squash(row.description), `description of ${check.trans_date}`).toContain(
          squash(check.exit_contains),
        );
      }
    }
  });
});
