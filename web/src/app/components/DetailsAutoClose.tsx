"use client";

import { useEffect } from "react";

/** Native <details> stays open on outside clicks; this closes any open
 *  .multiselect when the pointer goes down elsewhere (and on Escape).
 *  Renders nothing — pure behavior. The dropdown still works without JS,
 *  it just doesn't auto-close. */
export default function DetailsAutoClose() {
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      for (const d of document.querySelectorAll<HTMLDetailsElement>("details.multiselect[open]")) {
        if (!d.contains(e.target as Node)) d.open = false;
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      for (const d of document.querySelectorAll<HTMLDetailsElement>("details.multiselect[open]")) {
        d.open = false;
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  return null;
}
