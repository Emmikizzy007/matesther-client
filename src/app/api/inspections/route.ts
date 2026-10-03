import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  stageInspections,
  productionOperations,
  productionBatches,
  orders,
  customers,
  workers,
} from "@/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { refreshBatchAndOrder } from "@/lib/server";
import { guard, getSessionUser, getLinkedWorkerId, productionAccess, ANYONE, STAFF } from "@/lib/authz";
import { MOVEMENT_EVENTS, applyMovements } from "@/lib/production-ledger";
import { releaseApprovedToNextStage, statusFromQuantities } from "@/lib/production-route";

/**
 * GET /api/inspections?operationId=&orderId=&limit=
 * Inspection audit trail (never overwritten - every inspection is a row).
 *
 * FILTERING NOW HAPPENS IN SQL. This route used to fetch the whole
 * `stage_inspections` table, the whole `production_operations` table, every
 * batch, every order, every customer and every worker, join them in JavaScript
 * and only THEN apply `operationId` / `orderId` / the worker's own scope.
 *
 * That also had a correctness consequence worth stating: `limit(100)` was applied
 * BEFORE those filters, so a filtered request could return far fewer than 100
 * rows - or none at all - even when plenty of matching inspections existed. The
 * limit is now applied last, to the filtered set.
 */
export async function GET(req: Request) {
  const __g = await guard(req, ANYONE);
  if (__g) return __g;
  const __user = await getSessionUser(req);
  if (!__user) return NextResponse.json([], { headers: { "Cache-Control": "private, no-store" } });
  const myWorkerId = __user.role === "WORKER" ? await getLinkedWorkerId(__user) : null;
  if (__user.role === "WORKER" && myWorkerId === null)
    return NextResponse.json([], { headers: { "Cache-Control": "private, no-store" } });
  try {
    const { searchParams } = new URL(req.url);
    const operationId = searchParams.get("operationId") ? Number(searchParams.get("operationId")) : null;
    const orderId = searchParams.get("orderId") ? Number(searchParams.get("orderId")) : null;
    const rawLimit = Number(searchParams.get("limit") || 100);
    const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;

    // Restrict to a set of operations, resolved with indexed lookups. Each
    // active filter contributes one candidate list and the result is their
    // intersection, so the narrowing happens in SQL rather than in Node.
    const scopes: number[][] = [];
    if (operationId) scopes.push([operationId]);
    if (__user.role === "WORKER") {
      // Workers only see inspection history on their own jobs.
      const own = await db
        .select({ id: productionOperations.id })
        .from(productionOperations)
        .where(eq(productionOperations.workerId, myWorkerId!));
      scopes.push(own.map((row) => row.id));
    }
    if (orderId) {
      const forOrder = await db
        .select({ id: productionOperations.id })
        .from(productionOperations)
        .innerJoin(productionBatches, eq(productionBatches.id, productionOperations.productionBatchId))
        .where(eq(productionBatches.orderId, orderId));
      scopes.push(forOrder.map((row) => row.id));
    }
    const scopeIds = scopes.length ? scopes.reduce((left, right) => left.filter((id) => right.includes(id))) : null;
    if (scopeIds !== null && scopeIds.length === 0)
      return NextResponse.json([], { headers: { "Cache-Control": "private, no-store" } });

    const rows = await db
      .select()
      .from(stageInspections)
      .where(scopeIds === null ? undefined : inArray(stageInspections.productionOperationId, scopeIds))
      .orderBy(desc(stageInspections.inspectedAt), desc(stageInspections.id))
      .limit(limit);
    if (!rows.length) return NextResponse.json([], { headers: { "Cache-Control": "private, no-store" } });

    // Enrich only the rows being returned, one indexed lookup per relation.
    const opIds = [...new Set(rows.map((row) => row.productionOperationId))];
    const ops = await db
      .select({
        id: productionOperations.id, stage: productionOperations.stage, workerId: productionOperations.workerId,
        productionBatchId: productionOperations.productionBatchId,
      })
      .from(productionOperations)
      .where(inArray(productionOperations.id, opIds));
    const opMap = new Map(ops.map((o) => [o.id, o]));
    const batchIds = [...new Set(ops.map((o) => o.productionBatchId))];
    const batches = batchIds.length
      ? await db
          .select({ id: productionBatches.id, batchNumber: productionBatches.batchNumber, orderId: productionBatches.orderId })
          .from(productionBatches).where(inArray(productionBatches.id, batchIds))
      : [];
    const bMap = new Map(batches.map((b) => [b.id, b]));
    const orderIds = [...new Set(batches.map((b) => b.orderId))];
    const orderRows = orderIds.length
      ? await db
          .select({ id: orders.id, orderNumber: orders.orderNumber, customerId: orders.customerId })
          .from(orders).where(inArray(orders.id, orderIds))
      : [];
    const oMap = new Map(orderRows.map((o) => [o.id, o]));
    const customerIds = [...new Set(orderRows.map((o) => o.customerId).filter((v): v is number => !!v))];
    const customerRows = customerIds.length
      ? await db.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, customerIds))
      : [];
    const cMap = new Map(customerRows.map((c) => [c.id, c]));
    const workerIds = [...new Set(ops.map((o) => o.workerId).filter((v): v is number => !!v))];
    const workerRows = workerIds.length
      ? await db.select({ id: workers.id, name: workers.name }).from(workers).where(inArray(workers.id, workerIds))
      : [];
    const wMap = new Map(workerRows.map((w) => [w.id, w]));

    const data = rows.map((r) => {
      const op = opMap.get(r.productionOperationId);
      const batch = op ? bMap.get(op.productionBatchId) : undefined;
      const order = batch ? oMap.get(batch.orderId) : undefined;
      return {
        ...r,
        stage: op?.stage ?? "-",
        batchNumber: batch?.batchNumber ?? "-",
        orderId: order?.id ?? null,
        orderNumber: order?.orderNumber ?? "-",
        customer: cMap.get(order?.customerId ?? -1)?.name ?? "-",
        workerName: op?.workerId ? wMap.get(op.workerId)?.name ?? null : null,
      };
    });
    return NextResponse.json(data, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

/**
 * POST /api/inspections
 * { operationId, quantityApproved, quantityRework, quantityRejected, notes, inspectedBy }
 *
 * Rules (Matesther quality gate):
 * - total inspected may not exceed pieces still awaiting inspection
 * - only APPROVED pieces flow to the next production stage
 * - rework pieces return to the worker; rejected pieces stay recorded
 *
 * ATOMIC AND LEDGER-BACKED. The inspection row, the counters it produces and the
 * quantity that flows to the next stage are written in ONE transaction. Before
 * this they were five separate writes, so two supervisors inspecting the same job
 * at the same moment could each read the same `quantity_approved` and one
 * approval would be lost. The counters themselves are now derived from the
 * production movement ledger, so the audit trail and the figures it produced can
 * never disagree.
 */
export async function POST(req: Request) {
  const __g = await guard(req, STAFF);
  if (__g) return __g;
  try {
    const b = await req.json();
    const opId = Number(b.operationId);
    const approved = Number(b.quantityApproved) || 0;
    const rework = Number(b.quantityRework) || 0;
    const rejected = Number(b.quantityRejected) || 0;
    const total = approved + rework + rejected;
    if (![approved, rework, rejected].every((value) => Number.isSafeInteger(value) && value >= 0))
      return NextResponse.json({ error: "Inspection quantities must be non-negative whole garments." }, { status: 400 });

    if (!opId) return NextResponse.json({ error: "Operation is required." }, { status: 400 });
    if (total <= 0)
      return NextResponse.json(
        { error: "Record at least one piece as approved, rework or rejected." },
        { status: 400 }
      );
    const inspector = await getSessionUser(req);
    if (!inspector) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
    if ((rework > 0 || rejected > 0) && !String(b.notes ?? "").trim())
      return NextResponse.json({ error: "Explain why garments need rework or were rejected." }, { status: 400 });

    const [op] = await db
      .select()
      .from(productionOperations)
      .where(eq(productionOperations.id, opId));
    if (!op) return NextResponse.json({ error: "Operation not found." }, { status: 404 });
    if (inspector.role === "PRODUCTION_MANAGER") {
      const access = await productionAccess(inspector);
      if (access.workerId && op.workerId === access.workerId)
        return NextResponse.json({
          error: "You cannot inspect your own production work. Ask the Owner or another supervisor to inspect this job.",
        }, { status: 403 });
    }
    const [assigned] = op.workerId ? await db.select().from(workers).where(eq(workers.id, op.workerId)).limit(1) : [];
    const agreedRate = assigned?.paymentType === "PER_PIECE" ? op.pieceRate ?? assigned.paymentRate : null;

    const pending = (op.quantityCompleted ?? 0) - (op.quantityInspected ?? 0);
    if (total > pending)
      return NextResponse.json(
        { error: `Only ${pending} piece(s) are awaiting inspection - you cannot inspect ${total}.` },
        { status: 400 }
      );

    const actor = { userId: inspector.id, name: inspector.name };
    const updated = await db.transaction(async (tx) => {
      // 1. Record the inspection (audit trail) and the ledger rows it implies,
      //    so the counters and their evidence are written together.
      const [recorded] = await tx.insert(stageInspections).values({
        productionOperationId: opId,
        inspectedBy: inspector.name,
        pieceRate: agreedRate,
        quantityApproved: approved,
        quantityRework: rework,
        quantityRejected: rejected,
        notes: b.notes || null,
      }).returning({ id: stageInspections.id });

      // 2. Stage counters are DERIVED from the ledger, not incremented by hand.
      const derived = await applyMovements(tx, op, actor, [
        { type: MOVEMENT_EVENTS.INSPECTION_APPROVED, quantity: approved, workerId: op.workerId,
          referenceType: "STAGE_INSPECTION", referenceId: recorded.id,
          reason: "Inspection approved these pieces", notes: b.notes || null, occurredAt: new Date() },
        { type: MOVEMENT_EVENTS.INSPECTION_REWORK, quantity: rework, workerId: op.workerId,
          referenceType: "STAGE_INSPECTION", referenceId: recorded.id,
          reason: "Inspection sent these pieces back for rework", notes: b.notes || null, occurredAt: new Date() },
        { type: MOVEMENT_EVENTS.INSPECTION_REJECTED, quantity: rejected, workerId: op.workerId,
          referenceType: "STAGE_INSPECTION", referenceId: recorded.id,
          reason: "Inspection rejected these pieces", notes: b.notes || null, occurredAt: new Date() },
      ]);

      // 3. Only approved pieces move to the next APPLICABLE ROUTE STAGE.
      //
      // Shared with external-work acceptance and ready-made acceptance, so all
      // three paths release quantity by exactly the same rule and none of them can
      // drift from the others. It reads THIS BATCH's frozen route, so a garment
      // whose route skips a stage releases into the stage that actually follows.
      await releaseApprovedToNextStage(tx, op, derived.quantityApproved, actor);
      // One status rule for every path that can finish a stage.
      const status = statusFromQuantities(derived);
      const [row] = await tx
        .update(productionOperations)
        .set({
          inspector: inspector.name,
          inspectedAt: new Date(),
          status,
          completedAt: status === "COMPLETED" ? op.completedAt ?? new Date() : null,
        })
        .where(eq(productionOperations.id, opId))
        .returning();
      return row;
    });

    await refreshBatchAndOrder(op.productionBatchId);
    return NextResponse.json(updated, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}
