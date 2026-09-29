import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { payments, orders, customers, organizations, orderItems, products } from "@/db/schema";
import { guard, OWNER } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** Owner-only data for a printable customer receipt. No internal costs are shared. */
export async function GET(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const paymentId = Number(new URL(req.url).searchParams.get("paymentId"));
    if (!Number.isSafeInteger(paymentId) || paymentId <= 0)
      return NextResponse.json({ error: "A valid payment ID is required." }, { status: 400 });
    const [payment] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
    if (!payment) return NextResponse.json({ error: "Payment not found." }, { status: 404 });
    const [order] = await db.select().from(orders).where(eq(orders.id, payment.orderId)).limit(1);
    if (!order) return NextResponse.json({ error: "The order for this payment could not be found." }, { status: 404 });

    const [customerRows, orgRows, itemRows, allPayments, productRows] = await Promise.all([
      order.customerId ? db.select().from(customers).where(eq(customers.id, order.customerId)).limit(1) : Promise.resolve([]),
      db.select({ name: organizations.name, phone: organizations.phone, email: organizations.email, address: organizations.address }).from(organizations).where(eq(organizations.id, 1)).limit(1),
      db.select().from(orderItems).where(eq(orderItems.orderId, order.id)),
      db.select().from(payments).where(eq(payments.orderId, order.id)).orderBy(asc(payments.paymentDate), asc(payments.id)),
      db.select().from(products),
    ]);
    const productNames = new Map(productRows.map((row) => [row.id, row.name]));
    const paidBefore = allPayments
      .filter((row) => row.paymentDate < payment.paymentDate || (row.paymentDate === payment.paymentDate && row.id < payment.id))
      .reduce((sum, row) => sum + row.amount, 0);
    const balanceBefore = order.totalAmount - paidBefore;

    return NextResponse.json({
      receiptNo: `MTH-REC-${String(payment.id).padStart(4, "0")}`,
      payment: {
        id: payment.id,
        amount: payment.amount,
        date: payment.paymentDate,
        method: payment.paymentMethod,
        reference: payment.reference,
        notes: payment.notes,
      },
      order: {
        orderNumber: order.orderNumber,
        orderDate: order.orderDate,
        totalAmount: order.totalAmount,
        balanceBefore,
        balanceAfter: balanceBefore - payment.amount,
        paidToDate: paidBefore + payment.amount,
      },
      items: itemRows.map((item) => ({
        description: item.productId ? productNames.get(item.productId) ?? "Uniform item" : "Uniform item",
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        total: item.totalPrice,
      })),
      customer: customerRows[0] ? {
        name: customerRows[0].name, contactPerson: customerRows[0].contactPerson,
        phone: customerRows[0].phone, email: customerRows[0].email, address: customerRows[0].address,
      } : null,
      business: orgRows[0] ?? null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Receipt load failed", error);
    return NextResponse.json({ error: "Unable to load this receipt. Please try again." }, { status: 500 });
  }
}
