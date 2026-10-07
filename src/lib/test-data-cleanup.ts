import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  customers,
  deliveries,
  deliveryLines,
  expenses,
  externalWorkOrders,
  materialPurchases,
  materials,
  materialUsage,
  orderDeletions,
  orderItems,
  orderItemSizes,
  orders,
  packingRecords,
  payments,
  productionAllocations,
  productionBatches,
  productionMovements,
  productionOperations,
  qualityChecks,
  reworkRecords,
  stageInspections,
  supportAssignments,
  supportInspections,
  supportStatusEvents,
  testDataPurges,
  workerPayments,
  workers,
} from "@/db/schema";
import { isReadyMadeMaterial } from "@/lib/format";
import { monthKey } from "@/lib/payroll";

/**
 * ADMINISTRATIVE TEST-DATA CLEANUP.
 *
 * THE PROBLEM THIS SOLVES
 *   Matesther goes into real operation with a database that already contains orders
 *   created while the system was being tested. Those test orders cannot be removed
 *   through the ordinary order screen, and that is CORRECT: an order with approved
 *   production and settled money behind it must not be deletable by a click, because
 *   the same click on a real order would destroy a factory's records.
 *
 *   So this is a separate, deliberately narrow administrative act - not a more
 *   permissive delete. It is Owner-only, it targets exactly one order, it demands the
 *   school's name be typed back, it shows precisely what will go before anything goes,
 *   and it refuses to run if the world moved between the preview and the execution.
 *
 * WHAT IT IS NOT
 *   It is NOT a way to bypass the production and payroll protections. Those protections
 *   exist to stop a mistake; this exists to undo test data with a written account of it.
 *   The difference is enforced rather than assumed: every purge is recorded permanently
 *   in `test_data_purges` with who ran it, what they typed, what the preview promised
 *   and what was actually removed. An act that strong has to leave an audit, or "the
 *   test order was removed" and "a real order was removed" become the same sentence.
 *
 * WHAT IT NEVER TOUCHES
 *   Shared master data survives every purge: the school, the garments, the workers, the
 *   route definitions, the material master records and the organisation. Only rows that
 *   belong to THIS order are removed. A worker keeps their profile and their other
 *   earnings; a material keeps its record; a school keeps its record and its other
 *   orders.
 */

/** Accepts the db handle or a transaction handle, like the other lib modules. */
type Db = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** What a preview counted, per table. */
export type PurgeCounts = Record<string, number>;

export type PurgePreview = {
  orderId: number;
  orderNumber: string;
  customerId: number | null;
  customerName: string | null;
  totalAmount: number;
  amountPaid: number;
  counts: PurgeCounts;
  /**
   * A digest of the EXACT record ids that will be removed.
   *
   * This is the whole anti-staleness control. The caller must present it back when
   * executing, and it is recomputed at that moment from the live database: if anything
   * was added, removed or changed in between, the digest differs and the purge is
   * refused with a demand for a fresh preview. A confirmation therefore authorises one
   * specific set of rows and nothing else - it cannot be replayed later against a
   * different one, which is what makes it effectively single-use without needing to
   * store a token that a serverless function would not keep between requests.
   */
  fingerprint: string;
  /** Money already settled that this order contributed to. Reported, never rewritten. */
  payroll: PayrollImpact;
  /** Inventory movements this order made, and whether each can be safely reversed. */
  inventory: InventoryImpact;
  /** Anything that makes the purge unsafe to run, and must be resolved first. */
  blockers: string[];
};

export type PayrollImpact = {
  /**
   * Worker payments already recorded for a month this order's approved work contributed
   * to. These are NOT deleted and NOT edited.
   *
   * WHY NOT
   *   `worker_payments` has no order column, because payroll is a monthly settlement per
   *   person across everything they did that month - one row can cover three orders. So
   *   there is no honest way to remove "the part of this payment that came from this
   *   order": the money has left the building, and quietly rewriting a settled payroll
   *   row would make the bank sheet disagree with the bank.
   *
   *   What the purge DOES do is remove the earnings' SOURCE - the approved inspections
   *   behind this order - so the accrual disappears and the payroll screen recomputes
   *   without it. Any month already settled is reported here with the amount that came
   *   from this order, so the Owner can raise a correcting entry through the normal
   *   payroll route with the real figures in front of them.
   */
  settledPayments: {
    paymentId: number;
    workerId: number;
    workerName: string;
    periodMonth: string;
    paidAmount: number;
    /** What this order contributed to that month, before it is removed. */
    fromThisOrder: number;
    supportFromThisOrder: number;
  }[];
  totalSettled: number;
  /** Months whose accrual will change once this order's inspections are removed. */
  affectedMonths: string[];
};

export type InventoryImpact = {
  /** Raw-material stock that will be put back, because the issue is being removed. */
  restock: { materialId: number; materialName: string; quantity: number; unit: string }[];
  /** Purchases being removed that added stock, and the stock that will be taken back off. */
  despurchase: { materialId: number; materialName: string; quantity: number; unit: string }[];
  /** Ready-made purchases: cost records only, with no stock effect in either direction. */
  readyMade: { materialId: number; materialName: string; quantity: number }[];
  /**
   * A stock movement that cannot be undone without risking a wrong figure. When this is
   * non-empty the purge REFUSES to run, because guessing at inventory is how a business
   * loses track of what it owns - and the requirement is explicit that an unsafe
   * reversal must stop and report rather than silently corrupt the shelf.
   */
  unsafe: string[];
};

/** Compare names the way a person typing a confirmation would expect. */
function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

/** A stable digest of a set of ids, so the same set always produces the same token. */
function fingerprintOf(orderId: number, idsByTable: Record<string, number[]>): string {
  const canonical = Object.keys(idsByTable)
    .sort()
    .map((table) => `${table}=${[...idsByTable[table]].sort((a, b) => a - b).join(",")}`)
    .join("|");
  return createHash("sha256").update(`${orderId}::${canonical}`).digest("hex");
}

/**
 * Everything this order owns, by id.
 *
 * One pass, one query per table, all of them keyed by an indexed column - never a
 * full-table read. The ids are collected BEFORE anything is deleted because the
 * fingerprint has to describe the exact rows, and because some of them (support work,
 * in particular) are reachable from more than one direction and must not be counted
 * twice or missed.
 */
async function collectScope(handle: Db, orderId: number) {
  const itemRows = await handle.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, orderId));
  const itemIds = itemRows.map((row) => row.id);
  const variantRows = itemIds.length
    ? await handle.select({ id: orderItemSizes.id }).from(orderItemSizes).where(inArray(orderItemSizes.orderItemId, itemIds))
    : [];
  // A variant can also be named directly by material purchases and usage, so the set is
  // the union of both directions rather than only the one through the order's items.
  const directVariants = await handle
    .select({ orderVariantId: materialUsage.orderVariantId })
    .from(materialUsage)
    .where(eq(materialUsage.orderId, orderId));
  const variantIds = [...new Set([
    ...variantRows.map((row) => row.id),
    ...directVariants.map((row) => row.orderVariantId).filter((v): v is number => v !== null),
  ])];

  const batchRows = await handle.select({ id: productionBatches.id }).from(productionBatches).where(eq(productionBatches.orderId, orderId));
  const batchIds = batchRows.map((row) => row.id);
  const opRows = batchIds.length
    ? await handle.select({ id: productionOperations.id }).from(productionOperations).where(inArray(productionOperations.productionBatchId, batchIds))
    : [];
  const operationIds = opRows.map((row) => row.id);

  const [allocRows, movementRows, inspectionRows, qualityRows, reworkRows, externalRows] = await Promise.all([
    operationIds.length
      ? handle.select({ id: productionAllocations.id }).from(productionAllocations).where(inArray(productionAllocations.productionOperationId, operationIds))
      : Promise.resolve([] as { id: number }[]),
    operationIds.length
      ? handle.select({ id: productionMovements.id }).from(productionMovements).where(inArray(productionMovements.productionOperationId, operationIds))
      : Promise.resolve([] as { id: number }[]),
    operationIds.length
      ? handle.select({ id: stageInspections.id }).from(stageInspections).where(inArray(stageInspections.productionOperationId, operationIds))
      : Promise.resolve([] as { id: number }[]),
    operationIds.length
      ? handle.select({ id: qualityChecks.id }).from(qualityChecks).where(inArray(qualityChecks.productionOperationId, operationIds))
      : Promise.resolve([] as { id: number }[]),
    operationIds.length
      ? handle.select({ id: reworkRecords.id }).from(reworkRecords).where(inArray(reworkRecords.productionOperationId, operationIds))
      : Promise.resolve([] as { id: number }[]),
    operationIds.length
      ? handle.select({ id: externalWorkOrders.id }).from(externalWorkOrders).where(inArray(externalWorkOrders.productionOperationId, operationIds))
      : Promise.resolve([] as { id: number }[]),
  ]);

  /**
   * Support work is reached BOTH ways, and both are needed.
   *
   * `support_assignments.order_id` is `on delete set null`, so deleting the order would
   * NOT remove these rows - it would orphan them, leaving a helper's earnings attached
   * to nothing. And a hand-over recorded against a share rather than a stage job may
   * carry the order id but must still be found through its parent operation. Taking the
   * union of the two is what guarantees neither an orphan nor a survivor.
   */
  const [supportByOrder, supportByOperation] = await Promise.all([
    handle.select({ id: supportAssignments.id }).from(supportAssignments).where(eq(supportAssignments.orderId, orderId)),
    operationIds.length
      ? handle.select({ id: supportAssignments.id }).from(supportAssignments).where(inArray(supportAssignments.productionOperationId, operationIds))
      : Promise.resolve([] as { id: number }[]),
  ]);
  const supportIds = [...new Set([...supportByOrder, ...supportByOperation].map((row) => row.id))];
  const supportInspectionRows = supportIds.length
    ? await handle.select({ id: supportInspections.id }).from(supportInspections).where(inArray(supportInspections.supportAssignmentId, supportIds))
    : [];
  const supportEventRows = supportIds.length
    ? await handle.select({ id: supportStatusEvents.id }).from(supportStatusEvents).where(inArray(supportStatusEvents.supportAssignmentId, supportIds))
    : [];

  const [purchaseRows, usageRows, expenseRows, paymentRows, packingRows, deliveryRows] = await Promise.all([
    handle.select({ id: materialPurchases.id }).from(materialPurchases).where(eq(materialPurchases.orderId, orderId)),
    handle.select({ id: materialUsage.id }).from(materialUsage).where(eq(materialUsage.orderId, orderId)),
    handle.select({ id: expenses.id }).from(expenses).where(eq(expenses.orderId, orderId)),
    handle.select({ id: payments.id }).from(payments).where(eq(payments.orderId, orderId)),
    handle.select({ id: packingRecords.id }).from(packingRecords).where(eq(packingRecords.orderId, orderId)),
    handle.select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.orderId, orderId)),
  ]);

  return {
    itemIds,
    variantIds,
    batchIds,
    operationIds,
    allocationIds: allocRows.map((row) => row.id),
    movementIds: movementRows.map((row) => row.id),
    inspectionIds: inspectionRows.map((row) => row.id),
    qualityIds: qualityRows.map((row) => row.id),
    reworkIds: reworkRows.map((row) => row.id),
    externalIds: externalRows.map((row) => row.id),
    supportIds,
    supportInspectionIds: supportInspectionRows.map((row) => row.id),
    supportEventIds: supportEventRows.map((row) => row.id),
    purchaseIds: purchaseRows.map((row) => row.id),
    usageIds: usageRows.map((row) => row.id),
    expenseIds: expenseRows.map((row) => row.id),
    paymentIds: paymentRows.map((row) => row.id),
    packingIds: packingRows.map((row) => row.id),
    deliveryIds: deliveryRows.map((row) => row.id),
  };
}

type Scope = Awaited<ReturnType<typeof collectScope>>;

/** The counts a preview reports, in a fixed order so two previews are comparable. */
function countsOf(scope: Scope, deliveryLineCount: number): PurgeCounts {
  return {
    orders: 1,
    order_items: scope.itemIds.length,
    order_item_sizes: scope.variantIds.length,
    production_batches: scope.batchIds.length,
    production_operations: scope.operationIds.length,
    production_allocations: scope.allocationIds.length,
    production_movements: scope.movementIds.length,
    stage_inspections: scope.inspectionIds.length,
    quality_checks: scope.qualityIds.length,
    rework_records: scope.reworkIds.length,
    external_work_orders: scope.externalIds.length,
    support_assignments: scope.supportIds.length,
    support_inspections: scope.supportInspectionIds.length,
    support_status_events: scope.supportEventIds.length,
    material_purchases: scope.purchaseIds.length,
    material_usage: scope.usageIds.length,
    expenses: scope.expenseIds.length,
    payments: scope.paymentIds.length,
    packing_records: scope.packingIds.length,
    deliveries: scope.deliveryIds.length,
    delivery_lines: deliveryLineCount,
  };
}

function idsByTableOf(scope: Scope): Record<string, number[]> {
  return {
    order_items: scope.itemIds,
    order_item_sizes: scope.variantIds,
    production_batches: scope.batchIds,
    production_operations: scope.operationIds,
    production_allocations: scope.allocationIds,
    production_movements: scope.movementIds,
    stage_inspections: scope.inspectionIds,
    quality_checks: scope.qualityIds,
    rework_records: scope.reworkIds,
    external_work_orders: scope.externalIds,
    support_assignments: scope.supportIds,
    support_inspections: scope.supportInspectionIds,
    support_status_events: scope.supportEventIds,
    material_purchases: scope.purchaseIds,
    material_usage: scope.usageIds,
    expenses: scope.expenseIds,
    payments: scope.paymentIds,
    packing_records: scope.packingIds,
    deliveries: scope.deliveryIds,
  };
}

/**
 * What this order did to raw-material stock, and whether it can be undone.
 *
 * TWO MOVEMENTS, IN OPPOSITE DIRECTIONS
 *   An ISSUE took material off the shelf. Removing the issue record must put that
 *   material back - specifically what stayed out, on the material routes' own definition
 *   of "out" (issued less returned, with `issued` falling back to used + returned +
 *   wasted on a record that predates issue tracking), because a return already credited
 *   the shelf once and crediting it again would create stock out of nothing.
 *
 *   A PURCHASE put material on the shelf. Removing the purchase record must take that
 *   quantity back off.
 *
 *   A READY-MADE purchase did neither: finished garments bought in never enter raw
 *   inventory, which is a rule the material routes already enforce in both directions.
 *   So one is removed here as a cost record with no stock effect, and treating it as
 *   stock would put finished uniforms on the fabric shelf.
 *
 * WHY IT CAN REFUSE
 *   Reversing a purchase takes stock OFF the shelf, and the shelf may not have that much
 *   left - the material was used on other orders since. Driving it negative would be
 *   inventing a shortage that does not exist, so the purge stops and says so instead.
 *   Nothing is clamped to zero and nothing is silently skipped: a stock figure that
 *   cannot be restored honestly is a reason not to run.
 */
async function inventoryImpact(handle: Db, orderId: number, scope: Scope): Promise<InventoryImpact> {
  const impact: InventoryImpact = { restock: [], despurchase: [], readyMade: [], unsafe: [] };

  const usageRows = scope.usageIds.length
    ? await handle.select().from(materialUsage).where(inArray(materialUsage.id, scope.usageIds))
    : [];
  const purchaseRows = scope.purchaseIds.length
    ? await handle.select().from(materialPurchases).where(inArray(materialPurchases.id, scope.purchaseIds))
    : [];
  const materialIds = [...new Set([
    ...usageRows.map((row) => row.materialId),
    ...purchaseRows.map((row) => row.materialId),
  ].filter((v): v is number => v !== null))];
  const materialRows = materialIds.length
    ? await handle.select().from(materials).where(inArray(materials.id, materialIds))
    : [];
  const materialById = new Map(materialRows.map((row) => [row.id, row]));

  // Net stock effect per material, so several records on one material are judged once
  // against the shelf rather than one at a time.
  const netByMaterial = new Map<number, number>();
  const add = (materialId: number | null, delta: number) => {
    if (materialId === null || !delta) return;
    netByMaterial.set(materialId, (netByMaterial.get(materialId) ?? 0) + delta);
  };

  for (const usage of usageRows) {
    const material = materialById.get(usage.materialId);
    if (!material || isReadyMadeMaterial(material.category)) continue;
    /**
     * What this record took out of the store, using THE SAME EXPRESSION THE MATERIAL
     * ROUTES USE - not a plausible-looking one invented here.
     *
     * `POST /api/material-usage` draws the shelf down by `netOut`, and
     * `PUT /api/material-usage` credits it by the change in that same figure. Both define
     * it as ISSUED MINUS RETURNED, where a record that predates issue tracking has no
     * `quantity_issued` and falls back to everything the record accounts for:
     * `used + returned + wasted`.
     *
     * Getting this wrong is not a rounding error. Using `used + wasted` instead would
     * restore the wrong quantity whenever a record was issued and only partly consumed,
     * and using `quantityUsed` alone would restore less and less as material came back -
     * the exact defect the PUT route's own comment describes fixing. So the definition is
     * copied, deliberately and identically, and a test pins the number.
     */
    const issued = usage.quantityIssued
      ?? (usage.quantityUsed ?? 0) + (usage.quantityReturned ?? 0) + (usage.quantityWasted ?? 0);
    const stillOut = Math.max(0, issued - (usage.quantityReturned ?? 0));
    // Removing the issue puts back what never came home. Returned material already went
    // back on the shelf when the return was recorded, so crediting it again here would
    // create stock out of nothing.
    add(usage.materialId, stillOut);
    if (stillOut > 0)
      impact.restock.push({ materialId: material.id, materialName: material.name, quantity: stillOut, unit: material.unit });
  }

  for (const purchase of purchaseRows) {
    const material = materialById.get(purchase.materialId);
    if (!material) continue;
    if (isReadyMadeMaterial(material.category)) {
      // A finished garment bought in: a cost record, and no stock in either direction.
      impact.readyMade.push({ materialId: material.id, materialName: material.name, quantity: purchase.quantity ?? 0 });
      continue;
    }
    // Removing the purchase takes its quantity back off the shelf.
    add(purchase.materialId, -(purchase.quantity ?? 0));
    if ((purchase.quantity ?? 0) > 0)
      impact.despurchase.push({ materialId: material.id, materialName: material.name, quantity: purchase.quantity ?? 0, unit: material.unit });
  }

  for (const [materialId, delta] of netByMaterial) {
    const material = materialById.get(materialId);
    if (!material) {
      impact.unsafe.push(`Material ${materialId} no longer exists, so its stock effect cannot be assessed.`);
      continue;
    }
    const shelf = material.currentStock ?? 0;
    if (delta < 0 && shelf + delta < 0)
      impact.unsafe.push(
        `Removing this order's purchase of ${material.name} would take ${-delta} ${material.unit} off a shelf holding ${shelf}. `
        + `Stock cannot go negative, and it will not be forced to zero either, because that would hide a real shortage. `
        + `Adjust the stock figure for ${material.name} first, or leave this order in place.`
      );
  }
  return impact;
}

/**
 * What this order contributed to earnings that have ALREADY been settled.
 *
 * The accrual itself needs no handling: payroll derives piecework from approved
 * inspections, so removing this order's inspections removes its contribution and the
 * payroll screen recomputes without it. What cannot be recomputed is a payment that has
 * already been made - the money moved - so those are found and reported.
 */
async function payrollImpact(handle: Db, scope: Scope): Promise<PayrollImpact> {
  const impact: PayrollImpact = { settledPayments: [], totalSettled: 0, affectedMonths: [] };

  /**
   * Approved stage work behind this order, per worker per month, at the rate each
   * inspection actually paid. This is the SAME precedence lib/payroll.ts uses -
   * inspection snapshot, then the job's agreed rate, then the worker's profile rate -
   * and the same `coalesce(stage_inspections.worker_id, production_operations.worker_id)`
   * attribution, so the figure reported here is the figure payroll would have shown.
   */
  const stageRows = scope.inspectionIds.length
    ? await handle
        .select({
          workerId: sql<number>`coalesce(${stageInspections.workerId}, ${productionOperations.workerId})`,
          inspectedAt: stageInspections.inspectedAt,
          amount: sql<number>`coalesce(sum(${stageInspections.quantityApproved} * coalesce(${stageInspections.pieceRate}, ${productionOperations.pieceRate}, 0)), 0)`,
        })
        .from(stageInspections)
        .innerJoin(productionOperations, eq(productionOperations.id, stageInspections.productionOperationId))
        .where(inArray(stageInspections.id, scope.inspectionIds))
        .groupBy(sql`coalesce(${stageInspections.workerId}, ${productionOperations.workerId})`, stageInspections.inspectedAt)
    : [];
  const supportRows = scope.supportInspectionIds.length
    ? await handle
        .select({
          workerId: supportAssignments.workerId,
          inspectedAt: supportInspections.inspectedAt,
          amount: sql<number>`coalesce(sum(${supportInspections.quantityApproved} * coalesce(${supportInspections.pieceRate}, ${supportAssignments.pieceRate}, 0)), 0)`,
        })
        .from(supportInspections)
        .innerJoin(supportAssignments, eq(supportAssignments.id, supportInspections.supportAssignmentId))
        .where(inArray(supportInspections.id, scope.supportInspectionIds))
        .groupBy(supportAssignments.workerId, supportInspections.inspectedAt)
    : [];

  // Bucketed by month in Node from the timestamp each row carries, which is the same
  // `monthKey()` definition payroll uses. Grouping by month in SQL would need
  // date_trunc, which the suite's emulator does not implement.
  const stageByWorkerMonth = new Map<string, number>();
  const supportByWorkerMonth = new Map<string, number>();
  const months = new Set<string>();
  const workerIds = new Set<number>();
  for (const row of stageRows) {
    if (row.workerId === null || row.workerId === undefined) continue;
    const month = monthKey(row.inspectedAt);
    if (!month) continue;
    const key = `${row.workerId}|${month}`;
    stageByWorkerMonth.set(key, (stageByWorkerMonth.get(key) ?? 0) + (Number(row.amount) || 0));
    months.add(month);
    workerIds.add(Number(row.workerId));
  }
  for (const row of supportRows) {
    if (row.workerId === null || row.workerId === undefined) continue;
    const month = monthKey(row.inspectedAt);
    if (!month) continue;
    const key = `${row.workerId}|${month}`;
    supportByWorkerMonth.set(key, (supportByWorkerMonth.get(key) ?? 0) + (Number(row.amount) || 0));
    months.add(month);
    workerIds.add(Number(row.workerId));
  }
  impact.affectedMonths = [...months].sort();
  if (!workerIds.size || !months.size) return impact;

  const names = await handle
    .select({ id: workers.id, name: workers.name })
    .from(workers)
    .where(inArray(workers.id, [...workerIds]));
  const nameById = new Map(names.map((row) => [row.id, row.name]));

  const settled = await handle
    .select()
    .from(workerPayments)
    .where(and(
      inArray(workerPayments.workerId, [...workerIds]),
      inArray(workerPayments.periodMonth, [...months])
    ));
  for (const payment of settled) {
    const stagePart = stageByWorkerMonth.get(`${payment.workerId}|${payment.periodMonth}`) ?? 0;
    const supportPart = supportByWorkerMonth.get(`${payment.workerId}|${payment.periodMonth}`) ?? 0;
    if (stagePart <= 0 && supportPart <= 0) continue;
    impact.settledPayments.push({
      paymentId: payment.id,
      workerId: payment.workerId,
      workerName: nameById.get(payment.workerId) ?? `Worker ${payment.workerId}`,
      periodMonth: payment.periodMonth,
      paidAmount: payment.amount ?? 0,
      fromThisOrder: stagePart,
      supportFromThisOrder: supportPart,
    });
    impact.totalSettled += stagePart + supportPart;
  }
  impact.settledPayments.sort((a, b) => a.periodMonth.localeCompare(b.periodMonth) || a.workerId - b.workerId);
  return impact;
}

/**
 * How many garment lines sit on this order's deliveries.
 *
 * `delivery_lines` hangs from a delivery rather than from an order, so reaching it needs
 * the delivery ids - which the scope has already collected. One bounded count on an
 * indexed column.
 */
async function countDeliveryLines(handle: Db, deliveryIds: number[]): Promise<number> {
  if (!deliveryIds.length) return 0;
  const [row] = await handle
    .select({ total: sql<number>`count(*)` })
    .from(deliveryLines)
    .where(inArray(deliveryLines.deliveryId, deliveryIds));
  return Number(row?.total ?? 0);
}

/** Find the order, and prove it belongs to this organisation. */
export async function findPurgeTarget(organizationId: number | null | undefined, orderId: number) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  // One answer for "does not exist" and "is not yours": a caller must not be able to
  // discover another organisation's order ids by watching which ones 404 differently.
  if (!order) return null;
  if (organizationId !== null && organizationId !== undefined && order.organizationId !== organizationId) return null;
  const customer = order.customerId
    ? (await db.select({ id: customers.id, name: customers.name, organizationId: customers.organizationId })
        .from(customers).where(eq(customers.id, order.customerId)).limit(1))[0] ?? null
    : null;
  if (customer?.organizationId && organizationId !== null && organizationId !== undefined && customer.organizationId !== organizationId)
    return null;
  return { order, customer };
}

/**
 * PREVIEW: what would be removed, without removing anything.
 *
 * Reads only. It is safe to call as often as the Owner wants, and it is the only way to
 * obtain a fingerprint the execution will accept.
 */
export async function previewTestOrderPurge(
  organizationId: number | null | undefined,
  orderId: number
): Promise<PurgePreview | { error: string }> {
  const target = await findPurgeTarget(organizationId, orderId);
  if (!target) return { error: "That order could not be found." };
  const { order, customer } = target;

  const scope = await collectScope(db, orderId);
  const counts = countsOf(scope, await countDeliveryLines(db, scope.deliveryIds));
  const inventory = await inventoryImpact(db, orderId, scope);
  const payroll = await payrollImpact(db, scope);

  const blockers: string[] = [...inventory.unsafe];

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    customerId: order.customerId,
    customerName: customer?.name ?? null,
    totalAmount: order.totalAmount ?? 0,
    amountPaid: order.amountPaid ?? 0,
    counts,
    fingerprint: fingerprintOf(order.id, idsByTableOf(scope)),
    payroll,
    inventory,
    blockers,
  };
}

export type PurgeRequest = {
  organizationId: number | null | undefined;
  orderId: number;
  /** The school's name, typed by the Owner. Must match exactly. */
  confirmCustomerName: string;
  /** The order number, typed by the Owner. Must match exactly. */
  confirmOrderNumber: string;
  /** Why this order is being removed. Mandatory and permanent. */
  reason: string;
  /** The fingerprint from a preview that must still be current. */
  fingerprint: string;
  actor: { userId: number | null; name: string };
};

export type PurgeResult = {
  ok: true;
  purgeId: number;
  orderId: number;
  orderNumber: string;
  customerName: string | null;
  removed: PurgeCounts;
  payroll: PayrollImpact;
  inventory: InventoryImpact;
};

/**
 * EXECUTE the purge.
 *
 * EVERY CHECK RUNS AGAIN INSIDE THE TRANSACTION. That is not redundancy: a preview and
 * an execution are two separate requests, and between them another user can add a batch,
 * inspect a stage or record a payment. So the fingerprint is recomputed from the live
 * rows at execution time and compared, and the confirmations are re-checked against the
 * order as it is now. A stale confirmation is refused with 409 and a fresh preview is
 * demanded, which is what makes the authorisation effectively single-use - it names one
 * exact set of rows and cannot be replayed against a different one.
 *
 * ALL OR NOTHING. One transaction, so a failure partway through leaves the database
 * exactly as it was rather than half-cleaned. The audit row is written inside the same
 * transaction: if the removal did not happen, there is no record claiming it did.
 */
export async function executeTestOrderPurge(request: PurgeRequest): Promise<PurgeResult | { error: string; status: number }> {
  const confirmName = String(request.confirmCustomerName ?? "").trim();
  const confirmNumber = String(request.confirmOrderNumber ?? "").trim();
  const reason = String(request.reason ?? "").trim();
  const fingerprint = String(request.fingerprint ?? "").trim();

  if (!confirmName) return { error: "Type the school's name exactly as it appears on the order.", status: 400 };
  if (!confirmNumber) return { error: "Type the order number exactly as it appears.", status: 400 };
  if (reason.length < 10)
    return { error: "Give a reason of at least 10 characters. This is a permanent record of a destructive act.", status: 400 };
  if (!/^[a-f0-9]{64}$/i.test(fingerprint))
    return { error: "This cleanup needs a current preview. Open the preview again and confirm what it shows.", status: 400 };

  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, request.orderId)).limit(1);
    if (!order) return { error: "That order could not be found.", status: 404 };
    if (request.organizationId !== null && request.organizationId !== undefined && order.organizationId !== request.organizationId)
      // Same answer as "not found": another organisation's order is not distinguishable
      // from one that does not exist.
      return { error: "That order could not be found.", status: 404 };

    const customer = order.customerId
      ? (await tx.select({ id: customers.id, name: customers.name, organizationId: customers.organizationId })
          .from(customers).where(eq(customers.id, order.customerId)).limit(1))[0] ?? null
      : null;

    /* ---- the confirmations, checked against the order as it is NOW ---- */
    if (!sameName(confirmName, customer?.name ?? ""))
      return {
        error: `That is not the school on this order. Type the school's name exactly as it appears - this confirmation is what stops a neighbouring order being removed instead.`,
        status: 409,
      };
    if (confirmNumber !== String(order.orderNumber).trim())
      return { error: "That is not this order's number. Type it exactly as it appears.", status: 409 };

    /* ---- the fingerprint, recomputed from the live rows ---- */
    const scope = await collectScope(tx, request.orderId);
    const counts = countsOf(scope, await countDeliveryLines(tx, scope.deliveryIds));
    const current = fingerprintOf(order.id, idsByTableOf(scope));
    if (current !== fingerprint)
      return {
        error: "This order changed since the preview was taken, so the confirmation no longer describes what would be removed. "
          + "Take a fresh preview and confirm that instead. Nothing has been deleted.",
        status: 409,
      };

    /* ---- inventory: assessed again, and it can still stop the purge ---- */
    const inventory = await inventoryImpact(tx, order.id, scope);
    if (inventory.unsafe.length)
      return { error: inventory.unsafe.join(" "), status: 409 };

    const payroll = await payrollImpact(tx, scope);

    /* ---- restore stock BEFORE the records that justify it are gone ----
     *
     * Order matters here and only here: the net effect was computed from the purchase and
     * usage rows, so it is applied while they still exist and then they are removed. One
     * statement per material, not one per record.
     */
    const netByMaterial = new Map<number, number>();
    for (const entry of inventory.restock)
      netByMaterial.set(entry.materialId, (netByMaterial.get(entry.materialId) ?? 0) + entry.quantity);
    for (const entry of inventory.despurchase)
      netByMaterial.set(entry.materialId, (netByMaterial.get(entry.materialId) ?? 0) - entry.quantity);
    for (const [materialId, delta] of netByMaterial) {
      if (!delta) continue;
      await tx
        .update(materials)
        // An atomic read-modify-write in SQL, so two purges touching the same material
        // cannot each read the old figure and lose one of the adjustments.
        .set({ currentStock: sql`greatest(0, coalesce(${materials.currentStock}, 0) + ${delta})` })
        .where(eq(materials.id, materialId));
    }

    /* ---- the removal, children before parents ----
     *
     * Explicit id lists rather than relying on the cascade, for two reasons. First, the
     * cascades are not uniform: `support_assignments.order_id` is `set null`, so a
     * cascade would ORPHAN support work rather than remove it, and `material_usage` has
     * no cascade at all. Second, deleting by the ids the fingerprint described removes
     * EXACTLY the rows the Owner confirmed - a row created between the count and the
     * delete is not silently swept up with them.
     */
    const remove = async (table: any, ids: number[]) => {
      if (ids.length) await tx.delete(table).where(inArray(table.id, ids));
    };
    if (scope.deliveryIds.length)
      await tx.delete(deliveryLines).where(inArray(deliveryLines.deliveryId, scope.deliveryIds));
    await remove(supportInspections, scope.supportInspectionIds);
    await remove(supportStatusEvents, scope.supportEventIds);
    await remove(supportAssignments, scope.supportIds);
    await remove(stageInspections, scope.inspectionIds);
    await remove(qualityChecks, scope.qualityIds);
    await remove(reworkRecords, scope.reworkIds);
    await remove(externalWorkOrders, scope.externalIds);
    await remove(productionMovements, scope.movementIds);
    await remove(productionAllocations, scope.allocationIds);
    await remove(productionOperations, scope.operationIds);
    await remove(productionBatches, scope.batchIds);
    await remove(materialUsage, scope.usageIds);
    await remove(materialPurchases, scope.purchaseIds);
    await remove(expenses, scope.expenseIds);
    await remove(payments, scope.paymentIds);
    await remove(packingRecords, scope.packingIds);
    await remove(deliveries, scope.deliveryIds);
    await remove(orderItemSizes, scope.variantIds);
    await remove(orderItems, scope.itemIds);
    await tx.delete(orders).where(eq(orders.id, order.id));

    /* ---- the permanent account of what happened ---- */
    const [audit] = await tx
      .insert(testDataPurges)
      .values({
        organizationId: order.organizationId,
        orderId: order.id,
        orderNumber: order.orderNumber,
        customerName: customer?.name ?? null,
        confirmedCustomerName: confirmName,
        reason,
        ranById: request.actor.userId,
        ranByName: request.actor.name,
        previewCounts: JSON.stringify(counts),
        previewFingerprint: fingerprint,
        resultCounts: JSON.stringify(counts),
        // Reported rather than acted on: settled payroll is never rewritten here.
        payrollReport: payroll.settledPayments.length ? JSON.stringify(payroll.settledPayments) : null,
        inventoryReport: JSON.stringify({
          restock: inventory.restock,
          despurchase: inventory.despurchase,
          readyMade: inventory.readyMade,
        }),
      })
      .returning();

    return {
      ok: true as const,
      purgeId: audit.id,
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerName: customer?.name ?? null,
      removed: counts,
      payroll,
      inventory,
    };
  });
}

/**
 * Remove an order that has NO real business history behind it, and record it.
 *
 * This is the ordinary deletion the Orders screen offers, and it is deliberately much
 * weaker than the purge above: it works only on an order that never went anywhere. The
 * moment there is approved production, a customer payment, a delivery or settled payroll,
 * the Owner is pointed at the administrative purge instead - which is a preview, two
 * typed confirmations and a permanent audit entry, not a click.
 *
 * Returns the reason it refused, or null when the deletion went ahead.
 */
export async function deleteOrderIfSafe(
  organizationId: number | null | undefined,
  orderId: number,
  actor: { userId: number | null; name: string },
  reason: string
): Promise<{ ok: true } | { error: string; status: number }> {
  if (reason.trim().length < 10)
    return { error: "Give a reason of at least 10 characters for removing this order. It is recorded permanently.", status: 400 };

  const target = await findPurgeTarget(organizationId, orderId);
  if (!target) return { error: "Order not found.", status: 404 };
  const { order, customer } = target;

  // NOTE the destructuring: `Promise.all` resolves to a TUPLE OF ROW-SETS, so each name
  // here is an array and its first element is the row. Taking `const [batchRow] = ...`
  // instead binds the whole array, `array?.total` is undefined, every guard reads 0 - and
  // an order with approved production becomes deletable by a single click. The compiler
  // caught it; a test now pins it.
  const [batchRows, paymentRows, deliveryRows, stageRows] = await Promise.all([
    db.select({ total: sql<number>`count(*)` }).from(productionBatches).where(eq(productionBatches.orderId, orderId)),
    db.select({ total: sql<number>`count(*)` }).from(payments).where(eq(payments.orderId, orderId)),
    db.select({ total: sql<number>`count(*)` }).from(deliveries).where(eq(deliveries.orderId, orderId)),
    // The order's own stages, reached through its batches. Two bounded, indexed lookups
    // rather than one hand-written subquery, because a plain number interpolated into a
    // Drizzle `sql` template is NOT bound as a value - it is treated as an identifier - so
    // a string-built subquery here silently counted nothing and every guard read zero,
    // which would have let an order with approved production be deleted by a single click.
    db.select({ operationId: productionOperations.id })
      .from(productionOperations)
      .innerJoin(productionBatches, eq(productionBatches.id, productionOperations.productionBatchId))
      .where(eq(productionBatches.orderId, orderId)),
  ]);
  const guardOperationIds = stageRows.map((row) => row.operationId);
  // Inspections that actually judged something. An inspection row exists for every pass,
  // including one that approved nothing, so "has this order been inspected" is the wrong
  // question - "has anyone been judged on it" is the one that means history exists.
  const judgedRows = guardOperationIds.length
    ? await db.select({ total: sql<number>`count(*)` })
        .from(stageInspections)
        .where(and(
          inArray(stageInspections.productionOperationId, guardOperationIds),
          sql`${stageInspections.quantityApproved} + ${stageInspections.quantityRework} + ${stageInspections.quantityRejected} > 0`
        ))
    : [];
  const batches = Number(batchRows[0]?.total ?? 0);
  const paymentsCount = Number(paymentRows[0]?.total ?? 0);
  const deliveriesCount = Number(deliveryRows[0]?.total ?? 0);
  const judged = Number(judgedRows[0]?.total ?? 0);

  /**
   * The rule, stated as one refusal rather than four: an order that production or money
   * has touched is not removable this way. Batches with no work behind them are allowed,
   * because an abandoned empty batch is exactly the kind of thing an Owner should be able
   * to tidy without an administrative procedure - but approved, reworked or rejected work
   * is real history and is not.
   */
  if (judged > 0 || paymentsCount > 0 || deliveriesCount > 0)
    return {
      error:
        `This order has real history behind it`
        + `${judged > 0 ? ` - ${judged} inspected production record${judged === 1 ? "" : "s"}` : ""}`
        + `${paymentsCount > 0 ? `${judged > 0 ? "," : ""} ${paymentsCount} customer payment${paymentsCount === 1 ? "" : "s"}` : ""}`
        + `${deliveriesCount > 0 ? " and a delivery" : ""}`
        + `. It cannot be deleted here, because the same action on a live order would destroy a factory's records. `
        + `If this is TEST data that must be cleared before operations begin, use Settings > Test data cleanup, which previews exactly what will be removed and records the purge permanently.`,
      status: 409,
    };

  const scope = await collectScope(db, orderId);
  const counts = countsOf(scope, await countDeliveryLines(db, scope.deliveryIds));
  const inventory = await inventoryImpact(db, orderId, scope);
  if (inventory.unsafe.length) return { error: inventory.unsafe.join(" "), status: 409 };

  return db.transaction(async (tx) => {
    // Stock first, while the records that justify the adjustment still exist.
    const netByMaterial = new Map<number, number>();
    for (const entry of inventory.restock)
      netByMaterial.set(entry.materialId, (netByMaterial.get(entry.materialId) ?? 0) + entry.quantity);
    for (const entry of inventory.despurchase)
      netByMaterial.set(entry.materialId, (netByMaterial.get(entry.materialId) ?? 0) - entry.quantity);
    for (const [materialId, delta] of netByMaterial) {
      if (!delta) continue;
      await tx.update(materials)
        .set({ currentStock: sql`greatest(0, coalesce(${materials.currentStock}, 0) + ${delta})` })
        .where(eq(materials.id, materialId));
    }

    const remove = async (table: any, ids: number[]) => {
      if (ids.length) await tx.delete(table).where(inArray(table.id, ids));
    };
    await remove(supportInspections, scope.supportInspectionIds);
    await remove(supportStatusEvents, scope.supportEventIds);
    await remove(supportAssignments, scope.supportIds);
    await remove(stageInspections, scope.inspectionIds);
    await remove(qualityChecks, scope.qualityIds);
    await remove(reworkRecords, scope.reworkIds);
    await remove(externalWorkOrders, scope.externalIds);
    await remove(productionMovements, scope.movementIds);
    await remove(productionAllocations, scope.allocationIds);
    await remove(productionOperations, scope.operationIds);
    await remove(productionBatches, scope.batchIds);
    await remove(materialUsage, scope.usageIds);
    await remove(materialPurchases, scope.purchaseIds);
    await remove(expenses, scope.expenseIds);
    await remove(payments, scope.paymentIds);
    await remove(packingRecords, scope.packingIds);
    await remove(deliveries, scope.deliveryIds);
    await remove(orderItemSizes, scope.variantIds);
    await remove(orderItems, scope.itemIds);

    await tx.insert(orderDeletions).values({
      organizationId: order.organizationId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerName: customer?.name ?? null,
      deletedById: actor.userId,
      deletedByName: actor.name,
      reason: reason.trim().slice(0, 2000),
      totalAmount: order.totalAmount ?? 0,
      amountPaid: order.amountPaid ?? 0,
      batchCount: batches,
      operationCount: scope.operationIds.length,
      paymentCount: paymentsCount,
    });
    await tx.delete(orders).where(eq(orders.id, order.id));
    return { ok: true as const };
  });
}

/** The removal history for one organisation, newest first. Bounded. */
export async function purgeHistory(organizationId: number | null | undefined, limit = 50) {
  const scoped = organizationId !== null && organizationId !== undefined;
  const [purges, deletions] = await Promise.all([
    db.select().from(testDataPurges)
      .where(scoped ? eq(testDataPurges.organizationId, organizationId) : undefined)
      // desc + limit, not asc + limit + reverse: once the trail is longer than the
      // limit, taking the oldest slice and reversing it would return the wrong window.
      .orderBy(desc(testDataPurges.ranAt)).limit(limit),
    db.select().from(orderDeletions)
      .where(scoped ? eq(orderDeletions.organizationId, organizationId) : undefined)
      .orderBy(desc(orderDeletions.deletedAt)).limit(limit),
  ]);
  return { purges, deletions };
}
