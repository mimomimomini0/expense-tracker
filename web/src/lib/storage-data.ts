import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getSupabase } from "./supabase";

/** Local PDF storage helpers (owner request 2026-07-22, #3 + #4).
 *
 *  LOCAL-MODE ONLY: reads the fixtures/pdfs folder on the machine running the
 *  app. Works while running on this PC; on cloud hosting (Vercel) that folder
 *  is not deployed and getStorageInfo().exists is false — the UI says so.
 *  The canonical PDF store there is always Supabase storage. */

/** Resolve the PDF folder: FIXTURES_DIR env override, else ../fixtures/pdfs
 *  relative to the web/ working directory. */
export function pdfDir(): string {
  return process.env.FIXTURES_DIR
    ? path.resolve(process.env.FIXTURES_DIR)
    : path.resolve(process.cwd(), "..", "fixtures", "pdfs");
}

export interface StorageInfo {
  dir: string;
  exists: boolean;
  fileCount: number;
}

export function getStorageInfo(): StorageInfo {
  const dir = pdfDir();
  try {
    const files = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".pdf"));
    return { dir, exists: true, fileCount: files.length };
  } catch {
    return { dir, exists: false, fileCount: 0 };
  }
}

export interface ReconcileResult {
  available: boolean;
  dir: string;
  matched: number;
  newOnDisk: { name: string; hash: string }[];   // files not yet imported
  missingOnDisk: { filename: string; hash: string }[]; // in DB, file gone
}

/** Diff the fixtures folder against the imported statements by file hash
 *  (same sha256(buffer) the import uses). Surfaces PDFs to import and DB
 *  statements whose source file has disappeared. */
export async function reconcile(): Promise<ReconcileResult> {
  const dir = pdfDir();
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".pdf"));
  } catch {
    return { available: false, dir, matched: 0, newOnDisk: [], missingOnDisk: [] };
  }

  const diskByHash = new Map<string, string>(); // hash -> filename
  for (const name of names) {
    const buf = fs.readFileSync(path.join(dir, name));
    diskByHash.set(crypto.createHash("sha256").update(buf).digest("hex"), name);
  }

  const supabase = getSupabase();
  const dbHashes = new Map<string, string>(); // hash -> statement filename
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("statements")
      .select("filename,file_hash").order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { filename: string; file_hash: string }[]) {
      dbHashes.set(r.file_hash, r.filename);
    }
    if ((data ?? []).length < 1000) break;
  }

  const newOnDisk: { name: string; hash: string }[] = [];
  let matched = 0;
  for (const [hash, name] of diskByHash) {
    if (dbHashes.has(hash)) matched++;
    else newOnDisk.push({ name, hash: hash.slice(0, 12) });
  }
  const missingOnDisk: { filename: string; hash: string }[] = [];
  for (const [hash, filename] of dbHashes) {
    if (!diskByHash.has(hash)) missingOnDisk.push({ filename, hash: hash.slice(0, 12) });
  }

  return {
    available: true, dir, matched,
    newOnDisk: newOnDisk.sort((a, b) => a.name.localeCompare(b.name)),
    missingOnDisk: missingOnDisk.sort((a, b) => a.filename.localeCompare(b.filename)),
  };
}
