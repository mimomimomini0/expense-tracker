// Touch 'n Go eWallet / TNG card transaction-history input (owner request,
// 20 Jul 2026 — see TNG-EWALLET-NOTES.md).
//
// A transaction-history PDF can contain MULTIPLE card sections (like RHB's
// principal + supplementary pattern), each with its own printed summary and
// its own transaction table. Reconciliation runs per card: the full row-by-row
// running-balance chain plus the printed summary cross-checks.
//
// Model (owner-approved): Usage rows are EXPENSES; Reload rows are TRANSFERS
// and never count as expenses (a card-funded reload already appears on the
// card statement). Description = Exit Location (fallback Entry Location);
// Sector is the category hint.

import { z } from "zod";
import { cachedCall, type Extractor, type LlmCallOutcome, type LlmUsage } from "./llm.js";
import { toSen, type Sen } from "./money.js";

// ---------------- extraction shape ----------------

const opt = <T extends z.ZodTypeAny>(t: T) =>
  t.nullish().transform((v): z.infer<T> | null => (v === undefined ? null : v));

const tngRowZ = z.object({
  trans_no: opt(z.union([z.string(), z.number()]).transform(String)),
  trans_datetime: z.string(),
  posted_date: opt(z.string()),
  trans_type: z.string(),
  sector: opt(z.string()),
  entry_location: opt(z.string()),
  exit_location: opt(z.string()),
  reload_location: opt(z.string()),
  amount_rm: z.number(),
  balance_after_rm: z.number(),
});

const tngCardZ = z.object({
  card_serial: z.string(),
  card_type: opt(z.string()),
  summary: opt(
    z.object({
      reload_count: opt(z.number()),
      reload_total_rm: opt(z.number()),
      usage_count: opt(z.number()),
      usage_total_rm: opt(z.number()),
      other_charges_rm: opt(z.number()),
      card_balance_rm: opt(z.number()),
    }),
  ),
  rows: z.array(tngRowZ),
});

export const tngExtractionZ = z.object({
  doc_type: z.enum(["ewallet_statement", "other"]),
  provider: opt(z.string()),
  account_no: opt(z.string()),
  registered_name: opt(z.string()),
  period_start: opt(z.string()),
  period_end: opt(z.string()),
  cards: z.array(tngCardZ),
});

export type TngExtraction = z.infer<typeof tngExtractionZ>;
export type TngCard = z.infer<typeof tngCardZ>;

export const TNG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["doc_type", "cards"],
  properties: {
    doc_type: { enum: ["ewallet_statement", "other"] },
    provider: { type: "string", description: "e.g. Touch 'n Go" },
    account_no: { type: "string" },
    registered_name: { type: "string" },
    period_start: { type: "string", description: "Transaction period start, YYYY-MM-DD" },
    period_end: { type: "string", description: "Transaction period end, YYYY-MM-DD" },
    cards: {
      type: "array",
      description: "One entry per CARD SECTION. Each section starts with a card summary line (Card Type / Card Serial No. / No. of Reload / Reload Amount / No. of Usage / Usage Amount / Other Charges / Card Balance) followed by that card's own transaction table.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["card_serial", "rows"],
        properties: {
          card_serial: { type: "string" },
          card_type: { type: "string", description: "e.g. 'Pickleball Ext Charm Pink', 'GENERIC CARD 3.0'" },
          summary: {
            type: "object",
            additionalProperties: false,
            required: [],
            properties: {
              reload_count: { type: "number" },
              reload_total_rm: { type: "number" },
              usage_count: { type: "number" },
              usage_total_rm: { type: "number" },
              other_charges_rm: { type: "number" },
              card_balance_rm: { type: "number" },
            },
            description: "The printed summary for THIS card, exactly as printed.",
          },
          rows: {
            type: "array",
            description: "EVERY transaction row of this card's table, in the printed order (newest first). Do not skip, merge, or invent rows.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["trans_datetime", "trans_type", "amount_rm", "balance_after_rm"],
              properties: {
                trans_no: { type: "string" },
                trans_datetime: { type: "string", description: "'YYYY-MM-DD HH:MM:SS'" },
                posted_date: { type: "string", description: "YYYY-MM-DD. OMIT if absent" },
                trans_type: { type: "string", description: "Trans. Type exactly as printed (Usage, Reload, ...)" },
                sector: { type: "string", description: "Sector column (PARKING, TOLL, INTERNET RELOAD, ...)" },
                entry_location: { type: "string", description: "Entry Location. OMIT if blank" },
                exit_location: { type: "string", description: "Exit Location. OMIT if blank" },
                reload_location: { type: "string", description: "Reload Location. OMIT if blank" },
                amount_rm: { type: "number", description: "Trans. Amount (RM), always positive" },
                balance_after_rm: { type: "number", description: "Balance (RM) — the card balance AFTER this transaction" },
              },
            },
          },
        },
      },
    },
  },
} as const;

const TNG_PROMPT = `You are a semantic extractor for Touch 'n Go eWallet / TNG card transaction histories. Read the ENTIRE PDF. The document may contain MULTIPLE card sections — each begins with a card summary line (Card Type, Card Serial No., counts and totals) followed by that card's own transaction table. Extract every card section and every row. Rules:
- NEVER invent or skip rows. Tables list transactions NEWEST FIRST — keep that order.
- Assign each row to the card section it belongs to.
- Each row's Balance column is the card balance AFTER that transaction.
- Copy Trans. Type, Sector and locations exactly as printed (normalise internal line breaks to single spaces).
- OMIT optional fields that are blank. amount_rm is always positive.`;

export async function extractTng(
  pdf: Buffer,
  fileHash: string,
): Promise<LlmCallOutcome<TngExtraction>> {
  // ~260 rows of JSON plus thinking: give the output plenty of headroom
  return cachedCall(pdf, fileHash, "tng", TNG_PROMPT, "Extract the transaction history.", TNG_SCHEMA, (r) =>
    tngExtractionZ.parse(r), 100000,
  );
}

// ---------------- resolution + reconciliation ----------------

export type TngRowKind = "usage" | "reload" | "other";

export interface ResolvedTngRow {
  card_serial: string;
  trans_no: string | null;
  trans_date: string;
  trans_datetime: string;
  posted_date: string | null;
  kind: TngRowKind;
  trans_type_raw: string;
  sector: string | null;
  description: string;
  reload_source: string | null;
  amount: Sen;
  balance_after: Sen;
}

export interface TngCardReconciliation {
  card_serial: string;
  ok: boolean;
  problems: string[];
  chainChecked: number;
  usageCount: number;
  usageTotal: Sen;
  reloadCount: number;
  reloadTotal: Sen;
  otherCount: number;
  otherTotal: Sen;
  closingBalance: Sen;
  derivedOpeningBalance: Sen;
}

export function classifyTngRow(transType: string): TngRowKind {
  const t = transType.trim().toUpperCase();
  if (t.startsWith("USAGE")) return "usage";
  if (t.includes("RELOAD")) return "reload";
  return "other";
}

export function resolveTngCard(card: TngCard): ResolvedTngRow[] {
  const clean = (s: string | null) => (s ? s.replace(/\s+/g, " ").trim() : null);
  return card.rows.map((r) => {
    const kind = classifyTngRow(r.trans_type);
    const exit = clean(r.exit_location);
    const entry = clean(r.entry_location);
    const reloadLoc = clean(r.reload_location);
    // Owner decision: Exit Location identifies the transaction better than Entry.
    const description =
      (kind === "reload" ? clean(r.sector) ?? reloadLoc ?? exit : exit ?? entry) ??
      reloadLoc ?? entry ?? clean(r.sector) ?? r.trans_type;
    return {
      card_serial: card.card_serial,
      trans_no: r.trans_no,
      trans_date: r.trans_datetime.slice(0, 10),
      trans_datetime: r.trans_datetime,
      posted_date: r.posted_date ? r.posted_date.slice(0, 10) : null,
      kind,
      trans_type_raw: r.trans_type.trim(),
      sector: clean(r.sector),
      description,
      reload_source: kind === "reload" ? clean(r.sector) ?? reloadLoc : null,
      amount: toSen(r.amount_rm),
      balance_after: toSen(r.balance_after_rm),
    };
  });
}

function signed(row: ResolvedTngRow): Sen {
  return row.kind === "reload" ? row.amount : -row.amount;
}

export function reconcileTngCard(card: TngCard, rows: ResolvedTngRow[]): TngCardReconciliation {
  const problems: string[] = [];
  let usageCount = 0, usageTotal = 0, reloadCount = 0, reloadTotal = 0, otherCount = 0, otherTotal = 0;
  for (const r of rows) {
    if (r.kind === "usage") { usageCount++; usageTotal += r.amount; }
    else if (r.kind === "reload") { reloadCount++; reloadTotal += r.amount; }
    else { otherCount++; otherTotal += r.amount; }
  }

  let chainChecked = 0;
  for (let i = 0; i + 1 < rows.length; i++) {
    const newer = rows[i]!;
    const older = rows[i + 1]!;
    if (older.balance_after + signed(newer) !== newer.balance_after) {
      problems.push(
        `card ${card.card_serial}: balance chain broken at ${newer.trans_datetime} (${newer.description})`,
      );
    } else {
      chainChecked++;
    }
  }

  const closingBalance = rows.length > 0 ? rows[0]!.balance_after : 0;
  const oldest = rows[rows.length - 1];
  const derivedOpeningBalance = oldest ? oldest.balance_after - signed(oldest) : 0;

  const s = card.summary;
  if (s) {
    const check = (label: string, printed: number | null, actual: number, isMoney: boolean) => {
      if (printed == null) return;
      const printedCmp = isMoney ? toSen(printed) : printed;
      if (printedCmp !== actual) {
        problems.push(`card ${card.card_serial}: printed ${label} ${printed} != extracted ${isMoney ? actual / 100 : actual}`);
      }
    };
    check("reload count", s.reload_count, reloadCount, false);
    check("reload total", s.reload_total_rm, reloadTotal, true);
    check("usage count", s.usage_count, usageCount, false);
    check("usage total", s.usage_total_rm, usageTotal, true);
    check("card balance", s.card_balance_rm, closingBalance, true);
  } else {
    problems.push(`card ${card.card_serial}: no printed summary found to cross-check`);
  }

  if (derivedOpeningBalance + reloadTotal - usageTotal - otherTotal !== closingBalance) {
    problems.push(`card ${card.card_serial}: global equation opening + reloads - usage - other != closing`);
  }

  return {
    card_serial: card.card_serial,
    ok: problems.length === 0,
    problems,
    chainChecked,
    usageCount, usageTotal, reloadCount, reloadTotal, otherCount, otherTotal,
    closingBalance, derivedOpeningBalance,
  };
}

export interface TngImportResult {
  filename: string;
  outcome: "parsed_ok" | "needs_review" | "rejected_not_ewallet";
  extraction: TngExtraction | null;
  rows: ResolvedTngRow[]; // all cards, flattened
  cards: TngCardReconciliation[];
  usages: { gate: LlmUsage; extract: LlmUsage | null };
  detail?: string;
}

/** Full TNG parse: gate -> extract -> resolve -> reconcile per card. Pure of storage. */
export async function parseTngPdf(
  extractor: Extractor,
  filename: string,
  pdf: Buffer,
  fileHash: string,
): Promise<TngImportResult> {
  const gate = await extractor.gate(pdf, fileHash);
  if (gate.result.doc_type !== "ewallet_statement") {
    return {
      filename, outcome: "rejected_not_ewallet", extraction: null, rows: [], cards: [],
      usages: { gate: gate.usage, extract: null },
      detail: `not an e-wallet transaction history (${gate.result.reason})`,
    };
  }
  const ext = await extractTng(pdf, fileHash);
  const rows: ResolvedTngRow[] = [];
  const cards: TngCardReconciliation[] = [];
  for (const card of ext.result.cards) {
    const cardRows = resolveTngCard(card);
    rows.push(...cardRows);
    cards.push(reconcileTngCard(card, cardRows));
  }
  const ok = cards.length > 0 && cards.every((c) => c.ok);
  return {
    filename,
    outcome: ok ? "parsed_ok" : "needs_review",
    extraction: ext.result,
    rows, cards,
    usages: { gate: gate.usage, extract: ext.usage },
    detail: ok ? undefined : cards.flatMap((c) => c.problems).slice(0, 5).join(" | "),
  };
}
