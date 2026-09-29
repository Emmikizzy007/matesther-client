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
import { eq, and, desc } from "drizzle-orm";
import { refreshBatchAndOrder } from "@/lib/server";
import { guard, getSessionUser, getLinkedWorkerId, ANYONE, STAFF } from "@/lib/authz";

/**
 * GET /api/inspections?operationId=&orderId=
 * Inspection audit trail (never overwritten - every inspection is a row).
 */
export async function GET(req: Request) {
  const __g = await guard(req, ANYONE);
  if (__g) return __g;
  const __user = await getSessionUser(req);
  if (__user?.role === "WORKER" && (await getLinkedWorkerId(__user)) === null)
    return NextResponse.json([], { headers: { "Cache-Control": "private, no-store" } });
  try {
    const { searchParams } = new URL(req.url);
    const operationId = searchParams.get("operationId");
    const orderId = searchParams.get("orderId");
    const limit = Number(searchParams.get("limit") || 100);

    const [rows, ops, batches, orderRows, customerRows, workerRows] =
      await Promise.all([
        db.select().from(stageInspections).orderBy(desc(stageInspections.inspectedAt)).limit(limit),
        db.select().from(productionOperations),
        db.select().from(productionBatches),
        db.select().from(orders),
        db.select().from(customers),
        db.select().from(workers),
      ]);
    const opMap = new Map(ops.map((o) => [o.id, o]));
    const bMap = new Map(batches.map((b) => [b.id, b]));
    const oMap = new Map(orderRows.map((o) => [o.id, o]));
    const cMap = new Map(customerRows.map((c) => [c.id, c]));
    const wMap = new Map(workerRows.map((w) => [w.id, w]));

    let data = rows.map((r) => {
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
    // Workers only see inspection history on their own jobs
    if (__user?.role === "WORKER") {
      const __wid = await getLinkedWorkerId(__user);
      data = data.filter((d: any) => opMap.get(d.productionOperationId)?.workerId === __wid);
    }
    if (operationId) data = data.filter((d) => d.productionOperationId === Number(operationId));
    if (orderId) data = data.filter((d) => d.orderId === Number(orderId));
    return NextResponse.json(data);
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
    if (!b.inspectedBy)
      return NextResponse.json({ error: "Inspector name is required." }, { status: 400 });

    const [op] = await db
      .select()
      .from(productionOperations)
      .where(eq(productionOperations.id, opId));
    if (!op) return NextResponse.json({ error: "Operation not found." }, { status: 404 });
    const [assigned] = op.workerId ? await db.select().from(workers).where(eq(workers.id, op.workerId)).limit(1) : [];
    const agreedRate = assigned?.paymentType === "PER_PIECE" ? op.pieceRate ?? assigned.paymentRate : null;

    const pending = (op.quantityCompleted ?? 0) - (op.quantityInspected ?? 0);
    if (total > pending)
      return NextResponse.json(
        { error: `Only ${pending} piece(s) are awaiting inspection - you cannot inspect ${total}.` },
        { status: 400 }
      );

    // 1. Record the inspection (audit trail)
    await db.insert(stageInspections).values({
      productionOperationId: opId,
      inspectedBy: String(b.inspectedBy),
      pieceRate: agreedRate,
      quantityApproved: approved,
      quantityRework: rework,
      quantityRejected: rejected,
      notes: b.notes || null,
    });

    // 2. Update stage counters
    const newApproved = (op.quantityApproved ?? 0) + approved;
    const newRemaining = Math.max(0, (op.quantityReceived ?? 0) - newApproved - (op.quantityRejected ?? 0) - rejected);
    const uninspected = (op.quantityCompleted ?? 0) - (op.quantityInspected ?? 0) - total;
    const status =
      newRemaining <= 0
        ? "COMPLETED"
        : uninspected > 0
          ? "SUBMITTED"
          : "IN_PROGRESS";

    const [updated] = await db
      .update(productionOperations)
      .set({
        quantityInspected: (op.quantityInspected ?? 0) + total,
        quantityApproved: newApproved,
        quantityRework: (op.quantityRework ?? 0) + rework,
        quantityRejected: (op.quantityRejected ?? 0) + rejected,
        quantityRemaining: newRemaining,
        inspector: String(b.inspectedBy),
        inspectedAt: new Date(),
        status,
        completedAt: newRemaining <= 0 ? op.completedAt ?? new Date() : null,
      })
      .where(eq(productionOperations.id, opId))
      .returning();

    // 3. Only approved pieces move to the next stage
    const STAGE_ORDER = ["CUTTING", "SEWING", "MONOGRAMMING", "BUTTONHOLE", "BUTTON_TACKING", "IRONING", "PACKING", "DELIVERY"];
    if (approved > 0) {
      const idx = STAGE_ORDER.indexOf(op.stage);
      if (idx >= 0 && idx < STAGE_ORDER.length - 1) {
        const siblings = await db
          .select()
          .from(productionOperations)
          .where(eq(productionOperations.productionBatchId, op.productionBatchId));
        const next = siblings.find((s) => s.stage === STAGE_ORDER[idx + 1]);
        if (next && newApproved > (next.quantityReceived ?? 0)) {
          await db
            .update(productionOperations)
            .set({
              quantityReceived: newApproved,
              quantityRemaining: Math.max(0, newApproved - (next.quantityApproved ?? 0) - (next.quantityRejected ?? 0)),
            })
            .where(eq(productionOperations.id, next.id));
        }
      }
    }

    await refreshBatchAndOrder(op.productionBatchId);
    return NextResponse.json(updated, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}
