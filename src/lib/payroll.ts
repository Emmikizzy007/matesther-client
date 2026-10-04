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
import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
  /**
   * Approved pieces this worker HANDED OUT to a helper, and the money that came
   * back out of their own rate because of it.
   *
   * Matesther's rule: the tailor's full piece rate belongs to the garment. Doing
   * it themselves keeps all of it; handing a piece to a helper at an agreed rate
   * has that rate DEDUCTED, never added on top. A shirt at 300 with a helper
   * agreed at 30 pays the helper 30 and leaves the tailor 270.
   */
  supportPiecesDelegated: number;
  /** What actually came OUT of this month's piece-rate earnings. */
  supportDeduction: number;
  /**
   * What this month's approvals asked for in total, before the cap. Equals
   * `supportDeduction` whenever the month had enough piece-rate earnings to absorb
   * it, which is the normal case.
   */
  supportDeductionArising: number;
  /** Still to be recovered from this worker's later piece-rate earnings. */
  supportDeductionOwed: number;
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
/**
 * Who an inspection's approved pieces belong to.
 *
 * `stage_inspections.worker_id` is NULL on every inspection recorded before a stage
 * could be split across workers, and for those the answer is the stage's own
 * worker - which is exactly what payroll has always done. Where a stage IS split,
 * each inspection row names the worker it was attributed to, so pay follows the
 * person who actually made the garment rather than whoever the stage happens to be
 * nominally assigned to.
 *
 * Defining it once here is what keeps the monthly accrual, the twelve-month history
 * and the Workers page lifetime figure from ever disagreeing about attribution.
 */
const PAID_WORKER = sql`coalesce(${stageInspections.workerId}, ${productionOperations.workerId})`;

const PIECEWORK_SUM = sql`coalesce(sum(case when ${workers.paymentType} = 'PER_PIECE' then ${stageInspections.quantityApproved} * coalesce(${stageInspections.pieceRate}, ${productionOperations.pieceRate}, ${workers.paymentRate}) else 0 end), 0)`;
const SUPPORT_SUM = sql`coalesce(sum(case when ${workers.paymentType} = 'PER_PIECE' then ${supportInspections.quantityApproved} * coalesce(${supportInspections.pieceRate}, ${supportAssignments.pieceRate}, ${workers.paymentRate}) else 0 end), 0)`;

/** The same rule for ONE row, for the history path which buckets in JS. */
const PIECEWORK_ROW = sql`case when ${workers.paymentType} = 'PER_PIECE' then ${stageInspections.quantityApproved} * coalesce(${stageInspections.pieceRate}, ${productionOperations.pieceRate}, ${workers.paymentRate}) else 0 end`;
const SUPPORT_ROW = sql`case when ${workers.paymentType} = 'PER_PIECE' then ${supportInspections.quantityApproved} * coalesce(${supportInspections.pieceRate}, ${supportAssignments.pieceRate}, ${workers.paymentRate}) else 0 end`;

/**
 * The DEDUCTION side of support work.
 *
 * Same expression as `SUPPORT_SUM` and deliberately so: one movement of money has
 * two sides, and the amount the helper earns on an approved piece is exactly the
 * amount that leaves the tailor's rate for that piece. Reusing the expression is
 * what stops the two sides from ever drifting apart - if the helper's rule
 * changes, the deduction changes with it.
 *
 * The `workers` join stays on the HELPER (`supportAssignments.workerId`) because
 * it is the helper's rate and payment type that set the amount. Only the grouping
 * key differs: this one groups by `assignedByWorkerId`, the tailor who handed the
 * work out. That tailor is always a real worker - a login with no worker record
 * cannot create a support assignment at all - so the deduction always has somebody
 * to land on.
 *
 * Only APPROVED pieces move money on either side, at the rate snapshotted on the
 * inspection, so a later rate change cannot rewrite pay already earned.
 */

/**
 * The tailor whose commission a support deduction comes out of, joined alongside the
 * helper whose rate sets its amount. Aliased because one support inspection touches two
 * workers at once and a single `workers` join cannot be both.
 */
const supportTailor = alias(workers, "payroll_support_tailor");

/**
 * What an approved support inspection deducts from the tailor who handed it out.
 *
 * The amount is the helper's, at the rate snapshotted on the inspection - one movement
 * of money, two sides of it. But it only arises where the tailor actually HAS a piece
 * rate for it to come out of. A tailor paid a flat monthly salary earns no commission,
 * so there is nothing to deduct from and nothing to carry: the helper is still paid, and
 * that pay is a real extra cost of the work rather than a slice of somebody's commission.
 */
const DEDUCTION_SUM = sql`coalesce(sum(case when ${supportTailor.paymentType} = 'PER_PIECE' and ${workers.paymentType} = 'PER_PIECE' then ${supportInspections.quantityApproved} * coalesce(${supportInspections.pieceRate}, ${supportAssignments.pieceRate}, ${workers.paymentRate}) else 0 end), 0)`;

type PieceworkRow = { workerId: number; pieces: number; piecework: number };

/** One worker's support deduction for one month, after the carry-forward walk. */
export type DeductionMonth = {
  /** Approved pieces this worker handed out that were inspected in this month. */
  piecesDelegated: number;
  /** What those approvals took, at the rate snapshotted on each inspection. */
  arising: number;
  /** What this month's piece-rate earnings could actually absorb. */
  applied: number;
  /** What is still to be recovered from later months. */
  owed: number;
};

/**
 * Month arithmetic that agrees exactly with `monthKey()`.
 *
 * `monthKey()` buckets on UTC (`toISOString()`), and Postgres `extract()` on these
 * `timestamp` columns returns the stored UTC value - verified against a literal
 * `2026-03-31 23:30:00`, which does not shift into April. Bucketing in SQL rather
 * than in JavaScript is what lets the carry-forward be computed from aggregates
 * instead of from every inspection row ever written.
 */
function monthIndexOf(key: string): number {
  const [y, m] = key.split("-").map(Number);
  return y * 12 + m;
}
function keyOfMonthIndex(index: number): string {
  const year = Math.floor((index - 1) / 12);
  const month = ((index - 1) % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}
const monthIndexOfColumn = (column: any) =>
  sql`(extract(year from ${column}) * 12 + extract(month from ${column}))`;
type SupportRow = { workerId: number; supportPieces: number; supportPiecework: number };

/** Stage piecework per worker for a month, in ONE grouped query. */
async function stagePiecework(from: Date, to: Date, workerId?: number): Promise<Map<number, PieceworkRow>> {
  const rows = await db
    .select({
      workerId: PAID_WORKER,
      pieces: sql<number>`coalesce(sum(${stageInspections.quantityApproved}), 0)`,
      piecework: PIECEWORK_SUM,
    })
    .from(stageInspections)
    .innerJoin(productionOperations, eq(productionOperations.id, stageInspections.productionOperationId))
    .innerJoin(workers, eq(workers.id, PAID_WORKER))
    .where(
      and(
        gte(stageInspections.inspectedAt, from),
        lt(stageInspections.inspectedAt, to),
        workerId === undefined ? undefined : eq(PAID_WORKER, workerId)
      )
    )
    .groupBy(PAID_WORKER);
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

/**
 * The carried-forward support deduction, month by month, for every worker.
 *
 * WHY A WALK IS NEEDED AT ALL
 *   A tailor's full piece rate belongs to the garment, and a helper's agreed rate
 *   is deducted from it. When the tailor approved no pieces of their own that month
 *   there is nothing for it to come out of yet - so the remainder is held and
 *   recovered from the first later month that has piece-rate earnings. It is never
 *   written off, and it never makes anybody's pay negative.
 *
 * WHAT THE DEDUCTION MAY COME OUT OF
 *   Piece-rate earnings only: production piecework plus any support piecework the
 *   worker earned themselves. Salary, overtime and other approved payments are
 *   left alone, because the rule is expressed against the tailor's PIECE RATE and
 *   carving a helper's rate out of a contracted monthly salary would be inventing a
 *   payroll rule Matesther does not have. A tailor on a pure salary therefore has
 *   no base, and what is owed to them simply stays owed and visible.
 *
 * HOW FAR BACK IT LOOKS
 *   To the first month any support work was ever inspected - a carry cannot predate
 *   the first deduction. Where there has never been any support work this issues one
 *   cheap `min()` and returns nothing, so the ordinary payroll path is unaffected.
 *   Every figure is derived from `support_inspections` and `stage_inspections`; there
 *   is no stored balance to drift out of step with them.
 */
async function deductionSchedule(
  endMonth: string,
  workerId?: number
): Promise<Map<number, Map<string, DeductionMonth>>> {
  const schedule = new Map<number, Map<string, DeductionMonth>>();
  const [firstRow] = await db
    .select({ first: sql<Date | null>`min(${supportInspections.inspectedAt})` })
    .from(supportInspections);
  const firstDate = firstRow?.first ? new Date(firstRow.first) : null;
  if (!firstDate || Number.isNaN(firstDate.getTime())) return schedule;

  const endIndex = monthIndexOf(endMonth);
  const startIndex = Math.min(monthIndexOf(monthKey(firstDate)), endIndex);
  if (startIndex > endIndex) return schedule;
  const { from } = monthBounds(keyOfMonthIndex(startIndex));
  const { to } = monthBounds(endMonth);
  const scope = workerId === undefined ? undefined : workerId;

  const supportMonth = monthIndexOfColumn(supportInspections.inspectedAt);
  const stageMonth = monthIndexOfColumn(stageInspections.inspectedAt);

  // Three grouped reads, each returning one row per worker per month rather than
  // one row per inspection: the piece-rate earnings a deduction may come out of
  // (production piecework, and support piecework the worker earned themselves), and
  // the deductions arising against the worker who handed the work out.
  const [stageBase, supportBase, arising] = await Promise.all([
    db
      .select({
        workerId: PAID_WORKER,
        monthIndex: stageMonth,
        amount: PIECEWORK_SUM,
      })
      .from(stageInspections)
      .innerJoin(productionOperations, eq(productionOperations.id, stageInspections.productionOperationId))
      .innerJoin(workers, eq(workers.id, productionOperations.workerId))
      .where(and(gte(stageInspections.inspectedAt, from), lt(stageInspections.inspectedAt, to),
        scope === undefined ? undefined : eq(PAID_WORKER, scope)))
      .groupBy(PAID_WORKER, stageMonth),
    db
      .select({
        workerId: supportAssignments.workerId,
        monthIndex: supportMonth,
        amount: SUPPORT_SUM,
      })
      .from(supportInspections)
      .innerJoin(supportAssignments, eq(supportAssignments.id, supportInspections.supportAssignmentId))
      .innerJoin(workers, eq(workers.id, supportAssignments.workerId))
      .where(and(gte(supportInspections.inspectedAt, from), lt(supportInspections.inspectedAt, to),
        scope === undefined ? undefined : eq(supportAssignments.workerId, scope)))
      .groupBy(supportAssignments.workerId, supportMonth),
    db
      .select({
        workerId: supportAssignments.assignedByWorkerId,
        monthIndex: supportMonth,
        pieces: sql<number>`coalesce(sum(${supportInspections.quantityApproved}), 0)`,
        amount: DEDUCTION_SUM,
      })
      .from(supportInspections)
      .innerJoin(supportAssignments, eq(supportAssignments.id, supportInspections.supportAssignmentId))
      .innerJoin(workers, eq(workers.id, supportAssignments.workerId))
      .innerJoin(supportTailor, eq(supportTailor.id, supportAssignments.assignedByWorkerId))
      .where(and(gte(supportInspections.inspectedAt, from), lt(supportInspections.inspectedAt, to),
        scope === undefined ? undefined : eq(supportAssignments.assignedByWorkerId, scope)))
      .groupBy(supportAssignments.assignedByWorkerId, supportMonth),
  ]);

  const base = new Map<number, Map<number, number>>();
  const addBase = (id: number, monthIndex: number, amount: number) => {
    const byMonth = base.get(id) ?? new Map<number, number>();
    byMonth.set(monthIndex, (byMonth.get(monthIndex) ?? 0) + amount);
    base.set(id, byMonth);
  };
  for (const row of stageBase) addBase(Number(row.workerId), Number(row.monthIndex), Number(row.amount) || 0);
  for (const row of supportBase) addBase(Number(row.workerId), Number(row.monthIndex), Number(row.amount) || 0);

  const arisingByWorker = new Map<number, Map<number, { pieces: number; amount: number }>>();
  for (const row of arising) {
    const id = Number(row.workerId);
    const byMonth = arisingByWorker.get(id) ?? new Map<number, { pieces: number; amount: number }>();
    byMonth.set(Number(row.monthIndex), {
      pieces: Number(row.pieces) || 0,
      amount: Number(row.amount) || 0,
    });
    arisingByWorker.set(id, byMonth);
  }

  // Walk every month from the first deduction to the one asked for, in order, so a
  // month with no activity still passes its carried balance along.
  for (const [id, byMonth] of arisingByWorker) {
    const months = new Map<string, DeductionMonth>();
    let owed = 0;
    for (let index = startIndex; index <= endIndex; index++) {
      const entry = byMonth.get(index);
      const arisingAmount = entry?.amount ?? 0;
      const pool = owed + arisingAmount;
      const available = Math.max(0, base.get(id)?.get(index) ?? 0);
      const applied = Math.min(pool, available);
      owed = pool - applied;
      if (arisingAmount !== 0 || applied !== 0 || owed !== 0) {
        months.set(keyOfMonthIndex(index), {
          piecesDelegated: entry?.pieces ?? 0,
          arising: arisingAmount,
          applied,
          owed,
        });
      }
    }
    schedule.set(id, months);
  }
  return schedule;
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
  extra: ExtraRow | undefined,
  delegated?: DeductionMonth
): WorkerAccrual {
  const rate = w.paymentRate ?? 0;
  const piecework = stage?.piecework ?? 0;
  const supportEarned = support?.supportPiecework ?? 0;
  const supportDeduction = delegated?.applied ?? 0;
  const salary = salaryFor(w, month);
  const overtime = extra?.overtime ?? 0;
  const other = extra?.other ?? 0;
  // The helper's rate comes OUT of the tailor's, so the two never both count.
  const due = piecework + supportEarned + salary + overtime + other - supportDeduction;
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
    supportPiecesDelegated: delegated?.piecesDelegated ?? 0,
    supportDeduction,
    supportDeductionArising: delegated?.arising ?? 0,
    supportDeductionOwed: delegated?.owed ?? 0,
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
  const [stage, support, delegated, paid, extra, roles] = await Promise.all([
    stagePiecework(from, to, workerId),
    supportPiecework(from, to, workerId),
    deductionSchedule(month, workerId),
    paidByWorker([month], workerId),
    extrasByWorker([month], workerId),
    rolesForWorker(workerId),
  ]);
  return assemble(
    w, month, roles, stage.get(workerId), support.get(workerId),
    paid.get(workerId) ?? 0, extra.get(workerId), delegated.get(workerId)?.get(month)
  );
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
  const [people, roleMap, stage, support, delegated, paid, extra] = await Promise.all([
    db.select().from(workers),
    rolesByWorker(),
    stagePiecework(from, to),
    supportPiecework(from, to),
    deductionSchedule(month),
    paidByWorker([month]),
    extrasByWorker([month]),
  ]);
  const rows = people
    .map((w) =>
      assemble(
        w, month, roleMap.get(w.id) ?? [], stage.get(w.id), support.get(w.id),
        paid.get(w.id) ?? 0, extra.get(w.id), delegated.get(w.id)?.get(month)
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
      supportDeduction: t.supportDeduction + r.supportDeduction,
      supportDeductionOwed: t.supportDeductionOwed + r.supportDeductionOwed,
      salary: t.salary + r.salary,
      overtime: t.overtime + r.overtime,
      other: t.other + r.other,
    }),
    {
      piecework: 0, supportPiecework: 0, supportDeduction: 0, supportDeductionOwed: 0,
      salary: 0, overtime: 0, other: 0,
    }
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
  const [stageRows, supportRows, extraRows, paymentRows, roles, delegated] = await Promise.all([
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
          // Their work either names them directly (a split stage) or predates split
          // allocation and is attributed through the stage's own worker.
          or(eq(stageInspections.workerId, workerId), and(isNull(stageInspections.workerId), eq(productionOperations.workerId, workerId))),
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
    // The other side of support work, carried forward across months exactly as the
    // single-month accrual does it - one implementation, so the twelve-month view
    // and the monthly payroll screen can never disagree about who owes what.
    deductionSchedule(months[months.length - 1], workerId),
  ]);
  const myDelegated = delegated.get(workerId);

  type HistoryBucket = {
    pieces: number; piecework: number; supportPieces: number; supportPiecework: number;
    overtime: number; other: number; paid: number;
  };
  const emptyBucket = (): HistoryBucket => ({
    pieces: 0, piecework: 0, supportPieces: 0, supportPiecework: 0,
    overtime: 0, other: 0, paid: 0,
  });
  const bucket = new Map<string, HistoryBucket>();
  const ensure = (key: string) => {
    const found = bucket.get(key);
    if (found) return found;
    const fresh = emptyBucket();
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
    const entry = bucket.get(m) ?? emptyBucket();
    const salary = salaryFor(w, m);
    const delegatedMonth = myDelegated?.get(m);
    const supportDeduction = delegatedMonth?.applied ?? 0;
    const due =
      entry.piecework + entry.supportPiecework + salary + entry.overtime + entry.other - supportDeduction;
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
      supportPiecesDelegated: delegatedMonth?.piecesDelegated ?? 0,
      supportDeduction,
      supportDeductionArising: delegatedMonth?.arising ?? 0,
      supportDeductionOwed: delegatedMonth?.owed ?? 0,
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
