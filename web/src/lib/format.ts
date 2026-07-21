/** Formatting helpers. Money is always "RM 1,234.56"; dates are YYYY-MM-DD in
 *  Asia/Kuala_Lumpur. Safe to use on server and client. */

const RM_FORMAT = new Intl.NumberFormat("en-MY", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

export function formatRM(amount: number | string): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  return `RM ${RM_FORMAT.format(Number.isFinite(n) ? n : 0)}`;
}

const KL_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kuala_Lumpur",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

/** Postgres `date` columns arrive as "YYYY-MM-DD" strings — pass through
 *  verbatim. Date objects / timestamps are rendered in Asia/Kuala_Lumpur. */
export function formatDate(value: string | Date | null | undefined): string {
  if (value == null) return "";
  if (typeof value === "string") {
    return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value;
  }
  return KL_DATE.format(value);
}

/** Card label: display_name if set, else "Bank ••1234". Never translated. */
export function cardLabel(card: {
  display_name: string | null;
  bank_name: string;
  last4: string;
}): string {
  return card.display_name ?? `${card.bank_name} ••${card.last4}`;
}
