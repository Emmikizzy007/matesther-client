import { db } from "@/db";
import {
  orders,
  orderItems,
  payments,
  productionBatches,
  productionOperations,
} from "@/db/schema";
import { eq } from "drizzle-orm";

/** Recompute amount_paid + balance from payments table */
export async function refreshOrderMoney(orderId: number) {
  const payRows = await db
    .select()
    .from(payments)
    .where(eq(payments.orderId, orderId));
  const paid = payRows.reduce((s, p) => s + (p.amount ?? 0), 0);
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!order) return;
  await db
    .update(orders)
    .set({ amountPaid: paid, balance: (order.totalAmount ?? 0) - paid })
    .where(eq(orders.id, orderId));
}

/** Recompute order total from its items, then refresh money */
export async function refreshOrderTotals(orderId: number) {
  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  const total = items.reduce((s, i) => s + (i.totalPrice ?? 0), 0);
  await db
    .update(orders)
    .set({ totalAmount: total })
    .where(eq(orders.id, orderId));
  await refreshOrderMoney(orderId);
}

/** Roll up operation statuses -> batch -> order */
export async function refreshBatchAndOrder(batchId: number) {
  const ops = await db
    .select()
    .from(productionOperations)
    .where(eq(productionOperations.productionBatchId, batchId));
  const [batch] = await db
    .select()
    .from(productionBatches)
    .where(eq(productionBatches.id, batchId));
  if (!batch) return;

  let batchStatus = "PENDING";
  if (ops.length > 0) {
    if (ops.every((o) => o.status === "COMPLETED" || o.status === "CANCELLED"))
      batchStatus = "COMPLETED";
    else if (ops.some((o) => o.status === "IN_PROGRESS")) batchStatus = "IN_PROGRESS";
    else if (ops.some((o) => o.status === "ON_HOLD")) batchStatus = "ON_HOLD";
    else if (ops.some((o) => o.status === "COMPLETED")) batchStatus = "IN_PROGRESS";
  }
  await db
    .update(productionBatches)
    .set({ status: batchStatus })
    .where(eq(productionBatches.id, batchId));

  const batches = await db
    .select()
    .from(productionBatches)
    .where(eq(productionBatches.orderId, batch.orderId));
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, batch.orderId));
  if (!order) return;
  if (["CANCELLED"].includes(order.status)) return;
  let orderStatus = order.status;
  if (batches.length > 0) {
    if (batches.every((b) => b.status === "COMPLETED")) orderStatus = "COMPLETED";
    else if (
      batches.some((b) => b.status === "IN_PROGRESS" || b.status === "COMPLETED")
    ) {
      if (order.status === "PENDING") orderStatus = "IN_PROGRESS";
    }
  }
  if (orderStatus !== order.status) {
    await db
      .update(orders)
      .set({ status: orderStatus })
      .where(eq(orders.id, order.id));
  }
}

export function batchProgress(
  ops: { quantityCompleted: number | null }[],
  batchQty: number
): number {
  if (!batchQty || batchQty <= 0 || ops.length === 0) return 0;
  const done = ops.reduce((s, o) => s + (o.quantityCompleted ?? 0), 0);
  return Math.min(100, (done / (batchQty * ops.length)) * 100);
}
