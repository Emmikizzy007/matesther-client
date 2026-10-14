import { NextResponse } from "next/server";
import { guard, getSessionUser, OWNER } from "@/lib/authz";
import { db } from "@/db";
import { workerPayments, workerOvertime, payrollStatements, workers } from "@/db/schema";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { currentMonth, shiftMonth, accrualForWorker } from "@/lib/payroll";
import { assertMonth, lockPayrollWorker, PayrollError, requiredOrganization, safeId, money,
  unpostedApproved, getPayrollHistory, getPayrollSummary } from "@/lib/payroll-deductions";
import { payrollFailure, PRIVATE_RESPONSE } from "@/lib/payroll-deduction-http";

/** Original approved-piece/salary/support rules stay in lib/payroll.ts.
 * This endpoint overlays approved PREVIEWS or immutable POSTED statements,
 * without subtracting from the earnings/inspection records. */
export async function GET(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const org = requiredOrganization(actor);
    const p = new URL(req.url).searchParams;
    const month = assertMonth(p.get("month") || currentMonth());
    if (p.has("workerId")) {
      const workerId = safeId(p.get("workerId"), "worker");
      const [worker] = await db.select().from(workers).where(and(
        eq(workers.id, workerId), eq(workers.organizationId, org))).limit(1);
      if (!worker) throw new PayrollError("Worker not found in your organisation.", 404);
      const { history, payments } = await getPayrollHistory(org, workerId, month);
      return NextResponse.json({ worker, month, history, payments }, { headers: PRIVATE_RESPONSE });
    }
    const { workers: rows, totals, breakdown } = await getPayrollSummary(org, month);
    const [payRows, otRows] = await Promise.all([
      db.select({ payment: workerPayments, workerName: workers.name }).from(workerPayments)
        .innerJoin(workers, eq(workers.id, workerPayments.workerId))
        .where(and(eq(workers.organizationId, org), eq(workerPayments.periodMonth, month)))
        .orderBy(desc(workerPayments.paymentDate), desc(workerPayments.id)),
      db.select({ overtime: workerOvertime, workerName: workers.name }).from(workerOvertime)
        .innerJoin(workers, eq(workers.id, workerOvertime.workerId))
        .where(and(eq(workers.organizationId, org), gte(workerOvertime.workedOn, `${month}-01`),
          lt(workerOvertime.workedOn, `${shiftMonth(month, 1)}-01`))),
    ]);
    return NextResponse.json({ month, workers: rows, totals, breakdown,
      payments: payRows.map(({ payment, workerName }) => ({ ...payment, workerName })),
      overtime: otRows.map(({ overtime, workerName }) => ({ ...overtime, workerName })),
    }, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}

/** Cash settlements remain append-only, with their existing idempotency key.
 * Now serialized against deduction approval/posting under the worker row lock.
 * For any POSTED period the sum paid may never exceed the snapshotted net.
 * For the legacy path (no proposed deductions), previous payment rules remain.
 */
export async function POST(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const org = requiredOrganization(actor);
    const b = await req.json();
    const workerId = safeId(b.workerId, "worker");
    if (b.kind === "overtime" || b.kind === "other") {
      const amount = money(b.amount, "Overtime / other earnings");
      const workedOn = typeof b.workedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.workedOn)
        ? b.workedOn : new Date().toISOString().slice(0, 10);
      if (Number.isNaN(new Date(`${workedOn}T00:00:00Z`).getTime()) ||
        new Date(`${workedOn}T00:00:00Z`).toISOString().slice(0, 10) !== workedOn)
        throw new PayrollError("Use a real work date.");
      const hours = b.hours === undefined ? 0 : Number(b.hours);
      if (!Number.isSafeInteger(hours) || hours < 0 || hours > 1_000_000)
        throw new PayrollError("Hours must be a non-negative whole number.");
      const category = b.kind === "other" || b.category === "OTHER" ? "OTHER" : "OVERTIME";
      const row = await db.transaction(async (tx) => {
        await lockPayrollWorker(tx, org, workerId);
        const [posted] = await tx.select({ id: payrollStatements.id }).from(payrollStatements)
          .where(and(eq(payrollStatements.workerId, workerId), eq(payrollStatements.periodMonth, workedOn.slice(0, 7)))).limit(1);
        if (posted) throw new PayrollError("This period was posted. Do not silently change its earnings snapshot.", 409);
        const [created] = await tx.insert(workerOvertime).values({
          workerId, workedOn, hours, amount, category,
          notes: b.notes ? String(b.notes).slice(0, 1000) : null,
        }).returning();
        return created;
      });
      return NextResponse.json(row, { status: 201 });
    }
    if (b.kind !== undefined && b.kind !== "payment") throw new PayrollError("Unknown payroll action.");
    const amount = money(b.amount, "Payment amount");
    const periodMonth = assertMonth(b.periodMonth || currentMonth());
    const paymentDate = typeof b.paymentDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.paymentDate)
      ? b.paymentDate : new Date().toISOString().slice(0, 10);
    if (Number.isNaN(new Date(`${paymentDate}T00:00:00Z`).getTime()) ||
      new Date(`${paymentDate}T00:00:00Z`).toISOString().slice(0, 10) !== paymentDate)
      throw new PayrollError("Use a real payment date.");
    const PARTS = ["pieceworkAmount", "supportAmount", "salaryAmount", "overtimeAmount", "otherAmount"] as const;
    const part = (key: (typeof PARTS)[number]) => b[key] === undefined ? 0 : money(b[key], key, true);
    const parts = Object.fromEntries(PARTS.map((key) => [key, part(key)])) as Record<(typeof PARTS)[number], number>;
    const itemised = PARTS.some((key) => b[key] !== undefined);
    const partsSum = PARTS.reduce((sum, key) => sum + parts[key], 0);
    if (itemised && partsSum !== amount) throw new PayrollError("The breakdown must add up to the total paid.");
    const idempotencyKey = b.idempotencyKey ? String(b.idempotencyKey).slice(0, 200) : null;
    const row = await db.transaction(async (tx) => {
      await lockPayrollWorker(tx, org, workerId);
      if (idempotencyKey) {
        const [existing] = await tx.select().from(workerPayments)
          .where(eq(workerPayments.idempotencyKey, idempotencyKey)).limit(1);
        if (existing) throw new PayrollError("This payment has already been recorded.", 409);
      }
      const [statement] = await tx.select().from(payrollStatements).where(and(
        eq(payrollStatements.workerId, workerId), eq(payrollStatements.periodMonth, periodMonth))).limit(1);
      if (!statement && await unpostedApproved(tx, org, workerId, periodMonth))
        throw new PayrollError("This worker has approved deductions/refunds. Post the completed month before recording a cash settlement.", 409);
      if (statement) {
        const base = await accrualForWorker(workerId, periodMonth, tx);
        if (!base || amount > statement.net - base.paid)
          throw new PayrollError("Payment would exceed the posted net amount still owed.", 409);
      }
      const [created] = await tx.insert(workerPayments).values({
        workerId, paymentDate, periodMonth, ...parts, amount,
        method: b.method ? String(b.method).slice(0, 100) : "Cash",
        paidBy: actor.name, // always server session; never body.paidBy
        reference: b.reference ? String(b.reference).slice(0, 200) : null,
        idempotencyKey, notes: b.notes ? String(b.notes).slice(0, 1000) : null,
      }).returning();
      return created;
    });
    return NextResponse.json(row, { status: 201 });
  } catch (error) { return payrollFailure(error); }
}
