-- Touch 'n Go e-wallet tables. Paste into the Supabase SQL Editor and Run
-- (choose "Run and enable RLS", same as before).

create table if not exists ewallet_accounts (
  id bigint generated always as identity primary key,
  user_id uuid not null default '00000000-0000-0000-0000-000000000001',
  provider text not null,
  account_no text not null,
  registered_name text,
  unique (user_id, provider, account_no)
);

create table if not exists ewallet_cards (
  id bigint generated always as identity primary key,
  user_id uuid not null default '00000000-0000-0000-0000-000000000001',
  ewallet_account_id bigint not null references ewallet_accounts(id),
  card_serial text not null,
  card_type text,
  unique (user_id, ewallet_account_id, card_serial)
);

create table if not exists ewallet_statements (
  id bigint generated always as identity primary key,
  user_id uuid not null default '00000000-0000-0000-0000-000000000001',
  ewallet_account_id bigint not null references ewallet_accounts(id),
  filename text not null,
  file_hash text not null,
  uploaded_at timestamptz not null default now(),
  period_start date,
  period_end date,
  status text not null check (status in ('parsed_ok','needs_review','failed')),
  model_version text,
  prompt_version text,
  pdf_storage_path text,
  unique (user_id, file_hash)
);

create table if not exists ewallet_transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null default '00000000-0000-0000-0000-000000000001',
  ewallet_statement_id bigint not null references ewallet_statements(id) on delete cascade,
  ewallet_card_id bigint not null references ewallet_cards(id),
  trans_no text,
  trans_date date not null,
  trans_datetime timestamptz,
  posted_date date,
  kind text not null check (kind in ('usage','reload','other')),
  trans_type_raw text not null,
  sector text,
  description text not null, -- Exit Location (owner decision)
  reload_source text,        -- for reloads: IBG / credit card / PIN / eWallet app...
  -- future: link a card-funded reload to its credit-card transaction, or an
  -- inter-card transfer (e.g. card 2164085007 funding card 1113643631)
  linked_transaction_id bigint references transactions(id),
  linked_ewallet_transaction_id bigint references ewallet_transactions(id),
  amount_rm numeric(12,2) not null,
  balance_after_rm numeric(12,2) not null
);
