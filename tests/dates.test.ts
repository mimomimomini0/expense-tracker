// FR-3 mandatory date-resolution unit tests. These are pure and run without
// PDFs, API, or database.

import { describe, expect, it } from "vitest";
import { resolveDueDate, resolveTxnDate } from "../src/dates.js";

describe("FR-3 transaction date resolution", () => {
  it("resolves month <= statement month to the statement year", () => {
    expect(resolveTxnDate("19 APR", "2026-05-19")).toEqual({ iso: "2026-04-19", flagged: false });
    expect(resolveTxnDate("10 JAN", "2026-01-15")).toEqual({ iso: "2026-01-10", flagged: false });
  });

  it("MANDATORY: Dec transactions on a Jan statement resolve to the PRIOR year", () => {
    // RHB statement dated 15 Jan 2026 contains transactions dated 16-30 Dec
    for (const day of [16, 20, 25, 30]) {
      const r = resolveTxnDate(`${day} DEC`, "2026-01-15");
      expect(r.flagged).toBe(false);
      expect(r.iso).toBe(`2025-12-${day}`);
    }
  });

  it("handles lowercase month forms as printed by RHB ('27 Jun')", () => {
    expect(resolveTxnDate("27 Jun", "2026-07-15")).toEqual({ iso: "2026-06-27", flagged: false });
  });

  it("flags dates that resolve outside the statement window", () => {
    const r = resolveTxnDate("19 SEP", "2026-05-19"); // no valid reading near the period
    expect(r.flagged).toBe(true);
  });

  describe("compact DDMM form (RHB 2024 layout prints '2303' for 23/03)", () => {
    it("resolves unambiguous compact dates", () => {
      expect(resolveTxnDate("2303", "2024-04-14")).toEqual({ iso: "2024-03-23", flagged: false });
      expect(resolveTxnDate("3103", "2024-04-14")).toEqual({ iso: "2024-03-31", flagged: false });
    });

    it("reads compact strictly as day-month (Malaysian print order), never month-day", () => {
      // "0104" on an April statement is 1 April — not 4 January
      expect(resolveTxnDate("0104", "2024-04-14")).toEqual({ iso: "2024-04-01", flagged: false });
      // "0102" on a February statement is 1 Feb — 2 Jan would also fit the
      // window, so a two-reading interpretation would falsely flag every row
      expect(resolveTxnDate("0102", "2024-02-14")).toEqual({ iso: "2024-02-01", flagged: false });
    });

    it("crosses the year boundary backward like every other form", () => {
      expect(resolveTxnDate("1412", "2025-01-15")).toEqual({ iso: "2024-12-14", flagged: false });
    });

    it("flags an impossible compact month instead of guessing", () => {
      expect(resolveTxnDate("0313", "2024-04-14").flagged).toBe(true);
    });
  });
});

describe("FR-3 due date resolution (10-30 days after statement date)", () => {
  it("MANDATORY: '04/08/2026' on a 15 Jul 2026 statement is 4 August, never 8 April", () => {
    expect(resolveDueDate("04/08/2026", "2026-07-15")).toEqual({ iso: "2026-08-04", flagged: false });
  });

  it("MANDATORY: statement dated 15 Dec 2026 with due date '04/01' resolves to 4 Jan 2027", () => {
    expect(resolveDueDate("04/01", "2026-12-15")).toEqual({ iso: "2027-01-04", flagged: false });
  });

  it("resolves '07/03/2026' on a 15 Feb 2026 statement to 7 March (20 days), never 3 July", () => {
    expect(resolveDueDate("07/03/2026", "2026-02-15")).toEqual({ iso: "2026-03-07", flagged: false });
  });

  it("palindromic '05/05/2026' parses without a flag (both readings identical)", () => {
    expect(resolveDueDate("05/05/2026", "2026-04-15")).toEqual({ iso: "2026-05-05", flagged: false });
  });

  it("parses month-name due dates ('08 JUN 26', '28 JUL 26')", () => {
    expect(resolveDueDate("08 JUN 26", "2026-05-19")).toEqual({ iso: "2026-06-08", flagged: false });
    expect(resolveDueDate("28 JUL 26", "2026-07-08")).toEqual({ iso: "2026-07-28", flagged: false });
  });

  it("flags a due date with no reading inside the window", () => {
    expect(resolveDueDate("01/01/2026", "2026-06-15").flagged).toBe(true);
  });
});
