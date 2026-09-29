import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  workers,
  productionOperations,
  productionBatches,
  orders,
  customers,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { guard, getSessionUser, OWNER, STAFF } from "@/lib/authz";

export async function GET(req: Request) {
  const __g = await guard(req, STAFF);
  if (__g) return __g;
  try {
    const managerView = (await getSessionUser(req))?.role === "PRODUCTION_MANAGER";
    const publicWorker = (person: typeof workers.$inferSelect) => managerView
      ? { id: person.id, name: person.name, phone: person.phone, specialty: person.specialty,
          status: person.status, isInspector: person.isInspector, createdAt: person.createdAt }
      : person;
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    const rows = await db.select().from(workers);
    const opRows = await db.select().from(productionOperations);

    if (id) {
      const w = rows.find((x) => x.id === Number(id));
      if (!w) return NextResponse.json({ error: "Worker not found" }, { status: 404 });
      const myOps = opRows.filter((o) => o.workerId === w.id);
      const [batches, orderRows, customerRows] = await Promise.all([
        db.select().from(productionBatches),
        db.select().from(orders),
        db.select().from(customers),
      ]);
      const bMap = new Map(batches.map((b) => [b.id, b]));
      const oMap = new Map(orderRows.map((o) => [o.id, o]));
      const cMap = new Map(customerRows.map((c) => [c.id, c]));
      return NextResponse.json({
        ...publicWorker(w),
        assigned: myOps.reduce((s, o) => s + (o.quantityReceived ?? 0), 0),
        completed: myOps.reduce((s, o) => s + (o.quantityCompleted ?? 0), 0),
        approved: myOps.reduce((s, o) => s + (o.quantityApproved ?? 0), 0),
        rejected: myOps.reduce((s, o) => s + (o.quantityRejected ?? 0), 0),
        ...(managerView ? {} : {
          earnings: w.paymentType === "PER_PIECE"
            ? myOps.reduce((s, o) => s + (o.quantityApproved ?? 0), 0) * (w.paymentRate ?? 0)
            : w.paymentType === "MONTHLY" ? (w.paymentRate ?? 0) : 0,
        }),
        history: myOps.map((o) => {
          const batch = bMap.get(o.productionBatchId);
          const order = batch ? oMap.get(batch.orderId) : undefined;
          return {
            ...o,
            batchNumber: batch?.batchNumber ?? "-",
            orderNumber: order?.orderNumber ?? "-",
            orderId: order?.id,
            customer: cMap.get(order?.customerId ?? -1)?.name ?? "-",
          };
        }),
      });
    }

    const data = rows.map((w) => {
      const myOps = opRows.filter((o) => o.workerId === w.id);
      const approved = myOps.reduce((s, o) => s + (o.quantityApproved ?? 0), 0);
      return {
        ...publicWorker(w),
        currentTasks: myOps.filter((o) => o.status === "IN_PROGRESS" || o.status === "PENDING").length,
        assigned: myOps.reduce((s, o) => s + (o.quantityReceived ?? 0), 0),
        completed: myOps.reduce((s, o) => s + (o.quantityCompleted ?? 0), 0),
        rejected: myOps.reduce((s, o) => s + (o.quantityRejected ?? 0), 0),
        approved,
        ...(managerView ? {} : {
          earnings: w.paymentType === "PER_PIECE"
            ? approved * (w.paymentRate ?? 0)
            : w.paymentType === "MONTHLY" ? (w.paymentRate ?? 0) : 0,
        }),
      };
    });
    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const __g = await guard(req, OWNER);
  if (__g) return __g;
  try {
    const b = await req.json();
    if (!b.name) return NextResponse.json({ error: "Worker name is required" }, { status: 400 });
    const [row] = await db
      .insert(workers)
      .values({
        organizationId: 1,
        name: b.name,
        phone: b.phone || null,
        specialty: b.specialty || "Tailor",
        paymentType: b.paymentType || "PER_PIECE",
        paymentRate: Number(b.paymentRate) || 0,
        isInspector: !!b.isInspector,
        status: "ACTIVE",
      })
      .returning();
    return NextResponse.json(row, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const __g = await guard(req, OWNER);
  if (__g) return __g;
  try {
    const b = await req.json();
    const [row] = await db
      .update(workers)
      .set({
        name: b.name,
        phone: b.phone,
        specialty: b.specialty,
        paymentType: b.paymentType,
        paymentRate: Number(b.paymentRate) || 0,
        isInspector: !!b.isInspector,
        status: b.status,
      })
      .where(eq(workers.id, Number(b.id)))
      .returning();
    return NextResponse.json(row);
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const __g = await guard(req, OWNER);
  if (__g) return __g;
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    const linked = await db
      .select()
      .from(productionOperations)
      .where(eq(productionOperations.workerId, Number(id)));
    if (linked.length > 0)
      return NextResponse.json(
        { error: `Cannot delete - this worker has ${linked.length} production record(s). Set status to INACTIVE instead.` },
        { status: 400 }
      );
    await db.delete(workers).where(eq(workers.id, Number(id)));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}
