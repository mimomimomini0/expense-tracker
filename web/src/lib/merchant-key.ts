/** Merchant grouping key for the confirmation queue (FR-7):
 *  uppercase, whitespace collapsed, trailing COUNTRY token stripped.
 *  e.g. "GRABFOOD*  Kuala Lumpur   MY" -> "GRABFOOD* KUALA LUMPUR"
 *
 *  MUST stay byte-identical to merchantKey() in ../../../src/classify.ts —
 *  the classification scripts and this UI group the same rows, and a drift
 *  would split or merge queue groups inconsistently. Only known country
 *  tokens are stripped (never any 2-letter word: "... SB"/"... DT" are
 *  legitimate merchant endings). */
const COUNTRY_TAIL = /\s+(MY|SG|CN|HK|TW|US|SE|GB|AU|JP|TH|ID)\.?$/;

export function merchantKey(descriptionRaw: string): string {
  const normalized = descriptionRaw.toUpperCase().replace(/\s+/g, " ").trim();
  return normalized.replace(COUNTRY_TAIL, "").trim();
}
