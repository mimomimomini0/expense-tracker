// All monetary arithmetic is done in integer sen to guarantee exactness "to the sen".
// RM values cross this boundary only at extraction (parse) and display (format).

export type Sen = number; // always an integer number of sen; negative = CR balance

export function toSen(amountRm: number): Sen {
  return Math.round(amountRm * 100);
}

export function senToRmNumber(sen: Sen): number {
  return sen / 100;
}

export function formatRm(sen: Sen): string {
  const sign = sen < 0 ? "-" : "";
  const abs = Math.abs(sen);
  const whole = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, "0");
  return `${sign}${whole.toLocaleString("en-MY")}.${cents}`;
}
