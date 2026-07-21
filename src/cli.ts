// Phase 1 CLI.
//   npm run extract-fixtures   — FR-17: show batch + estimated cost, confirm,
//                                then call the Claude API and cache extractions
//   npm run import-fixtures    — run the full pipeline over the fixture batch
//                                (from cache) and print the run report
//   npm run report             — alias of import-fixtures

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  CachingExtractor, apiApproved, estimateBatchCost, markApiApproved, MODEL,
} from "./llm.js";
import { MemoryStore } from "./store.js";
import { SupabaseStore } from "./store-supabase.js";
import { importBatch } from "./pipeline.js";
import { computeChainWarnings } from "./chain.js";
import { formatRm } from "./money.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const PDF_DIR = path.join(ROOT, "fixtures", "pdfs");
const DUPLICATE_TRAP = "RHB_4258608307183799_20260601_DUPLICATE.pdf";

interface GroundTruth {
  statements: { file: string }[];
  traps: { file: string }[];
}

function loadGroundTruth(): GroundTruth {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "fixture-ground-truth.json"), "utf8"));
}

function batchFiles(): { name: string; pdf: Buffer }[] {
  const gt = loadGroundTruth();
  const source = path.join(PDF_DIR, "RHB_4258608307183799_20260601.pdf");
  const dup = path.join(PDF_DIR, DUPLICATE_TRAP);
  if (fs.existsSync(source) && !fs.existsSync(dup)) fs.copyFileSync(source, dup);

  const names = gt.statements.map((s) => s.file);
  // trap "file" values may be descriptions ("duplicate upload of X.pdf") — only
  // bare filenames refer to real files
  for (const t of gt.traps) if (/^\S+\.pdf$/.test(t.file) && !names.includes(t.file)) names.push(t.file);
  names.push(DUPLICATE_TRAP);

  const files: { name: string; pdf: Buffer }[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const p = path.join(PDF_DIR, name);
    if (fs.existsSync(p)) files.push({ name, pdf: fs.readFileSync(p) });
    else missing.push(name);
  }
  if (missing.length) {
    console.error(`MISSING fixture PDFs (place them in fixtures/pdfs/):\n  - ${missing.join("\n  - ")}`);
    process.exit(1);
  }
  return files;
}

async function confirm(question: string): Promise<boolean> {
  if (process.argv.includes("--yes")) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) => rl.question(`${question} [y/N] `, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function cmdExtractFixtures(): Promise<void> {
  const files = batchFiles();
  // the duplicate copy shares its hash with the original — extraction is cached, no extra cost
  const unique = files.filter((f) => f.name !== DUPLICATE_TRAP);

  console.log(`Fixture batch: ${files.length} files (${unique.length} unique documents)`);
  console.log(`Model: ${MODEL}\n`);
  console.log("Counting tokens for the cost estimate (free API call)...");
  const est = await estimateBatchCost(unique);
  for (const f of est.perFile) console.log(`  ${f.name.padEnd(45)} ~${f.tokensIn.toLocaleString()} input tokens`);
  console.log(
    `\nEstimated cost for gate + extraction of ${unique.length} documents:` +
      `\n  ~${(est.totalIn * 2).toLocaleString()} input tokens + ~${(est.estOutPerFile * unique.length).toLocaleString()} output tokens` +
      `\n  ≈ USD ${est.usd.toFixed(2)}  (≈ RM ${est.rm.toFixed(2)})` +
      `\n(Statements that fail reconciliation trigger one automatic re-parse each, up to ~2x that figure in the worst case.)\n`,
  );
  if (!(await confirm(`Process ${unique.length} statements — continue?`))) {
    console.log("Aborted. Nothing was sent to the Claude API.");
    return;
  }
  markApiApproved();

  const extractor = new CachingExtractor();
  let usd = 0;
  for (const f of unique) {
    const hash = (await import("./llm.js")).sha256(f.pdf);
    process.stdout.write(`  ${f.name} ... `);
    try {
      const g = await extractor.gate(f.pdf, hash);
      usd += g.usage.fromCache ? 0 : g.usage.estCostUsd;
      if (g.result.doc_type === "other") {
        console.log(`gate: NOT a credit card statement (${g.result.reason})`);
        continue;
      }
      const e = await extractor.extract(f.pdf, hash, null);
      usd += e.usage.fromCache ? 0 : e.usage.estCostUsd;
      console.log(
        `ok (${e.result.cards.length} card section(s), ${e.result.cards.reduce((n, c) => n + c.transactions.length, 0)} rows)` +
          (e.usage.fromCache ? " [cached]" : ""),
      );
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message}`);
    }
  }
  console.log(`\nDone. New API spend this run: ~USD ${usd.toFixed(2)} (RM ${(usd * 4.7).toFixed(2)}).`);
  console.log(`Extractions cached in fixtures/extractions/. Now run: npm test`);
}

async function cmdImportFixtures(): Promise<void> {
  const useSupabase = process.argv.includes("--supabase");
  const files = batchFiles();
  const store = useSupabase ? new SupabaseStore() : new MemoryStore();
  if (useSupabase) console.log("Importing into Supabase (persistent database)...\n");
  const outcomes = await importBatch(store, new CachingExtractor(), files);

  // FR-1: store the original PDFs for audit/reference (persistent runs only)
  if (useSupabase && store instanceof SupabaseStore) {
    const { sha256 } = await import("./llm.js");
    for (const o of outcomes) {
      if (o.outcome !== "parsed_ok" && o.outcome !== "needs_review") continue;
      const f = files.find((x) => x.name === o.filename);
      if (!f || o.statementId === undefined) continue;
      try {
        const storagePath = await store.storePdf(sha256(f.pdf), f.name, f.pdf);
        await store.setPdfStoragePath(o.statementId, storagePath);
      } catch (err) {
        console.warn(`  (PDF upload failed for ${f.name}: ${(err as Error).message})`);
      }
    }
  }

  const statements = await store.listStatements();
  const stmtCards = await store.listStatementCards();
  const banks = await store.listBanks();
  const cards = await store.listCardAccounts();
  const warnings = await computeChainWarnings(store);
  const costs = await store.listApiCosts();

  console.log("\n=============== PHASE 1 RUN REPORT ===============\n");
  console.log("Per-statement status:");
  for (const o of outcomes) {
    const st = statements.find((s) => s.id === o.statementId);
    const deltas = (o.reconciliationDeltas ?? [])
      .map((d) => `...${d.last4} delta RM ${formatRm(d.delta)}`)
      .join(", ");
    console.log(
      `  ${o.filename.padEnd(45)} ${o.outcome.padEnd(24)} retries=${o.retryCount ?? 0}` +
        (deltas ? `  ${deltas}` : "") +
        (st?.payment_due_date ? `  due=${st.payment_due_date}` : "") +
        (o.detail && o.outcome !== "parsed_ok" ? `\n${" ".repeat(6)}-> ${o.detail}` : ""),
    );
  }

  console.log("\nChain check:");
  if (warnings.length === 0) console.log("  no gap warnings");
  for (const w of warnings) {
    console.log(`  ${w.bank} ...${w.last4}: ${w.from_statement_date} -> ${w.to_statement_date}: ${w.detail}`);
  }

  console.log("\nCards:");
  for (const c of cards) {
    const bank = banks.find((b) => b.id === c.bank_id);
    const count = stmtCards.filter((sc) => sc.card_account_id === c.id).length;
    console.log(`  ${bank?.name} ...${c.last4} (${c.holder_label ?? "?"}): ${count} statements`);
  }

  const totalUsd = costs.reduce((s, c) => s + c.est_cost_usd, 0);
  const totalIn = costs.reduce((s, c) => s + c.tokens_in, 0);
  const totalOut = costs.reduce((s, c) => s + c.tokens_out, 0);
  console.log(
    `\nAPI usage (incl. cached replays): ${costs.length} calls, ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out tokens, ≈ USD ${totalUsd.toFixed(2)} (RM ${(totalUsd * 4.7).toFixed(2)})`,
  );
  console.log("\n==================================================\n");
}

const cmd = process.argv[2];
switch (cmd) {
  case "extract-fixtures":
    await cmdExtractFixtures();
    break;
  case "import-fixtures":
  case "report":
    await cmdImportFixtures();
    break;
  default:
    console.log("Usage: npm run cli -- <extract-fixtures|import-fixtures|report> [--yes]");
    if (!apiApproved()) console.log("\nFirst run: npm run extract-fixtures (shows cost, asks confirmation)");
}
