import "server-only";
import path from "node:path";
import { config } from "dotenv";

// Supabase credentials live in the PARENT project's .env (../.env relative to
// web/). Next.js only auto-loads web/.env*, so we pull the parent file in here.
// This module is server-only: the service-role key never reaches the client
// bundle (importing this file from a client component is a build error).
config({ path: path.resolve(process.cwd(), "..", ".env") });

export function requireEnv(
  name: "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY"
): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. It is expected in the parent directory's .env file ` +
        `(expense-tracker/.env) — see web/README.md.`
    );
  }
  return value;
}
