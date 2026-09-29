import { NextResponse } from "next/server";
import { guard, OWNER } from "@/lib/authz";
import { db } from "@/db";
import {
  orders,
  customers,
  orderItems,
  productionBatches,
  productionOperations,
} from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { batchProgress } from "@/lib/server";

export async function GET(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const [orderRows, customerRows, itemRows, batchRows, opRows] =
      await Promise.all([
        db.select().from(orders).orderBy(desc(orders.createdAt)),
        db.select().from(customers),
        db.select().from(orderItems),
        db.select().from(productionBatches),
        db.select().from(productionOperations),
      ]);
    const cMap = new Map(customerRows.map((c) => [c.id, c]));
    const opsByBatch = new Map<number, typeof opRows>();
    for (const o of opRows) {
      const a = opsByBatch.get(o.productionBatchId) ?? [];
      a.push(o);
      opsByBatch.set(o.productionBatchId, a);
    }
    const data = orderRows.map((o) => {
      const items = itemRows.filter((i) => i.orderId === o.id);
      const batches = batchRows
        .filter((b) => b.orderId === o.id)
        .filter((b) => {
          if (b.status !== "CANCELLED") return true;
          const approved = (opsByBatch.get(b.id) ?? []).reduce(
            (s, op) => s + (op.quantityApproved ?? 0),
            0
          );
          return approved > 0;
        });
      const ps = batches.map((b) =>
        batchProgress(opsByBatch.get(b.id) ?? [], b.quantity ?? 0)
      );
      return {
        ...o,
        customer: cMap.get(o.customerId ?? -1)?.name ?? "-",
        customerId: o.customerId,
        quantity: items.reduce((s, i) => s + (i.quantity ?? 0), 0),
        progress: batches.length
          ? Math.round(ps.reduce((a, b) => a + b, 0) / ps.length)
          : 0,
        batchCount: batches.length,
      };
    });
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const b = await req.json();
    if (!b.customerId)
      return NextResponse.json({ error: "Customer is required" }, { status: 400 });
    if (!b.items || b.items.length === 0)
      return NextResponse.json({ error: "Add at least one uniform product" }, { status: 400 });

    const existing = await db.select().from(orders);
    const year = new Date().getFullYear();
    const next = existing.length + 1;
    const orderNumber =
      b.orderNumber || `ORD-${year}-${String(next).padStart(3, "0")}`;

    const itemsTotal = b.items.reduce(
      (s: number, i: any) => s + Number(i.quantity || 0) * Number(i.unitPrice || 0),
      0
    );
    const [order] = await db
      .insert(orders)
      .values({
        organizationId: 1,
        customerId: Number(b.customerId),
        orderNumber,
        orderDate: b.orderDate || new Date().toISOString().slice(0, 10),
        dueDate: b.dueDate || null,
        status: "PENDING",
        totalAmount: itemsTotal,
        amountPaid: 0,
        balance: itemsTotal,
        notes: b.notes || null,
      })
      .returning();

    for (const it of b.items) {
      await db.insert(orderItems).values({
        orderId: order.id,
        productId: Number(it.productId),
        quantity: Number(it.quantity) || 0,
        unitPrice: Number(it.unitPrice) || 0,
        totalPrice: (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0),
        notes: it.notes || null,
      });
    }
    return NextResponse.json(order, { status: 201 });
  } catch (e: any) {
    const msg = String(e.message || "");
    if (msg.includes("unique") || msg.includes("duplicate"))
      return NextResponse.json({ error: "That order number already exists." }, { status: 400 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
