# Credit Card Expense Tracker — Project Specification & Build Brief

**Owner:** Dean Lim
**Version:** 1.5 — 19 July 2026 (v1.4 + expert-gap upgrade, all owner-approved: FR-18 dispute-window alerts & unusual-item flags, FR-19 subscription/recurring detection, FR-20 cost-of-credit & interest-tier tracking, FR-21 Paying-on-Behalf reimbursement lifecycle, FR-22 director-claim report generator, FR-4 self-correcting re-parse, Section-10 fixture suite as permanent CI regression harness with model/prompt versioning, Phase-4 account deletion/PDPA purge, statement-arrival nudge, credit utilization stat)
**Purpose of this document:** Complete build brief for Claude Code. Build in phases, in order. Do not start a later phase until the earlier phase's acceptance criteria pass.

---

## 1. Project Overview

A web application that tracks credit card expenses across multiple Malaysian credit cards by ingesting uploaded PDF statements. The system extracts transactions using LLM-based semantic parsing, verifies every extraction with arithmetic reconciliation, classifies spending into categories (learning from user confirmations), stores everything in a database, and presents a dashboard with charts, filters, exports, and payment-due reminders.

**Primary user:** The owner (non-developer). Single-user for now, but architected multi-user-ready (proper auth and per-user data isolation from day one) so a future SaaS pivot does not require a rewrite.

**Guiding principles:**
1. **Never silently wrong.** Every parsed statement must reconcile arithmetically or be flagged for human review. Wrong data is worse than no data.
2. **Promote full payment.** The system's payment features default to and encourage paying the statement balance in full, making the cost of not doing so visible.
3. **Layout-agnostic parsing.** Banks change statement formats without notice. Extraction is semantic (LLM), never positional (regex/templates), and always verified (reconciliation).
4. **Simple, documented, maintainable.** One language, one framework, one database. Plain-English documentation in the repo so a non-developer can direct future changes through AI coding tools.

---

## 2. Known Source Statements (initial scope)

Three banks are in scope for Phase 1. Sample PDFs are provided and serve as ground-truth test fixtures (see §10 Acceptance Criteria).

| Bank | Card ending | Statement traits |
|---|---|---|
| CIMB | 2225 | Single card. "19 APR" date format. Posting + transaction date columns. Promo text interleaved between transaction rows. FX shown as two-line entries (foreign amount + RM amount). Fee rows (LATE CHARGES, FINANCE CHARGES) appear as transactions. Statement ~19th monthly. |
| RHB | 3799 (principal), 2505 (supplementary) | Two card accounts in one PDF, sectioned by card number + holder name. "27 Jun" date format. Due date printed dd/mm/yyyy. Contains refunds (CR), payments (CR), and a 36-month 0% instalment plan (EP-OGAWA). Statement ~15th monthly. |
| UOB (ex-Citibank) | 2485 | Transaction table buried on page 5 of 6 after announcements/T&C. Transaction date only (no posting date). Summary box: Previous Balance / Credit-Payment / Debit-Fees / Retail Purchase / Cash Advance / Total Balance Due. Statement ~8th monthly. |

The parser MUST NOT hard-code these layouts. They are validation fixtures, not templates.

---

## 3. Functional Requirements

### FR-1: PDF Statement Upload & Registry
- Upload one or more PDF statements via web UI (drag-drop + file picker).
- Handle password-protected PDFs: prompt for password; offer to save it (encrypted) per card source; on future uploads from that source, ask "CIMB statement password detected — use your saved password?"
- Statement registry records: original filename, upload timestamp, bank, card account(s), statement date, statement period (start/end), payment due date, file hash.
- **Duplicate detection:** reject re-upload of the same statement (same file hash, or same bank + card + statement date) with a clear message.
- Store the original PDF for audit/reference.

### FR-2: LLM Semantic Extraction (layout-agnostic)
- **Document-type gate (runs FIRST, before any extraction):** the system classifies every uploaded PDF as `credit_card_statement`, `contains_credit_card_statement` (a combined mailing bundling a card statement with other content), or `other`. Pure non-statements — bank current/savings account statements, invoices, receipts, contracts, random documents — are **rejected with a clear error** ("This file is not a credit card statement — nothing was imported") and nothing is processed or stored beyond an upload-rejection log entry. For a combined document, ONLY the credit card statement section is extracted, with a visible notice: "non-statement pages were ignored." The gate judges document TYPE, never bank familiarity: a card statement from a never-before-seen bank must pass the gate and attempt extraction (reconciliation then judges the result); a familiar bank's non-card document must still fail. The scope of this product is credit cards only (owner decision); it must never half-parse a wrong document into the expense database. Real negative fixture: the RHB current-account statement for a business account (account no. 207-xxx, deposit-account layout with running balance column) must be rejected at this gate.
- Use the Claude API to read the entire PDF and extract, regardless of page position or layout:
  - Statement-level: bank, statement date, payment due date, currency, per-card sections — plus, where printed: each card's credit limit and the current retail interest rate / tier line (e.g. RHB "CURRENT RETAIL INTEREST IS 15.00%"), stored per statement-card for FR-20 tier tracking and FR-10 utilization.
  - Per-card: card number (masked, last 4), cardholder name, opening/previous balance, closing/statement balance, minimum payment due, credit limit, and summary totals where printed (total credits, total debits/retail, cash advance).
  - Per-transaction: transaction date, posting date (if present — captured but NOT used as the record date), raw description, RM amount, direction (debit/credit), original currency + original amount for FX transactions.
- Extraction returns strict JSON conforming to a schema; invalid JSON triggers one retry, then flags the statement as failed.
- Promo text, announcements, T&C, reward summaries are ignored as transactions.

### FR-3: Date Resolution Rules (critical — a previous build failed here)
- **Record by transaction date only.** Posting date is stored as metadata but never used as the expense date.
- Transaction dates on statements omit the year (and some banks print ambiguous dd/mm). Resolve every date by anchoring to the statement date:
  - Statement period ≈ the ~31 days ending at the statement date.
  - If transaction month ≤ statement month → statement year.
  - If transaction month > statement month (e.g., Dec transactions on a Jan statement) → statement year − 1.
  - For dd/mm ambiguity, resolve by which interpretation lands in the valid window — and the window differs by field type: **transaction dates** must fall inside the statement period; **payment due dates** must fall 10–30 days *after* the statement date (e.g., "04/08/2026" on a 15 Jul 2026 statement = 4 August, never 8 April). Exactly one interpretation will satisfy its window; if neither or both do, flag for review.
  - **Due dates cross the year boundary forward:** a December statement's due date falls in January of the NEXT year (statement year + 1). The 10–30-day window rule governs; never assume the due date shares the statement's calendar year. Mandatory unit test: statement dated 15 Dec 2026 with due date "04/01" → 4 Jan 2027.
- Any transaction date that resolves outside the statement period ± 45 days → flag statement for review.
- Real fixture (mandatory unit test): the RHB statement dated 15 Jan 2026 contains transactions dated 16–30 Dec, which MUST resolve to December **2025** (statement year − 1), while its Jan transactions resolve to 2026.

### FR-4: Arithmetic Reconciliation (the trust layer)
- After extraction, for every card section compute: opening balance − credits + debits, and compare to the extracted closing balance.
- **Match (to the sen):** statement auto-accepted.
- **Mismatch → automatic self-correcting re-parse FIRST (owner-approved):** before anything reaches a human, the system automatically retries extraction ONCE, feeding the model its own arithmetic error ("your rows sum to X, the statement's closing balance is Y, delta Z — re-examine the statement, paying attention to missed rows, sign errors, and two-line FX entries"). If the retry reconciles exactly, it commits normally with the retry logged. Only if the retry also fails does the statement enter "Needs Review", showing the discrepancy amount and the parsed rows; nothing is committed to the expense database until the user resolves it (edit rows, re-parse, or force-accept with a logged override). Human review is the second line of defense, not the first — this matters at multi-year backfill volume.
- Where the bank prints summary totals (e.g., UOB's Retail Purchase total), cross-check those too as secondary validation.
- **Cross-statement chain reconciliation:** for each card, the opening balance of statement N must equal the closing balance of statement N−1. On upload, verify against the adjacent statements already in the database; a mismatch or a missing month triggers a "gap detected — statement missing or out of sequence" warning (never a silent accept). The provided RHB Jan–Jul 2026 chain (closing balances 922.83 → 37.71 → 304.00 → 1,345.80 → 10,252.94 → 466.11 → 513.36, each equal to the next month's opening) is the ground-truth fixture. Chain rules of order: (a) the earliest statement of a card in the database is exempt from the backward check; (b) statements may arrive in ANY order — the multi-year backfill will not be chronological — so chain checks re-evaluate whenever a neighbor arrives; (c) gap warnings auto-resolve the moment the missing statement is imported, no manual dismissal needed; (d) **new-card detection flow (owner decision):** when a statement arrives for a card number not yet in the system, the user is prompted to choose "record as a NEW card" or "this REPLACES / continues an existing card" (picking the predecessor from a list — covers expiry reissues, lost-card replacements, product upgrades). Choosing continuation links the chain across the number change, carries over the display name and default business tag, and preserves the full history under one logical card timeline; a "link predecessor card" action in settings remains available to fix it later.
- **Credit (CR) balances:** opening/closing balances can themselves be CR (overpaid account) — store as negative values and carry the sign through all reconciliation math. Real fixture: RHB 15 Jan 2026 opening balance is 127.02 CR, and −127.02 + 1,049.85 debits = 922.83 closing, exactly.

### FR-5: Transaction Typing
Every row is typed as one of:
- **purchase** — normal spending (counts toward expense reports)
- **refund** — CR that reverses spending; recorded and displayed as its own transaction line under a "Refunds" category, and shown as a separate series in reports — **never silently netted into a spending category's total** (owner decision, Q9). **Payment-vs-refund disambiguation (hard rule):** a CR row is a `payment` only if its description carries a payment descriptor (e.g. "TRANSFER / TOP-UP THANK YOU-CLICKS", "DUITNOW TO ACCOUNT", "PYMT VIA SA/CA ACCOUNT", "CASH PAYMENT AT ..."); a CR row carrying a merchant name is a `refund`. Refunds may reverse purchases from a PREVIOUS statement, often for the exact original amount. Real fixture: CIMB 19 Apr 2024 opens with two Lazada CR rows (3,090.31 + 3,229.74) reversing 16 Mar purchases from the prior statement — both MUST be typed refund; typing them payment corrupts payment auto-detection by RM6,320.05.
- **payment** — cardholder payment to the bank (e.g., "PYMT VIA SA/CA ACCOUNT", "PAYMENT REC'D WITH THANKS-DUITNOW"); excluded from expense totals; feeds payment-tracking (FR-9)
- **fee/interest** — LATE CHARGES, FINANCE CHARGES, annual fees, service tax; category "Bank fees & interest", shown separately in reports
- **instalment** — recurring instalment charges (e.g., "EP-OGAWA-36MTHS : 03/36"); linked to an instalment plan record (FR-6)
- **cash_advance** — if present

### FR-6: Instalment Plan Tracking
- Detect instalment transactions (pattern: plan name + "NN/MM" progress) and statement instalment-summary tables (principal, rate, remaining months, outstanding principal).
- Maintain an instalment plan record per plan: monthly amount, total months, months elapsed, outstanding principal, projected end date.
- **Plan identity (never merge distinct plans):** a plan is identified by card + plan name + total months + principal amount, and each new statement's NN/MM must be exactly the previous NN + 1. A row that matches by name but conflicts with the active plan's progression — e.g., a fresh "01/36" while an existing EP-OGAWA plan sits at 07/36 — is a NEW plan (the user bought the same product again), never an update to the existing one. Ambiguous matches go to the confirmation queue.
- Dashboard shows committed future obligations (total outstanding instalment principal and monthly commitment).

### FR-7: Category Classification (learning system)
- Category taxonomy (editable by user): F&B / Restaurants, Groceries, Utilities (TNB, PBA, etc.), Telco (Maxis, Digi, Time, etc.), Online Purchases (Lazada, Shopee, Taobao, etc.), Transport & Fuel, Health & Pharmacy, Insurance, Subscriptions (Netflix, Spotify, etc.), Retail & Shopping, Kids & Family, Pets, Home & Renovation, Fitness & Sports, **Paying on Behalf** (spending made on behalf of someone else, typically to be reimbursed — shown as its own series in reports so it never distorts the user's true spending), Bank Fees & Interest, Refunds, Other.
- **Categories describe WHAT was bought. Business attribution (who it was for) is a separate dimension** — the business tag in FR-8 — never a category. A business lunch is F&B *and* tagged to the relevant company; the two axes are filtered independently in reports.
- **Merchant learning table:** merchant pattern → category. Seeded with obvious Malaysian merchants; grows from user confirmations. Once confirmed, the same merchant never asks again (user can re-map anytime).
- Classification order: (1) learning table match → auto-assign; (2) LLM suggestion with confidence; high confidence auto-assigns but remains editable; (3) low confidence / unknown → **confirmation queue**: system may use web search to research the merchant, then presents its recommendation with a dropdown of all categories for the user to confirm.
- Bulk-confirm UI: the queue groups identical merchants so one confirmation clears all pending rows for that merchant.

### FR-8: Multi-Card, Supplementary Card & Business Attribution
- Data model supports multiple card accounts per statement (RHB pattern) and multiple banks per user.
- Each card carries user-editable labels: display name and a **default business tag** (Personal, or one of the user's companies from onboarding, FR-14).
- **Per-transaction override (owner decision, Q2):** every transaction inherits its card's default tag but can be individually re-tagged — business purchases on a personal card (and vice versa) must be attributable correctly. Override is one tap/click in the transactions table; overridden rows are visually marked.
- Dashboard and reports let the user **show/hide individual cards** and filter independently by card, business tag, and category. Supplementary card spending is recorded fully and attributable.

### FR-9: Payment Due Tracking, Reminders & Payment Recording
- On every upload, capture per card: payment due date, minimum payment due, statement balance.
- **Upcoming Payments panel** on the dashboard: card, statement balance, minimum due, due date, days remaining, status; color-coded (green >7 days, amber ≤7, red ≤2 or overdue).
- **Reminders:** email (Phase 3; provider e.g. Resend) at 7 / 3 / 1 days before due and on the due date, until the payment is recorded. In-app banner always. WhatsApp reminders are explicitly backlogged (owner decision, Q6) — email first.
- **Statement-arrival nudge (owner-approved):** the system learns each card's statement cycle (e.g. CIMB ~19th, RHB ~15th, UOB ~8th). If no statement has been uploaded within a few days after the expected date, send ONE nudge — "Your [card] statement should be available now — upload it to keep tracking current." Without the statement, every downstream feature goes blind; this closes the upstream gap. Subject to the same degradation rules as predictive reminders (pause after two ignored cycles). Largely superseded per-card once email ingestion is active for that card.
- **Predictive reminders:** learn each card's statement cycle (CIMB ~19th, RHB ~15th, UOB ~8th) and fire a reminder based on the predicted due date even if the statement hasn't been uploaded yet — covers the "forgot to upload" failure mode. Also remind "statement expected — please upload" a few days after the predicted statement date.
- **Payment recording — promote full payment (priority requirement):** when the user marks a card cycle paid, present:
  1. **Full payment paid** (statement balance; pre-selected default, visually primary)
  2. **Minimum payment of RM {minimum_due} paid**
  3. **Other amount paid: RM ____** (manual entry)
  - If the user selects minimum or other-below-full, show a non-blocking note with the estimated finance-charge consequence (18% p.a. on carried balance) — inform, don't nag twice.
- **Auto-detection (cumulative — Test 6 fixture):** a cycle may be settled by MULTIPLE payments; the CIMB Jun 2026 statement contains four (CASH PAYMENT, DUITNOW, and two Clicks transfers). Auto-detection therefore SUMS all rows typed `payment` in the following statement — refund CRs are EXCLUDED from this sum (see FR-5 disambiguation; the CIMB Apr 2024 fixture's Lazada refund CRs must not count) — and compares the cumulative total against the prior cycle's statement balance, using each payment row's transaction date vs the due date to judge timeliness. A cumulative payment total exceeding the prior statement balance (prepayment) still resolves to paid_full. `amount_paid` is cumulative; status derives from the sum (≥ statement balance → paid_full; ≥ minimum → paid_minimum; else paid_other/overdue). Manually recorded payments reconcile against the detected total, with discrepancies surfaced.
- **Direction rules (hard):** a `payment` row is always CR — a DR row must never be typed payment regardless of wording (e.g., "CASH PAYMENT AT D591" is CR → payment, not cash advance); a `cash_advance` row is always DR.
- **Predictive reminder degradation:** predicted reminders are labeled "estimated — statement not yet uploaded," and pause automatically after two consecutive cycles with no upload for that card (resuming on the next upload), so a card the user has stopped using doesn't nag forever. A per-card snooze/disable is available in settings.
- Payment history per card is retained (supports awareness of banks' tiered 15/17/18% interest qualification).

### FR-10: Dashboard & Reports (main page)
- Main page IS the report page:
  - **Bar chart:** monthly total expenses (12-month default, adjustable range).
  - **Pie/donut chart:** category breakdown for the selected period.
  - **Upcoming Payments panel** (FR-9).
  - **Instalment commitments panel** (FR-6).
  - **Credit utilization stat (owner-approved):** per card and combined — latest statement balance ÷ credit limit, clearly labeled "as of statement date [date]" (statement data is 2–4 weeks stale by nature; no false real-time claims). Sustained high utilization is CCRIS-relevant; keep it a simple labeled stat, nothing fancier.
  - Filters applied globally: date range, card(s), purpose tag(s), categories, include/exclude fees & refunds.
  - View customization: user chooses which panels/charts display, chart granularity (monthly/quarterly/yearly), top-N categories vs all.
- **Transactions page:** searchable, sortable, filterable table; inline category editing; drill-down from any chart segment.
- **Export:** CSV and Excel (.xlsx) of any filtered view; summary report (period totals by category, by card, and by business tag) exportable as PDF or Excel. **Exports follow the currently selected UI language** (English UI → English export; Chinese UI → Chinese export; owner decision, Q10). Reporting periods default to calendar year.

### FR-11: Authentication & Security
- Email + password login with password recovery via email reset link (Supabase Auth provides both).
- Password protection toggleable per user preference in settings (for single-user local convenience), but the hosted app always requires auth.
- All data scoped per user (row-level security) — this is the multi-user-ready foundation.
- Statement PDF passwords stored encrypted using a **server-side application key, deliberately independent of the user's login password** — so account password recovery (FR-11 reset flow) never renders the saved statement passwords unrecoverable. Never plaintext.
- HTTPS only. No card PANs stored — last-4 + bank only.

### FR-12: Platforms & Sync
- Responsive web application = Windows, macOS, Android, iOS coverage; installable as a PWA for app-like mobile use.
- Hosted online; database is the single source of truth → sync across devices is automatic. No native apps in scope.

### FR-13: Internationalization (English + Simplified Chinese)
- Full UI available in English and Simplified Chinese (zh-CN); language toggle in the header, preference saved per user.
- Implementation rule: **no hard-coded UI strings anywhere** — every label, button, message, chart title, email reminder, and error goes through the i18n framework (next-intl) from the first line of UI code. Retrofitting i18n later is far more expensive than wiring it in from the start, so this applies from Phase 2 onward even though translations can be completed later.
- What gets translated: all UI chrome, category names (categories table gets `name_en` / `name_zh` columns; user-created categories can be named in either), reminder emails, export report headers.
- What does NOT get translated: raw transaction descriptions (stored and displayed exactly as printed on the statement — they are audit data), bank names, merchant names.
- Locale-aware formatting: dates and numbers follow the selected locale; currency remains RM throughout.
- Architecture must allow adding further languages later by dropping in a new translation file only (relevant if the SaaS path is ever pursued in the Malaysian market — English/Chinese/Malay).

### FR-14: Onboarding & User Profile
- Before first use, a one-time setup page collects: preferred language, display name, email for reminders, and — critically — the user's **companies/businesses** (name + short label), supporting users who own more than one company. These become the selectable business tags used throughout FR-8.
- Companies are editable later in settings (add, rename, archive — never hard-delete while transactions reference them).
- Onboarding also walks through adding the user's card sources (bank, last-4, default business tag) so the first statement upload lands on a prepared structure.
- The system is strictly **single-user per account** (owner decision, Q7): no shared logins, no household accounts. A spouse or partner registers independently.

### FR-15: Transaction Editing & Audit Trail (owner decision)
- Users MAY edit a transaction's category, business tag, notes — and also its amount/date if they believe extraction erred — but **every edit is recorded**: field changed, original value, new value, timestamp. Nothing is ever edited in place invisibly.
- The originally extracted values are IMMUTABLE and always preserved. Reconciliation always runs against the extracted values (so the arithmetic trust layer is never corrupted by an edit); reports and exports use the edited values; edited rows carry a visible "edited" marker.
- A dedicated **Edit History page** lists all edits (filterable by card/date/field) with before → after values and a one-tap revert per edit.
- Statement-level force-accept overrides (Needs Review resolution) appear in the same history.

### FR-16: Statement Deletion
- Statement-level delete only — never single-transaction delete (that would break reconciliation). Deleting a statement removes its transactions, recomputes chain-gap warnings, and shows a confirmation dialog listing exactly what will be removed (statement date, card(s), transaction count, total). Re-upload after deletion is permitted. Deletions are logged in the Edit History page.

### FR-17: Cost Transparency & Failure Notifications (owner decision)
- **Warn before LLM access:** before any batch is sent to the Claude API, show the user what will be processed and an estimated cost, requiring confirmation to proceed ("Process 32 statements — estimated cost ~RM X. Continue?"). Single-statement uploads show a lightweight inline estimate. Per-user cumulative API cost is tracked and visible in settings — this cost-accounting structure is multi-user-ready by design, since the system is intended to eventually serve the public, not only the owner.
- **Reconciliation failure notifications:** EVERY statement that fails reconciliation or lands in Needs Review triggers BOTH an email and an in-app prompt — never a silent badge. Batch uploads additionally end with a summary ("29 of 30 verified; 1 needs review").
- **Monthly digest email (owner decision: IN):** on each statement import, send a digest — total spend by category and by business tag, comparison vs the prior month, refunds, and upcoming payment due dates. Follows the user's UI language.

### FR-18: Dispute-Window Alert & Unusual-Item Flags (owner-approved)
- Malaysian card statements are legally conclusive if discrepancies aren't reported within **14 calendar days of the statement date** (printed on every fixture statement). On import, compute and display the dispute deadline: "Dispute window closes [date] — review flagged items now."
- Rule-based unusual-item flags shown with the deadline: first-ever-seen merchants for this user, foreign-currency transactions, and duplicate same-merchant-same-amount rows within one statement. Flags are informational nudges for the user's review — never auto-disputes. This converts the upload habit into fraud protection with a real legal deadline attached.
- If the statement is uploaded after its window has already closed (normal during backfill), no alert is raised.

### FR-19: Recurring Charge & Subscription Detection (owner-approved)
- Detect recurring patterns across statements: same merchant, similar amount, regular monthly cadence (fixtures: Netflix, Spotify, Coway, AIA, Anytime Fitness).
- **Active Subscriptions view:** each detected recurrence with merchant, amount, cadence, first/last seen, and the total monthly recurring commitment.
- **Price-change alert** when a recurring charge's amount changes; **zombie flag** when a recurrence has been charging ≥ 3 months without the user having confirmed it — silent money leaks live here.
- User can confirm, rename, or dismiss detected recurrences; dismissals are remembered.

### FR-20: Cost-of-Credit Analytics & Interest-Tier Tracking (owner-approved)
- **"What your cards cost you" report:** total fees + interest (fee_interest-typed rows: late charges, finance charges, card service tax, annual fees) per card, per month, and per calendar year — behavioral feedback worth more than any chart.
- **Interest-tier tracking:** the printed retail interest rate per statement-card (15% / 17% / 18% behavioral tiers) is stored on every import; ALERT the user (email + in-app) whenever a card's tier WORSENS versus its previous statement — early warning that late payments now cost more on every ringgit of balance. Tier history is visible per card.

### FR-21: "Paying on Behalf" Reimbursement Lifecycle (owner-approved)
- Every transaction categorized Paying on Behalf gains: optional "for whom" text, status (owed | repaid), and repaid date.
- **"Owed to me" panel:** outstanding on-behalf amounts totaled per person, with one-tap mark-as-repaid. Without this lifecycle the category is just a label and repayments get tracked in the user's head — the exact failure mode this system exists to eliminate.

### FR-22: Director/Owner Claim Report Generator (owner-approved)
- One action: "Generate claim report — [business tag], [period]" producing an itemized, exportable document (PDF/Excel): each business-tagged transaction with date, merchant, amount, card, and source-statement reference, plus period totals.
- Purpose: substantiation for director/owner expense claims when reimbursing business spending made on personal cards — turns tagging work the user already does into the compliance document currently assembled by hand. Suitable for company records and audit; follows the UI language; respects the FR-15 edited-values rule (report uses edited values, notes the edit marker).

---

## 4. Data Model (PostgreSQL)

```
users            id, email, created_at, settings_json
banks            id, name (CIMB/RHB/UOB/...), statement_day_of_month_estimate
companies        id, user_id, name, label, archived bool
card_accounts    id, user_id, bank_id, last4, holder_label,
                 default_business_tag (personal | company_id),
                 is_supplementary, parent_card_id (nullable), display_name,
                 show_on_dashboard bool, statement_pdf_password_encrypted (nullable)
statements       id, user_id, bank_id, filename, file_hash, uploaded_at,
                 statement_date, period_start, period_end, payment_due_date,
                 status (parsed_ok | needs_review | failed), pdf_storage_path,
                 model_version, prompt_version, retry_count,
                 raw_extraction_json
statement_cards  id, statement_id, card_account_id, opening_balance,
                 closing_balance, minimum_due, credit_limit,
                 retail_interest_rate (nullable — printed tier, FR-20),
                 summary_totals_json, reconciliation_delta
recurrences      id, user_id, card_account_id, merchant_pattern, typical_amount,
                 cadence, first_seen, last_seen, status (detected|confirmed|dismissed)
transactions     id, user_id, statement_card_id, card_account_id,
                 txn_date, posting_date (nullable), description_raw,
                 merchant_normalized, amount_rm, direction (debit|credit),
                 original_currency (nullable), original_amount (nullable),
                 txn_type (purchase|refund|payment|fee_interest|instalment|cash_advance),
                 category_id, category_source (learned|llm|user), confidence,
                 business_tag (personal | company_id), business_tag_overridden bool,
                 user_amount (nullable override — extracted amount immutable),
                 user_txn_date (nullable override), notes, edited bool,
                 on_behalf_party (nullable), on_behalf_status (owed|repaid, nullable),
                 on_behalf_repaid_at (nullable),
                 needs_confirmation bool
edit_log         id, user_id, entity (transaction|statement), entity_id,
                 field, old_value, new_value, action (edit|revert|delete|force_accept),
                 created_at
api_cost_log     id, user_id, statement_id (nullable), tokens_in, tokens_out,
                 est_cost_rm, created_at
categories       id, user_id (null = system default), name_en, name_zh,
                 parent_id, sort_order
merchant_rules   id, user_id, merchant_pattern, category_id, txn_type_override,
                 created_from_txn_id, confirmed_at
instalment_plans id, user_id, card_account_id, plan_name, monthly_amount,
                 total_months, months_elapsed, principal_total,
                 principal_outstanding, projected_end_date
payment_cycles   id, user_id, card_account_id, statement_id, due_date,
                 statement_balance, minimum_due,
                 status (unpaid|paid_full|paid_minimum|paid_other|overdue),
                 amount_paid, paid_recorded_at, auto_detected bool
reminders_log    id, payment_cycle_id, channel, sent_at
```

Constraints: unique (user_id, file_hash) on statements; unique (user_id, card_account_id, statement_date) on statement_cards — NOT at bank level, because a user can legitimately hold two separate card accounts at one bank each issuing its own statement on the same date; duplicate detection = file hash first, then card-account + statement-date collision; all monetary values `numeric(12,2)`; reconciliation_delta must be 0.00 for status `parsed_ok`.

---

## 5. Processing Pipeline

```
Upload PDF
  → decrypt if needed (saved or prompted password)
  → hash + duplicate check
  → document-type gate: credit card statement? no → REJECT with error, stop
  → store original PDF
  → Claude API extraction (strict JSON schema; 1 retry on schema failure)
  → date resolution (anchor to statement date; year-boundary rule)
  → transaction typing (purchase/refund/payment/fee/instalment/cash_advance)
  → per-card arithmetic reconciliation
      ├─ match  → commit to DB
      └─ mismatch → Needs Review queue (nothing committed)
  → classification pass (merchant_rules → LLM suggest → confirmation queue)
  → payment_cycles upsert (due date, balances) + match payment CRs to prior cycle
  → instalment plan detect/update
  → dashboard refreshed
```

Extraction prompt requirements: output JSON only; include statement summary figures; never invent rows; mark uncertain fields with nulls rather than guesses; treat CR/"-"/parenthesized amounts as credits.

---

## 6. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js (App Router, TypeScript) | One codebase for UI + API routes; huge documentation base; AI-tooling-friendly |
| Database / Auth / Storage | Supabase (Postgres + Auth + Storage + Row-Level Security) | Auth with password recovery built in; RLS gives multi-user isolation from day one; PDF storage included |
| LLM extraction & classification | Claude API (PDF input, JSON output) | Semantic, layout-agnostic parsing |
| PDF decryption | qpdf or pikepdf server-side | Handle password-protected statements before sending to LLM |
| Charts | Recharts | Simple bar/pie with filtering |
| Email reminders | Resend (or equivalent) | Simple transactional email |
| Excel export | SheetJS (xlsx) | CSV + Excel generation |
| Internationalization | next-intl | English + Simplified Chinese UI; translation-file-based, extensible |
| Hosting | Vercel (app) + Supabase (data) | Zero-ops deployment |

**Maintainability rules (non-negotiable):** one framework, one database; every module has a plain-English README; a top-level `ARCHITECTURE.md` explains the pipeline in non-programmer language; no clever abstractions; environment variables documented in `.env.example`.

---

## 7. Build Phases

**Phase 1 — Parse & Verify (core value):**
Upload, decryption, registry + duplicate detection, document-type gate, LLM extraction (with model_version/prompt_version recorded per statement), date resolution, transaction typing, **self-correcting re-parse on reconciliation failure (FR-4)**, reconciliation + chain checks, Needs Review screen. **The Section 10 fixture suite is encoded as an automated regression harness in Phase 1 and runs on EVERY code change thereafter** — a Phase 3 change that silently breaks Phase 1 parsing must fail CI, not be discovered when the numbers are wrong. CLI-or-simple-UI acceptable. **Exit: the ENTIRE fixture set (all provided statements including the 2024 batch and both trap files) passes every §10 criterion to the sen, via the automated harness.**

**Phase 2 — Classify & Store:**
Onboarding & profile page (FR-14), category taxonomy, merchant learning table, confirmation queue with dropdown + bulk confirm, transactions table UI with business-tag override, instalment tracking, **bulk historical import** (owner will backfill several years of statements; the upload flow must handle batches of PDFs in one session, processing sequentially with a progress view). i18n framework wired from the first UI screen (all strings via next-intl; English strings first, Chinese keys stubbed).

**Phase 3 — Dashboard, Reports & Payments:**
Bar + pie charts, filters (card / business tag / category), show/hide cards, credit utilization stat, exports (CSV/Excel/PDF summary, language-aware), Upcoming Payments panel, payment recording (full / minimum / other — full pre-selected), email + predictive reminders, statement-arrival nudge, payment auto-detection, monthly digest email on import (FR-17), reconciliation-failure email + in-app prompts (FR-17), Edit History page (FR-15), statement deletion flow (FR-16), dispute-window alerts + unusual-item flags (FR-18), subscription/recurring detection with price-change and zombie alerts (FR-19), cost-of-credit report + interest-tier tracking and worsening alerts (FR-20), Paying-on-Behalf reimbursement lifecycle + Owed-to-me panel (FR-21), director/owner claim report generator (FR-22), **email statement ingestion** (dedicated ingestion address; forwarded bank emails have their PDF attachments extracted and processed through the same pipeline, including the document-type gate and duplicate check — owner decision, Q1 of round 2).

**Phase 4 — Hardening & Polish:**
Auth flows — **passwordless email OTP login** (owner decision; nothing to forget or leak; phone-first UI throughout, dashboard equally strong on desktop), encrypted statement-password vault, PWA install, settings (including per-user API cost view), **account deletion with full purge** (delete my account → removes transactions, statements, stored PDFs, logs, and derived data irrecoverably, with confirmation; the purge path is designed now because Malaysia's PDPA applies the moment the system serves the public — full PDPA consent/retention legal review belongs to the public-launch stage), complete Simplified Chinese translation pass (UI, emails, digest, export headers, seeded category names), language toggle, docs pass, backup/export-all.

**Explicit non-goals for now (backlog):** multi-user SaaS onboarding/billing, budgets and spending-limit alerts (owner decision: retrospective tracking first), WhatsApp reminders, shareable chart-snapshot images (bar/pie chart exported as an image for sharing), local-first/on-device statement storage mode (owner's stated architecture direction for a future monetized version — statements stored on the user's own device with a privacy notice), reward-points expiry tracking, bank API integrations, native mobile apps, receipt/OCR of non-statement documents. **Resolved (owner decision):** bank current/savings account statements are OUT of scope — this is a credit card system, not an all-scope financial tracker. Non-credit-card PDFs are rejected at the FR-2 document-type gate, never partially ingested. Bank-account ingestion remains a possible far-future extension only. **Design posture:** although built for a single owner first, every structure (cost accounting, RLS, onboarding, i18n, card flows) must be generic multi-user shapes — the system is intended to eventually go public; nothing may hard-code the owner's specifics.

---

## 8. UX Notes

- Confirmation queue is the only place the system asks questions; everything else is automatic. Group by merchant; one tap confirms all instances.
- Needs Review screen shows: parsed rows, expected vs computed closing balance, delta, and side-by-side original PDF page.
- Payment dialog: Full payment is the visually primary, pre-selected option. Minimum and Other are secondary. One informational line on interest cost when not paying full — shown once, not repeated.
- Dashboard defaults: last 12 months, all visible cards, fees shown as separate series, refunds shown as a separate series (never netted into category totals).

## 9. Error Handling & Edge Cases

- Scanned/image-only PDFs: attempt extraction anyway (Claude reads images); if reconciliation fails, flag with guidance.
- **Timezone:** ALL date arithmetic — due-date countdowns, reminder scheduling, "days remaining," statement-cycle prediction — is computed in Asia/Kuala_Lumpur, never server/UTC time. A reminder firing on the wrong calendar day is a defect in this product's core purpose.
- **Locale-aware dynamic text:** LLM-generated content shown to the user (merchant research summaries, category suggestions in the confirmation queue) is produced in the active UI language — the extraction/classification prompts receive the user's locale. Static strings are covered by FR-13; this covers the dynamic ones.
- Statement crossing year boundary (Jan statement, Dec transactions): covered by FR-3 rule — include a unit test.
- Zero-activity card sections (RHB supplementary this month): record the card with opening=closing, no transactions — not an error.
- Same-day duplicate transactions at one merchant (UOB FamilyMart pattern in CIMB statement): both are real; never dedupe committed transaction rows.
- Currency: store RM as canonical amount always; original currency/amount as metadata only. FX rows may denote the currency by name OR by numeric ISO 4217 code prefix — real fixtures: "CNY 749.22", "840U.S. DOLLAR 2.16" (840 = USD), "344HONG KONG DOLLAR 40.00" (344 = HKD), "901NEW TAIWAN DOLLAR 4,440.00" (TWD); the extractor must handle both forms.
- **A bank's own layout drifts over the years** — the CIMB 2024 fixtures differ from the 2026 ones (no invoice number, different contact details, different section order). Extraction must rely on semantic understanding, never on bank-specific templates or positional rules.
- **Card identity = bank + card number.** The printed cardholder name varies across years on the same card (real fixture: "DEAN LIM" on 2024 CIMB statements vs the full legal name on 2026 ones). Name variations must never create a duplicate card account during backfill; the holder label is display metadata only.
- LLM outage/failure: statement stays in `failed` state with retry button; never partial-commit.

## 10. Acceptance Criteria (ground truth from provided samples)

**CIMB — statement dated 19 May 2026:**
31 transaction rows including LATE CHARGES 71.83 and FINANCE CHARGES 120.57 (typed fee_interest). Previous balance 7,321.60; closing 13,374.87; reconciliation: 7,321.60 + 6,053.27 debits = 13,374.87 exactly. Taobao row: amount_rm 443.36, original CNY 749.22. Due date 8 Jun 2026; minimum 1,034.82. All transaction dates resolve to Apr/May 2026 within period.

**RHB — statement dated 15 Jul 2026:**
Two card sections (…3799 principal, …2505 supplementary with zero activity). Principal: opening 466.11 → closing 513.36. Rows include one refund CR 470.57 (WEIXIN), two payments CR 150.00 + 320.00 (typed payment, excluded from expenses), one instalment row 277.75 tagged to plan EP-OGAWA-36MTHS (03/36; principal 9,999.00; outstanding 9,165.75; 33 months remaining). Reconciliation exact. Due date resolves to 4 Aug 2026 (not 8 Apr).

**UOB — statement dated 8 Jul 2026:**
Transactions found on page 5 despite 4 preceding non-transaction pages. 8 retail rows (sum 203.40, matching printed Retail Purchase total) + 1 payment CR 200.00. Previous 35.38 → closing 38.78; reconciliation exact. No posting dates (nullable field). Due 28 Jul 2026; minimum 38.78. Transaction dates span Jun–Jul 2026, resolved correctly.

**General:** re-uploading any of the three PDFs is rejected as duplicate. A deliberately corrupted copy (one amount altered) must land in Needs Review, not the database.

**Extended fixture set (RHB Jan–Jul 2026 chain + CIMB Jun 2026):**
- **Chain:** RHB principal card statements Jan through Jul 2026 form an unbroken chain — each closing balance (922.83, 37.71, 304.00, 1,345.80, 10,252.94, 466.11, 513.36) equals the next statement's opening. Importing all seven must produce zero gap warnings; deleting the April statement and re-checking must produce exactly one.
- **Year boundary:** RHB 15 Jan 2026 statement — all Dec transactions dated December 2025, all Jan transactions January 2026.
- **CR opening balance:** same Jan statement opens at 127.02 CR (stored negative) and still reconciles exactly to 922.83.
- **Supplementary card with activity:** Jan statement's supplementary section has 3 purchases + 1 payment netting to 0.00 — all four rows captured, attributed to the supplementary card.
- **Instalment progression:** EP-OGAWA appears as 01/36 (May), 02/36 (Jun), 03/36 (Jul) with outstanding principal 9,721.25 → 9,443.50 → 9,165.75; the instalment plan record must update, not duplicate, across uploads.
- **Payment description variety (CIMB Jun 2026):** four different payment formats in one statement — "CASH PAYMENT AT D591", "DUITNOW TO ACCOUNT", and two "TRANSFER / TOP-UP THANK YOU-CLICKS" entries — all typed `payment`, none counted as spending or refunds. Statement reconciles 13,374.87 opening → 4,496.28 closing.
- **Duplicate uploads:** the fixture batch intentionally contains the same RHB statement uploaded twice (identical file) and a re-upload of an earlier statement — both must be rejected with a clear duplicate warning, and existing data must never be overwritten or double-inserted.
- **Wrong-document rejection:** uploading the RHB business current-account statement (a deposit account, not a credit card) must be rejected at the document-type gate with a clear "not a credit card statement" error — zero transactions committed, zero statement records created. The same applies to any arbitrary non-statement PDF.

**CIMB 2024 fixture set (Jan–Jun 2024, older layout):**
- All six statements reconcile exactly (closings 1,397.84 → 4,019.91 → 7,657.09 → 5,582.75 → 973.25 → 923.89) and form an unbroken chain; after importing them alongside the 2026 fixtures, the chain checker must flag exactly the missing Jul 2024–Apr 2026 months for this card, and those warnings must auto-clear as intervening statements are uploaded.
- **Refund disambiguation (critical):** Apr 2024 statement's two Lazada CR rows (3,090.31 + 3,229.74, reversing 16 Mar purchases from the prior statement) typed `refund`, NOT payment; the Mar cycle's payment auto-detection total must exclude them.
- **Payment variety and prepayment:** Feb 2024 has two payments (DUITNOW 1,500 + Clicks 1,000) whose sum exceeds the prior balance 1,397.84 → prior cycle resolves paid_full; Mar 2024's 4,019.91 payment exactly equals prior balance → paid_full; Jun 2024 has three payments including two on the same day via different channels — all captured as separate payment rows.
- **FX with numeric ISO codes:** OPENRICE HKD ("344HONG KONG DOLLAR 40.00" → RM 24.53) and CYBERBIZ TWD ("901NEW TAIWAN DOLLAR 4,440.00" → RM 674.65) — RM stored as amount, currency + original amount as metadata.
- **Layout drift and name drift:** the 2024 statements (no invoice number, "DEAN LIM" as printed cardholder) import into the SAME card account as the 2026 statements (matched by bank + card number 2225), with no duplicate card created.
- Jan 2024 opens at 0.01 with a 3.69 CR payment — near-zero balances and an overpaying credit both handled without sign errors.

---

## 11. Definition of Done (per phase)

Code runs locally with one documented command; all acceptance tests for the phase pass; `ARCHITECTURE.md` updated in plain English; no secrets in the repo; the owner can perform the phase's core workflow end-to-end without touching code.
