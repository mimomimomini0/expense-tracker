// FR-5 transaction typing. Deterministic rules over description + direction.
//
// Hard rules from the spec:
//  - A CR row is a `payment` only if its description carries a payment
//    descriptor; a CR row carrying a merchant name is a `refund`.
//  - A `payment` row is always CR; a DR row is never typed payment
//    ("CASH PAYMENT AT D591" is CR -> payment, never cash_advance).
//  - A `cash_advance` row is always DR.

import type { TxnType } from "./types.js";

const PAYMENT_DESCRIPTORS: RegExp[] = [
  /\bPYMT\b/i,
  /PAYMENT\s+REC'?D/i,
  /CASH\s+PAYMENT\b/i,
  /\bPAYMENT\b.*\b(THANK|VIA|RECEIVED|COUNTER|BRANCH)\b/i,
  /THANK\s*YOU/i,
  /\bDUITNOW\b/i,
  /TRANSFER\s*\/\s*TOP-?UP/i,
  /\bTOP-?UP\b.*CLICKS/i,
  /VIA\s+SA\/?CA/i,
  /\bIBG\b.*PAYMENT/i,
  /AUTO\s*DEBIT.*PAYMENT/i,
];

const FEE_INTEREST: RegExp[] = [
  /LATE\s+CHARGE/i,
  /FINANCE\s+CHARGE/i,
  /SERVICE\s+TAX/i,
  /ANNUAL\s+FEE/i,
  /INTEREST\s+CHARGE/i,
  /\bSST\b/i,
  /GOVERNMENT\s+TAX/i,
];

const INSTALMENT: RegExp[] = [
  /\b\d{1,2}\/\d{1,2}\b.*MTH/i,
  /MTHS?\s*[:\-]?\s*\d{1,2}\/\d{1,2}/i,
  /^EP[-\s]/i,
  /INSTAL?MENT/i,
  /FLEXI\s*PAY/i,
];

// e.g. "EP-OGAWA-36MTHS : 03/36"
export const INSTALMENT_PROGRESS = /(\d{1,2})\s*\/\s*(\d{1,2})\s*$/;

const CASH_ADVANCE: RegExp[] = [/CASH\s+ADVANCE/i, /\bATM\s+WITHDRAWAL/i];

export function classifyTransaction(description: string, direction: "debit" | "credit"): TxnType {
  const d = description.trim();

  if (direction === "credit") {
    // payment vs refund disambiguation (hard rule)
    if (PAYMENT_DESCRIPTORS.some((re) => re.test(d))) return "payment";
    return "refund";
  }

  // debit rows — never payment
  if (FEE_INTEREST.some((re) => re.test(d))) return "fee_interest";
  if (INSTALMENT.some((re) => re.test(d)) && INSTALMENT_PROGRESS.test(d)) return "instalment";
  if (CASH_ADVANCE.some((re) => re.test(d))) return "cash_advance";
  return "purchase";
}

/** Parse "EP-OGAWA-36MTHS : 03/36" -> { base: "EP-OGAWA", nn: 3, mm: 36 } */
export function parseInstalmentProgress(
  description: string,
): { base: string; nn: number; mm: number } | null {
  const m = description.match(INSTALMENT_PROGRESS);
  if (!m) return null;
  const nn = +m[1]!;
  const mm = +m[2]!;
  if (nn < 1 || mm < 1 || nn > mm) return null;
  let base = description.slice(0, m.index).replace(/[\s:.-]+$/, "").trim();
  // strip a trailing "-36MTHS" style token from the plan name
  base = base.replace(/[-\s]\d{1,3}\s*MTHS?$/i, "").trim();
  return { base, nn, mm };
}
