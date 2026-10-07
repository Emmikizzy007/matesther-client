import { NextResponse } from "next/server";
import { guard, getSessionUser, OWNER } from "@/lib/authz";
import { db } from "@/db";
import { orderFulfilment } from "@/lib/production-control";
import { packingRecords, orders, customers } from "@/db/schema";
import { desc, eq, inArray, sql } from "drizzle-orm";

/**
 * GET /api/packing?orderId=&limit=&offset=
 *
 * Packing records, newest first. `orderId` is a WHERE CLAUSE rather than a filter
 * applied after every record in the database has been read and enriched, which is what
 * it was - and the order page asks for one order's packing every time it opens.
 * Orders and schools are then fetched for the records being returned only.
 */
export async function GET(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const { searchParams } = new URL(req.url);
    const rawOrderId = searchParams.get("orderId");
    if (rawOrderId !== null && rawOrderId.trim() !== "" && !/^\d+$/.test(rawOrderId.trim()))
      return NextResponse.json({ error: "Choose a valid order." }, { status: 400 });
    const orderId = rawOrderId && /^\d+$/.test(rawOrderId.trim()) ? Number(rawOrderId.trim()) : null;
    const rawLimit = searchParams.get("limit") ? Number(searchParams.get("limit")) : NaN;
    const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
    const rawOffset = searchParams.get("offset") ? Number(searchParams.get("offset")) : 0;
    const offset = Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

    const where = orderId !== null ? eq(packingRecords.orderId, orderId) : undefined;
    const [totalRow] = await db.select({ total: sql<number>`count(*)` }).from(packingRecords).where(where);
    const total = Number(totalRow?.total ?? 0);
    const rows = total === 0
      ? []
      : await db.select().from(packingRecords).where(where)
          .orderBy(desc(packingRecords.packedAt), desc(packingRecords.id))
          .limit(limit).offset(offset);

    const orderIds = [...new Set(rows.map((row) => row.orderId))];
    const orderRows = orderIds.length
      ? await db.select({ id: orders.id, orderNumber: orders.orderNumber, customerId: orders.customerId })
          .from(orders).where(inArray(orders.id, orderIds))
      : [];
    const customerIds = [...new Set(orderRows.map((o) => o.customerId).filter((v): v is number => v !== null))];
    const customerRows = customerIds.length
      ? await db.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, customerIds))
      : [];
    const oMap = new Map(orderRows.map((o) => [o.id, o]));
    const cMap = new Map(customerRows.map((c) => [c.id, c]));
    const data = rows.map((p) => {
      const o = oMap.get(p.orderId);
      return {
        ...p,
        orderNumber: o?.orderNumber ?? "-",
        customer: o?.customerId ? cMap.get(o.customerId)?.name ?? "-" : "-",
      };
    });
    return NextResponse.json(data, {
      headers: { "Cache-Control": "private, no-store", "X-Total-Count": String(total) },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
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
    const b = await req.json();
    const orderId = Number(b.orderId);
    if (!Number.isSafeInteger(orderId) || orderId < 1)
      return NextResponse.json({ error: "Order is required" }, { status: 400 });
    const packing = Number(b.quantityPacked);
    if (!Number.isFinite(packing) || packing <= 0)
      return NextResponse.json({ error: "Quantity packed is required" }, { status: 400 });

    /**
     * Only garments that production has actually finished and approved can be packed.
     *
     * This used to accept any positive number against any order id, so packing could run
     * arbitrarily far ahead of the floor - an order of ten could be packed as five hundred,
     * and nothing downstream could tell the difference between a packed garment and a
     * made one. The ceiling is the same derived figure the order page and the control board
     * show, from the same `orderFulfilment`, so the three cannot disagree.
     *
     * An order that has entered production is bounded by what production approved. One that
     * never did keeps the ceiling it has always had - what was ordered - so a historical
     * order, or one satisfied entirely off the floor, does not suddenly become impossible to
     * pack. Nothing already recorded is touched.
     */
    const fulfilment = await orderFulfilment(orderId);
    if (!fulfilment) return NextResponse.json({ error: "Order not found" }, { status: 404 });
    const stillPackable = Math.max(0, fulfilment.ceiling - fulfilment.packed);
    if (packing > stillPackable)
      return NextResponse.json({
        error: fulfilment.productionStarted
          ? `Production has approved ${fulfilment.approved} garment(s) for this order and ${fulfilment.packed} are already packed, so only ${stillPackable} more can be packed. Packing cannot run ahead of approved production - approve the work first, or correct the quantities with a reason if the ledger is wrong.`
          : `Only ${fulfilment.ordered} garment(s) were ordered and ${fulfilment.packed} are already packed, so only ${stillPackable} more can be packed.`,
      }, { status: 400 });

    const [row] = await db
      .insert(packingRecords)
      .values({
        orderId,
        quantityPacked: packing,
        packageCount: Number(b.packageCount) || 0,
        notes: b.notes || null,
        recordedById: actor?.id ?? null,
        recordedByName: actor?.name ?? null,
      })
      .returning();
    return NextResponse.json(row, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}
