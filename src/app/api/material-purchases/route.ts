import { NextResponse } from "next/server";
import { guard, OWNER } from "@/lib/authz";
import { db } from "@/db";
import { materialPurchases, materials, orders } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export async function GET(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const { searchParams } = new URL(req.url);
    const orderId = searchParams.get("orderId");
    const rows = await db.select().from(materialPurchases).orderBy(desc(materialPurchases.purchaseDate));
    const [matRows, orderRows] = await Promise.all([
      db.select().from(materials),
      db.select().from(orders),
    ]);
    const mMap = new Map(matRows.map((m) => [m.id, m]));
    const oMap = new Map(orderRows.map((o) => [o.id, o]));
    let data = rows.map((p) => ({
      ...p,
      materialName: mMap.get(p.materialId)?.name ?? "-",
      unit: mMap.get(p.materialId)?.unit ?? "",
      orderNumber: p.orderId ? oMap.get(p.orderId)?.orderNumber ?? "-" : null,
    }));
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
    if (!b.materialId) return NextResponse.json({ error: "Material is required" }, { status: 400 });
    if (!b.quantity || Number(b.quantity) <= 0)
      return NextResponse.json({ error: "Quantity must be greater than zero" }, { status: 400 });
    const qty = Number(b.quantity);
    const unitCost = Number(b.unitCost) || 0;
    const [row] = await db
      .insert(materialPurchases)
      .values({
        organizationId: 1,
        materialId: Number(b.materialId),
        supplier: b.supplier || null,
        quantity: qty,
        unitCost,
        totalCost: qty * unitCost,
        purchaseDate: b.purchaseDate || new Date().toISOString().slice(0, 10),
        orderId: b.orderId ? Number(b.orderId) : null,
        notes: b.notes || null,
      })
      .returning();
    // stock in
    const [mat] = await db.select().from(materials).where(eq(materials.id, Number(b.materialId)));
    if (mat) {
      await db
        .update(materials)
        .set({ currentStock: (mat.currentStock ?? 0) + qty, unitCost: unitCost || mat.unitCost })
        .where(eq(materials.id, mat.id));
    }
    return NextResponse.json(row, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}
