import { NextResponse } from "next/server";
import { guard, OWNER } from "@/lib/authz";
import { db } from "@/db";
import { packingRecords, orders, customers } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export async function GET(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const { searchParams } = new URL(req.url);
    const orderId = searchParams.get("orderId");
    const rows = await db.select().from(packingRecords).orderBy(desc(packingRecords.packedAt));
    const [orderRows, customerRows] = await Promise.all([
      db.select().from(orders),
      db.select().from(customers),
    ]);
    const oMap = new Map(orderRows.map((o) => [o.id, o]));
    const cMap = new Map(customerRows.map((c) => [c.id, c]));
    let data = rows.map((p) => {
      const o = oMap.get(p.orderId);
      return {
        ...p,
        orderNumber: o?.orderNumber ?? "-",
        customer: cMap.get(o?.customerId ?? -1)?.name ?? "-",
      };
    });
    if (orderId) data = data.filter((d) => d.orderId === Number(orderId));
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const b = await req.json();
    if (!b.orderId) return NextResponse.json({ error: "Order is required" }, { status: 400 });
    if (!b.quantityPacked || Number(b.quantityPacked) <= 0)
      return NextResponse.json({ error: "Quantity packed is required" }, { status: 400 });
    const [row] = await db
      .insert(packingRecords)
      .values({
        orderId: Number(b.orderId),
        quantityPacked: Number(b.quantityPacked),
        packageCount: Number(b.packageCount) || 0,
        notes: b.notes || null,
      })
      .returning();
    return NextResponse.json(row, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}
