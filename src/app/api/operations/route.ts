import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  productionOperations,
  productionBatches,
  orders,
  customers,
  workers,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { refreshBatchAndOrder } from "@/lib/server";
import { guard, getSessionUser, getLinkedWorkerId, ANYONE } from "@/lib/authz";

/**
 * GET /api/operations?status=&orderId=&workerId=
 * All production job steps with inspection counters.
 */
export async function GET(req: Request) {
  const __g = await guard(req, ANYONE);
  if (__g) return __g;
  const __user = await getSessionUser(req);
  const __onlyMyJobs = __user?.role === "WORKER" ? await getLinkedWorkerId(__user) : null;
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const orderId = searchParams.get("orderId");
    const workerId = searchParams.get("workerId");

    const [opRows, batchRows, orderRows, customerRows, workerRows] =
      await Promise.all([
        db.select().from(productionOperations),
        db.select().from(productionBatches),
        db.select().from(orders),
        db.select().from(customers),
        db.select().from(workers),
      ]);
    const bMap = new Map(batchRows.map((b) => [b.id, b]));
    const oMap = new Map(orderRows.map((o) => [o.id, o]));
    const cMap = new Map(customerRows.map((c) => [c.id, c]));
    const wMap = new Map(workerRows.map((w) => [w.id, w]));

    let rows = opRows.map((o) => {
      const batch = bMap.get(o.productionBatchId);
      const order = batch ? oMap.get(batch.orderId) : undefined;
      return {
        ...o,
        pendingInspection: Math.max(
          0,
          (o.quantityCompleted ?? 0) - (o.quantityInspected ?? 0)
        ),
        batchNumber: batch?.batchNumber ?? "-",
        batchQuantity: batch?.quantity ?? 0,
        orderId: order?.id ?? null,
        orderNumber: order?.orderNumber ?? "-",
        dueDate: order?.dueDate ?? null,
        customer: cMap.get(order?.customerId ?? -1)?.name ?? "-",
        workerName: wMap.get(o.workerId ?? -1)?.name ?? null,
      };
    });
    if (status) rows = rows.filter((r) => r.status === status);
    if (orderId) rows = rows.filter((r) => r.orderId === Number(orderId));
    if (workerId) rows = rows.filter((r) => r.workerId === Number(workerId));
    if (__onlyMyJobs !== null)
      rows = rows.filter((r) => r.workerId === __onlyMyJobs);
    return NextResponse.json(rows);
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

/**
 * PUT /api/operations
 * - Workers: submit finished pieces for inspection  { id, submitQty }  or  { id, status: "SUBMITTED" }
 * - Manager/Owner: assign worker, set status, dates, notes
 *
 * A stage can NEVER be marked COMPLETED without inspection approval.
 */
export async function PUT(req: Request) {
  const denied = await guard(req, ANYONE);
  if (denied) return denied;
  try {
    const b = await req.json();
    const id = Number(b.id);
    const [existing] = await db
      .select()
      .from(productionOperations)
      .where(eq(productionOperations.id, id));
    if (!existing) return NextResponse.json({ error: "Operation not found." }, { status: 404 });

    // A worker may only submit finished garments on their own active job.
    const sessionUser = await getSessionUser(req);
    if (sessionUser?.role === "WORKER") {
      const workerId = await getLinkedWorkerId(sessionUser);
      if (!workerId || existing.workerId !== workerId)
        return NextResponse.json({ error: "You can only submit your own assigned jobs." }, { status: 403 });
      if (Object.keys(b).some((key) => !["id", "submitQty"].includes(key)))
        return NextResponse.json(
          { error: "Workers can only submit a quantity for inspection. The Owner or Project Manager handles assignments and approvals." },
          { status: 403 }
        );
      if (!["IN_PROGRESS", "SUBMITTED"].includes(existing.status))
        return NextResponse.json({ error: "This job is not active. Contact your supervisor." }, { status: 400 });
      const pendingInspection = Math.max(0, (existing.quantityCompleted ?? 0) - (existing.quantityInspected ?? 0));
      const available = Math.max(0, (existing.quantityRemaining ?? 0) - pendingInspection);
      const qty = Number(b.submitQty);
      if (!Number.isInteger(qty) || qty <= 0 || qty > available)
        return NextResponse.json(
          { error: `You can submit between 1 and ${available} pieces for this job.` },
          { status: 400 }
        );
    }

    let completed = existing.quantityCompleted ?? 0;
    let received = existing.quantityReceived ?? 0;
    let rejected = existing.quantityRejected ?? 0;
    let status = existing.status;
    let submittedAt = existing.submittedAt ?? null;

    // Worker: submit N more pieces for inspection
    if (b.submitQty !== undefined && Number(b.submitQty) > 0) {
      const n = Number(b.submitQty);
      completed += n;
      status = "SUBMITTED";
      submittedAt = new Date();
    } else {
      if (b.quantityReceived !== undefined) received = Math.max(0, Number(b.quantityReceived));
      if (b.quantityCompleted !== undefined) completed = Math.max(0, Number(b.quantityCompleted));
      if (b.quantityRejected !== undefined) rejected = Math.max(0, Number(b.quantityRejected));
      if (b.status) {
        if (b.status === "SUBMITTED") {
          status = "SUBMITTED";
          if (completed > (existing.quantityInspected ?? 0)) submittedAt = new Date();
        } else if (b.status === "COMPLETED") {
          // Quality gate: completion requires inspection approval
          const approved = existing.quantityApproved ?? 0;
          const remaining = Math.max(0, received - approved - rejected);
          if (approved <= 0 || remaining > 0)
            return NextResponse.json(
              {
                error:
                  "This stage cannot be completed yet - the Project Manager or Owner must first inspect and approve all submitted pieces (Inspection Queue).",
              },
              { status: 400 }
            );
          status = "COMPLETED";
        } else {
          status = b.status;
        }
      }
    }

    const remaining = Math.max(0, received - (existing.quantityApproved ?? 0) - rejected);

    const [row] = await db
      .update(productionOperations)
      .set({
        workerId:
          b.workerId !== undefined ? (b.workerId ? Number(b.workerId) : null) : existing.workerId,
        quantityReceived: received,
        quantityCompleted: completed,
        quantityRejected: rejected,
        quantityRemaining: remaining,
        status,
        submittedAt,
        expectedCompletionDate:
          b.expectedCompletionDate !== undefined
            ? b.expectedCompletionDate || null
            : existing.expectedCompletionDate,
        completedAt:
          status === "COMPLETED" ? existing.completedAt ?? new Date() : null,
        notes: b.notes !== undefined ? b.notes : existing.notes,
      })
      .where(eq(productionOperations.id, id))
      .returning();

    await refreshBatchAndOrder(existing.productionBatchId);
    return NextResponse.json(row);
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}
