# Setting up the shareable demo

The demo is a **second, separate copy** of the app: same code, but its own
database full of a fictional person's fake finances and its own password. Your
real app and data are never involved — physically different database. Friends &
family log in with a demo password and explore everything freely.

You've already done every kind of step below once (for your real deploy), so
this is a repeat with different values.

---

## 1. Create a second Supabase project  **[you]**
- supabase.com → **New project** (free). Name it e.g. `expense-tracker-demo`.
- Once it's ready: **Project Settings → API** → copy the **Project URL** and the
  **`service_role`** key (the secret one). You'll need both below.

## 2. Apply the schema  **[you]**
In the demo project's **SQL Editor**, run each of these files' contents (same
ones you pasted for the real project), in order:
`schema.sql`, `schema-ewallet.sql`, `schema-phase2.sql`, `schema-phase2b.sql`,
`schema-phase2c.sql`.

## 3. Seed the fake data  **[you run, I built the script]**
First preview it with **no database and no credentials** (safe, prints a summary):
```bash
npx tsx scripts/seed-demo.ts --dry-run
```
Then seed the demo project. In **PowerShell**, from the `expense-tracker` folder
(paste your demo project's URL and service_role key):
```bash
$env:DEMO_SUPABASE_URL="https://YOUR-DEMO.supabase.co"; $env:DEMO_SUPABASE_SERVICE_ROLE_KEY="eyJ...demo-service-role..."; npx tsx scripts/seed-demo.ts --yes
```
> The script **refuses to run** unless those two are set, and it errors out if
> `DEMO_SUPABASE_URL` matches your real one — so it can't touch real data. If
> `node`/`npx` isn't found, prefix with:
> `$env:Path = "C:\Program Files\nodejs;" + $env:Path;`

It imports ~20 statements / ~240 transactions through the real pipeline, then
categorises them. When it prints "Done", the demo database is ready.

## 4. Deploy a second Vercel project  **[you]**
Vercel → **Add New… → Project** → import the **same** `expense-tracker` repo
again (Vercel allows multiple projects from one repo).
- **Root Directory** → `web`; **Include source files outside of the Root
  Directory** → **ON** (same as before).
- **Environment Variables** (Production) — point these at the **DEMO** project:

  | Name | Value |
  | --- | --- |
  | `SUPABASE_URL` | the **demo** project URL |
  | `SUPABASE_SERVICE_ROLE_KEY` | the **demo** project service_role key |
  | `ALLOWED_PASSWORD` | a **demo password** you're happy to share |
  | `AUTH_ENABLED` | `1` |
  | `AUTH_SECRET` | generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
  | `ALLOWED_EMAIL` | `demo@demo.local` (identity only) |

- Deploy. You'll get a separate link like `expense-tracker-demo-xxxx.vercel.app`.

## 5. Share it
Send friends the **demo URL + demo password**. They can poke at everything —
dashboards, transactions, subscriptions, reports — with zero risk to your real
finances. They can't import their own statements (that's a future feature); the
demo is there to *show how the system works*.

---

## Notes
- **Reset the demo** anytime: the data is disposable. Re-seed a fresh Supabase
  project, or clear the tables and re-run step 3.
- **Re-running the seed** on a non-empty demo DB is blocked (pass `--force` to
  override); best to seed a clean project.
- The demo and real deployments share only the **code** on GitHub — never data,
  passwords, or keys.
