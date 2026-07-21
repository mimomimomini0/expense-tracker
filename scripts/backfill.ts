// Phase 2 bulk historical import (owner-approved 2026-07-20, est USD 3.90):
//   $env:EXPENSE_ALLOW_API="1"; npx tsx scripts/backfill.ts
//
// Runs every fixtures/pdfs PDF that has no cached extraction through the FULL
// Phase 1 pipeline (gate -> extract -> dates -> typing -> reconcile with one
// self-correcting re-parse -> chain-safe commit) straight into Supabase, then
// stores the PDFs and prints a run report. Everything is cached, so a re-run
// after a crash costs nothing and duplicates are rejected by file hash.

import fs from "node:fs";
import path from "node:path";
import { CachingExtractor, cacheDir, sha256 } from "../src/llm.js";
import { importPdf } from "../src/pipeline.js";
import { SupabaseStore } from "../src/store-supabase.js";
import { computeChainWarnings } from "../src/chain.js";
import { formatRm } from "../src/money.js";
import type { ImportOutcome } from "../src/types.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const pdfDir = path.join(ROOT, "fixtures", "pdfs");

function gateRejected(hash16: string): boolean {
  try {
    const g = JSON.parse(fs.readFileSync(path.join(cacheDir(), `${hash16}.gate.p1.json`), "utf8"));
    return g.result?.doc_type === "other";
  } catch {
    return false;
  }
}

const store = new SupabaseStore();

// Process any PDF that is NOT already committed to the database (by file
// hash) and not gate-rejected. Cached extractions replay for free, so
// re-running after deleting a needs_review statement re-imports it at no
// API cost, and a full re-run is a no-op.
const inDb = new Set((await store.listStatements()).map((s) => s.file_hash));
const files: { name: string; pdf: Buffer }[] = [];
for (const name of fs.readdirSync(pdfDir).filter((n) => n.toLowerCase().endsWith(".pdf")).sort()) {
  const pdf = fs.readFileSync(path.join(pdfDir, name));
  const hash = sha256(pdf);
  if (!inDb.has(hash) && !gateRejected(hash.slice(0, 16))) files.push({ name, pdf });
}
console.log(`backfill batch: ${files.length} documents\n`);
if (files.length === 0) process.exit(0);

const extractor = new CachingExtractor();
const costsBefore = (await store.listApiCosts()).length;

const outcomes: ImportOutcome[] = [];
for (const f of files) {
  process.stdout.write(`[${outcomes.length + 1}/${files.length}] ${f.name} ... `);
  try {
    const o = await importPdf(store, extractor, f.name, f.pdf);
    outcomes.push(o);
    const deltas = (o.reconciliationDeltas ?? []).map((d) => `...${d.last4} ${formatRm(d.delta)}`).join(", ");
    console.log(`${o.outcome} retries=${o.retryCount ?? 0}${deltas ? ` [${deltas}]` : ""}${o.newCards ? ` NEW CARDS: ${o.newCards.map((c) => c.last4).join(",")}` : ""}${o.detail && o.outcome !== "parsed_ok" ? `\n    -> ${o.detail}` : ""}`);
    if ((o.outcome === "parsed_ok" || o.outcome === "needs_review") && o.statementId !== undefined) {
      const storagePath = await store.storePdf(sha256(f.pdf), f.name, f.pdf);
      await store.setPdfStoragePath(o.statementId, storagePath);
    }
  } catch (err) {
    console.log(`FAILED: ${(err as Error).message}`);
    outcomes.push({ filename: f.name, outcome: "failed", detail: (err as Error).message });
  }
}

// ---------------- report ----------------
const counts = new Map<string, number>();
for (const o of outcomes) counts.set(o.outcome, (counts.get(o.outcome) ?? 0) + 1);
console.log(`\n=============== BACKFILL RUN REPORT ===============`);
console.log(`outcomes:`, Object.fromEntries(counts));

const newCards = outcomes.flatMap((o) => o.newCards ?? []);
if (newCards.length > 0) {
  console.log(`\nNEW card numbers first seen this run (FR-4d: owner decides new-vs-continuation):`);
  for (const c of newCards) console.log(`  card_account ${c.cardAccountId}: ...${c.last4}`);
}

// FR-4d (owner clarification 2026-07-21): auto-link confident balance
// handoffs — a replacement card continues the same statement series
const { detectContinuations } = await import("../src/continuation.js");
const detected = detectContinuations(
  await store.listCardAccounts(), await store.listStatements(), await store.listStatementCards(),
);
for (const d of detected) {
  if (d.confident) {
    await store.linkCardContinuation(d.successor.id, d.predecessor.id);
    console.log(`\ncontinuation AUTO-LINKED: ...${d.predecessor.last4} -> ...${d.successor.last4} (${d.reason})`);
  } else {
    console.log(`\ncontinuation PROPOSED (needs owner confirmation): ...${d.predecessor.last4} -> ...${d.successor.last4} — ${d.reason}`);
  }
}

const warnings = await computeChainWarnings(store);
console.log(`\nchain check: ${warnings.length === 0 ? "no gap warnings" : warnings.length + " warnings"}`);
for (const w of warnings) {
  console.log(`  ${w.bank} ...${w.last4}: ${w.from_statement_date} -> ${w.to_statement_date}: ${w.detail}`);
}

const costs = await store.listApiCosts();
const runCosts = costs.slice(costsBefore);
const usd = runCosts.reduce((s, c) => s + c.est_cost_usd, 0);
console.log(`\nAPI spend this run: ${runCosts.length} calls, ≈ USD ${usd.toFixed(2)} (RM ${(usd * 4.7).toFixed(2)})`);

const statements = await store.listStatements();
const txCount = (await store.listTransactions()).length;
console.log(`database now: ${statements.length} statements, ${txCount} transactions`);
