import { NextResponse } from "next/server";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { customers, orderItems, orderItemSizes, orders, productionBatches, productionRoutes, products } from "@/db/schema";
import { variantLabel } from "@/lib/format";
import { isAutomaticRoute } from "@/lib/production-route";
import { guard, getSessionUser, STAFF } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** A production-only order catalogue. Do not return selling prices, balances or profits. */
/**
 * GET /api/production-orders[?id=7]
 *
 * THE CATALOGUE THE ASSIGN SCREEN IS BUILT FROM: every order that can still be put
 * into production, with its exact variants, what is already allocated on each, and
 * the route a new batch would follow.
 *
 * WHY `?id=` EXISTS
 *   "Start Production" on a school's order page opens the assign screen with that
 *   order already chosen. That screen needs this catalogue, but it needs ONE order,
 *   not every open order in the business - so the same derivation is available
 *   bounded to a single id, and the id is re-validated here against the caller's
 *   organisation rather than trusted from the query string.
 *
 * HOW IT STAYS BOUNDED
 *   It used to read seven whole tables - every order, customer, order item,
 *   product, variant, batch and route in the database - and then filter to the
 *   caller's organisation in JavaScript. Every one of those is now scoped in SQL:
 *   the organisation's own open orders first, then the child rows for exactly
 *   those orders by id. The work is the same shape (one pass, no per-order query),
 *   but the rows read are the rows returned rather than the whole company history.
 */
export async function GET(req: Request) {
  const denied = await guard(req, STAFF);
  if (denied) return denied;
  const user = await getSessionUser(req);
  try {
    const query = new URL(req.url).searchParams;
    const rawId = query.get("id");
    if (rawId !== null && !/^\d+$/.test(rawId.trim()))
      return NextResponse.json({ error: "Choose a valid order." }, { status: 400 });
    const wantedId = rawId === null ? null : Number(rawId.trim());

    // ---- 1. the orders in scope, filtered in SQL ----
    // Both the organisation and the open-status test are in the WHERE clause, so a
    // company with ten thousand completed orders does not read them to list twelve
    // open ones. `?id=` names its own order and is not status-filtered, because
    // "Start Production" on a specific order must be able to say why it cannot.
    const inScope = await db
      .select({
        id: orders.id, organizationId: orders.organizationId, customerId: orders.customerId,
        orderNumber: orders.orderNumber, status: orders.status, dueDate: orders.dueDate,
      })
      .from(orders)
      .where(and(
        // Organisation isolation, in the query rather than in a filter afterwards.
        user?.organizationId === null || user?.organizationId === undefined
          ? undefined
          : eq(orders.organizationId, user.organizationId),
        wantedId !== null ? eq(orders.id, wantedId) : undefined,
        // Two `<>` predicates rather than one `NOT IN (...)` list: identical in
        // meaning, index-usable on real PostgreSQL, and it also runs on pg-mem,
        // whose b-tree index cannot enumerate a NOT IN over an indexed column.
        // Same class of engine gap the suite already documents for date_trunc,
        // HAVING and NULLS NOT DISTINCT - the SQL is chosen to work in both.
        wantedId !== null ? undefined : ne(orders.status, "CANCELLED"),
        wantedId !== null ? undefined : ne(orders.status, "COMPLETED"),
      ));
    const ownOrders = inScope;
    if (!ownOrders.length)
      return NextResponse.json([], { headers: { "Cache-Control": "private, no-store" } });

    const orderIds = ownOrders.map((order) => order.id);

    // ---- 2. only the child rows belonging to those orders ----
    const [itemRows, customerRows, routeRows] = await Promise.all([
      db.select({ id: orderItems.id, orderId: orderItems.orderId, productId: orderItems.productId, quantity: orderItems.quantity })
        .from(orderItems).where(inArray(orderItems.orderId, orderIds)),
      // Only the schools these orders actually name.
      ownOrders.some((order) => order.customerId !== null)
        ? db.select({ id: customers.id, name: customers.name }).from(customers)
            .where(inArray(customers.id, [...new Set(ownOrders.map((order) => order.customerId).filter((v): v is number => v !== null))]))
        : Promise.resolve([] as { id: number; name: string }[]),
      db.select({ id: productionRoutes.id, productId: productionRoutes.productId, name: productionRoutes.name, isDefault: productionRoutes.isDefault, isActive: productionRoutes.isActive })
        .from(productionRoutes)
        .where(user?.organizationId === null || user?.organizationId === undefined
          ? undefined
          : eq(productionRoutes.organizationId, user.organizationId)),
    ]);
    const itemIds = itemRows.map((item) => item.id);
    const productIds = [...new Set(itemRows.map((item) => item.productId).filter((v): v is number => !!v))];
    const [sizeRows, batches, productsRows] = await Promise.all([
      itemIds.length
        ? db.select({ id: orderItemSizes.id, orderItemId: orderItemSizes.orderItemId, size: orderItemSizes.size,
            color: orderItemSizes.color, quantity: orderItemSizes.quantity }).from(orderItemSizes)
            .where(inArray(orderItemSizes.orderItemId, itemIds))
        : Promise.resolve([] as { id: number; orderItemId: number; size: string | null; color: string | null; quantity: number }[]),
      db.select({ id: productionBatches.id, orderId: productionBatches.orderId, orderItemId: productionBatches.orderItemId,
        orderVariantId: productionBatches.orderVariantId, size: productionBatches.size, color: productionBatches.color,
        routeId: productionBatches.routeId, quantity: productionBatches.quantity, status: productionBatches.status })
        .from(productionBatches).where(inArray(productionBatches.orderId, orderIds)),
      productIds.length
        ? db.select({ id: products.id, name: products.name, category: products.category }).from(products)
            .where(inArray(products.id, productIds))
        : Promise.resolve([] as { id: number; name: string; category: string | null }[]),
    ]);

    const customersById = new Map(customerRows.map((customer) => [customer.id, customer.name]));
    const productsById = new Map(productsRows.map((product) => [product.id, product.name]));

    /**
     * The route a NEW batch of this garment would follow.
     *
     * This is `isAutomaticRoute` - the same rule `resolveRoute` applies - and not
     * "the first route whose product matches", which is what it was. That picked a
     * retired route, an unflagged route the resolver would never choose, or (with
     * no organisation filter here) another company's route, and the assign screen
     * then showed stages the batch would not get.
     */
    const automaticRouteId = (productId: number | null): number | null => {
      // A line whose product is unknown follows the organisation default, exactly as
      // `resolveRoute` would. Returning null here instead - as the first version of this
      // did - made the assign screen promise "Matesther standard eight-stage route" for a
      // garment that was in fact about to be built from the house default, which is the
      // same class of disagreement the resolver fix exists to remove.
      const candidates = productId === null || productId === undefined
        ? routeRows.filter((route) => route.productId === null)
        : routeRows.filter((route) => route.productId === productId);
      const chosen = candidates.find((route) => isAutomaticRoute(route, routeRows));
      // No route of its own: fall back to the organisation-wide default, then to nothing,
      // which the screen renders as the built-in eight stages.
      if (chosen) return chosen.id;
      if (productId === null || productId === undefined) return null;
      const generic = routeRows
        .filter((route) => route.productId === null)
        .find((route) => isAutomaticRoute(route, routeRows));
      return generic?.id ?? null;
    };

    const result = ownOrders.map((order) => ({
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
        const defaultRouteId = automaticRouteId(item.productId ?? null);
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
          defaultRouteId,
          /** Named, so the screen can say WHICH route and why, rather than only showing stages. */
          defaultRouteName: defaultRouteId === null
            ? null
            : routeRows.find((route) => route.id === defaultRouteId)?.name ?? null,
          /** True when the garment has no route of its own and the fallback applies. */
          defaultRouteIsGeneric: defaultRouteId !== null &&
            (routeRows.find((route) => route.id === defaultRouteId)?.productId ?? null) === null,
        };
      }),
    }));
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Production order catalogue failed", error);
    return NextResponse.json({ error: "Could not load orders available for production." }, { status: 500 });
  }
}
