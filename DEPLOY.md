# Deploying the Expense Tracker to Vercel

Runbook for putting `web/` online. Everything here except the steps marked
**[you]** was verified on 2026-07-22 by a clean production build. The **[you]**
steps need your Vercel/GitHub/Supabase accounts, so I can't do them for you —
follow them in order.

The engine (`src/`, scripts, harness) is **not** deployed. Only the Next.js app
in `web/` goes to Vercel. Imports, backfill and classification keep running
locally on your PC as before.

---

## 0. What you're deploying

- **App:** `web/` — Next.js 15 App Router, all rendering server-side.
- **Data:** your existing Supabase project (unchanged — Vercel just talks to it).
- **Auth:** email-OTP, single user. Off locally, **must be turned on for the
  public deploy** (step 4) or anyone with the URL sees your finances.
- **Cost:** Vercel Hobby plan is free and enough for one user. Supabase you
  already have.

---

## 1. Push the repo to GitHub  **[you]**

Vercel deploys from a git repo, and there's **no remote yet**. Create a
**private** GitHub repo (must be private — the repo contains your bank data
structure and category history, though not `.env` or the PDFs, which are
git-ignored). Then, from `expense-tracker/`:

```bash
git remote add origin git@github.com:<you>/expense-tracker.git
git push -u origin master
```

Confirm `.env` and `fixtures/pdfs/` did **not** get pushed (they're in
`.gitignore` — I verified). If you see them on GitHub, stop and tell me.

---

## 2. Import the project into Vercel  **[you]**

New Project → import the GitHub repo. Then, **before the first deploy**, set two
things in **Settings → Build & Development Settings**:

| Setting | Value | Why |
| --- | --- | --- |
| **Root Directory** | `web` | The Next.js app lives in `web/`, not the repo root. |
| **Include source files outside of the Root Directory** | **ON** ✅ | The app imports 3 pure engine files from `../src` (`cost-of-credit`, `flags`, `recurring`). Without this, the build fails with "Module not found: `../../../src/...`". |

That checkbox is the single most likely thing to trip you up. The three files
are dependency-free (I checked — zero imports each), so nothing else from the
parent is needed.

Framework preset auto-detects as **Next.js** — leave build/output commands
default.

---

## 3. Set environment variables in Vercel  **[you]**

**Settings → Environment Variables.** Add these for **Production** (and Preview
if you want preview deploys to work). Values come from your local
`expense-tracker/.env`.

| Variable | Value | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | *(from your .env)* | Required. |
| `SUPABASE_SERVICE_ROLE_KEY` | *(from your .env)* | Required. Server-only — never reaches the browser (no `NEXT_PUBLIC_` var exists in this app). |
| `ALLOWED_PASSWORD` | *(your chosen password)* | **The login gate.** Pick a strong, unique passphrase. Server-only — checked constant-time, never sent to the browser. |
| `AUTH_ENABLED` | `1` | **Turns the login wall ON.** See step 4. |
| `AUTH_SECRET` | *(generate — see below)* | HMAC key for the session cookie. Recommended so it's independent of the service key. |
| `ALLOWED_EMAIL` | `mimomimomini0@gmail.com` | Identity/display only now (session label). Not the login gate. |

**Generate `AUTH_SECRET`** (run locally, paste the output as the value):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Do **not** set these on Vercel:
- `ANTHROPIC_API_KEY` — the web app never calls the LLM (engine-only; I verified).
- `FIXTURES_DIR` — local-storage feature only; the reconcile/storage panel
  self-disables on cloud (the folder isn't deployed).

> Why no `.env` on Vercel: `web/src/lib/env.ts` tries to `dotenv`-load
> `../.env`, finds no file on Vercel, and harmlessly no-ops — the real values
> come straight from `process.env` that Vercel injects. Confirmed safe.

---

## 4. Turn auth on — and don't lock yourself out

`AUTH_ENABLED=1` (step 3) activates `web/src/middleware.ts`, which redirects
every route except `/login` to the login page until you have a valid session.
The login flow is a **single password** (no email involved):

1. You open the app → login page → type the `ALLOWED_PASSWORD`.
2. The app sets a 30-day signed (`AUTH_SECRET`) httpOnly session cookie.

> **Why a password, not an emailed code:** the original design emailed a 6-digit
> code, but Supabase's built-in mailer can't send a code without a **paid custom
> SMTP** setup (it only sends a magic *link* on the free tier, and the template
> is locked). A password gate is the pragmatic single-user choice — no email
> infrastructure, nothing to deliver. No Supabase email/template config is
> needed.

**If you get locked out:** set `AUTH_ENABLED=0` in Vercel env vars and redeploy
— the wall drops instantly. To change the password, edit `ALLOWED_PASSWORD` in
Vercel and redeploy.

---

## 5. Deploy & smoke-test

Trigger the deploy (push to `master`, or "Redeploy" in Vercel). After it's live:

- [ ] Visiting the URL redirects to `/login` (proves the wall is up).
- [ ] Enter your `ALLOWED_PASSWORD` → lands on `/dashboard` with your real
      numbers (last-12-mo total, KPI tiles, chart). Wrong password just re-shows
      the login with an error; "Login is not configured" means `ALLOWED_PASSWORD`
      isn't set in Vercel.
- [ ] `/transactions` lists rows; a filter works.
- [ ] `/subscriptions`, `/costs`, `/owed`, `/duedates`, `/management` all load.
- [ ] Header language toggle (EN/中文) and theme toggle (Day/Dark/System) work.
- [ ] Settings/storage panel shows a "not available on cloud" style notice
      instead of erroring (expected — the PDF folder isn't deployed).

If anything 500s, check Vercel → Deployment → **Runtime Logs**; the usual cause
is a missing/typo'd env var from step 3.

---

## 6. After deploy — how the split works

- **Reads/writes** (categorising, confirming the queue, recording payments,
  marking on-behalf repaid) work from the cloud app — they only touch Supabase.
- **Imports** (new PDFs → backfill → classify) still run **locally** on your PC
  against the same Supabase DB. New statements show up on the deployed app on
  next load. The local storage/reconcile panel stays a local-only convenience.
- **Email reminders / digests (FR-9/FR-17)** are still dark — they need a
  **Resend API key** (`RESEND_API_KEY`) wired in. Not part of this deploy;
  flag it when you want it.

---

## Quick reference

**Vercel project settings**
- Root Directory: `web`
- Include files outside root: **ON**
- Framework: Next.js (auto)

**Env vars (Production):** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`ALLOWED_PASSWORD`, `AUTH_ENABLED=1`, `AUTH_SECRET`, `ALLOWED_EMAIL` (identity only)

**Login:** single password (`ALLOWED_PASSWORD`). No Supabase email/SMTP setup needed.

**Lockout escape:** `AUTH_ENABLED=0` → redeploy. **Change password:** edit `ALLOWED_PASSWORD` → redeploy.
