// FR-6 instalment plan tracking (Phase 1 subset needed by the harness).
// Plan identity: card + plan name + total months + principal. Progression must
// be exactly prev NN + 1; a fresh 01/MM while a plan is mid-run is a NEW plan.
// Plans are recomputed from ALL stored statements so import order never matters.

import { DateTime } from "luxon";
import type { Store } from "./store.js";
import type { ExtractedInstalmentSummary, InstalmentPlanRow } from "./types.js";
import { toSen } from "./money.js";
import { parseInstalmentProgress } from "./typing.js";
import { ZONE } from "./dates.js";

interface Observation {
  statementDate: string;
  base: string;
  nn: number;
  mm: number;
  monthlyAmount: number; // sen
  summary: ExtractedInstalmentSummary | null;
}

export async function recomputeInstalmentPlans(store: Store, cardAccountId: number): Promise<void> {
  const statements = await store.listStatements();
  const stmtCards = (await store.listStatementCards()).filter(
    (sc) => sc.card_account_id === cardAccountId,
  );
  const txns = (await store.listTransactions()).filter(
    (t) => t.card_account_id === cardAccountId && t.txn_type === "instalment",
  );

  const observations: Observation[] = [];
  for (const t of txns) {
    const prog = parseInstalmentProgress(t.description_raw);
    if (!prog) continue;
    const sc = stmtCards.find((x) => x.id === t.statement_card_id);
    const st = sc ? statements.find((s) => s.id === sc.statement_id) : undefined;
    if (!sc || !st) continue;
    const summaries: ExtractedInstalmentSummary[] = sc.instalment_summaries_json
      ? JSON.parse(sc.instalment_summaries_json)
      : [];
    const summary =
      summaries.find(
        (s) =>
          s.plan_name.toUpperCase().includes(prog.base.toUpperCase()) ||
          prog.base.toUpperCase().includes(s.plan_name.toUpperCase()) ||
          (s.monthly_amount_rm != null && toSen(s.monthly_amount_rm) === t.amount),
      ) ?? (summaries.length === 1 ? summaries[0]! : null);
    observations.push({
      statementDate: st.statement_date,
      base: prog.base.toUpperCase(),
      nn: prog.nn,
      mm: prog.mm,
      monthlyAmount: t.amount,
      summary,
    });
  }

  // Group by (base, mm, principal) then split into runs of consecutive NN —
  // each run is one plan instance (buying the same product again restarts at 01).
  const groups = new Map<string, Observation[]>();
  for (const o of observations) {
    const principal = o.summary?.principal_rm != null ? toSen(o.summary.principal_rm) : "?";
    const key = `${o.base}|${o.mm}|${principal}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(o);
  }

  const plans: Omit<InstalmentPlanRow, "id" | "card_account_id">[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.nn - b.nn || a.statementDate.localeCompare(b.statementDate));
    const runs: Observation[][] = [];
    for (const o of list) {
      const current = runs[runs.length - 1];
      if (current && o.nn === current[current.length - 1]!.nn + 1) {
        current.push(o);
      } else if (current && o.nn === current[current.length - 1]!.nn) {
        // duplicate observation of the same month (should not happen; keep latest)
        current[current.length - 1] = o;
      } else {
        runs.push([o]);
      }
    }
    for (const run of runs) {
      const latest = run[run.length - 1]!;
      const monthsRemaining = latest.mm - latest.nn;
      const projectedEnd = DateTime.fromISO(latest.statementDate, { zone: ZONE })
        .plus({ months: monthsRemaining })
        .toISODate();
      plans.push({
        plan_name: latest.base,
        monthly_amount: latest.monthlyAmount,
        total_months: latest.mm,
        months_elapsed: latest.nn,
        principal_total: latest.summary?.principal_rm != null ? toSen(latest.summary.principal_rm) : null,
        principal_outstanding:
          latest.summary?.outstanding_principal_rm != null
            ? toSen(latest.summary.outstanding_principal_rm)
            : null,
        projected_end_date: projectedEnd,
      });
    }
  }

  await store.replaceInstalmentPlans(cardAccountId, plans);
}
