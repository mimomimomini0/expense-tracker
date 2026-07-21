// Phase 1 processing pipeline (spec §5):
// hash + duplicate check -> document-type gate -> LLM extraction -> date
// resolution -> transaction typing -> per-card arithmetic reconciliation with
// ONE self-correcting re-parse -> commit | needs_review. Chain reconciliation,
// instalment plans and payment cycles are recomputed after every import.
//
// Invariants:
//  - A reconciliation mismatch is NEVER silently committed.
//  - Nothing is committed for rejected or needs_review files (except the
//    statement registry row for needs_review, and a rejection log entry).
//  - Extracted values are immutable once stored; reconciliation runs on them.

import { formatRm, toSen } from "./money.js";
import { resolveDueDate, resolveTxnDate } from "./dates.js";
import { classifyTransaction } from "./typing.js";
import { reconcileCard } from "./reconcile.js";
import { recomputeInstalmentPlans } from "./instalments.js";
import { recomputePaymentCycles } from "./payments.js";
import { sha256, PROMPT_VERSION, type Extractor, type LlmUsage } from "./llm.js";
import type { Store } from "./store.js";
import type {
  ExtractionResult, ExtractedCard, ImportOutcome, TransactionRow, TxnType,
} from "./types.js";

interface ResolvedTxn {
  txn_date: string;
  posting_date: string | null;
  description_raw: string;
  amount: number; // sen
  direction: "debit" | "credit";
  original_currency: string | null;
  original_amount: number | null;
  txn_type: TxnType;
}

interface ResolvedCard {
  extracted: ExtractedCard;
  txns: ResolvedTxn[];
  delta: number; // sen
  dateFlags: string[];
}

function resolveCards(extraction: ExtractionResult): { cards: ResolvedCard[]; dateFlags: string[] } {
  const allFlags: string[] = [];
  const cards: ResolvedCard[] = [];
  const stmtDate = extraction.statement_date!;

  for (const card of extraction.cards) {
    const flags: string[] = [];
    const txns: ResolvedTxn[] = [];
    for (const t of card.transactions) {
      const resolved = resolveTxnDate(t.txn_date_raw, stmtDate);
      if (resolved.flagged) flags.push(`card ${card.last4}: ${resolved.reason}`);
      let posting: string | null = null;
      if (t.posting_date_raw) {
        const p = resolveTxnDate(t.posting_date_raw, stmtDate);
        posting = p.iso; // posting date is metadata only; never flags the statement
      }
      txns.push({
        txn_date: resolved.iso ?? stmtDate,
        posting_date: posting,
        description_raw: t.description,
        amount: toSen(t.amount_rm),
        direction: t.direction,
        original_currency: t.original_currency,
        original_amount: t.original_amount,
        txn_type: classifyTransaction(t.description, t.direction),
      });
    }
    const rec = reconcileCard(card);
    cards.push({ extracted: card, txns, delta: rec.delta, dateFlags: flags });
    allFlags.push(...flags);
  }
  return { cards, dateFlags: allFlags };
}

function reconciliationFeedback(extraction: ExtractionResult): string {
  const lines: string[] = [];
  for (const card of extraction.cards) {
    const rec = reconcileCard(card);
    if (rec.delta !== 0) {
      lines.push(
        `Card ending ${card.last4}: your rows sum to a closing balance of RM ${formatRm(rec.computedClosing)} ` +
          `(opening ${formatRm(rec.opening)} - credits ${formatRm(rec.totalCredits)} + debits ${formatRm(rec.totalDebits)}), ` +
          `but the statement's printed closing balance is RM ${formatRm(rec.closing)} — a delta of RM ${formatRm(rec.delta)}.`,
      );
    }
  }
  return lines.join("\n");
}

export async function importPdf(
  store: Store,
  extractor: Extractor,
  filename: string,
  pdf: Buffer,
): Promise<ImportOutcome> {
  const fileHash = sha256(pdf);

  const logUsage = async (purpose: "gate" | "extract" | "reparse", u: LlmUsage) => {
    await store.logApiCost({
      statement_filename: filename, purpose, model: u.model,
      tokens_in: u.tokensIn, tokens_out: u.tokensOut,
      est_cost_usd: u.estCostUsd, est_cost_rm: u.estCostRm,
    });
  };

  // 1. duplicate check — file hash
  const dup = await store.findStatementByHash(fileHash);
  if (dup) {
    await store.logRejection({
      filename, file_hash: fileHash, reason: "duplicate_file_hash",
      detail: `identical file already imported as "${dup.filename}" (statement ${dup.statement_date})`,
    });
    return { filename, outcome: "rejected_duplicate", detail: `duplicate of ${dup.filename}` };
  }

  // 2. document-type gate — runs FIRST, before any extraction
  const gate = await extractor.gate(pdf, fileHash);
  await logUsage("gate", gate.usage);
  if (gate.result.doc_type === "other" || gate.result.doc_type === "ewallet_statement") {
    const hint =
      gate.result.doc_type === "ewallet_statement"
        ? "This is an e-wallet transaction history — import it with the e-wallet importer (npm run cli -- import-tng), not the card pipeline."
        : `This file is not a credit card statement — nothing was imported. (${gate.result.reason})`;
    await store.logRejection({
      filename, file_hash: fileHash, reason: "not_credit_card_statement", detail: hint,
    });
    return { filename, outcome: "rejected_not_statement", detail: hint };
  }

  // 3. extraction (attempt 1)
  let retryCount = 0;
  let attempt = await extractor.extract(pdf, fileHash, null);
  await logUsage("extract", attempt.usage);
  let extraction = attempt.result;

  const invalid = (e: ExtractionResult) =>
    e.doc_type === "other" || !e.statement_date || e.cards.length === 0;

  if (invalid(extraction)) {
    if (extraction.doc_type === "other") {
      await store.logRejection({
        filename, file_hash: fileHash, reason: "not_credit_card_statement",
        detail: "This file is not a credit card statement — nothing was imported.",
      });
      return { filename, outcome: "rejected_not_statement", detail: "extractor classified as non-statement" };
    }
    return { filename, outcome: "failed", detail: "extraction returned no statement date or no card sections" };
  }

  // 4-5. date resolution + typing + reconciliation, with ONE self-correcting re-parse
  let { cards, dateFlags } = resolveCards(extraction);
  let mismatched = cards.filter((c) => c.delta !== 0);

  if (mismatched.length > 0) {
    retryCount = 1;
    const feedback = reconciliationFeedback(extraction);
    const retry = await extractor.extract(pdf, fileHash, feedback);
    await logUsage("reparse", retry.usage);
    if (!invalid(retry.result)) {
      const retryResolved = resolveCards(retry.result);
      const retryMismatched = retryResolved.cards.filter((c) => c.delta !== 0);
      if (retryMismatched.length === 0) {
        extraction = retry.result;
        attempt = retry;
        cards = retryResolved.cards;
        dateFlags = retryResolved.dateFlags;
        mismatched = [];
      } else {
        mismatched = retryMismatched;
        extraction = retry.result;
        attempt = retry;
        cards = retryResolved.cards;
        dateFlags = retryResolved.dateFlags;
      }
    }
  }

  const stmtDate = extraction.statement_date!;
  const due = extraction.payment_due_date_raw
    ? resolveDueDate(extraction.payment_due_date_raw, stmtDate)
    : { iso: null, flagged: false, reason: undefined };

  const bank = await store.getOrCreateBank(extraction.bank ?? gate.result.bank_guess ?? "UNKNOWN");

  const reviewReasons: string[] = [];
  for (const c of mismatched) {
    reviewReasons.push(
      `card ${c.extracted.last4}: reconciliation delta RM ${formatRm(c.delta)} after ${retryCount} automatic re-parse`,
    );
  }
  reviewReasons.push(...dateFlags);
  if (due.flagged) reviewReasons.push(`due date: ${due.reason}`);

  if (reviewReasons.length > 0) {
    // Needs Review: registry row only — nothing committed to the expense DB.
    const st = await store.insertStatement({
      bank_id: bank.id, filename, file_hash: fileHash,
      statement_date: stmtDate,
      period_start: extraction.statement_period_start,
      period_end: extraction.statement_period_end,
      payment_due_date: due.iso,
      status: "needs_review",
      model_version: attempt.usage.model, prompt_version: PROMPT_VERSION,
      retry_count: retryCount,
      review_reason: reviewReasons.join(" | "),
      raw_extraction_json: JSON.stringify(extraction),
    });
    return {
      filename, outcome: "needs_review", statementId: st.id, retryCount,
      detail: reviewReasons.join(" | "),
      reconciliationDeltas: cards.map((c) => ({ last4: c.extracted.last4, delta: c.delta })),
    };
  }

  // 6. duplicate check — same card + statement date (never bank-level)
  for (const c of cards) {
    const existingCard = await store.findCardAccount(bank.id, c.extracted.last4);
    if (existingCard) {
      const dupCard = await store.findStatementCardByCardAndDate(existingCard.id, stmtDate);
      if (dupCard) {
        await store.logRejection({
          filename, file_hash: fileHash, reason: "duplicate_statement",
          detail: `a statement for ${bank.name} card ...${c.extracted.last4} dated ${stmtDate} already exists`,
        });
        return {
          filename, outcome: "rejected_duplicate",
          detail: `statement for card ${c.extracted.last4} dated ${stmtDate} already exists`,
        };
      }
    }
  }

  // 7. commit — everything reconciled to the sen
  const st = await store.insertStatement({
    bank_id: bank.id, filename, file_hash: fileHash,
    statement_date: stmtDate,
    period_start: extraction.statement_period_start,
    period_end: extraction.statement_period_end,
    payment_due_date: due.iso,
    status: "parsed_ok",
    model_version: attempt.usage.model, prompt_version: PROMPT_VERSION,
    retry_count: retryCount,
    review_reason: null,
    raw_extraction_json: JSON.stringify(extraction),
  });

  const affectedCards: number[] = [];
  const newCards: { cardAccountId: number; last4: string }[] = [];
  for (const c of cards) {
    // Card identity = bank + card number. Holder-name drift never creates a
    // new card; the label is display metadata only.
    let cardAccount = await store.findCardAccount(bank.id, c.extracted.last4);
    if (!cardAccount) {
      cardAccount = await store.createCardAccount(bank.id, c.extracted.last4, c.extracted.holder_name);
      // FR-4d: surface first-seen card numbers so the upload flow can ask
      // "new card, or continuation of an existing card?"
      newCards.push({ cardAccountId: cardAccount.id, last4: cardAccount.last4 });
    }
    affectedCards.push(cardAccount.id);

    const sc = await store.insertStatementCard({
      statement_id: st.id,
      card_account_id: cardAccount.id,
      opening_balance: toSen(c.extracted.opening_balance_rm),
      closing_balance: toSen(c.extracted.closing_balance_rm),
      minimum_due: c.extracted.minimum_due_rm != null ? toSen(c.extracted.minimum_due_rm) : null,
      credit_limit: c.extracted.credit_limit_rm != null ? toSen(c.extracted.credit_limit_rm) : null,
      retail_interest_rate: c.extracted.retail_interest_rate_pct,
      summary_totals_json: c.extracted.summary_totals ? JSON.stringify(c.extracted.summary_totals) : null,
      instalment_summaries_json:
        c.extracted.instalment_summaries.length > 0
          ? JSON.stringify(c.extracted.instalment_summaries)
          : null,
      reconciliation_delta: 0,
    });

    const rows: Omit<TransactionRow, "id">[] = c.txns.map((t) => ({
      statement_card_id: sc.id,
      card_account_id: cardAccount!.id,
      txn_date: t.txn_date,
      posting_date: t.posting_date,
      description_raw: t.description_raw,
      amount: t.amount,
      direction: t.direction,
      original_currency: t.original_currency,
      original_amount: t.original_amount,
      txn_type: t.txn_type,
    }));
    await store.insertTransactions(rows);
  }

  // 8. derived state — recomputed, order-independent
  for (const cardId of affectedCards) {
    await recomputeInstalmentPlans(store, cardId);
    await recomputePaymentCycles(store, cardId);
  }
  // Payment cycles of OTHER cards can change when a neighbor statement arrives
  // for the same card only, so affected cards suffice. Chain warnings are
  // computed on demand (chain.ts) and need no persistence.

  return {
    filename, outcome: "parsed_ok", statementId: st.id, retryCount,
    reconciliationDeltas: cards.map((c) => ({ last4: c.extracted.last4, delta: 0 })),
    ...(newCards.length > 0 ? { newCards } : {}),
  };
}

export async function importBatch(
  store: Store,
  extractor: Extractor,
  files: { name: string; pdf: Buffer }[],
): Promise<ImportOutcome[]> {
  const outcomes: ImportOutcome[] = [];
  for (const f of files) {
    outcomes.push(await importPdf(store, extractor, f.name, f.pdf));
  }
  return outcomes;
}
