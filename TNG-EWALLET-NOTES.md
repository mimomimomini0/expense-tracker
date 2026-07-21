# Touch 'n Go eWallet — new input type (owner request, 20 Jul 2026)

Status: COMPLETE INCL. TRANSFER-LINKING (20 Jul 2026) — src/tng.ts + tests/tng.test.ts,
ground truth in fixture-ground-truth-tng.json (owner to eyeball-verify the two
printed card-summary rows). The sample contains TWO card sections
(1113643631 Pickleball + 2164085007 GENERIC 3.0); both reconcile: full
row-by-row balance chain + printed summary cross-checks. Persistence done
(schema-ewallet.sql applied, import-tng.ts imported 2 cards / 259 txns / PDF
stored). Transfer-linking done: src/links.ts + tests/links.test.ts (harness
111/111 green), linking pass scripts/link-tng.ts run against Supabase.

## Transfer-linking findings (20 Jul 2026 — for owner review)

- The matchers are deliberately conservative: links are written only for
  EXACT-amount, unambiguous matches (reload<->card txn within 3 days;
  inter-card within 10 minutes). Everything else is reported, never guessed.
- **Zero direct card-funded reloads exist in the current data.** All 15 reloads
  are app-funded (12 INTERNET RELOAD via OTATNGD) or terminal cash (3
  SSK/terminal). The money path is: credit card -> eWallet APP (with 1% fee:
  RM101 for RM100) -> NFC card reload. The app balance itself is not covered
  by any statement we ingest, so the two hops can't be joined row-to-row.
- **7 TNG app top-ups sit on the CIMB card statements (RM 1,505 total; txn ids
  10, 12, 13, 14, 17, 162, 179).** These are transfers into the eWallet, but
  today they count as card purchases while TNG Usage rows also count as
  expenses — the same ringgit twice at the aggregate level. How to categorise
  app top-ups (transfer category? exclusion flag?) is a Phase 2 / categories
  decision for the owner.
- **Inter-card note:** the owner said card 2164085007 often funds card
  1113643631's reloads, but the sample statement period (2025-07-20..2026-07-20)
  shows no such pair — no equal-amount cross-card rows within minutes. The
  inter-card matcher is built and tested (synthetic fixtures) and will link
  such pairs automatically in future statements if they appear. Worth asking
  the owner what that funding flow looks like in the TNG app (it may happen at
  the app level, invisible to per-card histories).

Originally: Captured while Phase 1 sits at "complete,
awaiting external review". Sample statement: `fixtures/tng/TransactionHistory_153975159.pdf`.

## Owner's field mapping (from the TNG transaction-history PDF)

| TNG column | Use as |
|---|---|
| Trans Date | transaction date (the expense date) |
| Trans Type | Usage vs Reload. Reload sources vary: bank IBG, credit card, PIN reload, others |
| Sector | transaction category hint |
| **Exit Location** | transaction description — more accurate identification than Entry Location |
| Amount | RM amount |

## Design considerations for the build (to review with owner before starting)

1. **Not a credit card statement.** The Phase 1 document-type gate deliberately
   rejects everything that isn't a card statement. Adding TNG means a new
   document type (`ewallet_statement`) with its own pipeline branch — the gate
   stays strict for everything else.
2. **Double-counting guard (important).** A reload FROM a credit card also
   appears as a purchase row on that card's statement (already in the system).
   If wallet reloads were counted as expenses, the same ringgit would be
   counted twice. Correct model: wallet **Usage rows are expenses**; **Reload
   rows are transfers, not expenses** — and card-funded reloads should
   eventually be LINKED to the matching card transaction.
3. **Trust layer carries over.** TNG statements print a running balance, so the
   same never-silently-wrong reconciliation applies: opening balance + reloads
   − usage = closing balance, exactly, or Needs Review.
4. **Harness first, as always.** A hand-verified ground-truth entry for the
   sample statement (balances + a few known rows) before any pipeline code.

## Where the project stopped (resume point)

- Phase 1 COMPLETE: 91/91 harness tests green; all 16 fixtures parsed_ok delta
  0.00; both traps rejected; chains verified; run report produced.
- Supabase fully wired: schema applied (RLS on), fixture batch persisted
  (16 statements, 363 transactions, PDFs in the `statements` storage bucket).
- Awaiting: owner's external review of the run report → then Phase 2
  (categories, merchant learning, bulk backfill of the extra 2024–2025 PDFs
  already sitting in fixtures/pdfs, new-card continuation flow for the
  replaced RHB card) + this TNG input type.
