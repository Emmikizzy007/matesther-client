import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { payrollAttendance, payrollDeductions, payrollStatementLines } from "@/db/schema";
import { guard, getSessionUser, OWNER } from "@/lib/authz";
import { ATTENDANCE_STATUSES, auditPayroll, assertMonth, lockPayrollWorker,
  PayrollError, requiredOrganization, safeId, shortText } from "@/lib/payroll-deductions";
import { payrollFailure, PRIVATE_RESPONSE } from "@/lib/payroll-deduction-http";
import { shiftMonth } from "@/lib/payroll";

function dateOf(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new PayrollError("Use a real attendance date (YYYY-MM-DD).");
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value || value > new Date().toISOString().slice(0, 10))
    throw new PayrollError("Attendance dates must be real and not in the future.");
  return value;
}
function statusOf(value: unknown) {
  if (typeof value !== "string" || !ATTENDANCE_STATUSES.includes(value as typeof ATTENDANCE_STATUSES[number]))
    throw new PayrollError("Choose present, unauthorized absence, paid/approved/unpaid leave or other.");
  return value;
}

export async function GET(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const org = requiredOrganization(actor);
    const p = new URL(req.url).searchParams;
    const month = assertMonth(p.get("month"));
    const workerId = p.has("workerId") ? safeId(p.get("workerId"), "worker") : null;
    const raw = p.has("limit") ? Number(p.get("limit")) : 50;
    if (!Number.isSafeInteger(raw) || raw < 1 || raw > 100) throw new PayrollError("Limit must be 1–100.");
    const rows = await db.select().from(payrollAttendance).where(and(
      eq(payrollAttendance.organizationId, org), gte(payrollAttendance.day, `${month}-01`),
      lt(payrollAttendance.day, `${shiftMonth(month, 1)}-01`),
      workerId ? eq(payrollAttendance.workerId, workerId) : undefined,
    )).orderBy(desc(payrollAttendance.day), desc(payrollAttendance.id)).limit(raw);
    return NextResponse.json({ rows }, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}

/** Missing dates are not a time clock and NEVER generate a deduction. Every
 * absence/leave decision is a recorded, named event with evidence. */
export async function POST(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const org = requiredOrganization(actor);
    const body = await req.json();
    const workerId = safeId(body.workerId, "worker");
    const day = dateOf(body.day);
    const status = statusOf(body.status);
    const reason = shortText(body.reason, "Attendance/leave reason", 8, 500);
    const evidenceRef = body.evidenceRef ? shortText(body.evidenceRef, "Attendance evidence reference", 5, 500) : null;
    if (["UNAUTHORIZED_ABSENCE", "UNPAID_LEAVE"].includes(status) && !evidenceRef)
      throw new PayrollError("Unpaid/unauthorized absences need a recorded source, not an inferred missing day.");
    const row = await db.transaction(async (tx) => {
      await lockPayrollWorker(tx, org, workerId);
      const [record] = await tx.insert(payrollAttendance).values({
        organizationId: org, workerId, day, status, reason, evidenceRef,
        recordedById: actor.id, recordedByName: actor.name,
      }).returning();
      await auditPayroll(tx, actor, "ATTENDANCE", record.id, "CREATE", reason, undefined, record);
      return record;
    });
    return NextResponse.json(row, { status: 201, headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}

/** Correct an uncommitted day with a signed audit event. An approved deduction
 * or a posted line protects its evidence from later status rewrites. Cancel an
 * unposted proposal first, then correct and create a NEW proposal. */
export async function PUT(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const org = requiredOrganization(actor);
    const b = await req.json();
    const id = safeId(b.id, "attendance record");
    const status = statusOf(b.status);
    const reason = shortText(b.reason, "Correction reason", 8, 500);
    const evidenceRef = b.evidenceRef ? shortText(b.evidenceRef, "Evidence reference", 5, 500) : null;
    if (["UNAUTHORIZED_ABSENCE", "UNPAID_LEAVE"].includes(status) && !evidenceRef)
      throw new PayrollError("Unpaid/unauthorized absences need a documented source.");
    const [candidate] = await db.select({ workerId: payrollAttendance.workerId }).from(payrollAttendance)
      .where(and(eq(payrollAttendance.id, id), eq(payrollAttendance.organizationId, org))).limit(1);
    if (!candidate) throw new PayrollError("Attendance record not found.", 404);
    const row = await db.transaction(async (tx) => {
      await lockPayrollWorker(tx, org, candidate.workerId);
      const [before] = await tx.select().from(payrollAttendance).where(and(
        eq(payrollAttendance.id, id), eq(payrollAttendance.organizationId, org),
      )).for("update").limit(1);
      if (!before) throw new PayrollError("Attendance record not found.", 404);
      const attached = await tx.select({ id: payrollDeductions.id, status: payrollDeductions.status })
        .from(payrollDeductions).where(eq(payrollDeductions.attendanceId, id));
      if (attached.some((proposal) => ["PENDING", "APPROVED"].includes(proposal.status)))
        throw new PayrollError("Cancel the pending/approved absence case before correcting the underlying attendance.", 409);
      if (attached.length) {
        const [booked] = await tx.select({ id: payrollStatementLines.id }).from(payrollStatementLines)
          .where(inArray(payrollStatementLines.deductionId, attached.map((item) => item.id))).limit(1);
        if (booked) throw new PayrollError("This day was used in a posted payroll. Correct via a later-period refund, not by rewriting its evidence.", 409);
      }
      const [updated] = await tx.update(payrollAttendance).set({ status, reason, evidenceRef, updatedAt: new Date() })
        .where(eq(payrollAttendance.id, id)).returning();
      await auditPayroll(tx, actor, "ATTENDANCE", id, "CORRECT", reason, before, updated);
      return updated;
    });
    return NextResponse.json(row, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}
