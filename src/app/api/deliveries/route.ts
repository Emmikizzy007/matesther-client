import { NextResponse } from "next/server";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { orderFulfilment } from "@/lib/production-control";
import { customers, deliveries, deliveryLines, orderItems, orderItemSizes, orders, organizations, products } from "@/db/schema";
import { guard, getSessionUser, OWNER } from "@/lib/authz";

export const dynamic = "force-dynamic";

type DeliveryInput = {
  orderId?: number | string;
  id?: number | string;
  deliveryDate?: string;
  deliveredQuantity?: number | string;
  recipient?: string;
  deliveryAddress?: string;
  status?: string;
  notes?: string;
  lines?: { orderItemId: number | string; size?: string; quantity: number | string }[];
};

function goodDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

async function prepareLines(orderId: number, raw: DeliveryInput["lines"]) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50) throw new Error("Add one or more garment lines (up to 50) for this delivery.");
  const [items, catalog, sizes] = await Promise.all([
    db.select().from(orderItems).where(eq(orderItems.orderId, orderId)),
    db.select().from(products),
    db.select().from(orderItemSizes),
  ]);
  const productNames = new Map(catalog.map((p) => [p.id, p.name]));
  const byItem = new Map(items.map((item) => [item.id, item]));
  const totals = new Map<number, number>();
  const prepared = raw.map((line) => {
    const itemId = Number(line.orderItemId);
    const qty = Number(line.quantity);
    const item = byItem.get(itemId);
    if (!item) throw new Error("Every garment must belong to the selected order.");
    if (!Number.isSafeInteger(qty) || qty < 1) throw new Error("Garment quantities must be whole numbers greater than zero.");
    const size = String(line.size ?? "").trim().toUpperCase();
    if (size.length > 40) throw new Error("Keep size labels under 40 characters.");
    const itemSizes = sizes.filter((s) => s.orderItemId === itemId);
    // `size` is nullable now that a variant may have a colour but no size run.
    if (size && itemSizes.length && !itemSizes.some((s) => String(s.size ?? "").toUpperCase() === size))
      throw new Error(`Size ${size} is not listed for ${productNames.get(item.productId ?? -1) ?? "this garment"}. Update the order sizes first.`);
    totals.set(itemId, (totals.get(itemId) ?? 0) + qty);
    if (totals.get(itemId)! > item.quantity) throw new Error("This delivery contains more of a garment than were ordered.");
    return {
      orderItemId: itemId,
      description: productNames.get(item.productId ?? -1) ?? "School uniform",
      size: size || null,
      quantity: qty,
    };
  });
  return { prepared, total: prepared.reduce((sum, line) => sum + line.quantity, 0), items };
}

/** GET /api/deliveries?orderId=... or ?deliveryId=... */
export async function GET(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const query = new URL(req.url).searchParams;
    const id = query.get("deliveryId");
    if (id) {
      const deliveryId = Number(id);
      if (!Number.isSafeInteger(deliveryId) || deliveryId < 1)
        return NextResponse.json({ error: "Invalid delivery ID." }, { status: 400 });
      const [delivery] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId)).limit(1);
      if (!delivery) return NextResponse.json({ error: "Delivery not found." }, { status: 404 });
      const [orderRows, customerRows, orgRows, lines, allDeliveries, items] = await Promise.all([
        db.select().from(orders).where(eq(orders.id, delivery.orderId)).limit(1),
        db.select().from(customers),
        db.select({ name: organizations.name, phone: organizations.phone, email: organizations.email, address: organizations.address }).from(organizations).where(eq(organizations.id, 1)).limit(1),
        db.select().from(deliveryLines).where(eq(deliveryLines.deliveryId, deliveryId)).orderBy(asc(deliveryLines.id)),
        db.select().from(deliveries).where(eq(deliveries.orderId, delivery.orderId)),
        db.select().from(orderItems).where(eq(orderItems.orderId, delivery.orderId)),
      ]);
      const order = orderRows[0];
      if (!order) return NextResponse.json({ error: "Order not found." }, { status: 404 });
      const customer = customerRows.find((row) => row.id === order.customerId);
      const orderedQty = items.reduce((sum, item) => sum + item.quantity, 0);
      const shippedBefore = allDeliveries
        .filter((row) => row.deliveryDate < delivery.deliveryDate || (row.deliveryDate === delivery.deliveryDate && row.id < delivery.id))
        .reduce((sum, row) => sum + row.deliveredQuantity, 0);
      return NextResponse.json({
        delivery: { ...delivery, deliveryNumber: `MTH-DLV-${String(delivery.id).padStart(4, "0")}` },
        lines: lines.length ? lines.map((line) => ({ description: line.description, size: line.size, quantity: line.quantity })) : [
          { description: "School uniforms (garment breakdown not recorded)", size: null, quantity: delivery.deliveredQuantity },
        ],
        legacySummary: lines.length === 0,
        order: { orderNumber: order.orderNumber, orderDate: order.orderDate, orderedQuantity: orderedQty, shippedBefore, remainingAfter: Math.max(0, orderedQty - shippedBefore - delivery.deliveredQuantity) },
        customer: customer ? { name: customer.name, contactPerson: customer.contactPerson, phone: customer.phone, email: customer.email, address: customer.address } : null,
        business: orgRows[0] ?? null,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const orderId = query.get("orderId");
    const [rows, orderRows, customerRows] = await Promise.all([
      db.select().from(deliveries).orderBy(desc(deliveries.deliveryDate), desc(deliveries.id)),
      db.select().from(orders),
      db.select().from(customers),
    ]);
    const ordersById = new Map(orderRows.map((row) => [row.id, row]));
    const customersById = new Map(customerRows.map((row) => [row.id, row]));
    const result = rows
      .filter((row) => !orderId || row.orderId === Number(orderId))
      .map((row) => ({ ...row, deliveryNumber: `MTH-DLV-${String(row.id).padStart(4, "0")}`, orderNumber: ordersById.get(row.orderId)?.orderNumber ?? "Not found", customer: customersById.get(ordersById.get(row.orderId)?.customerId ?? -1)?.name ?? "Not found" }));
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Delivery load failed", error);
    return NextResponse.json({ error: "Unable to load deliveries. Please try again." }, { status: 500 });
  }
}

/** POST records a new delivery and its actual garment/size lines. */
export async function POST(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    /**
     * The actor is the signed-in user, read from the session.
     *
     * Nothing here is taken from the request body: a caller must not be able to put somebody
     * else's name on a receipt, a packing record or a delivery note, which is exactly what made
     * payroll's `paidBy` worth fixing. Same derivation as `worker_payments.paid_by`,
     * `stage_inspections.inspected_by` and the ledger's `actor_user_id` / `actor_name`.
     *
     * Stamped once, when the record is created, and never rewritten by a later edit - so it
     * means WHO RECORDED THIS, not who last touched it. An edit is already OWNER-only on all
     * three routes, and silently moving this column would change the meaning of rows that are
     * already on somebody's filing cabinet.
     */
    const actor = await getSessionUser(req);
    const body: DeliveryInput = await req.json();
    const orderId = Number(body.orderId);
    if (!Number.isSafeInteger(orderId) || orderId < 1)
      return NextResponse.json({ error: "Select an order." }, { status: 400 });
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order || order.status === "CANCELLED") return NextResponse.json({ error: "This order is not available for delivery." }, { status: 400 });
    const date = body.deliveryDate || new Date().toISOString().slice(0, 10);
    if (!goodDate(date)) return NextResponse.json({ error: "Enter a valid delivery date." }, { status: 400 });
    const { prepared, total, items } = await prepareLines(orderId, body.lines);
    const prior = await db.select().from(deliveries).where(eq(deliveries.orderId, orderId));
    const alreadyDelivered = prior.reduce((sum, row) => sum + row.deliveredQuantity, 0);
    const ordered = items.reduce((sum, item) => sum + item.quantity, 0);
    if (alreadyDelivered + total > ordered)
      return NextResponse.json({ error: `Only ${Math.max(0, ordered - alreadyDelivered)} garments remain undelivered for this order.` }, { status: 400 });

    /**
     * And a delivery cannot run ahead of what production actually made and had approved.
     *
     * The check above is against what was ORDERED, which is a ceiling on the contract, not
     * on the factory: an order of a hundred could be delivered in full with sixty approved
     * garments and forty that never existed. The figure used here is the same derived
     * `approved` the order page and the control board show, from the same `orderFulfilment`,
     * so what management sees and what this route will allow cannot drift apart.
     *
     * An order that never entered production keeps the ordered ceiling it has always had, so
     * a historical order or one satisfied off the floor still delivers exactly as before.
     */
    const fulfilment = await orderFulfilment(orderId);
    if (fulfilment?.productionStarted && alreadyDelivered + total > fulfilment.ceiling) {
      const stillDeliverable = Math.max(0, fulfilment.ceiling - alreadyDelivered);
      return NextResponse.json({
        error: `Production has approved ${fulfilment.approved} of the ${fulfilment.ordered} garments ordered, and ${alreadyDelivered} have already been delivered, so only ${stillDeliverable} more can be delivered. A delivery cannot run ahead of approved production - approve the work first, or correct the quantities with a reason if the ledger is wrong.`,
      }, { status: 400 });
    }
    const created = await db.transaction(async (tx) => {
      const [delivery] = await tx.insert(deliveries).values({
        orderId, deliveryDate: date, deliveredQuantity: total,
        recipient: String(body.recipient ?? "").trim() || null,
        deliveryAddress: String(body.deliveryAddress ?? "").trim() || null,
        status: body.status === "PARTIAL" ? "PARTIAL" : "DELIVERED",
        notes: String(body.notes ?? "").trim() || null,
        recordedById: actor?.id ?? null,
        recordedByName: actor?.name ?? null,
      }).returning();
      await tx.insert(deliveryLines).values(prepared.map((line) => ({ ...line, deliveryId: delivery.id })));
      return delivery;
    });
    return NextResponse.json({ ...created, deliveryNumber: `MTH-DLV-${String(created.id).padStart(4, "0")}` }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && /^(Add one|Every garment|Garment quantities|Keep size|Size |This delivery)/.test(error.message))
      return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("Delivery save failed", error);
    return NextResponse.json({ error: "Unable to record this delivery. Please try again." }, { status: 500 });
  }
}

/** PUT updates a delivery and optionally replaces its garment lines. */
export async function PUT(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const body: DeliveryInput = await req.json();
    const id = Number(body.id);
    const [existing] = await db.select().from(deliveries).where(eq(deliveries.id, id)).limit(1);
    if (!existing) return NextResponse.json({ error: "Delivery not found." }, { status: 404 });
    const date = body.deliveryDate || existing.deliveryDate;
    if (!goodDate(date)) return NextResponse.json({ error: "Enter a valid delivery date." }, { status: 400 });
    const rows = body.lines ? await prepareLines(existing.orderId, body.lines) : null;
    const newTotal = rows?.total ?? existing.deliveredQuantity;
    if (rows) {
      const prior = await db.select().from(deliveries).where(eq(deliveries.orderId, existing.orderId));
      const alreadyDelivered = prior.filter((d) => d.id !== id).reduce((sum, d) => sum + d.deliveredQuantity, 0);
      if (alreadyDelivered + newTotal > rows.items.reduce((sum, item) => sum + item.quantity, 0))
        return NextResponse.json({ error: "This delivery exceeds the garments ordered." }, { status: 400 });
    }
    const updated = await db.transaction(async (tx) => {
      const [delivery] = await tx.update(deliveries).set({
        deliveryDate: date, deliveredQuantity: newTotal,
        recipient: body.recipient === undefined ? existing.recipient : String(body.recipient).trim() || null,
        deliveryAddress: body.deliveryAddress === undefined ? existing.deliveryAddress : String(body.deliveryAddress).trim() || null,
        status: body.status === "PARTIAL" || body.status === "DELIVERED" ? body.status : existing.status,
        notes: body.notes === undefined ? existing.notes : String(body.notes).trim() || null,
      }).where(eq(deliveries.id, id)).returning();
      if (rows) {
        await tx.delete(deliveryLines).where(eq(deliveryLines.deliveryId, id));
        await tx.insert(deliveryLines).values(rows.prepared.map((line) => ({ ...line, deliveryId: id })));
      }
      return delivery;
    });
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error && /^(Add one|Every garment|Garment quantities|Keep size|Size |This delivery)/.test(error.message))
      return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("Delivery edit failed", error);
    return NextResponse.json({ error: "Unable to update the delivery." }, { status: 500 });
  }
}
