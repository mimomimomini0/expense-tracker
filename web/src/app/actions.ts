"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

export async function setLocale(locale: string): Promise<void> {
  const value = locale === "zh" ? "zh" : "en";
  const store = await cookies();
  store.set("NEXT_LOCALE", value, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax"
  });
  revalidatePath("/", "layout");
}

/** Day / Dark / System theme (owner request 2026-07-21). "system" clears the
 *  cookie so the html element carries no data-theme and prefers-color-scheme
 *  decides. Rendered server-side, so there is no flash on load. */
export async function setTheme(theme: string): Promise<void> {
  const store = await cookies();
  if (theme === "light" || theme === "dark") {
    store.set("THEME", theme, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax"
    });
  } else {
    store.delete("THEME");
  }
  revalidatePath("/", "layout");
}
