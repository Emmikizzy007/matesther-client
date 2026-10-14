import { NextResponse } from "next/server";
import { and, desc, eq, gt, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { orders, productionBatches, productionOperations, stageInspections,
  supportAssignments, supportInspections, workers } from "@/db/schema";
import { guard, getSessionUser, OWNER } from "@/lib/authz";
import { assertMonth, PayrollError, requiredOrganization, safeId } from "@/lib/payroll-deductions";
import { payrollFailure, PRIVATE_RESPONSE } from "@/lib/payroll-deduction-http";
import { monthBounds } from "@/lib/payroll";

/** Read-only evidence picker. Rejected != chargeable: it merely supplies an
 * inspection id/quantity, and no money moves without a separate signed case,
 * proven net loss, labour-officer approval and independent Owner review. */
export async function GET(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const org = requiredOrganization(actor);
    const p = new URL(req.url).searchParams;
    const workerId = safeId(p.get("workerId"), "worker");
    const [worker] = await db.select({ id: workers.id }).from(workers).where(and(
      eq(workers.id, workerId), eq(workers.organizationId, org))).limit(1);
    if (!worker) throw new PayrollError("Worker not found.", 404);
    const period = p.has("month") ? assertMonth(p.get("month")) : null;
    const bounds = period ? monthBounds(period) : null;
    const rows = await db.select({
      id: stageInspections.id, quantityRejected: stageInspections.quantityRejected,
      quantityRework: stageInspections.quantityRework,
      quantityApproved: stageInspections.quantityApproved,
      notes: stageInspections.notes, inspectedAt: stageInspections.inspectedAt,
      stage: productionOperations.stage, batchNumber: productionBatches.batchNumber,
      orderNumber: orders.orderNumber,
    }).from(stageInspections)
      .innerJoin(productionOperations, eq(productionOperations.id, stageInspections.productionOperationId))
      .innerJoin(productionBatches, eq(productionBatches.id, productionOperations.productionBatchId))
      .innerJoin(orders, eq(orders.id, productionBatches.orderId))
      .where(and(eq(orders.organizationId, org), gt(stageInspections.quantityRejected, 0),
        eq(sql`coalesce(${stageInspections.workerId},${productionOperations.workerId})`, workerId),
        bounds ? gte(stageInspections.inspectedAt, bounds.from) : undefined,
        bounds ? lt(stageInspections.inspectedAt, bounds.to) : undefined))
      .orderBy(desc(stageInspections.inspectedAt), desc(stageInspections.id)).limit(100);
    const support = await db.select({
      id: supportInspections.id, quantityRejected: supportInspections.quantityRejected,
      quantityRework: supportInspections.quantityRework,
      quantityApproved: supportInspections.quantityApproved,
      notes: supportInspections.notes, inspectedAt: supportInspections.inspectedAt,
      stage: supportAssignments.stage, operation: supportAssignments.operation,
      batchNumber: productionBatches.batchNumber, orderNumber: orders.orderNumber,
    }).from(supportInspections)
      .innerJoin(supportAssignments, eq(supportAssignments.id, supportInspections.supportAssignmentId))
      .innerJoin(productionOperations, eq(productionOperations.id, supportAssignments.productionOperationId))
      .innerJoin(productionBatches, eq(productionBatches.id, productionOperations.productionBatchId))
      .innerJoin(orders, eq(orders.id, productionBatches.orderId))
      .where(and(eq(supportAssignments.organizationId, org), eq(supportAssignments.workerId, workerId),
        eq(supportAssignments.orderId, orders.id), eq(orders.organizationId, org),
        gt(supportInspections.quantityRejected, 0),
        bounds ? gte(supportInspections.inspectedAt, bounds.from) : undefined,
        bounds ? lt(supportInspections.inspectedAt, bounds.to) : undefined))
      .orderBy(desc(supportInspections.inspectedAt), desc(supportInspections.id)).limit(100);
    const combined = [
      ...rows.map((r) => ({ ...r, source: "STAGE" as const, operation: null })),
      ...support.map((r) => ({ ...r, source: "SUPPORT" as const })),
    ].sort((a, b) => (b.inspectedAt?.getTime() ?? 0) - (a.inspectedAt?.getTime() ?? 0)).slice(0, 100);
    return NextResponse.json({ rows: combined }, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}
