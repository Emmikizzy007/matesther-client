import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { productionOperations, productionBatches, orders, customers, workers, orderItems, products } from "@/db/schema";
import { refreshBatchAndOrder } from "@/lib/server";
import { guard, getSessionUser, getLinkedWorkerId, productionAccess, ANYONE } from "@/lib/authz";
import { STAGE_ROLES } from "@/lib/format";
import { workerHoldsRole } from "@/lib/worker-roles";

const STATUSES = ["PENDING", "IN_PROGRESS", "SUBMITTED", "COMPLETED", "ON_HOLD", "CANCELLED"];

export async function GET(req: Request) {
  const denied = await guard(req, ANYONE);
  if (denied) return denied;
  const session = await getSessionUser(req);
  const myWorkerId = session?.role === "WORKER" ? await getLinkedWorkerId(session) : null;
  if (session?.role === "WORKER" && myWorkerId === null)
    return NextResponse.json([], { headers: { "Cache-Control": "private, no-store" } });
  try {
    const query = new URL(req.url).searchParams;
    const [ops, batches, orderRows, customerRows, workerRows, items, catalog] = await Promise.all([
      db.select().from(productionOperations), db.select().from(productionBatches), db.select().from(orders),
      db.select().from(customers), db.select().from(workers), db.select().from(orderItems),
      db.select({ id: products.id, name: products.name }).from(products),
    ]);
    const byBatch = new Map(batches.map((batch) => [batch.id, batch]));
    const byOrder = new Map(orderRows.map((order) => [order.id, order]));
    const byCustomer = new Map(customerRows.map((customer) => [customer.id, customer]));
    const byWorker = new Map(workerRows.map((person) => [person.id, person]));
    const byItem = new Map(items.map((item) => [item.id, item]));
    const byProduct = new Map(catalog.map((product) => [product.id, product.name]));
    const rows = ops.filter((op) =>
      (!query.get("status") || op.status === query.get("status")) &&
      (!query.get("workerId") || op.workerId === Number(query.get("workerId"))) &&
      (!myWorkerId || op.workerId === myWorkerId) &&
      (!query.get("orderId") || byBatch.get(op.productionBatchId)?.orderId === Number(query.get("orderId")))
    ).map((op) => {
      const batch = byBatch.get(op.productionBatchId);
      const order = batch ? byOrder.get(batch.orderId) : undefined;
      const item = batch?.orderItemId ? byItem.get(batch.orderItemId) : undefined;
      return {
        ...op,
        batchNumber: batch?.batchNumber ?? "-", batchQuantity: batch?.quantity ?? 0,
        size: batch?.size ?? null, color: batch?.color ?? null,
        garment: item?.productId ? byProduct.get(item.productId) ?? "Uniform item" : "Full order",
        orderId: order?.id ?? null, orderNumber: order?.orderNumber ?? "-", dueDate: order?.dueDate ?? null,
        customer: byCustomer.get(order?.customerId ?? -1)?.name ?? "-",
        workerName: byWorker.get(op.workerId ?? -1)?.name ?? null,
        paymentType: byWorker.get(op.workerId ?? -1)?.paymentType ?? null,
        pendingInspection: Math.max(0, op.quantityCompleted - op.quantityInspected),
      };
    });
    return NextResponse.json(rows, { headers: { "Cache-Control": "private, no-store" } });
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
      const [submitted] = await db.update(productionOperations).set({
        quantityCompleted: current.quantityCompleted + qty, status: "SUBMITTED", submittedAt: new Date(),
      }).where(eq(productionOperations.id, id)).returning();
      await refreshBatchAndOrder(current.productionBatchId);
      return NextResponse.json(submitted);
    }

    const workerId = body.workerId === undefined ? current.workerId : body.workerId ? Number(body.workerId) : null;
    const changedWorker = workerId !== current.workerId;
    const [person] = workerId ? await db.select().from(workers).where(eq(workers.id, workerId)).limit(1) : [];
    if (workerId && (!person || person.status !== "ACTIVE" || person.organizationId !== session.organizationId))
      return NextResponse.json({ error: "Choose an active Matesther worker." }, { status: 400 });
    // "Is a cutter" now means holding the Cutter role among possibly several.
    if (access?.cutterSupervisor && workerId !== current.workerId && (await workerHoldsRole(person, "Cutter")))
      return NextResponse.json({ error: "Cutter assignments must be made by the Owner or a non-cutting supervisor." }, { status: 403 });
    if (person && STAGE_ROLES[current.stage] && !(await workerHoldsRole(person, STAGE_ROLES[current.stage])))
      return NextResponse.json({ error: `${current.stage.replaceAll("_", " ")} needs a ${STAGE_ROLES[current.stage]}.` }, { status: 400 });
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
    const received = body.quantityReceived === undefined ? current.quantityReceived : Number(body.quantityReceived);
    const completed = body.quantityCompleted === undefined ? current.quantityCompleted : Number(body.quantityCompleted);
    const rejected = body.quantityRejected === undefined ? current.quantityRejected : Number(body.quantityRejected);
    if (![received, completed, rejected].every((number) => Number.isSafeInteger(number) && number >= 0) || completed < current.quantityInspected)
      return NextResponse.json({ error: "Quantities must be non-negative whole numbers. Submitted work cannot be less than work already inspected." }, { status: 400 });
    const status = body.status ?? current.status;
    if (!STATUSES.includes(status)) return NextResponse.json({ error: "Choose a valid status." }, { status: 400 });
    const remaining = Math.max(0, received - current.quantityApproved - rejected);
    if (status === "COMPLETED" && (current.quantityApproved < 1 || remaining > 0))
      return NextResponse.json({ error: "Inspect and approve the work before completing this stage." }, { status: 400 });
    const [updated] = await db.update(productionOperations).set({
      workerId, pieceRate, quantityReceived: received, quantityCompleted: completed,
      quantityRejected: rejected, quantityRemaining: remaining, status,
      submittedAt: status === "SUBMITTED" && completed > current.quantityInspected ? current.submittedAt ?? new Date() : current.submittedAt,
      expectedCompletionDate: body.expectedCompletionDate === undefined ? current.expectedCompletionDate : body.expectedCompletionDate || null,
      completedAt: status === "COMPLETED" ? current.completedAt ?? new Date() : null,
      notes: body.notes === undefined ? current.notes : String(body.notes).slice(0, 2000),
    }).where(eq(productionOperations.id, id)).returning();
    await refreshBatchAndOrder(current.productionBatchId);
    return NextResponse.json(updated);
  } catch (error) {
    console.error("Production job update failed", error);
    return NextResponse.json({ error: "Could not update this production job." }, { status: 500 });
  }
}
