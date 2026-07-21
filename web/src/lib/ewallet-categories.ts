/** E-wallet usage sector -> category name (owner decision Q3).
 *  MUST stay in sync with src/ewallet-categories.ts in the engine — same
 *  mapping, same refuse-to-guess rule for unknown sectors. */
const SECTOR_CATEGORY: Record<string, string> = {
  PARKING: "Transport & Fuel",
  TOLL: "Transport & Fuel",
  TRANSIT: "Transport & Fuel",
  RAIL: "Transport & Fuel",
  BUS: "Transport & Fuel",
  FUEL: "Transport & Fuel",
  RETAIL: "Retail & Shopping",
  "F&B": "F&B / Restaurants",
};

export function ewalletSectorCategory(sector: string | null): string | null {
  if (!sector) return null;
  const s = sector.replace(/\s+/g, " ").trim().toUpperCase();
  return SECTOR_CATEGORY[s] ?? null;
}
