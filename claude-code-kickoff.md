# Claude Code Kickoff — Expense Tracker, Phase 1 ONLY

You are building Phase 1 of the credit-card expense tracking system specified in
`expense-tracker-spec.md` (version 1.5). Read the ENTIRE spec before writing any code.
This file tells you the working order and the hard rules. Where this file and the spec
conflict, the spec wins.

## Scope: Phase 1 only
Upload → duplicate check (file hash + card/date) → document-type gate → LLM extraction
(Claude API; record model_version + prompt_version) → date resolution → transaction
typing → self-correcting re-parse on reconciliation failure (one automatic retry with
the arithmetic error fed back) → per-statement reconciliation to the sen → chain
reconciliation → Needs Review state. CLI or minimal UI is acceptable for Phase 1.
Do NOT build dashboards, categories, payments, reminders, or i18n yet.

## Working order (non-negotiable)
1. **Build the regression harness FIRST**, before the pipeline. Load
   `fixture-ground-truth.json` and generate one test per statement, per trap, and per
   chain rule. These tests obviously fail at first — that is the point. The harness is
   the definition of done and must run on every code change (wire it into the test
   script / CI from day one).
2. Then build the pipeline until the harness is fully green.
3. **Exit criterion: EVERY assertion in fixture-ground-truth.json passes — every
   statement parsed_ok with reconciliation_delta exactly 0.00 against the ground-truth
   balances, both traps rejected correctly, both chains verified, the corrupted-copy
   test lands in needs_review, and the shuffled-order import test converges to the same
   final state.** Do not proceed to Phase 2 under any circumstance until this is true.
   Do not weaken, skip, or mark-as-todo any failing test to get to green.

## Hard rules (from the spec — the ones most tempting to shortcut)
- Ground truth is `fixture-ground-truth.json`, hand-verified by the owner's analyst.
  The pipeline NEVER grades its own homework: assert against the JSON, not against
  pipeline output.
- Reconciliation runs on extracted values, which are immutable once stored.
- No bank-specific templates, regex layouts, or positional parsing — semantic LLM
  extraction only. The fixtures deliberately include two different CIMB layout eras
  and a card whose printed holder name changes across years.
- A reconciliation mismatch is NEVER silently committed. Retry once with the error
  fed back; then Needs Review.
- All date arithmetic in Asia/Kuala_Lumpur. Monetary values numeric(12,2).
- Uniqueness: (user_id, file_hash) on statements; (user_id, card_account_id,
  statement_date) on statement_cards — never bank-level.
- Card identity = bank + card number. "DEAN LIM" and the full legal name are the SAME
  CIMB card.

## Prerequisites the owner will provide
- Supabase project (URL + service key) — Postgres, Auth, Storage, RLS per spec §4.
- Anthropic API key (env: ANTHROPIC_API_KEY). Use a Sonnet-class model for extraction;
  record the exact model string per statement.
- The fixture PDFs, placed in `fixtures/pdfs/` with filenames matching
  fixture-ground-truth.json. The trap file (RHB current-account statement) and the
  deliberate duplicate belong in the batch — they are test inputs, not mistakes.

## Cost behavior (FR-17 applies even in Phase 1)
Before sending any batch to the Claude API, print/display the statement count and an
estimated cost and require confirmation. Log tokens and estimated cost per statement
(api_cost_log).

## Reporting back
When the harness is green, produce a run report: per-statement status, reconciliation
deltas (all 0.00), retry counts, trap outcomes, chain-check results, and total API
cost. The owner will bring this report back for external review before Phase 2 is
authorized.
