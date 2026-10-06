import { NextResponse } from "next/server";
import { db } from "@/db";
import { customers, orderItems, orderItemSizes, orders, productionBatches, productionRoutes, products } from "@/db/schema";
import { variantLabel } from "@/lib/format";
import { guard, getSessionUser, STAFF } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** A production-only order catalogue. Do not return selling prices, balances or profits. */
export async function GET(req: Request) {
  const denied = await guard(req, STAFF);
  if (denied) return denied;
  const user = await getSessionUser(req);
  try {
    const [allOrders, customersRows, itemRows, productsRows, sizeRows, batches, routeRows] = await Promise.all([
      db.select({ id: orders.id, organizationId: orders.organizationId, customerId: orders.customerId,
        orderNumber: orders.orderNumber, status: orders.status, dueDate: orders.dueDate }).from(orders),
      db.select({ id: customers.id, name: customers.name }).from(customers),
      db.select({ id: orderItems.id, orderId: orderItems.orderId, productId: orderItems.productId, quantity: orderItems.quantity }).from(orderItems),
      db.select({ id: products.id, name: products.name, category: products.category }).from(products),
      // The order's exact variants: item + size + colour + quantity. `id` is now
      // carried through so a batch can be allocated against a specific variant
      // rather than against free text that happens to match.
      db.select({ id: orderItemSizes.id, orderItemId: orderItemSizes.orderItemId, size: orderItemSizes.size,
        color: orderItemSizes.color, quantity: orderItemSizes.quantity }).from(orderItemSizes),
      db.select({ id: productionBatches.id, orderId: productionBatches.orderId, orderItemId: productionBatches.orderItemId,
        orderVariantId: productionBatches.orderVariantId, size: productionBatches.size, color: productionBatches.color,
        routeId: productionBatches.routeId, quantity: productionBatches.quantity, status: productionBatches.status }).from(productionBatches),
      db.select({ id: productionRoutes.id, productId: productionRoutes.productId, name: productionRoutes.name }).from(productionRoutes),
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
        items: itemRows.filter((item) => item.orderId === order.id).map((item) => {
          const itemBatches = batches.filter((batch) => batch.orderItemId === item.id && batch.status !== "CANCELLED");
          const variants = sizeRows.filter((row) => row.orderItemId === item.id).map((row) => {
            // Allocated is matched by variant id first, and falls back to the
            // size/colour text for batches created before variants were linked, so
            // historical allocations still count against the right ceiling.
            const forVariant = itemBatches.filter((batch) =>
              batch.orderVariantId === row.id ||
              (batch.orderVariantId === null &&
                String(batch.size ?? "").trim().toUpperCase() === String(row.size ?? "").trim().toUpperCase() &&
                String(batch.color ?? "").trim().toLowerCase() === String(row.color ?? "").trim().toLowerCase()));
            const allocated = forVariant.reduce((sum, batch) => sum + batch.quantity, 0);
            return {
              id: row.id,
              size: row.size,
              color: row.color,
              quantity: row.quantity,
              allocated,
              available: Math.max(0, row.quantity - allocated),
              label: variantLabel(row.size, row.color),
            };
          });
          return {
            id: item.id,
            name: productsById.get(item.productId ?? -1) ?? "School uniform",
            productId: item.productId ?? null,
            quantity: item.quantity,
            // Kept for the existing screens: the distinct sizes on this item.
            sizes: [...new Map(variants.map((variant) => [String(variant.size ?? ""), { size: variant.size, quantity: variant.quantity }])).values()],
            variants,
            assigned: itemBatches.map((batch) => ({
              batchId: batch.id, size: batch.size, color: batch.color,
              quantity: batch.quantity, orderVariantId: batch.orderVariantId,
              route: routeRows.find((route) => route.id === batch.routeId)?.name ?? null,
            })),
            // The route a new batch for this garment would follow, so the assign
            // screen can show the stages before anything is created.
            defaultRouteId: routeRows.find((route) => route.productId === item.productId)?.id ?? null,
          };
        }),
      }));
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Production order catalogue failed", error);
    return NextResponse.json({ error: "Could not load orders available for production." }, { status: 500 });
  }
}
