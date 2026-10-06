import { NextResponse } from "next/server";
import { guard, getSessionUser, OWNER } from "@/lib/authz";
import { db } from "@/db";
import { payments, orders, customers } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { refreshOrderMoney } from "@/lib/server";

export async function GET(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const { searchParams } = new URL(req.url);
    const orderId = searchParams.get("orderId");
    const rows = await db.select().from(payments).orderBy(desc(payments.paymentDate));
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
        orderTotal: o?.totalAmount ?? 0,
        balance: o?.balance ?? 0,
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
    /**
     * The actor is the signed-in user, read from the session.
     *
     * Nothing here is taken from the request body: a caller must not be able to put somebody
     * else's name on a receipt, a packing record or a delivery note, which is exactly what made
     * payroll's `paidBy` worth fixing. Same derivation as `worker_payments.paid_by`,
     * `stage_inspections.inspected_by` and the ledger's `actor_user_id` / `actor_name`.
     *
     * Stamped once, when the record is created, and never rewritten by a later edit - so it
     * means WHO RECORDED THIS, not who last touched it. An edit is already OWNER-only on all
     * three routes, and silently moving this column would change the meaning of rows that are
     * already on somebody's filing cabinet.
     */
    const actor = await getSessionUser(req);
    const b = await req.json();
    if (!b.orderId) return NextResponse.json({ error: "Order is required" }, { status: 400 });
    if (!b.amount || Number(b.amount) <= 0)
      return NextResponse.json({ error: "Amount must be greater than zero" }, { status: 400 });
    const [row] = await db
      .insert(payments)
      .values({
        orderId: Number(b.orderId),
        amount: Number(b.amount),
        paymentDate: b.paymentDate || new Date().toISOString().slice(0, 10),
        paymentMethod: b.paymentMethod || "Bank Transfer",
        reference: b.reference || null,
        notes: b.notes || null,
        recordedById: actor?.id ?? null,
        recordedByName: actor?.name ?? null,
      })
      .returning();
    await refreshOrderMoney(Number(b.orderId));
    return NextResponse.json(row, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const { searchParams } = new URL(req.url);
    const id = Number(searchParams.get("id"));
    const [row] = await db.select().from(payments).where(eq(payments.id, id));
    await db.delete(payments).where(eq(payments.id, id));
    if (row) await refreshOrderMoney(row.orderId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}
