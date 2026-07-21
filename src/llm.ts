// LLM layer: document-type gate + semantic extraction (layout-agnostic, FR-2).
// Model: Sonnet-class per the kickoff. Exact model string is recorded per call.
// Results are cached on disk keyed by (file hash, kind, prompt version) so the
// regression harness replays deterministically without re-billing the API.

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ExtractionResult, GateResult } from "./types.js";

export const MODEL = "claude-sonnet-5";
export const PROMPT_VERSION = "p1";

// Claude Sonnet 5 introductory pricing (through 2026-08-31): $2/M in, $10/M out.
const USD_PER_M_IN = 2;
const USD_PER_M_OUT = 10;
const USD_TO_RM = 4.7; // approximate, for FR-17 display only

export interface LlmUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  estCostUsd: number;
  estCostRm: number;
  fromCache: boolean;
}

export function costOf(tokensIn: number, tokensOut: number): { usd: number; rm: number } {
  const usd = (tokensIn / 1e6) * USD_PER_M_IN + (tokensOut / 1e6) * USD_PER_M_OUT;
  return { usd, rm: usd * USD_TO_RM };
}

// ---------------- zod validation of the model output ----------------

// The structured-outputs API caps union-typed (nullable) parameters at 16 per
// schema, so "not printed" is expressed by OMITTING the field, not by null.
// This helper normalises omitted fields back to null for the domain types.
const opt = <T extends z.ZodTypeAny>(t: T) =>
  t.nullish().transform((v): z.infer<T> | null => (v === undefined ? null : v));

const txnZ = z.object({
  txn_date_raw: z.string(),
  posting_date_raw: opt(z.string()),
  description: z.string(),
  amount_rm: z.number(),
  direction: z.enum(["debit", "credit"]),
  original_currency: opt(z.string()),
  original_amount: opt(z.number()),
});

const cardZ = z.object({
  card_number_masked: z.string(),
  last4: z.string(),
  holder_name: opt(z.string()),
  opening_balance_rm: z.number(),
  closing_balance_rm: z.number(),
  minimum_due_rm: opt(z.number()),
  credit_limit_rm: opt(z.number()),
  retail_interest_rate_pct: opt(z.number()),
  summary_totals: opt(
    z.object({
      total_debits_rm: opt(z.number()),
      total_credits_rm: opt(z.number()),
      retail_purchase_rm: opt(z.number()),
      cash_advance_rm: opt(z.number()),
    }),
  ),
  instalment_summaries: z.array(
    z.object({
      plan_name: z.string(),
      total_months: opt(z.number()),
      monthly_amount_rm: opt(z.number()),
      principal_rm: opt(z.number()),
      outstanding_principal_rm: opt(z.number()),
    }),
  ),
  transactions: z.array(txnZ),
});

export const extractionZ = z.object({
  doc_type: z.enum(["credit_card_statement", "contains_credit_card_statement", "other"]),
  bank: opt(z.string()),
  statement_date: opt(z.string()),
  payment_due_date_raw: opt(z.string()),
  statement_period_start: opt(z.string()),
  statement_period_end: opt(z.string()),
  cards: z.array(cardZ),
});

const gateZ = z.object({
  doc_type: z.enum([
    "credit_card_statement", "contains_credit_card_statement", "ewallet_statement", "other",
  ]),
  bank_guess: opt(z.string()),
  reason: z.string(),
});

// ---------------- JSON schemas for structured outputs ----------------

// NOTE: the structured-outputs API limits union-typed parameters (type arrays /
// anyOf) to 16 per schema. "Not printed" fields are therefore OPTIONAL (omitted
// from `required`) rather than nullable; the zod layer maps omission -> null.

const TXN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["txn_date_raw", "description", "amount_rm", "direction"],
  properties: {
    txn_date_raw: { type: "string", description: "Transaction date exactly as printed, e.g. '19 APR' or '27 Jun'" },
    posting_date_raw: { type: "string", description: "Posting date as printed. OMIT if the statement has no posting date column" },
    description: { type: "string", description: "Raw description exactly as printed (merge multi-line descriptions of ONE transaction)" },
    amount_rm: { type: "number", description: "RM amount, always positive" },
    direction: { enum: ["debit", "credit"], description: "credit for CR / '-' / parenthesized amounts (payments, refunds); debit otherwise" },
    original_currency: { type: "string", description: "For FX rows only: ISO 4217 alpha code (CNY, HKD, TWD, USD...). Numeric prefixes map: 840=USD, 344=HKD, 901=TWD, 156=CNY, 702=SGD, 392=JPY, 764=THB, 826=GBP, 978=EUR, 036=AUD. OMIT for RM rows." },
    original_amount: { type: "number", description: "Foreign-currency amount for FX rows only. OMIT otherwise" },
  },
} as const;

const CARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "card_number_masked", "last4", "opening_balance_rm", "closing_balance_rm",
    "instalment_summaries", "transactions",
  ],
  properties: {
    card_number_masked: { type: "string" },
    last4: { type: "string", description: "Last 4 digits of the card number" },
    holder_name: { type: "string", description: "Cardholder name as printed. OMIT if not printed" },
    opening_balance_rm: { type: "number", description: "Previous/opening balance. NEGATIVE if printed as CR (credit balance)" },
    closing_balance_rm: { type: "number", description: "Closing/statement balance. NEGATIVE if printed as CR" },
    minimum_due_rm: { type: "number", description: "Minimum payment due. OMIT if not printed for this card" },
    credit_limit_rm: { type: "number", description: "Credit limit. OMIT if not printed" },
    retail_interest_rate_pct: { type: "number", description: "Printed retail interest rate, e.g. 15.00 from 'CURRENT RETAIL INTEREST IS 15.00%'. OMIT if not printed" },
    summary_totals: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        total_debits_rm: { type: "number" },
        total_credits_rm: { type: "number" },
        retail_purchase_rm: { type: "number" },
        cash_advance_rm: { type: "number" },
      },
      description: "Summary totals where printed on the statement (e.g. UOB's Previous Balance / Retail Purchase box). Include only the fields actually printed; OMIT the whole object if none are.",
    },
    instalment_summaries: {
      type: "array",
      description: "Instalment plan summary table rows if the statement prints one (plan name, principal, outstanding principal, months). Empty array if none.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["plan_name"],
        properties: {
          plan_name: { type: "string" },
          total_months: { type: "number" },
          monthly_amount_rm: { type: "number" },
          principal_rm: { type: "number" },
          outstanding_principal_rm: { type: "number" },
        },
      },
    },
    transactions: { type: "array", items: TXN_SCHEMA },
  },
} as const;

export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["doc_type", "cards"],
  properties: {
    doc_type: {
      enum: ["credit_card_statement", "contains_credit_card_statement", "other"],
      description: "other = NOT a credit card statement (current/savings account, invoice, receipt, anything else)",
    },
    bank: { type: "string", description: "Issuing bank name, e.g. CIMB, RHB, UOB" },
    statement_date: { type: "string", description: "Statement date as YYYY-MM-DD (the year IS printed on the statement)" },
    payment_due_date_raw: { type: "string", description: "Payment due date EXACTLY as printed, e.g. '04/08/2026' or '08 JUN 26' — do not reinterpret" },
    statement_period_start: { type: "string", description: "YYYY-MM-DD if the statement prints a period start. OMIT otherwise" },
    statement_period_end: { type: "string", description: "YYYY-MM-DD if the statement prints a period end. OMIT otherwise" },
    cards: { type: "array", items: CARD_SCHEMA },
  },
} as const;

export const GATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["doc_type", "reason"],
  properties: {
    doc_type: { enum: ["credit_card_statement", "contains_credit_card_statement", "ewallet_statement", "other"] },
    bank_guess: { type: "string", description: "Issuing bank/institution if identifiable. OMIT if unknown" },
    reason: { type: "string" },
  },
} as const;

// ---------------- prompts ----------------

const GATE_PROMPT = `You are a document-type gate for an expense tracker.
Classify this PDF by DOCUMENT TYPE only — never by whether the issuer looks familiar:
- "credit_card_statement": a credit card statement (any bank, any layout, any era).
- "contains_credit_card_statement": a combined mailing that bundles a credit card statement with other content.
- "ewallet_statement": an e-wallet / prepaid-card transaction history (e.g. Touch 'n Go eWallet or TNG card) with reload and usage rows and a wallet balance.
- "other": anything else — bank CURRENT/SAVINGS/deposit account statements (running-balance column, account number instead of card number), invoices, receipts, contracts, letters, random documents.
A deposit/current account statement from a bank that also issues credit cards is still "other".`;

const EXTRACT_PROMPT = `You are a semantic extractor for Malaysian credit card statements. Read the ENTIRE PDF (transactions may start on any page, e.g. page 5 after announcements) and extract the data per the schema. Rules:
- NEVER invent rows. NEVER guess values — OMIT optional fields that are not printed on the statement.
- Layout-agnostic: rely on meaning, not position. Bank layouts differ across banks and across years.
- Amounts printed with "CR", "-", or parentheses are credits (direction "credit"); amount_rm is always positive.
- Balances (opening/closing) printed with CR are NEGATIVE numbers.
- FX transactions may span TWO printed lines (foreign amount line + RM line): output them as ONE transaction with the RM value in amount_rm and the foreign currency/amount in original_currency/original_amount. Currency may be given by name or by numeric ISO 4217 prefix (e.g. "840U.S. DOLLAR", "344HONG KONG DOLLAR", "901NEW TAIWAN DOLLAR") — map to the alpha code.
- Promo text, announcements, T&C, reward-point summaries interleaved between rows are NOT transactions.
- A statement may contain MULTIPLE card sections (principal + supplementary cards): one entry in "cards" per card number, each with its own balances and transactions. Include card sections with zero activity (opening/closing printed, no rows).
- Dates inside transaction rows: copy them EXACTLY as printed into txn_date_raw / posting_date_raw (no year inference — downstream code resolves years).
- Copy the payment due date exactly as printed into payment_due_date_raw.
- Include every transaction row, including duplicates at the same merchant on the same day (both are real).
- Include summary totals and instalment summary tables where printed.
- statement_date: the statement date with its printed year, formatted YYYY-MM-DD.`;

// ---------------- client + cache ----------------

function projectRoot(): string {
  return path.resolve(import.meta.dirname, "..");
}

export function cacheDir(): string {
  return path.join(projectRoot(), "fixtures", "extractions");
}

export function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

interface CachedCall<T> {
  model: string;
  prompt_version: string;
  kind: string;
  usage: { input_tokens: number; output_tokens: number };
  result: T;
}

function cachePath(fileHash: string, kind: string): string {
  return path.join(cacheDir(), `${fileHash.slice(0, 16)}.${kind}.${PROMPT_VERSION}.json`);
}

function readCache<T>(fileHash: string, kind: string): CachedCall<T> | null {
  const p = cachePath(fileHash, kind);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as CachedCall<T>;
  } catch {
    return null;
  }
}

function writeCache<T>(fileHash: string, kind: string, data: CachedCall<T>): void {
  fs.mkdirSync(cacheDir(), { recursive: true });
  fs.writeFileSync(cachePath(fileHash, kind), JSON.stringify(data, null, 1), "utf8");
}

/** FR-17: the API is only callable after the owner has confirmed the batch cost. */
export function apiApproved(): boolean {
  return process.env.EXPENSE_ALLOW_API === "1" || fs.existsSync(path.join(cacheDir(), ".api-approved"));
}

export function markApiApproved(): void {
  fs.mkdirSync(cacheDir(), { recursive: true });
  fs.writeFileSync(path.join(cacheDir(), ".api-approved"), new Date().toISOString(), "utf8");
}

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

// Extract the JSON object from a model response that should be JSON-only but
// may be wrapped in markdown fences or stray prose.
function parseJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start === -1 || end <= start) throw new Error("response contains no JSON object");
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch (err) {
      // keep the raw response for diagnosis — parse failures on long documents
      // are otherwise invisible
      fs.mkdirSync(cacheDir(), { recursive: true });
      fs.writeFileSync(path.join(cacheDir(), "debug-last-parse-failure.txt"), text, "utf8");
      throw err;
    }
  }
}

// The grammar-enforced structured-outputs mode rejects a schema of this size
// ("Schema is too complex"), so the schema is embedded in the prompt instead
// and the output is validated with zod. Per spec FR-2, invalid JSON triggers
// one retry, then the statement is flagged as failed.
async function callStructured<T>(
  pdf: Buffer,
  system: string,
  userText: string,
  schema: object,
  validate: (raw: unknown) => T,
  maxTokens = 32000,
): Promise<{ result: T; usage: { input_tokens: number; output_tokens: number }; model: string }> {
  const fullSystem =
    `${system}\n\nRespond with a SINGLE JSON object conforming exactly to this JSON Schema — ` +
    `no markdown fences, no commentary, JSON only:\n${JSON.stringify(schema)}`;

  const attemptOnce = async () => {
    const stream = client().messages.stream({
      model: MODEL,
      max_tokens: maxTokens,
      system: fullSystem,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") },
            },
            { type: "text", text: userText },
          ],
        },
      ],
    });
    const resp = await stream.finalMessage();
    if (resp.stop_reason === "refusal") throw new Error("model refused the request");
    if (resp.stop_reason === "max_tokens") {
      throw new Error(`output truncated at max_tokens=${maxTokens} — raise the budget for this document`);
    }
    const text = resp.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("no text block in response");
    return {
      result: validate(parseJsonPayload(text.text)),
      usage: { input_tokens: resp.usage.input_tokens, output_tokens: resp.usage.output_tokens },
      model: resp.model,
    };
  };

  try {
    return await attemptOnce();
  } catch (err) {
    // one retry on invalid/unparseable JSON or transient failure (FR-2)
    await new Promise((res) => setTimeout(res, 2000));
    return await attemptOnce();
  }
}

export interface LlmCallOutcome<T> {
  result: T;
  usage: LlmUsage;
}

export async function cachedCall<T>(
  pdf: Buffer,
  fileHash: string,
  kind: string,
  system: string,
  userText: string,
  schema: object,
  validate: (raw: unknown) => T,
  maxTokens?: number,
): Promise<LlmCallOutcome<T>> {
  const hit = readCache<T>(fileHash, kind);
  if (hit) {
    const { usd, rm } = costOf(hit.usage.input_tokens, hit.usage.output_tokens);
    return {
      result: validate(hit.result),
      usage: {
        model: hit.model, tokensIn: hit.usage.input_tokens, tokensOut: hit.usage.output_tokens,
        estCostUsd: usd, estCostRm: rm, fromCache: true,
      },
    };
  }
  if (!apiApproved()) {
    throw new Error(
      `No cached ${kind} extraction for this file and API use has not been approved. ` +
        `Run "npm run extract-fixtures" first (it shows the estimated cost and asks for confirmation).`,
    );
  }
  const { result, usage, model } = await callStructured(pdf, system, userText, schema, validate, maxTokens);
  writeCache(fileHash, kind, { model, prompt_version: PROMPT_VERSION, kind, usage, result });
  const { usd, rm } = costOf(usage.input_tokens, usage.output_tokens);
  return {
    result,
    usage: {
      model, tokensIn: usage.input_tokens, tokensOut: usage.output_tokens,
      estCostUsd: usd, estCostRm: rm, fromCache: false,
    },
  };
}

// ---------------- public API ----------------

export interface Extractor {
  gate(pdf: Buffer, fileHash: string): Promise<LlmCallOutcome<GateResult>>;
  extract(pdf: Buffer, fileHash: string, feedback: string | null): Promise<LlmCallOutcome<ExtractionResult>>;
}

export class CachingExtractor implements Extractor {
  async gate(pdf: Buffer, fileHash: string): Promise<LlmCallOutcome<GateResult>> {
    return cachedCall(pdf, fileHash, "gate", GATE_PROMPT, "Classify this document.", GATE_SCHEMA, (r) =>
      gateZ.parse(r),
    );
  }

  async extract(
    pdf: Buffer,
    fileHash: string,
    feedback: string | null,
  ): Promise<LlmCallOutcome<ExtractionResult>> {
    const kind = feedback ? "reparse" : "extract";
    const userText = feedback
      ? `Extract the statement data.\n\nIMPORTANT — a previous extraction FAILED arithmetic reconciliation:\n${feedback}\nRe-examine the statement carefully, paying particular attention to missed rows, sign errors (CR vs DR), and two-line FX entries that must be a single transaction.`
      : "Extract the statement data.";
    return cachedCall(pdf, fileHash, kind, EXTRACT_PROMPT, userText, EXTRACTION_SCHEMA, (r) =>
      extractionZ.parse(r),
    );
  }
}

/** Token-count a fixture set for the FR-17 cost estimate (count_tokens is free). */
export async function estimateBatchCost(
  files: { name: string; pdf: Buffer }[],
): Promise<{ perFile: { name: string; tokensIn: number }[]; totalIn: number; estOutPerFile: number; usd: number; rm: number }> {
  const perFile: { name: string; tokensIn: number }[] = [];
  for (const f of files) {
    const count = async () => client().messages.countTokens({
      model: MODEL,
      system: EXTRACT_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: f.pdf.toString("base64") },
            },
            { type: "text", text: "Extract the statement data." },
          ],
        },
      ],
    });
    let r;
    try {
      r = await count();
    } catch {
      await new Promise((res) => setTimeout(res, 3000)); // one retry on transient errors
      r = await count();
    }
    perFile.push({ name: f.name, tokensIn: r.input_tokens });
  }
  const totalIn = perFile.reduce((s, f) => s + f.tokensIn, 0);
  const estOutPerFile = 5000; // generous per-statement output estimate (JSON + thinking)
  // Each file is gated (same PDF, tiny output) + extracted: roughly 2x input.
  const { usd, rm } = costOf(totalIn * 2, estOutPerFile * files.length);
  return { perFile, totalIn, estOutPerFile, usd, rm };
}
