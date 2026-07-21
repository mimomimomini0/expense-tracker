-- Merchant merge & rename (owner request 2026-07-21): card terminals register
-- the same shop under different names (CB&TL / CBTL / MYCBTL). An alias maps
-- a merchant key to its canonical display name; applied at READ time, so
-- nothing is rewritten and a merge is fully reversible.
-- Paste into the Supabase SQL Editor and Run. Idempotent.

create table if not exists merchant_aliases (
  id bigint generated always as identity primary key,
  user_id uuid not null default '00000000-0000-0000-0000-000000000001',
  merchant_key text not null, -- variant (normalized description, country tail stripped)
  canonical text not null,    -- display name, e.g. 'CBTL'
  created_at timestamptz not null default now(),
  unique (user_id, merchant_key)
);
