import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orders, orderItems, orderItemSizes, productionBatches, productionOperations, workers } from "@/db/schema";
import { STAGES } from "@/lib/format";
import { refreshBatchAndOrder } from "@/lib/server";
import { guard, OWNER, STAFF } from "@/lib/authz";

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

/** Create a size/colour-specific batch with separate Cutting and Sewing pay. */
export async function POST(req: Request) {
  const denied = await guard(req, STAFF);
  if (denied) return denied;
  try {
    const body = await req.json();
    const orderId = Number(body.orderId);
    const itemId = body.orderItemId ? Number(body.orderItemId) : null;
    const quantity = Number(body.quantity);
    if (!Number.isSafeInteger(orderId) || orderId < 1 || !Number.isSafeInteger(quantity) || quantity < 1)
      return NextResponse.json({ error: "Choose an order and a positive whole-number batch quantity." }, { status: 400 });
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order || order.status === "CANCELLED")
      return NextResponse.json({ error: "This order is not available for production." }, { status: 400 });
    const [item] = itemId ? await db.select().from(orderItems).where(eq(orderItems.id, itemId)).limit(1) : [];
    if (itemId && (!item || item.orderId !== orderId))
      return NextResponse.json({ error: "Choose a garment from this order." }, { status: 400 });
    const size = String(body.size ?? "").trim().toUpperCase();
    const color = String(body.color ?? "").trim();
    if (size.length > 40 || color.length > 70)
      return NextResponse.json({ error: "Size or colour description is too long." }, { status: 400 });
    if (size && !item)
      return NextResponse.json({ error: "Choose a garment before assigning a size." }, { status: 400 });
    const sizes = item ? await db.select().from(orderItemSizes).where(eq(orderItemSizes.orderItemId, item.id)) : [];
    if (size && sizes.length && !sizes.some((row) => row.size.toUpperCase() === size))
      return NextResponse.json({ error: `Add size ${size} under the order's Sizes tab first.` }, { status: 400 });
    const targetSize = sizes.find((row) => row.size.toUpperCase() === size);
    const existing = await db.select().from(productionBatches).where(eq(productionBatches.orderId, orderId));
    if (targetSize) {
      const allocated = existing.filter((batch) => batch.orderItemId === itemId && batch.size?.toUpperCase() === size && batch.status !== "CANCELLED")
        .reduce((sum, batch) => sum + batch.quantity, 0);
      if (allocated + quantity > targetSize.quantity)
        return NextResponse.json({ error: `Only ${Math.max(0, targetSize.quantity - allocated)} unassigned ${size} garment(s) remain for this item.` }, { status: 400 });
    } else if (item && quantity > item.quantity)
      return NextResponse.json({ error: "Batch quantity cannot exceed the ordered quantity for this garment." }, { status: 400 });

    async function resolveWorker(raw: unknown, rawRate: unknown, specialty: string): Promise<Assignment> {
      if (!raw) return { id: null, rate: null };
      const id = Number(raw);
      const [person] = await db.select().from(workers).where(eq(workers.id, id)).limit(1);
      if (!person || person.status !== "ACTIVE" || person.organizationId !== order.organizationId || person.specialty.toLowerCase() !== specialty.toLowerCase())
        throw new Error(`Select an active ${specialty} from Matesther's Workers page.`);
      if (person.paymentType !== "PER_PIECE") return { id, rate: null };
      const rate = Number(rawRate);
      if (!Number.isSafeInteger(rate) || rate < 1)
        throw new Error(`Enter the agreed amount per piece for ${person.name} on this batch.`);
      return { id, rate };
    }
    const cutter = await resolveWorker(body.workerId, body.cuttingRate, "Cutter");
    const tailor = await resolveWorker(body.tailorId, body.sewingRate, "Tailor");
    if (tailor.id && sizes.length && !size)
      return NextResponse.json({ error: "Choose a size for the Tailor. Create another batch for each additional size." }, { status: 400 });
    if (body.expectedCompletionDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.expectedCompletionDate)))
      return NextResponse.json({ error: "Enter a valid expected completion date." }, { status: 400 });
    let suffix = existing.length;
    let batchNumber = "";
    do {
      batchNumber = `B-${order.orderNumber.replace("ORD-", "")}-${String.fromCharCode(65 + suffix++)}`;
    } while (existing.some((batch) => batch.batchNumber === batchNumber));
    if (body.batchNumber) batchNumber = String(body.batchNumber).trim().slice(0, 80);
    const batch = await db.transaction(async (tx) => {
      const [newBatch] = await tx.insert(productionBatches).values({
        orderId, orderItemId: itemId, batchNumber, quantity,
        size: size || null, color: color || null,
        status: cutter.id ? "IN_PROGRESS" : "PENDING",
      }).returning();
      await tx.insert(productionOperations).values(STAGES.map((stage) => {
        const assignment = stage === "CUTTING" ? cutter : stage === "SEWING" ? tailor : { id: null, rate: null };
        return {
          productionBatchId: newBatch.id, stage,
          workerId: assignment.id, pieceRate: assignment.rate,
          quantityReceived: stage === "CUTTING" ? quantity : 0,
          quantityRemaining: stage === "CUTTING" ? quantity : 0,
          quantityCompleted: 0, quantityRejected: 0,
          status: stage === "CUTTING" && cutter.id ? "IN_PROGRESS" : "PENDING",
          expectedCompletionDate: body.expectedCompletionDate || order.dueDate || null,
        };
      }));
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
