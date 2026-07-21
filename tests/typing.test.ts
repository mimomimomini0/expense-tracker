// FR-5 transaction typing unit tests — the payment-vs-refund hard rule and
// the direction rules, using the real fixture descriptions.

import { describe, expect, it } from "vitest";
import { classifyTransaction, parseInstalmentProgress } from "../src/typing.js";

describe("payment vs refund disambiguation (CR rows)", () => {
  it("payment descriptors type as payment", () => {
    for (const d of [
      "TRANSFER / TOP-UP THANK YOU-CLICKS",
      "DUITNOW TO ACCOUNT",
      "PYMT VIA SA/CA ACCOUNT",
      "CASH PAYMENT AT D591",
      "PAYMENT REC'D WITH THANKS-DUITNOW",
    ]) {
      expect(classifyTransaction(d, "credit"), d).toBe("payment");
    }
  });

  it("merchant-named CR rows type as refund, never payment", () => {
    for (const d of [
      "LAZADA.COM.MY KUALA LUMPUR MYS",
      "WEIXIN*China Housing SHENZHEN CHN",
    ]) {
      expect(classifyTransaction(d, "credit"), d).toBe("refund");
    }
  });
});

describe("direction rules (hard)", () => {
  it("a DR row is never typed payment", () => {
    // even with payment-like wording, a debit is not a payment
    expect(classifyTransaction("DUITNOW TO ACCOUNT", "debit")).not.toBe("payment");
  });

  it("CASH PAYMENT AT D591 as CR is payment, not cash_advance", () => {
    expect(classifyTransaction("CASH PAYMENT AT D591", "credit")).toBe("payment");
  });

  it("cash advance is DR only", () => {
    expect(classifyTransaction("CASH ADVANCE", "debit")).toBe("cash_advance");
    expect(classifyTransaction("CASH ADVANCE", "credit")).not.toBe("cash_advance");
  });
});

describe("fees and instalments", () => {
  it("fee/interest rows", () => {
    for (const d of ["LATE CHARGES", "FINANCE CHARGES", "CARD SERVICE TAX"]) {
      expect(classifyTransaction(d, "debit"), d).toBe("fee_interest");
    }
  });

  it("instalment rows with NN/MM progress", () => {
    expect(classifyTransaction("EP-OGAWA-36MTHS : 03/36", "debit")).toBe("instalment");
  });

  it("parses instalment progress", () => {
    expect(parseInstalmentProgress("EP-OGAWA-36MTHS : 03/36")).toEqual({
      base: "EP-OGAWA", nn: 3, mm: 36,
    });
    expect(parseInstalmentProgress("EP-OGAWA-36MTHS : 01/36")).toEqual({
      base: "EP-OGAWA", nn: 1, mm: 36,
    });
  });
});
