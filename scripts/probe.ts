// Diagnostic probe: is the API reachable, and do large PDF uploads survive?
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const c = new Anthropic({ maxRetries: 3 });
const ROOT = path.resolve(import.meta.dirname, "..");

const small = await c.messages.countTokens({
  model: "claude-sonnet-5",
  messages: [{ role: "user", content: "hello world" }],
});
console.log("1. text-only count_tokens OK:", small.input_tokens, "tokens");

const target = process.argv[2] ?? "eStatement_31263.924003865075.pdf";
const pdf = fs.readFileSync(path.join(ROOT, "fixtures", "pdfs", target));
console.log(`2. trying PDF ${target} (${(pdf.length / 1024).toFixed(0)} KB)...`);
const big = await c.messages.countTokens({
  model: "claude-sonnet-5",
  messages: [
    {
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } },
        { type: "text", text: "Extract the statement data." },
      ],
    },
  ],
});
console.log("   PDF count_tokens OK:", big.input_tokens, "tokens");
