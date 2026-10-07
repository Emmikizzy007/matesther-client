import { NextResponse } from "next/server";
import { guard, getSessionUser, OWNER } from "@/lib/authz";
import { db } from "@/db";
import {
  orders,
  customers,
  orderItems,
  productionBatches,
  productionOperations,
} from "@/db/schema";
import { and, desc, eq, ilike, inArray, like, or, sql } from "drizzle-orm";
import { batchProgress } from "@/lib/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/orders?search=&status=&limit=&offset=
 *
 * THE ORDER LIST. Owner-only, because it carries revenue and balances.
 *
 * WHAT IT USED TO COST
 *   Five whole tables - every order, every customer, every order item, every
 *   production batch and EVERY PRODUCTION OPERATION IN THE DATABASE - were read on
 *   every visit to the Orders screen, then joined and filtered in JavaScript. The
 *   operation table alone grows by one row per stage per batch, so a year of
 *   production made the list screen read tens of thousands of rows to draw
 *   twenty-five of them, and the browser then filtered that again on every keystroke.
 *
 * WHAT IT COSTS NOW
 *   The organisation's own orders, filtered and paged in SQL, and then the child rows
 *   for ONLY the orders on that page. Statement count is constant at six whether the
 *   business has twenty orders or twenty thousand, and the payload is one page rather
 *   than the company's whole history. `X-Total-Count` reports the matching total so
 *   the screen can page without a second counting query.
 *
 *   Organisation isolation is in the WHERE clause. It used not to exist here at all:
 *   the handler selected every order in the database and never compared
 *   `organizationId`, so a second company on the same deployment would have appeared
 *   in the first one's order list.
 *
 * The response is still a bare array, because that is what every consumer reads. The
 * total travels in the header, exactly as the material-purchase and operation lists
 * already do it.
 */
export async function GET(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const session = await getSessionUser(req);
    const query = new URL(req.url).searchParams;

    const search = query.get("search")?.trim() ?? "";
    const status = query.get("status")?.trim().toUpperCase() ?? "";
    const rawLimit = query.get("limit") ? Number(query.get("limit")) : NaN;
    // A default page, not the whole table. A caller that genuinely wants more can ask,
    // up to a ceiling, so one screen can never make the database return everything.
    const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 50;
    const rawOffset = query.get("offset") ? Number(query.get("offset")) : 0;
    const offset = Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

    const ownOrganization = session?.organizationId === null || session?.organizationId === undefined
      ? undefined
      : eq(orders.organizationId, session.organizationId);

    /**
     * Search matches the order number, or the school's name.
     *
     * The school's name lives on `customers`, so the search joins it - the same shape
     * `productionControl` already uses for its own search, and deliberately not a
     * correlated `EXISTS`, which pg-mem cannot resolve against an outer column (the
     * documented gap that also rules out `NOT EXISTS` with an alias). A join is safe
     * here rather than merely convenient: `orders.customer_id` names at most one
     * customer, so it multiplies nothing and the total stays the number of ORDERS.
     *
     * The join is only added when there is a search to run, so an unfiltered list still
     * costs one relation.
     */
    const matchesSearch = search
      ? or(
          ilike(orders.orderNumber, `%${search}%`),
          ilike(customers.name, `%${search}%`)
        )
      : undefined;

    const where = and(
      ownOrganization,
      status ? eq(orders.status, status) : undefined,
      matchesSearch
    );
    // The total counts every match, not just the page, so the pager is honest.
    const countQuery = matchesSearch
      ? db.select({ total: sql<number>`count(*)` }).from(orders).leftJoin(customers, eq(customers.id, orders.customerId)).where(where)
      : db.select({ total: sql<number>`count(*)` }).from(orders).where(where);
    const [totalRow] = await countQuery;
    const total = Number(totalRow?.total ?? 0);

    const pageQuery = matchesSearch
      ? db.select({ order: orders }).from(orders).leftJoin(customers, eq(customers.id, orders.customerId)).where(where)
      : null;
    const page = total === 0
      ? []
      : pageQuery
        ? (await pageQuery
            .orderBy(desc(orders.createdAt), desc(orders.id))
            .limit(limit)
            .offset(offset)).map((row) => row.order)
        : await db.select().from(orders).where(where)
            .orderBy(desc(orders.createdAt), desc(orders.id))
            .limit(limit)
            .offset(offset);

    if (!page.length)
      return NextResponse.json([], {
        headers: { "Cache-Control": "private, no-store", "X-Total-Count": String(total) },
      });

    const pageIds = page.map((order) => order.id);
    const customerIds = [...new Set(page.map((order) => order.customerId).filter((v): v is number => v !== null))];

    // ---- child rows for THIS PAGE ONLY ----
    const [customerRows, itemRows] = await Promise.all([
      customerIds.length
        ? db.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, customerIds))
        : Promise.resolve([] as { id: number; name: string }[]),
      db.select({ id: orderItems.id, orderId: orderItems.orderId, quantity: orderItems.quantity })
        .from(orderItems).where(inArray(orderItems.orderId, pageIds)),
    ]);

    /**
     * Batches and their stages, scoped to the page's orders through a subquery.
     *
     * `inArray(productionBatches.orderId, pageIds)` would do for the batches, but the
     * operations belong to batches, and reaching them through the order id needs the
     * same subquery - otherwise this is where the old code read every operation in the
     * database. Both reads are bounded by the page, so the work is proportional to what
     * is drawn rather than to how much production has ever happened.
     */
    const [batchRows, opRows] = await Promise.all([
      db.select({
        id: productionBatches.id, orderId: productionBatches.orderId,
        quantity: productionBatches.quantity, status: productionBatches.status,
      })
        .from(productionBatches).where(inArray(productionBatches.orderId, pageIds)),
      db.select({
        id: productionOperations.id, productionBatchId: productionOperations.productionBatchId,
        quantityCompleted: productionOperations.quantityCompleted, quantityApproved: productionOperations.quantityApproved,
      })
        .from(productionOperations)
        .where(sql`${productionOperations.productionBatchId} in (select ${productionBatches.id} from ${productionBatches} where ${productionBatches.orderId} in (${sql.join(pageIds.map((id) => sql`${id}`), sql`, `)}))`),
    ]);

    const cMap = new Map(customerRows.map((c) => [c.id, c.name]));
    const opsByBatch = new Map<number, typeof opRows>();
    for (const op of opRows) {
      const list = opsByBatch.get(op.productionBatchId) ?? [];
      list.push(op);
      opsByBatch.set(op.productionBatchId, list);
    }
    const itemsByOrder = new Map<number, typeof itemRows>();
    for (const item of itemRows) {
      const list = itemsByOrder.get(item.orderId) ?? [];
      list.push(item);
      itemsByOrder.set(item.orderId, list);
    }
    const batchesByOrder = new Map<number, typeof batchRows>();
    for (const batch of batchRows) {
      const list = batchesByOrder.get(batch.orderId) ?? [];
      list.push(batch);
      batchesByOrder.set(batch.orderId, list);
    }

    const data = page.map((order) => {
      const items = itemsByOrder.get(order.id) ?? [];
      /**
       * The same batch rule as before, unchanged: a CANCELLED batch counts towards
       * progress only if it has approved work behind it, so abandoning an empty batch
       * cannot drag a completed order's progress down. What changed is that the batches
       * and operations being examined are this page's, not the database's.
       */
      const batches = (batchesByOrder.get(order.id) ?? []).filter((batch) => {
        if (batch.status !== "CANCELLED") return true;
        const approved = (opsByBatch.get(batch.id) ?? []).reduce((sum, op) => sum + (op.quantityApproved ?? 0), 0);
        return approved > 0;
      });
      const progresses = batches.map((batch) =>
        batchProgress(opsByBatch.get(batch.id) ?? [], batch.quantity ?? 0)
      );
      return {
        ...order,
        customer: cMap.get(order.customerId ?? -1) ?? "-",
        customerId: order.customerId,
        quantity: items.reduce((sum, item) => sum + (item.quantity ?? 0), 0),
        progress: progresses.length
          ? Math.round(progresses.reduce((a, b) => a + b, 0) / progresses.length)
          : 0,
        batchCount: batches.length,
      };
    });
    return NextResponse.json(data, {
      headers: { "Cache-Control": "private, no-store", "X-Total-Count": String(total) },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

/**
 * The sequence number for a new order, as `ORD-<year>-<nnn>`.
 *
 * It used to be `count(every order in the database) + 1`, read by selecting the whole
 * orders table. Two things were wrong with that beyond the cost:
 *
 *   - it is not concurrency-safe. Two Owners saving at the same moment read the same
 *     count and both write the same order number, and `order_number` is unique, so the
 *     second one fails with a constraint error rather than getting the next number;
 *   - it does not survive a deletion. Remove any order and the count drops, so the next
 *     order re-uses a number that is still in use - which is exactly what happens once
 *     test data is cleaned up before the business goes live.
 *
 * So the number is derived from the highest sequence ALREADY USED this year, by parsing
 * the numbers themselves rather than counting rows, and the insert retries forward on a
 * uniqueness collision. Reading the table for a count is gone; a bounded, ordered read
 * of this year's own numbers is what replaces it.
 */
async function nextOrderNumber(organizationId: number | null | undefined, year: number): Promise<string> {
  const prefix = `ORD-${year}-`;
  const rows = await db
    .select({ orderNumber: orders.orderNumber })
    .from(orders)
    .where(and(
      like(orders.orderNumber, `${prefix}%`),
      organizationId === null || organizationId === undefined
        ? undefined
        : eq(orders.organizationId, organizationId),
    ))
    .orderBy(desc(orders.orderNumber))
    .limit(500);
  let highest = 0;
  for (const row of rows) {
    const sequence = Number(String(row.orderNumber).slice(prefix.length));
    if (Number.isSafeInteger(sequence) && sequence > highest) highest = sequence;
  }
  return `${prefix}${String(highest + 1).padStart(3, "0")}`;
}

export async function POST(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
    const b = await req.json();
    if (!b.customerId)
      return NextResponse.json({ error: "Customer is required" }, { status: 400 });
    if (!b.items || b.items.length === 0)
      return NextResponse.json({ error: "Add at least one uniform product" }, { status: 400 });

    // The customer must be this organisation's own. A caller naming another company's
    // customer id used to be able to attach an order to it.
    const [customer] = await db
      .select({ id: customers.id, organizationId: customers.organizationId })
      .from(customers)
      .where(eq(customers.id, Number(b.customerId)))
      .limit(1);
    if (!customer || (customer.organizationId !== null && session.organizationId !== null && customer.organizationId !== session.organizationId))
      return NextResponse.json({ error: "Choose one of Matesther's own schools or customers." }, { status: 400 });

    const itemsTotal = b.items.reduce(
      (s: number, i: any) => s + Number(i.quantity || 0) * Number(i.unitPrice || 0),
      0
    );
    const year = new Date().getFullYear();

    /**
     * Insert the order and its items in ONE transaction.
     *
     * It used to insert the order, then loop over the items with a separate statement
     * each and no transaction, so a failure on the third item left an order in the
     * database with two of its five garments - and an order total that no longer matched
     * its own items. Either the whole order exists or none of it does.
     */
    const createWith = async (orderNumber: string) =>
      db.transaction(async (tx) => {
        const [order] = await tx
          .insert(orders)
          .values({
            // The caller's own organisation, from the session - never a literal, and
            // never something the request body can name.
            organizationId: session.organizationId,
            customerId: customer.id,
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
        await tx.insert(orderItems).values(
          b.items.map((it: any) => ({
            orderId: order.id,
            productId: Number(it.productId),
            quantity: Number(it.quantity) || 0,
            unitPrice: Number(it.unitPrice) || 0,
            totalPrice: (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0),
            notes: it.notes || null,
          }))
        );
        return order;
      });

    // A caller may name the order number; otherwise it is the next unused sequence.
    if (b.orderNumber) {
      const order = await createWith(String(b.orderNumber).trim().slice(0, 50));
      return NextResponse.json(order, { status: 201 });
    }
    let attempt = await nextOrderNumber(session.organizationId, year);
    // Bounded retry forward: two Owners saving at once, or a number freed by a cleanup,
    // must produce the NEXT number rather than an error the Owner has to work around.
    for (let tries = 0; tries < 5; tries += 1) {
      try {
        const order = await createWith(attempt);
        return NextResponse.json(order, { status: 201 });
      } catch (error: any) {
        const message = String(error?.message ?? error?.queryError?.message ?? "");
        if (!/unique|duplicate/i.test(message)) throw error;
        const sequence = Number(attempt.slice(`ORD-${year}-`.length));
        attempt = `ORD-${year}-${String((Number.isSafeInteger(sequence) ? sequence : 0) + 1).padStart(3, "0")}`;
      }
    }
    return NextResponse.json({ error: "Could not allocate an order number. Please try again." }, { status: 409 });
  } catch (e: any) {
    const msg = String(e.message || "");
    if (msg.includes("unique") || msg.includes("duplicate"))
      return NextResponse.json({ error: "That order number already exists." }, { status: 400 });
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || msg || "Unknown error" }, { status: 500 });
  }
}
