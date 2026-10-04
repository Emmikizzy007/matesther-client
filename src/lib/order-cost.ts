import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
  expenses,
  externalWorkOrders,
  materialPurchases,
  materials,
  materialUsage,
  orders,
  productionBatches,
  productionOperations,
  stageInspections,
  supportAssignments,
  supportInspections,
  workers,
} from "@/db/schema";
import { EXPENSE_CATEGORIES, READY_MADE_CATEGORY, sameRole } from "@/lib/format";

/**
 * What an order actually cost, split into the categories Matesther runs on.
 *
 * WHY THIS EXISTS
 *   Profitability used to be `revenue - (material_usage + expenses)`. That counted no
 *   labour at all, so every order looked far more profitable than it was, and it put
 *   hand-entered "Materials" and "Labour" expense rows next to the computed figures
 *   for the same things. This is the same order, costed properly, from records the
 *   system already keeps. Nothing here is a second cost system: every line reads a
 *   table that already exists, and no figure can be typed in by hand.
 *
 * THE NINE CATEGORIES, AND WHERE EACH COMES FROM
 *   readyMade      material_purchases for a material in the "Ready-made garment"
 *                  category. Buying a finished uniform is a PURCHASE. It is never
 *                  tailor labour, and it never creates a worker_payments row.
 *   materials      material_usage.total_cost - fabric and trim consumed on the order.
 *   internalLabour approved stage inspections on stages produced INTERNALLY, at the
 *                  rate snapshotted when the work was approved.
 *   machineLabour  the same, on stages produced by MACHINE. Matesther's own machine
 *                  work is in-house, so it is labour, not a vendor bill.
 *   supportLabour  what support work ADDS to the order's labour cost, which is normally
 *                  zero. See below - this is an internal allocation, not a second cost.
 *   outsourced     external_work_orders.total_cost - OUTSOURCED and VENDOR_PROCESSING.
 *                  A vendor is not a worker and never appears in payroll.
 *   packaging      expenses categorised "Packaging".
 *   delivery       expenses categorised "Transportation".
 *   other          every remaining expense category (Electricity, Repairs, Other).
 *
 * SUPPORT LABOUR IS AN INTERNAL ALLOCATION OF ONE COST, NOT A SECOND COST
 *   Matesther pays the support worker directly - that money really leaves the business.
 *   But it is not an ADDITIONAL labour cost on top of the tailor's commission, because
 *   it comes out of that commission for the very same approved pieces.
 *
 *     Tailor rate 300 x 100 approved pieces  = 30,000 gross commission
 *     18 of those pieces delegated at 30     =    540 paid to the support worker
 *     Tailor's commission after deduction    = 29,460
 *     Total internal labour cost             = 30,000   (NOT 30,540)
 *
 *   So `internalLabour` above is the tailor's GROSS commission, which already contains
 *   the delegated pieces at their full rate, and `supportLabour` is what support work
 *   adds on top of that - the helper's payment less the deduction it caused, which
 *   cancels to zero. Counting the helper's pay as well would double-count the same
 *   labour. The two sides are reported separately as `supportGrossPaid` and
 *   `supportDeductedFromTailors` so the allocation is visible instead of hidden behind
 *   a zero, and payroll shows both the payment to the helper and the deduction from
 *   the tailor.
 *
 *   Where the tailor has no piece rate to deduct from - a tailor paid a flat monthly
 *   salary - no deduction arises and the helper's pay correctly stands alone as a real
 *   extra cost, because there is no gross commission for it to be part of.
 *
 * WHAT IS DELIBERATELY NOT COUNTED
 *   Hand-entered expense rows in the "Materials" and "Labour" categories overlap the
 *   computed figures above, so they are excluded from cost and reported separately as
 *   `superseded`. They are not deleted and not hidden - they are simply no longer
 *   added on top of a computed number for the same thing.
 *
 *   Salaries are not attributable to a single order. A monthly-paid machinist or
 *   security guard is a business cost, not an order cost, and there is no rule in
 *   Matesther for spreading one across orders - so none is invented here. Order
 *   profit is therefore profit against DIRECT cost. `business` in the report carries
 *   the unattributable total so the two are never confused.
 */
export type OrderCosts = {
  revenue: number;
  readyMade: number;
  materials: number;
  internalLabour: number;
  machineLabour: number;
  /**
   * What support work ADDS to labour cost: the helper's approved payment less the
   * deduction it caused in the tailor's commission. Zero in the ordinary case.
   */
  supportLabour: number;
  /** The cash Matesther pays support workers on this order, on approved pieces only. */
  supportGrossPaid: number;
  /** What that same money took back out of the tailors' gross commission. */
  supportDeductedFromTailors: number;
  outsourced: number;
  packaging: number;
  delivery: number;
  other: number;
  /** Hand-entered expenses that the computed figures now cover. Not in totalCost. */
  supersededMaterials: number;
  supersededLabour: number;
  totalCost: number;
  profit: number;
  margin: number;
  /** The figure the old formula produced, kept visible beside the new one. */
  legacy: { totalCost: number; profit: number; margin: number };
};

const EMPTY_COSTS: Omit<OrderCosts, "revenue" | "margin" | "legacy"> = {
  readyMade: 0,
  materials: 0,
  internalLabour: 0,
  machineLabour: 0,
  supportLabour: 0,
  supportGrossPaid: 0,
  supportDeductedFromTailors: 0,
  outsourced: 0,
  packaging: 0,
  delivery: 0,
  other: 0,
  supersededMaterials: 0,
  supersededLabour: 0,
  totalCost: 0,
  profit: 0,
};
void EMPTY_COSTS;

/** Expense categories that describe something the computed cost lines already cover. */
const SUPERSEDED_MATERIALS = "Materials";
const SUPERSEDED_LABOUR = "Labour";
const PACKAGING_CATEGORY = "Packaging";
const DELIVERY_CATEGORY = "Transportation";

/** Which expense category an order cost line owns. */
export function expenseCostLine(category: string): "packaging" | "delivery" | "other" | "superseded" {
  if (sameRole(category, PACKAGING_CATEGORY)) return "packaging";
  if (sameRole(category, DELIVERY_CATEGORY)) return "delivery";
  if (sameRole(category, SUPERSEDED_MATERIALS)) return "superseded";
  if (sameRole(category, SUPERSEDED_LABOUR)) return "superseded";
  return "other";
}

/** Every category the expenses screen offers, so nothing is silently unclassified. */
export function classifyAllExpenseCategories(): Record<string, ReturnType<typeof expenseCostLine>> {
  const out: Record<string, ReturnType<typeof expenseCostLine>> = {};
  for (const category of EXPENSE_CATEGORIES) out[category] = expenseCostLine(category);
  return out;
}

/**
 * Support work touches TWO workers at once: the helper who did it and the tailor whose
 * rate it came out of. Aliasing keeps the two joins distinct in one query.
 */
const helpers = alias(workers, "support_cost_helper");
const tailors = alias(workers, "support_cost_tailor");

/**
 * The rate an approved inspection paid at, as SQL.
 *
 * Identical precedence to `lib/job-pay.ts` and to payroll: the rate snapshotted on the
 * inspection, else the job's agreed rate, else the worker's legacy profile rate, and
 * only for people paid per piece. Counting approved pieces only is what keeps order
 * cost consistent with what payroll actually pays out.
 */
const stageEarnings = sql`case when ${workers.paymentType} = 'PER_PIECE' then ${stageInspections.quantityApproved} * coalesce(${stageInspections.pieceRate}, ${productionOperations.pieceRate}, ${workers.paymentRate}) else 0 end`;

/** A helper's approved support earnings, and the deduction it causes. */
const supportEarnings = sql`case when ${helpers.paymentType} = 'PER_PIECE' then ${supportInspections.quantityApproved} * coalesce(${supportInspections.pieceRate}, ${supportAssignments.pieceRate}, ${helpers.paymentRate}) else 0 end`;

/**
 * The deduction an approved support inspection causes, gated on the tailor who handed
 * the work out actually HAVING a piece rate. A monthly-paid tailor has nothing for a
 * helper's rate to come out of, so no deduction arises and the helper's pay remains a
 * genuine extra cost of the order.
 */
const supportDeduction = sql`case when ${tailors.paymentType} = 'PER_PIECE' and ${helpers.paymentType} = 'PER_PIECE' then ${supportInspections.quantityApproved} * coalesce(${supportInspections.pieceRate}, ${supportAssignments.pieceRate}, ${helpers.paymentRate}) else 0 end`;

type CostAccumulator = {
  readyMade: number;
  materials: number;
  internalLabour: number;
  machineLabour: number;
  supportLabour: number;
  supportGrossPaid: number;
  supportDeductedFromTailors: number;
  outsourced: number;
  packaging: number;
  delivery: number;
  other: number;
  supersededMaterials: number;
  supersededLabour: number;
  /** The old formula's inputs, so the two figures can be shown side by side. */
  legacyUsage: number;
  legacyExpenses: number;
};

const newAccumulator = (): CostAccumulator => ({
  readyMade: 0,
  materials: 0,
  internalLabour: 0,
  machineLabour: 0,
  supportLabour: 0,
  supportGrossPaid: 0,
  supportDeductedFromTailors: 0,
  outsourced: 0,
  packaging: 0,
  delivery: 0,
  other: 0,
  supersededMaterials: 0,
  supersededLabour: 0,
  legacyUsage: 0,
  legacyExpenses: 0,
});

function round(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function marginFor(revenue: number, profit: number): number {
  return revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0;
}

function finalise(revenue: number, c: CostAccumulator): OrderCosts {
  // Support labour is already net of the deduction by the time it lands here.
  const totalCost = round(
    c.readyMade + c.materials + c.internalLabour + c.machineLabour + c.supportLabour +
    c.outsourced + c.packaging + c.delivery + c.other
  );
  const legacyTotalCost = round(c.legacyUsage + c.legacyExpenses);
  const profit = round(revenue - totalCost);
  const legacyProfit = round(revenue - legacyTotalCost);
  return {
    revenue: round(revenue),
    readyMade: round(c.readyMade),
    materials: round(c.materials),
    internalLabour: round(c.internalLabour),
    machineLabour: round(c.machineLabour),
    supportLabour: round(c.supportLabour),
    supportGrossPaid: round(c.supportGrossPaid),
    supportDeductedFromTailors: round(c.supportDeductedFromTailors),
    outsourced: round(c.outsourced),
    packaging: round(c.packaging),
    delivery: round(c.delivery),
    other: round(c.other),
    supersededMaterials: round(c.supersededMaterials),
    supersededLabour: round(c.supersededLabour),
    totalCost,
    profit,
    margin: marginFor(revenue, profit),
    legacy: {
      totalCost: legacyTotalCost,
      profit: legacyProfit,
      margin: marginFor(revenue, legacyProfit),
    },
  };
}

/**
 * Cost every order in one pass.
 *
 * Six grouped statements, each returning one row per order rather than one row per
 * inspection, usage record or expense - so costing the whole order book is the same
 * handful of queries whether there are ten orders or ten thousand. Pass `orderIds` to
 * cost a page of orders; omit it to cost the book.
 *
 * A record reaches an order either directly (`order_id`) or through the production work
 * it belongs to (operation -> batch -> order), because support work and ready-made
 * purchases recorded against a stage job do not always carry the order id themselves.
 * Both routes are followed, and neither can make a record count twice: each query
 * groups its own table once.
 */
export async function orderCosts(orderIds?: number[]): Promise<Map<number, OrderCosts>> {
  const accumulators = new Map<number, CostAccumulator>();
  const get = (orderId: number) => {
    const found = accumulators.get(orderId);
    if (found) return found;
    const fresh = newAccumulator();
    accumulators.set(orderId, fresh);
    return fresh;
  };
  const scope = orderIds && orderIds.length ? orderIds : null;
  if (orderIds && !orderIds.length) return new Map();

  /* ---- 1. orders: revenue, and the legacy formula's shape ---- */
  const orderRows = await db
    .select({ id: orders.id, totalAmount: orders.totalAmount })
    .from(orders)
    .where(scope ? inArray(orders.id, scope) : undefined);
  const revenueById = new Map<number, number>(
    orderRows.map((row) => [row.id, Number(row.totalAmount) || 0])
  );

  /* ---- 2. material consumed on the order ---- */
  const usageRows = await db
    .select({
      orderId: materialUsage.orderId,
      readyMade: sql<number>`coalesce(sum(case when ${materials.category} = ${READY_MADE_CATEGORY} then coalesce(${materialUsage.totalCost}, 0) else 0 end), 0)`,
      materials: sql<number>`coalesce(sum(case when coalesce(${materials.category}, '') <> ${READY_MADE_CATEGORY} then coalesce(${materialUsage.totalCost}, 0) else 0 end), 0)`,
      allUsage: sql<number>`coalesce(sum(coalesce(${materialUsage.totalCost}, 0)), 0)`,
    })
    .from(materialUsage)
    .leftJoin(materials, eq(materials.id, materialUsage.materialId))
    .where(and(isNotNull(materialUsage.orderId), scope ? inArray(materialUsage.orderId, scope) : undefined))
    .groupBy(materialUsage.orderId);
  for (const row of usageRows) {
    const orderId = Number(row.orderId);
    if (!orderId) continue;
    const c = get(orderId);
    c.materials += Number(row.materials) || 0;
    // A ready-made garment consumed straight onto an order is still a purchase of a
    // finished good, so it belongs in the ready-made line whichever table holds it.
    c.readyMade += Number(row.readyMade) || 0;
    c.legacyUsage += Number(row.allUsage) || 0;
  }

  /* ---- 3. ready-made garments bought for the order ---- */
  const purchaseRows = await db
    .select({
      orderId: sql<number>`coalesce(${materialPurchases.orderId}, ${productionBatches.orderId})`,
      readyMade: sql<number>`coalesce(sum(case when ${materials.category} = ${READY_MADE_CATEGORY} then coalesce(${materialPurchases.totalCost}, 0) else 0 end), 0)`,
    })
    .from(materialPurchases)
    .leftJoin(materials, eq(materials.id, materialPurchases.materialId))
    .leftJoin(productionOperations, eq(productionOperations.id, materialPurchases.productionOperationId))
    .leftJoin(productionBatches, eq(productionBatches.id, productionOperations.productionBatchId))
    .where(
      and(
        or(isNotNull(materialPurchases.orderId), isNotNull(productionBatches.orderId)),
        scope
          ? or(inArray(materialPurchases.orderId, scope), inArray(productionBatches.orderId, scope))
          : undefined
      )
    )
    .groupBy(sql`coalesce(${materialPurchases.orderId}, ${productionBatches.orderId})`);
  for (const row of purchaseRows) {
    const orderId = Number(row.orderId);
    if (!orderId) continue;
    const c = get(orderId);
    // The legacy formula never counted purchases at all, which is why ready-made
    // buying was invisible in order profit until now.
    c.readyMade += Number(row.readyMade) || 0;
  }

  /* ---- 4. labour: approved stage work, split by how the stage is produced ---- */
  const labourRows = await db
    .select({
      orderId: productionBatches.orderId,
      internal: sql<number>`coalesce(sum(case when coalesce(${productionOperations.method}, 'INTERNAL') not in ('MACHINE', 'OUTSOURCED', 'VENDOR_PROCESSING', 'READY_MADE') then ${stageEarnings} else 0 end), 0)`,
      machine: sql<number>`coalesce(sum(case when ${productionOperations.method} = 'MACHINE' then ${stageEarnings} else 0 end), 0)`,
    })
    .from(stageInspections)
    .innerJoin(productionOperations, eq(productionOperations.id, stageInspections.productionOperationId))
    .innerJoin(productionBatches, eq(productionBatches.id, productionOperations.productionBatchId))
    // The pieces belong to whoever the inspection was attributed to; where a stage was
    // never split that is the stage's own worker, exactly as payroll resolves it.
    .innerJoin(workers, eq(workers.id, sql`coalesce(${stageInspections.workerId}, ${productionOperations.workerId})`))
    .where(and(isNotNull(productionBatches.orderId), scope ? inArray(productionBatches.orderId, scope) : undefined))
    .groupBy(productionBatches.orderId);
  for (const row of labourRows) {
    const orderId = Number(row.orderId);
    if (!orderId) continue;
    const c = get(orderId);
    c.internalLabour += Number(row.internal) || 0;
    c.machineLabour += Number(row.machine) || 0;
  }

  /* ---- 5. support labour, net of the deduction it causes ---- */
  const supportRows = await db
    .select({
      orderId: sql<number>`coalesce(${supportAssignments.orderId}, ${productionBatches.orderId})`,
      earned: sql<number>`coalesce(sum(${supportEarnings}), 0)`,
      deducted: sql<number>`coalesce(sum(${supportDeduction}), 0)`,
    })
    .from(supportInspections)
    .innerJoin(supportAssignments, eq(supportAssignments.id, supportInspections.supportAssignmentId))
    .innerJoin(helpers, eq(helpers.id, supportAssignments.workerId))
    .innerJoin(tailors, eq(tailors.id, supportAssignments.assignedByWorkerId))
    .leftJoin(productionOperations, eq(productionOperations.id, supportAssignments.productionOperationId))
    .leftJoin(productionBatches, eq(productionBatches.id, productionOperations.productionBatchId))
    .where(
      and(
        or(isNotNull(supportAssignments.orderId), isNotNull(productionBatches.orderId)),
        scope
          ? or(inArray(supportAssignments.orderId, scope), inArray(productionBatches.orderId, scope))
          : undefined
      )
    )
    .groupBy(sql`coalesce(${supportAssignments.orderId}, ${productionBatches.orderId})`);
  for (const row of supportRows) {
    const orderId = Number(row.orderId);
    if (!orderId) continue;
    const c = get(orderId);
    const earned = Number(row.earned) || 0;
    const deducted = Number(row.deducted) || 0;
    // Both sides of one movement of money, reported so the allocation is visible.
    c.supportGrossPaid += earned;
    c.supportDeductedFromTailors += deducted;
    // What the helper earned, less what came back out of the tailor's gross commission.
    // Cancels to zero whenever the tailor is paid per piece, which is the point: the
    // garment's labour cost is the piece rate once, however the work was divided.
    c.supportLabour += earned - deducted;
  }

  /* ---- 6. outsourced and vendor processing ---- */
  const externalRows = await db
    .select({
      orderId: productionBatches.orderId,
      outsourced: sql<number>`coalesce(sum(coalesce(${externalWorkOrders.totalCost}, 0)), 0)`,
    })
    .from(externalWorkOrders)
    .innerJoin(productionBatches, eq(productionBatches.id, externalWorkOrders.productionBatchId))
    .where(and(isNotNull(productionBatches.orderId), scope ? inArray(productionBatches.orderId, scope) : undefined))
    .groupBy(productionBatches.orderId);
  for (const row of externalRows) {
    const orderId = Number(row.orderId);
    if (!orderId) continue;
    get(orderId).outsourced += Number(row.outsourced) || 0;
  }

  /* ---- 7. expenses, by the category that owns them ---- */
  const expenseRows = await db
    .select({
      orderId: expenses.orderId,
      category: expenses.category,
      amount: sql<number>`coalesce(sum(coalesce(${expenses.amount}, 0)), 0)`,
    })
    .from(expenses)
    .where(and(isNotNull(expenses.orderId), scope ? inArray(expenses.orderId, scope) : undefined))
    .groupBy(expenses.orderId, expenses.category);
  for (const row of expenseRows) {
    const orderId = Number(row.orderId);
    if (!orderId) continue;
    const c = get(orderId);
    const amount = Number(row.amount) || 0;
    c.legacyExpenses += amount;
    const line = expenseCostLine(row.category ?? "");
    if (line === "packaging") c.packaging += amount;
    else if (line === "delivery") c.delivery += amount;
    else if (line === "other") c.other += amount;
    else if (sameRole(row.category ?? "", SUPERSEDED_MATERIALS)) c.supersededMaterials += amount;
    else c.supersededLabour += amount;
  }

  /* ---- assemble, for every order asked about ---- */
  const result = new Map<number, OrderCosts>();
  for (const [orderId, revenue] of revenueById) {
    result.set(orderId, finalise(revenue, accumulators.get(orderId) ?? newAccumulator()));
  }
  return result;
}

/** Cost one order. Convenience wrapper over `orderCosts()`. */
export async function orderCost(orderId: number): Promise<OrderCosts> {
  const all = await orderCosts([orderId]);
  return all.get(orderId) ?? finalise(0, newAccumulator());
}

/** The empty breakdown, for an order that has nothing recorded against it yet. */
export function emptyOrderCosts(revenue = 0): OrderCosts {
  return finalise(revenue, newAccumulator());
}

/**
 * Business-wide costs that no single order can carry.
 *
 * Reported next to order profit so that "profit" on an order is never mistaken for the
 * whole business's profit: salaries, and expenses recorded with no order against them,
 * are real costs that belong here and nowhere else.
 */
/** `expenses.expense_date` is a DATE column, so it is bounded with 'YYYY-MM-DD' strings. */
export async function unattributableCosts(fromDay?: string, toDay?: string) {
  const expenseWindow = fromDay && toDay
    ? sql`${expenses.expenseDate} >= ${fromDay} and ${expenses.expenseDate} < ${toDay}`
    : undefined;
  const [expenseRows] = await db
    .select({
      total: sql<number>`coalesce(sum(coalesce(${expenses.amount}, 0)), 0)`,
    })
    .from(expenses)
    .where(and(isNull(expenses.orderId), expenseWindow));
  const [salaryRows] = await db
    .select({
      total: sql<number>`coalesce(sum(${workers.paymentRate}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(workers)
    .where(and(eq(workers.paymentType, "MONTHLY"), eq(workers.status, "ACTIVE")));
  return {
    /** Monthly salary commitment, i.e. one month of it. */
    monthlySalaries: Number(salaryRows?.total) || 0,
    salariedStaff: Number(salaryRows?.count) || 0,
    /** Expenses recorded against the business rather than an order. */
    unattributedExpenses: Number(expenseRows?.total) || 0,
  };
}

/** Category labels for the cost panel, in the order they should be read. */
export const COST_LINES: { key: keyof OrderCosts; label: string }[] = [
  { key: "readyMade", label: "Ready-made garments" },
  { key: "materials", label: "Raw materials" },
  { key: "internalLabour", label: "Internal labour" },
  { key: "machineLabour", label: "Machine labour" },
  { key: "supportLabour", label: "Support labour added (net of the tailor deduction)" },
  { key: "outsourced", label: "Outsourced / vendor" },
  { key: "packaging", label: "Packaging" },
  { key: "delivery", label: "Delivery" },
  { key: "other", label: "Other expenses" },
];
