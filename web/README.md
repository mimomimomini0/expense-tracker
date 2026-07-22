# Expense Tracker — Web UI (Phase 2)

Next.js (App Router) + TypeScript UI for the expense-tracker engine in `../src`.
Single user, English / Simplified Chinese, all data in Supabase.

## Pages

| Route           | Purpose |
| --------------- | ------- |
| `/transactions` | All transactions, newest first, with filters (card, category, type, date range) and inline edits for category / business tag / notes. Every edit also writes an `edit_log` row (FR-15). |
| `/queue`        | Confirmation queue (FR-7): `needs_confirmation` transactions grouped by merchant key. Confirming a group saves a `merchant_rules` row and clears the whole group. |
| `/onboarding`   | One-time profile (FR-14): language, display name, reminder email, companies (add / rename / archive), per-card display name + default business tag. |

## Environment

Supabase credentials are **not** stored in this directory. They are loaded from
the **parent** project's `.env` file (`expense-tracker/.env`):

```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

`src/lib/env.ts` uses `dotenv` to read `../.env` relative to the directory the
server is started from — so always run `npm run dev` / `npm run build` /
`npm start` from inside `web/`. The module is marked `server-only`: importing
it (or the Supabase client) from a client component is a build error, which
guarantees the service-role key never reaches the browser bundle.

All Supabase reads/writes happen in server components and server actions.
There is no client-side Supabase client.

## Language

Locale is cookie-based (`NEXT_LOCALE`, values `en` / `zh`) via next-intl,
without URL prefixes. Toggle in the header; saving a preferred language on
`/onboarding` also updates the cookie. All UI strings live in
`messages/en.json` and `messages/zh.json`. Raw transaction descriptions, bank
names and merchant names are displayed verbatim and never translated.

## Conventions

- Money: `RM 1,234.56` (credits shown in green with a leading minus).
- Dates: `YYYY-MM-DD`, timezone `Asia/Kuala_Lumpur`.
- Category / business-tag / notes edits set `category_source='user'` /
  `business_tag_overridden=true` / `edited=true` and insert `edit_log` rows.
  Extracted values are immutable — nothing else is editable from the UI.
- `companies` and `user_profiles` may not exist yet (Phase 2b addendum SQL).
  Pages that use them show a translated notice instead of crashing.

## Commands

```
npm install
npm run dev     # http://localhost:3000
npm run build
npm start
```

## Auth (Phase 4)

Passwordless email-OTP login, DISABLED by default. To enable: set
`AUTH_ENABLED=1` in the parent `.env` and restart. Only `ALLOWED_EMAIL` may
sign in; the 6-digit code arrives via Supabase Auth's built-in mailer.
Locked out? Set `AUTH_ENABLED=0` again. Sessions last 30 days
(HMAC-signed httpOnly cookie).

> The app verifies a **typed 6-digit code**, so Supabase's "Magic Link" email
> template must include `{{ .Token }}` (the default template sends a link
> instead). For the full cloud setup — Vercel Root Directory, the
> "include files outside root" build option, env vars and this template fix —
> see [`../DEPLOY.md`](../DEPLOY.md).
