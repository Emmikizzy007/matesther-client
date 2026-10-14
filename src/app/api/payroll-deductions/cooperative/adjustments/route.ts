import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { payrollCooperativeAdjustments, workers } from "@/db/schema";
import { guard, getSessionUser, OWNER } from "@/lib/authz";
import {
  PayrollError, auditPayroll, lockPayrollWorker, requiredOrganization, safeId, shortText,
} from "@/lib/payroll-deductions";
import { payrollFailure, PRIVATE_RESPONSE } from "@/lib/payroll-deduction-http";

function signedMoney(value: unknown, label: string) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 2_000_000_000)
    throw new PayrollError(`${label} must be a non-zero whole naira amount up to ₦2,000,000,000 (negative recovers from the fund).`);
  return amount;
}

/**
 * Authorised corrections to a worker's cooperative fund (bank charges, clerical
 * fixes, court orders). Signed amounts, two-person control: the approver is
 * never the creator. Only APPROVED adjustments change the computed balance;
 * nothing is ever silently edited and every decision is audited.
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
    const filter = and(eq(payrollCooperativeAdjustments.organizationId, org),
      workerId ? eq(payrollCooperativeAdjustments.workerId, workerId) : undefined);
    const [rows, count] = await Promise.all([
      db.select({ adjustment: payrollCooperativeAdjustments, workerName: workers.name })
        .from(payrollCooperativeAdjustments).innerJoin(workers, eq(workers.id, payrollCooperativeAdjustments.workerId))
        .where(filter).orderBy(desc(payrollCooperativeAdjustments.id)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(payrollCooperativeAdjustments)
        .innerJoin(workers, eq(workers.id, payrollCooperativeAdjustments.workerId)).where(filter),
    ]);
    return NextResponse.json({ rows, total: Number(count[0]?.count ?? 0), limit, offset }, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}

export async function POST(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const org = requiredOrganization(actor);
    const b = await req.json();
    const workerId = safeId(b.workerId, "cooperative member");
    const amount = signedMoney(b.amount, "Adjustment amount");
    const reason = shortText(b.reason, "Reason for the adjustment", 5, 1000);
    const reference = b.reference ? shortText(b.reference, "Adjustment reference", 2, 200) : null;
    const row = await db.transaction(async (tx) => {
      const person = await lockPayrollWorker(tx, org, workerId);
      const [created] = await tx.insert(payrollCooperativeAdjustments).values({
        organizationId: org, workerId, amount, reason, reference, status: "PENDING",
        createdById: actor.id, createdByName: actor.name,
      }).returning();
      await auditPayroll(tx, actor, "COOP_ADJUSTMENT", created.id, "CREATE",
        `Proposed ₦${amount} adjustment to ${person.name}'s cooperative fund. ${reason}`, undefined, created);
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
    const id = safeId(b.id, "cooperative adjustment");
    const action = String(b.action ?? "");
    if (!["APPROVE", "REJECT", "CANCEL"].includes(action))
      throw new PayrollError("Choose approve, reject or cancel.");
    const reason = shortText(b.reason, "Decision reason", 5, 1000);
    const [candidate] = await db.select({ workerId: payrollCooperativeAdjustments.workerId })
      .from(payrollCooperativeAdjustments)
      .where(and(eq(payrollCooperativeAdjustments.id, id), eq(payrollCooperativeAdjustments.organizationId, org)))
      .limit(1);
    if (!candidate) throw new PayrollError("Adjustment not found in your organisation.", 404);
    const updated = await db.transaction(async (tx) => {
      await lockPayrollWorker(tx, org, candidate.workerId);
      const [record] = await tx.select().from(payrollCooperativeAdjustments)
        .where(and(eq(payrollCooperativeAdjustments.id, id), eq(payrollCooperativeAdjustments.organizationId, org)))
        .for("update").limit(1);
      if (!record) throw new PayrollError("Adjustment not found.", 404);
      const allowed = action === "APPROVE" ? ["PENDING"] : action === "REJECT" ? ["PENDING"] : ["PENDING", "APPROVED"];
      if (!allowed.includes(record.status))
        throw new PayrollError(`This adjustment cannot be ${action.toLowerCase()}d in its current state.`, 409);
      if (action === "APPROVE" && actor.id === record.createdById)
        throw new PayrollError("Separation of duties: a different Owner must approve the adjustment.", 403);
      const status = action === "APPROVE" ? "APPROVED" : action === "REJECT" ? "REJECTED" : "CANCELLED";
      const [row] = await tx.update(payrollCooperativeAdjustments).set({
        status, decisionReason: reason,
        ...(status === "APPROVED" ? { approvedById: actor.id, approvedByName: actor.name, approvedAt: new Date() } : {}),
      }).where(eq(payrollCooperativeAdjustments.id, id)).returning();
      await auditPayroll(tx, actor, "COOP_ADJUSTMENT", id, action, reason, record, row);
      return row;
    });
    return NextResponse.json(updated, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}
