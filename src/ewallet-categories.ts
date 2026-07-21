// Owner decision Q3 (2026-07-20): TNG e-wallet USAGE rows join the category
// system so Phase 3 reports unify card + e-wallet spending. Mapping is
// deterministic from the printed Sector column — no LLM involvement. An
// unmapped sector returns null (caller queues it for the owner; never guess).
//
// Reload rows never reach this mapping: they are transfers (kind "reload"),
// not expenses, and card-funded ones are handled by the linking layer.

import type { CategoryName } from "./classify.js";

const SECTOR_CATEGORY: Record<string, CategoryName> = {
  // observed in the owner's history (228 PARKING + 16 TOLL usage rows)
  PARKING: "Transport & Fuel",
  TOLL: "Transport & Fuel",
  // other sectors TNG prints on card/e-wallet histories
  TRANSIT: "Transport & Fuel",
  RAIL: "Transport & Fuel",
  BUS: "Transport & Fuel",
  FUEL: "Transport & Fuel",
  RETAIL: "Retail & Shopping",
  "F&B": "F&B / Restaurants",
};

/** Category for a TNG usage row's sector, or null when the sector is unknown
 *  (caller should surface it for confirmation, not guess). */
export function ewalletSectorCategory(sector: string | null): CategoryName | null {
  if (!sector) return null;
  const s = sector.replace(/\s+/g, " ").trim().toUpperCase();
  return SECTOR_CATEGORY[s] ?? null;
}
