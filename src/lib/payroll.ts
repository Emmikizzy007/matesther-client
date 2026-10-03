import { db } from "@/db";
import {
  workers,
  productionOperations,
  stageInspections,
  workerPayments,
  workerOvertime,
  supportAssignments,
  supportInspections,
} from "@/db/schema";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { inspectionEarnings } from "@/lib/job-pay";
import { staffCategories } from "@/lib/format";
import { rolesByWorker, rolesForWorker } from "@/lib/worker-roles";

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

/**
 * Half-open UTC bounds for a `YYYY-MM` key: [first instant, first instant of the
 * next month).
 *
 * WHY A RANGE AND NOT `date_trunc` / `to_char`
 *   `monthKey()` buckets by the UTC month of a timestamp. A half-open range on
 *   the same UTC instants selects exactly the same rows, so the SQL filter and
 *   the JS bucketing agree - and the range is what the new
 *   `stage_inspections_inspected_at_idx` and `support_inspections_inspected_at_idx`
 *   indexes can actually use. `tests/payroll-rules.test.ts` asserts the two agree
 *   on rows either side of a month boundary.
 */
export function monthBounds(month: string): { from: Date; to: Date } {
  const [y, m] = month.split("-").map(Number);
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
}

/* ---------------- per-worker accrual ---------------- */

/** Payment status shown on the payroll sheet and the monthly payment sheet. */
export function paymentStatus(due: number, paid: number): string {
  if (due === 0) return paid > 0 ? "PAID" : "NOTHING_DUE";
  if (paid <= 0) return "UNPAID";
  return due - paid <= 0 ? "PAID" : "PARTIAL";
}

export interface WorkerAccrual {
  month: string;
  workerId: number;
  name: string;
  specialty: string;
  /** Every role the person holds, production and non-production alike. */
  roles: string[];
  /** Broad grouping: Production Worker / Support Worker / Salaried staff. */
  categories: string[];
  department: string | null;
  jobTitle: string | null;
  paymentType: string;
  rate: number;
  status: string;
  pieces: number;
  /** Production stage piecework, on approved pieces only. */
  piecework: number;
  /** Tailor support piecework, on approved support work only. */
  supportPieces: number;
  supportPiecework: number;
  salary: number;
  overtime: number;
  /** Other approved earnings recorded for the month (allowance, bonus). */
  other: number;
  due: number;
  paid: number;
  balance: number;
  paymentStatus: string;
}

/**
 * The pay rules, unchanged - only WHERE they are evaluated has moved.
 *
 *   piecework = approved pieces × rate, where the rate precedence is
 *               inspection snapshot -> the job's agreed rate -> the worker's
 *               legacy profile rate, and only for PER_PIECE people.
 *   pieces    = approved pieces, counted for everyone regardless of payment type.
 *
 * `inspectionEarnings()` in lib/job-pay.ts remains the definition of that rule
 * and is still exercised directly by tests/payroll-rules.test.ts. The SQL below
 * is the same expression as a `CASE` + `COALESCE`, and
 * `assertSqlMatchesInspectionEarnings()` in the same test file proves the two
 * agree rather than leaving them to drift.
 */
const PIECEWORK_SUM = sql`coalesce(sum(case when ${workers.paymentType} = 'PER_PIECE' then ${stageInspections.quantityApproved} * coalesce(${stageInspections.pieceRate}, ${productionOperations.pieceRate}, ${workers.paymentRate}) else 0 end), 0)`;
const SUPPORT_SUM = sql`coalesce(sum(case when ${workers.paymentType} = 'PER_PIECE' then ${supportInspections.quantityApproved} * coalesce(${supportInspections.pieceRate}, ${supportAssignments.pieceRate}, ${workers.paymentRate}) else 0 end), 0)`;

/** The same rule for ONE row, for the history path which buckets in JS. */
const PIECEWORK_ROW = sql`case when ${workers.paymentType} = 'PER_PIECE' then ${stageInspections.quantityApproved} * coalesce(${stageInspections.pieceRate}, ${productionOperations.pieceRate}, ${workers.paymentRate}) else 0 end`;
const SUPPORT_ROW = sql`case when ${workers.paymentType} = 'PER_PIECE' then ${supportInspections.quantityApproved} * coalesce(${supportInspections.pieceRate}, ${supportAssignments.pieceRate}, ${workers.paymentRate}) else 0 end`;

type PieceworkRow = { workerId: number; pieces: number; piecework: number };
type SupportRow = { workerId: number; supportPieces: number; supportPiecework: number };

/** Stage piecework per worker for a month, in ONE grouped query. */
async function stagePiecework(from: Date, to: Date, workerId?: number): Promise<Map<number, PieceworkRow>> {
  const rows = await db
    .select({
      workerId: productionOperations.workerId,
      pieces: sql<number>`coalesce(sum(${stageInspections.quantityApproved}), 0)`,
      piecework: PIECEWORK_SUM,
    })
    .from(stageInspections)
    .innerJoin(productionOperations, eq(productionOperations.id, stageInspections.productionOperationId))
    .innerJoin(workers, eq(workers.id, productionOperations.workerId))
    .where(
      and(
        gte(stageInspections.inspectedAt, from),
        lt(stageInspections.inspectedAt, to),
        workerId === undefined ? undefined : eq(productionOperations.workerId, workerId)
      )
    )
    .groupBy(productionOperations.workerId);
  return new Map(
    rows.map((row) => [
      Number(row.workerId),
      { workerId: Number(row.workerId), pieces: Number(row.pieces) || 0, piecework: Number(row.piecework) || 0 },
    ])
  );
}

/** Support piecework per worker for a month, in ONE grouped query. */
async function supportPiecework(from: Date, to: Date, workerId?: number): Promise<Map<number, SupportRow>> {
  const rows = await db
    .select({
      workerId: supportAssignments.workerId,
      supportPieces: sql<number>`coalesce(sum(${supportInspections.quantityApproved}), 0)`,
      supportPiecework: SUPPORT_SUM,
    })
    .from(supportInspections)
    .innerJoin(supportAssignments, eq(supportAssignments.id, supportInspections.supportAssignmentId))
    .innerJoin(workers, eq(workers.id, supportAssignments.workerId))
    .where(
      and(
        gte(supportInspections.inspectedAt, from),
        lt(supportInspections.inspectedAt, to),
        workerId === undefined ? undefined : eq(supportAssignments.workerId, workerId)
      )
    )
    .groupBy(supportAssignments.workerId);
  return new Map(
    rows.map((row) => [
      Number(row.workerId),
      {
        workerId: Number(row.workerId),
        supportPieces: Number(row.supportPieces) || 0,
        supportPiecework: Number(row.supportPiecework) || 0,
      },
    ])
  );
}

/** Amount already paid per worker for a month. `period_month` is TEXT, so this
 *  is an exact match with no timestamp semantics involved. */
async function paidByWorker(months: string[], workerId?: number): Promise<Map<number, number>> {
  const rows = await db
    .select({
      workerId: workerPayments.workerId,
      periodMonth: workerPayments.periodMonth,
      paid: sql<number>`coalesce(sum(${workerPayments.amount}), 0)`,
    })
    .from(workerPayments)
    .where(
      and(
        inArray(workerPayments.periodMonth, months),
        workerId === undefined ? undefined : eq(workerPayments.workerId, workerId)
      )
    )
    .groupBy(workerPayments.workerId, workerPayments.periodMonth);
  const out = new Map<number, number>();
  for (const row of rows) {
    const key = Number(row.workerId);
    out.set(key, (out.get(key) ?? 0) + (Number(row.paid) || 0));
  }
  return out;
}

type ExtraRow = { workerId: number; overtime: number; other: number };

/** Overtime and other approved earnings per worker for a month.
 *  `months` is the inclusive list of `YYYY-MM` keys to cover. */
async function extrasByWorker(months: string[], workerId?: number): Promise<Map<number, ExtraRow>> {
  const from = `${months[0]}-01`;
  const to = `${shiftMonth(months[months.length - 1], 1)}-01`;
  const rows = await db
    .select({
      workerId: workerOvertime.workerId,
      // `category` is NOT NULL DEFAULT 'OVERTIME'; the coalesce mirrors the
      // `?? "OVERTIME"` the previous JS did, so a legacy null behaves the same.
      overtime: sql<number>`coalesce(sum(case when coalesce(${workerOvertime.category}, 'OVERTIME') = 'OVERTIME' then ${workerOvertime.amount} else 0 end), 0)`,
      other: sql<number>`coalesce(sum(case when ${workerOvertime.category} = 'OTHER' then ${workerOvertime.amount} else 0 end), 0)`,
    })
    .from(workerOvertime)
    .where(
      and(
        gte(workerOvertime.workedOn, from),
        lt(workerOvertime.workedOn, to),
        workerId === undefined ? undefined : eq(workerOvertime.workerId, workerId)
      )
    )
    .groupBy(workerOvertime.workerId);
  return new Map(
    rows.map((row) => [
      Number(row.workerId),
      { workerId: Number(row.workerId), overtime: Number(row.overtime) || 0, other: Number(row.other) || 0 },
    ])
  );
}

/**
 * Salary and the month-window rules that decide whether it applies.
 *
 * Kept in TypeScript on purpose: it depends on `monthKey()` of `archived_at` and
 * `created_at`, is a per-person scalar rather than an aggregate, and is exactly
 * the expression that was there before.
 */
function salaryFor(w: {
  paymentType: string; paymentRate: number; status: string;
  archivedAt: Date | null; createdAt: Date | null;
}, month: string): number {
  const rate = w.paymentRate ?? 0;
  const activeDuringMonth = w.status === "ACTIVE" || (!!w.archivedAt && month <= monthKey(w.archivedAt));
  return w.paymentType === "MONTHLY" && activeDuringMonth && (!w.createdAt || month >= monthKey(w.createdAt)) ? rate : 0;
}

function assemble(
  w: typeof workers.$inferSelect,
  month: string,
  roles: string[],
  stage: PieceworkRow | undefined,
  support: SupportRow | undefined,
  paid: number,
  extra: ExtraRow | undefined
): WorkerAccrual {
  const rate = w.paymentRate ?? 0;
  const piecework = stage?.piecework ?? 0;
  const supportEarned = support?.supportPiecework ?? 0;
  const salary = salaryFor(w, month);
  const overtime = extra?.overtime ?? 0;
  const other = extra?.other ?? 0;
  const due = piecework + supportEarned + salary + overtime + other;
  return {
    month,
    workerId: w.id,
    name: w.name,
    specialty: w.specialty,
    roles,
    categories: staffCategories(roles),
    department: w.department ?? null,
    jobTitle: w.jobTitle ?? null,
    paymentType: w.paymentType,
    rate,
    status: w.status,
    pieces: stage?.pieces ?? 0,
    piecework,
    supportPieces: support?.supportPieces ?? 0,
    supportPiecework: supportEarned,
    salary,
    overtime,
    other,
    due,
    paid,
    balance: due - paid,
    paymentStatus: paymentStatus(due, paid),
  };
}

/**
 * What a worker has EARNED in a given month, plus what has already been PAID.
 *
 * This used to issue 9 statements and read ~18,000 rows for ONE person, two of
 * those statements being unfiltered full scans of `stage_inspections` and
 * `support_inspections` whose rows were then thrown away by a JS month filter.
 * It now issues 7 statements and reads only that person's rows for that month.
 */
export async function accrualForWorker(workerId: number, month: string): Promise<WorkerAccrual | null> {
  const [w] = await db.select().from(workers).where(eq(workers.id, workerId));
  if (!w) return null;
  const { from, to } = monthBounds(month);
  const [stage, support, paid, extra, roles] = await Promise.all([
    stagePiecework(from, to, workerId),
    supportPiecework(from, to, workerId),
    paidByWorker([month], workerId),
    extrasByWorker([month], workerId),
    rolesForWorker(workerId),
  ]);
  return assemble(w, month, roles, stage.get(workerId), support.get(workerId), paid.get(workerId) ?? 0, extra.get(workerId));
}

/**
 * Accruals for every worker in a month + totals (the "amount we must pay this
 * month").
 *
 * Was: one `accrualForWorker` per worker, i.e. 630 statements and ~1.27 million
 * rows read for 70 workers, because every one of them re-scanned the entire
 * inspection history. Now: 7 statements and only the month's rows, with the
 * per-worker split done by `GROUP BY`.
 */
export async function workerAccruals(month: string) {
  const { from, to } = monthBounds(month);
  const [people, roleMap, stage, support, paid, extra] = await Promise.all([
    db.select().from(workers),
    rolesByWorker(),
    stagePiecework(from, to),
    supportPiecework(from, to),
    paidByWorker([month]),
    extrasByWorker([month]),
  ]);
  const rows = people
    .map((w) =>
      assemble(
        w, month, roleMap.get(w.id) ?? [], stage.get(w.id), support.get(w.id),
        paid.get(w.id) ?? 0, extra.get(w.id)
      )
    )
    .sort((a, b) => b.due - a.due);
  const totals = rows.reduce(
    (t, r) => ({
      due: t.due + r.due,
      paid: t.paid + r.paid,
      balance: t.balance + r.balance,
    }),
    { due: 0, paid: 0, balance: 0 }
  );
  // Kept separate from `totals` on purpose: totals is the headline the existing
  // payroll UI and tests rely on, breakdown is the additive detail.
  const breakdown = rows.reduce(
    (t, r) => ({
      piecework: t.piecework + r.piecework,
      supportPiecework: t.supportPiecework + r.supportPiecework,
      salary: t.salary + r.salary,
      overtime: t.overtime + r.overtime,
      other: t.other + r.other,
    }),
    { piecework: 0, supportPiecework: 0, salary: 0, overtime: 0, other: 0 }
  );
  return { workers: rows, totals, breakdown };
}

/**
 * 12-month history for one worker + their payment records.
 *
 * Was: twelve sequential `accrualForWorker` calls = 112 statements and ~218,000
 * rows read. Now the whole 12-month window is fetched once and bucketed by
 * `monthKey()`, which is the same function the single-month path uses.
 */
export async function workerHistory(workerId: number, month: string) {
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) months.push(shiftMonth(month, -i));
  const { from } = monthBounds(months[0]);
  const { to } = monthBounds(months[months.length - 1]);

  const [w] = await db.select().from(workers).where(eq(workers.id, workerId));
  if (!w) return { history: [], payments: [] };

  // One worker over twelve months is a small set, so the inspection rows are
  // fetched individually and bucketed in JS - the same `monthKey()` the
  // single-month path uses, which keeps the two paths from ever disagreeing.
  const [stageRows, supportRows, extraRows, paymentRows, roles] = await Promise.all([
    db
      .select({
        inspectedAt: stageInspections.inspectedAt,
        quantityApproved: stageInspections.quantityApproved,
        earnings: PIECEWORK_ROW,
      })
      .from(stageInspections)
      .innerJoin(productionOperations, eq(productionOperations.id, stageInspections.productionOperationId))
      .innerJoin(workers, eq(workers.id, productionOperations.workerId))
      .where(
        and(
          eq(productionOperations.workerId, workerId),
          gte(stageInspections.inspectedAt, from),
          lt(stageInspections.inspectedAt, to)
        )
      ),
    db
      .select({
        inspectedAt: supportInspections.inspectedAt,
        quantityApproved: supportInspections.quantityApproved,
        earnings: SUPPORT_ROW,
      })
      .from(supportInspections)
      .innerJoin(supportAssignments, eq(supportAssignments.id, supportInspections.supportAssignmentId))
      .innerJoin(workers, eq(workers.id, supportAssignments.workerId))
      .where(
        and(
          eq(supportAssignments.workerId, workerId),
          gte(supportInspections.inspectedAt, from),
          lt(supportInspections.inspectedAt, to)
        )
      ),
    db
      .select()
      .from(workerOvertime)
      .where(
        and(
          eq(workerOvertime.workerId, workerId),
          gte(workerOvertime.workedOn, `${months[0]}-01`),
          lt(workerOvertime.workedOn, `${shiftMonth(months[months.length - 1], 1)}-01`)
        )
      ),
    db
      .select()
      .from(workerPayments)
      .where(and(eq(workerPayments.workerId, workerId), inArray(workerPayments.periodMonth, months)))
      .orderBy(workerPayments.paymentDate),
    rolesForWorker(workerId),
  ]);

  const bucket = new Map<string, { pieces: number; piecework: number; supportPieces: number; supportPiecework: number; overtime: number; other: number; paid: number }>();
  const ensure = (key: string) => {
    const found = bucket.get(key);
    if (found) return found;
    const fresh = { pieces: 0, piecework: 0, supportPieces: 0, supportPiecework: 0, overtime: 0, other: 0, paid: 0 };
    bucket.set(key, fresh);
    return fresh;
  };
  for (const row of stageRows) {
    const entry = ensure(monthKey(row.inspectedAt));
    entry.pieces += row.quantityApproved ?? 0;
    entry.piecework += Number(row.earnings) || 0;
  }
  for (const row of supportRows) {
    const entry = ensure(monthKey(row.inspectedAt));
    entry.supportPieces += row.quantityApproved ?? 0;
    entry.supportPiecework += Number(row.earnings) || 0;
  }
  for (const row of extraRows) {
    const entry = ensure(monthKey(row.workedOn));
    if ((row.category ?? "OVERTIME") === "OTHER") entry.other += row.amount ?? 0;
    else entry.overtime += row.amount ?? 0;
  }
  for (const row of paymentRows) ensure(row.periodMonth).paid += row.amount ?? 0;

  const history: WorkerAccrual[] = [];
  for (const m of months) {
    const entry = bucket.get(m) ?? { pieces: 0, piecework: 0, supportPieces: 0, supportPiecework: 0, overtime: 0, other: 0, paid: 0 };
    const salary = salaryFor(w, m);
    const due = entry.piecework + entry.supportPiecework + salary + entry.overtime + entry.other;
    history.push({
      month: m,
      workerId: w.id,
      name: w.name,
      specialty: w.specialty,
      roles,
      categories: staffCategories(roles),
      department: w.department ?? null,
      jobTitle: w.jobTitle ?? null,
      paymentType: w.paymentType,
      rate: w.paymentRate ?? 0,
      status: w.status,
      pieces: entry.pieces,
      piecework: entry.piecework,
      supportPieces: entry.supportPieces,
      supportPiecework: entry.supportPiecework,
      salary,
      overtime: entry.overtime,
      other: entry.other,
      due,
      paid: entry.paid,
      balance: due - entry.paid,
      paymentStatus: paymentStatus(due, entry.paid),
    });
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

/** Re-exported so the pay rule and its SQL form stay visibly tied together. */
export { inspectionEarnings };
