import { NextResponse } from "next/server";
import { guard, OWNER } from "@/lib/authz";
import { db } from "@/db";
import { materialUsage, materials, orders } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

export async function GET(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const { searchParams } = new URL(req.url);
    const orderId = searchParams.get("orderId");
    const rows = await db.select().from(materialUsage).orderBy(desc(materialUsage.usedAt));
    const [matRows, orderRows] = await Promise.all([
      db.select().from(materials),
      db.select().from(orders),
    ]);
    const mMap = new Map(matRows.map((m) => [m.id, m]));
    const oMap = new Map(orderRows.map((o) => [o.id, o]));
    let data = rows.map((u) => ({
      ...u,
      materialName: mMap.get(u.materialId)?.name ?? "-",
      unit: mMap.get(u.materialId)?.unit ?? "",
      orderNumber: u.orderId ? oMap.get(u.orderId)?.orderNumber ?? "-" : "-",
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
    if (!b.orderId) return NextResponse.json({ error: "Link usage to an order" }, { status: 400 });
    if (!b.quantityUsed || Number(b.quantityUsed) <= 0)
      return NextResponse.json({ error: "Quantity used must be greater than zero" }, { status: 400 });
    const [mat] = await db.select().from(materials).where(eq(materials.id, Number(b.materialId)));
    if (!mat) return NextResponse.json({ error: "Material not found" }, { status: 404 });
    const qty = Number(b.quantityUsed);
    const unitCost = b.unitCost !== undefined && b.unitCost !== "" ? Number(b.unitCost) : mat.unitCost ?? 0;
    const [row] = await db
      .insert(materialUsage)
      .values({
        orderId: Number(b.orderId),
        productionOperationId: b.productionOperationId ? Number(b.productionOperationId) : null,
        materialId: Number(b.materialId),
        quantityUsed: qty,
        unitCost,
        totalCost: qty * unitCost,
      })
      .returning();
    await db
      .update(materials)
      .set({ currentStock: (mat.currentStock ?? 0) - qty })
      .where(eq(materials.id, mat.id));
    return NextResponse.json(row, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}
