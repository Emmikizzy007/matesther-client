import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { payrollStatementLines, payrollStatements, workers } from "@/db/schema";
import { guard, getSessionUser, OWNER } from "@/lib/authz";
import { PayrollError, requiredOrganization, safeId } from "@/lib/payroll-deductions";
import { payrollFailure, PRIVATE_RESPONSE } from "@/lib/payroll-deduction-http";

/** The POSTED statement line IS the cooperative transaction; there is no
 * second mutable balance or credit insert that can get out of sync. Refunds
 * post a negative credit to the next month. Never book these as revenue/expense. */
export async function GET(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const org = requiredOrganization(actor);
    const p = new URL(req.url).searchParams;
    const workerId = safeId(p.get("workerId"), "cooperative member");
    const [member] = await db.select({ id: workers.id }).from(workers).where(and(
      eq(workers.id, workerId), eq(workers.organizationId, org))).limit(1);
    if (!member) throw new PayrollError("Member not found in your organisation.", 404);
    const limit = p.has("limit") ? Number(p.get("limit")) : 50;
    const offset = p.has("offset") ? Number(p.get("offset")) : 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000)
      throw new PayrollError("Use limit 1–100 and a non-negative offset.");
    const filter = and(eq(payrollStatements.organizationId, org), eq(payrollStatements.workerId, workerId),
      eq(payrollStatementLines.categoryCode, "COOPERATIVE"));
    const [history, balance] = await Promise.all([
      db.select({ line: payrollStatementLines, periodMonth: payrollStatements.periodMonth,
        postedAt: payrollStatements.postedAt, workerName: payrollStatements.workerName })
        .from(payrollStatementLines).innerJoin(payrollStatements, eq(payrollStatements.id, payrollStatementLines.statementId))
        .where(filter).orderBy(desc(payrollStatements.periodMonth), desc(payrollStatementLines.id)).limit(limit).offset(offset),
      db.select({ amount: sql<number>`coalesce(sum(${payrollStatementLines.cooperativeCredit}), 0)`,
        count: sql<number>`count(${payrollStatementLines.id})` })
        .from(payrollStatementLines).innerJoin(payrollStatements, eq(payrollStatements.id, payrollStatementLines.statementId)).where(filter),
    ]);
    return NextResponse.json({ workerId, balance: Number(balance[0]?.amount ?? 0), total: Number(balance[0]?.count ?? 0),
      transactions: history, limit, offset }, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}
