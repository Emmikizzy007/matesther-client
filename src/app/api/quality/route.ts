import { NextResponse } from "next/server";
import { guard, OWNER } from "@/lib/authz";
import { db } from "@/db";
import { qualityChecks, reworkRecords } from "@/db/schema";
import { desc } from "drizzle-orm";

/** kind=check (default) or kind=rework */
export async function GET(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const { searchParams } = new URL(req.url);
    const kind = searchParams.get("kind") || "check";
    if (kind === "rework") {
      const rows = await db.select().from(reworkRecords).orderBy(desc(reworkRecords.createdAt));
      return NextResponse.json(rows);
    }
    const rows = await db.select().from(qualityChecks).orderBy(desc(qualityChecks.checkedAt));
    return NextResponse.json(rows);
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const b = await req.json();
    if (!b.productionOperationId)
      return NextResponse.json({ error: "Production operation is required" }, { status: 400 });
    if (b.kind === "rework") {
      if (!b.quantity || Number(b.quantity) <= 0)
        return NextResponse.json({ error: "Rework quantity is required" }, { status: 400 });
      const [row] = await db
        .insert(reworkRecords)
        .values({
          productionOperationId: Number(b.productionOperationId),
          quantity: Number(b.quantity),
          reason: b.reason || null,
          status: b.status || "PENDING",
        })
        .returning();
      return NextResponse.json(row, { status: 201 });
    }
    const checked = Number(b.quantityChecked) || 0;
    const passed = Number(b.quantityPassed) || 0;
    if (checked <= 0) return NextResponse.json({ error: "Quantity checked is required" }, { status: 400 });
    if (passed > checked)
      return NextResponse.json({ error: "Passed cannot exceed checked" }, { status: 400 });
    const [row] = await db
      .insert(qualityChecks)
      .values({
        productionOperationId: Number(b.productionOperationId),
        quantityChecked: checked,
        quantityPassed: passed,
        quantityFailed: checked - passed,
        notes: b.notes || null,
      })
      .returning();
    return NextResponse.json(row, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}
