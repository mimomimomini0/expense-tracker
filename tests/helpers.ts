import fs from "node:fs";
import path from "node:path";
import { MemoryStore } from "../src/store.js";
import { CachingExtractor, type Extractor } from "../src/llm.js";
import { importBatch } from "../src/pipeline.js";
import type { ImportOutcome } from "../src/types.js";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const PDF_DIR = path.join(ROOT, "fixtures", "pdfs");
export const DUPLICATE_TRAP_NAME = "RHB_4258608307183799_20260601_DUPLICATE.pdf";

export interface GroundTruthStatement {
  file: string;
  bank: string;
  card: string;
  statement_date: string;
  due_date: string;
  opening: number;
  closing: number;
  minimum?: number;
  assertions: string[];
}

export interface GroundTruth {
  spec_version: string;
  cards: { bank: string; last4?: string; card_no?: string; note?: string }[];
  statements: GroundTruthStatement[];
  traps: { file: string; expected: string; reason: string }[];
  chains: {
    card: string;
    unbroken: string[];
    then_gap?: string;
    note?: string;
  }[];
  harness_rules: string[];
}

export function loadGroundTruth(): GroundTruth {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, "fixture-ground-truth.json"), "utf8"),
  ) as GroundTruth;
}

export function fixturePath(name: string): string {
  return path.join(PDF_DIR, name);
}

export function loadPdf(name: string): Buffer {
  return fs.readFileSync(fixturePath(name));
}

/** The deliberate duplicate trap: an identical copy of the June RHB statement. */
export function ensureDuplicateTrap(): void {
  const source = fixturePath("RHB_4258608307183799_20260601.pdf");
  const target = fixturePath(DUPLICATE_TRAP_NAME);
  if (fs.existsSync(source) && !fs.existsSync(target)) {
    fs.copyFileSync(source, target);
  }
}

/**
 * The full fixture batch, in ground-truth order, with both trap files included
 * (they are test inputs, not mistakes). The duplicate copy goes last so the
 * canonically-named file is the surviving row in the default import.
 */
export function batchFileNames(gt: GroundTruth): string[] {
  ensureDuplicateTrap();
  const names = gt.statements.map((s) => s.file);
  for (const t of gt.traps) {
    // trap "file" values may be descriptions ("duplicate upload of X.pdf")
    if (/^\S+\.pdf$/.test(t.file) && !names.includes(t.file)) names.push(t.file);
  }
  names.push(DUPLICATE_TRAP_NAME);
  return names;
}

export function missingFixtures(gt: GroundTruth): string[] {
  return batchFileNames(gt).filter((n) => !fs.existsSync(fixturePath(n)));
}

export interface BatchRun {
  store: MemoryStore;
  outcomes: ImportOutcome[];
}

export async function runBatch(
  fileNames: string[],
  extractor: Extractor = new CachingExtractor(),
): Promise<BatchRun> {
  const store = new MemoryStore();
  const files = fileNames.map((name) => ({ name, pdf: loadPdf(name) }));
  const outcomes = await importBatch(store, extractor, files);
  return { store, outcomes };
}

/** Deterministic shuffle (mulberry32) so the shuffled-order test is reproducible. */
export function deterministicShuffle<T>(items: T[], seed: number): T[] {
  const a = [...items];
  let s = seed >>> 0;
  const rand = () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
