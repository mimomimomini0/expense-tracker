// Phase 1 store. The pipeline talks to this interface only.
// MemoryStore backs the regression harness (deterministic, resettable);
// SupabaseStore (store-supabase.ts) backs real CLI imports.
//
// Derived state (chain warnings, instalment plans, payment cycles) is always
// RECOMPUTED from immutable stored statements, never incrementally patched —
// this is what makes shuffled-order imports converge to the same final state.

import type {
  ApiCostRow, BankRow, CardAccountRow, InstalmentPlanRow, PaymentCycleRow,
  RejectionRow, StatementCardRow, StatementRow, TransactionRow,
} from "./types.js";

export interface Store {
  getOrCreateBank(name: string): Promise<BankRow>;
  findCardAccount(bankId: number, last4: string): Promise<CardAccountRow | null>;
  createCardAccount(bankId: number, last4: string, holderLabel: string | null): Promise<CardAccountRow>;
  /** FR-4d: record that cardId REPLACES/continues predecessorCardId. */
  linkCardContinuation(cardId: number, predecessorCardId: number): Promise<void>;

  findStatementByHash(fileHash: string): Promise<StatementRow | null>;
  findStatementCardByCardAndDate(cardAccountId: number, statementDate: string): Promise<StatementCardRow | null>;
  insertStatement(row: Omit<StatementRow, "id">): Promise<StatementRow>;
  insertStatementCard(row: Omit<StatementCardRow, "id">): Promise<StatementCardRow>;
  insertTransactions(rows: Omit<TransactionRow, "id">[]): Promise<void>;
  deleteStatement(statementId: number): Promise<void>;

  listBanks(): Promise<BankRow[]>;
  listCardAccounts(): Promise<CardAccountRow[]>;
  listStatements(): Promise<StatementRow[]>;
  listStatementCards(): Promise<StatementCardRow[]>;
  listTransactions(): Promise<TransactionRow[]>;

  replaceInstalmentPlans(cardAccountId: number, plans: Omit<InstalmentPlanRow, "id" | "card_account_id">[]): Promise<void>;
  listInstalmentPlans(): Promise<InstalmentPlanRow[]>;

  replacePaymentCycles(cardAccountId: number, cycles: Omit<PaymentCycleRow, "id" | "card_account_id">[]): Promise<void>;
  listPaymentCycles(): Promise<PaymentCycleRow[]>;

  logRejection(row: Omit<RejectionRow, "id">): Promise<void>;
  listRejections(): Promise<RejectionRow[]>;
  logApiCost(row: Omit<ApiCostRow, "id">): Promise<void>;
  listApiCosts(): Promise<ApiCostRow[]>;
}

export class MemoryStore implements Store {
  private seq = 0;
  banks: BankRow[] = [];
  cardAccounts: CardAccountRow[] = [];
  statements: StatementRow[] = [];
  statementCards: StatementCardRow[] = [];
  transactions: TransactionRow[] = [];
  instalmentPlans: InstalmentPlanRow[] = [];
  paymentCycles: PaymentCycleRow[] = [];
  rejections: RejectionRow[] = [];
  apiCosts: ApiCostRow[] = [];

  private nextId(): number {
    return ++this.seq;
  }

  async getOrCreateBank(name: string): Promise<BankRow> {
    const existing = this.banks.find((b) => b.name.toUpperCase() === name.toUpperCase());
    if (existing) return existing;
    const row: BankRow = { id: this.nextId(), name };
    this.banks.push(row);
    return row;
  }

  async findCardAccount(bankId: number, last4: string): Promise<CardAccountRow | null> {
    return this.cardAccounts.find((c) => c.bank_id === bankId && c.last4 === last4) ?? null;
  }

  async createCardAccount(bankId: number, last4: string, holderLabel: string | null): Promise<CardAccountRow> {
    const row: CardAccountRow = {
      id: this.nextId(), bank_id: bankId, last4, holder_label: holderLabel, continues_card_id: null,
    };
    this.cardAccounts.push(row);
    return row;
  }

  async linkCardContinuation(cardId: number, predecessorCardId: number): Promise<void> {
    if (cardId === predecessorCardId) throw new Error("a card cannot continue itself");
    const card = this.cardAccounts.find((c) => c.id === cardId);
    if (!card) throw new Error(`linkCardContinuation: card ${cardId} not found`);
    if (!this.cardAccounts.some((c) => c.id === predecessorCardId)) {
      throw new Error(`linkCardContinuation: predecessor ${predecessorCardId} not found`);
    }
    card.continues_card_id = predecessorCardId;
  }

  async findStatementByHash(fileHash: string): Promise<StatementRow | null> {
    return this.statements.find((s) => s.file_hash === fileHash) ?? null;
  }

  async findStatementCardByCardAndDate(cardAccountId: number, statementDate: string): Promise<StatementCardRow | null> {
    for (const sc of this.statementCards) {
      if (sc.card_account_id !== cardAccountId) continue;
      const st = this.statements.find((s) => s.id === sc.statement_id);
      if (st && st.statement_date === statementDate) return sc;
    }
    return null;
  }

  async insertStatement(row: Omit<StatementRow, "id">): Promise<StatementRow> {
    // uniqueness: (user, file_hash)
    if (this.statements.some((s) => s.file_hash === row.file_hash)) {
      throw new Error(`unique violation: file_hash ${row.file_hash}`);
    }
    const full: StatementRow = { ...row, id: this.nextId() };
    this.statements.push(full);
    return full;
  }

  async insertStatementCard(row: Omit<StatementCardRow, "id">): Promise<StatementCardRow> {
    // uniqueness: (user, card_account_id, statement_date)
    const st = this.statements.find((s) => s.id === row.statement_id);
    if (st) {
      const dup = await this.findStatementCardByCardAndDate(row.card_account_id, st.statement_date);
      if (dup) throw new Error(`unique violation: card ${row.card_account_id} @ ${st.statement_date}`);
    }
    const full: StatementCardRow = { ...row, id: this.nextId() };
    this.statementCards.push(full);
    return full;
  }

  async insertTransactions(rows: Omit<TransactionRow, "id">[]): Promise<void> {
    for (const r of rows) this.transactions.push({ ...r, id: this.nextId() });
  }

  async deleteStatement(statementId: number): Promise<void> {
    const cardIds = this.statementCards.filter((sc) => sc.statement_id === statementId).map((sc) => sc.id);
    this.transactions = this.transactions.filter((t) => !cardIds.includes(t.statement_card_id));
    this.statementCards = this.statementCards.filter((sc) => sc.statement_id !== statementId);
    this.statements = this.statements.filter((s) => s.id !== statementId);
    this.paymentCycles = this.paymentCycles.filter((c) => c.statement_id !== statementId);
  }

  async listBanks() { return [...this.banks]; }
  async listCardAccounts() { return [...this.cardAccounts]; }
  async listStatements() { return [...this.statements]; }
  async listStatementCards() { return [...this.statementCards]; }
  async listTransactions() { return [...this.transactions]; }

  async replaceInstalmentPlans(cardAccountId: number, plans: Omit<InstalmentPlanRow, "id" | "card_account_id">[]): Promise<void> {
    this.instalmentPlans = this.instalmentPlans.filter((p) => p.card_account_id !== cardAccountId);
    for (const p of plans) {
      this.instalmentPlans.push({ ...p, id: this.nextId(), card_account_id: cardAccountId });
    }
  }

  async listInstalmentPlans() { return [...this.instalmentPlans]; }

  async replacePaymentCycles(cardAccountId: number, cycles: Omit<PaymentCycleRow, "id" | "card_account_id">[]): Promise<void> {
    this.paymentCycles = this.paymentCycles.filter((c) => c.card_account_id !== cardAccountId);
    for (const c of cycles) {
      this.paymentCycles.push({ ...c, id: this.nextId(), card_account_id: cardAccountId });
    }
  }

  async listPaymentCycles() { return [...this.paymentCycles]; }

  async logRejection(row: Omit<RejectionRow, "id">): Promise<void> {
    this.rejections.push({ ...row, id: this.nextId() });
  }
  async listRejections() { return [...this.rejections]; }

  async logApiCost(row: Omit<ApiCostRow, "id">): Promise<void> {
    this.apiCosts.push({ ...row, id: this.nextId() });
  }
  async listApiCosts() { return [...this.apiCosts]; }
}

/**
 * Canonical snapshot of committed financial state, independent of insertion
 * order and row ids. Used by the shuffled-order convergence test.
 */
export async function canonicalSnapshot(store: Store): Promise<string> {
  const banks = await store.listBanks();
  const cards = await store.listCardAccounts();
  const statements = await store.listStatements();
  const stmtCards = await store.listStatementCards();
  const txns = await store.listTransactions();
  const plans = await store.listInstalmentPlans();
  const cycles = await store.listPaymentCycles();

  const bankName = (id: number) => banks.find((b) => b.id === id)?.name ?? "?";
  const cardKey = (id: number) => {
    const c = cards.find((x) => x.id === id);
    return c ? `${bankName(c.bank_id)}:${c.last4}` : "?";
  };
  const stmtKey = (id: number) => {
    const s = statements.find((x) => x.id === id);
    return s ? `${bankName(s.bank_id)}:${s.statement_date}:${s.file_hash.slice(0, 12)}` : "?";
  };
  const stmtCardKey = (id: number) => {
    const sc = stmtCards.find((x) => x.id === id);
    return sc ? `${stmtKey(sc.statement_id)}|${cardKey(sc.card_account_id)}` : "?";
  };

  const snap = {
    statements: statements
      // filename intentionally omitted: when a batch contains the same file
      // twice under two names, whichever imports first wins — the financial
      // state must still converge regardless of order.
      .map((s) => ({
        key: stmtKey(s.id), status: s.status,
        due: s.payment_due_date, retries: s.retry_count,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    statementCards: stmtCards
      .map((sc) => ({
        key: stmtCardKey(sc.id), opening: sc.opening_balance, closing: sc.closing_balance,
        min: sc.minimum_due, delta: sc.reconciliation_delta,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    transactions: txns
      .map((t) => ({
        card: cardKey(t.card_account_id), sc: stmtCardKey(t.statement_card_id),
        date: t.txn_date, desc: t.description_raw, amt: t.amount, dir: t.direction,
        type: t.txn_type, ccy: t.original_currency, orig: t.original_amount,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    plans: plans
      .map((p) => ({
        card: cardKey(p.card_account_id), name: p.plan_name, total: p.total_months,
        elapsed: p.months_elapsed, principal: p.principal_total, outstanding: p.principal_outstanding,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    cycles: cycles
      .map((c) => ({
        card: cardKey(c.card_account_id), stmt: stmtKey(c.statement_id), due: c.due_date,
        balance: c.statement_balance, min: c.minimum_due, status: c.status, paid: c.amount_paid,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
  return JSON.stringify(snap, null, 1);
}
