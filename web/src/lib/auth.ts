import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { requireEnv } from "./env";

/** Phase 4 auth: single-user password gate.
 *
 *  DISABLED unless AUTH_ENABLED=1 — locally the app runs on localhost only, so
 *  the gate is turned on at deployment (see web/README.md and ../DEPLOY.md).
 *
 *  Flow: /login asks for a password -> compared (constant-time) against the
 *  ALLOWED_PASSWORD env var -> we set our own HMAC-signed httpOnly session
 *  cookie. Data access stays server-side via the service key; this gate is the
 *  perimeter. (Email OTP was the original design, but Supabase's built-in
 *  mailer can't send a code without paid custom SMTP, so a password gate is the
 *  pragmatic single-user choice.) */

export const SESSION_COOKIE = "SESSION";
const SESSION_DAYS = 30;

export function authEnabled(): boolean {
  return process.env.AUTH_ENABLED === "1";
}

/** Display/identity only — the login gate is the password, not this. */
export function allowedEmail(): string {
  return (process.env.ALLOWED_EMAIL ?? "").trim().toLowerCase();
}

export function passwordConfigured(): boolean {
  return (process.env.ALLOWED_PASSWORD ?? "").length > 0;
}

/** Constant-time password check against ALLOWED_PASSWORD. Hashing both sides
 *  first gives equal-length buffers (timingSafeEqual requires it) and avoids
 *  leaking the expected length. */
export function checkPassword(input: string): boolean {
  const expected = process.env.ALLOWED_PASSWORD ?? "";
  if (!expected) return false;
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function secret(): string {
  // reuse the service key as HMAC secret unless a dedicated one is set —
  // both live only in the parent .env
  return process.env.AUTH_SECRET ?? requireEnv("SUPABASE_SERVICE_ROLE_KEY");
}

export function signSession(email: string): string {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = `${email.toLowerCase()}|${exp}`;
  const mac = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${mac}`;
}

export function verifySession(token: string | undefined): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payloadB64 = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  let payload: string;
  try {
    payload = Buffer.from(payloadB64, "base64url").toString();
  } catch {
    return null;
  }
  const expected = createHmac("sha256", secret()).update(payload).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const [email, expStr] = payload.split("|");
  if (!email || !expStr || Number(expStr) < Date.now()) return null;
  return email;
}

export async function currentUser(): Promise<string | null> {
  if (!authEnabled()) return allowedEmail() || "local";
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value);
}
