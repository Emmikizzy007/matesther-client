import { NextResponse } from "next/server";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
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
  productionAllocations,
  orderItemSizes,
} from "@/db/schema";
import { guard, getSessionUser, getLinkedWorkerId, ANYONE } from "@/lib/authz";
import { SUPPORT_OPERATIONS, SUPPORT_ROLE, sameRole, variantLabel } from "@/lib/format";
import { workerHoldsRole } from "@/lib/worker-roles";
import {
  supportPending,
  supportInspectionEarnings,
  supportInspectionRate,
  supportInspectionDeduction,
  supportHeadroom,
} from "@/lib/support-work";

export const dynamic = "force-dynamic";

/**
 * Tailor support work: weaving, taping and other supporting garment work that a
 * tailor hands to a helper.
 *
 * The parent tailor keeps their own production_operations row - support work is
 * recorded alongside it, never in place of it.
 */

/** GET /api/support-work - a Worker sees only support work they are part of. */
/**
 * GET /api/support-work?limit=&offset=
 *
 * Support work handed from a tailor to a helper. A tailor signs in as a Worker,
 * so a Worker needs both sides of the record: work handed TO them, and work THEY
 * handed out for inspection.
 *
 * This used to read eight whole tables - every support assignment, every worker,
 * every order, every customer, every production operation, every batch, every
 * order item and every product - and join them in JavaScript. At the measured
 * scale that was 20,064 rows read to return 750. The worker's own scope is now a
 * WHERE clause, and only the rows being returned are enriched.
 */
export async function GET(req: Request) {
  const denied = await guard(req, ANYONE);
  if (denied) return denied;
  try {
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
    const myWorkerId = session.role === "WORKER" ? await getLinkedWorkerId(session) : null;
    if (session.role === "WORKER" && myWorkerId === null)
      return NextResponse.json([], { headers: { "Cache-Control": "private, no-store" } });

    const query = new URL(req.url).searchParams;
    const rawLimit = query.get("limit") ? Number(query.get("limit")) : NaN;
    const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : null;
    const rawOffset = query.get("offset") ? Number(query.get("offset")) : 0;
    const offset = Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

    // A Worker's scope cannot be widened by a query string.
    const scope = myWorkerId !== null
      ? or(eq(supportAssignments.workerId, myWorkerId), eq(supportAssignments.assignedByWorkerId, myWorkerId))
      : undefined;

    const [totalRow] = await db
      .select({ total: sql<number>`count(*)` })
      .from(supportAssignments)
      .where(scope);

    const builder = db
      .select()
      .from(supportAssignments)
      .where(scope)
      // Newest first, which is the order the previous JavaScript sort produced.
      // The id tiebreaker keeps paging stable for rows created in the same instant.
      .orderBy(desc(supportAssignments.createdAt), supportAssignments.id);
    const assignments = await (limit !== null ? builder.limit(limit).offset(offset) : builder);
    if (!assignments.length)
      return NextResponse.json([], {
        headers: { "Cache-Control": "private, no-store", "X-Total-Count": String(Number(totalRow?.total ?? 0)) },
      });

    // Enrich only what is on this page.
    const personIds = [...new Set(assignments.flatMap((row) =>
      [row.workerId, row.assignedByWorkerId, row.approvedByWorkerId].filter((v): v is number => !!v)))];
    const opIds = [...new Set(assignments.map((row) => row.productionOperationId).filter((v): v is number => !!v))];
    const orderIds = [...new Set(assignments.map((row) => row.orderId).filter((v): v is number => !!v))];

    const [people, ops, orderRows] = await Promise.all([
      personIds.length
        ? db.select({ id: workers.id, name: workers.name }).from(workers).where(inArray(workers.id, personIds))
        : Promise.resolve([] as { id: number; name: string }[]),
      opIds.length
        ? db.select({ id: productionOperations.id, stage: productionOperations.stage, productionBatchId: productionOperations.productionBatchId })
            .from(productionOperations).where(inArray(productionOperations.id, opIds))
        : Promise.resolve([] as { id: number; stage: string; productionBatchId: number }[]),
      orderIds.length
        ? db.select({ id: orders.id, orderNumber: orders.orderNumber, customerId: orders.customerId })
            .from(orders).where(inArray(orders.id, orderIds))
        : Promise.resolve([] as { id: number; orderNumber: string; customerId: number | null }[]),
    ]);
    const batchIds = [...new Set(ops.map((op) => op.productionBatchId))];
    const customerIds = [...new Set(orderRows.map((order) => order.customerId).filter((v): v is number => !!v))];
    const [batches, customerRows] = await Promise.all([
      batchIds.length
        ? db.select({ id: productionBatches.id, batchNumber: productionBatches.batchNumber, size: productionBatches.size, color: productionBatches.color, orderItemId: productionBatches.orderItemId })
            .from(productionBatches).where(inArray(productionBatches.id, batchIds))
        : Promise.resolve([] as { id: number; batchNumber: string; size: string | null; color: string | null; orderItemId: number | null }[]),
      customerIds.length
        ? db.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, customerIds))
        : Promise.resolve([] as { id: number; name: string }[]),
    ]);
    const itemIds = [...new Set(batches.map((batch) => batch.orderItemId).filter((v): v is number => !!v))];
    const items = itemIds.length
      ? await db.select({ id: orderItems.id, productId: orderItems.productId }).from(orderItems).where(inArray(orderItems.id, itemIds))
      : [];
    const productIds = [...new Set(items.map((item) => item.productId).filter((v): v is number => !!v))];
    // The exact variant and, where the work was handed out from a named share, that
    // share - so a helper is told WHICH garment and whose work they are supporting
    // rather than being shown a whole order's quantity.
    const variantIds = [...new Set(assignments.map((row) => row.orderVariantId).filter((v): v is number => !!v))];
    const shareIds = [...new Set(assignments.map((row) => row.productionAllocationId).filter((v): v is number => !!v))];
    const [garments, variantRows, shareRows] = await Promise.all([
      productIds.length
        ? db.select({ id: products.id, name: products.name }).from(products).where(inArray(products.id, productIds))
        : Promise.resolve([] as { id: number; name: string }[]),
      variantIds.length
        ? db.select({ id: orderItemSizes.id, size: orderItemSizes.size, color: orderItemSizes.color, quantity: orderItemSizes.quantity })
            .from(orderItemSizes).where(inArray(orderItemSizes.id, variantIds))
        : Promise.resolve([] as { id: number; size: string | null; color: string | null; quantity: number }[]),
      shareIds.length
        ? db.select({
            id: productionAllocations.id, workerId: productionAllocations.workerId,
            quantityAllocated: productionAllocations.quantityAllocated, stage: productionAllocations.stage,
          }).from(productionAllocations).where(inArray(productionAllocations.id, shareIds))
        : Promise.resolve([] as { id: number; workerId: number; quantityAllocated: number; stage: string }[]),
    ]);
    // The tailor holding each share, named so the helper knows whose work it is.
    const shareHolderIds = [...new Set(shareRows.map((row) => row.workerId))];
    const shareHolders = shareHolderIds.length
      ? await db.select({ id: workers.id, name: workers.name }).from(workers).where(inArray(workers.id, shareHolderIds))
      : [];
    const shareHolderById = new Map(shareHolders.map((person) => [person.id, person.name]));

    const personById = new Map(people.map((person) => [person.id, person]));
    const orderById = new Map(orderRows.map((order) => [order.id, order]));
    const customerById = new Map(customerRows.map((row) => [row.id, row]));
    const opById = new Map(ops.map((op) => [op.id, op]));
    const batchById = new Map(batches.map((batch) => [batch.id, batch]));
    const itemById = new Map(items.map((item) => [item.id, item]));
    const productById = new Map(garments.map((garment) => [garment.id, garment]));
    const variantById = new Map(variantRows.map((variant) => [variant.id, variant]));
    const shareById = new Map(shareRows.map((share) => [share.id, share]));

    const rows = assignments.map((row) => {
      const parent = row.productionOperationId ? opById.get(row.productionOperationId) : undefined;
      const batch = parent ? batchById.get(parent.productionBatchId) : undefined;
      const order = row.orderId ? orderById.get(row.orderId) : undefined;
      // The garment comes from the assignment's own inherited item first, and falls back
      // to the batch's, so support work recorded before the inheritance existed still
      // names its garment.
      const itemId = row.orderItemId ?? batch?.orderItemId ?? null;
      const garment = itemId ? productById.get(itemById.get(itemId)?.productId ?? -1) : undefined;
      const variant = row.orderVariantId ? variantById.get(row.orderVariantId) : undefined;
      const share = row.productionAllocationId ? shareById.get(row.productionAllocationId) : undefined;
      // The exact variant is the size and colour the ORDER specified. The batch's own
      // size/colour text is the older, free-text answer and is only a fallback.
      const size = variant?.size ?? batch?.size ?? null;
      const color = variant?.color ?? batch?.color ?? null;
      const variantParts = [size, color].filter((value): value is string => !!value && String(value).trim() !== "");
      // The house rendering of a variant, the same one the production board, the
      // operations list and the worker's dashboard use, so a helper reading "Navy •
      // Size 10" here sees the same words everywhere else in the system.
      const variantText = variantParts.length ? variantLabel(size, color) : null;
      return {
        ...row,
        supportWorker: personById.get(row.workerId)?.name ?? "-",
        assignedBy: personById.get(row.assignedByWorkerId)?.name ?? "-",
        approvedBy: row.approvedByWorkerId ? personById.get(row.approvedByWorkerId)?.name ?? "-" : null,
        orderNumber: order?.orderNumber ?? "-",
        customer: order?.customerId ? customerById.get(order.customerId)?.name ?? "-" : "-",
        // The stage inherited onto the assignment when it was handed out, else the parent
        // stage job's. Never retyped by the helper and never guessed.
        stage: row.stage ?? parent?.stage ?? share?.stage ?? null,
        batchNumber: batch?.batchNumber ?? null,
        size,
        color,
        variant: variantText,
        variantQuantity: variant?.quantity ?? null,
        garment: garment?.name ?? null,
        /**
         * The exact share this support work was handed out from, when there is one:
         * whose work it is and how big that share is. A helper is never shown a whole
         * order's quantity when an exact production allocation exists behind their work.
         */
        allocation: share
          ? {
              id: share.id,
              stage: share.stage,
              holderWorkerId: share.workerId,
              holder: shareHolderById.get(share.workerId) ?? personById.get(share.workerId)?.name ?? "-",
              quantityAllocated: share.quantityAllocated,
            }
          : null,
        pending: supportPending(row),
      };
    });

    return NextResponse.json(rows, {
      headers: { "Cache-Control": "private, no-store", "X-Total-Count": String(Number(totalRow?.total ?? 0)) },
    });
  } catch (error) {
    console.error("Support work load failed", error);
    return NextResponse.json({ error: "Unable to load support work." }, { status: 500 });
  }
}

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

    /* ---------- the exact work being supported, inherited not re-chosen ----------
     *
     * A helper is never handed "some school's order". They are handed THIS tailor's
     * share of THIS stage, on THIS item, THIS size and THIS colour, in a quantity
     * that cannot exceed the share. Where a share exists it is named; otherwise the
     * stage job is, and the order, item, variant and stage are all read off it.
     */
    const allocationId = body.productionAllocationId ? Number(body.productionAllocationId) : null;
    if (allocationId !== null && (!Number.isSafeInteger(allocationId) || allocationId < 1))
      return NextResponse.json({ error: "Choose a valid production share." }, { status: 400 });
    const parentOperationId = body.productionOperationId ? Number(body.productionOperationId) : null;
    if (parentOperationId !== null && !Number.isSafeInteger(parentOperationId))
      return NextResponse.json({ error: "Choose a valid production job." }, { status: 400 });
    if (allocationId !== null && parentOperationId !== null)
      return NextResponse.json(
        { error: "Choose either the tailor's share of the stage or the stage itself, not both." },
        { status: 400 }
      );

    const share = allocationId
      ? (await db.select().from(productionAllocations).where(eq(productionAllocations.id, allocationId)).limit(1))[0] ?? null
      : null;
    if (allocationId !== null && !share)
      return NextResponse.json({ error: "That production share could not be found." }, { status: 404 });

    // A share names its own stage job; never let a request disagree with it.
    const resolvedOperationId = share ? share.productionOperationId : parentOperationId;
    const parent = resolvedOperationId
      ? (await db.select().from(productionOperations).where(eq(productionOperations.id, resolvedOperationId)).limit(1))[0] ?? null
      : null;
    if (resolvedOperationId !== null && !parent)
      return NextResponse.json({ error: "That production job could not be found." }, { status: 404 });

    const batch = parent
      ? (await db.select().from(productionBatches).where(eq(productionBatches.id, parent.productionBatchId)).limit(1))[0] ?? null
      : null;

    /* ---------- only the holder of the work may hand it out ---------- */
    const holderId = share ? share.workerId : parent?.workerId ?? null;
    let effectiveAssignerId = assignerId;
    if (holderId !== null && holderId !== assignerId) {
      const isSupervisor = session.role === "OWNER" || session.role === "PRODUCTION_MANAGER";
      if (!isSupervisor)
        return NextResponse.json(
          { error: "You can only hand out support work on pieces you hold yourself." },
          { status: 403 }
        );
      // A supervisor recording a hand-over on somebody's behalf: the work still came
      // from the worker holding the pieces, so inspection authority AND the pay
      // deduction both land on them rather than on whoever typed it in.
      effectiveAssignerId = holderId;
    }
    if (effectiveAssignerId !== assignerId) {
      const [holder] = await db.select().from(workers).where(eq(workers.id, effectiveAssignerId)).limit(1);
      if (!holder || holder.status !== "ACTIVE" || holder.organizationId !== session.organizationId)
        return NextResponse.json(
          { error: "The worker holding this share must be an active Matesther worker." },
          { status: 400 }
        );
      if (holder.id === workerId)
        return NextResponse.json(
          { error: "The worker holding this share cannot also be the support worker on it." },
          { status: 400 }
        );
    }

    /* ---------- how much may be handed out ----------
     *
     * The helper's pieces are a subset of the pieces the tailor holds. The ceiling
     * is per supporting operation: 40 garments can take 40 weaves AND 40 tapes, but
     * never 60 weaves, because there would be nothing for the extra 20 to be on.
     */
    const holding = share
      ? share.quantityAllocated
      : parent
        ? batch?.quantity ?? 0
        : null;
    if (holding !== null) {
      const [handedOut] = await db
        .select({ total: sql<number>`coalesce(sum(${supportAssignments.quantityAssigned}), 0)` })
        .from(supportAssignments)
        .where(and(
          share
            ? eq(supportAssignments.productionAllocationId, share.id)
            : and(
                eq(supportAssignments.productionOperationId, parent!.id),
                isNull(supportAssignments.productionAllocationId)
              ),
          sql`lower(${supportAssignments.operation}) = lower(${operation})`,
          sql`${supportAssignments.status} <> 'CANCELLED'`
        ));
      const headroom = supportHeadroom(holding, Number(handedOut?.total) || 0);
      if (quantity > headroom)
        return NextResponse.json(
          {
            error: headroom === 0
              ? `All ${holding} piece${holding === 1 ? "" : "s"} of ${operation} on this work have already been handed out.`
              : `Only ${headroom} piece${headroom === 1 ? "" : "s"} of ${operation} are left to hand out on this work.`,
          },
          { status: 400 }
        );
    }

    const requestedOrderId = body.orderId ? Number(body.orderId) : null;
    if (requestedOrderId !== null && !Number.isSafeInteger(requestedOrderId))
      return NextResponse.json({ error: "Choose a valid order." }, { status: 400 });
    // The order, item, variant and stage come from the production work. A caller
    // may not attach support work to an order it has nothing to do with.
    const orderId = parent ? batch?.orderId ?? null : requestedOrderId;
    if (!parent && requestedOrderId !== null) {
      const [order] = await db.select().from(orders).where(eq(orders.id, requestedOrderId)).limit(1);
      if (!order || order.organizationId !== session.organizationId)
        return NextResponse.json({ error: "That order could not be found." }, { status: 404 });
    }

    const [created] = await db
      .insert(supportAssignments)
      .values({
        organizationId: session.organizationId,
        assignedByWorkerId: effectiveAssignerId,
        workerId,
        productionOperationId: resolvedOperationId,
        productionAllocationId: share?.id ?? null,
        orderId,
        // Inherited so the helper's dashboard and the order's cost all see the same
        // exact garment - item, size, colour and stage - without re-typing any of it.
        orderItemId: parent ? batch?.orderItemId ?? null : null,
        orderVariantId: parent ? batch?.orderVariantId ?? null : null,
        stage: parent ? parent.stage : null,
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
          /**
           * The other side of the same money: what this approval takes back from the
           * tailor who handed the work out. Shown here so nobody can read the
           * helper's pay as an extra cost on top of the tailor's.
           */
          deductedFromTailor: person
            ? supportInspectionDeduction(inspection, assignment, person)
            : 0,
          deductedFromWorkerId: updated.assignedByWorkerId,
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
