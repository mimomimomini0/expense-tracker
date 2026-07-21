"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSupabase } from "@/lib/supabase";
import { allowedEmail, authEnabled, signSession, SESSION_COOKIE } from "@/lib/auth";

/** Step 1: send the 6-digit OTP via Supabase's built-in mailer. Only the
 *  allowed email may request one — this is a single-user system (spec Q7). */
export async function requestOtp(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email || email !== allowedEmail()) {
    redirect("/login?error=email");
  }
  const { error } = await getSupabase().auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true },
  });
  if (error) redirect(`/login?error=send`);
  redirect(`/login?sent=1&email=${encodeURIComponent(email)}`);
}

/** Step 2: verify the code, then set our own signed session cookie. */
export async function verifyCode(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const token = String(formData.get("code") ?? "").trim();
  if (email !== allowedEmail() || !/^\d{6}$/.test(token)) {
    redirect(`/login?sent=1&email=${encodeURIComponent(email)}&error=code`);
  }
  const { error } = await getSupabase().auth.verifyOtp({ email, token, type: "email" });
  if (error) redirect(`/login?sent=1&email=${encodeURIComponent(email)}&error=code`);

  (await cookies()).set(SESSION_COOKIE, signSession(email), {
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
