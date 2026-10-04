import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  customers,
  externalWorkOrders,
  orderItemSizes,
  orders,
  productionBatches,
  productionMovements,
  productionOperations,
} from "@/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { refreshBatchAndOrder } from "@/lib/server";
import { guard, getSessionUser, ANYONE, STAFF } from "@/lib/authz";
import { EXTERNAL_METHODS, isExternalMethod, methodLabel, variantLabel } from "@/lib/format";
import {
  MOVEMENT_EVENTS,
  applyMovements,
  deriveDetail,
  deriveQuantities,
} from "@/lib/production-ledger";
import { releaseApprovedToNextStage, statusFromQuantities } from "@/lib/production-route";

export const dynamic = "force-dynamic";

/**
 * EXTERNAL PRODUCTION WORK: sent out, came back, judged.
 *
 * A stage whose method is OUTSOURCED, VENDOR_PROCESSING or MACHINE is still an
 * ordinary `production_operations` row with the same counters, the same place in
 * the route and the same acceptance gate. This route records the shipments behind
 * it, because one stage can be sent out several times and each dispatch has its own
 * outcome.
 *
 * THE FOUR FIGURES ARE FOUR DIFFERENT FACTS
 *   quantity_sent      what left the factory
 *   quantity_returned  what physically came back
 *   quantity_accepted  what MATESTHER judged good on return
 *   quantity_rejected  what came back damaged or wrong
 *   quantity_short     what never came back at all
 *
 * 100 sent / 96 returned / 94 accepted / 2 rejected / 2 short is a perfectly
 * normal outcome and every one of those numbers is kept. Nothing here assumes sent
 * equals returned, or returned equals accepted.
 *
 * ONLY `quantity_accepted` is released to the next route stage, and it is released
 * through the production movement ledger by the same `releaseApprovedToNextStage`
 * that internal inspection uses - so there is exactly one rule for "approved work
 * moves on", not one per production method.
 *
 * Vendors are NOT workers. Payroll iterates every worker to build accruals, so a
 * vendor placed in `workers` would accrue phantom piecework forever. External cost
 * lives on the dispatch (and in `expenses` / `material_purchases` where it already
 * does); a vendor master with payment terms is an open decision flagged for Task 4.
 */

/** Enrich a dispatch with the batch, variant, order and school behind it. */
async function enrich(rows: typeof externalWorkOrders.$inferSelect[]) {
  if (!rows.length) return [];
  const opIds = [...new Set(rows.map((row) => row.productionOperationId))];
  const batchIds = [...new Set(rows.map((row) => row.productionBatchId))];
  const [ops, batches] = await Promise.all([
    opIds.length
      ? db.select({ id: productionOperations.id, stage: productionOperations.stage, method: productionOperations.method,
          routePosition: productionOperations.routePosition, quantityReceived: productionOperations.quantityReceived,
          quantityApproved: productionOperations.quantityApproved, quantityRemaining: productionOperations.quantityRemaining,
          status: productionOperations.status })
        .from(productionOperations).where(inArray(productionOperations.id, opIds))
      : [],
    batchIds.length
      ? db.select({ id: productionBatches.id, batchNumber: productionBatches.batchNumber, orderId: productionBatches.orderId,
          orderVariantId: productionBatches.orderVariantId, size: productionBatches.size, color: productionBatches.color,
          quantity: productionBatches.quantity })
        .from(productionBatches).where(inArray(productionBatches.id, batchIds))
      : [],
  ]);
  const opById = new Map(ops.map((op) => [op.id, op]));
  const batchById = new Map(batches.map((batch) => [batch.id, batch]));
  const orderIds = [...new Set(batches.map((batch) => batch.orderId))];
  const variantIds = [...new Set(batches.map((batch) => batch.orderVariantId).filter((v): v is number => !!v))];
  const [orderRows, variantRows] = await Promise.all([
    orderIds.length
      ? db.select({ id: orders.id, orderNumber: orders.orderNumber, customerId: orders.customerId, dueDate: orders.dueDate })
        .from(orders).where(inArray(orders.id, orderIds))
      : [],
    variantIds.length
      ? db.select({ id: orderItemSizes.id, size: orderItemSizes.size, color: orderItemSizes.color, quantity: orderItemSizes.quantity })
        .from(orderItemSizes).where(inArray(orderItemSizes.id, variantIds))
      : [],
  ]);
  const orderById = new Map(orderRows.map((order) => [order.id, order]));
  const variantById = new Map(variantRows.map((variant) => [variant.id, variant]));
  const customerIds = [...new Set(orderRows.map((order) => order.customerId).filter((v): v is number => !!v))];
  const customerRows = customerIds.length
    ? await db.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, customerIds))
    : [];
  const customerById = new Map(customerRows.map((customer) => [customer.id, customer.name]));

  return rows.map((row) => {
    const batch = batchById.get(row.productionBatchId);
    const order = batch ? orderById.get(batch.orderId) : undefined;
    const variant = batch?.orderVariantId ? variantById.get(batch.orderVariantId) : undefined;
    const op = opById.get(row.productionOperationId);
    return {
      ...row,
      methodLabel: methodLabel(row.method),
      batchNumber: batch?.batchNumber ?? "-",
      batchQuantity: batch?.quantity ?? 0,
      // The exact garment this dispatch is about, not the whole order.
      size: variant?.size ?? batch?.size ?? null,
      color: variant?.color ?? batch?.color ?? null,
      variant: variantLabel(variant?.size ?? batch?.size, variant?.color ?? batch?.color),
      orderId: order?.id ?? null,
      orderNumber: order?.orderNumber ?? "-",
      dueDate: order?.dueDate ?? null,
      customer: order ? customerById.get(order.customerId ?? -1) ?? "-" : "-",
      operationStatus: op?.status ?? null,
      stageApproved: op?.quantityApproved ?? 0,
      stageRemaining: op?.quantityRemaining ?? 0,
    };
  });
}

/** GET /api/external-work?operationId=&batchId=&status= */
export async function GET(req: Request) {
  const denied = await guard(req, ANYONE);
  if (denied) return denied;
  try {
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
    const query = new URL(req.url).searchParams;
    const operationId = query.get("operationId") ? Number(query.get("operationId")) : null;
    const batchId = query.get("batchId") ? Number(query.get("batchId")) : null;
    const status = query.get("status") ? String(query.get("status")).toUpperCase() : null;

    // This is a supervisor's record of what left the factory and what came back.
    // A Worker has no part in sending work out or accepting it, and an external
    // stage carries no worker of its own, so a Worker session gets an empty list
    // rather than a filtered one - there is nothing of theirs to filter.
    if (session.role === "WORKER")
      return NextResponse.json([], { headers: { "Cache-Control": "private, no-store" } });
    const rows = await db
      .select()
      .from(externalWorkOrders)
      .where(
        and(
          operationId ? eq(externalWorkOrders.productionOperationId, operationId) : undefined,
          batchId ? eq(externalWorkOrders.productionBatchId, batchId) : undefined,
          status ? eq(externalWorkOrders.status, status) : undefined
        )
      )
      .orderBy(desc(externalWorkOrders.sentAt), desc(externalWorkOrders.id));
    const shaped = await enrich(rows);
    return NextResponse.json(shaped, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("External work load failed", error);
    return NextResponse.json({ error: "Could not load external production work." }, { status: 500 });
  }
}

/**
 * POST /api/external-work - send work out.
 * { operationId, vendorName, quantitySent, unitCost?, totalCost?, notes? }
 */
export async function POST(req: Request) {
  const denied = await guard(req, STAFF);
  if (denied) return denied;
  try {
    const body = await req.json();
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

    const operationId = Number(body.operationId);
    if (!Number.isSafeInteger(operationId) || operationId < 1)
      return NextResponse.json({ error: "Choose the production stage being sent out." }, { status: 400 });
    const [op] = await db.select().from(productionOperations).where(eq(productionOperations.id, operationId)).limit(1);
    if (!op) return NextResponse.json({ error: "Production stage not found." }, { status: 404 });
    if (!isExternalMethod(op.method))
      return NextResponse.json({
        error: `${op.stage.replaceAll("_", " ")} on this batch is produced ${methodLabel(op.method).toLowerCase()}, not outside the factory. `
          + `Only a stage whose method is ${EXTERNAL_METHODS.map(methodLabel).join(", ")} can be sent out.`,
      }, { status: 400 });

    const vendorName = String(body.vendorName ?? "").trim();
    if (!vendorName)
      return NextResponse.json({ error: "Record who the work is going to. The name is kept on the audit trail." }, { status: 400 });
    if (vendorName.length > 160)
      return NextResponse.json({ error: "Keep the vendor name under 160 characters." }, { status: 400 });

    const quantitySent = Number(body.quantitySent);
    if (!Number.isSafeInteger(quantitySent) || quantitySent < 1)
      return NextResponse.json({ error: "Enter how many garments are going out, as a whole number." }, { status: 400 });

    // What is genuinely free to send: what the stage holds, minus what is already
    // out and unresolved. Without the second half, the same garments could be
    // dispatched twice and come back double.
    const derived = await deriveDetail(db, op.id);
    const open = await db
      .select()
      .from(externalWorkOrders)
      .where(and(eq(externalWorkOrders.productionOperationId, op.id), eq(externalWorkOrders.status, "SENT")));
    const alreadyOut = open.reduce((sum, row) => sum + Math.max(0, row.quantitySent - row.quantityReturned - row.quantityShort), 0);
    const freeToSend = Math.max(0, derived.quantityRemaining - alreadyOut);
    if (quantitySent > freeToSend)
      return NextResponse.json({
        error: freeToSend > 0
          ? `Only ${freeToSend} garment(s) are available to send out from this stage. ${alreadyOut} are already out and not yet accounted for.`
          : `Nothing is available to send out from this stage. It holds ${derived.quantityReceived} and ${alreadyOut} are already out awaiting return.`,
      }, { status: 400 });

    const unitCost = body.unitCost === undefined || body.unitCost === "" || body.unitCost === null ? null : Number(body.unitCost);
    if (unitCost !== null && (!Number.isFinite(unitCost) || unitCost < 0))
      return NextResponse.json({ error: "The cost per garment must be zero or more." }, { status: 400 });
    const totalCost = body.totalCost === undefined || body.totalCost === "" || body.totalCost === null
      ? (unitCost === null ? null : unitCost * quantitySent)
      : Number(body.totalCost);
    if (totalCost !== null && (!Number.isFinite(totalCost) || totalCost < 0))
      return NextResponse.json({ error: "The total cost must be zero or more." }, { status: 400 });

    // What Matesther will owe the vendor, and when the work was promised back. Both are
    // recorded AT DISPATCH so a bill still owing and a vendor running late are visible
    // without anybody having to remember them. Payable defaults to the cost of the work.
    const amountPayable = body.amountPayable === undefined || body.amountPayable === "" || body.amountPayable === null
      ? (totalCost === null ? null : Math.round(totalCost))
      : Number(body.amountPayable);
    if (amountPayable !== null && (!Number.isSafeInteger(amountPayable) || amountPayable < 0))
      return NextResponse.json({ error: "The amount payable must be a whole naira amount." }, { status: 400 });
    if (amountPayable !== null && totalCost !== null && amountPayable > Math.round(totalCost))
      return NextResponse.json({
        error: `The vendor cannot be owed more (${amountPayable}) than the work costs (${Math.round(totalCost)}).`,
      }, { status: 400 });
    const expectedReturnAt = body.expectedReturnAt === undefined || body.expectedReturnAt === "" || body.expectedReturnAt === null
      ? null
      : new Date(String(body.expectedReturnAt));
    if (body.expectedReturnAt && (!expectedReturnAt || Number.isNaN(expectedReturnAt.getTime())))
      return NextResponse.json({ error: "Enter the expected return date as a real date." }, { status: 400 });

    const actor = { userId: session.id, name: session.name };

    const created = await db.transaction(async (tx) => {
      const [dispatch] = await tx.insert(externalWorkOrders).values({
        organizationId: session.organizationId,
        productionOperationId: op.id,
        productionBatchId: op.productionBatchId,
        stage: op.stage,
        method: op.method,
        vendorName,
        quantitySent,
        unitCost,
        totalCost,
        amountPayable,
        expectedReturnAt,
        status: "SENT",
        sentBy: session.name,
        notes: body.notes ? String(body.notes).slice(0, 2000) : null,
      }).returning();

      // EXTERNAL_SENT is in no derived bucket on purpose: sending work out is not
      // production. It is on the ledger so the dispatch is auditable, and it moves
      // no counter - which is what stops a stage looking further along than it is
      // merely because garments left the building.
      await applyMovements(tx, op, actor, [{
        type: MOVEMENT_EVENTS.EXTERNAL_SENT,
        quantity: quantitySent,
        workerId: op.workerId,
        referenceType: "EXTERNAL_WORK_ORDER",
        referenceId: dispatch.id,
        reason: `${quantitySent} garment(s) sent to ${vendorName} for ${methodLabel(op.method).toLowerCase()}`,
        notes: body.notes ? String(body.notes).slice(0, 2000) : null,
      }]);
      if (op.status === "PENDING") {
        await tx.update(productionOperations).set({ status: "IN_PROGRESS" })
          .where(and(eq(productionOperations.id, op.id), eq(productionOperations.status, "PENDING")));
      }
      return dispatch;
    });
    await refreshBatchAndOrder(op.productionBatchId);
    const [shaped] = await enrich([created]);
    return NextResponse.json(shaped ?? created, { status: 201 });
  } catch (error) {
    console.error("External dispatch failed", error);
    return NextResponse.json({ error: "Could not record this dispatch." }, { status: 500 });
  }
}

/**
 * PUT /api/external-work - record what came back and what MATESTHER accepted.
 * { id, quantityReturned, quantityAccepted?, quantityRejected?, quantityShort?, notes? }
 *
 * The four figures are cumulative for this dispatch. Each increase becomes a signed
 * ledger event; a DECREASE is refused, because un-accepting returned work would be
 * the same silent rewrite of history that Task 2 removed from the stage counters.
 */
export async function PUT(req: Request) {
  const denied = await guard(req, STAFF);
  if (denied) return denied;
  try {
    const body = await req.json();
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1)
      return NextResponse.json({ error: "Choose the dispatch to record against." }, { status: 400 });
    const [dispatch] = await db.select().from(externalWorkOrders).where(eq(externalWorkOrders.id, id)).limit(1);
    if (!dispatch) return NextResponse.json({ error: "Dispatch not found." }, { status: 404 });
    if (dispatch.status === "CLOSED")
      return NextResponse.json({ error: "This dispatch is already fully accounted for. Send a new one for anything still outstanding." }, { status: 400 });
    const [op] = await db.select().from(productionOperations).where(eq(productionOperations.id, dispatch.productionOperationId)).limit(1);
    if (!op) return NextResponse.json({ error: "The production stage behind this dispatch no longer exists." }, { status: 404 });

    // Separation of duties, the same rule POST /api/inspections applies: a
    // supervisor who is also on the factory floor may not be the only person
    // judging work. Accepting returned goods is that judgement, so a Production
    // Manager may not accept a dispatch they themselves sent. The Owner may, and
    // the sender is recorded either way.
    if (session.role === "PRODUCTION_MANAGER" && dispatch.sentBy) {
      const [sent] = await db
        .select({ actorUserId: productionMovements.actorUserId })
        .from(productionMovements)
        .where(
          and(
            eq(productionMovements.referenceType, "EXTERNAL_WORK_ORDER"),
            eq(productionMovements.referenceId, dispatch.id),
            eq(productionMovements.eventType, MOVEMENT_EVENTS.EXTERNAL_SENT)
          )
        )
        .limit(1);
      if (sent?.actorUserId && sent.actorUserId === session.id)
        return NextResponse.json({
          error: "You sent this work out, so you cannot be the one to accept it back. Ask the Owner or another supervisor.",
        }, { status: 403 });
    }

    const read = (field: string, current: number) =>
      body[field] === undefined || body[field] === "" || body[field] === null ? current : Number(body[field]);
    const returned = read("quantityReturned", dispatch.quantityReturned);
    const accepted = read("quantityAccepted", dispatch.quantityAccepted);
    const rejected = read("quantityRejected", dispatch.quantityRejected);
    const short = read("quantityShort", dispatch.quantityShort);
    if (![returned, accepted, rejected, short].every((value) => Number.isSafeInteger(value) && value >= 0))
      return NextResponse.json({ error: "Quantities must be non-negative whole garments." }, { status: 400 });

    for (const [label, next, previous] of [
      ["returned", returned, dispatch.quantityReturned],
      ["accepted", accepted, dispatch.quantityAccepted],
      ["rejected", rejected, dispatch.quantityRejected],
      ["short", short, dispatch.quantityShort],
    ] as const) {
      if (next < previous)
        return NextResponse.json({
          error: `Garments already recorded as ${label} (${previous}) cannot be un-recorded (${next}). Record a correction with a reason instead of shrinking an accepted figure.`,
        }, { status: 400 });
    }
    if (returned > dispatch.quantitySent)
      return NextResponse.json({ error: `Only ${dispatch.quantitySent} garment(s) were sent on this dispatch, so no more than that can come back.` }, { status: 400 });
    if (accepted + rejected > returned)
      return NextResponse.json({ error: `${accepted + rejected} garments judged but only ${returned} came back. Record the return first.` }, { status: 400 });
    if (short > dispatch.quantitySent - returned)
      return NextResponse.json({
        error: `${dispatch.quantitySent - returned} garment(s) are unaccounted for, so no more than that can be recorded as short.`,
      }, { status: 400 });
    if ((rejected > 0 || short > 0) && !String(body.notes ?? dispatch.notes ?? "").trim())
      return NextResponse.json({ error: "Explain what was damaged or did not come back." }, { status: 400 });

    /* ---------- what the vendor is owed, and what has been paid ----------
     *
     * A vendor is not a worker. This is an EXTERNAL PRODUCTION COST with its own
     * payable, its own payments and its own reference - it never enters payroll and
     * never creates a worker_payments row. Paying a vendor is also not the same event
     * as accepting the goods back, so the two are recorded separately: work can be
     * accepted and still unpaid, or paid on account before it returns.
     */
    const readMoney = (field: string, current: number | null) => {
      const raw = body[field];
      if (raw === undefined || raw === "") return current;
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 0)
        throw Object.assign(new Error(`${field} must be a whole naira amount.`), { status: 400 });
      return value;
    };
    let totalCost: number | null;
    let amountPayable: number | null;
    let amountPaid: number | null;
    let paymentReference: string | null;
    let paidAt: Date | null;
    try {
      totalCost = readMoney("totalCost", dispatch.totalCost);
      // What is owed defaults to the agreed cost of the work, so a dispatch is never
      // silently recorded as costing nothing to pay.
      amountPayable = readMoney("amountPayable", dispatch.amountPayable ?? dispatch.totalCost);
      amountPaid = readMoney("amountPaid", dispatch.amountPaid);
      paymentReference = body.paymentReference === undefined
        ? dispatch.paymentReference
        : String(body.paymentReference).trim().slice(0, 200) || null;
      paidAt = dispatch.paidAt;
    } catch (error: any) {
      return NextResponse.json({ error: error?.message ?? "Enter whole naira amounts." }, { status: 400 });
    }
    if (amountPayable !== null && totalCost !== null && amountPayable > totalCost)
      return NextResponse.json({
        error: `The vendor cannot be owed more (${amountPayable}) than the work costs (${totalCost}).`,
      }, { status: 400 });
    if (amountPaid !== null && amountPayable !== null && amountPaid > amountPayable)
      return NextResponse.json({
        error: `Only ${amountPayable} is owed on this dispatch, so no more than that can be recorded as paid.`,
      }, { status: 400 });
    // Money already sent to a vendor is a fact. It can be added to, never quietly
    // reduced - the same rule that protects an accepted quantity.
    if (amountPaid !== null && dispatch.amountPaid !== null && amountPaid < dispatch.amountPaid)
      return NextResponse.json({
        error: `Already paid ${dispatch.amountPaid} on this dispatch, which cannot be un-paid (${amountPaid}). Record the difference with a reason instead.`,
      }, { status: 400 });
    if (amountPaid !== null && amountPaid > (dispatch.amountPaid ?? 0)) {
      paidAt = dispatch.paidAt ?? new Date();
      if (!paymentReference && body.paymentReference !== undefined)
        return NextResponse.json({ error: "A payment needs its bank reference so it can be matched." }, { status: 400 });
    }
    /**
     * Whether the vendor's bill on this dispatch is settled. Reported, never stored, so
     * it can never disagree with the two amounts it comes from.
     */
    const settled = amountPayable !== null && (amountPaid ?? 0) >= amountPayable;
    const expectedReturnAt = body.expectedReturnAt === undefined || body.expectedReturnAt === "" || body.expectedReturnAt === null
      ? dispatch.expectedReturnAt
      : new Date(String(body.expectedReturnAt));
    if (body.expectedReturnAt && Number.isNaN(expectedReturnAt?.getTime() ?? NaN))
      return NextResponse.json({ error: "Enter the expected return date as a real date." }, { status: 400 });

    const deltas = {
      returned: returned - dispatch.quantityReturned,
      accepted: accepted - dispatch.quantityAccepted,
      rejected: rejected - dispatch.quantityRejected,
      short: short - dispatch.quantityShort,
    };
    const fullyAccounted = returned + short === dispatch.quantitySent && accepted + rejected === returned;
    const actor = { userId: session.id, name: session.name };

    const updated = await db.transaction(async (tx) => {
      const derived = await applyMovements(tx, op, actor, [
        { type: MOVEMENT_EVENTS.EXTERNAL_RETURNED, quantity: deltas.returned, workerId: op.workerId,
          referenceType: "EXTERNAL_WORK_ORDER", referenceId: dispatch.id,
          reason: `${deltas.returned} garment(s) came back from ${dispatch.vendorName}` },
        { type: MOVEMENT_EVENTS.EXTERNAL_ACCEPTED, quantity: deltas.accepted, workerId: op.workerId,
          referenceType: "EXTERNAL_WORK_ORDER", referenceId: dispatch.id,
          reason: `${deltas.accepted} garment(s) accepted back from ${dispatch.vendorName}` },
        { type: MOVEMENT_EVENTS.EXTERNAL_REJECTED, quantity: deltas.rejected, workerId: op.workerId,
          referenceType: "EXTERNAL_WORK_ORDER", referenceId: dispatch.id,
          reason: `${deltas.rejected} garment(s) rejected or damaged on return from ${dispatch.vendorName}`,
          notes: body.notes ? String(body.notes).slice(0, 2000) : null },
        { type: MOVEMENT_EVENTS.EXTERNAL_SHORT, quantity: deltas.short, workerId: op.workerId,
          referenceType: "EXTERNAL_WORK_ORDER", referenceId: dispatch.id,
          reason: `${deltas.short} garment(s) never came back from ${dispatch.vendorName}`,
          notes: body.notes ? String(body.notes).slice(0, 2000) : null },
      ]);

      const [row] = await tx.update(externalWorkOrders).set({
        quantityReturned: returned,
        quantityAccepted: accepted,
        quantityRejected: rejected,
        quantityShort: short,
        // `status` keeps its existing meaning - the GARMENTS are fully accounted for.
        // Paying the vendor is a separate fact with its own field, because work can be
        // accepted and still unpaid, and closing a dispatch on the goods must not hide
        // a bill that is still owing.
        status: fullyAccounted ? "CLOSED" : "RETURNED",
        returnedAt: deltas.returned > 0 ? dispatch.returnedAt ?? new Date() : dispatch.returnedAt,
        closedAt: fullyAccounted ? dispatch.closedAt ?? new Date() : null,
        acceptedBy: deltas.accepted + deltas.rejected > 0 ? session.name : dispatch.acceptedBy,
        totalCost,
        amountPayable,
        amountPaid: amountPaid ?? 0,
        paymentReference,
        paidAt,
        expectedReturnAt,
        notes: body.notes === undefined ? dispatch.notes : String(body.notes).slice(0, 2000) || null,
      }).where(eq(externalWorkOrders.id, dispatch.id)).returning();

      const status = statusFromQuantities(derived);
      await tx.update(productionOperations).set({
        status,
        inspectedAt: deltas.accepted + deltas.rejected > 0 ? new Date() : op.inspectedAt,
        inspector: deltas.accepted + deltas.rejected > 0 ? session.name : op.inspector,
        completedAt: status === "COMPLETED" ? op.completedAt ?? new Date() : null,
      }).where(eq(productionOperations.id, op.id));

      // ONLY what was accepted moves on - not what was sent, not what came back.
      await releaseApprovedToNextStage(tx, op, derived.quantityApproved, actor);
      return row;
    });

    await refreshBatchAndOrder(op.productionBatchId);
    const quantities = await deriveQuantities(db, op.id);
    const [shaped] = await enrich([updated]);
    return NextResponse.json({
      ...(shaped ?? updated),
      stage: quantities,
      paymentStatus: settled ? "SETTLED" : (updated.amountPaid ?? 0) > 0 ? "PART_PAID" : "UNPAID",
      amountOutstanding: Math.max(0, (updated.amountPayable ?? updated.totalCost ?? 0) - (updated.amountPaid ?? 0)),
    });
  } catch (error) {
    console.error("External return failed", error);
    return NextResponse.json({ error: "Could not record this return." }, { status: 500 });
  }
}
