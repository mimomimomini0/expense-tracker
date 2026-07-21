-- Phase 2 addendum (FR-14 onboarding & profile): companies + user profile.
-- Paste into the Supabase SQL Editor and Run, same as schema-phase2.sql.
-- Idempotent: safe to run more than once.

create table if not exists companies (
  id bigint generated always as identity primary key,
  user_id uuid not null default '00000000-0000-0000-0000-000000000001',
  name text not null,
  label text not null, -- short label used as the business tag chip
  archived boolean not null default false, -- archive only; never hard-delete
  unique (user_id, label)
);

create table if not exists user_profiles (
  user_id uuid primary key default '00000000-0000-0000-0000-000000000001',
  language text not null default 'en' check (language in ('en','zh')),
  display_name text,
  reminder_email text
);

-- card display metadata used by the UI (spec §6 card_accounts; display_name
-- and show_on_dashboard already exist from schema.sql)
