// THE regression harness (kickoff working-order rule #1, spec §10).
// One generated test per statement, per trap, and per chain rule in
// fixture-ground-truth.json — asserted against the hand-verified JSON values,
// never against pipeline output. Runs on every code change via `npm test`.
//
// The pipeline replays cached LLM extractions, so this suite is deterministic
// and free once `npm run extract-fixtures` has run (FR-17 cost confirmation).

import { beforeAll, describe, expect, it } from "vitest";
import {
  batchFileNames, deterministicShuffle, DUPLICATE_TRAP_NAME, loadGroundTruth, loadPdf,
  missingFixtures, runBatch, type BatchRun, type GroundTruthStatement,
} from "./helpers.js";
import { EXTRA_CHECKS, UOB_CHECK, type StmtCtx } from "./statement-checks.js";
import { canonicalSnapshot, MemoryStore } from "../src/store.js";
import { computeChainWarnings } from "../src/chain.js";
import { importPdf } from "../src/pipeline.js";
import { CachingExtractor, sha256, type Extractor } from "../src/llm.js";
import type { ExtractionResult, GateResult } from "../src/types.js";
import type { LlmCallOutcome } from "../src/llm.js";

const gt = loadGroundTruth();
const missing = missingFixtures(gt);
const sen = (rm: number) => Math.round(rm * 100);

let run: BatchRun;

beforeAll(async () => {
  if (missing.length > 0) {
    throw new Error(
      `Missing fixture PDFs in fixtures/pdfs: ${missing.join(", ")} — the harness cannot run without them.`,
    );
  }
  run = await runBatch(batchFileNames(gt));
});

async function ctxFor(s: GroundTruthStatement): Promise<StmtCtx> {
  const store = run.store;
  const banks = await store.listBanks();
  const statements = await store.listStatements();
  const stmtCards = await store.listStatementCards();
  const cards = await store.listCardAccounts();
  const txns = await store.listTransactions();

  const bank = banks.find((b) => b.name.toUpperCase().includes(s.bank.toUpperCase()));
  expect(bank, `bank ${s.bank} should exist`).toBeTruthy();
  const stmt = statements.find(
    (x) => x.bank_id === bank!.id && x.statement_date === s.statement_date,
  );
  expect(stmt, `statement ${s.file} (${s.bank} ${s.statement_date}) should exist`).toBeTruthy();

  const cardEntry = (last4: string) => {
    const card = cards.find((c) => c.bank_id === bank!.id && c.last4 === last4);
    expect(card, `card ${s.bank} ...${last4} should exist`).toBeTruthy();
    const sc = stmtCards.find(
      (x) => x.statement_id === stmt!.id && x.card_account_id === card!.id,
    );
    expect(sc, `statement_card for ...${last4} on ${s.statement_date} should exist`).toBeTruthy();
    return { sc: sc!, txns: txns.filter((t) => t.statement_card_id === sc!.id) };
  };

  return {
    store,
    stmt: stmt!,
    card: cardEntry,
    hasCard: (last4: string) => {
      const card = cards.find((c) => c.bank_id === bank!.id && c.last4 === last4);
      if (!card) return false;
      return stmtCards.some((x) => x.statement_id === stmt!.id && x.card_account_id === card.id);
    },
    allTxns: () => {
      const scIds = stmtCards.filter((x) => x.statement_id === stmt!.id).map((x) => x.id);
      return txns.filter((t) => scIds.includes(t.statement_card_id));
    },
  };
}

// ---------------------------------------------------------------------------
// One test per statement
// ---------------------------------------------------------------------------

describe.each(gt.statements)("statement $file", (s) => {
  it("reaches parsed_ok with reconciliation_delta exactly 0.00", async () => {
    const outcome = run.outcomes.find((o) => o.filename === s.file);
    expect(outcome, "import outcome exists").toBeTruthy();
    expect(outcome!.outcome, outcome!.detail ?? "").toBe("parsed_ok");
    const ctx = await ctxFor(s);
    expect(ctx.stmt.status).toBe("parsed_ok");
    const { sc, txns } = ctx.card(s.card);
    expect(sc.reconciliation_delta, "reconciliation_delta").toBe(0);
    // recompute from stored (immutable) values: opening - credits + debits = closing
    const debits = txns.filter((t) => t.direction === "debit").reduce((a, t) => a + t.amount, 0);
    const credits = txns.filter((t) => t.direction === "credit").reduce((a, t) => a + t.amount, 0);
    expect(sc.opening_balance - credits + debits, "stored rows reconcile to the sen").toBe(
      sc.closing_balance,
    );
  });

  it("matches the hand-verified balances and dates", async () => {
    const ctx = await ctxFor(s);
    expect(ctx.stmt.statement_date).toBe(s.statement_date);
    expect(ctx.stmt.payment_due_date, "payment due date").toBe(s.due_date);
    const { sc } = ctx.card(s.card);
    expect(sc.opening_balance, "opening balance").toBe(sen(s.opening));
    expect(sc.closing_balance, "closing balance").toBe(sen(s.closing));
    if (s.minimum !== undefined) {
      expect(sc.minimum_due, "minimum payment due").toBe(sen(s.minimum));
    }
  });

  it("records model_version and prompt_version", async () => {
    const ctx = await ctxFor(s);
    expect(ctx.stmt.model_version).toMatch(/claude/);
    expect(ctx.stmt.prompt_version).toBeTruthy();
  });

  it("satisfies its statement-specific ground-truth assertions", async () => {
    const ctx = await ctxFor(s);
    const check = EXTRA_CHECKS[s.file];
    if (check) await check(ctx);
    if (s.bank === "UOB") UOB_CHECK(ctx);
  });
});

// ---------------------------------------------------------------------------
// Instalment plan progression (May 01/36 -> Jun 02/36 -> Jul 03/36)
// ---------------------------------------------------------------------------

describe("instalment plan EP-OGAWA", () => {
  it("updates a single plan record across uploads — never duplicates", async () => {
    const plans = await run.store.listInstalmentPlans();
    const ogawa = plans.filter((p) => p.plan_name.includes("OGAWA"));
    expect(ogawa.length, "exactly one EP-OGAWA plan record").toBe(1);
    const p = ogawa[0]!;
    expect(p.total_months).toBe(36);
    expect(p.months_elapsed, "03/36 after the July statement").toBe(3);
    expect(p.principal_total, "principal 9999.00").toBe(sen(9999.0));
    expect(p.principal_outstanding, "outstanding 9165.75 after 03/36").toBe(sen(9165.75));
    expect(p.monthly_amount).toBe(sen(277.75));
  });
});

// ---------------------------------------------------------------------------
// One test per trap
// ---------------------------------------------------------------------------

describe.each(gt.traps)("trap $file", (trap) => {
  it(`is ${trap.expected}`, async () => {
    if (trap.file.includes("20705500033467")) {
      // RHB business CURRENT ACCOUNT statement — rejected at the document-type gate
      const outcome = run.outcomes.find((o) => o.filename === trap.file);
      expect(outcome, "trap file was part of the batch").toBeTruthy();
      expect(outcome!.outcome).toBe("rejected_not_statement");
      // zero records committed
      const hash = sha256(loadPdf(trap.file));
      const statements = await run.store.listStatements();
      expect(statements.some((st) => st.file_hash === hash)).toBe(false);
      const rejections = await run.store.listRejections();
      const rej = rejections.find((r) => r.filename === trap.file);
      expect(rej, "upload-rejection log entry").toBeTruthy();
      expect(rej!.reason).toBe("not_credit_card_statement");
      expect(rej!.detail).toContain("not a credit card statement");
    } else {
      // deliberate duplicate upload of the June RHB statement
      const outcome = run.outcomes.find((o) => o.filename === DUPLICATE_TRAP_NAME);
      expect(outcome, "duplicate copy was part of the batch").toBeTruthy();
      expect(outcome!.outcome).toBe("rejected_duplicate");
      // existing data never overwritten or double-inserted
      const hash = sha256(loadPdf("RHB_4258608307183799_20260601.pdf"));
      const statements = await run.store.listStatements();
      expect(statements.filter((st) => st.file_hash === hash).length).toBe(1);
      const rejections = await run.store.listRejections();
      expect(rejections.some((r) => r.reason === "duplicate_file_hash")).toBe(true);
    }
  });
});

describe("re-upload of an already-imported statement", () => {
  it("is rejected as a duplicate and changes nothing", async () => {
    const before = (await run.store.listTransactions()).length;
    const outcome = await importPdf(
      run.store, new CachingExtractor(), "eStatement20260519.pdf", loadPdf("eStatement20260519.pdf"),
    );
    expect(outcome.outcome).toBe("rejected_duplicate");
    expect((await run.store.listTransactions()).length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// One test per chain rule
// ---------------------------------------------------------------------------

async function warningsForCard(store: MemoryStore, bankName: string, last4: string) {
  const warnings = await computeChainWarnings(store);
  return warnings.filter((w) => w.bank.toUpperCase().includes(bankName) && w.last4 === last4);
}

describe.each(gt.chains)("chain $card", (chain) => {
  it("verifies against the stored statements", async () => {
    const [bankName, last4] = chain.card.split(" ") as [string, string];
    const cardWarnings = await warningsForCard(run.store, bankName.toUpperCase(), last4);

    if (chain.then_gap) {
      // CIMB 2225: 2024 run unbroken, then EXACTLY ONE gap (Jul 2024 - Apr 2026),
      // and the 2026-05 -> 2026-06 link unbroken.
      expect(cardWarnings.length, JSON.stringify(cardWarnings, null, 1)).toBe(1);
      expect(cardWarnings[0]!.from_statement_date).toBe("2024-06-19");
      expect(cardWarnings[0]!.to_statement_date).toBe("2026-05-19");
    } else {
      // RHB 3799: Jan-Jul 2026 unbroken — zero gap warnings
      expect(cardWarnings.length, JSON.stringify(cardWarnings, null, 1)).toBe(0);
    }

    // each closing balance equals the next statement's opening (from the JSON)
    const banks = await run.store.listBanks();
    const cards = await run.store.listCardAccounts();
    const statements = await run.store.listStatements();
    const stmtCards = await run.store.listStatementCards();
    const bank = banks.find((b) => b.name.toUpperCase().includes(bankName.toUpperCase()))!;
    const card = cards.find((c) => c.bank_id === bank.id && c.last4 === last4)!;
    const byDate = new Map(
      stmtCards
        .filter((sc) => sc.card_account_id === card.id)
        .map((sc) => [statements.find((s) => s.id === sc.statement_id)!.statement_date, sc]),
    );
    for (let i = 1; i < chain.unbroken.length; i++) {
      const prev = byDate.get(chain.unbroken[i - 1]!)!;
      const next = byDate.get(chain.unbroken[i]!)!;
      expect(prev, `statement ${chain.unbroken[i - 1]} present`).toBeTruthy();
      expect(next, `statement ${chain.unbroken[i]} present`).toBeTruthy();
      expect(next.opening_balance, `${chain.unbroken[i]} opening = ${chain.unbroken[i - 1]} closing`).toBe(
        prev.closing_balance,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Corrupted copy -> needs_review, never parsed_ok, nothing committed
// ---------------------------------------------------------------------------

class CorruptingExtractor implements Extractor {
  constructor(private base: Extractor) {}
  gate(pdf: Buffer, hash: string): Promise<LlmCallOutcome<GateResult>> {
    return this.base.gate(pdf, hash);
  }
  // Replays the cached extraction with ONE amount altered — simulating a
  // statement whose printed amount is genuinely unreadable. Every attempt
  // (primary, re-parse, and the stronger-model escalation) sees the same
  // corruption, so reconciliation must fail on all of them. Delegating to the
  // cached base.extract keeps this offline — no real API call fires.
  private async corrupt(pdf: Buffer, hash: string): Promise<LlmCallOutcome<ExtractionResult>> {
    const out = await this.base.extract(pdf, hash, null);
    const clone = structuredClone(out.result) as ExtractionResult;
    const txn = clone.cards[0]?.transactions[0];
    if (txn) txn.amount_rm = Math.round((txn.amount_rm + 1) * 100) / 100;
    return { ...out, result: clone };
  }
  extract(pdf: Buffer, hash: string, _feedback: string | null): Promise<LlmCallOutcome<ExtractionResult>> {
    return this.corrupt(pdf, hash);
  }
  escalate(pdf: Buffer, hash: string, _feedback: string): Promise<LlmCallOutcome<ExtractionResult>> {
    return this.corrupt(pdf, hash);
  }
}

describe("corrupted copy (one amount altered)", () => {
  it("lands in needs_review with nothing committed, after re-parse then escalation", async () => {
    const store = new MemoryStore();
    const extractor = new CorruptingExtractor(new CachingExtractor());
    const outcome = await importPdf(
      store, extractor, "eStatement20260519_CORRUPTED.pdf", loadPdf("eStatement20260519.pdf"),
    );
    expect(outcome.outcome).toBe("needs_review");
    expect(outcome.retryCount, "one self-correcting re-parse plus one model escalation").toBe(2);
    const statements = await store.listStatements();
    expect(statements.length).toBe(1);
    expect(statements[0]!.status).toBe("needs_review");
    expect(statements[0]!.review_reason).toContain("delta");
    // NOTHING committed to the expense database
    expect((await store.listStatementCards()).length).toBe(0);
    expect((await store.listTransactions()).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Shuffled-order import converges to the identical final state
// ---------------------------------------------------------------------------

describe("out-of-order import", () => {
  it("shuffled upload order produces an identical final state, chain warnings resolved", async () => {
    const names = batchFileNames(gt);
    const ordered = await runBatch(names);
    const shuffled = await runBatch(deterministicShuffle(names, 42));
    expect(await canonicalSnapshot(shuffled.store)).toBe(await canonicalSnapshot(ordered.store));

    // chain state identical too: RHB clean, CIMB exactly the known gap
    expect((await warningsForCard(shuffled.store, "RHB", "3799")).length).toBe(0);
    const cimb = await warningsForCard(shuffled.store, "CIMB", "2225");
    expect(cimb.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Deleting a mid-chain statement surfaces exactly one gap; re-import clears it
// (mutating test — keep last)
// ---------------------------------------------------------------------------

describe("chain gap detection on delete + auto-resolve on re-import", () => {
  it("deleting the April RHB statement produces exactly one gap warning; re-importing clears it", async () => {
    const statements = await run.store.listStatements();
    const april = statements.find(
      (s) => s.filename === "RHB_4258608307183799_20260401.pdf" && s.status === "parsed_ok",
    );
    expect(april, "April RHB statement exists").toBeTruthy();

    await run.store.deleteStatement(april!.id);
    const after = await warningsForCard(run.store, "RHB", "3799");
    expect(after.length, JSON.stringify(after, null, 1)).toBe(1);
    expect(after[0]!.from_statement_date).toBe("2026-03-15");
    expect(after[0]!.to_statement_date).toBe("2026-05-15");

    // warnings auto-resolve the moment the missing statement is imported
    const outcome = await importPdf(
      run.store, new CachingExtractor(),
      "RHB_4258608307183799_20260401.pdf", loadPdf("RHB_4258608307183799_20260401.pdf"),
    );
    expect(outcome.outcome).toBe("parsed_ok");
    expect((await warningsForCard(run.store, "RHB", "3799")).length).toBe(0);
  });
});
