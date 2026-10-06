import { NextResponse } from "next/server";
import { guard, OWNER } from "@/lib/authz";
import { db } from "@/db";
import { materialPurchases, materials, orders } from "@/db/schema";
import { isReadyMadeMaterial } from "@/lib/format";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

/**
 * GET /api/material-purchases?orderId=&materialId=&limit=&offset=
 *
 * Filtered and paged in SQL, in the same shape as GET /api/material-usage, and still a bare
 * array so nothing that reads it has to change. This used to read every purchase, every
 * material and every order in the database, filter the purchases in JavaScript afterwards, and
 * return the lot with no pagination - so the materials screen downloaded the whole book on
 * every visit, and purchases only ever accumulate. The name lookups now fetch only the
 * materials and orders the returned page actually mentions.
 */
export async function GET(req: Request) {
  // Owner-only, exactly as before: who may see purchase cost has not changed.
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const { searchParams } = new URL(req.url);
    const orderId = Number(searchParams.get("orderId") ?? "") || null;
    const materialId = Number(searchParams.get("materialId") ?? "") || null;
    const rawLimit = searchParams.get("limit") ? Number(searchParams.get("limit")) : NaN;
    const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 500;
    const rawOffset = searchParams.get("offset") ? Number(searchParams.get("offset")) : 0;
    const offset = Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

    const where = and(
      orderId ? eq(materialPurchases.orderId, orderId) : undefined,
      materialId ? eq(materialPurchases.materialId, materialId) : undefined
    );
    const [totalRow] = await db.select({ total: sql<number>`count(*)` }).from(materialPurchases).where(where);
    const rows = await db
      .select()
      .from(materialPurchases)
      .where(where)
      .orderBy(desc(materialPurchases.purchaseDate), desc(materialPurchases.id))
      .limit(limit)
      .offset(offset);

    // An empty list is not valid SQL for IN, and a page with no purchases mentions nothing.
    const materialIds = [...new Set(rows.map((r) => r.materialId).filter((id): id is number => id !== null))];
    const orderIds = [...new Set(rows.map((r) => r.orderId).filter((id): id is number => id !== null))];
    const [matRows, orderRows] = await Promise.all([
      materialIds.length
        ? db.select().from(materials).where(inArray(materials.id, materialIds))
        : Promise.resolve([] as typeof materials.$inferSelect[]),
      orderIds.length
        ? db.select().from(orders).where(inArray(orders.id, orderIds))
        : Promise.resolve([] as typeof orders.$inferSelect[]),
    ]);
    const mMap = new Map(matRows.map((m) => [m.id, m]));
    const oMap = new Map(orderRows.map((o) => [o.id, o]));
    const data = rows.map((p) => ({
      ...p,
      materialName: mMap.get(p.materialId)?.name ?? "-",
      unit: mMap.get(p.materialId)?.unit ?? "",
      orderNumber: p.orderId ? oMap.get(p.orderId)?.orderNumber ?? "-" : null,
    }));
    return NextResponse.json(data, {
      headers: { "Cache-Control": "private, no-store", "X-Total-Count": String(Number(totalRow?.total ?? 0)) },
    });
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
    // Read the material BEFORE writing the purchase. Its category decides whether this
    // purchase may touch raw-material stock at all, and a purchase against a material that
    // does not exist must be refused rather than written as an orphan row.
    const [mat] = await db.select().from(materials).where(eq(materials.id, Number(b.materialId)));
    if (!mat) return NextResponse.json({ error: "Material not found" }, { status: 404 });
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
    /**
     * Stock in - for RAW MATERIALS only.
     *
     * A ready-made garment is a finished good Matesther BUYS, not a raw material it stores.
     * It stays exactly what it was before this guard: a purchase row with its own cost, which
     * `order-cost` already classifies as `readyMade` rather than as fabric. What it must never
     * do is enter raw-material inventory - because once it is on the fabric shelf it can be
     * issued to a job as though it were cloth, and the same garment is then both stock and a
     * finished purchase.
     *
     * This is not a new rule or a new classification: `POST /api/ready-made` writes its
     * purchases into this very same table and has never touched `current_stock`. The general
     * purchases screen was the one path that did, so a garment catalogued as ready-made and
     * bought here took a door around it. The catalogue unit cost is left alone for the same
     * reason - the dedicated flow leaves it alone too.
     */
    if (!isReadyMadeMaterial(mat.category)) {
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
