import { NextResponse } from "next/server";
import { db } from "@/db";
import { customers, orderItems, orderItemSizes, orders, productionBatches, products } from "@/db/schema";
import { guard, getSessionUser, STAFF } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** A production-only order catalogue. Do not return selling prices, balances or profits. */
export async function GET(req: Request) {
  const denied = await guard(req, STAFF);
  if (denied) return denied;
  const user = await getSessionUser(req);
  try {
    const [allOrders, customersRows, itemRows, productsRows, sizeRows, batches] = await Promise.all([
      db.select({ id: orders.id, organizationId: orders.organizationId, customerId: orders.customerId,
        orderNumber: orders.orderNumber, status: orders.status, dueDate: orders.dueDate }).from(orders),
      db.select({ id: customers.id, name: customers.name }).from(customers),
      db.select({ id: orderItems.id, orderId: orderItems.orderId, productId: orderItems.productId, quantity: orderItems.quantity }).from(orderItems),
      db.select({ id: products.id, name: products.name }).from(products),
      db.select({ orderItemId: orderItemSizes.orderItemId, size: orderItemSizes.size, quantity: orderItemSizes.quantity }).from(orderItemSizes),
      db.select({ orderId: productionBatches.orderId, orderItemId: productionBatches.orderItemId, size: productionBatches.size,
        color: productionBatches.color, quantity: productionBatches.quantity, status: productionBatches.status }).from(productionBatches),
    ]);
    const customersById = new Map(customersRows.map((customer) => [customer.id, customer.name]));
    const productsById = new Map(productsRows.map((product) => [product.id, product.name]));
    const result = allOrders
      .filter((order) => order.organizationId === user?.organizationId && !["CANCELLED", "COMPLETED"].includes(order.status))
      .map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        customer: customersById.get(order.customerId ?? -1) ?? "School not recorded",
        dueDate: order.dueDate,
        status: order.status,
        items: itemRows.filter((item) => item.orderId === order.id).map((item) => ({
          id: item.id,
          name: productsById.get(item.productId ?? -1) ?? "School uniform",
          quantity: item.quantity,
          sizes: sizeRows.filter((row) => row.orderItemId === item.id).map((row) => ({ size: row.size, quantity: row.quantity })),
          assigned: batches.filter((batch) => batch.orderItemId === item.id && batch.status !== "CANCELLED")
            .map((batch) => ({ size: batch.size, color: batch.color, quantity: batch.quantity })),
        })),
      }));
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Production order catalogue failed", error);
    return NextResponse.json({ error: "Could not load orders available for production." }, { status: 500 });
  }
}
