// Owner decision Q3: e-wallet usage sectors map deterministically to the
// category taxonomy. Real-data layer: every usage row in the owner's TNG
// history must map (228 PARKING + 16 TOLL -> Transport & Fuel).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ewalletSectorCategory } from "../src/ewallet-categories.js";
import { CachingExtractor, sha256 } from "../src/llm.js";
import { parseTngPdf } from "../src/tng.js";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("e-wallet sector -> category mapping (Q3)", () => {
  it("maps every usage row of the real TNG history — 244 rows, all Transport & Fuel", async () => {
    const file = "TransactionHistory_153975159.pdf";
    const pdf = fs.readFileSync(path.join(ROOT, "fixtures", "tng", file));
    const result = await parseTngPdf(new CachingExtractor(), file, pdf, sha256(pdf));
    expect(result.outcome).toBe("parsed_ok");
    const usage = result.rows.filter((r) => r.kind === "usage");
    expect(usage.length).toBe(244);
    for (const row of usage) {
      expect(ewalletSectorCategory(row.sector), `sector ${row.sector}`).toBe("Transport & Fuel");
    }
  });

  it("normalises case/whitespace and refuses to guess unknown sectors", () => {
    expect(ewalletSectorCategory(" parking ")).toBe("Transport & Fuel");
    expect(ewalletSectorCategory("Retail")).toBe("Retail & Shopping");
    expect(ewalletSectorCategory("MYSTERY SECTOR")).toBeNull();
    expect(ewalletSectorCategory(null)).toBeNull();
  });

  it("never maps reload sectors to an expense category", () => {
    expect(ewalletSectorCategory("INTERNET RELOAD")).toBeNull();
    expect(ewalletSectorCategory("SSK/TERMINAL/OTHER RELOAD")).toBeNull();
  });
});
