import { db } from "@/db";
import {
  payrollDeductions, payrollReversals, payrollStatements, payrollStatementLines,
  payrollDeductionAudit, workers,
} from "@/db/schema";
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { accrualForWorker, currentMonth, paymentStatus, shiftMonth, workerAccruals, workerHistory,
  type PayrollDb, type WorkerAccrual } from "@/lib/payroll";
import { calculatePaye2026, type PayeAssessment, PAYE_RULE } from "@/lib/nigerian-paye";
import type { SessionUser } from "@/lib/authz";

export const BUILTIN_DEDUCTIONS = [
  { code: "STATUTORY_TAX", name: "Statutory PAYE (2026)", kind: "TAX" },
  { code: "HOUSE_RENT", name: "House rent", kind: "COMPANY" },
  { code: "COOPERATIVE", name: "Cooperative savings", kind: "COOPERATIVE" },
  { code: "ABSENCE", name: "Unpaid absence / leave", kind: "ATTENDANCE" },
  { code: "DAMAGE", name: "Approved garment damage", kind: "DAMAGE" },
  { code: "STAFF_OCCASION", name: "Staff occasion contribution", kind: "COMPANY" },
] as const;
export const ATTENDANCE_STATUSES = ["PRESENT", "UNAUTHORIZED_ABSENCE", "UNPAID_LEAVE", "APPROVED_LEAVE", "PAID_LEAVE", "OTHER"] as const;
export type Deduction = typeof payrollDeductions.$inferSelect;
export type Reversal = typeof payrollReversals.$inferSelect;
export type Statement = typeof payrollStatements.$inferSelect;
export type StatementLine = typeof payrollStatementLines.$inferSelect;
export type DeductionItem = {
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

export class PayrollError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function assertMonth(value: unknown): string {
  const month = String(value ?? "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new PayrollError("Use a valid payroll month (YYYY-MM).", 400);
  return month;
}
export function requiredOrganization(session: SessionUser): number {
  if (!session.organizationId) throw new PayrollError("Your Owner account needs an organisation before managing payroll.", 403);
  return session.organizationId;
}
export function safeId(value: unknown, name = "record"): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new PayrollError(`Choose a valid ${name}.`);
  return id;
}
export function money(value: unknown, label: string, allowZero = false): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < (allowZero ? 0 : 1) || amount > 2_000_000_000)
    throw new PayrollError(`${label} must be ${allowZero ? "a non-negative" : "a positive"} whole naira amount up to ₦2,000,000,000.`);
  return amount;
}
export function shortText(value: unknown, label: string, min = 1, max = 500): string {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max)
    throw new PayrollError(`${label} must contain ${min}–${max} characters.`);
  return value.trim();
}

export function monthOffset(start: string, target: string) {
  const [sy, sm] = start.split("-").map(Number);
  const [ty, tm] = target.split("-").map(Number);
  return (ty - sy) * 12 + tm - sm;
}
export function appliesInMonth(record: Pick<Deduction, "status" | "startMonth" | "endMonth" | "frequencyMonths">, month: string) {
  if (record.status !== "APPROVED" || month < record.startMonth || (record.endMonth && month > record.endMonth)) return false;
  const offset = monthOffset(record.startMonth, month);
  return record.frequencyMonths === 0 ? offset === 0 : offset % record.frequencyMonths === 0;
}

/** Preview on the same APPROVED only inputs the posting transaction will use.
 * Missing attendance days, rejected output, drafts or unauthorised proposals do
 * not produce lines. Support allocation is already in accrual.due; never deduct
 * it twice or treat it as an ordinary company/company-revenue deduction. */
export function calculateDeduction(base: WorkerAccrual, d: Deduction, month: string): DeductionItem {
  const basisAmount = d.basis === "SALARY" ? base.salary : base.due;
  let amount: number;
  let calculation: string;
  switch (d.method) {
    case "FIXED":
    case "VARIABLE":
      amount = d.amount!;
      calculation = `${d.method}: ₦${amount} approved for ${month}`;
      break;
    case "PERCENT":
      amount = Math.round(basisAmount * d.rateBps! / 10_000);
      calculation = `${d.rateBps! / 100}% × ₦${basisAmount} ${d.basis === "SALARY" ? "salary" : "approved pay after support allocation"}; rounded to the nearest naira`;
      break;
    case "ATTENDANCE":
      amount = Math.round(base.salary / d.workingDays!);
      calculation = `One explicitly recorded ${d.description} day: ₦${base.salary} salary ÷ ${d.workingDays} policy working days; rounded to the nearest naira`;
      break;
    case "PAYE_2026": {
      if (!month.startsWith("2026-")) throw new PayrollError("2026 PAYE cannot be applied outside the reviewed 2026 tax year.", 409);
      const assessment: PayeAssessment = {
        annualGross: d.annualGross!, annualPension: d.annualPension ?? 0,
        annualNhf: d.annualNhf ?? 0, annualNhis: d.annualNhis ?? 0,
        annualRentPaid: d.annualRentPaid ?? 0, annualOtherRelief: d.annualOtherRelief ?? 0,
        minimumWageExempt: d.minimumWageExempt,
      };
      const tax = calculatePaye2026(assessment);
      amount = tax.monthlyTax;
      calculation = `${PAYE_RULE}; annual gross ₦${tax.annualGross}; eligible relief ₦${tax.reliefs} (including rent ₦${tax.rentRelief}); chargeable ₦${tax.chargeableIncome}; annual tax ₦${tax.annualTax}; monthly rounded ₦${amount}${tax.minimumWageExempt ? "; documented minimum-wage exemption" : ""}`;
      break;
    }
    default: throw new PayrollError("Unknown deduction calculation method.", 409);
  }
  if (!Number.isSafeInteger(amount) || amount < 0) throw new PayrollError("Invalid calculated deduction.", 409);
  return {
    id: d.id, deductionId: d.id, reversalId: null,
    categoryCode: d.categoryCode, categoryName: d.categoryName,
    method: d.method, description: d.description,
    basisAmount, amount, calculation,
    cooperativeCredit: d.categoryCode === "COOPERATIVE" ? amount : 0,
  };
}

export function calculatePreview(base: WorkerAccrual, deductions: Deduction[], reversals: { reversal: Reversal; source: StatementLine }[], month: string) {
  const items: DeductionItem[] = [];
  const issues: string[] = [];
  for (const d of deductions) {
    if (!appliesInMonth(d, month)) continue;
    try { items.push(calculateDeduction(base, d, month)); }
    catch (error) { issues.push(error instanceof Error ? error.message : "Invalid deduction"); }
  }
  for (const { reversal, source } of reversals) {
    if (reversal.status !== "APPROVED" || reversal.targetMonth !== month) continue;
    items.push({
      id: -reversal.id, deductionId: null, reversalId: reversal.id,
      categoryCode: source.categoryCode, categoryName: `${source.categoryName} (refund)`,
      method: "REVERSAL", description: reversal.reason, basisAmount: source.amount,
      amount: -reversal.amount,
      cooperativeCredit: source.categoryCode === "COOPERATIVE" ? -reversal.amount : 0,
      calculation: `Full refund of posted line ${source.id} from a prior month`,
    });
  }
  const positive = items.reduce((sum, line) => sum + Math.max(0, line.amount), 0);
  const taxDeduction = items.filter((line) => line.categoryCode === "STATUTORY_TAX").reduce((sum, line) => sum + line.amount, 0);
  const companyDeductions = items.reduce((sum, line) => sum + line.amount, 0) - taxDeduction;
  // Section 5(7) Labour Act: conservative ceiling across statutory + company
  // deductions, excluding the pre-existing distribution of a garment's piece
  // rate to its support worker. Do not silently truncate/skip a real obligation.
  const wage = Math.max(0, base.due);
  if (positive > wage) issues.push(`₦${positive} in deductions exceeds the worker's ₦${wage} earned pay for this period.`);
  if (positive > Math.floor(wage / 3))
    issues.push(`₦${positive} exceeds the conservative one-third-of-earned-wages ceiling of ₦${Math.floor(wage / 3)}. Review the authorisations or reschedule.`);
  if (base.paid > 0 && items.length > 0)
    issues.push("Cash was already paid for this period. Do not retroactively post deductions or overwrite a payment.");
  return { items, issues, taxDeduction, companyDeductions, net: base.due - taxDeduction - companyDeductions };
}

export type PayrollView = WorkerAccrual & {
  gross: number;
  deductionItems: DeductionItem[];
  payrollDeductions: number;
  taxDeduction: number;
  totalDeductions: number;
  previewIssues: string[];
  finalized: boolean;
  mustPost: boolean;
  statementId: number | null;
  postedAt: Date | null;
};

function gross(base: WorkerAccrual) {
  return base.piecework + base.supportPiecework + base.salary + base.overtime + base.other;
}

export function applyDeductionView(base: WorkerAccrual, deductions: Deduction[],
  reversals: { reversal: Reversal; source: StatementLine }[],
  statement?: Statement, booked: StatementLine[] = []): PayrollView {
  if (statement) {
    // Every financial field comes from the immutable snapshot. `paid` is still
    // the sum of the independent append-only cash payments, not frozen here.
    const due = statement.net;
    return {
      ...base, piecework: statement.piecework, supportPiecework: statement.supportPiecework,
      salary: statement.salary, overtime: statement.overtime, other: statement.other,
      name: statement.workerName, department: statement.department,
      rate: statement.rate, paymentType: statement.paymentType, pieces: statement.pieces,
      supportPieces: statement.supportPieces, supportPiecesDelegated: statement.supportPiecesDelegated,
      supportDeduction: statement.supportDeduction, supportDeductionOwed: statement.supportDeductionOwed,
      gross: statement.gross, due, paid: base.paid, balance: due - base.paid,
      paymentStatus: paymentStatus(due, base.paid),
      deductionItems: booked.map((line) => ({ ...line, id: line.id })),
      payrollDeductions: statement.companyDeductions + statement.taxDeduction,
      taxDeduction: statement.taxDeduction,
      totalDeductions: statement.supportDeduction + statement.companyDeductions + statement.taxDeduction,
      finalized: true, mustPost: false, previewIssues: [],
      statementId: statement.id, postedAt: statement.postedAt,
    };
  }
  const preview = calculatePreview(base, deductions, reversals, base.month);
  // Invalid previews do not silently lower a worker's shown pay; payment is
  // blocked separately until the Owner resolves/declines the proposal.
  const due = preview.issues.length ? base.due : preview.net;
  return {
    ...base, gross: gross(base), due, balance: due - base.paid,
    paymentStatus: paymentStatus(due, base.paid),
    deductionItems: preview.items,
    payrollDeductions: preview.issues.length ? 0 : preview.companyDeductions + preview.taxDeduction,
    taxDeduction: preview.issues.length ? 0 : preview.taxDeduction,
    totalDeductions: base.supportDeduction + (preview.issues.length ? 0 : preview.companyDeductions + preview.taxDeduction),
    previewIssues: preview.issues, finalized: false,
    mustPost: preview.items.length > 0 || preview.issues.length > 0,
    statementId: null, postedAt: null,
  };
}

/** All relevant rows are bounded in SQL by organisation and month range. One
 * grouped read per relation rather than fetching the full payroll tables into a
 * browser. A 12-month personal history reuses this same path. */
async function periodInputs(handle: PayrollDb, organizationId: number, from: string, to: string, workerId?: number) {
  const scope = workerId === undefined ? undefined : eq(payrollDeductions.workerId, workerId);
  const [deductions, statements, reversalRows] = await Promise.all([
    handle.select().from(payrollDeductions).where(and(
      eq(payrollDeductions.organizationId, organizationId), eq(payrollDeductions.status, "APPROVED"),
      lte(payrollDeductions.startMonth, to),
      or(isNull(payrollDeductions.endMonth), gte(payrollDeductions.endMonth, from)), scope,
    )),
    handle.select().from(payrollStatements).where(and(
      eq(payrollStatements.organizationId, organizationId),
      gte(payrollStatements.periodMonth, from), lte(payrollStatements.periodMonth, to),
      workerId === undefined ? undefined : eq(payrollStatements.workerId, workerId),
    )),
    handle.select({ reversal: payrollReversals, source: payrollStatementLines }).from(payrollReversals)
      .innerJoin(payrollStatementLines, eq(payrollStatementLines.id, payrollReversals.sourceLineId))
      .where(and(eq(payrollReversals.organizationId, organizationId), eq(payrollReversals.status, "APPROVED"),
        gte(payrollReversals.targetMonth, from), lte(payrollReversals.targetMonth, to),
        workerId === undefined ? undefined : eq(payrollReversals.workerId, workerId))),
  ]);
  const booked = statements.length ? await handle.select().from(payrollStatementLines)
    .where(inArray(payrollStatementLines.statementId, statements.map((s) => s.id))) : [];
  return { deductions, statements, reversals: reversalRows, booked };
}

export async function getPayrollSummary(organizationId: number, month: string) {
  const { workers: base, breakdown: oldBreakdown } = await workerAccruals(month, organizationId);
  const { deductions, reversals, statements, booked } = await periodInputs(db, organizationId, month, month);
  const byWorker = new Map<number, Deduction[]>();
  const refundsByWorker = new Map<number, typeof reversals>();
  const statementByWorker = new Map(statements.map((s) => [s.workerId, s]));
  const linesByStatement = new Map<number, StatementLine[]>();
  for (const d of deductions) byWorker.set(d.workerId, [...(byWorker.get(d.workerId) ?? []), d]);
  for (const r of reversals) refundsByWorker.set(r.reversal.workerId,
    [...(refundsByWorker.get(r.reversal.workerId) ?? []), r]);
  for (const line of booked) linesByStatement.set(line.statementId,
    [...(linesByStatement.get(line.statementId) ?? []), line]);
  const rows = base.map((row) => {
    const statement = statementByWorker.get(row.workerId);
    return applyDeductionView(row, byWorker.get(row.workerId) ?? [], refundsByWorker.get(row.workerId) ?? [],
      statement, statement ? linesByStatement.get(statement.id) ?? [] : []);
  }).sort((a, b) => b.due - a.due);
  const totals = rows.reduce((t, r) => ({ due: t.due + r.due, paid: t.paid + r.paid, balance: t.balance + r.balance }), { due: 0, paid: 0, balance: 0 });
  const breakdown = {
    ...oldBreakdown,
    supportDeduction: rows.reduce((t, r) => t + r.supportDeduction, 0),
    gross: rows.reduce((t, r) => t + r.gross, 0),
    taxDeduction: rows.reduce((t, r) => t + r.taxDeduction, 0),
    payrollDeductions: rows.reduce((t, r) => t + r.payrollDeductions, 0),
    totalDeductions: rows.reduce((t, r) => t + r.totalDeductions, 0),
  };
  return { workers: rows, totals, breakdown };
}

export async function getPayrollHistory(organizationId: number, workerId: number, month: string) {
  const original = await workerHistory(workerId, month);
  if (!original.history.length) return original;
  const from = original.history[0].month;
  const { deductions, reversals, statements, booked } = await periodInputs(db, organizationId, from, month, workerId);
  return {
    ...original,
    history: original.history.map((row) => {
      const statement = statements.find((s) => s.periodMonth === row.month);
      return applyDeductionView(row, deductions, reversals, statement,
        booked.filter((line) => line.statementId === statement?.id));
    }),
  };
}

/** SERIALISATION CONTRACT: all three routes that can change a worker's pay
 * (approve, post, settle cash) take this row lock inside their transaction,
 * in that order. A race between approval and payment therefore cannot quietly
 * create a retroactive deduction. PostgreSQL enforces the unique statement and
 * booked-line constraints as a second line of defence. pg-mem cannot prove
 * real concurrent transaction isolation; verify with PostgreSQL before go-live. */
export async function lockPayrollWorker(handle: PayrollDb, organizationId: number, workerId: number) {
  const [person] = await handle.select({ id: workers.id, name: workers.name, status: workers.status })
    .from(workers).where(and(eq(workers.id, workerId), eq(workers.organizationId, organizationId))).for("update").limit(1);
  if (!person) throw new PayrollError("Worker not found in your organisation.", 404);
  return person;
}

export async function auditPayroll(handle: PayrollDb, actor: SessionUser, entityType: string, entityId: number,
  action: string, reason: string, before?: unknown, after?: unknown) {
  const organizationId = requiredOrganization(actor);
  await handle.insert(payrollDeductionAudit).values({
    organizationId, entityType, entityId, action, reason,
    before: before === undefined ? null : JSON.stringify(before),
    after: after === undefined ? null : JSON.stringify(after),
    actorId: actor.id, actorName: actor.name,
  });
}

/** Posting is the ONLY place a deduction and a cooperative credit become real.
 * It is impossible to post an open month or one with existing cash settlements.
 * All reads, validation and inserts use ONE transaction/worker row lock. */
export async function postPayroll(actor: SessionUser, workerId: number, month: string) {
  const organizationId = requiredOrganization(actor);
  if (month >= currentMonth()) throw new PayrollError("Only a completed payroll month can be posted. Preview this month now; post it after month end.", 409);
  return db.transaction(async (tx) => {
    await lockPayrollWorker(tx, organizationId, workerId);
    const [existing] = await tx.select({ id: payrollStatements.id }).from(payrollStatements)
      .where(and(eq(payrollStatements.workerId, workerId), eq(payrollStatements.periodMonth, month))).limit(1);
    if (existing) throw new PayrollError("This worker's payroll period is already posted. Historical statements cannot be overwritten.", 409);
    const base = await accrualForWorker(workerId, month, tx);
    if (!base) throw new PayrollError("Worker not found.", 404);
    if (base.paid > 0)
      throw new PayrollError("This worker already received cash for this month. Do not retroactively post or restate a paid period.", 409);
    const inputs = await periodInputs(tx, organizationId, month, month, workerId);
    const preview = calculatePreview(base, inputs.deductions, inputs.reversals, month);
    if (preview.issues.length) throw new PayrollError(preview.issues.join(" "), 409);
    const [statement] = await tx.insert(payrollStatements).values({
      organizationId, workerId, workerName: base.name, department: base.department,
      periodMonth: month, paymentType: base.paymentType, rate: base.rate,
      pieces: base.pieces, supportPieces: base.supportPieces, supportPiecesDelegated: base.supportPiecesDelegated,
      supportDeductionOwed: base.supportDeductionOwed, piecework: base.piecework,
      supportPiecework: base.supportPiecework, salary: base.salary, overtime: base.overtime, other: base.other,
      gross: gross(base), supportDeduction: base.supportDeduction,
      taxDeduction: preview.taxDeduction, companyDeductions: preview.companyDeductions, net: preview.net,
      postedById: actor.id, postedByName: actor.name,
    }).returning();
    if (preview.items.length) await tx.insert(payrollStatementLines).values(preview.items.map((item) => ({
      statementId: statement.id, deductionId: item.deductionId, reversalId: item.reversalId,
      categoryCode: item.categoryCode, categoryName: item.categoryName,
      method: item.method, description: item.description, basisAmount: item.basisAmount,
      amount: item.amount, cooperativeCredit: item.cooperativeCredit, calculation: item.calculation,
    })));
    await auditPayroll(tx, actor, "STATEMENT", statement.id, "POST", `Posted ${month}; gross ₦${gross(base)}, support allocation ₦${base.supportDeduction}, PAYE ₦${preview.taxDeduction}, other deductions ₦${preview.companyDeductions}, net ₦${preview.net}.`,
      undefined, { workerId, month, lineIds: preview.items.map((l) => l.deductionId ?? `reversal:${l.reversalId}`) });
    return { statement, lines: preview.items };
  });
}

/** Validate that an intended deduction cannot edit an existing settlement or
 * finalized statement. Used under the same worker lock by the approval path. */
export async function assertUnsettled(handle: PayrollDb, workerId: number, month: string) {
  const [statement] = await handle.select({ id: payrollStatements.id }).from(payrollStatements)
    .where(and(eq(payrollStatements.workerId, workerId), eq(payrollStatements.periodMonth, month))).limit(1);
  if (statement) throw new PayrollError(`Payroll for ${month} is already posted; it cannot be changed.`, 409);
  // Payment rows from the existing payroll system cannot be retroactively
  // reduced. Only the specific month being activated is inspected.
  const { workerPayments } = await import("@/db/schema");
  const [paid] = await handle.select({ id: workerPayments.id }).from(workerPayments)
    .where(and(eq(workerPayments.workerId, workerId), eq(workerPayments.periodMonth, month))).limit(1);
  if (paid) throw new PayrollError(`Money has already been paid for ${month}; deductions cannot be added retroactively.`, 409);
}

/** Lightweight check for the cash-settlement route (under the worker lock). */
export async function unpostedApproved(handle: PayrollDb, organizationId: number, workerId: number, month: string) {
  const { deductions, reversals } = await periodInputs(handle, organizationId, month, month, workerId);
  return deductions.some((d) => appliesInMonth(d, month)) || reversals.length > 0;
}

export function previousOpenMonth() { return shiftMonth(currentMonth(), -1); }
