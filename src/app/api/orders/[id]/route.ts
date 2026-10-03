import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  orders,
  customers,
  orderItems,
  products,
  productionBatches,
  productionOperations,
  workers,
  materials,
  materialPurchases,
  materialUsage,
  expenses,
  payments,
  packingRecords,
  deliveries,
  qualityChecks,
  reworkRecords,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { refreshOrderMoney, batchProgress } from "@/lib/server";
import { guard, OWNER } from "@/lib/authz";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const { id } = await params;
    const orderId = Number(id);
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

    const [customerRows, itemRows, productRows, batchRows, workerRows, materialRows] =
      await Promise.all([
        db.select().from(customers),
        db.select().from(orderItems).where(eq(orderItems.orderId, orderId)),
        db.select().from(products),
        db.select().from(productionBatches).where(eq(productionBatches.orderId, orderId)),
        db.select().from(workers),
        db.select().from(materials),
      ]);
    const batchIds = batchRows.map((b) => b.id);
    const [allOps, usageRows, expenseRows, paymentRows, purchaseRows, packRows, delRows] =
      await Promise.all([
        db.select().from(productionOperations),
        db.select().from(materialUsage).where(eq(materialUsage.orderId, orderId)),
        db.select().from(expenses).where(eq(expenses.orderId, orderId)),
        db.select().from(payments).where(eq(payments.orderId, orderId)),
        db.select().from(materialPurchases).where(eq(materialPurchases.orderId, orderId)),
        db.select().from(packingRecords).where(eq(packingRecords.orderId, orderId)),
        db.select().from(deliveries).where(eq(deliveries.orderId, orderId)),
      ]);
    const ops = allOps.filter((o) => batchIds.includes(o.productionBatchId));
    const opIds = ops.map((o) => o.id);
    const [qcRows, rwRows] = await Promise.all([
      db.select().from(qualityChecks),
      db.select().from(reworkRecords),
    ]);
    const quality = qcRows.filter((q) => opIds.includes(q.productionOperationId));
    const rework = rwRows.filter((r) => opIds.includes(r.productionOperationId));

    const pMap = new Map(productRows.map((p) => [p.id, p]));
    const wMap = new Map(workerRows.map((w) => [w.id, w]));
    const mMap = new Map(materialRows.map((m) => [m.id, m]));
    const itemMap = new Map(itemRows.map((i) => [i.id, i]));

    const batches = batchRows.map((b) => {
      const bOps = ops
        .filter((o) => o.productionBatchId === b.id)
        .map((o) => ({ ...o, workerName: wMap.get(o.workerId ?? -1)?.name ?? null }));
      return {
        ...b,
        itemName: b.orderItemId
          ? pMap.get(itemMap.get(b.orderItemId)?.productId ?? -1)?.name ?? null
          : null,
        operations: bOps,
        progress: Math.round(batchProgress(bOps, b.quantity ?? 0)),
      };
    });

    const usage = usageRows.map((u) => ({
      ...u,
      materialName: mMap.get(u.materialId)?.name ?? "-",
      unit: mMap.get(u.materialId)?.unit ?? "",
    }));
    const purchases = purchaseRows.map((p) => ({
      ...p,
      materialName: mMap.get(p.materialId)?.name ?? "-",
      unit: mMap.get(p.materialId)?.unit ?? "",
    }));

    // ---- cost breakdown ----
    const usageByCat = new Map<string, number>();
    for (const u of usageRows) {
      const cat = mMap.get(u.materialId)?.category ?? "Materials";
      usageByCat.set(cat, (usageByCat.get(cat) ?? 0) + (u.totalCost ?? 0));
    }
    const expByCat = new Map<string, number>();
    for (const e of expenseRows)
      expByCat.set(e.category, (expByCat.get(e.category) ?? 0) + (e.amount ?? 0));
    const materialCost = usageRows.reduce((s, u) => s + (u.totalCost ?? 0), 0);
    const expenseCost = expenseRows.reduce((s, e) => s + (e.amount ?? 0), 0);
    const totalCost = materialCost + expenseCost;
    const revenue = order.totalAmount ?? 0;
    const profit = revenue - totalCost;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

      const progressBatches = batches.filter(
        (b: any) =>
          !(
            b.status === "CANCELLED" &&
            b.operations.every((o: any) => (o.quantityApproved ?? 0) === 0)
          )
      );
      const overallProgress = progressBatches.length
        ? Math.round(
            progressBatches.reduce((s: number, b: any) => s + b.progress, 0) /
              progressBatches.length
          )
        : 0;

    return NextResponse.json({
      order: {
        ...order,
        customer: customerRows.find((c) => c.id === order.customerId) ?? null,
      },
      items: itemRows.map((i) => ({
        ...i,
        productName: pMap.get(i.productId ?? -1)?.name ?? "-",
      })),
      batches,
      usage,
      purchases,
      expenses: expenseRows,
      payments: paymentRows,
      packing: packRows,
      deliveries: delRows,
      quality: quality.map((q) => ({
        ...q,
        stage: ops.find((o) => o.id === q.productionOperationId)?.stage ?? "-",
      })),
      rework: rework.map((r) => ({
        ...r,
        stage: ops.find((o) => o.id === r.productionOperationId)?.stage ?? "-",
      })),
      costs: {
        materialCost,
        expenseCost,
        usageByCategory: [...usageByCat.entries()].map(([category, amount]) => ({ category, amount })),
        expensesByCategory: [...expByCat.entries()].map(([category, amount]) => ({ category, amount })),
        totalCost,
        revenue,
        profit,
        margin: Math.round(margin * 10) / 10,
        purchaseTotal: purchaseRows.reduce((s, p) => s + (p.totalCost ?? 0), 0),
      },
      progress: overallProgress,
      totalQuantity: itemRows.reduce((s, i) => s + (i.quantity ?? 0), 0),
      packedQuantity: packRows.reduce((s, p) => s + (p.quantityPacked ?? 0), 0),
      deliveredQuantity: delRows.reduce((s, d) => s + (d.deliveredQuantity ?? 0), 0),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const { id } = await params;
    const orderId = Number(id);
    const b = await req.json();
    // Update items in place - items linked to production batches keep their id.
    //
    // The whole edit runs in ONE transaction. It used to be a sequence of
    // independent writes, so a failure part-way through left an order with its
    // items changed, its total recalculated, and an error returned to the client -
    // a committed change nobody knew had happened. Now it either all applies or
    // none of it does.
    if (b.items) {
      await db.transaction(async (tx) => {
        const existingItems = await tx
          .select()
          .from(orderItems)
          .where(eq(orderItems.orderId, orderId));
        const linkedItemIds = new Set(
          (
            await tx
              .select()
              .from(productionBatches)
              .where(eq(productionBatches.orderId, orderId))
          )
            .filter((bb) => bb.orderItemId)
            .map((bb) => bb.orderItemId)
        );
        const usedExisting = new Set<number>();

        // How much of each line is already committed to production. Cutting an
        // order line below this used to be accepted silently, which left a batch
        // in production for more garments than the order now says were ordered -
        // i.e. over-allocation created after the fact, with no audit row. This is
        // the same ceiling POST /api/batches enforces when a batch is created.
        const allocatedByItem = new Map<number, number>();
        for (const batch of await tx
          .select()
          .from(productionBatches)
          .where(eq(productionBatches.orderId, orderId))) {
          if (!batch.orderItemId || batch.status === "CANCELLED") continue;
          allocatedByItem.set(batch.orderItemId, (allocatedByItem.get(batch.orderItemId) ?? 0) + batch.quantity);
        }

        for (const it of b.items) {
          const qty = Number(it.quantity) || 0;
          const price = Number(it.unitPrice) || 0;
          const match = existingItems.find(
            (e) => !usedExisting.has(e.id) && e.productId === Number(it.productId)
          );
          if (match) {
            const allocated = allocatedByItem.get(match.id) ?? 0;
            if (qty < allocated)
              throw new Error(
                `ALLOCATED:${match.quantity}:${allocated}:${qty}`
              );
            usedExisting.add(match.id);
            await tx
              .update(orderItems)
              .set({ quantity: qty, unitPrice: price, totalPrice: qty * price, notes: it.notes || null })
              .where(eq(orderItems.id, match.id));
          } else {
            await tx.insert(orderItems).values({
              orderId,
              productId: Number(it.productId),
              quantity: qty,
              unitPrice: price,
              totalPrice: qty * price,
              notes: it.notes || null,
            });
          }
        }

        // Only remove old items that have NO production batch attached
        for (const e of existingItems) {
          if (!usedExisting.has(e.id) && !linkedItemIds.has(e.id)) {
            await tx.delete(orderItems).where(eq(orderItems.id, e.id));
          }
        }

        const items = await tx
          .select()
          .from(orderItems)
          .where(eq(orderItems.orderId, orderId));
        const total = items.reduce((s, i) => s + (i.totalPrice ?? 0), 0);
        await tx.update(orders).set({ totalAmount: total }).where(eq(orders.id, orderId));
      });
    }
    // Only the fields actually present. Passing an object whose every value is
    // `undefined` makes Drizzle throw "No values to set" - which is how a request
    // carrying only `items` used to return HTTP 500 *after* the item edits and the
    // recalculated order total had already been committed. The client saw a
    // failure and the database had changed.
    const changes: Partial<typeof orders.$inferInsert> = {};
    if (b.customerId) changes.customerId = Number(b.customerId);
    if (b.orderDate) changes.orderDate = b.orderDate;
    if (b.dueDate !== undefined) changes.dueDate = b.dueDate === "" ? null : b.dueDate || null;
    if (b.status) changes.status = b.status;
    if (b.notes !== undefined) changes.notes = b.notes;
    const [row] = Object.keys(changes).length
      ? await db.update(orders).set(changes).where(eq(orders.id, orderId)).returning()
      : await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    await refreshOrderMoney(orderId);
    return NextResponse.json(row);
  } catch (e: any) {
    // Raised inside the transaction, so nothing was written: the order keeps its
    // old quantity and the client is told exactly why.
    const allocated = typeof e?.message === "string" && e.message.startsWith("ALLOCATED:") ? e.message.split(":") : null;
    if (allocated)
      return NextResponse.json({
        error: `${allocated[2]} of these garments are already in production batches, so this line cannot be reduced below that. `
          + `Cancel or reduce the batches first. (Ordered ${allocated[1]}, requested ${allocated[3]}.)`,
      }, { status: 400 });
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const { id } = await params;
    await db.delete(orders).where(eq(orders.id, Number(id)));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}
