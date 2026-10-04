import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  stageInspections,
  productionOperations,
  productionAllocations,
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
import { operationIdsForWorker } from "@/lib/production-allocation";
import { liveAllocations, validateAttributions, type Allocation } from "@/lib/production-allocation";

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
      // A Worker's scope is applied to the inspection ROWS rather than to
      // operations, because a stage split across workers writes one row per worker
      // credited and all of them point at the same operation. See
      // workerInspectionScope below.
      scopes.push(await ownOperationIds(myWorkerId!));
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
      .where(
        and(
          scopeIds === null ? undefined : inArray(stageInspections.productionOperationId, scopeIds),
          __user.role === "WORKER" ? eq(stageInspections.workerId, myWorkerId!) : undefined
        )
      )
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
    const workerIds = [...new Set([
      ...ops.map((o) => o.workerId),
      ...rows.map((r) => r.workerId),
    ].filter((v): v is number => !!v))];
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
        // A split stage writes one row per worker credited, so the name shown has to
        // come from the row's own attribution. Falling back to the stage's nominal
        // worker is what keeps every unattributed historical row reading exactly as
        // it did before.
        workerName: (() => {
          const credited = r.workerId ?? op?.workerId ?? null;
          return credited ? wMap.get(credited)?.name ?? null : null;
        })(),
      };
    });
    return NextResponse.json(data, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

/**
 * The operations a Worker is the nominal worker on.
 *
 * Kept as an operation-id scope so it composes with the `operationId` and `orderId`
 * filters. Row-level attribution is applied separately, because on a stage split
 * across workers the operation is shared but the inspection rows are not.
 */
async function ownOperationIds(workerId: number): Promise<number[]> {
  const own = await db
    .select({ id: productionOperations.id })
    .from(productionOperations)
    .where(eq(productionOperations.workerId, workerId));
  // A worker who holds a share of a stage they are not nominally assigned to must
  // still see that stage's history - but only the rows credited to them, which the
  // row-level filter above guarantees.
  const shared = await operationIdsForWorker(workerId);
  return [...new Set([...own.map((row) => row.id), ...shared])];
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
    // A stage may now be split across several workers, so "is this my own work?"
    // has to consider the allocations as well as the stage's legacy worker_id -
    // otherwise a supervisor could hold a share of a stage and then inspect it.
    const allocations = await liveAllocations(db, op.id);
    if (inspector.role === "PRODUCTION_MANAGER") {
      const access = await productionAccess(inspector);
      const holdsShare = !!access.workerId && allocations.some((row) => row.workerId === access.workerId);
      if (access.workerId && (op.workerId === access.workerId || holdsShare))
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

    // A split stage must be attributed per worker. Deciding whose pieces were the
    // good ones is a fact only the person at the inspection table knows, so it is
    // asked for rather than invented - see validateAttributions.
    let shares: { workerId: number | null; allocation: Allocation | null; approved: number; rework: number; rejected: number; rate: number | null }[];
    if (allocations.length > 1) {
      const checked = validateAttributions(allocations, b.attributions, { approved, rework, rejected });
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      const byId = new Map(allocations.map((row) => [row.id, row]));
      const shareWorkers = await db.select().from(workers).where(inArray(workers.id, checked.rows.map((row) => byId.get(row.allocationId)!.workerId)));
      const workerById = new Map(shareWorkers.map((person) => [person.id, person]));
      shares = checked.rows
        .filter((row) => row.approved + row.rework + row.rejected > 0)
        .map((row) => {
          const allocation = byId.get(row.allocationId)!;
          const person = workerById.get(allocation.workerId);
          return {
            workerId: allocation.workerId,
            allocation,
            approved: row.approved,
            rework: row.rework,
            rejected: row.rejected,
            // The rate agreed with THIS worker for THIS stage, then the same
            // fallbacks that have always applied: the job rate, then their profile.
            rate: allocation.pieceRate ?? (person?.paymentType === "PER_PIECE" ? op.pieceRate ?? person.paymentRate : null),
          };
        });
      if (!shares.length)
        return NextResponse.json({ error: "Name which worker each judged garment belongs to." }, { status: 400 });
    } else {
      // One worker, or none: exactly the single inspection row this route has always
      // written. `workerId` stays NULL when the stage was never split, which is what
      // makes payroll fall back to production_operations.worker_id for every
      // inspection recorded before allocations existed.
      const only = allocations[0] ?? null;
      let rate = agreedRate;
      if (only) {
        const [person] = await db.select().from(workers).where(eq(workers.id, only.workerId)).limit(1);
        rate = only.pieceRate ?? (person?.paymentType === "PER_PIECE" ? op.pieceRate ?? person.paymentRate : null);
      }
      shares = [{ workerId: only?.workerId ?? null, allocation: only, approved, rework, rejected, rate }];
    }

    const actor = { userId: inspector.id, name: inspector.name };
    const updated = await db.transaction(async (tx) => {
      // 1. One inspection row per worker credited, so the audit trail says who made
      //    the pieces that were approved - and so pay follows the right person.
      //    Each row carries that worker's own rate snapshot.
      const recorded = await Promise.all(
        shares.map((share) =>
          tx.insert(stageInspections).values({
            productionOperationId: opId,
            workerId: share.workerId,
            inspectedBy: inspector.name,
            pieceRate: share.rate,
            quantityApproved: share.approved,
            quantityRework: share.rework,
            quantityRejected: share.rejected,
            notes: b.notes || null,
          }).returning({ id: stageInspections.id })
        )
      );

      // 2. Stage counters are DERIVED from the ledger, not incremented by hand.
      //    One event set per worker, each pointing at its own inspection row, so the
      //    stage total and the per-worker split can never disagree - the stage total
      //    IS the sum of the splits.
      const derived = await applyMovements(tx, op, actor, recorded.flatMap(([row], index) => {
        const share = shares[index];
        return [
          { type: MOVEMENT_EVENTS.INSPECTION_APPROVED, quantity: share.approved, workerId: share.workerId,
            referenceType: "STAGE_INSPECTION", referenceId: row.id,
            reason: "Inspection approved these pieces", notes: b.notes || null, occurredAt: new Date() },
          { type: MOVEMENT_EVENTS.INSPECTION_REWORK, quantity: share.rework, workerId: share.workerId,
            referenceType: "STAGE_INSPECTION", referenceId: row.id,
            reason: "Inspection sent these pieces back for rework", notes: b.notes || null, occurredAt: new Date() },
          { type: MOVEMENT_EVENTS.INSPECTION_REJECTED, quantity: share.rejected, workerId: share.workerId,
            referenceType: "STAGE_INSPECTION", referenceId: row.id,
            reason: "Inspection rejected these pieces", notes: b.notes || null, occurredAt: new Date() },
        ];
      }));

      // Each worker's own allocation is credited with what was judged of THEIR work,
      // so what they can still submit, and what they are owed, stays per person.
      for (const share of shares) {
        if (!share.allocation) continue;
        const allocation = share.allocation;
        const nextApproved = allocation.quantityApproved + share.approved;
        const nextRework = allocation.quantityRework + share.rework;
        const nextRejected = allocation.quantityRejected + share.rejected;
        const judged = nextApproved + nextRework + nextRejected;
        await tx.update(productionAllocations).set({
          quantityApproved: nextApproved,
          quantityRework: nextRework,
          quantityRejected: nextRejected,
          status: judged >= allocation.quantityAllocated && allocation.quantitySubmitted >= allocation.quantityAllocated
            ? "COMPLETED"
            : allocation.status,
        }).where(eq(productionAllocations.id, allocation.id));
      }

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
