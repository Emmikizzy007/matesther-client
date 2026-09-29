import { NextResponse } from "next/server";
import { guard, OWNER } from "@/lib/authz";
import { db } from "@/db";
import { materials, materialPurchases, materialUsage } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function GET(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const [rows, purchases, usage] = await Promise.all([
      db.select().from(materials),
      db.select().from(materialPurchases),
      db.select().from(materialUsage),
    ]);
    const data = rows.map((m) => {
      const purchased = purchases
        .filter((p) => p.materialId === m.id)
        .reduce((s, p) => s + (p.quantity ?? 0), 0);
      const used = usage
        .filter((u) => u.materialId === m.id)
        .reduce((s, u) => s + (u.quantityUsed ?? 0), 0);
      const stockValue = (m.currentStock ?? 0) * (m.unitCost ?? 0);
      const low = (m.currentStock ?? 0) <= (m.reorderLevel ?? 0);
      return { ...m, purchased, used, stockValue, low };
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
    if (!b.name) return NextResponse.json({ error: "Material name is required" }, { status: 400 });
    const [row] = await db
      .insert(materials)
      .values({
        organizationId: 1,
        name: b.name,
        category: b.category || "General",
        unit: b.unit || "pcs",
        currentStock: Number(b.currentStock) || 0,
        reorderLevel: Number(b.reorderLevel) || 0,
        unitCost: Number(b.unitCost) || 0,
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
      .update(materials)
      .set({
        name: b.name,
        category: b.category,
        unit: b.unit,
        currentStock: b.currentStock !== undefined ? Number(b.currentStock) : undefined,
        reorderLevel: b.reorderLevel !== undefined ? Number(b.reorderLevel) : undefined,
        unitCost: b.unitCost !== undefined ? Number(b.unitCost) : undefined,
      })
      .where(eq(materials.id, Number(b.id)))
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
    const id = searchParams.get("id");
    await db.delete(materials).where(eq(materials.id, Number(id)));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json(
      { error: "Cannot delete - this material has purchase or usage records." },
      { status: 400 }
    );
  }
}
