-- Expense Tracker — Postgres schema (spec §4, Phase 1 subset).
-- Run this once in the Supabase SQL Editor (Dashboard -> SQL Editor -> paste -> Run).
-- Phase 1 is single-user; user_id defaults to a fixed owner UUID so the
-- multi-user shape (and the uniqueness constraints) exist from day one.

create extension if not exists pgcrypto;

create table if not exists banks (
  id bigint generated always as identity primary key,
  name text not null unique,
  statement_day_of_month_estimate int
);

create table if not exists card_accounts (
  id bigint generated always as identity primary key,
  user_id uuid not null default '00000000-0000-0000-0000-000000000001',
  bank_id bigint not null references banks(id),
  last4 text not null,
  holder_label text,
  is_supplementary boolean not null default false,
  parent_card_id bigint references card_accounts(id),
  display_name text,
  show_on_dashboard boolean not null default true,
  statement_pdf_password_encrypted text,
  unique (user_id, bank_id, last4)
);

create table if not exists statements (
  id bigint generated always as identity primary key,
  user_id uuid not null default '00000000-0000-0000-0000-000000000001',
  bank_id bigint not null references banks(id),
  filename text not null,
  file_hash text not null,
  uploaded_at timestamptz not null default now(),
  statement_date date not null,
  period_start date,
  period_end date,
  payment_due_date date,
  status text not null check (status in ('parsed_ok','needs_review','failed')),
  pdf_storage_path text,
  model_version text not null,
  prompt_version text not null,
  retry_count int not null default 0,
  review_reason text,
  raw_extraction_json jsonb,
  unique (user_id, file_hash)
);

create table if not exists statement_cards (
  id bigint generated always as identity primary key,
  user_id uuid not null default '00000000-0000-0000-0000-000000000001',
  statement_id bigint not null references statements(id) on delete cascade,
  card_account_id bigint not null references card_accounts(id),
  statement_date date not null, -- denormalised to carry the uniqueness constraint
  opening_balance numeric(12,2) not null,
  closing_balance numeric(12,2) not null,
  minimum_due numeric(12,2),
  credit_limit numeric(12,2),
  retail_interest_rate numeric(5,2),
  summary_totals_json jsonb,
  instalment_summaries_json jsonb,
  reconciliation_delta numeric(12,2) not null,
  -- card-account level, NEVER bank level (a user can hold two cards at one bank)
  unique (user_id, card_account_id, statement_date),
  -- reconciliation_delta must be 0.00 for committed statements
  check (reconciliation_delta = 0.00)
);

create table if not exists transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null default '00000000-0000-0000-0000-000000000001',
  statement_card_id bigint not null references statement_cards(id) on delete cascade,
  card_account_id bigint not null references card_accounts(id),
  txn_date date not null,
  posting_date date,
  description_raw text not null,
  merchant_normalized text,
  amount_rm numeric(12,2) not null,
  direction text not null check (direction in ('debit','credit')),
  original_currency text,
  original_amount numeric(14,2),
  txn_type text not null check (txn_type in ('purchase','refund','payment','fee_interest','instalment','cash_advance')),
  user_amount numeric(12,2), -- nullable override; extracted amount immutable
  user_txn_date date,
  notes text,
  edited boolean not null default false,
  needs_confirmation boolean not null default false
);

create table if not exists instalment_plans (
  id bigint generated always as identity primary key,
  user_id uuid not null default '00000000-0000-0000-0000-000000000001',
  card_account_id bigint not null references card_accounts(id),
  plan_name text not null,
  monthly_amount numeric(12,2),
  total_months int not null,
  months_elapsed int not null,
  principal_total numeric(12,2),
  principal_outstanding numeric(12,2),
  projected_end_date date
);

create table if not exists payment_cycles (
  id bigint generated always as identity primary key,
  user_id uuid not null default '00000000-0000-0000-0000-000000000001',
  card_account_id bigint not null references card_accounts(id),
  statement_id bigint not null references statements(id) on delete cascade,
  due_date date,
  statement_balance numeric(12,2) not null,
  minimum_due numeric(12,2),
  status text not null check (status in ('unpaid','paid_full','paid_minimum','paid_other','overdue')),
  amount_paid numeric(12,2) not null default 0,
  paid_recorded_at timestamptz,
  auto_detected boolean not null default false
);

create table if not exists upload_rejections (
  id bigint generated always as identity primary key,
  user_id uuid not null default '00000000-0000-0000-0000-000000000001',
  filename text not null,
  file_hash text not null,
  reason text not null check (reason in ('not_credit_card_statement','duplicate_file_hash','duplicate_statement')),
  detail text,
  created_at timestamptz not null default now()
);

create table if not exists edit_log (
  id bigint generated always as identity primary key,
  user_id uuid not null default '00000000-0000-0000-0000-000000000001',
  entity text not null check (entity in ('transaction','statement')),
  entity_id bigint not null,
  field text not null,
  old_value text,
  new_value text,
  action text not null check (action in ('edit','revert','delete','force_accept')),
  created_at timestamptz not null default now()
);

create table if not exists api_cost_log (
  id bigint generated always as identity primary key,
  user_id uuid not null default '00000000-0000-0000-0000-000000000001',
  statement_filename text,
  purpose text not null,
  model text not null,
  tokens_in int not null,
  tokens_out int not null,
  est_cost_usd numeric(10,4) not null,
  est_cost_rm numeric(10,2) not null,
  created_at timestamptz not null default now()
);
