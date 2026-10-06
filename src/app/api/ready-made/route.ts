import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  materialPurchases,
  materials,
  orderItemSizes,
  orders,
  productionBatches,
  productionMovements,
  productionOperations,
} from "@/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { refreshBatchAndOrder } from "@/lib/server";
import { guard, getSessionUser, OWNER, STAFF } from "@/lib/authz";
import { READY_MADE_CATEGORY, isPurchasedMethod, variantLabel } from "@/lib/format";
import { MOVEMENT_EVENTS, applyMovements, deriveDetail } from "@/lib/production-ledger";
import { releaseApprovedToNextStage, statusFromQuantities } from "@/lib/production-route";

export const dynamic = "force-dynamic";

/**
 * READY-MADE RECEIPTS: a finished garment BOUGHT IN, not manufactured.
 *
 * WHY THIS IS NOT `/api/external-work`
 *   These are different business facts and must never be merged:
 *     - outsourcing / vendor processing pays someone to MAKE MATESTHER'S garment,
 *       which is an external production cost;
 *     - a ready-made purchase BUYS A FINISHED GOOD, which is a purchase cost.
 *   Conflating them would let a ₦500,000 cardigan purchase be reported as tailor
 *   labour, or as outsourced production. So a ready-made receipt lives in
 *   `material_purchases` - the existing purchase table, with its existing cost
 *   columns - and is only LINKED to the route stage it satisfies. No worker is
 *   involved, no piece rate is created, and nothing is written to `worker_payments`.
 *
 * The garment itself is a `materials` row with `category = 'Ready-made garment'`,
 * because `material_purchases.material_id` is NOT NULL. That needs no new table and
 * keeps finished goods in the same catalogue as fabric and thread.
 *
 * Stock is deliberately NOT incremented here. A ready-made garment recorded against
 * a route stage is bought to satisfy a specific order and goes straight to it; it
 * never sits in raw-material stock. Buying finished goods to hold and resell is
 * what `POST /api/material-purchases` is for, and that path still increments stock
 * exactly as before. Flagged for review - see the Task 3 report.
 */

/** GET /api/ready-made?operationId=&batchId=&orderId= */
export async function GET(req: Request) {
  const denied = await guard(req, STAFF);
  if (denied) return denied;
  try {
    const query = new URL(req.url).searchParams;
    const operationId = query.get("operationId") ? Number(query.get("operationId")) : null;
    const orderId = query.get("orderId") ? Number(query.get("orderId")) : null;
    const rows = await db
      .select()
      .from(materialPurchases)
      .where(
        and(
          operationId ? eq(materialPurchases.productionOperationId, operationId) : undefined,
          orderId ? eq(materialPurchases.orderId, orderId) : undefined
        )
      )
      .orderBy(desc(materialPurchases.purchaseDate), desc(materialPurchases.id));
    // Only purchases tied to a route stage are ready-made receipts. A fabric
    // purchase stays on the Materials page where it has always been.
    const linked = rows.filter((row) => row.productionOperationId !== null);

    const opIds = [...new Set(linked.map((row) => row.productionOperationId).filter((v): v is number => !!v))];
    const materialIds = [...new Set(linked.map((row) => row.materialId))];
    const [ops, garmentRows] = await Promise.all([
      opIds.length
        ? db.select({ id: productionOperations.id, stage: productionOperations.stage, method: productionOperations.method,
            productionBatchId: productionOperations.productionBatchId, quantityApproved: productionOperations.quantityApproved,
            quantityRejected: productionOperations.quantityRejected, quantityRemaining: productionOperations.quantityRemaining,
            status: productionOperations.status })
          .from(productionOperations).where(inArray(productionOperations.id, opIds))
        : Promise.resolve([]),
      materialIds.length
        ? db.select({ id: materials.id, name: materials.name, category: materials.category, unit: materials.unit })
          .from(materials).where(inArray(materials.id, materialIds))
        : Promise.resolve([]),
    ]);
    const opById = new Map(ops.map((op) => [op.id, op]));
    const materialById = new Map(garmentRows.map((row) => [row.id, row]));
    const batchIds = [...new Set(ops.map((op) => op.productionBatchId))];
    const batches = batchIds.length
      ? await db.select({ id: productionBatches.id, batchNumber: productionBatches.batchNumber, orderId: productionBatches.orderId,
          orderVariantId: productionBatches.orderVariantId, size: productionBatches.size, color: productionBatches.color })
        .from(productionBatches).where(inArray(productionBatches.id, batchIds))
      : [];
    const batchById = new Map(batches.map((batch) => [batch.id, batch]));
    const variantIds = [...new Set(batches.map((batch) => batch.orderVariantId).filter((v): v is number => !!v))];
    const orderIds = [...new Set(batches.map((batch) => batch.orderId))];
    const [variantRows, orderRows] = await Promise.all([
      variantIds.length
        ? db.select({ id: orderItemSizes.id, size: orderItemSizes.size, color: orderItemSizes.color })
          .from(orderItemSizes).where(inArray(orderItemSizes.id, variantIds))
        : Promise.resolve([]),
      orderIds.length
        ? db.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders).where(inArray(orders.id, orderIds))
        : Promise.resolve([]),
    ]);
    const variantById = new Map(variantRows.map((row) => [row.id, row]));
    const orderById = new Map(orderRows.map((row) => [row.id, row]));

    return NextResponse.json(
      linked.map((row) => {
        const op = row.productionOperationId ? opById.get(row.productionOperationId) : undefined;
        const batch = op ? batchById.get(op.productionBatchId) : undefined;
        const variant = batch?.orderVariantId ? variantById.get(batch.orderVariantId) : undefined;
        const material = materialById.get(row.materialId);
        return {
          ...row,
          garment: material?.name ?? "-",
          category: material?.category ?? null,
          unit: material?.unit ?? null,
          stage: op?.stage ?? null,
          stageStatus: op?.status ?? null,
          batchNumber: batch?.batchNumber ?? "-",
          orderNumber: batch ? orderById.get(batch.orderId)?.orderNumber ?? "-" : "-",
          size: variant?.size ?? batch?.size ?? null,
          color: variant?.color ?? batch?.color ?? null,
          variant: variantLabel(variant?.size ?? batch?.size, variant?.color ?? batch?.color),
        };
      }),
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    console.error("Ready-made receipt load failed", error);
    return NextResponse.json({ error: "Could not load ready-made receipts." }, { status: 500 });
  }
}

/**
 * POST /api/ready-made - record a finished-garment purchase against a route stage.
 * { operationId, materialId, quantity, unitCost?, supplier?, purchaseDate?, orderVariantId?, notes? }
 *
 * Recording the purchase makes the garments RECEIVED at that stage. It does not
 * make them available downstream: only `PUT` (acceptance) does that, so a delivery
 * that arrives damaged cannot silently progress an order.
 */
export async function POST(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const body = await req.json();
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

    const operationId = Number(body.operationId);
    if (!Number.isSafeInteger(operationId) || operationId < 1)
      return NextResponse.json({ error: "Choose the route stage this purchase satisfies." }, { status: 400 });
    const [op] = await db.select().from(productionOperations).where(eq(productionOperations.id, operationId)).limit(1);
    if (!op) return NextResponse.json({ error: "Production stage not found." }, { status: 404 });
    if (!isPurchasedMethod(op.method))
      return NextResponse.json({
        error: `${op.stage.replaceAll("_", " ")} on this batch is not a ready-made stage. Record outsourced or vendor work under External Work instead - a purchase and a manufacturing contract are different costs and must stay separate.`,
      }, { status: 400 });

    const materialId = Number(body.materialId);
    if (!Number.isSafeInteger(materialId) || materialId < 1)
      return NextResponse.json({ error: `Choose the finished garment being bought. Add it under Materials with the category "${READY_MADE_CATEGORY}".` }, { status: 400 });
    const [material] = await db.select().from(materials).where(eq(materials.id, materialId)).limit(1);
    if (!material)
      return NextResponse.json({ error: `That garment is not in Matesther's catalogue. Add it under Materials with the category "${READY_MADE_CATEGORY}".` }, { status: 400 });

    const quantity = Number(body.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1)
      return NextResponse.json({ error: "Enter how many finished garments were bought, as a whole number." }, { status: 400 });

    // A stage cannot receive more finished garments than the route released into
    // it, so a purchase cannot be used to inflate a stage beyond its allocation.
    const derived = await deriveDetail(db, op.id);
    const alreadyPurchased = await db
      .select()
      .from(materialPurchases)
      .where(eq(materialPurchases.productionOperationId, op.id));
    const alreadyReceived = alreadyPurchased.reduce((sum, row) => sum + row.quantity, 0);
    const capacity = Math.max(0, derived.quantityReceived - alreadyReceived);
    if (quantity > capacity)
      return NextResponse.json({
        error: `This stage can take ${capacity} more finished garment(s) - it was allocated ${derived.quantityReceived} and ${alreadyReceived} have already been bought in.`,
      }, { status: 400 });

    const unitCost = body.unitCost === undefined || body.unitCost === "" || body.unitCost === null ? 0 : Number(body.unitCost);
    if (!Number.isFinite(unitCost) || unitCost < 0)
      return NextResponse.json({ error: "The cost per garment must be zero or more." }, { status: 400 });
    const purchaseDate = body.purchaseDate && /^\d{4}-\d{2}-\d{2}$/.test(String(body.purchaseDate))
      ? String(body.purchaseDate)
      : new Date().toISOString().slice(0, 10);
    const [batch] = await db.select().from(productionBatches).where(eq(productionBatches.id, op.productionBatchId)).limit(1);
    const [order] = batch ? await db.select().from(orders).where(eq(orders.id, batch.orderId)).limit(1) : [];
    const actor = { userId: session.id, name: session.name };

    const created = await db.transaction(async (tx) => {
      const [purchase] = await tx.insert(materialPurchases).values({
        organizationId: session.organizationId,
        materialId,
        supplier: body.supplier ? String(body.supplier).slice(0, 160) : null,
        quantity,
        unitCost,
        totalCost: quantity * unitCost,
        purchaseDate,
        orderId: order?.id ?? null,
        productionOperationId: op.id,
        orderVariantId: batch?.orderVariantId ?? null,
        notes: body.notes ? String(body.notes).slice(0, 2000) : null,
      }).returning();
      await applyMovements(tx, op, actor, [{
        type: MOVEMENT_EVENTS.RECEIVED_READYMADE,
        quantity,
        workerId: null,
        referenceType: "MATERIAL_PURCHASE",
        referenceId: purchase.id,
        reason: `${quantity} finished ${material.name} garment(s) bought in for ${op.stage} from ${purchase.supplier ?? "an unrecorded supplier"}`,
        notes: body.notes ? String(body.notes).slice(0, 2000) : null,
      }]);
      await tx.update(productionOperations)
        .set({ status: op.status === "PENDING" ? "IN_PROGRESS" : op.status })
        .where(eq(productionOperations.id, op.id));
      return purchase;
    });
    await refreshBatchAndOrder(op.productionBatchId);
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    console.error("Ready-made receipt failed", error);
    return NextResponse.json({ error: "Could not record this ready-made purchase." }, { status: 500 });
  }
}

/**
 * PUT /api/ready-made - accept or reject what actually arrived.
 * { id, quantityAccepted, quantityRejected?, notes? }
 *
 * Only the ACCEPTED quantity is released to the next route stage. A delivery of 100
 * cardigans where 4 are the wrong colour releases 96, and the 4 stay visible as a
 * rejected purchase rather than quietly vanishing into the order.
 */
export async function PUT(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const body = await req.json();
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1)
      return NextResponse.json({ error: "Choose the ready-made receipt to judge." }, { status: 400 });
    const [purchase] = await db.select().from(materialPurchases).where(eq(materialPurchases.id, id)).limit(1);
    if (!purchase || !purchase.productionOperationId)
      return NextResponse.json({ error: "That purchase is not a ready-made receipt against a production stage." }, { status: 404 });
    const [op] = await db.select().from(productionOperations).where(eq(productionOperations.id, purchase.productionOperationId)).limit(1);
    if (!op) return NextResponse.json({ error: "The route stage behind this receipt no longer exists." }, { status: 404 });

    const accepted = Number(body.quantityAccepted);
    const rejected = body.quantityRejected === undefined || body.quantityRejected === "" ? 0 : Number(body.quantityRejected);
    if (![accepted, rejected].every((value) => Number.isSafeInteger(value) && value >= 0))
      return NextResponse.json({ error: "Quantities must be non-negative whole garments." }, { status: 400 });
    if (accepted + rejected > purchase.quantity)
      return NextResponse.json({ error: `Only ${purchase.quantity} garment(s) were bought on this receipt.` }, { status: 400 });
    if (accepted + rejected <= 0)
      return NextResponse.json({ error: "Record at least one garment as accepted or rejected." }, { status: 400 });
    if (rejected > 0 && !String(body.notes ?? "").trim())
      return NextResponse.json({ error: "Explain why ready-made garments were rejected on arrival." }, { status: 400 });

    // Judge a receipt ONCE. Re-judging would let an accepted figure be moved later
    // with no event behind it - the same hole Task 2 closed on the stage counters.
    // The check reads the ledger rather than a status column, so the record that
    // proves it was already judged is the same record that stops it being judged
    // twice.
    const [alreadyJudged] = await db
      .select({ id: productionMovements.id })
      .from(productionMovements)
      .where(
        and(
          eq(productionMovements.referenceType, "MATERIAL_PURCHASE"),
          eq(productionMovements.referenceId, purchase.id),
          eq(productionMovements.eventType, MOVEMENT_EVENTS.READYMADE_ACCEPTED)
        )
      )
      .limit(1);
    if (alreadyJudged)
      return NextResponse.json({
        error: "This ready-made receipt has already been accepted. Its quantity is on the audit trail and cannot be judged a second time - record a new receipt for anything further.",
      }, { status: 400 });

    const actor = { userId: session.id, name: session.name };
    const result = await db.transaction(async (tx) => {
      const derived = await applyMovements(tx, op, actor, [
        { type: MOVEMENT_EVENTS.READYMADE_ACCEPTED, quantity: accepted, workerId: null,
          referenceType: "MATERIAL_PURCHASE", referenceId: purchase.id,
          reason: `${accepted} bought-in garment(s) accepted on arrival` },
        { type: MOVEMENT_EVENTS.READYMADE_REJECTED, quantity: rejected, workerId: null,
          referenceType: "MATERIAL_PURCHASE", referenceId: purchase.id,
          reason: `${rejected} bought-in garment(s) rejected on arrival`,
          notes: body.notes ? String(body.notes).slice(0, 2000) : null },
      ]);
      const status = statusFromQuantities(derived);
      await tx.update(productionOperations).set({
        status,
        inspector: session.name,
        inspectedAt: new Date(),
        completedAt: status === "COMPLETED" ? op.completedAt ?? new Date() : null,
      }).where(eq(productionOperations.id, op.id));
      // Only the accepted garments move on to the next applicable route stage.
      await releaseApprovedToNextStage(tx, op, derived.quantityApproved, actor);
      return derived;
    });
    await refreshBatchAndOrder(op.productionBatchId);
    return NextResponse.json({ ok: true, accepted, rejected, stage: result });
  } catch (error) {
    console.error("Ready-made acceptance failed", error);
    return NextResponse.json({ error: "Could not record this acceptance." }, { status: 500 });
  }
}
