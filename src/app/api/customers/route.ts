import { NextResponse } from "next/server";
import { guard, OWNER } from "@/lib/authz";
import { db } from "@/db";
import { customers, orders } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export async function GET(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const rows = await db.select().from(customers).orderBy(desc(customers.createdAt));
    const orderRows = await db.select().from(orders);
    const data = rows.map((c) => {
      const co = orderRows.filter((o) => o.customerId === c.id);
      return {
        ...c,
        orderCount: co.length,
        totalOrdered: co.reduce((s, o) => s + (o.totalAmount ?? 0), 0),
        outstanding: co.reduce((s, o) => s + Math.max(0, o.balance ?? 0), 0),
      };
    });
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const b = await req.json();
    if (!b.name) return NextResponse.json({ error: "Customer name is required" }, { status: 400 });
    const [row] = await db
      .insert(customers)
      .values({
        organizationId: 1,
        name: b.name,
        type: b.type || "SCHOOL",
        contactPerson: b.contactPerson || null,
        phone: b.phone || null,
        email: b.email || null,
        address: b.address || null,
      })
      .returning();
    return NextResponse.json(row, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}
