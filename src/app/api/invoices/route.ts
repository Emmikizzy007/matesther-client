import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { payments, orders, customers, organizations, orderItems, products } from "@/db/schema";
import { guard, OWNER } from "@/lib/authz";

export const dynamic = "force-dynamic";

/**
 * Owner-only data for the printable order invoice. No internal costs are
 * shared. Amounts follow the EXISTING order rules exactly: line totals come
 * from order_items.total_price, the grand total is orders.total_amount (the
 * authoritative figure), and the outstanding balance is total_amount minus
 * every payment recorded against the order - the same arithmetic the payment
 * receipt and the payments screen already use. Nothing is recalculated here.
 */
export async function GET(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const orderId = Number(new URL(req.url).searchParams.get("orderId"));
    if (!Number.isSafeInteger(orderId) || orderId <= 0)
      return NextResponse.json({ error: "A valid order ID is required." }, { status: 400 });
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) return NextResponse.json({ error: "Order not found." }, { status: 404 });

    const [customerRows, orgRows, itemRows, paymentRows, productRows] = await Promise.all([
      order.customerId ? db.select().from(customers).where(eq(customers.id, order.customerId)).limit(1) : Promise.resolve([]),
      db.select({ name: organizations.name, phone: organizations.phone, email: organizations.email, address: organizations.address }).from(organizations).where(eq(organizations.id, 1)).limit(1),
      db.select().from(orderItems).where(eq(orderItems.orderId, order.id)).orderBy(asc(orderItems.id)),
      db.select().from(payments).where(eq(payments.orderId, order.id)).orderBy(asc(payments.paymentDate), asc(payments.id)),
      db.select().from(products),
    ]);
    const productNames = new Map(productRows.map((row) => [row.id, row.name]));
    const itemsTotal = itemRows.reduce((sum, item) => sum + item.totalPrice, 0);
    const paidTotal = paymentRows.reduce((sum, payment) => sum + payment.amount, 0);

    return NextResponse.json({
      invoiceNo: `MTH-INV-${order.orderNumber}`,
      order: {
        orderNumber: order.orderNumber,
        orderDate: order.orderDate,
        totalAmount: order.totalAmount,
        itemsTotal,
        // Non-zero only when the recorded order total differs from the sum of
        // its line totals (a discount/adjustment captured on the order). The
        // order total stays authoritative; the difference is shown, not hidden.
        adjustment: order.totalAmount - itemsTotal,
        paidTotal,
        outstanding: order.totalAmount - paidTotal,
      },
      items: itemRows.map((item) => ({
        description: item.productId ? productNames.get(item.productId) ?? "Uniform item" : "Uniform item",
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        total: item.totalPrice,
      })),
      payments: paymentRows.map((payment) => ({
        id: payment.id,
        amount: payment.amount,
        date: payment.paymentDate,
        method: payment.paymentMethod,
        reference: payment.reference,
      })),
      customer: customerRows[0] ? {
        name: customerRows[0].name, contactPerson: customerRows[0].contactPerson,
        phone: customerRows[0].phone, email: customerRows[0].email, address: customerRows[0].address,
      } : null,
      business: orgRows[0] ?? null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Invoice load failed", error);
    return NextResponse.json({ error: "Unable to load this invoice. Please try again." }, { status: 500 });
  }
}
