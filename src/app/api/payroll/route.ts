import { NextResponse } from "next/server";
import { guard, getSessionUser, OWNER } from "@/lib/authz";
import { db } from "@/db";
import { workerPayments, workerOvertime, workers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { workerAccruals, workerHistory, currentMonth } from "@/lib/payroll";

/**
 * GET /api/payroll?month=YYYY-MM            → monthly payroll summary for all workers
 * GET /api/payroll?month=YYYY-MM&workerId=N → 12-month history + payment records for one worker
 */
export async function GET(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const { searchParams } = new URL(req.url);
    const month = searchParams.get("month") || currentMonth();
    const workerId = searchParams.get("workerId");

    if (workerId) {
      const [worker] = await db
        .select()
        .from(workers)
        .where(eq(workers.id, Number(workerId)));
      if (!worker) return NextResponse.json({ error: "Worker not found" }, { status: 404 });
      const { history, payments } = await workerHistory(Number(workerId), month);
      return NextResponse.json({ worker, month, history, payments });
    }

    const { workers: rows, totals, breakdown } = await workerAccruals(month);
    const [payRows, otRows, allWorkers] = await Promise.all([
      db.select().from(workerPayments),
      db.select().from(workerOvertime),
      db.select().from(workers),
    ]);
    const wMap = new Map(allWorkers.map((w) => [w.id, w]));
    const payments = payRows
      .filter((p) => p.periodMonth === month)
      .map((p) => ({ ...p, workerName: wMap.get(p.workerId)?.name ?? "-" }))
      .sort((a, b) => String(b.paymentDate).localeCompare(String(a.paymentDate)));
    const overtime = otRows
      .filter((o) => {
        const k = String(o.workedOn).slice(0, 7);
        return k === month;
      })
      .map((o) => ({ ...o, workerName: wMap.get(o.workerId)?.name ?? "-" }));

    return NextResponse.json({ month, workers: rows, totals, breakdown, payments, overtime });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}

/**
 * POST /api/payroll
 *  { kind: "payment", workerId, periodMonth, paymentDate, pieceworkAmount, supportAmount,
 *    salaryAmount, overtimeAmount, otherAmount, amount, method, paidBy, reference,
 *    idempotencyKey, notes }
 *  { kind: "overtime", workerId, workedOn, hours, amount, category, notes }
 *
 * Payments are only ever inserted, never updated or deleted, so the payroll
 * history is preserved. An optional `idempotencyKey` makes the same payment
 * impossible to record twice - a repeat returns 409 with the original row.
 */
export async function POST(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  const session = await getSessionUser(req);
  try {
    const b = await req.json();
    if (b.kind === "overtime" || b.kind === "other") {
      if (!b.workerId) return NextResponse.json({ error: "Worker is required" }, { status: 400 });
      if (!b.amount || Number(b.amount) <= 0)
        return NextResponse.json({ error: "The amount must be greater than zero" }, { status: 400 });
      const category = b.kind === "other" || b.category === "OTHER" ? "OTHER" : "OVERTIME";
      const [row] = await db
        .insert(workerOvertime)
        .values({
          workerId: Number(b.workerId),
          workedOn: b.workedOn || new Date().toISOString().slice(0, 10),
          hours: Number(b.hours) || 0,
          amount: Number(b.amount),
          category,
          notes: b.notes || null,
        })
        .returning();
      return NextResponse.json(row, { status: 201 });
    }

    // payment
    if (!b.workerId) return NextResponse.json({ error: "Worker is required" }, { status: 400 });
    if (!b.amount || Number(b.amount) <= 0)
      return NextResponse.json({ error: "Payment amount must be greater than zero" }, { status: 400 });
    const amount = Number(b.amount);
    if (!Number.isSafeInteger(amount))
      return NextResponse.json({ error: "Payment amount must be a whole naira amount." }, { status: 400 });

    const PARTS = ["pieceworkAmount", "supportAmount", "salaryAmount", "overtimeAmount", "otherAmount"] as const;
    const part = (key: (typeof PARTS)[number]) => Number(b[key]) || 0;
    const itemised = PARTS.some((key) => b[key] !== undefined);
    const partsSum = PARTS.reduce((sum, key) => sum + part(key), 0);
    if (itemised && partsSum !== amount)
      return NextResponse.json(
        { error: "The breakdown must add up to the total paid." },
        { status: 400 }
      );

    // Duplicate/double-payment guard: the same key can only ever be stored once.
    const idempotencyKey = b.idempotencyKey ? String(b.idempotencyKey).slice(0, 200) : null;
    if (idempotencyKey) {
      const [existing] = await db
        .select()
        .from(workerPayments)
        .where(eq(workerPayments.idempotencyKey, idempotencyKey))
        .limit(1);
      if (existing)
        return NextResponse.json(
          { error: "This payment has already been recorded.", payment: existing },
          { status: 409 }
        );
    }

    const [row] = await db
      .insert(workerPayments)
      .values({
        workerId: Number(b.workerId),
        paymentDate: b.paymentDate || new Date().toISOString().slice(0, 10),
        periodMonth: b.periodMonth || currentMonth(),
        pieceworkAmount: part("pieceworkAmount"),
        supportAmount: part("supportAmount"),
        salaryAmount: part("salaryAmount"),
        overtimeAmount: part("overtimeAmount"),
        otherAmount: part("otherAmount"),
        amount,
        method: b.method || "Cash",
        /**
         * WHO recorded this payment comes from the session, never from the request.
         *
         * `paidBy` was the only actor in the entire API taken from the body: the payroll
         * screen sent `user?.name`, so an honest client wrote the truth and any other caller
         * could write anyone - or nobody - into the payroll history. Every sibling route
         * already derives its actor server-side (`inspections.inspectedBy`, support
         * approvals, `production-corrections`), and a payment is the one record where "who
         * paid this person" is the whole audit. The column is unchanged and the honest
         * client's value is unchanged; only where it is trusted from has moved.
         */
        paidBy: session?.name || null,
        reference: b.reference ? String(b.reference).slice(0, 200) : null,
        idempotencyKey,
        notes: b.notes || null,
      })
      .returning();
    return NextResponse.json(row, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}
