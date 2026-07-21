# Expense Tracker — How It Works (Phase 1)

This document explains the system in plain English. Phase 1 is the "parse &
verify" core: it turns uploaded credit card statement PDFs into verified
transaction data, and refuses to store anything it cannot prove is correct.

## The one rule everything follows

**Never silently wrong.** Every statement must reconcile arithmetically —
opening balance − payments/refunds + spending = closing balance, exactly, to
the sen — or it is flagged for a human instead of being saved.

## What happens when a PDF is imported

```
PDF file
  1. Fingerprint (SHA-256 hash) — seen this exact file before? -> reject as duplicate
  2. Document-type gate (AI) — is this actually a CREDIT CARD statement?
        A bank current-account statement, invoice, or random PDF is rejected
        with a clear error. Nothing is stored except a rejection log entry.
  3. Extraction (AI, Claude claude-sonnet-5) — reads the whole PDF like a human
        would (any bank, any layout, any year — no templates, no regex) and
        returns structured data: balances, dates, every transaction row.
  4. Date resolution (code, not AI) — statement rows print dates without years
        ("19 APR"). Deterministic rules anchor them to the statement date,
        handle the December->January year boundary, and resolve dd/mm
        ambiguity by which reading lands in the valid window.
  5. Transaction typing (code) — every row becomes one of: purchase, refund,
        payment, fee_interest, instalment, cash_advance. A credit with a
        payment descriptor ("PYMT VIA...", "DUITNOW...") is a payment; a
        credit with a merchant name (Lazada, WEIXIN) is a refund. This
        distinction keeps refunds out of payment detection.
  6. Reconciliation (code) — the arithmetic check, in integer sen.
        Match      -> commit to the database.
        Mismatch   -> ONE automatic re-parse: the AI is shown its own
                      arithmetic error and asked to look again (missed rows,
                      sign errors, two-line foreign-currency entries).
        Still off  -> statement goes to "Needs Review". NOTHING is committed.
  7. Duplicate statement check — same card + same statement date already in
        the database? -> reject (file hash differs but it's the same statement).
  8. Derived state is recomputed from scratch after every import:
        - Chain check: each statement's opening balance must equal the
          previous statement's closing balance; a hole in the months raises a
          "gap" warning that disappears by itself once the missing month is
          imported. Statements can arrive in ANY order.
        - Instalment plans (e.g. EP-OGAWA 36 months): one record per plan,
          updated as new months arrive — never duplicated.
        - Payment cycles: all payment rows in the FOLLOWING statement are
          summed and compared to this statement's balance (multiple partial
          payments and prepayment both handled; refunds never counted).
```

## Why the numbers can be trusted

- Extracted values are **immutable** once stored. Reconciliation always runs
  against them, so later edits can never corrupt the arithmetic proof.
- All money is handled as **integer sen** internally — no floating point.
- All date arithmetic uses the **Asia/Kuala_Lumpur** timezone.
- The AI never grades its own homework: the regression harness asserts
  against `fixture-ground-truth.json`, hand-verified by a human.

## The regression harness (the definition of done)

`npm test` runs the entire fixture suite: 16 real statements across 3 banks
(CIMB 2024 + 2026 layouts, RHB principal + supplementary, UOB), one
current-account trap file that must be rejected, one deliberate duplicate,
a corrupted-copy test that must land in Needs Review, and a shuffled-order
import that must converge to the identical final state. It runs on every code
change; a change that breaks parsing fails the suite immediately.

The AI extraction of each fixture is **cached on disk**
(`fixtures/extractions/`), so the harness replays deterministically and
costs nothing after the first run.

## Cost transparency (FR-17)

The Claude API is never called until the owner has seen an estimated cost and
confirmed: `npm run extract-fixtures` prints the batch size + estimate, asks
for confirmation, and only then calls the API. Every call's tokens and
estimated cost are logged (api_cost_log).

## Files

| Path | What it is |
|---|---|
| `src/pipeline.ts` | The import flow described above |
| `src/llm.ts` | Claude API calls (gate + extraction), disk cache, cost math |
| `src/dates.ts` | FR-3 date resolution rules |
| `src/typing.ts` | FR-5 transaction typing rules |
| `src/reconcile.ts` | FR-4 arithmetic reconciliation |
| `src/chain.ts` | Cross-statement chain check (computed, order-independent) |
| `src/instalments.ts` | Instalment plan derivation |
| `src/payments.ts` | Payment-cycle auto-detection |
| `src/store.ts` | Data store (in-memory implementation used by the harness) |
| `schema.sql` | Postgres schema for Supabase (paste into the SQL Editor) |
| `tests/` | The regression harness |
| `fixtures/pdfs/` | The statement PDFs (never committed) |
| `fixtures/extractions/` | Cached AI extractions (deterministic replays) |

## Commands

| Command | What it does |
|---|---|
| `npm test` | Run the full regression harness |
| `npm run extract-fixtures` | Estimate cost, confirm, extract all fixtures via Claude |
| `npm run report` | Import the fixture batch and print the Phase 1 run report |
| `npm run typecheck` | TypeScript check |
