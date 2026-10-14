import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  orders, payrollDeductions, productionBatches, productionIncidents, productionOperations,
  supportAssignments, workers,
} from "@/db/schema";
import { guard, getSessionUser, OWNER, STAFF, type SessionUser } from "@/lib/authz";
import {
  PayrollError, auditPayroll, lockPayrollWorker, money, requiredOrganization, safeId, shortText,
} from "@/lib/payroll-deductions";
import { payrollFailure, PRIVATE_RESPONSE } from "@/lib/payroll-deduction-http";

export const INCIDENT_TYPES = ["INCOMPLETE_WORK", "DAMAGED_CLOTHES", "LOST_CLOTHES", "OTHER"] as const;

function optionalCount(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > 1_000_000)
    throw new PayrollError(`${label} must be a whole number of pieces (0 or more).`);
  return n;
}

type AssignmentInfo = {
  assignedQuantity: number | null;
  completedQuantity: number | null;
  assignmentWorkerId: number;
  label: string;
};

/** The original work assignment an incident is recorded against. An incident
 * may be recorded even when the work is NOT completed, inspected or approved —
 * that is the whole point — so only the assignment's existence, organisation
 * and responsible worker are checked here. */
async function assignmentInfo(organizationId: number, source: string, operationId: number | null, supportId: number | null): Promise<AssignmentInfo> {
  if (source === "STAGE_OPERATION" && operationId) {
    const [op] = await db.select({
      workerId: productionOperations.workerId,
      quantityReceived: productionOperations.quantityReceived,
      quantityCompleted: productionOperations.quantityCompleted,
      stage: productionOperations.stage,
      batchNumber: productionBatches.batchNumber,
      orderNumber: orders.orderNumber,
      organizationId: orders.organizationId,
    }).from(productionOperations)
      .innerJoin(productionBatches, eq(productionBatches.id, productionOperations.productionBatchId))
      .innerJoin(orders, eq(orders.id, productionBatches.orderId))
      .where(eq(productionOperations.id, operationId)).limit(1);
    if (!op || op.organizationId !== organizationId)
      throw new PayrollError("Work assignment not found in your organisation.", 404);
    if (!op.workerId)
      throw new PayrollError("This stage has no assigned worker; assign the work before recording an incident against it.", 409);
    return {
      assignedQuantity: op.quantityReceived, completedQuantity: op.quantityCompleted,
      assignmentWorkerId: op.workerId,
      label: `${op.orderNumber} · ${op.batchNumber} · ${op.stage}`,
    };
  }
  if (source === "SUPPORT_ASSIGNMENT" && supportId) {
    const [assignment] = await db.select({
      workerId: supportAssignments.workerId,
      quantityAssigned: supportAssignments.quantityAssigned,
      quantitySubmitted: supportAssignments.quantitySubmitted,
      operation: supportAssignments.operation,
      organizationId: supportAssignments.organizationId,
    }).from(supportAssignments).where(and(
      eq(supportAssignments.id, supportId), eq(supportAssignments.organizationId, organizationId),
    )).limit(1);
    if (!assignment) throw new PayrollError("Support-work assignment not found in your organisation.", 404);
    return {
      assignedQuantity: assignment.quantityAssigned, completedQuantity: assignment.quantitySubmitted,
      assignmentWorkerId: assignment.workerId,
      label: `Support · ${assignment.operation}`,
    };
  }
  throw new PayrollError("Choose the original work assignment: a stage operation or a support-work assignment.");
}

/** Read-only list for the incident register. Includes the assignment snapshot
 * and any resulting deduction, so review can see the full trail. */
export async function GET(req: Request) {
  const denied = await guard(req, STAFF); if (denied) return denied;
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
    if (status && !["REPORTED", "CORRECTION_ONLY", "APPROVED_FOR_DEDUCTION", "REJECTED", "CANCELLED"].includes(status))
      throw new PayrollError("Unknown incident status.");
    const type = p.get("incidentType");
    if (type && !INCIDENT_TYPES.includes(type as (typeof INCIDENT_TYPES)[number]))
      throw new PayrollError("Unknown incident type.");
    const filter = and(eq(productionIncidents.organizationId, org),
      workerId ? eq(productionIncidents.workerId, workerId) : undefined,
      status ? eq(productionIncidents.status, status) : undefined,
      type ? eq(productionIncidents.incidentType, type) : undefined);
    const [rows, count, deductions] = await Promise.all([
      db.select({ incident: productionIncidents, workerName: workers.name })
        .from(productionIncidents).innerJoin(workers, eq(workers.id, productionIncidents.workerId))
        .where(filter).orderBy(desc(productionIncidents.id)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(productionIncidents)
        .innerJoin(workers, eq(workers.id, productionIncidents.workerId)).where(filter),
      db.select({ id: payrollDeductions.id, workerId: payrollDeductions.workerId, status: payrollDeductions.status,
        amount: payrollDeductions.amount, incidentProductionId: payrollDeductions.incidentProductionId })
        .from(payrollDeductions)
        .where(and(eq(payrollDeductions.organizationId, org), sql`${payrollDeductions.incidentProductionId} is not null`)),
    ]);
    const deductionByIncident = new Map(deductions.map((d) => [d.incidentProductionId, d]));
    return NextResponse.json({
      rows: rows.map((row) => ({ ...row, deduction: deductionByIncident.get(row.incident.id) ?? null })),
      total: Number(count[0]?.count ?? 0), limit, offset,
    }, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}

/** Record an incident against an existing work assignment. Supervisors
 * (Owner/Production Manager) may report. NOTHING is deducted here: the company
 * reviews, establishes responsibility, and only an approved incident may later
 * support one separately proposed deduction. */
export async function POST(req: Request) {
  const denied = await guard(req, STAFF); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const org = requiredOrganization(actor);
    const b = await req.json();
    const workerId = safeId(b.workerId, "responsible worker");
    const assignmentSource = String(b.assignmentSource ?? "");
    const productionOperationId = b.productionOperationId ? safeId(b.productionOperationId, "stage operation") : null;
    const supportAssignmentId = b.supportAssignmentId ? safeId(b.supportAssignmentId, "support assignment") : null;
    if (assignmentSource !== "STAGE_OPERATION" && assignmentSource !== "SUPPORT_ASSIGNMENT")
      throw new PayrollError("Assignment source must be STAGE_OPERATION or SUPPORT_ASSIGNMENT.");
    if (assignmentSource === "STAGE_OPERATION" ? (!productionOperationId || supportAssignmentId) : (productionOperationId || !supportAssignmentId))
      throw new PayrollError("Exactly one original assignment must be identified for its source.");
    const incidentType = String(b.incidentType ?? "");
    if (!INCIDENT_TYPES.includes(incidentType as (typeof INCIDENT_TYPES)[number]))
      throw new PayrollError("Incident type must be incomplete work, damaged clothes, lost/missing clothes, or other.");
    const description = shortText(b.description, "Incident description", 5, 2000);
    const completedQuantity = optionalCount(b.completedQuantity, "Completed quantity");
    const incompleteQuantity = optionalCount(b.incompleteQuantity, "Incomplete quantity");
    const damagedQuantity = optionalCount(b.damagedQuantity, "Damaged quantity");
    const missingQuantity = optionalCount(b.missingQuantity, "Missing quantity");
    if (incidentType === "INCOMPLETE_WORK" && !incompleteQuantity)
      throw new PayrollError("An incomplete-work incident records at least one incomplete piece.");
    if (incidentType === "DAMAGED_CLOTHES" && !damagedQuantity)
      throw new PayrollError("A damaged-clothes incident records at least one damaged piece.");
    if (incidentType === "LOST_CLOTHES" && !missingQuantity)
      throw new PayrollError("A lost/missing-clothes incident records at least one missing piece.");
    const proposedAmount = b.proposedAmount === undefined || b.proposedAmount === "" ? null
      : money(b.proposedAmount, "Proposed deduction amount");
    const proposedCalculation = b.proposedCalculation
      ? shortText(b.proposedCalculation, "Proposed deduction calculation", 2, 1000) : null;
    if (proposedAmount && !proposedCalculation)
      throw new PayrollError("Record how the proposed deduction amount was calculated.");
    const assignment = await assignmentInfo(org, assignmentSource, productionOperationId, supportAssignmentId);
    if (assignment.assignmentWorkerId !== workerId)
      throw new PayrollError("The responsible worker must be the worker this assignment belongs to.", 404);
    for (const [label, value] of [["Completed", completedQuantity], ["Incomplete", incompleteQuantity],
      ["Damaged", damagedQuantity], ["Missing", missingQuantity]] as const) {
      if (value !== null && assignment.assignedQuantity !== null && value > assignment.assignedQuantity)
        throw new PayrollError(`${label} quantity cannot exceed the assigned quantity of ${assignment.assignedQuantity}.`);
    }
    const row = await db.transaction(async (tx) => {
      await lockPayrollWorker(tx, org, workerId);
      const [duplicate] = await tx.select({ id: productionIncidents.id, status: productionIncidents.status })
        .from(productionIncidents).where(and(
          eq(productionIncidents.organizationId, org), eq(productionIncidents.incidentType, incidentType),
          assignmentSource === "STAGE_OPERATION"
            ? eq(productionIncidents.productionOperationId, productionOperationId!)
            : eq(productionIncidents.supportAssignmentId, supportAssignmentId!),
          sql`${productionIncidents.status} in ('REPORTED','CORRECTION_ONLY','APPROVED_FOR_DEDUCTION')`,
        )).limit(1);
      if (duplicate)
        throw new PayrollError(`An open ${incidentType.replaceAll("_", " ").toLowerCase()} incident (#${duplicate.id}) already exists for this assignment.`, 409);
      const [created] = await tx.insert(productionIncidents).values({
        organizationId: org, workerId, assignmentSource,
        productionOperationId: assignmentSource === "STAGE_OPERATION" ? productionOperationId : null,
        supportAssignmentId: assignmentSource === "SUPPORT_ASSIGNMENT" ? supportAssignmentId : null,
        incidentType, description,
        assignedQuantity: assignment.assignedQuantity, completedQuantity,
        incompleteQuantity, damagedQuantity, missingQuantity,
        proposedAmount, proposedCalculation,
        status: "REPORTED", reportedById: actor.id, reportedByName: actor.name,
      }).returning();
      await auditPayroll(tx, actor, "PRODUCTION_INCIDENT", created.id, "REPORT",
        `Reported ${incidentType.replaceAll("_", " ").toLowerCase()} on ${assignment.label} (assignment #` +
        `${productionOperationId ?? supportAssignmentId}): ${description}` +
        `${proposedAmount ? ` Proposed deduction ₦${proposedAmount}: ${proposedCalculation}.` : ""}`,
        undefined, created);
      return created;
    });
    return NextResponse.json(row, { status: 201, headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}

/** Review outcomes (Owner only): CORRECTION_ONLY (the work can be corrected —
 * no deduction), APPROVED_FOR_DEDUCTION (responsibility established and a
 * deduction justified, with the authorised amount), REJECTED (no basis).
 * A CANCEL lets the reporter withdraw a mistaken report. Recording an incident
 * or any review outcome still deducts nothing by itself. */
export async function PUT(req: Request) {
  const denied = await guard(req, STAFF); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const org = requiredOrganization(actor);
    const b = await req.json();
    const id = safeId(b.id, "production incident");
    const action = String(b.action ?? "");
    const [candidate] = await db.select({ reportedById: productionIncidents.reportedById, workerId: productionIncidents.workerId })
      .from(productionIncidents)
      .where(and(eq(productionIncidents.id, id), eq(productionIncidents.organizationId, org))).limit(1);
    if (!candidate) throw new PayrollError("Incident not found in your organisation.", 404);
    const row = await db.transaction(async (tx) => {
      await lockPayrollWorker(tx, org, candidate.workerId);
      const [record] = await tx.select().from(productionIncidents)
        .where(and(eq(productionIncidents.id, id), eq(productionIncidents.organizationId, org)))
        .for("update").limit(1);
      if (!record) throw new PayrollError("Incident not found.", 404);
      if (action === "CANCEL") {
        if (record.status !== "REPORTED")
          throw new PayrollError("Only a newly reported incident can be cancelled.", 409);
        if (actor.role !== "OWNER" && actor.id !== record.reportedById)
          throw new PayrollError("Only the reporter or an Owner can cancel a reported incident.", 403);
        const reason = shortText(b.reason, "Cancellation reason", 5, 1000);
        const [updated] = await tx.update(productionIncidents).set({ status: "CANCELLED", reviewReason: reason })
          .where(eq(productionIncidents.id, id)).returning();
        await auditPayroll(tx, actor, "PRODUCTION_INCIDENT", id, "CANCEL", reason, record, updated);
        return updated;
      }
      if (!["CORRECTION_ONLY", "APPROVED_FOR_DEDUCTION", "REJECTED"].includes(action))
        throw new PayrollError("Choose correction_only, approved_for_deduction, rejected or cancel.");
      if (actor.role !== "OWNER")
        throw new PayrollError("Only an Owner can review an incident for a possible deduction.", 403);
      if (record.status !== "REPORTED")
        throw new PayrollError("Only a reported incident can be reviewed.", 409);
      if (action === "APPROVED_FOR_DEDUCTION" && actor.id === record.reportedById)
        throw new PayrollError("Separation of duties: the reporter cannot approve their own incident for a deduction.", 403);
      const reason = shortText(b.reason, "Review findings", 5, 2000);
      const approvedAmount = b.approvedAmount === undefined || b.approvedAmount === ""
        ? null : money(b.approvedAmount, "Approved deduction amount");
      if (action === "APPROVED_FOR_DEDUCTION") {
        const cap = record.approvedAmount ?? record.proposedAmount;
        if (approvedAmount && record.proposedAmount && approvedAmount > record.proposedAmount)
          throw new PayrollError("The approved amount cannot exceed the proposed deduction amount.");
        if (!approvedAmount && !cap)
          throw new PayrollError("Approve a specific deduction amount (or first record a proposed amount).");
      } else if (approvedAmount) {
        throw new PayrollError("An approved amount is only recorded when approving an incident for deduction.");
      }
      const status = action === "CORRECTION_ONLY" ? "CORRECTION_ONLY" : action === "APPROVED_FOR_DEDUCTION" ? "APPROVED_FOR_DEDUCTION" : "REJECTED";
      const [updated] = await tx.update(productionIncidents).set({
        status, reviewReason: reason,
        ...(action === "APPROVED_FOR_DEDUCTION" ? {
          reviewedById: actor.id, reviewedByName: actor.name, reviewedAt: new Date(),
          approvedAmount: approvedAmount ?? record.proposedAmount,
        } : {
          reviewedById: actor.id, reviewedByName: actor.name, reviewedAt: new Date(),
        }),
      }).where(eq(productionIncidents.id, id)).returning();
      await auditPayroll(tx, actor, "PRODUCTION_INCIDENT", id, action, reason, record, updated);
      return updated;
    });
    return NextResponse.json(row, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}
