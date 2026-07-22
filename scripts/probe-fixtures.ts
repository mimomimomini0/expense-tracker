// Free probe: for each cached PDF, show bank/holder, #cards, #txns, so we can
// pick a diverse, representative sample for the model-accuracy test. Reads only
// the on-disk Sonnet extraction cache — no API calls.
import fs from "node:fs";
import path from "node:path";
import { cacheDir, sha256 } from "../src/llm.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const pdfDir = path.join(ROOT, "fixtures", "pdfs");

const rows: { name: string; cards: number; txns: number; holders: string; last4s: string }[] = [];
for (const name of fs.readdirSync(pdfDir).filter((n) => n.toLowerCase().endsWith(".pdf")).sort()) {
  const pdf = fs.readFileSync(path.join(pdfDir, name));
  const hash16 = sha256(pdf).slice(0, 16);
  const p = path.join(cacheDir(), `${hash16}.extract.p1.json`);
  if (!fs.existsSync(p)) continue; // only cached (ground-truth) ones
  const c = JSON.parse(fs.readFileSync(p, "utf8"));
  const cards = c.result?.cards ?? [];
  rows.push({
    name,
    cards: cards.length,
    txns: cards.reduce((s: number, cd: any) => s + (cd.transactions?.length ?? 0), 0),
    holders: [...new Set(cards.map((cd: any) => cd.holder_name).filter(Boolean))].join("|") || "-",
    last4s: cards.map((cd: any) => cd.last4).join(","),
  });
}

rows.sort((a, b) => b.cards - a.cards || b.txns - a.txns);
for (const r of rows) {
  console.log(
    r.name.padEnd(34) + " cards=" + String(r.cards).padEnd(3) +
    " txns=" + String(r.txns).padEnd(4) + " last4=" + r.last4s.padEnd(24) + " " + r.holders.slice(0, 30),
  );
}
console.log(`\n${rows.length} cached statements`);
