import { NextResponse } from "next/server";
import { guard, OWNER } from "@/lib/authz";
import { db } from "@/db";
import { expenses, orders, customers } from "@/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

export async function GET(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const { searchParams } = new URL(req.url);
    const rawOrderId = searchParams.get("orderId");
    if (rawOrderId !== null && rawOrderId.trim() !== "" && !/^\d+$/.test(rawOrderId.trim()))
      return NextResponse.json({ error: "Choose a valid order." }, { status: 400 });
    const orderId = rawOrderId && /^\d+$/.test(rawOrderId.trim()) ? Number(rawOrderId.trim()) : null;
    const category = searchParams.get("category")?.trim() || null;
    const rawLimit = searchParams.get("limit") ? Number(searchParams.get("limit")) : NaN;
    const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;
    const rawOffset = searchParams.get("offset") ? Number(searchParams.get("offset")) : 0;
    const offset = Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

    /**
     * Both filters are WHERE CLAUSES.
     *
     * They used to be applied after the mapping, so the order page's "expenses on this
     * order" and the expenses screen's category filter each read every expense, every
     * order and every customer in the database first. An expense list grows forever, so
     * that cost only ever went up.
     */
    const where = and(
      orderId !== null ? eq(expenses.orderId, orderId) : undefined,
      category ? eq(expenses.category, category) : undefined
    );
    const [totalRow] = await db.select({ total: sql<number>`count(*)` }).from(expenses).where(where);
    const total = Number(totalRow?.total ?? 0);
    const rows = total === 0
      ? []
      : await db.select().from(expenses).where(where)
          .orderBy(desc(expenses.expenseDate), desc(expenses.id))
          .limit(limit).offset(offset);

    // Only the orders these expenses actually name. An expense with no order - a
    // general business cost - keeps `orderNumber: null`, exactly as before.
    const orderIds = [...new Set(rows.map((row) => row.orderId).filter((v): v is number => v !== null))];
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
    const data = rows.map((e) => {
      const o = e.orderId ? oMap.get(e.orderId) : undefined;
      return {
        ...e,
        orderNumber: o?.orderNumber ?? null,
        customer: o ? (o.customerId ? cMap.get(o.customerId)?.name ?? null : null) : null,
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
    const b = await req.json();
    if (!b.description) return NextResponse.json({ error: "Description is required" }, { status: 400 });
    if (!b.amount || Number(b.amount) <= 0)
      return NextResponse.json({ error: "Amount must be greater than zero" }, { status: 400 });
    const [row] = await db
      .insert(expenses)
      .values({
        organizationId: 1,
        orderId: b.orderId ? Number(b.orderId) : null,
        category: b.category || "Other",
        description: b.description,
        amount: Number(b.amount),
        expenseDate: b.expenseDate || new Date().toISOString().slice(0, 10),
        notes: b.notes || null,
      })
      .returning();
    return NextResponse.json(row, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const b = await req.json();
    const [row] = await db
      .update(expenses)
      .set({
        orderId: b.orderId ? Number(b.orderId) : null,
        category: b.category,
        description: b.description,
        amount: Number(b.amount),
        expenseDate: b.expenseDate,
        notes: b.notes,
      })
      .where(eq(expenses.id, Number(b.id)))
      .returning();
    return NextResponse.json(row);
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const { searchParams } = new URL(req.url);
    await db.delete(expenses).where(eq(expenses.id, Number(searchParams.get("id"))));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}
