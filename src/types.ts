import type { Sen } from "./money.js";

// ---------- Extraction result (what the LLM returns, before resolution) ----------

export type DocType =
  | "credit_card_statement"
  | "contains_credit_card_statement"
  | "ewallet_statement"
  | "other";

export interface ExtractedTransaction {
  txn_date_raw: string;
  posting_date_raw: string | null;
  description: string;
  amount_rm: number; // positive RM value
  direction: "debit" | "credit";
  original_currency: string | null; // ISO alpha code, resolved from name or numeric code
  original_amount: number | null;
}

export interface ExtractedInstalmentSummary {
  plan_name: string;
  total_months: number | null;
  monthly_amount_rm: number | null;
  principal_rm: number | null;
  outstanding_principal_rm: number | null;
}

export interface ExtractedCard {
  card_number_masked: string; // as printed
  last4: string;
  holder_name: string | null;
  opening_balance_rm: number; // negative when printed CR
  closing_balance_rm: number; // negative when printed CR
  minimum_due_rm: number | null;
  credit_limit_rm: number | null;
  retail_interest_rate_pct: number | null;
  summary_totals: {
    total_debits_rm: number | null;
    total_credits_rm: number | null;
    retail_purchase_rm: number | null;
    cash_advance_rm: number | null;
  } | null;
  instalment_summaries: ExtractedInstalmentSummary[];
  transactions: ExtractedTransaction[];
}

export interface ExtractionResult {
  doc_type: DocType;
  bank: string | null;
  statement_date: string | null; // YYYY-MM-DD as printed
  payment_due_date_raw: string | null; // as printed
  statement_period_start: string | null;
  statement_period_end: string | null;
  cards: ExtractedCard[];
}

export interface GateResult {
  doc_type: DocType;
  bank_guess: string | null;
  reason: string;
}

// ---------- Stored records (post-resolution, integer sen) ----------

export type TxnType = "purchase" | "refund" | "payment" | "fee_interest" | "instalment" | "cash_advance";
export type StatementStatus = "parsed_ok" | "needs_review" | "failed";

export interface BankRow {
  id: number;
  name: string;
}

export interface CardAccountRow {
  id: number;
  bank_id: number;
  last4: string;
  holder_label: string | null;
  /** FR-4d: id of the predecessor card this card REPLACES/continues (reissue,
   *  lost-card replacement, product upgrade). Chain checks follow this link. */
  continues_card_id: number | null;
}

export interface StatementRow {
  id: number;
  bank_id: number;
  filename: string;
  file_hash: string;
  statement_date: string;
  period_start: string | null;
  period_end: string | null;
  payment_due_date: string | null;
  status: StatementStatus;
  model_version: string;
  prompt_version: string;
  retry_count: number;
  review_reason: string | null;
  raw_extraction_json: string;
}

export interface StatementCardRow {
  id: number;
  statement_id: number;
  card_account_id: number;
  opening_balance: Sen;
  closing_balance: Sen;
  minimum_due: Sen | null;
  credit_limit: Sen | null;
  retail_interest_rate: number | null;
  summary_totals_json: string | null;
  instalment_summaries_json: string | null;
  reconciliation_delta: Sen;
}

export interface TransactionRow {
  id: number;
  statement_card_id: number;
  card_account_id: number;
  txn_date: string;
  posting_date: string | null;
  description_raw: string;
  amount: Sen; // positive
  direction: "debit" | "credit";
  original_currency: string | null;
  original_amount: number | null;
  txn_type: TxnType;
}

export interface InstalmentPlanRow {
  id: number;
  card_account_id: number;
  plan_name: string;
  monthly_amount: Sen | null;
  total_months: number;
  months_elapsed: number;
  principal_total: Sen | null;
  principal_outstanding: Sen | null;
  projected_end_date: string | null;
}

export type CycleStatus = "unpaid" | "paid_full" | "paid_minimum" | "paid_other" | "overdue";

export interface PaymentCycleRow {
  id: number;
  card_account_id: number;
  statement_id: number;
  due_date: string | null;
  statement_balance: Sen;
  minimum_due: Sen | null;
  status: CycleStatus;
  amount_paid: Sen;
  /** set when the USER recorded a payment (FR-9); recompute preserves it */
  paid_recorded_at: string | null;
  auto_detected: boolean;
}

export interface RejectionRow {
  id: number;
  filename: string;
  file_hash: string;
  reason: "not_credit_card_statement" | "duplicate_file_hash" | "duplicate_statement";
  detail: string;
}

export interface ApiCostRow {
  id: number;
  statement_filename: string | null;
  purpose: "gate" | "extract" | "reparse" | "escalate" | "estimate";
  model: string;
  tokens_in: number;
  tokens_out: number;
  est_cost_usd: number;
  est_cost_rm: number;
}

export interface ChainWarning {
  card_account_id: number;
  bank: string;
  last4: string;
  from_statement_date: string;
  to_statement_date: string;
  kind: "gap_or_out_of_sequence";
  detail: string;
}

export interface ImportOutcome {
  filename: string;
  outcome: "parsed_ok" | "needs_review" | "rejected_not_statement" | "rejected_duplicate" | "failed";
  statementId?: number;
  retryCount?: number;
  detail?: string;
  reconciliationDeltas?: { last4: string; delta: Sen }[];
  /** FR-4d: card numbers first seen in this import. The upload flow must ask
   *  the user "new card, or does it REPLACE/continue an existing card?" and
   *  call store.linkCardContinuation for a continuation. */
  newCards?: { cardAccountId: number; last4: string }[];
}
