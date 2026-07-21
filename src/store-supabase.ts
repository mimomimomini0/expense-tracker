// Supabase-backed Store. Same interface as MemoryStore, so the pipeline is
// storage-agnostic. Monetary values are integer sen in the app and
// numeric(12,2) RM in Postgres; conversion happens only at this boundary.

import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Store } from "./store.js";
import type {
  ApiCostRow, BankRow, CardAccountRow, InstalmentPlanRow, PaymentCycleRow,
  RejectionRow, StatementCardRow, StatementRow, TransactionRow,
} from "./types.js";

const rm = (sen: number | null): number | null => (sen == null ? null : sen / 100);
const senOf = (v: unknown): number => Math.round(Number(v) * 100);
const senOrNull = (v: unknown): number | null => (v == null ? null : Math.round(Number(v) * 100));

function need<T>(data: T | null, error: { message: string } | null, ctx: string): T {
  if (error) throw new Error(`${ctx}: ${error.message}`);
  if (data == null) throw new Error(`${ctx}: no data returned`);
  return data;
}

export class SupabaseStore implements Store {
  private db: SupabaseClient;

  constructor() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env");
    this.db = createClient(url, key, { auth: { persistSession: false } });
  }

  get client(): SupabaseClient {
    return this.db;
  }

  async getOrCreateBank(name: string): Promise<BankRow> {
    const found = await this.db.from("banks").select("id,name").ilike("name", name).maybeSingle();
    if (found.error) throw new Error(`getOrCreateBank: ${found.error.message}`);
    if (found.data) return found.data as BankRow;
    const ins = await this.db.from("banks").insert({ name }).select("id,name").single();
    return need(ins.data, ins.error, "getOrCreateBank insert") as BankRow;
  }

  // continues_card_id requires schema-phase2.sql to be applied
  private cardCols = "id,bank_id,last4,holder_label,continues_card_id";

  async findCardAccount(bankId: number, last4: string): Promise<CardAccountRow | null> {
    const r = await this.db
      .from("card_accounts").select(this.cardCols)
      .eq("bank_id", bankId).eq("last4", last4).maybeSingle();
    if (r.error) throw new Error(`findCardAccount: ${r.error.message}`);
    return (r.data as unknown as CardAccountRow) ?? null;
  }

  async createCardAccount(bankId: number, last4: string, holderLabel: string | null): Promise<CardAccountRow> {
    const r = await this.db
      .from("card_accounts").insert({ bank_id: bankId, last4, holder_label: holderLabel })
      .select(this.cardCols).single();
    return need(r.data, r.error, "createCardAccount") as unknown as CardAccountRow;
  }

  async linkCardContinuation(cardId: number, predecessorCardId: number): Promise<void> {
    if (cardId === predecessorCardId) throw new Error("a card cannot continue itself");
    const r = await this.db
      .from("card_accounts").update({ continues_card_id: predecessorCardId }).eq("id", cardId);
    if (r.error) throw new Error(`linkCardContinuation: ${r.error.message}`);
  }

  private stmtCols =
    "id,bank_id,filename,file_hash,statement_date,period_start,period_end,payment_due_date,status,model_version,prompt_version,retry_count,review_reason,raw_extraction_json";

  private toStatementRow(d: Record<string, unknown>): StatementRow {
    return {
      ...(d as unknown as StatementRow),
      raw_extraction_json:
        typeof d.raw_extraction_json === "string"
          ? d.raw_extraction_json
          : JSON.stringify(d.raw_extraction_json),
    };
  }

  async findStatementByHash(fileHash: string): Promise<StatementRow | null> {
    const r = await this.db.from("statements").select(this.stmtCols).eq("file_hash", fileHash).maybeSingle();
    if (r.error) throw new Error(`findStatementByHash: ${r.error.message}`);
    return r.data ? this.toStatementRow(r.data as unknown as Record<string, unknown>) : null;
  }

  async findStatementCardByCardAndDate(cardAccountId: number, statementDate: string): Promise<StatementCardRow | null> {
    const r = await this.db
      .from("statement_cards").select("*")
      .eq("card_account_id", cardAccountId).eq("statement_date", statementDate).maybeSingle();
    if (r.error) throw new Error(`findStatementCardByCardAndDate: ${r.error.message}`);
    return r.data ? this.toStatementCardRow(r.data) : null;
  }

  async insertStatement(row: Omit<StatementRow, "id">): Promise<StatementRow> {
    const r = await this.db
      .from("statements")
      .insert({
        bank_id: row.bank_id,
        filename: row.filename,
        file_hash: row.file_hash,
        statement_date: row.statement_date,
        period_start: row.period_start,
        period_end: row.period_end,
        payment_due_date: row.payment_due_date,
        status: row.status,
        model_version: row.model_version,
        prompt_version: row.prompt_version,
        retry_count: row.retry_count,
        review_reason: row.review_reason,
        raw_extraction_json: JSON.parse(row.raw_extraction_json),
      })
      .select(this.stmtCols)
      .single();
    return this.toStatementRow(need(r.data, r.error, "insertStatement") as unknown as Record<string, unknown>);
  }

  private toStatementCardRow(d: Record<string, unknown>): StatementCardRow {
    return {
      id: d.id as number,
      statement_id: d.statement_id as number,
      card_account_id: d.card_account_id as number,
      opening_balance: senOf(d.opening_balance),
      closing_balance: senOf(d.closing_balance),
      minimum_due: senOrNull(d.minimum_due),
      credit_limit: senOrNull(d.credit_limit),
      retail_interest_rate: d.retail_interest_rate == null ? null : Number(d.retail_interest_rate),
      summary_totals_json: d.summary_totals_json == null ? null : JSON.stringify(d.summary_totals_json),
      instalment_summaries_json:
        d.instalment_summaries_json == null ? null : JSON.stringify(d.instalment_summaries_json),
      reconciliation_delta: senOf(d.reconciliation_delta ?? 0),
    };
  }

  async insertStatementCard(row: Omit<StatementCardRow, "id">): Promise<StatementCardRow> {
    const st = await this.db.from("statements").select("statement_date").eq("id", row.statement_id).single();
    const statementDate = need(st.data, st.error, "insertStatementCard lookup").statement_date as string;
    const r = await this.db
      .from("statement_cards")
      .insert({
        statement_id: row.statement_id,
        card_account_id: row.card_account_id,
        statement_date: statementDate,
        opening_balance: rm(row.opening_balance),
        closing_balance: rm(row.closing_balance),
        minimum_due: rm(row.minimum_due),
        credit_limit: rm(row.credit_limit),
        retail_interest_rate: row.retail_interest_rate,
        summary_totals_json: row.summary_totals_json ? JSON.parse(row.summary_totals_json) : null,
        instalment_summaries_json: row.instalment_summaries_json ? JSON.parse(row.instalment_summaries_json) : null,
        reconciliation_delta: rm(row.reconciliation_delta),
      })
      .select("*")
      .single();
    return this.toStatementCardRow(need(r.data, r.error, "insertStatementCard") as Record<string, unknown>);
  }

  async insertTransactions(rows: Omit<TransactionRow, "id">[]): Promise<void> {
    if (rows.length === 0) return;
    const r = await this.db.from("transactions").insert(
      rows.map((t) => ({
        statement_card_id: t.statement_card_id,
        card_account_id: t.card_account_id,
        txn_date: t.txn_date,
        posting_date: t.posting_date,
        description_raw: t.description_raw,
        amount_rm: rm(t.amount),
        direction: t.direction,
        original_currency: t.original_currency,
        original_amount: t.original_amount,
        txn_type: t.txn_type,
      })),
    );
    if (r.error) throw new Error(`insertTransactions: ${r.error.message}`);
  }

  async deleteStatement(statementId: number): Promise<void> {
    const r = await this.db.from("statements").delete().eq("id", statementId);
    if (r.error) throw new Error(`deleteStatement: ${r.error.message}`);
  }

  async listBanks(): Promise<BankRow[]> {
    const r = await this.db.from("banks").select("id,name").order("id");
    return need(r.data, r.error, "listBanks") as BankRow[];
  }

  async listCardAccounts(): Promise<CardAccountRow[]> {
    const r = await this.db.from("card_accounts").select(this.cardCols).order("id");
    return need(r.data, r.error, "listCardAccounts") as unknown as CardAccountRow[];
  }

  async listStatements(): Promise<StatementRow[]> {
    const r = await this.db.from("statements").select(this.stmtCols).order("id");
    return (need(r.data, r.error, "listStatements") as unknown as Record<string, unknown>[]).map((d) =>
      this.toStatementRow(d),
    );
  }

  async listStatementCards(): Promise<StatementCardRow[]> {
    const r = await this.db.from("statement_cards").select("*").order("id");
    return (need(r.data, r.error, "listStatementCards") as Record<string, unknown>[]).map((d) =>
      this.toStatementCardRow(d),
    );
  }

  async listTransactions(): Promise<TransactionRow[]> {
    // paginated: PostgREST caps a single select at 1000 rows by default, and
    // this table passed that during the 2024 backfill. An unpaginated read
    // here silently truncated what recomputePaymentCycles / instalments saw.
    const rows: Record<string, unknown>[] = [];
    for (let from = 0; ; from += 1000) {
      const r = await this.db.from("transactions").select("*").order("id").range(from, from + 999);
      const page = need(r.data, r.error, "listTransactions") as Record<string, unknown>[];
      rows.push(...page);
      if (page.length < 1000) break;
    }
    return rows.map((d) => ({
      id: d.id as number,
      statement_card_id: d.statement_card_id as number,
      card_account_id: d.card_account_id as number,
      txn_date: d.txn_date as string,
      posting_date: (d.posting_date as string) ?? null,
      description_raw: d.description_raw as string,
      amount: senOf(d.amount_rm),
      direction: d.direction as "debit" | "credit",
      original_currency: (d.original_currency as string) ?? null,
      original_amount: d.original_amount == null ? null : Number(d.original_amount),
      txn_type: d.txn_type as TransactionRow["txn_type"],
    }));
  }

  async replaceInstalmentPlans(
    cardAccountId: number,
    plans: Omit<InstalmentPlanRow, "id" | "card_account_id">[],
  ): Promise<void> {
    const del = await this.db.from("instalment_plans").delete().eq("card_account_id", cardAccountId);
    if (del.error) throw new Error(`replaceInstalmentPlans delete: ${del.error.message}`);
    if (plans.length === 0) return;
    const ins = await this.db.from("instalment_plans").insert(
      plans.map((p) => ({
        card_account_id: cardAccountId,
        plan_name: p.plan_name,
        monthly_amount: rm(p.monthly_amount),
        total_months: p.total_months,
        months_elapsed: p.months_elapsed,
        principal_total: rm(p.principal_total),
        principal_outstanding: rm(p.principal_outstanding),
        projected_end_date: p.projected_end_date,
      })),
    );
    if (ins.error) throw new Error(`replaceInstalmentPlans insert: ${ins.error.message}`);
  }

  async listInstalmentPlans(): Promise<InstalmentPlanRow[]> {
    const r = await this.db.from("instalment_plans").select("*").order("id");
    return (need(r.data, r.error, "listInstalmentPlans") as Record<string, unknown>[]).map((d) => ({
      id: d.id as number,
      card_account_id: d.card_account_id as number,
      plan_name: d.plan_name as string,
      monthly_amount: senOrNull(d.monthly_amount),
      total_months: d.total_months as number,
      months_elapsed: d.months_elapsed as number,
      principal_total: senOrNull(d.principal_total),
      principal_outstanding: senOrNull(d.principal_outstanding),
      projected_end_date: (d.projected_end_date as string) ?? null,
    }));
  }

  async replacePaymentCycles(
    cardAccountId: number,
    cycles: Omit<PaymentCycleRow, "id" | "card_account_id">[],
  ): Promise<void> {
    const del = await this.db.from("payment_cycles").delete().eq("card_account_id", cardAccountId);
    if (del.error) throw new Error(`replacePaymentCycles delete: ${del.error.message}`);
    if (cycles.length === 0) return;
    const ins = await this.db.from("payment_cycles").insert(
      cycles.map((c) => ({
        card_account_id: cardAccountId,
        statement_id: c.statement_id,
        due_date: c.due_date,
        statement_balance: rm(c.statement_balance),
        minimum_due: rm(c.minimum_due),
        status: c.status,
        amount_paid: rm(c.amount_paid),
        paid_recorded_at: c.paid_recorded_at,
        auto_detected: c.auto_detected,
      })),
    );
    if (ins.error) throw new Error(`replacePaymentCycles insert: ${ins.error.message}`);
  }

  async listPaymentCycles(): Promise<PaymentCycleRow[]> {
    const r = await this.db.from("payment_cycles").select("*").order("id");
    return (need(r.data, r.error, "listPaymentCycles") as Record<string, unknown>[]).map((d) => ({
      id: d.id as number,
      card_account_id: d.card_account_id as number,
      statement_id: d.statement_id as number,
      due_date: (d.due_date as string) ?? null,
      statement_balance: senOf(d.statement_balance),
      minimum_due: senOrNull(d.minimum_due),
      status: d.status as PaymentCycleRow["status"],
      amount_paid: senOf(d.amount_paid),
      paid_recorded_at: (d.paid_recorded_at as string) ?? null,
      auto_detected: d.auto_detected as boolean,
    }));
  }

  async logRejection(row: Omit<RejectionRow, "id">): Promise<void> {
    const r = await this.db.from("upload_rejections").insert({
      filename: row.filename, file_hash: row.file_hash, reason: row.reason, detail: row.detail,
    });
    if (r.error) throw new Error(`logRejection: ${r.error.message}`);
  }

  async listRejections(): Promise<RejectionRow[]> {
    const r = await this.db.from("upload_rejections").select("id,filename,file_hash,reason,detail").order("id");
    return need(r.data, r.error, "listRejections") as RejectionRow[];
  }

  async logApiCost(row: Omit<ApiCostRow, "id">): Promise<void> {
    const r = await this.db.from("api_cost_log").insert({
      statement_filename: row.statement_filename,
      purpose: row.purpose,
      model: row.model,
      tokens_in: row.tokens_in,
      tokens_out: row.tokens_out,
      est_cost_usd: row.est_cost_usd,
      est_cost_rm: row.est_cost_rm,
    });
    if (r.error) throw new Error(`logApiCost: ${r.error.message}`);
  }

  async listApiCosts(): Promise<ApiCostRow[]> {
    const r = await this.db.from("api_cost_log").select("*").order("id");
    return (need(r.data, r.error, "listApiCosts") as Record<string, unknown>[]).map((d) => ({
      id: d.id as number,
      statement_filename: (d.statement_filename as string) ?? null,
      purpose: d.purpose as ApiCostRow["purpose"],
      model: d.model as string,
      tokens_in: d.tokens_in as number,
      tokens_out: d.tokens_out as number,
      est_cost_usd: Number(d.est_cost_usd),
      est_cost_rm: Number(d.est_cost_rm),
    }));
  }

  /** FR-1: store the original PDF for audit/reference; returns the storage path. */
  async storePdf(fileHash: string, filename: string, pdf: Buffer): Promise<string> {
    const bucket = "statements";
    const { data: buckets } = await this.db.storage.listBuckets();
    if (!buckets?.some((b) => b.name === bucket)) {
      const created = await this.db.storage.createBucket(bucket, { public: false });
      if (created.error) throw new Error(`createBucket: ${created.error.message}`);
    }
    const path = `${fileHash.slice(0, 16)}/${filename}`;
    const up = await this.db.storage.from(bucket).upload(path, pdf, {
      contentType: "application/pdf",
      upsert: true,
    });
    if (up.error) throw new Error(`storePdf: ${up.error.message}`);
    return `${bucket}/${path}`;
  }

  async setPdfStoragePath(statementId: number, storagePath: string): Promise<void> {
    const r = await this.db.from("statements").update({ pdf_storage_path: storagePath }).eq("id", statementId);
    if (r.error) throw new Error(`setPdfStoragePath: ${r.error.message}`);
  }
}
