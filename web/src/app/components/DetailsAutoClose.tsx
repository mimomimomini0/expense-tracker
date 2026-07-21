"use client";

import { useEffect } from "react";

/** Behaviour layer for the checkbox multi-selects (renders nothing):
 *   - closes any open .multiselect on outside click / Escape,
 *   - handles the in-dropdown "Select all" / "Clear" buttons (data-ms-all /
 *     data-ms-none) by (un)checking every box in that dropdown.
 *  Everything still works without JS — the buttons simply need it. */
export default function DetailsAutoClose() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-ms-all],[data-ms-none]");
      if (!btn) return;
      const details = btn.closest<HTMLDetailsElement>("details.multiselect");
      if (!details) return;
      e.preventDefault();
      const check = btn.hasAttribute("data-ms-all");
      for (const box of details.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
        box.checked = check;
      }
    };
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
    document.addEventListener("click", onClick);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  return null;
}
