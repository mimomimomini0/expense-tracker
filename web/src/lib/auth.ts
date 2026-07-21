import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { requireEnv } from "./env";

/** Phase 4 passwordless auth (spec: email OTP, single user).
 *
 *  DISABLED unless AUTH_ENABLED=1 in the parent .env — the app is
 *  localhost-only today, and shipping auth enabled-by-default would risk
 *  locking the owner out before they can receive the first OTP. Flip the
 *  flag at deployment (see web/README.md).
 *
 *  Flow: /login asks for the allowed email -> Supabase sends a 6-digit OTP
 *  (its built-in mailer; no Resend needed at single-user volume) ->
 *  verifyOtp -> we set our own HMAC-signed httpOnly session cookie. Data
 *  access stays server-side via the service key; this gate is the perimeter. */

export const SESSION_COOKIE = "SESSION";
const SESSION_DAYS = 30;

export function authEnabled(): boolean {
  return process.env.AUTH_ENABLED === "1";
}

export function allowedEmail(): string {
  return (process.env.ALLOWED_EMAIL ?? "").trim().toLowerCase();
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
