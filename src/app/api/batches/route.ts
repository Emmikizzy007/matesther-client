import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orders, orderItems, orderItemSizes, productionBatches, productionOperations, workers } from "@/db/schema";
import { STAGE_ROLES, sameRole, variantLabel } from "@/lib/format";
import { MOVEMENT_EVENTS, applyMovements } from "@/lib/production-ledger";
import { resolveRoute, type RouteStage } from "@/lib/production-route";
import { refreshBatchAndOrder } from "@/lib/server";
import { guard, getSessionUser, productionAccess, OWNER, STAFF } from "@/lib/authz";
import { workerHoldsRole, type RoleCache } from "@/lib/worker-roles";

type Assignment = { id: number | null; rate: number | null };

export async function GET(req: Request) {
  const denied = await guard(req, STAFF);
  if (denied) return denied;
  try {
    const raw = new URL(req.url).searchParams.get("orderId");
    const rows = raw
      ? await db.select().from(productionBatches).where(eq(productionBatches.orderId, Number(raw)))
      : await db.select().from(productionBatches);
    return NextResponse.json(rows);
  } catch (error) {
    console.error("Batch list failed", error);
    return NextResponse.json({ error: "Could not load production batches." }, { status: 500 });
  }
}

/**
 * POST /api/batches - allocate an exact garment variant to production.
 *
 * A batch is ONE exact variant (item + optional size + optional colour) and a
 * quantity of it, following ONE route. It has always been size/colour aware; what
 * changed in Task 3 is that:
 *
 *   - the size and colour may now come from an `orderVariantId`, so the batch is
 *     tied to the exact variant the school ordered instead of to free text that
 *     happens to match;
 *   - the allocation ceiling is enforced per VARIANT server-side, not just per item
 *     and per size;
 *   - the stages created come from a ROUTE, which may be all eight stages, fewer,
 *     or in a different order - and the route is frozen onto the batch as
 *     `route_position` on each operation;
 *   - each stage carries a production METHOD (internal / machine / outsourced /
 *     ready-made / vendor processing);
 *   - worker assignment is by the ROLE a stage requires, so the legacy
 *     `workerId` + `cuttingRate` pair still lands on the route's Cutter stage and
 *     `tailorId` + `sewingRate` on its Tailor stage, while a generic `assignments`
 *     list can fill any stage of any route.
 *
 * A request shaped exactly like the old one gets exactly the old result: the
 * built-in eight-stage route, all INTERNAL, quantity placed in front of CUTTING.
 */
export async function POST(req: Request) {
  const denied = await guard(req, STAFF);
  if (denied) return denied;
  try {
    const body = await req.json();
    const orderId = Number(body.orderId);
    const itemId = body.orderItemId ? Number(body.orderItemId) : null;
    const variantId = body.orderVariantId ? Number(body.orderVariantId) : null;
    const quantity = Number(body.quantity);
    if (!Number.isSafeInteger(orderId) || orderId < 1 || !Number.isSafeInteger(quantity) || quantity < 1)
      return NextResponse.json({ error: "Choose an order and a positive whole-number batch quantity." }, { status: 400 });
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
    if (!order || order.organizationId !== session.organizationId || ["CANCELLED", "COMPLETED"].includes(order.status))
      return NextResponse.json({ error: "This order is not available for production." }, { status: 400 });
    const access = await productionAccess(session);
    const [item] = itemId ? await db.select().from(orderItems).where(eq(orderItems.id, itemId)).limit(1) : [];
    if (itemId && (!item || item.orderId !== orderId))
      return NextResponse.json({ error: "Choose a garment from this order." }, { status: 400 });

    // ---------- the exact variant ----------
    const variants = item
      ? await db.select().from(orderItemSizes).where(eq(orderItemSizes.orderItemId, item.id))
      : [];
    const requestedSize = String(body.size ?? "").trim().toUpperCase();
    const requestedColor = String(body.color ?? "").trim();
    if (requestedSize.length > 40 || requestedColor.length > 70)
      return NextResponse.json({ error: "Size or colour description is too long." }, { status: 400 });
    if ((requestedSize || variantId) && !item)
      return NextResponse.json({ error: "Choose a garment before assigning a size." }, { status: 400 });

    let variant: (typeof variants)[number] | null = null;
    if (variantId) {
      variant = variants.find((row) => row.id === variantId) ?? null;
      if (!variant)
        return NextResponse.json({ error: "Choose a size and colour that this order actually lists." }, { status: 400 });
    } else if (requestedSize || requestedColor) {
      // Legacy callers still pass size/colour as text. Match them to a real variant
      // when the order has any, so a batch can never claim a combination the school
      // never ordered.
      if (variants.length) {
        variant = variants.find((row) =>
          String(row.size ?? "").trim().toUpperCase() === requestedSize &&
          String(row.color ?? "").trim().toLowerCase() === requestedColor.toLowerCase()
        ) ?? null;
        if (requestedSize && !variant && !variants.some((row) => String(row.size ?? "").trim().toUpperCase() === requestedSize))
          return NextResponse.json({ error: `Add size ${requestedSize} under the order's Sizes tab first.` }, { status: 400 });
        if (requestedSize && requestedColor && !variant)
          return NextResponse.json({
            error: `${requestedColor} in size ${requestedSize} is not one of this order's variants. Add it under the order's Sizes tab first.`,
          }, { status: 400 });
      }
    }
    // The batch keeps its own snapshot of size and colour: every existing screen,
    // delivery line and printed document reads those two columns, and a snapshot
    // must survive later edits to the order.
    const size = variant ? String(variant.size ?? "").trim().toUpperCase() : requestedSize;
    const color = variant ? String(variant.color ?? "").trim() : requestedColor;

    // ---------- allocation ceilings, all server-side ----------
    const existing = await db.select().from(productionBatches).where(eq(productionBatches.orderId, orderId));
    const live = existing.filter((batch) => batch.status !== "CANCELLED");
    const itemAllocated = live
      .filter((batch) => batch.orderItemId === itemId)
      .reduce((sum, batch) => sum + batch.quantity, 0);
    if (item && itemAllocated + quantity > item.quantity)
      return NextResponse.json({ error: `Only ${Math.max(0, item.quantity - itemAllocated)} garment(s) remain to be assigned for this item.` }, { status: 400 });

    if (variant) {
      // The strongest ceiling: this exact item + size + colour. Without it two
      // batches could each stay inside the item and size limits and still
      // over-commit the navy size-8 blazers specifically.
      const variantAllocated = live
        .filter((batch) => batch.orderVariantId === variant!.id ||
          (batch.orderVariantId === null && batch.orderItemId === itemId &&
            String(batch.size ?? "").toUpperCase() === size && String(batch.color ?? "").trim() === color))
        .reduce((sum, batch) => sum + batch.quantity, 0);
      if (variantAllocated + quantity > variant.quantity)
        return NextResponse.json({
          error: `Only ${Math.max(0, variant.quantity - variantAllocated)} unassigned ${variantLabel(size, color)} garment(s) remain on this order.`,
        }, { status: 400 });
    } else if (size) {
      // Legacy path: a size was typed but the order lists variants by size only.
      const targetSize = variants.find((row) => String(row.size ?? "").toUpperCase() === size);
      if (variants.length && !targetSize)
        return NextResponse.json({ error: `Add size ${size} under the order's Sizes tab first.` }, { status: 400 });
      if (targetSize) {
        const allocated = live
          .filter((batch) => batch.orderItemId === itemId && String(batch.size ?? "").toUpperCase() === size)
          .reduce((sum, batch) => sum + batch.quantity, 0);
        if (allocated + quantity > targetSize.quantity)
          return NextResponse.json({ error: `Only ${Math.max(0, targetSize.quantity - allocated)} unassigned ${size} garment(s) remain for this item.` }, { status: 400 });
      }
    }

    // ---------- the route ----------
    const resolved = await resolveRoute({
      organizationId: order.organizationId,
      productId: item?.productId ?? null,
      routeId: body.routeId ?? null,
      stages: body.stages,
    });
    if ("error" in resolved) return NextResponse.json({ error: resolved.error }, { status: 400 });
    const route = resolved;
    /** The role a stage needs: the route may override the default stage map. */
    const roleOf = (stage: RouteStage) =>
      stage.roleRequired ?? STAGE_ROLES[stage.stage as keyof typeof STAGE_ROLES] ?? null;

    // ---------- who is assigned to what ----------
    type Assignment = { stage: string; workerId: number; rate: number | null; role: string | null };
    const wanted: Assignment[] = [];
    if (Array.isArray(body.assignments)) {
      for (const entry of body.assignments) {
        const stageName = String(entry?.stage ?? "").trim().toUpperCase();
        const workerId = entry?.workerId ? Number(entry.workerId) : null;
        if (!stageName || !workerId) continue;
        const routeStage = route.stages.find((candidate) => candidate.stage === stageName);
        if (!routeStage)
          return NextResponse.json({ error: `${stageName} is not part of this batch's route.` }, { status: 400 });
        wanted.push({ stage: stageName, workerId, rate: entry?.pieceRate === undefined || entry?.pieceRate === "" || entry?.pieceRate === null ? null : Number(entry.pieceRate), role: roleOf(routeStage) });
      }
    }
    // Legacy shape: the Cutter and the Tailor, named directly. Each lands on the
    // FIRST stage of this route that requires that role - normally CUTTING and
    // SEWING, but a route that skips cutting simply has no Cutter stage to fill.
    const legacy: [unknown, unknown, string, string][] = [
      [body.workerId, body.cuttingRate, "Cutter", "cutting"],
      [body.tailorId, body.sewingRate, "Tailor", "sewing"],
    ];
    for (const [rawWorker, rawRate, role, label] of legacy) {
      if (!rawWorker) continue;
      const target = route.stages.find((candidate) => sameRole(roleOf(candidate), role));
      if (!target)
        return NextResponse.json({
          error: `This batch's route has no ${role} stage, so ${label} work cannot be assigned to it. Choose a route that includes ${role === "Cutter" ? "Cutting" : "Sewing"}, or assign a different stage.`,
        }, { status: 400 });
      if (wanted.some((entry) => entry.stage === target.stage)) continue;
      wanted.push({ stage: target.stage, workerId: Number(rawWorker), rate: rawRate === undefined || rawRate === "" || rawRate === null ? null : Number(rawRate), role });
    }

    // A cutter-supervisor may not place cutting work, however it was requested.
    if (!access.canAssignCutting && wanted.some((entry) => sameRole(entry.role, "Cutter")))
      return NextResponse.json({
        error: "As a cutter-supervisor, you cannot assign cutting work to yourself or another Cutter. Leave Cutting unassigned for the Owner or a non-cutting supervisor.",
      }, { status: 403 });

    const roleCache: RoleCache = new Map();
    const resolvedAssignments = new Map<string, { id: number | null; rate: number | null }>();
    for (const stage of route.stages) resolvedAssignments.set(stage.stage, { id: null, rate: null });
    for (const entry of wanted) {
      const [person] = await db.select().from(workers).where(eq(workers.id, entry.workerId)).limit(1);
      // A person qualifies when the required role is one of the roles they hold.
      if (!person || person.status !== "ACTIVE" || person.organizationId !== order.organizationId)
        return NextResponse.json({ error: `Select an active ${entry.role ?? "worker"} from Matesther's Workers page.` }, { status: 400 });
      if (entry.role && !(await workerHoldsRole(person, entry.role, roleCache)))
        return NextResponse.json({ error: `${entry.stage.replaceAll("_", " ")} needs a ${entry.role}. ${person.name} does not hold that role.` }, { status: 400 });
      if (person.paymentType === "PER_PIECE") {
        const rate = Number(entry.rate);
        if (!Number.isSafeInteger(rate) || rate < 1)
          return NextResponse.json({ error: `Enter the agreed amount per piece for ${person.name} on this batch.` }, { status: 400 });
        resolvedAssignments.set(entry.stage, { id: person.id, rate });
      } else {
        resolvedAssignments.set(entry.stage, { id: person.id, rate: null });
      }
    }
    if (wanted.some((entry) => entry.role === "Tailor") && variants.length && !variant && !size)
      return NextResponse.json({ error: "Choose a size for the Tailor. Create another batch for each additional size." }, { status: 400 });
    if (body.expectedCompletionDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.expectedCompletionDate)))
      return NextResponse.json({ error: "Enter a valid expected completion date." }, { status: 400 });

    let suffix = existing.length;
    let batchNumber = "";
    do {
      batchNumber = `B-${order.orderNumber.replace("ORD-", "")}-${String.fromCharCode(65 + suffix++)}`;
    } while (existing.some((batch) => batch.batchNumber === batchNumber));
    if (body.batchNumber) batchNumber = String(body.batchNumber).trim().slice(0, 80);

    const actor = { userId: session.id, name: session.name };
    const firstAssignment = resolvedAssignments.get(route.stages[0].stage) ?? { id: null, rate: null };
    const batch = await db.transaction(async (tx) => {
      const [newBatch] = await tx.insert(productionBatches).values({
        orderId, orderItemId: itemId, batchNumber, quantity,
        size: size || null, color: color || null,
        orderVariantId: variant?.id ?? null,
        // Reference only. The batch's real route is its operations in position
        // order, so editing or deleting this route later cannot rewrite history.
        routeId: route.routeId,
        status: firstAssignment.id ? "IN_PROGRESS" : "PENDING",
      }).returning();
      // One operation per ROUTE stage, in route order, each carrying its own
      // method. A route that skips a stage simply has no row for it, which is what
      // stops that garment being reported as stuck at a stage it does not have.
      const created = await tx.insert(productionOperations).values(route.stages.map((stage, index) => {
        const assignment = resolvedAssignments.get(stage.stage) ?? { id: null, rate: null };
        const isFirst = index === 0;
        return {
          productionBatchId: newBatch.id,
          stage: stage.stage,
          routePosition: stage.position,
          routeStageId: stage.routeStageId,
          method: stage.method || "INTERNAL",
          workerId: assignment.id,
          pieceRate: assignment.rate,
          // Garments enter the route at its first stage, whatever that stage is.
          quantityReceived: isFirst ? quantity : 0,
          quantityRemaining: isFirst ? quantity : 0,
          quantityCompleted: 0, quantityRejected: 0,
          status: isFirst && assignment.id ? "IN_PROGRESS" : "PENDING",
          expectedCompletionDate: body.expectedCompletionDate || order.dueDate || null,
        };
      })).returning();
      // The quantity placed in front of the first stage is itself a ledger event,
      // so every counter this batch will ever show has an event behind it.
      for (const op of created) {
        if (op.quantityReceived > 0) {
          await applyMovements(tx, op, actor, [{
            type: MOVEMENT_EVENTS.ALLOCATION,
            quantity: op.quantityReceived,
            workerId: op.workerId,
            referenceType: "PRODUCTION_BATCH",
            referenceId: newBatch.id,
            reason: `Batch ${batchNumber} allocated ${op.quantityReceived} ${variantLabel(size, color)} garment(s) to ${op.stage}`,
          }]);
        }
      }
      return newBatch;
    });
    await refreshBatchAndOrder(batch.id);
    return NextResponse.json(batch, { status: 201 });
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("Enter the agreed") || error.message.startsWith("Select an active")))
      return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("Start production failed", error);
    return NextResponse.json({ error: "Could not create this production batch." }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const id = Number(new URL(req.url).searchParams.get("id"));
    if (!Number.isSafeInteger(id) || id < 1)
      return NextResponse.json({ error: "Valid batch ID required." }, { status: 400 });
    const ops = await db.select().from(productionOperations).where(eq(productionOperations.productionBatchId, id));
    if (ops.some((op) => op.quantityCompleted > 0 || op.quantityApproved > 0))
      return NextResponse.json({ error: "This batch has submitted work. Keep the production history and cancel its stages instead." }, { status: 400 });
    await db.delete(productionBatches).where(eq(productionBatches.id, id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Batch removal failed", error);
    return NextResponse.json({ error: "Could not remove this empty batch." }, { status: 500 });
  }
}
