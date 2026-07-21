-- Phase 2 schema additions (spec §6): categories, merchant learning,
-- classification columns, business attribution, on-behalf lifecycle, and the
-- FR-4d new-card continuation link.
-- Paste into the Supabase SQL Editor and Run (same as schema.sql before).
-- Idempotent: safe to run more than once.

-- ---------- category taxonomy (FR-7) ----------
create table if not exists categories (
  id bigint generated always as identity primary key,
  user_id uuid, -- NULL = system default category
  name_en text not null,
  name_zh text,
  parent_id bigint references categories(id),
  sort_order int not null default 0
);
create unique index if not exists categories_system_name
  on categories (name_en) where user_id is null;

insert into categories (name_en, name_zh, sort_order) values
  ('F&B / Restaurants',    '餐饮',        10),
  ('Groceries',            '杂货',        20),
  ('Utilities',            '水电费',      30),
  ('Telco',                '电信',        40),
  ('Online Purchases',     '网购',        50),
  ('Transport & Fuel',     '交通与燃油',  60),
  ('Health & Pharmacy',    '医疗与药房',  70),
  ('Insurance',            '保险',        80),
  ('Subscriptions',        '订阅服务',    90),
  ('Retail & Shopping',    '零售购物',   100),
  ('Kids & Family',        '孩子与家庭', 110),
  ('Pets',                 '宠物',       120),
  ('Home & Renovation',    '居家与装修', 130),
  ('Fitness & Sports',     '健身与运动', 140),
  -- owner requests 2026-07-21
  ('Lifestyle & Leisure',  '休闲娱乐',   143),
  ('Parking',              '停车费',     144),
  ('Travel Expenses',      '旅行开支',   145),
  ('Gift & Donation',      '礼物与捐赠', 146),
  ('Dispute',              '争议',       147),
  ('Medical',              '医疗',       148),
  ('Paying on Behalf',     '代付',       150),
  ('Bank Fees & Interest', '银行费用与利息', 160),
  ('Refunds',              '退款',       170),
  -- owner decision Q1 (2026-07-20): wallet top-ups are transfers, excluded
  -- from spending totals, own series in reports
  ('Wallet Transfers',     '钱包转账',   175),
  ('Other',                '其他',       180)
on conflict do nothing;

-- ---------- merchant learning table (FR-7) ----------
create table if not exists merchant_rules (
  id bigint generated always as identity primary key,
  user_id uuid not null default '00000000-0000-0000-0000-000000000001',
  merchant_pattern text not null, -- normalized merchant prefix, matched case-insensitively
  category_id bigint not null references categories(id),
  txn_type_override text check (txn_type_override in
    ('purchase','refund','payment','fee_interest','instalment','cash_advance')),
  created_from_txn_id bigint references transactions(id),
  confirmed_at timestamptz, -- NULL = seeded default, set when the user confirms
  unique (user_id, merchant_pattern)
);

-- ---------- classification + attribution columns on transactions ----------
alter table transactions add column if not exists category_id bigint references categories(id);
alter table transactions add column if not exists category_source text
  check (category_source in ('learned','llm','user'));
alter table transactions add column if not exists confidence numeric(4,3);
alter table transactions add column if not exists business_tag text not null default 'personal';
alter table transactions add column if not exists business_tag_overridden boolean not null default false;
alter table transactions add column if not exists on_behalf_party text;
alter table transactions add column if not exists on_behalf_status text
  check (on_behalf_status in ('owed','repaid'));
alter table transactions add column if not exists on_behalf_repaid_at timestamptz;

-- ---------- card-account attribution default (FR-8) ----------
alter table card_accounts add column if not exists default_business_tag text not null default 'personal';

-- ---------- FR-4d: new-card continuation ----------
-- A replacement/reissued card CONTINUES its predecessor's timeline (distinct
-- from parent_card_id, which models principal/supplementary). The chain check
-- follows this link across the card-number change.
alter table card_accounts add column if not exists continues_card_id bigint references card_accounts(id);
