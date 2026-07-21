// FR-7 category classification (learning system). Deterministic core:
//
//   order: (0) txn_type-driven categories (fees -> Bank Fees & Interest,
//          refunds -> Refunds; payments carry NO category — they are not
//          expenses), then (1) merchant-rule match -> auto-assign, then
//          (2) LLM suggestion (pluggable; a Noop suggester keeps the engine
//          fully offline until API use is approved per FR-17), then
//          (3) confirmation queue, grouped by merchant so one confirmation
//          clears every pending row of that merchant.
//
// Categories describe WHAT was bought; business attribution is a separate
// dimension (FR-8) and never appears here. Seed rules cover only merchants
// whose category is beyond doubt (the spec's "obvious Malaysian merchants") —
// anything debatable goes to the queue for the owner. Notably TNG EWALLET is
// NOT seeded: those rows are eWallet transfers pending the owner's
// double-count decision (see TNG-EWALLET-NOTES.md).

import type { TxnType } from "./types.js";

// ---------------- taxonomy (FR-7, seeded in schema-phase2.sql) ----------------

export const CATEGORIES = [
  "F&B / Restaurants", "Groceries", "Utilities", "Telco", "Online Purchases",
  "Transport & Fuel", "Health & Pharmacy", "Insurance", "Subscriptions",
  "Retail & Shopping", "Kids & Family", "Pets", "Home & Renovation",
  "Fitness & Sports",
  // owner requests 2026-07-21
  "Lifestyle & Leisure",
  "Parking",
  "Travel Expenses",
  "Gift & Donation",
  "Dispute",
  "Paying on Behalf", "Bank Fees & Interest", "Refunds",
  // owner decision Q1 (2026-07-20): e-wallet top-ups are transfers, excluded
  // from spending totals in reports (like payments), shown as their own line
  "Wallet Transfers",
  "Other",
] as const;
export type CategoryName = (typeof CATEGORIES)[number];

// ---------------- merchant normalization ----------------

/** Uppercase, collapse whitespace. Rules match on this form. */
export function normalizeDesc(description: string): string {
  return description.toUpperCase().replace(/\s+/g, " ").trim();
}

const COUNTRY_TAIL = /\s+(MY|SG|CN|HK|TW|US|SE|GB|AU|JP|TH|ID)\.?$/;

/**
 * Grouping key for the confirmation queue: normalized description with the
 * trailing country token dropped, so "LAZADA KUALA LUMPUR MY" and
 * "LAZADA KUALA LUMPUR" group together. Deliberately conservative — only
 * IDENTICAL merchants group (spec: "the queue groups identical merchants").
 */
export function merchantKey(description: string): string {
  return normalizeDesc(description).replace(COUNTRY_TAIL, "").trim();
}

// ---------------- merchant rules ----------------

export interface MerchantRule {
  /** Normalized pattern; matches when the normalized description STARTS WITH it. */
  merchant_pattern: string;
  category: CategoryName;
  /** Supabase ids once persisted; null in the pure engine. */
  id?: number | null;
  confirmed_at?: string | null;
}

/**
 * Seed rules — unambiguous chains only, patterns chosen against the owner's
 * real statement descriptions. Growth beyond this list comes from user
 * confirmations, never from guesses.
 */
export const SEED_RULES: MerchantRule[] = [
  // groceries & convenience
  { merchant_pattern: "JAYA GROCER", category: "Groceries" },
  { merchant_pattern: "VILLAGE GROCER", category: "Groceries" },
  { merchant_pattern: "COLD STORAGE", category: "Groceries" },
  { merchant_pattern: "99 SPEEDMART", category: "Groceries" },
  { merchant_pattern: "AEON", category: "Groceries" },
  { merchant_pattern: "FAMILYMART", category: "Groceries" },
  { merchant_pattern: "LOTUS'S", category: "Groceries" },
  { merchant_pattern: "TESCO", category: "Groceries" },
  // f&b chains
  { merchant_pattern: "MCDONALD", category: "F&B / Restaurants" },
  { merchant_pattern: "STARBUCKS", category: "F&B / Restaurants" },
  { merchant_pattern: "CBTL", category: "F&B / Restaurants" },
  { merchant_pattern: "CB&TL", category: "F&B / Restaurants" },
  { merchant_pattern: "MYCBTL", category: "F&B / Restaurants" },
  { merchant_pattern: "ZUS COFFEE", category: "F&B / Restaurants" },
  { merchant_pattern: "NANDO", category: "F&B / Restaurants" },
  { merchant_pattern: "KFC", category: "F&B / Restaurants" },
  { merchant_pattern: "ORIENTAL KOPI", category: "F&B / Restaurants" },
  // online marketplaces
  { merchant_pattern: "LAZADA", category: "Online Purchases" },
  { merchant_pattern: "SHOPEE", category: "Online Purchases" },
  { merchant_pattern: "TAOBAO", category: "Online Purchases" },
  { merchant_pattern: "ALIPAY*TAOBAO", category: "Online Purchases" },
  // transport
  { merchant_pattern: "GRAB-EC", category: "Transport & Fuel" },
  { merchant_pattern: "GRAB RIDES", category: "Transport & Fuel" },
  { merchant_pattern: "GRABEXPRESS", category: "Transport & Fuel" },
  { merchant_pattern: "PETRONAS", category: "Transport & Fuel" },
  { merchant_pattern: "SHELL ", category: "Transport & Fuel" },
  // telco & utilities
  { merchant_pattern: "MAXIS", category: "Telco" },
  { merchant_pattern: "DIGI ", category: "Telco" },
  { merchant_pattern: "CELCOM", category: "Telco" },
  { merchant_pattern: "U MOBILE", category: "Telco" },
  { merchant_pattern: "TIME DOTCOM", category: "Telco" },
  { merchant_pattern: "TNB", category: "Utilities" },
  { merchant_pattern: "PBA ", category: "Utilities" },
  { merchant_pattern: "INDAH WATER", category: "Utilities" },
  // subscriptions & insurance & fitness
  { merchant_pattern: "NETFLIX", category: "Subscriptions" },
  { merchant_pattern: "SPOTIFY", category: "Subscriptions" },
  { merchant_pattern: "COWAY", category: "Subscriptions" },
  { merchant_pattern: "AIA ", category: "Insurance" },
  { merchant_pattern: "ANYTIME FITNESS", category: "Fitness & Sports" },
  { merchant_pattern: "DECATHLON", category: "Fitness & Sports" },
  // health
  { merchant_pattern: "GUARDIAN", category: "Health & Pharmacy" },
  { merchant_pattern: "WATSON", category: "Health & Pharmacy" },
  { merchant_pattern: "ALPRO PHARMACY", category: "Health & Pharmacy" },
  { merchant_pattern: "KLINIK", category: "Health & Pharmacy" },
  // retail / home / kids / pets
  { merchant_pattern: "IKEA", category: "Home & Renovation" },
  { merchant_pattern: "MUJI", category: "Retail & Shopping" },
  { merchant_pattern: "POPULAR", category: "Retail & Shopping" },
  { merchant_pattern: "TOYS 'R' US", category: "Kids & Family" },
  { merchant_pattern: "GRACE VETERINARY", category: "Pets" },
];

export function findRule(description: string, rules: MerchantRule[]): MerchantRule | null {
  const d = normalizeDesc(description);
  // longest pattern wins so "GRAB RIDES" beats a hypothetical "GRAB"
  let best: MerchantRule | null = null;
  for (const r of rules) {
    if (d.startsWith(r.merchant_pattern) && (!best || r.merchant_pattern.length > best.merchant_pattern.length)) {
      best = r;
    }
  }
  return best;
}

// ---------------- LLM suggestion stage (pluggable, FR-17-gated) ----------------

export interface CategorySuggestion {
  category: CategoryName;
  confidence: number; // 0..1
}

export interface CategorySuggester {
  /** Return null for "don't know" — the row then enters the confirmation queue. */
  suggest(description: string, txnType: TxnType): Promise<CategorySuggestion | null>;
}

/** Offline default: suggests nothing; every unknown merchant goes to the queue. */
export class NoopSuggester implements CategorySuggester {
  async suggest(): Promise<CategorySuggestion | null> {
    return null;
  }
}

/** LLM suggestions at or above this confidence auto-assign (still editable). */
export const AUTO_ASSIGN_CONFIDENCE = 0.8;

// ---------------- classification ----------------

export type ClassificationSource = "type" | "rule" | "llm";

export interface Classification {
  category: CategoryName | null; // null: no category applies (payments) or pending queue
  source: ClassificationSource | null;
  confidence: number | null; // only for source "llm"
  rule: MerchantRule | null; // only for source "rule"
  queued: boolean; // true -> goes to the confirmation queue
}

const NO_CATEGORY: Classification = {
  category: null, source: null, confidence: null, rule: null, queued: false,
};

export async function classifyRow(
  description: string,
  txnType: TxnType,
  rules: MerchantRule[],
  suggester: CategorySuggester,
): Promise<Classification> {
  // (0) type-driven — these never depend on the merchant
  if (txnType === "payment") return NO_CATEGORY; // not an expense, no category
  if (txnType === "fee_interest") {
    return { category: "Bank Fees & Interest", source: "type", confidence: null, rule: null, queued: false };
  }
  if (txnType === "refund") {
    return { category: "Refunds", source: "type", confidence: null, rule: null, queued: false };
  }

  // (1) learning table
  const rule = findRule(description, rules);
  if (rule) return { category: rule.category, source: "rule", confidence: null, rule, queued: false };

  // (2) LLM suggestion
  const s = await suggester.suggest(description, txnType);
  if (s && s.confidence >= AUTO_ASSIGN_CONFIDENCE) {
    return { category: s.category, source: "llm", confidence: s.confidence, rule: null, queued: false };
  }

  // (3) confirmation queue (low confidence still shown as the recommendation)
  return {
    category: s?.category ?? null, source: s ? "llm" : null,
    confidence: s?.confidence ?? null, rule: null, queued: true,
  };
}

// ---------------- confirmation queue ----------------

export interface QueueItem<T> {
  merchant: string; // grouping key (merchantKey of the description)
  rows: T[]; // every pending row of this merchant — one confirmation clears all
  suggestion: CategorySuggestion | null;
}

export function buildConfirmationQueue<T>(
  pending: { row: T; description: string; suggestion: CategorySuggestion | null }[],
): QueueItem<T>[] {
  const groups = new Map<string, QueueItem<T>>();
  for (const p of pending) {
    const key = merchantKey(p.description);
    let g = groups.get(key);
    if (!g) {
      g = { merchant: key, rows: [], suggestion: p.suggestion };
      groups.set(key, g);
    }
    g.rows.push(p.row);
    // keep the highest-confidence suggestion for the group
    if (p.suggestion && (!g.suggestion || p.suggestion.confidence > g.suggestion.confidence)) {
      g.suggestion = p.suggestion;
    }
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length);
}

/**
 * A user confirmation becomes a learning rule: the merchant key is the
 * pattern, so every future row of this merchant auto-assigns (FR-7: "once
 * confirmed, the same merchant never asks again").
 */
export function ruleFromConfirmation(merchant: string, category: CategoryName): MerchantRule {
  return { merchant_pattern: merchant, category, confirmed_at: new Date().toISOString() };
}
