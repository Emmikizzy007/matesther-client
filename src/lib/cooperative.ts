/**
 * Workers' cooperative savings fund.
 *
 * ONE LEDGER, COMPUTED — NEVER STORED
 *   The contribution side of the fund is exactly the existing posted
 *   `payroll_statement_lines.cooperative_credit` ledger (negative on an
 *   approved refund line). Withdrawals and authorised adjustments are the two
 *   new append-only sides of the SAME fund:
 *
 *     balance = posted credits − PAID withdrawals + APPROVED adjustments
 *
 *   Nothing here writes a mutable balance row, so the company-wide total is
 *   always the sum of the individual worker balances by construction. These
 *   savings belong to the workers: they are never company revenue or expense,
 *   and nothing in this module touches orders, expenses or production costs.
 *
 *   A REQUESTED or APPROVED withdrawal moves NO money. Only the row whose
 *   status is PAID — the actual cash/bank payment, recorded with its date,
 *   method and reference — reduces the fund.
 */
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  payrollCooperativeAdjustments,
  payrollCooperativeWithdrawals,
  payrollStatementLines,
  payrollStatements,
  workers,
} from "@/db/schema";
import { PayrollError } from "@/lib/payroll-deductions";
import type { PayrollDb } from "@/lib/payroll";

export type CooperativeTotals = {
  /** Posted contributions, including negative refund lines. */
  contributions: number;
  /** Completed, recorded payments out of the fund. */
  withdrawals: number;
  /** Approved signed corrections to the fund. */
  adjustments: number;
  /** What the workers' fund actually holds right now. */
  balance: number;
  /** Approved but not yet paid withdrawal promises. */
  reserved: number;
  /** Requested but not yet decided or paid. */
  pending: number;
  /** balance − reserved − pending: what a new request may ask for. */
  available: number;
};

const num = (value: unknown) => Number(value ?? 0);

/** Fund position for one worker, or for the whole organisation when workerId
 * is omitted. Bounded aggregate SQL only — no table scans into the browser. */
export async function cooperativeTotals(
  handle: PayrollDb,
  organizationId: number,
  workerId?: number,
): Promise<CooperativeTotals> {
  const scope: SQL | undefined = workerId === undefined
    ? eq(payrollStatements.organizationId, organizationId)
    : and(eq(payrollStatements.organizationId, organizationId), eq(payrollStatements.workerId, workerId));
  const withdrawalScope: SQL | undefined = workerId === undefined
    ? eq(payrollCooperativeWithdrawals.organizationId, organizationId)
    : and(eq(payrollCooperativeWithdrawals.organizationId, organizationId),
        eq(payrollCooperativeWithdrawals.workerId, workerId));
  const adjustmentScope: SQL | undefined = workerId === undefined
    ? eq(payrollCooperativeAdjustments.organizationId, organizationId)
    : and(eq(payrollCooperativeAdjustments.organizationId, organizationId),
        eq(payrollCooperativeAdjustments.workerId, workerId));
  const [credit] = await handle
    .select({ sum: sql<number>`coalesce(sum(${payrollStatementLines.cooperativeCredit}), 0)` })
    .from(payrollStatementLines)
    .innerJoin(payrollStatements, eq(payrollStatements.id, payrollStatementLines.statementId))
    .where(scope);
  const [paid] = await handle
    .select({ sum: sql<number>`coalesce(sum(${payrollCooperativeWithdrawals.amount}), 0)` })
    .from(payrollCooperativeWithdrawals)
    .where(and(withdrawalScope, eq(payrollCooperativeWithdrawals.status, "PAID")));
  const [reserved] = await handle
    .select({ sum: sql<number>`coalesce(sum(${payrollCooperativeWithdrawals.amount}), 0)` })
    .from(payrollCooperativeWithdrawals)
    .where(and(withdrawalScope, eq(payrollCooperativeWithdrawals.status, "APPROVED")));
  const [pending] = await handle
    .select({ sum: sql<number>`coalesce(sum(${payrollCooperativeWithdrawals.amount}), 0)` })
    .from(payrollCooperativeWithdrawals)
    .where(and(withdrawalScope, eq(payrollCooperativeWithdrawals.status, "REQUESTED")));
  const [adjustment] = await handle
    .select({ sum: sql<number>`coalesce(sum(${payrollCooperativeAdjustments.amount}), 0)` })
    .from(payrollCooperativeAdjustments)
    .where(and(adjustmentScope, eq(payrollCooperativeAdjustments.status, "APPROVED")));
  const contributions = num(credit?.sum);
  const withdrawals = num(paid?.sum);
  const adjustments = num(adjustment?.sum);
  const balance = contributions - withdrawals + adjustments;
  return {
    contributions,
    withdrawals,
    adjustments,
    balance,
    reserved: num(reserved?.sum),
    pending: num(pending?.sum),
    available: balance - num(reserved?.sum) - num(pending?.sum),
  };
}

/**
 * Outstanding promises (REQUESTED + APPROVED) that are not `exceptId`'s own
 * row. Every gate — request, approval, payment — asks whether the fund can
 * still cover the row AFTER the rest of the outstanding promises, which is
 * what stops two concurrent requests from spending the same naira twice.
 */
export async function outstandingExcept(handle: PayrollDb, organizationId: number, workerId: number, exceptId: number) {
  const [row] = await handle
    .select({ sum: sql<number>`coalesce(sum(${payrollCooperativeWithdrawals.amount}), 0)` })
    .from(payrollCooperativeWithdrawals)
    .where(and(
      eq(payrollCooperativeWithdrawals.organizationId, organizationId),
      eq(payrollCooperativeWithdrawals.workerId, workerId),
      sql`${payrollCooperativeWithdrawals.status} in ('REQUESTED','APPROVED')`,
      sql`${payrollCooperativeWithdrawals.id} <> ${exceptId}`,
    ));
  return num(row?.sum);
}

export function assertCovered(amount: number, totals: CooperativeTotals, outstandingOther: number, when: string) {
  const available = totals.balance - outstandingOther;
  if (amount > available)
    throw new PayrollError(
      `Insufficient cooperative balance for this ${when}: ₦${amount} requested, ₦${Math.max(0, available)} available ` +
      `(balance ₦${totals.balance} less other outstanding requests).`,
      409,
    );
}

export type FundEntry = {
  kind: "CONTRIBUTION" | "WITHDRAWAL" | "ADJUSTMENT";
  at: Date;
  reference: string;
  /** Signed movement of the fund. */
  amount: number;
  description: string;
  detail: string;
  /** Back-compat shape: every entry exposes `line.cooperativeCredit`. */
  line: {
    id: number;
    deductionId: number | null;
    reversalId: number | null;
    categoryCode: string;
    categoryName: string;
    method: string;
    description: string;
    basisAmount: number;
    amount: number;
    cooperativeCredit: number;
    calculation: string;
  };
  periodMonth: string | null;
  postedAt: Date | null;
  workerName: string | null;
  status: string | null;
  paymentMethod?: string | null;
};

/** Full worker fund history in one chronological list, each row carrying the
 * fund balance AFTER that transaction. Posted lines, paid withdrawals and
 * approved adjustments are merged; anything that moved no money never appears
 * here as a movement. */
export async function cooperativeHistory(handle: PayrollDb, organizationId: number, workerId: number, limit = 50, offset = 0) {
  const [member] = await handle
    .select({ id: workers.id, name: workers.name, department: workers.department })
    .from(workers)
    .where(and(eq(workers.id, workerId), eq(workers.organizationId, organizationId)))
    .limit(1);
  if (!member) throw new PayrollError("Member not found in your organisation.", 404);
  const [lines, withdrawals, adjustments, totals] = await Promise.all([
    handle
      .select({
        line: payrollStatementLines,
        periodMonth: payrollStatements.periodMonth,
        postedAt: payrollStatements.postedAt,
        workerName: payrollStatements.workerName,
      })
      .from(payrollStatementLines)
      .innerJoin(payrollStatements, eq(payrollStatements.id, payrollStatementLines.statementId))
      .where(and(
        eq(payrollStatements.organizationId, organizationId),
        eq(payrollStatements.workerId, workerId),
        eq(payrollStatementLines.categoryCode, "COOPERATIVE"),
      ))
      .orderBy(desc(payrollStatements.periodMonth), desc(payrollStatementLines.id))
      .limit(500),
    handle.select().from(payrollCooperativeWithdrawals).where(and(
      eq(payrollCooperativeWithdrawals.organizationId, organizationId),
      eq(payrollCooperativeWithdrawals.workerId, workerId),
      eq(payrollCooperativeWithdrawals.status, "PAID"),
    )).orderBy(desc(payrollCooperativeWithdrawals.paidAt)).limit(500),
    handle.select().from(payrollCooperativeAdjustments).where(and(
      eq(payrollCooperativeAdjustments.organizationId, organizationId),
      eq(payrollCooperativeAdjustments.workerId, workerId),
      eq(payrollCooperativeAdjustments.status, "APPROVED"),
    )).orderBy(desc(payrollCooperativeAdjustments.approvedAt)).limit(500),
    cooperativeTotals(handle, organizationId, workerId),
  ]);

  const entries: FundEntry[] = [
    ...lines.map(({ line, periodMonth, postedAt, workerName }): FundEntry => ({
      kind: line.cooperativeCredit < 0 ? "ADJUSTMENT" : "CONTRIBUTION",
      at: postedAt,
      reference: `PAYROLL-${periodMonth}#${line.id}`,
      amount: line.cooperativeCredit,
      description: line.description,
      detail: line.calculation,
      line,
      periodMonth,
      postedAt,
      workerName,
      status: "POSTED",
    })),
    ...withdrawals.map((w): FundEntry => ({
      kind: "WITHDRAWAL",
      at: w.paidAt ?? w.requestedAt,
      reference: w.paymentReference || `WITHDRAWAL-${w.id}`,
      amount: -w.amount,
      description: `Cooperative withdrawal paid (${w.paymentMethod || "unspecified method"})`,
      detail: w.reason + (w.paymentNotes ? ` · ${w.paymentNotes}` : ""),
      line: {
        id: -w.id, deductionId: null, reversalId: null,
        categoryCode: "COOPERATIVE_WITHDRAWAL", categoryName: "Cooperative withdrawal",
        method: "PAID", description: w.reason, basisAmount: w.amount,
        amount: -w.amount, cooperativeCredit: -w.amount,
        calculation: `Paid ${w.paidOn ?? "—"}${w.paymentReference ? ` · ref ${w.paymentReference}` : ""}`,
      },
      periodMonth: (w.paidOn ?? "").slice(0, 7) || null,
      postedAt: w.paidAt,
      workerName: null,
      status: w.status,
      paymentMethod: w.paymentMethod,
    })),
    ...adjustments.map((a): FundEntry => ({
      kind: "ADJUSTMENT",
      at: a.approvedAt ?? a.createdAt,
      reference: a.reference || `ADJUSTMENT-${a.id}`,
      amount: a.amount,
      description: "Authorised cooperative adjustment",
      detail: a.reason + (a.decisionReason ? ` · ${a.decisionReason}` : ""),
      line: {
        id: -a.id, deductionId: null, reversalId: null,
        categoryCode: "COOPERATIVE_ADJUSTMENT", categoryName: "Cooperative adjustment",
        method: "APPROVED", description: a.reason, basisAmount: Math.abs(a.amount),
        amount: a.amount, cooperativeCredit: a.amount,
        calculation: a.amount > 0 ? "Credit to the worker's fund" : "Debit from the worker's fund",
      },
      periodMonth: (a.approvedAt ?? a.createdAt).toISOString().slice(0, 7),
      postedAt: a.approvedAt,
      workerName: null,
      status: a.status,
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime() || a.line.id - b.line.id);

  // Running balance AFTER each transaction, oldest first, then newest first
  // for display and server-side pagination.
  let running = 0;
  for (const entry of entries) {
    running += entry.amount;
    (entry as FundEntry & { balanceAfter: number }).balanceAfter = running;
  }
  entries.reverse();
  return {
    workerId,
    workerName: member.name,
    ...totals,
    total: entries.length,
    transactions: entries.slice(offset, offset + limit),
    limit,
    offset,
  };
}

export type MemberRow = {
  workerId: number;
  workerName: string;
  department: string | null;
  contributions: number;
  withdrawals: number;
  adjustments: number;
  balance: number;
};

/** Company-wide member fund list: a searchable ledger-derived view whose grand
 * total ALWAYS equals the sum of the individual balances it returns. */
export async function cooperativeMembers(
  handle: PayrollDb,
  organizationId: number,
  options: { search?: string; limit?: number; offset?: number } = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const search = (options.search ?? "").trim();
  const workerFilter = and(
    eq(workers.organizationId, organizationId),
    search
      ? or(
          ilike(workers.name, `%${search.replace(/[\\%_]/g, "\\$&")}%`),
          eq(workers.id, Number(search) || -1),
        )
      : undefined,
  );
  const [creditRows, withdrawalRows, adjustmentRows] = await Promise.all([
    handle
      .select({
        workerId: payrollStatements.workerId,
        workerName: sql<string>`max(${payrollStatements.workerName})`,
        department: sql<string | null>`max(${payrollStatements.department})`,
        contributions: sql<number>`coalesce(sum(${payrollStatementLines.cooperativeCredit}), 0)`,
      })
      .from(payrollStatementLines)
      .innerJoin(payrollStatements, eq(payrollStatements.id, payrollStatementLines.statementId))
      .innerJoin(workers, eq(workers.id, payrollStatements.workerId))
      .where(and(eq(payrollStatements.organizationId, organizationId), workerFilter))
      .groupBy(payrollStatements.workerId),
    handle
      .select({
        workerId: payrollCooperativeWithdrawals.workerId,
        withdrawals: sql<number>`coalesce(sum(${payrollCooperativeWithdrawals.amount}), 0)`,
      })
      .from(payrollCooperativeWithdrawals)
      .innerJoin(workers, eq(workers.id, payrollCooperativeWithdrawals.workerId))
      .where(and(eq(payrollCooperativeWithdrawals.organizationId, organizationId),
        eq(payrollCooperativeWithdrawals.status, "PAID"), workerFilter))
      .groupBy(payrollCooperativeWithdrawals.workerId),
    handle
      .select({
        workerId: payrollCooperativeAdjustments.workerId,
        adjustments: sql<number>`coalesce(sum(${payrollCooperativeAdjustments.amount}), 0)`,
      })
      .from(payrollCooperativeAdjustments)
      .innerJoin(workers, eq(workers.id, payrollCooperativeAdjustments.workerId))
      .where(and(eq(payrollCooperativeAdjustments.organizationId, organizationId),
        eq(payrollCooperativeAdjustments.status, "APPROVED"), workerFilter))
      .groupBy(payrollCooperativeAdjustments.workerId),
  ]);
  const byWorker = new Map<number, MemberRow>();
  const ensure = (workerId: number, workerName: string, department: string | null) => {
    const row = byWorker.get(workerId) ?? {
      workerId, workerName, department,
      contributions: 0, withdrawals: 0, adjustments: 0, balance: 0,
    };
    byWorker.set(workerId, row);
    return row;
  };
  for (const row of creditRows) {
    const entry = ensure(row.workerId, row.workerName, row.department);
    entry.contributions = num(row.contributions);
  }
  for (const row of withdrawalRows) {
    const entry = ensure(row.workerId, `Worker #${row.workerId}`, null);
    entry.withdrawals = num(row.withdrawals);
  }
  for (const row of adjustmentRows) {
    const entry = ensure(row.workerId, `Worker #${row.workerId}`, null);
    entry.adjustments = num(row.adjustments);
  }
  // Fill in the CURRENT name/department and make the arithmetic explicit.
  const ids = [...byWorker.keys()];
  if (ids.length) {
    const people = await handle
      .select({ id: workers.id, name: workers.name, department: workers.department })
      .from(workers)
      .where(and(eq(workers.organizationId, organizationId), inArray(workers.id, ids)));
    for (const person of people) {
      const entry = byWorker.get(person.id);
      if (entry) {
        entry.workerName = person.name;
        entry.department = person.department;
      }
    }
  }
  const rows = [...byWorker.values()]
    .map((row) => ({ ...row, balance: row.contributions - row.withdrawals + row.adjustments }))
    .sort((a, b) => b.balance - a.balance || a.workerName.localeCompare(b.workerName));
  const summary = rows.reduce(
    (totals, row) => ({
      totalHeld: totals.totalHeld + row.balance,
      totalContributions: totals.totalContributions + row.contributions,
      totalWithdrawals: totals.totalWithdrawals + row.withdrawals,
      totalAdjustments: totals.totalAdjustments + row.adjustments,
      participating: totals.participating + (row.contributions !== 0 || row.withdrawals !== 0 || row.adjustments !== 0 ? 1 : 0),
    }),
    { totalHeld: 0, totalContributions: 0, totalWithdrawals: 0, totalAdjustments: 0, participating: 0 },
  );
  return {
    ...summary,
    rows: rows.slice(offset, offset + limit),
    total: rows.length,
    limit,
    offset,
  };
}
