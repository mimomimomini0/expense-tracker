import { NextRequest, NextResponse } from "next/server";

/** Auth perimeter (Phase 4). Active only when AUTH_ENABLED=1. Verifies the
 *  HMAC session cookie with Web Crypto (Edge-safe twin of lib/auth.ts —
 *  keep the token format in sync). */

const SESSION_COOKIE = "SESSION";

const PUBLIC = [/^\/login/, /^\/_next\//, /^\/favicon/, /^\/manifest/, /^\/sw\.js/, /^\/icons\//];

async function verify(token: string | undefined, secret: string): Promise<boolean> {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  let payload: string;
  try {
    payload = atob(token.slice(0, dot).replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (expected !== token.slice(dot + 1)) return false;
  const [email, expStr] = payload.split("|");
  return Boolean(email) && Number(expStr) > Date.now();
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  if (process.env.AUTH_ENABLED !== "1") return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((re) => re.test(pathname))) return NextResponse.next();

  const secret = process.env.AUTH_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (await verify(req.cookies.get(SESSION_COOKIE)?.value, secret)) {
    return NextResponse.next();
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
