import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { payrollReversals, payrollStatementLines, payrollStatements, workers } from "@/db/schema";
import { guard, getSessionUser, OWNER } from "@/lib/authz";
import { assertMonth, assertUnsettled, auditPayroll, lockPayrollWorker,
  PayrollError, requiredOrganization, safeId, shortText } from "@/lib/payroll-deductions";
import { payrollFailure, PRIVATE_RESPONSE } from "@/lib/payroll-deduction-http";
import { currentMonth } from "@/lib/payroll";

async function sourceOf(lineId: number, organizationId: number) {
  const [record] = await db.select({ line: payrollStatementLines, statement: payrollStatements })
    .from(payrollStatementLines).innerJoin(payrollStatements, eq(payrollStatements.id, payrollStatementLines.statementId))
    .where(and(eq(payrollStatementLines.id, lineId), eq(payrollStatements.organizationId, organizationId))).limit(1);
  if (!record) throw new PayrollError("Posted deduction line not found in your organisation.", 404);
  return record;
}

/** Request a FULL compensating refund for the NEXT unprocessed payroll month.
 * Do not delete/change the booked line; tax requires a separate statutory
 * adjustment process and cannot be silently reclassified as a company refund. */
export async function POST(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const org = requiredOrganization(actor);
    const b = await req.json();
    const sourceLineId = safeId(b.sourceLineId, "posted deduction line");
    const targetMonth = assertMonth(b.targetMonth);
    const reason = shortText(b.reason, "Refund/correction reason", 20, 1000);
    const { line, statement } = await sourceOf(sourceLineId, org);
    if (line.amount <= 0 || line.reversalId || line.categoryCode === "STATUTORY_TAX")
      throw new PayrollError("Only a posted, positive, non-statutory deduction can be refunded here.", 409);
    if (targetMonth <= statement.periodMonth || targetMonth < currentMonth())
      throw new PayrollError("A refund must be in a later unprocessed month; the original period stays immutable.", 409);
    const row = await db.transaction(async (tx) => {
      await lockPayrollWorker(tx, org, statement.workerId);
      await assertUnsettled(tx, statement.workerId, targetMonth);
      const [reversal] = await tx.insert(payrollReversals).values({
        organizationId: org, workerId: statement.workerId, sourceLineId, targetMonth,
        amount: line.amount, reason, status: "PENDING", createdById: actor.id, createdByName: actor.name,
      }).returning();
      await auditPayroll(tx, actor, "REVERSAL", reversal.id, "CREATE", reason, undefined, reversal);
      return reversal;
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
    const id = safeId(b.id, "refund request");
    const action = String(b.action ?? "");
    if (!["APPROVE", "REJECT", "CANCEL"].includes(action)) throw new PayrollError("Choose approve, reject or cancel.");
    const reason = shortText(b.reason, "Review reason", 8, 500);
    const [candidate] = await db.select({ workerId: payrollReversals.workerId }).from(payrollReversals)
      .where(and(eq(payrollReversals.id, id), eq(payrollReversals.organizationId, org))).limit(1);
    if (!candidate) throw new PayrollError("Refund request not found.", 404);
    const row = await db.transaction(async (tx) => {
      await lockPayrollWorker(tx, org, candidate.workerId);
      const [before] = await tx.select().from(payrollReversals).where(and(
        eq(payrollReversals.id, id), eq(payrollReversals.organizationId, org),
      )).for("update").limit(1);
      if (!before) throw new PayrollError("Refund request not found.", 404);
      if (action === "APPROVE") {
        if (before.status !== "PENDING") throw new PayrollError("Only pending refunds can be approved.", 409);
        if (before.createdById === actor.id)
          throw new PayrollError("A different Owner must approve a financial reversal.", 403);
        await assertUnsettled(tx, before.workerId, before.targetMonth);
      } else if (action === "REJECT" ? before.status !== "PENDING" : !["PENDING", "APPROVED"].includes(before.status)) {
        throw new PayrollError("This refund request cannot be rejected/cancelled.", 409);
      }
      if (action === "CANCEL") {
        const [posted] = await tx.select({ id: payrollStatementLines.id }).from(payrollStatementLines)
          .where(eq(payrollStatementLines.reversalId, id)).limit(1);
        if (posted) throw new PayrollError("Already posted: reverse using a new reviewed case, not by deleting history.", 409);
      }
      const status = action === "APPROVE" ? "APPROVED" : action === "REJECT" ? "REJECTED" : "CANCELLED";
      const [updated] = await tx.update(payrollReversals).set({ status,
        ...(status === "APPROVED" ? { approvedById: actor.id, approvedByName: actor.name, approvedAt: new Date() } :
          { cancelledById: actor.id, cancelledByName: actor.name, cancelledAt: new Date() }),
      }).where(eq(payrollReversals.id, id)).returning();
      await auditPayroll(tx, actor, "REVERSAL", id, action, reason, before, updated);
      return updated;
    });
    return NextResponse.json(row, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}

export async function GET(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const org = requiredOrganization(actor);
    const p = new URL(req.url).searchParams;
    const workerId = p.has("workerId") ? safeId(p.get("workerId"), "worker") : null;
    const limit = p.has("limit") ? Number(p.get("limit")) : 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new PayrollError("Limit must be 1–100.");
    const rows = await db.select({ reversal: payrollReversals,
      workerName: workers.name, categoryName: payrollStatementLines.categoryName,
      sourcePeriod: payrollStatements.periodMonth }).from(payrollReversals)
      .innerJoin(payrollStatementLines, eq(payrollStatementLines.id, payrollReversals.sourceLineId))
      .innerJoin(payrollStatements, eq(payrollStatements.id, payrollStatementLines.statementId))
      .innerJoin(workers, eq(workers.id, payrollReversals.workerId))
      .where(and(eq(payrollReversals.organizationId, org), workerId ? eq(payrollReversals.workerId, workerId) : undefined))
      .orderBy(desc(payrollReversals.id)).limit(limit);
    return NextResponse.json({ rows }, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}
