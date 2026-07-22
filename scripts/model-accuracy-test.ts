// Model-accuracy test (owner request 2026-07-22): is a cheaper model accurate
// enough to replace Sonnet 5 for statement extraction?
//
// Ground truth = the existing Sonnet extractions on disk, each already
// reconciled to the bank's PRINTED opening/closing/summary during backfill
// (every delta was 0.00). For each sample PDF we re-extract with a CANDIDATE
// model and judge it two ways:
//   1. Objective, self-contained: does the candidate's extraction reconcile to
//      the statement's own printed balances? (reconcileCard delta == 0)
//   2. Against ground truth: same card count, opening/closing, txn count, and
//      per-row amount+direction match vs the trusted Sonnet rows.
//
// BILLABLE: makes one real extraction call per sample PDF on the candidate
// model. Gated behind EXPENSE_ALLOW_API=1 so it can't run by accident.
//   EXPENSE_ALLOW_API=1 npx tsx scripts/model-accuracy-test.ts [candidateModel]
//
import fs from "node:fs";
import path from "node:path";
import { cacheDir, extractWithModel, MODEL, sha256 } from "../src/llm.js";
import { reconcileCard } from "../src/reconcile.js";
import { toSen } from "../src/money.js";
import type { ExtractedCard, ExtractionResult } from "../src/types.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const pdfDir = path.join(ROOT, "fixtures", "pdfs");

const CANDIDATE = process.argv[2] ?? "claude-haiku-4-5";
// Haiku 4.5 pricing (per 1M tokens); swap if testing another model.
const CAND_IN = 1.0;
const CAND_OUT = 5.0;
const USD_TO_RM = 4.7;

// One PDF per distinct bank/layout family, biased toward the hard/large ones.
const SAMPLE = [
  { file: "December-2024 (2).pdf", layout: "RHB 2024 4-card, compact DDMM dates (hardest)" },
  { file: "April-2024.pdf", layout: "RHB 2024 4-card, compact DDMM dates" },
  { file: "RHB_4258608307183799_20260501.pdf", layout: "RHB 2026 2-card" },
  { file: "eStatement20260619.pdf", layout: "CIMB 1-card, 104 txns (largest single card)" },
  { file: "UOB202409.pdf", layout: "UOB 1-card" },
];

if (process.env.EXPENSE_ALLOW_API !== "1") {
  console.error("Refusing to run: this makes billable API calls. Re-run with EXPENSE_ALLOW_API=1.");
  process.exit(1);
}

interface CardDiff {
  last4: string;
  openingMatch: boolean;
  closingMatch: boolean;
  gtTxns: number;
  candTxns: number;
  rowsMatched: number; // candidate rows matched to a distinct GT row by (amount, direction)
  gtOnly: number; // GT rows with no candidate match (candidate MISSED)
  candOnly: number; // candidate rows with no GT match (candidate EXTRA / split)
  candReconcileDelta: number; // sen; 0 == candidate arithmetic ties to printed balances
  candSecondary: string[];
}

function diffCard(gt: ExtractedCard, cand: ExtractedCard | undefined): CardDiff {
  if (!cand) {
    return {
      last4: gt.last4, openingMatch: false, closingMatch: false,
      gtTxns: gt.transactions.length, candTxns: 0, rowsMatched: 0,
      gtOnly: gt.transactions.length, candOnly: 0, candReconcileDelta: NaN, candSecondary: ["card missing"],
    };
  }
  // greedy match candidate rows to GT rows by (amount in sen, direction)
  const pool = gt.transactions.map((t) => ({ key: `${toSen(t.amount_rm)}|${t.direction}`, used: false }));
  let matched = 0;
  for (const c of cand.transactions) {
    const key = `${toSen(c.amount_rm)}|${c.direction}`;
    const hit = pool.find((p) => !p.used && p.key === key);
    if (hit) { hit.used = true; matched++; }
  }
  const rec = reconcileCard(cand);
  return {
    last4: gt.last4,
    openingMatch: toSen(gt.opening_balance_rm) === toSen(cand.opening_balance_rm),
    closingMatch: toSen(gt.closing_balance_rm) === toSen(cand.closing_balance_rm),
    gtTxns: gt.transactions.length,
    candTxns: cand.transactions.length,
    rowsMatched: matched,
    gtOnly: gt.transactions.length - matched,
    candOnly: cand.transactions.length - matched,
    candReconcileDelta: rec.delta,
    candSecondary: rec.secondaryMismatches,
  };
}

console.log(`Ground truth: ${MODEL} (reconciled to printed balances during backfill)`);
console.log(`Candidate:    ${CANDIDATE}  (pricing $${CAND_IN}/M in, $${CAND_OUT}/M out)\n`);

let totGtTxns = 0, totMatched = 0, totMissed = 0, totExtra = 0;
let totUsd = 0, filesReconciled = 0, filesPerfect = 0;

for (const { file, layout } of SAMPLE) {
  const full = path.join(pdfDir, file);
  const pdf = fs.readFileSync(full);
  const hash16 = sha256(pdf).slice(0, 16);
  const gtPath = path.join(cacheDir(), `${hash16}.extract.p1.json`);
  if (!fs.existsSync(gtPath)) { console.log(`SKIP ${file}: no ground-truth cache`); continue; }
  const gt = (JSON.parse(fs.readFileSync(gtPath, "utf8")).result) as ExtractionResult;

  process.stdout.write(`\n=== ${file}\n    ${layout}\n    extracting with ${CANDIDATE}... `);
  let cand: ExtractionResult;
  let usd = 0;
  try {
    const out = await extractWithModel(pdf, CANDIDATE, 40000);
    cand = out.result;
    usd = (out.usage.input_tokens / 1e6) * CAND_IN + (out.usage.output_tokens / 1e6) * CAND_OUT;
    totUsd += usd;
    console.log(`done (${out.usage.input_tokens.toLocaleString()} in / ${out.usage.output_tokens.toLocaleString()} out, ~USD ${usd.toFixed(3)})`);
  } catch (err) {
    console.log(`FAILED: ${(err as Error).message}`);
    continue;
  }

  const candByLast4 = new Map(cand.cards.map((c) => [c.last4, c]));
  let fileReconciled = true, filePerfect = true;
  console.log(`    cards: ground-truth ${gt.cards.length}, candidate ${cand.cards.length}`);
  for (const gc of gt.cards) {
    const d = diffCard(gc, candByLast4.get(gc.last4));
    totGtTxns += d.gtTxns; totMatched += d.rowsMatched; totMissed += d.gtOnly; totExtra += d.candOnly;
    const recStr = Number.isNaN(d.candReconcileDelta)
      ? "n/a"
      : d.candReconcileDelta === 0 ? "0 ✓" : `${(d.candReconcileDelta / 100).toFixed(2)} ✗`;
    if (d.candReconcileDelta !== 0) fileReconciled = false;
    if (d.gtOnly !== 0 || d.candOnly !== 0 || !d.openingMatch || !d.closingMatch) filePerfect = false;
    console.log(
      `    card ${d.last4}: open ${d.openingMatch ? "✓" : "✗"} close ${d.closingMatch ? "✓" : "✗"} | ` +
      `txns gt=${d.gtTxns} cand=${d.candTxns} matched=${d.rowsMatched} missed=${d.gtOnly} extra=${d.candOnly} | ` +
      `reconcile Δ=${recStr}` + (d.candSecondary.length ? ` | ${d.candSecondary.join("; ")}` : ""),
    );
  }
  if (fileReconciled && cand.cards.length === gt.cards.length) filesReconciled++;
  if (filePerfect && cand.cards.length === gt.cards.length) filesPerfect++;
}

console.log("\n" + "=".repeat(60));
console.log(`SUMMARY (${CANDIDATE} vs ${MODEL} ground truth)`);
console.log(`  sample: ${SAMPLE.length} statements`);
console.log(`  statements that reconcile to printed balances: ${filesReconciled}/${SAMPLE.length}`);
console.log(`  statements byte-perfect vs ground truth:        ${filesPerfect}/${SAMPLE.length}`);
console.log(`  transaction rows: ${totGtTxns} ground truth | ${totMatched} matched | ${totMissed} missed | ${totExtra} extra`);
console.log(`  row recall: ${((totMatched / totGtTxns) * 100).toFixed(1)}%`);
console.log(`  candidate cost for this run: ~USD ${totUsd.toFixed(3)} (RM ${(totUsd * USD_TO_RM).toFixed(2)}) for ${SAMPLE.length} statements`);
console.log(`  → ~USD ${(totUsd / SAMPLE.length).toFixed(3)}/statement on ${CANDIDATE}`);
