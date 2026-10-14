import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { payrollCooperativeWithdrawals, workers } from "@/db/schema";
import { guard, getSessionUser, OWNER, type SessionUser } from "@/lib/authz";
import {
  PayrollError, auditPayroll, lockPayrollWorker, money, requiredOrganization, safeId, shortText,
} from "@/lib/payroll-deductions";
import { payrollFailure, PRIVATE_RESPONSE } from "@/lib/payroll-deduction-http";
import { assertCovered, cooperativeTotals, outstandingExcept } from "@/lib/cooperative";

const METHODS = ["Cash", "Bank Transfer", "POS", "Other"];

function day(value: unknown, label: string, allowFuture = false) {
  const date = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new PayrollError(`${label} must be a real YYYY-MM-DD date.`);
  const parsed = new Date(`${date}T00:00:00Z`);
  const today = new Date().toISOString().slice(0, 10);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ||
    (!allowFuture && date > today))
    throw new PayrollError(`${label} must be a real date${allowFuture ? "" : ", not in the future"}.`);
  return date;
}

/**
 * Workers' cooperative withdrawals: request → review → approve/reject → record
 * the actual payment.
 *
 * Money NEVER moves on a request or an approval. The fund balance only falls
 * when the completed cash/bank payment is recorded (status PAID), and every
 * gate re-checks the computed balance under the payroll worker lock so two
 * concurrent requests cannot spend the same naira twice. The requester can
 * neither approve their own request nor record its payment.
 */
export async function GET(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const org = requiredOrganization(actor);
    const p = new URL(req.url).searchParams;
    const limit = p.has("limit") ? Number(p.get("limit")) : 50;
    const offset = p.has("offset") ? Number(p.get("offset")) : 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000)
      throw new PayrollError("Use limit 1–100 and a non-negative offset.");
    const workerId = p.has("workerId") ? safeId(p.get("workerId"), "worker") : null;
    const status = p.get("status");
    if (status && !["REQUESTED", "APPROVED", "REJECTED", "CANCELLED", "PAID"].includes(status))
      throw new PayrollError("Unknown withdrawal status.");
    const filter = and(eq(payrollCooperativeWithdrawals.organizationId, org),
      workerId ? eq(payrollCooperativeWithdrawals.workerId, workerId) : undefined,
      status ? eq(payrollCooperativeWithdrawals.status, status) : undefined);
    const [rows, count, totals] = await Promise.all([
      db.select({ withdrawal: payrollCooperativeWithdrawals, workerName: workers.name })
        .from(payrollCooperativeWithdrawals).innerJoin(workers, eq(workers.id, payrollCooperativeWithdrawals.workerId))
        .where(filter).orderBy(desc(payrollCooperativeWithdrawals.id)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(payrollCooperativeWithdrawals)
        .innerJoin(workers, eq(workers.id, payrollCooperativeWithdrawals.workerId)).where(filter),
      cooperativeTotals(db, org, workerId ?? undefined),
    ]);
    return NextResponse.json({ rows, total: Number(count[0]?.count ?? 0), limit, offset, totals },
      { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}

export async function POST(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const org = requiredOrganization(actor);
    const b = await req.json();
    const workerId = safeId(b.workerId, "cooperative member");
    const amount = money(b.amount, "Requested withdrawal amount");
    const reason = shortText(b.reason, "Reason for the withdrawal", 5, 1000);
    const row = await db.transaction(async (tx) => {
      const person = await lockPayrollWorker(tx, org, workerId);
      const totals = await cooperativeTotals(tx, org, workerId);
      assertCovered(amount, totals, totals.reserved + totals.pending, "request");
      const [created] = await tx.insert(payrollCooperativeWithdrawals).values({
        organizationId: org, workerId, amount, reason, status: "REQUESTED",
        requestedById: actor.id, requestedByName: actor.name,
      }).returning();
      await auditPayroll(tx, actor, "COOP_WITHDRAWAL", created.id, "REQUEST",
        `Requested ₦${amount} from ${person.name}'s cooperative savings. ${reason}`, undefined, created);
      return created;
    });
    return NextResponse.json(row, { status: 201, headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}

export async function PUT(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const org = requiredOrganization(actor);
    const b = await req.json();
    const id = safeId(b.id, "withdrawal request");
    const action = String(b.action ?? "");
    const [candidate] = await db.select({ workerId: payrollCooperativeWithdrawals.workerId })
      .from(payrollCooperativeWithdrawals)
      .where(and(eq(payrollCooperativeWithdrawals.id, id), eq(payrollCooperativeWithdrawals.organizationId, org)))
      .limit(1);
    if (!candidate) throw new PayrollError("Withdrawal request not found in your organisation.", 404);
    const updated = await db.transaction(async (tx) => {
      await lockPayrollWorker(tx, org, candidate.workerId);
      const [record] = await tx.select().from(payrollCooperativeWithdrawals)
        .where(and(eq(payrollCooperativeWithdrawals.id, id), eq(payrollCooperativeWithdrawals.organizationId, org)))
        .for("update").limit(1);
      if (!record) throw new PayrollError("Withdrawal request not found.", 404);
      if (action === "APPROVE" || action === "REJECT") {
        if (record.status !== "REQUESTED")
          throw new PayrollError("Only a requested withdrawal can be approved or rejected.", 409);
        if (actor.id === record.requestedById)
          throw new PayrollError("Separation of duties: the requester cannot approve or reject their own withdrawal request.", 403);
        const reason = shortText(b.reason, "Review reason", 5, 1000);
        if (action === "APPROVE") {
          const totals = await cooperativeTotals(tx, org, record.workerId);
          const others = await outstandingExcept(tx, org, record.workerId, record.id);
          assertCovered(record.amount, totals, others, "approval");
        }
        const [row] = await tx.update(payrollCooperativeWithdrawals).set({
          status: action === "APPROVE" ? "APPROVED" : "REJECTED",
          reviewedById: actor.id, reviewedByName: actor.name, reviewedAt: new Date(), reviewReason: reason,
        }).where(eq(payrollCooperativeWithdrawals.id, id)).returning();
        await auditPayroll(tx, actor, "COOP_WITHDRAWAL", id, action, reason, record, row);
        return row;
      }
      if (action === "CANCEL") {
        if (!["REQUESTED", "APPROVED"].includes(record.status))
          throw new PayrollError("Only an outstanding request can be cancelled.", 409);
        const reason = shortText(b.reason, "Cancellation reason", 5, 1000);
        const [row] = await tx.update(payrollCooperativeWithdrawals).set({
          status: "CANCELLED", reviewedById: actor.id, reviewedByName: actor.name,
          reviewedAt: new Date(), reviewReason: reason,
        }).where(eq(payrollCooperativeWithdrawals.id, id)).returning();
        await auditPayroll(tx, actor, "COOP_WITHDRAWAL", id, "CANCEL", reason, record, row);
        return row;
      }
      if (action === "RECORD_PAYMENT") {
        if (record.status !== "APPROVED")
          throw new PayrollError("Only an approved withdrawal can be paid. A pending or rejected request is never money paid.", 409);
        if (actor.id === record.requestedById)
          throw new PayrollError("Separation of duties: the requester cannot record their own withdrawal payment.", 403);
        const paidOn = b.paidOn ? day(b.paidOn, "Payment date") : new Date().toISOString().slice(0, 10);
        const paymentMethod = shortText(b.paymentMethod ?? "Cash", "Payment method", 2, 40);
        if (!METHODS.includes(paymentMethod))
          throw new PayrollError(`Payment method must be one of: ${METHODS.join(", ")}.`);
        const paymentReference = b.paymentReference
          ? shortText(b.paymentReference, "Payment reference", 2, 200) : null;
        const paymentNotes = b.paymentNotes ? shortText(b.paymentNotes, "Payment notes", 1, 500) : null;
        // Re-check under the worker lock: another payment may have landed while
        // this one was being arranged.
        const totals = await cooperativeTotals(tx, org, record.workerId);
        const others = await outstandingExcept(tx, org, record.workerId, record.id);
        assertCovered(record.amount, totals, others, "payment");
        const [row] = await tx.update(payrollCooperativeWithdrawals).set({
          status: "PAID", paidOn, paymentMethod, paymentReference, paymentNotes,
          paidById: actor.id, paidByName: actor.name, paidAt: new Date(),
        }).where(eq(payrollCooperativeWithdrawals.id, id)).returning();
        await auditPayroll(tx, actor, "COOP_WITHDRAWAL", id, "PAY",
          `Recorded ₦${record.amount} paid to the member on ${paidOn} by ${paymentMethod}` +
          `${paymentReference ? ` (ref ${paymentReference})` : ""}.`, record, row);
        return row;
      }
      throw new PayrollError("Choose approve, reject, cancel or record_payment.");
    });
    return NextResponse.json(updated, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}
