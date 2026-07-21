// FR-7 stage 2: LLM category suggestions for the pending merchant groups.
//   npx tsx scripts/suggest-categories.ts            -> shows the plan + cost estimate, makes NO API call
//   npx tsx scripts/suggest-categories.ts --confirm  -> one batched, cached call, then applies results
//
// Applies the spec rule: suggestions at/above AUTO_ASSIGN_CONFIDENCE
// auto-assign (category_source 'llm', still editable, cleared from the queue);
// lower-confidence suggestions stay IN the queue with the recommendation
// stored in notes-free form (confidence column) for the queue UI to display.
// User-set rows are never touched. Results are cached in
// fixtures/extractions/category-suggestions.json so re-runs are free.

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { SupabaseStore } from "../src/store-supabase.js";
import { AUTO_ASSIGN_CONFIDENCE, CATEGORIES, merchantKey } from "../src/classify.js";
import { cacheDir, costOf, MODEL } from "../src/llm.js";

const CONFIRMED = process.argv.includes("--confirm");
const CACHE = path.join(cacheDir(), "category-suggestions.json");

const db = new SupabaseStore().client;

// ---- pending groups (paginated past the 1000-row default page size) ----
const pendingRows: { id: number; description_raw: string; category_source: string | null }[] = [];
for (let from = 0; ; from += 1000) {
  const page = await db.from("transactions")
    .select("id,description_raw,category_source,needs_confirmation")
    .eq("needs_confirmation", true).order("id").range(from, from + 999);
  if (page.error) throw new Error(page.error.message);
  pendingRows.push(...(page.data as typeof pendingRows));
  if ((page.data ?? []).length < 1000) break;
}
const groups = new Map<string, number[]>();
for (const t of pendingRows) {
  if (t.category_source === "user") continue;
  const k = merchantKey(t.description_raw as string);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(t.id as number);
}
if (groups.size === 0) {
  console.log("confirmation queue is empty — nothing to suggest");
  process.exit(0);
}

// ---- cached suggestions ----
type Suggestion = { category: string; confidence: number };
const cache: Record<string, Suggestion> = fs.existsSync(CACHE)
  ? JSON.parse(fs.readFileSync(CACHE, "utf8"))
  : {};
const missing = [...groups.keys()].filter((k) => !cache[k]);

console.log(`pending merchant groups: ${groups.size} (${missing.length} without a cached suggestion)`);
if (missing.length > 0 && !CONFIRMED) {
  // rough estimate: prompt + ~15 tokens per merchant in, ~25 out
  const inTok = 400 + missing.length * 15;
  const outTok = missing.length * 25;
  const { usd, rm } = costOf(inTok, outTok);
  console.log(`\nWould make ONE ${MODEL} call: ~${inTok} tokens in, ~${outTok} out`);
  console.log(`ESTIMATE: USD ${usd.toFixed(4)} (approx RM ${rm.toFixed(2)})`);
  console.log(`\nNo API call made. Re-run with --confirm to proceed (FR-17).`);
  process.exit(0);
}

if (missing.length > 0) {
  const sugZ = z.object({
    suggestions: z.array(z.object({
      merchant: z.string(),
      category: z.enum(CATEGORIES),
      confidence: z.number().min(0).max(1),
    })),
  });
  const client = new Anthropic();
  let totalUsd = 0, totalRm = 0;
  // chunk the merchants: one giant response risks truncation / empty content;
  // each chunk's results are cached immediately so a crash resumes for free
  const CHUNK = 80;
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK);
    const prompt =
      `You categorise Malaysian credit-card merchants for an expense tracker. ` +
      `Allowed categories (use EXACTLY these strings): ${CATEGORIES.join(" | ")}.\n` +
      `For each merchant below, return your best category and a calibrated confidence 0-1 ` +
      `(1 = certain, <0.8 = a human should confirm). Merchants are raw statement descriptors ` +
      `(location suffixes, branch codes). E-wallet or wallet TOP-UPS (TNG, GrabPay, Boost) are ` +
      `transfers: give them category "Wallet Transfers" with LOW confidence so a human decides.\n` +
      `Respond with a single JSON object: {"suggestions":[{"merchant":"...","category":"...","confidence":0.x}]} ` +
      `covering EVERY merchant, no commentary, no markdown fences.\n\nMerchants:\n` +
      chunk.map((m) => `- ${m}`).join("\n");

    const stream = client.messages.stream({
      model: MODEL, max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    });
    const resp = await stream.finalMessage();
    if (resp.stop_reason === "max_tokens") throw new Error("suggestion response truncated — lower CHUNK");
    const text = resp.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") {
      throw new Error(`no text in response (stop_reason ${resp.stop_reason}, content types: ${resp.content.map((b) => b.type).join(",") || "none"})`);
    }
    const raw = text.text.trim().replace(/^```json?\s*|\s*```$/g, "");
    const parsed = sugZ.parse(JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)));
    const { usd, rm } = costOf(resp.usage.input_tokens, resp.usage.output_tokens);
    totalUsd += usd; totalRm += rm;
    for (const s of parsed.suggestions) {
      // model may echo the merchant slightly differently; match by key
      const k = [...groups.keys()].find((g) => merchantKey(s.merchant) === merchantKey(g));
      if (k) cache[k] = { category: s.category, confidence: s.confidence };
    }
    fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1), "utf8");
    console.log(`chunk ${Math.floor(i / CHUNK) + 1}/${Math.ceil(missing.length / CHUNK)}: ${parsed.suggestions.length} suggestions (${resp.usage.input_tokens} in / ${resp.usage.output_tokens} out)`);
  }
  console.log(`API spend: USD ${totalUsd.toFixed(4)} (RM ${totalRm.toFixed(2)})`);
  const still = [...groups.keys()].filter((k) => !cache[k]);
  if (still.length > 0) console.log(`WARNING: no suggestion returned for ${still.length} merchants: ${still.slice(0, 5).join(", ")}${still.length > 5 ? " ..." : ""}`);
}

// ---- apply ----
const catQ = await db.from("categories").select("id,name_en").is("user_id", null);
if (catQ.error) throw new Error(catQ.error.message);
const catId = new Map((catQ.data ?? []).map((c) => [c.name_en as string, c.id as number]));

let autoAssigned = 0, keptQueued = 0;
for (const [merchant, ids] of groups) {
  const s = cache[merchant];
  if (!s) continue;
  const cid = catId.get(s.category);
  if (!cid) { console.log(`skip ${merchant}: unknown category "${s.category}"`); continue; }
  const auto = s.confidence >= AUTO_ASSIGN_CONFIDENCE;
  const upd = await db.from("transactions").update(
    auto
      ? { category_id: cid, category_source: "llm", confidence: s.confidence, needs_confirmation: false }
      : { category_id: cid, category_source: "llm", confidence: s.confidence }, // stays queued, recommendation shown
  ).in("id", ids)
    .or("category_source.is.null,category_source.neq.user")
    .select("id");
  if (upd.error) throw new Error(`apply ${merchant}: ${upd.error.message}`);
  if (auto) autoAssigned += upd.data?.length ?? 0; else keptQueued += upd.data?.length ?? 0;
}
console.log(`auto-assigned (>= ${AUTO_ASSIGN_CONFIDENCE}): ${autoAssigned} rows | queued with recommendation: ${keptQueued} rows`);
