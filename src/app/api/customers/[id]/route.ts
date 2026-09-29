import { NextResponse } from "next/server";
import { guard, OWNER } from "@/lib/authz";
import { db } from "@/db";
import { customers, orders } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const { id } = await params;
    const b = await req.json();
    const [row] = await db
      .update(customers)
      .set({
        name: b.name,
        type: b.type,
        contactPerson: b.contactPerson,
        phone: b.phone,
        email: b.email,
        address: b.address,
      })
      .where(eq(customers.id, Number(id)))
      .returning();
    return NextResponse.json(row);
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const { id } = await params;
    const linked = await db.select().from(orders).where(eq(orders.customerId, Number(id)));
    if (linked.length > 0)
      return NextResponse.json(
        { error: `Cannot delete - ${linked.length} order(s) belong to this customer.` },
        { status: 400 }
      );
    await db.delete(customers).where(eq(customers.id, Number(id)));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}
