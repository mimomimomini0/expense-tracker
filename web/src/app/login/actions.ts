"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  allowedEmail, authEnabled, checkPassword, passwordConfigured, signSession, SESSION_COOKIE,
} from "@/lib/auth";

/** Single-user password login. On a correct password we set our own
 *  HMAC-signed session cookie; the middleware gate checks that cookie. */
export async function login(formData: FormData): Promise<void> {
  const password = String(formData.get("password") ?? "");
  if (!passwordConfigured()) redirect("/login?error=config");
  if (!checkPassword(password)) {
    // Slow brute-force attempts a little; single-user so legit typos are rare.
    await new Promise((r) => setTimeout(r, 800));
    redirect("/login?error=password");
  }
  (await cookies()).set(SESSION_COOKIE, signSession(allowedEmail() || "owner"), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 30 * 86_400,
  });
  redirect("/dashboard");
}

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  if (authEnabled()) redirect("/login");
  redirect("/dashboard");
}
