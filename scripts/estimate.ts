// Free FR-17 cost estimate over whatever fixture PDFs are currently present.
import fs from "node:fs";
import path from "node:path";
import { estimateBatchCost } from "../src/llm.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const gt = JSON.parse(fs.readFileSync(path.join(ROOT, "fixture-ground-truth.json"), "utf8"));
const names: string[] = gt.statements.map((s: { file: string }) => s.file);
for (const t of gt.traps as { file: string }[]) {
  if (/^\S+\.pdf$/.test(t.file) && !names.includes(t.file)) names.push(t.file);
}

const files: { name: string; pdf: Buffer }[] = [];
const missing: string[] = [];
for (const n of names) {
  const p = path.join(ROOT, "fixtures", "pdfs", n);
  if (fs.existsSync(p)) files.push({ name: n, pdf: fs.readFileSync(p) });
  else missing.push(n);
}
console.log("missing:", missing.join(", ") || "none");
const est = await estimateBatchCost(files);
for (const f of est.perFile) {
  console.log("  " + f.name.padEnd(45) + " ~" + f.tokensIn.toLocaleString() + " tokens in");
}
console.log(
  "TOTAL input (x2 for gate+extract): ~" + (est.totalIn * 2).toLocaleString() +
  "; est output ~" + (est.estOutPerFile * files.length).toLocaleString(),
);
console.log(
  "ESTIMATE: USD " + est.usd.toFixed(2) + " (approx RM " + est.rm.toFixed(2) + ") for " + files.length + " documents",
);
