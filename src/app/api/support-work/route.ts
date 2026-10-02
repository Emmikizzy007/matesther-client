import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
  supportAssignments,
  supportInspections,
  workers,
  orders,
  customers,
  productionOperations,
  productionBatches,
  orderItems,
  products,
} from "@/db/schema";
import { guard, getSessionUser, getLinkedWorkerId, ANYONE } from "@/lib/authz";
import { SUPPORT_OPERATIONS, SUPPORT_ROLE, sameRole } from "@/lib/format";
import { workerHoldsRole } from "@/lib/worker-roles";
import { supportPending, supportInspectionEarnings, supportInspectionRate } from "@/lib/support-work";

export const dynamic = "force-dynamic";

/**
 * Tailor support work: weaving, taping and other supporting garment work that a
 * tailor hands to a helper.
 *
 * The parent tailor keeps their own production_operations row - support work is
 * recorded alongside it, never in place of it.
 */

/** GET /api/support-work - a Worker sees only support work they are part of. */
export async function GET(req: Request) {
  const denied = await guard(req, ANYONE);
  if (denied) return denied;
  try {
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
    // A tailor signs in as a Worker, so a Worker needs both sides of the record:
    // work handed to them, and work they handed out for inspection.
    const myWorkerId = session.role === "WORKER" ? await getLinkedWorkerId(session) : null;

    const [assignments, people, orderRows, customerRows, ops, batches, items, garments] =
      await Promise.all([
        db.select().from(supportAssignments),
        db.select().from(workers),
        db.select().from(orders),
        db.select().from(customers),
        db.select().from(productionOperations),
        db.select().from(productionBatches),
        db.select().from(orderItems),
        db.select().from(products),
      ]);

    const personById = new Map(people.map((person) => [person.id, person]));
    const orderById = new Map(orderRows.map((order) => [order.id, order]));
    const customerById = new Map(customerRows.map((row) => [row.id, row]));
    const opById = new Map(ops.map((op) => [op.id, op]));
    const batchById = new Map(batches.map((batch) => [batch.id, batch]));
    const itemById = new Map(items.map((item) => [item.id, item]));
    const productById = new Map(garments.map((garment) => [garment.id, garment]));

    const rows = assignments
      .filter(
        (row) =>
          !myWorkerId || row.workerId === myWorkerId || row.assignedByWorkerId === myWorkerId
      )
      .map((row) => {
        const parent = row.productionOperationId ? opById.get(row.productionOperationId) : undefined;
        const batch = parent ? batchById.get(parent.productionBatchId) : undefined;
        const order = row.orderId ? orderById.get(row.orderId) : undefined;
        const garment = batch?.orderItemId
          ? productById.get(itemById.get(batch.orderItemId)?.productId ?? -1)
          : undefined;
        return {
          ...row,
          supportWorker: personById.get(row.workerId)?.name ?? "-",
          assignedBy: personById.get(row.assignedByWorkerId)?.name ?? "-",
          approvedBy: row.approvedByWorkerId ? personById.get(row.approvedByWorkerId)?.name ?? "-" : null,
          orderNumber: order?.orderNumber ?? "-",
          customer: order?.customerId ? customerById.get(order.customerId)?.name ?? "-" : "-",
          stage: parent?.stage ?? null,
          batchNumber: batch?.batchNumber ?? null,
          size: batch?.size ?? null,
          color: batch?.color ?? null,
          garment: garment?.name ?? null,
          pending: supportPending(row),
        };
      })
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));

    return NextResponse.json(rows, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Support work load failed", error);
    return NextResponse.json({ error: "Unable to load support work." }, { status: 500 });
  }
}

/** POST /api/support-work - the parent tailor (or the Owner) hands work out. */
export async function POST(req: Request) {
  const denied = await guard(req, ANYONE);
  if (denied) return denied;
  try {
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
    const body = await req.json();

    // Who is handing the work out? Only the Owner may name somebody else.
    const myWorkerId = await getLinkedWorkerId(session);
    const namedAssigner =
      session.role === "OWNER" && body.assignedByWorkerId ? Number(body.assignedByWorkerId) : null;
    const assignerId = namedAssigner ?? myWorkerId;
    if (assignerId === null || !Number.isSafeInteger(assignerId) || assignerId < 1)
      return NextResponse.json(
        { error: "Only a tailor with a worker record can hand out support work. Ask the Owner to record it." },
        { status: 400 }
      );

    const [assigner] = await db.select().from(workers).where(eq(workers.id, assignerId)).limit(1);
    if (!assigner || assigner.status !== "ACTIVE" || assigner.organizationId !== session.organizationId)
      return NextResponse.json({ error: "The assigning tailor must be an active Matesther worker." }, { status: 400 });

    const workerId = Number(body.workerId);
    if (!Number.isSafeInteger(workerId) || workerId < 1)
      return NextResponse.json({ error: "Choose the support worker." }, { status: 400 });
    if (workerId === assignerId)
      return NextResponse.json(
        { error: "A tailor cannot hand support work to themselves." },
        { status: 400 }
      );
    const [person] = await db.select().from(workers).where(eq(workers.id, workerId)).limit(1);
    if (!person || person.status !== "ACTIVE" || person.organizationId !== session.organizationId)
      return NextResponse.json({ error: "Choose an active Matesther worker." }, { status: 400 });
    if (!(await workerHoldsRole(person, SUPPORT_ROLE)))
      return NextResponse.json(
        { error: `${person.name} does not hold the ${SUPPORT_ROLE} role. Add it under Workers first.` },
        { status: 400 }
      );

    const operation = String(body.operation ?? "").trim();
    if (!SUPPORT_OPERATIONS.some((known) => sameRole(known, operation)))
      return NextResponse.json(
        { error: `Choose one of: ${SUPPORT_OPERATIONS.join(", ")}.` },
        { status: 400 }
      );

    const quantity = Number(body.quantityAssigned);
    if (!Number.isSafeInteger(quantity) || quantity < 1)
      return NextResponse.json({ error: "Enter how many pieces are being handed over." }, { status: 400 });

    const rate = body.pieceRate === undefined || body.pieceRate === "" ? 0 : Number(body.pieceRate);
    if (!Number.isSafeInteger(rate) || rate < 0)
      return NextResponse.json({ error: "The agreed rate must be a whole naira amount." }, { status: 400 });
    if (person.paymentType === "PER_PIECE" && rate < 1)
      return NextResponse.json(
        { error: `Enter the agreed per-piece rate for ${person.name} on this support work.` },
        { status: 400 }
      );

    const parentOperationId = body.productionOperationId ? Number(body.productionOperationId) : null;
    if (parentOperationId !== null && !Number.isSafeInteger(parentOperationId))
      return NextResponse.json({ error: "Choose a valid production job." }, { status: 400 });
    const parent = parentOperationId
      ? await db.select().from(productionOperations).where(eq(productionOperations.id, parentOperationId)).limit(1)
      : [];
    if (parentOperationId !== null && !parent[0])
      return NextResponse.json({ error: "That production job could not be found." }, { status: 404 });

    const orderId = parent[0]
      ? (await db.select().from(productionBatches).where(eq(productionBatches.id, parent[0].productionBatchId)).limit(1))[0]?.orderId ?? null
      : body.orderId
        ? Number(body.orderId)
        : null;

    const [created] = await db
      .insert(supportAssignments)
      .values({
        organizationId: session.organizationId,
        assignedByWorkerId: assignerId,
        workerId,
        productionOperationId: parentOperationId,
        orderId,
        operation,
        pieceRate: rate,
        quantityAssigned: quantity,
        status: "ASSIGNED",
        notes: body.notes ? String(body.notes).slice(0, 2000) : null,
      })
      .returning();
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error("Support work assignment failed", error);
    return NextResponse.json({ error: "Unable to record this support assignment." }, { status: 500 });
  }
}

/**
 * PUT /api/support-work
 *  { id, submitQty }                                        - the helper submits
 *  { id, quantityApproved, quantityRework, quantityRejected } - the tailor inspects
 *  { id, status: "CANCELLED" }                              - before anything is done
 *
 * A support worker can never approve their own work, whatever their login role.
 */
export async function PUT(req: Request) {
  const denied = await guard(req, ANYONE);
  if (denied) return denied;
  try {
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
    const body = await req.json();
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1)
      return NextResponse.json({ error: "Choose a support assignment." }, { status: 400 });
    const [assignment] = await db.select().from(supportAssignments).where(eq(supportAssignments.id, id)).limit(1);
    if (!assignment) return NextResponse.json({ error: "Support assignment not found." }, { status: 404 });

    const myWorkerId = await getLinkedWorkerId(session);
    const isSupervisor = session.role === "OWNER" || session.role === "PRODUCTION_MANAGER";
    const isAssigningTailor = !!myWorkerId && myWorkerId === assignment.assignedByWorkerId;
    const isSupportWorker = !!myWorkerId && myWorkerId === assignment.workerId;

    /* ---------- the support worker submits their own completed work ---------- */
    if (body.submitQty !== undefined) {
      if (!isSupportWorker)
        return NextResponse.json(
          { error: "Only the support worker who was given this work can submit it." },
          { status: 403 }
        );
      if (Object.keys(body).some((key) => !["id", "submitQty"].includes(key)))
        return NextResponse.json({ error: "Only your completed quantity can be submitted." }, { status: 403 });
      if (assignment.status === "CANCELLED")
        return NextResponse.json({ error: "This support assignment was cancelled." }, { status: 400 });
      const pending = supportPending(assignment);
      const available = Math.max(0, assignment.quantityAssigned - assignment.quantitySubmitted + pending);
      const qty = Number(body.submitQty);
      if (!Number.isSafeInteger(qty) || qty < 1 || qty > available)
        return NextResponse.json({ error: `You can submit between 1 and ${available} pieces.` }, { status: 400 });
      const [submitted] = await db
        .update(supportAssignments)
        .set({
          quantitySubmitted: assignment.quantitySubmitted + qty,
          status: "SUBMITTED",
          submittedAt: new Date(),
        })
        .where(eq(supportAssignments.id, id))
        .returning();
      return NextResponse.json(submitted);
    }

    /* ---------- inspection: the assigning tailor or a supervisor ---------- */
    if (body.quantityApproved !== undefined || body.quantityRework !== undefined || body.quantityRejected !== undefined) {
      if (!isSupervisor && !isAssigningTailor)
        return NextResponse.json(
          { error: "Only the tailor who handed out this work, a supervisor or the Owner can inspect it." },
          { status: 403 }
        );
      // Separation of duty: the person who did the work never approves it.
      if (isSupportWorker)
        return NextResponse.json(
          { error: "You cannot approve your own support work. Ask the tailor who assigned it, a supervisor or the Owner." },
          { status: 403 }
        );

      const approved = Number(body.quantityApproved ?? 0);
      const rework = Number(body.quantityRework ?? 0);
      const rejected = Number(body.quantityRejected ?? 0);
      if (![approved, rework, rejected].every((value) => Number.isSafeInteger(value) && value >= 0))
        return NextResponse.json({ error: "Quantities must be non-negative whole numbers." }, { status: 400 });
      if (approved + rework + rejected < 1)
        return NextResponse.json({ error: "Record at least one piece as approved, rework or rejected." }, { status: 400 });
      if ((rework > 0 || rejected > 0) && !String(body.notes ?? "").trim())
        return NextResponse.json({ error: "Rework or rejection needs a written reason." }, { status: 400 });

      const pending = supportPending(assignment);
      if (approved + rework + rejected > pending)
        return NextResponse.json(
          { error: `Only ${pending} piece${pending === 1 ? "" : "s"} are awaiting inspection.` },
          { status: 400 }
        );

      const [person] = await db.select().from(workers).where(eq(workers.id, assignment.workerId)).limit(1);
      const inspectorWorkerId = isSupervisor && !isAssigningTailor ? null : myWorkerId;

      const [inspection] = await db
        .insert(supportInspections)
        .values({
          supportAssignmentId: id,
          inspectedBy: session.name,
          // Snapshot the agreed rate so pay history survives a later change.
          pieceRate: assignment.pieceRate,
          quantityApproved: approved,
          quantityRework: rework,
          quantityRejected: rejected,
          notes: body.notes ? String(body.notes).slice(0, 2000) : null,
        })
        .returning();

      const totals = {
        quantityApproved: assignment.quantityApproved + approved,
        quantityRework: assignment.quantityRework + rework,
        quantityRejected: assignment.quantityRejected + rejected,
      };
      const remainingPending = Math.max(0, assignment.quantitySubmitted - (totals.quantityApproved + totals.quantityRework + totals.quantityRejected));
      const [updated] = await db
        .update(supportAssignments)
        .set({
          ...totals,
          status: remainingPending > 0 ? "SUBMITTED" : rework > 0 && approved === 0 ? "REWORK" : "APPROVED",
          inspectedAt: new Date(),
          approvedByWorkerId: inspectorWorkerId ?? assignment.approvedByWorkerId,
        })
        .where(eq(supportAssignments.id, id))
        .returning();

      return NextResponse.json(
        {
          ...inspection,
          assignment: updated,
          // What this inspection makes payable, so the UI and payroll agree.
          payable: person
            ? supportInspectionEarnings(inspection, assignment, person)
            : 0,
          pieceRatePaid: person ? supportInspectionRate(inspection, assignment, person) : assignment.pieceRate,
        },
        { status: 201 }
      );
    }

    /* ---------- cancel, only while nothing has been done ---------- */
    if (body.status === "CANCELLED") {
      if (!isSupervisor && !isAssigningTailor)
        return NextResponse.json({ error: "Only the assigning tailor, a supervisor or the Owner can cancel." }, { status: 403 });
      if (assignment.quantitySubmitted > 0)
        return NextResponse.json(
          { error: "Work has already been submitted. Inspect it instead of cancelling, so the history stays intact." },
          { status: 400 }
        );
      const [updated] = await db
        .update(supportAssignments)
        .set({ status: "CANCELLED" })
        .where(eq(supportAssignments.id, id))
        .returning();
      return NextResponse.json(updated);
    }

    return NextResponse.json({ error: "Submit a quantity, or record an inspection." }, { status: 400 });
  } catch (error) {
    console.error("Support work update failed", error);
    return NextResponse.json({ error: "Unable to update this support assignment." }, { status: 500 });
  }
}
