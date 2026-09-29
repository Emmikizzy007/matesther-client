import { db } from "@/db";
import {
  workers,
  productionOperations,
  stageInspections,
  workerPayments,
  workerOvertime,
} from "@/db/schema";
import { eq } from "drizzle-orm";

/* ---------------- month helpers ---------------- */

export function monthKey(d: Date | string | null | undefined): string {
  if (!d) return "";
  if (d instanceof Date) return d.toISOString().slice(0, 7);
  return String(d).slice(0, 7);
}

export function currentMonth(): string {
  return monthKey(new Date());
}

export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/* ---------------- per-worker accrual ---------------- */

export interface WorkerAccrual {
  month: string;
  workerId: number;
  name: string;
  specialty: string;
  paymentType: string;
  rate: number;
  status: string;
  pieces: number;
  piecework: number;
  salary: number;
  overtime: number;
  due: number;
  paid: number;
  balance: number;
}

/**
 * What a worker has EARNED in a given month:
 *  - piecework = approved pieces (at inspection) × per-piece rate
 *  - salary    = monthly wage for salaried staff
 *  - overtime  = recorded overtime payments for that month
 * plus what has already been PAID (worker_payments for that period).
 */
export async function accrualForWorker(workerId: number, month: string): Promise<WorkerAccrual | null> {
  const [w] = await db.select().from(workers).where(eq(workers.id, workerId));
  if (!w) return null;

  const [ops, insps, pays, ots] = await Promise.all([
    db.select().from(productionOperations).where(eq(productionOperations.workerId, workerId)),
    db.select().from(stageInspections),
    db.select().from(workerPayments).where(eq(workerPayments.workerId, workerId)),
    db.select().from(workerOvertime).where(eq(workerOvertime.workerId, workerId)),
  ]);
  const opIds = new Set(ops.map((o) => o.id));

  let pieces = 0;
  for (const i of insps) {
    if (opIds.has(i.productionOperationId) && monthKey(i.inspectedAt) === month) {
      pieces += i.quantityApproved ?? 0;
    }
  }
  const rate = w.paymentRate ?? 0;
  const piecework = w.paymentType === "PER_PIECE" ? pieces * rate : 0;
  const salary = w.paymentType === "MONTHLY" && w.status === "ACTIVE" ? rate : 0;
  const overtime = ots
    .filter((o) => monthKey(o.workedOn) === month)
    .reduce((s, o) => s + (o.amount ?? 0), 0);
  const due = piecework + salary + overtime;
  const paid = pays
    .filter((p) => p.periodMonth === month)
    .reduce((s, p) => s + (p.amount ?? 0), 0);

  return {
    month,
    workerId,
    name: w.name,
    specialty: w.specialty,
    paymentType: w.paymentType,
    rate,
    status: w.status,
    pieces,
    piecework,
    salary,
    overtime,
    due,
    paid,
    balance: due - paid,
  };
}

/** Accruals for every worker in a month + totals (the "amount we must pay this month") */
export async function workerAccruals(month: string) {
  const ws = await db.select().from(workers);
  const rows = (await Promise.all(ws.map((w) => accrualForWorker(w.id, month))))
    .filter((r): r is WorkerAccrual => !!r)
    .sort((a, b) => b.due - a.due);
  const totals = rows.reduce(
    (t, r) => ({
      due: t.due + r.due,
      paid: t.paid + r.paid,
      balance: t.balance + r.balance,
    }),
    { due: 0, paid: 0, balance: 0 }
  );
  return { workers: rows, totals };
}

/** 12-month history for one worker + their payment records */
export async function workerHistory(workerId: number, month: string) {
  const history: WorkerAccrual[] = [];
  for (let i = 0; i < 12; i++) {
    const m = shiftMonth(month, -i);
    const row = await accrualForWorker(workerId, m);
    if (row) history.push(row);
  }
  const payments = await db
    .select()
    .from(workerPayments)
    .where(eq(workerPayments.workerId, workerId))
    .orderBy(workerPayments.paymentDate);
  return { history, payments };
}

/* ---------------- business growth (monthly) ---------------- */

/**
 * Monthly Revenue / Expenses / Profit series for the growth chart.
 * revenue  = order value by order month
 * expenses = recorded expenses + materials actually used, by month
 */
export function buildGrowth(orders: any[], expenseRows: any[], usageRows: any[]) {
  const byMonth = new Map<string, { revenue: number; expenses: number }>();
  const ensure = (k: string) => {
    if (!k) return null;
    if (!byMonth.has(k)) byMonth.set(k, { revenue: 0, expenses: 0 });
    return byMonth.get(k)!;
  };
  for (const o of orders) {
    const v = ensure(monthKey(o.orderDate));
    if (v) v.revenue += o.totalAmount ?? 0;
  }
  for (const e of expenseRows) {
    const v = ensure(monthKey(e.expenseDate));
    if (v) v.expenses += e.amount ?? 0;
  }
  for (const u of usageRows) {
    const v = ensure(monthKey(u.usedAt));
    if (v) v.expenses += u.totalCost ?? 0;
  }

  const known = [...byMonth.keys()].sort();
  const start = known[0] ?? currentMonth();
  const end = currentMonth();
  const months: { key: string; label: string; revenue: number; expenses: number; profit: number }[] = [];
  for (let k = start; k <= end; k = shiftMonth(k, 1)) {
    const v = byMonth.get(k) ?? { revenue: 0, expenses: 0 };
    months.push({
      key: k,
      label: new Date(Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, 1)).toLocaleDateString(
        "en-GB",
        { month: "short", year: "2-digit", timeZone: "UTC" }
      ),
      revenue: v.revenue,
      expenses: v.expenses,
      profit: v.revenue - v.expenses,
    });
  }

  const years = new Map<number, { year: number; revenue: number; expenses: number; profit: number }>();
  for (const m of months) {
    const y = Number(m.key.slice(0, 4));
    if (!years.has(y)) years.set(y, { year: y, revenue: 0, expenses: 0, profit: 0 });
    const rec = years.get(y)!;
    rec.revenue += m.revenue;
    rec.expenses += m.expenses;
    rec.profit += m.profit;
  }
  const nowYear = Number(currentMonth().slice(0, 4));
  const yearsList = [...years.values()].map((y) => ({
    ...y,
    margin: y.revenue > 0 ? Math.round((y.profit / y.revenue) * 1000) / 10 : 0,
    ytd: y.year === nowYear,
  }));

  return { months, years: yearsList };
}
