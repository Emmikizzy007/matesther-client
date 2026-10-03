import { NextResponse } from "next/server";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { productionOperations, productionBatches, orders, customers, workers, orderItems, products } from "@/db/schema";
import { refreshBatchAndOrder } from "@/lib/server";
import { guard, getSessionUser, getLinkedWorkerId, productionAccess, ANYONE } from "@/lib/authz";
import { STAGE_ROLES, isExternalMethod, isPurchasedMethod, methodLabel, variantLabel } from "@/lib/format";
import { workerHoldsRole, type RoleCache } from "@/lib/worker-roles";
import { MOVEMENT_EVENTS, applyMovements } from "@/lib/production-ledger";
import { roleForStage } from "@/lib/production-route";

const STATUSES = ["PENDING", "IN_PROGRESS", "SUBMITTED", "COMPLETED", "ON_HOLD", "CANCELLED"];

/**
 * Quantity fields a supervisor may NO LONGER set directly.
 *
 * These three used to be writable through PUT /api/operations, which meant:
 *   - a stage's `quantity_received` could be raised above what the previous
 *     stage had actually approved, and the fabricated figure would then flow
 *     downstream on the next approval;
 *   - `quantity_completed` could be invented without any submission, and then
 *     approved, paying for garments nobody made;
 *   - `quantity_rejected` could be lowered below what the inspection audit trail
 *     recorded, silently flipping a COMPLETED job back to IN_PROGRESS.
 * None of those writes left any trace: no row recorded who changed a quantity,
 * when, or why.
 *
 * Quantities now move only through events (allocate, submit, inspect) recorded on
 * the production movement ledger. A genuine mistake is still correctable - via
 * POST /api/production-corrections, which writes a signed ledger row carrying the
 * actor, the timestamp and a mandatory written reason.
 */
const LEDGER_ONLY_FIELDS = ["quantityReceived", "quantityCompleted", "quantityRejected",
  "quantityInspected", "quantityApproved", "quantityRework", "quantityRemaining"];

/**
 * GET /api/operations
 *   ?status=PENDING,IN_PROGRESS   comma-separated list
 *   &stage=CUTTING&workerId=&orderId=&batchId=&hasReceived=1
 *   &limit=&offset=               server-side pagination
 *
 * FILTERING AND PAGING NOW HAPPEN IN SQL. This route used to read the ENTIRE
 * `production_operations`, `production_batches`, `orders`, `customers`,
 * `workers` and `order_items` tables on every call, join them in JavaScript and
 * only then apply the status / worker / order filters. At the measured synthetic
 * scale that was 18,564 rows read to answer one request and an 11 MB response
 * body for the Production board. It is now three queries: one join for the page
 * of rows actually asked for, one count for the total, and one small product
 * lookup for the garment names on that page.
 *
 * `X-Total-Count` carries the unpaginated total so a client can page without a
 * second request. The response body stays a plain array, so every existing
 * caller keeps working unchanged.
 */
export async function GET(req: Request) {
  const denied = await guard(req, ANYONE);
  if (denied) return denied;
  const session = await getSessionUser(req);
  if (!session) return NextResponse.json([], { headers: { "Cache-Control": "private, no-store" } });
  const myWorkerId = session.role === "WORKER" ? await getLinkedWorkerId(session) : null;
  if (session.role === "WORKER" && myWorkerId === null)
    return NextResponse.json([], { headers: { "Cache-Control": "private, no-store" } });
  try {
    const query = new URL(req.url).searchParams;
    const wantedStatuses = String(query.get("status") ?? "")
      .split(",").map((value) => value.trim().toUpperCase())
      .filter((value) => STATUSES.includes(value));
    const stage = query.get("stage") ? String(query.get("stage")).trim().toUpperCase() : null;
    const workerFilter = query.get("workerId") ? Number(query.get("workerId")) : null;
    const orderFilter = query.get("orderId") ? Number(query.get("orderId")) : null;
    const batchFilter = query.get("batchId") ? Number(query.get("batchId")) : null;
    // `hasReceived=1` asks only for stages that actually hold work. Seven of the
    // eight stages on every batch start at zero and stay there until an inspection
    // releases work into them, so a screen that lists assignable jobs was
    // downloading mostly empty rows.
    const hasReceived = query.get("hasReceived") === "1";
    const rawLimit = query.get("limit") ? Number(query.get("limit")) : NaN;
    const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : null;
    const rawOffset = query.get("offset") ? Number(query.get("offset")) : 0;
    const offset = Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

    // A Worker only ever sees their own jobs; that scope cannot be widened by a
    // query string, exactly as before.
    const effectiveWorker = myWorkerId !== null ? myWorkerId : workerFilter;
    const filters = and(
      wantedStatuses.length ? inArray(productionOperations.status, wantedStatuses) : undefined,
      stage ? eq(productionOperations.stage, stage) : undefined,
      effectiveWorker !== null && Number.isSafeInteger(effectiveWorker) ? eq(productionOperations.workerId, effectiveWorker) : undefined,
      orderFilter !== null && Number.isSafeInteger(orderFilter) ? eq(orders.id, orderFilter) : undefined,
      batchFilter !== null && Number.isSafeInteger(batchFilter) ? eq(productionOperations.productionBatchId, batchFilter) : undefined,
      hasReceived ? gt(productionOperations.quantityReceived, 0) : undefined
    );

    const [totalRow] = await db
      .select({ total: sql<number>`count(*)` })
      .from(productionOperations)
      .leftJoin(productionBatches, eq(productionBatches.id, productionOperations.productionBatchId))
      .leftJoin(orders, eq(orders.id, productionBatches.orderId))
      .where(filters);
    const total = Number(totalRow?.total ?? 0);

    const builder = db
      .select({
        id: productionOperations.id,
        productionBatchId: productionOperations.productionBatchId,
        stage: productionOperations.stage,
        workerId: productionOperations.workerId,
        pieceRate: productionOperations.pieceRate,
        quantityReceived: productionOperations.quantityReceived,
        quantityCompleted: productionOperations.quantityCompleted,
        quantityRejected: productionOperations.quantityRejected,
        quantityRemaining: productionOperations.quantityRemaining,
        quantityInspected: productionOperations.quantityInspected,
        quantityApproved: productionOperations.quantityApproved,
        quantityRework: productionOperations.quantityRework,
        inspector: productionOperations.inspector,
        status: productionOperations.status,
        // Route and method: what a card must show so a supervisor can tell an
        // in-house sewing job from one that is out with a vendor, and can see where
        // this stage sits in THIS batch's route rather than in a global list.
        method: productionOperations.method,
        routePosition: productionOperations.routePosition,
        assignedAt: productionOperations.assignedAt,
        submittedAt: productionOperations.submittedAt,
        expectedCompletionDate: productionOperations.expectedCompletionDate,
        inspectedAt: productionOperations.inspectedAt,
        completedAt: productionOperations.completedAt,
        notes: productionOperations.notes,
        batchNumber: productionBatches.batchNumber,
        batchQuantity: productionBatches.quantity,
        size: productionBatches.size,
        color: productionBatches.color,
        orderVariantId: productionBatches.orderVariantId,
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        dueDate: orders.dueDate,
        customer: customers.name,
        workerName: workers.name,
        paymentType: workers.paymentType,
        productId: orderItems.productId,
      })
      .from(productionOperations)
      .leftJoin(productionBatches, eq(productionBatches.id, productionOperations.productionBatchId))
      .leftJoin(orders, eq(orders.id, productionBatches.orderId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .leftJoin(workers, eq(workers.id, productionOperations.workerId))
      .leftJoin(orderItems, eq(orderItems.id, productionBatches.orderItemId))
      .where(filters)
      // Insertion order, which is what the un-ordered full scan returned before.
      .orderBy(productionOperations.id);
    // `.offset()` is only available after `.limit()`, so the two shapes are kept
    // separate rather than reassigned.
    const page = await (limit !== null ? builder.limit(limit).offset(offset) : builder);

    // Garment names for this page only, not for the whole catalogue.
    const productIds = [...new Set(page.map((row) => row.productId).filter((value): value is number => !!value))];
    const catalog = productIds.length
      ? await db.select({ id: products.id, name: products.name }).from(products).where(inArray(products.id, productIds))
      : [];
    const byProduct = new Map(catalog.map((product) => [product.id, product.name]));

    // How many stages each batch on this page actually has, so a card can say
    // "stage 2 of 3" instead of implying the eight-stage pipeline. One grouped
    // query, limited to the batches on this page.
    const pageBatchIds = [...new Set(page.map((row) => row.productionBatchId))];
    const routeLengths = pageBatchIds.length
      ? await db
          .select({ batchId: productionOperations.productionBatchId, stages: sql<number>`count(*)` })
          .from(productionOperations)
          .where(inArray(productionOperations.productionBatchId, pageBatchIds))
          .groupBy(productionOperations.productionBatchId)
      : [];
    const lengthByBatch = new Map(routeLengths.map((row) => [Number(row.batchId), Number(row.stages)]));

    const rows = page.map(({ productId, ...op }) => {
      const routeLength = lengthByBatch.get(op.productionBatchId) ?? 0;
      return {
        ...op,
        batchNumber: op.batchNumber ?? "-",
        batchQuantity: op.batchQuantity ?? 0,
        garment: productId ? byProduct.get(productId) ?? "Uniform item" : "Full order",
        // The exact garment this job is for, not the whole order.
        variant: variantLabel(op.size, op.color),
        method: op.method ?? "INTERNAL",
        methodLabel: methodLabel(op.method),
        routePosition: op.routePosition ?? null,
        routeLength,
        routeStageNumber: op.routePosition ?? null,
        orderNumber: op.orderNumber ?? "-",
        customer: op.customer ?? "-",
        workerName: op.workerName ?? null,
        paymentType: op.paymentType ?? null,
        pendingInspection: Math.max(0, op.quantityCompleted - op.quantityInspected),
      };
    });
    return NextResponse.json(rows, {
      headers: { "Cache-Control": "private, no-store", "X-Total-Count": String(total) },
    });
  } catch (error) {
    console.error("Production jobs load failed", error);
    return NextResponse.json({ error: "Unable to load production jobs." }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const denied = await guard(req, ANYONE);
  if (denied) return denied;
  try {
    const body = await req.json();
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ error: "Choose a production job." }, { status: 400 });
    const [current] = await db.select().from(productionOperations).where(eq(productionOperations.id, id)).limit(1);
    if (!current) return NextResponse.json({ error: "Job not found." }, { status: 404 });
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
    const access = session.role === "PRODUCTION_MANAGER" ? await productionAccess(session) : null;
    if (session.role === "PRODUCTION_MANAGER" && access?.cutterSupervisor && current.stage === "CUTTING" && body.submitQty === undefined)
      return NextResponse.json({
        error: "A cutter-supervisor cannot assign, change or complete Cutting jobs. An Owner or non-cutting supervisor must handle Cutting. Submit your own pieces through My Jobs.",
      }, { status: 403 });
    if (session.role === "WORKER" || (session.role === "PRODUCTION_MANAGER" && body.submitQty !== undefined)) {
      // Checked BEFORE ownership, so the answer is about the stage rather than a
      // confusing "this is not your job" on a job nobody could ever submit against.
      // A stage produced outside the factory, or satisfied by buying finished
      // garments in, has no worker submission: allowing one would let a SUBMISSION
      // event sit beside the EXTERNAL_RETURNED / RECEIVED_READYMADE events for the
      // same garments and count them twice.
      if (isExternalMethod(current.method) || isPurchasedMethod(current.method))
        return NextResponse.json({
          error: `This stage is ${methodLabel(current.method).toLowerCase()}, so nobody submits pieces against it. `
            + (isPurchasedMethod(current.method)
              ? "Record the purchase and accept it on arrival under External Work & Ready-made."
              : "Record what comes back under External Work & Ready-made; only what Matesther accepts counts."),
        }, { status: 400 });
      const workerId = await getLinkedWorkerId(session);
      if (!workerId || current.workerId !== workerId)
        return NextResponse.json({ error: "You can only submit your own assigned jobs." }, { status: 403 });
      if (Object.keys(body).some((key) => !["id", "submitQty"].includes(key)))
        return NextResponse.json({ error: "Only your completed quantity can be submitted for inspection." }, { status: 403 });
      if (!["IN_PROGRESS", "SUBMITTED"].includes(current.status))
        return NextResponse.json({ error: "This job is not active. Contact your supervisor." }, { status: 400 });
      const pending = Math.max(0, current.quantityCompleted - current.quantityInspected);
      const available = Math.max(0, current.quantityRemaining - pending);
      const qty = Number(body.submitQty);
      if (!Number.isSafeInteger(qty) || qty < 1 || qty > available)
        return NextResponse.json({ error: `You can submit between 1 and ${available} pieces.` }, { status: 400 });
      const actor = { userId: session.id, name: session.name };
      // The submission is a ledger event and the counter is derived from it, in
      // one transaction: two submissions can no longer read the same
      // `quantity_completed` and lose one of them.
      const submitted = await db.transaction(async (tx) => {
        await applyMovements(tx, current, actor, [{
          type: MOVEMENT_EVENTS.SUBMISSION, quantity: qty, workerId: current.workerId,
          reason: `${qty} piece(s) submitted for inspection`,
        }]);
        const [row] = await tx.update(productionOperations).set({
          status: "SUBMITTED", submittedAt: new Date(),
        }).where(eq(productionOperations.id, id)).returning();
        return row;
      });
      await refreshBatchAndOrder(current.productionBatchId);
      return NextResponse.json(submitted);
    }

    const smuggled = LEDGER_ONLY_FIELDS.filter((field) => body[field] !== undefined);
    if (smuggled.length)
      return NextResponse.json({
        error: `${smuggled.map((field) => field.replace(/([A-Z])/g, " $1").toLowerCase()).join(", ")} can no longer be typed in. `
          + "Quantities come from what was allocated, submitted and inspected. To fix a genuine mistake use a recorded correction, "
          + "which keeps who changed it, when and why.",
      }, { status: 400 });
    const workerId = body.workerId === undefined ? current.workerId : body.workerId ? Number(body.workerId) : null;
    const changedWorker = workerId !== current.workerId;
    const [person] = workerId ? await db.select().from(workers).where(eq(workers.id, workerId)).limit(1) : [];
    if (workerId && (!person || person.status !== "ACTIVE" || person.organizationId !== session.organizationId))
      return NextResponse.json({ error: "Choose an active Matesther worker." }, { status: 400 });
    // "Is a cutter" now means holding the Cutter role among possibly several.
    // One memo for this request: the same person can be checked against both the
    // Cutter rule and the stage rule, which used to resolve their roles twice.
    const roleCache: RoleCache = new Map();
    if (access?.cutterSupervisor && workerId !== current.workerId && (await workerHoldsRole(person, "Cutter", roleCache)))
      return NextResponse.json({ error: "Cutter assignments must be made by the Owner or a non-cutting supervisor." }, { status: 403 });
    // The role a stage needs: the batch's own route may override the default map,
    // which is how a route can demand a Packer at DELIVERY on one garment and
    // something else on another without a code change.
    const requiredRole = await roleForStage(db, current);
    if (person && requiredRole && !(await workerHoldsRole(person, requiredRole, roleCache)))
      return NextResponse.json({ error: `${current.stage.replaceAll("_", " ")} needs a ${requiredRole}.` }, { status: 400 });
    if (changedWorker && (current.quantityCompleted > 0 || current.quantityInspected > 0 || current.quantityApproved > 0))
      return NextResponse.json({ error: "This job already has production history. Keep the assigned worker; use a new batch to split the work." }, { status: 400 });

    let pieceRate = current.pieceRate;
    if (person?.paymentType === "PER_PIECE") {
      const proposed = body.pieceRate === undefined || body.pieceRate === "" || body.pieceRate === null
        ? (changedWorker ? null : pieceRate) : Number(body.pieceRate);
      if (changedWorker && (!Number.isSafeInteger(proposed) || (proposed ?? 0) < 1))
        return NextResponse.json({ error: `Enter the agreed per-piece rate for ${person.name} on this job.` }, { status: 400 });
      if (proposed !== null && (!Number.isSafeInteger(proposed) || proposed < 1))
        return NextResponse.json({ error: "Agreed per-piece rate must be a positive whole amount." }, { status: 400 });
      if (proposed !== pieceRate && (current.quantityCompleted > 0 || current.quantityInspected > 0))
        return NextResponse.json({ error: "The job rate is locked once work is submitted. The original agreement and inspection history must stay intact." }, { status: 400 });
      pieceRate = proposed;
    } else if (changedWorker) pieceRate = null;
    if (!person && body.workerId !== undefined) pieceRate = null;
    const status = body.status ?? current.status;
    if (!STATUSES.includes(status)) return NextResponse.json({ error: "Choose a valid status." }, { status: 400 });
    // `remaining` is read from the derived counters, never recomputed from input.
    const remaining = current.quantityRemaining;
    if (status === "COMPLETED" && (current.quantityApproved < 1 || remaining > 0))
      return NextResponse.json({ error: "Inspect and approve the work before completing this stage." }, { status: 400 });
    const actor = { userId: session.id, name: session.name };
    const updated = await db.transaction(async (tx) => {
      // Reassignment is on the audit trail even though it moves no quantity: who
      // took a job off whom, and why, is exactly what a production dispute needs.
      if (changedWorker) {
        await applyMovements(tx, current, actor, [{
          type: MOVEMENT_EVENTS.REASSIGNMENT, quantity: 0, audit: true, workerId,
          reason: String(body.notes ?? "").trim() || "Job reassigned",
        }]);
      }
      const [row] = await tx.update(productionOperations).set({
        workerId, pieceRate, status,
        submittedAt: status === "SUBMITTED" && current.quantityCompleted > current.quantityInspected ? current.submittedAt ?? new Date() : current.submittedAt,
        expectedCompletionDate: body.expectedCompletionDate === undefined ? current.expectedCompletionDate : body.expectedCompletionDate || null,
        completedAt: status === "COMPLETED" ? current.completedAt ?? new Date() : null,
        notes: body.notes === undefined ? current.notes : String(body.notes).slice(0, 2000),
      }).where(eq(productionOperations.id, id)).returning();
      return row;
    });
    await refreshBatchAndOrder(current.productionBatchId);
    return NextResponse.json(updated);
  } catch (error) {
    console.error("Production job update failed", error);
    return NextResponse.json({ error: "Could not update this production job." }, { status: 500 });
  }
}
