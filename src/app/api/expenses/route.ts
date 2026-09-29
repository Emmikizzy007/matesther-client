import { NextResponse } from "next/server";
import { guard, OWNER } from "@/lib/authz";
import { db } from "@/db";
import { expenses, orders, customers } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export async function GET(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const { searchParams } = new URL(req.url);
    const orderId = searchParams.get("orderId");
    const category = searchParams.get("category");
    const rows = await db.select().from(expenses).orderBy(desc(expenses.expenseDate));
    const [orderRows, customerRows] = await Promise.all([
      db.select().from(orders),
      db.select().from(customers),
    ]);
    const oMap = new Map(orderRows.map((o) => [o.id, o]));
    const cMap = new Map(customerRows.map((c) => [c.id, c]));
    let data = rows.map((e) => {
      const o = e.orderId ? oMap.get(e.orderId) : undefined;
      return {
        ...e,
        orderNumber: o?.orderNumber ?? null,
        customer: o ? cMap.get(o.customerId ?? -1)?.name ?? null : null,
      };
    });
    if (orderId) data = data.filter((d) => d.orderId === Number(orderId));
    if (category) data = data.filter((d) => d.category === category);
    return NextResponse.json(data);
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
