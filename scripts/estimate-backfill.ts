// FR-17 cost estimate for the Phase 2 bulk backfill: every PDF in
// fixtures/pdfs whose extraction is NOT already cached. Uses the free
// count_tokens endpoint only — no billable calls.
//   npx tsx scripts/estimate-backfill.ts
import fs from "node:fs";
import path from "node:path";
import { cacheDir, estimateBatchCost, sha256 } from "../src/llm.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const pdfDir = path.join(ROOT, "fixtures", "pdfs");

const cached: string[] = [];
const todo: { name: string; pdf: Buffer }[] = [];
for (const name of fs.readdirSync(pdfDir).filter((n) => n.toLowerCase().endsWith(".pdf")).sort()) {
  const pdf = fs.readFileSync(path.join(pdfDir, name));
  const hash16 = sha256(pdf).slice(0, 16);
  const hasExtract = fs.existsSync(path.join(cacheDir(), `${hash16}.extract.p1.json`));
  const hasGate = fs.existsSync(path.join(cacheDir(), `${hash16}.gate.p1.json`));
  if (hasExtract || (hasGate && !hasExtract && isRejectedByGate(hash16))) cached.push(name);
  else if (hasGate && !hasExtract) cached.push(`${name} (gate-cached, rejected)`);
  else todo.push({ name, pdf });
}

function isRejectedByGate(hash16: string): boolean {
  try {
    const g = JSON.parse(fs.readFileSync(path.join(cacheDir(), `${hash16}.gate.p1.json`), "utf8"));
    return g.result?.doc_type === "other";
  } catch {
    return false;
  }
}

console.log(`already processed/cached: ${cached.length}`);
for (const c of cached) console.log(`  = ${c}`);
console.log(`\nto backfill: ${todo.length}`);
if (todo.length === 0) {
  console.log("nothing to do");
  process.exit(0);
}

const est = await estimateBatchCost(todo);
for (const f of est.perFile) {
  console.log("  + " + f.name.padEnd(45) + " ~" + f.tokensIn.toLocaleString() + " tokens in");
}
console.log(
  "\nTOTAL input (x2 for gate+extract): ~" + (est.totalIn * 2).toLocaleString() +
  "; est output ~" + (est.estOutPerFile * todo.length).toLocaleString(),
);
console.log(
  "ESTIMATE: USD " + est.usd.toFixed(2) + " (approx RM " + est.rm.toFixed(2) + ") for " + todo.length + " documents",
);
console.log("\nNo billable call has been made. Owner approval required before extraction (FR-17).");
