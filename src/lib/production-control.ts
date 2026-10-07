import { and, asc, eq, inArray, like, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { variantLabel } from "@/lib/format";
import {
  customers,
  externalWorkOrders,
  orderItems,
  orders,
  orderItemSizes,
  packingRecords,
  productionBatches,
  productionOperations,
  products,
  deliveries,
} from "@/db/schema";
import { deriveQuantitiesBulk, detailOrZero } from "@/lib/production-ledger";
import { allocationsByOperation, workerNames } from "@/lib/production-allocation";
import { supportByOperation, type StageSupport } from "@/lib/support-work";

/**
 * ROUTE-AWARE PRODUCTION CONTROL.
 *
 * One question, answered per exact garment variant: where is this work, how much of it is
 * left, whose hands is it in, and what is stopping it.
 *
 * NOTHING HERE IS EDITABLE AND NOTHING HERE IS NEW. Every figure is derived from records
 * the system already keeps, and this module writes nothing at all:
 *
 *   ordered / approved / remaining   the production movement ledger, via
 *                                    `deriveQuantitiesBulk()` - the same derivation the
 *                                    integrity tests hold the counters to, so this screen
 *                                    cannot show a quantity the ledger disagrees with;
 *   current route stage              the route FROZEN ON THE BATCH as
 *                                    `production_operations.route_position`, not the global
 *                                    eight-stage array, so a route that skips or reorders
 *                                    stages reports its own truth;
 *   assigned quantity                `production_allocations`, live shares only;
 *   awaiting inspection / rework /
 *   rejected                         the ledger's own buckets;
 *   bottleneck, stuck, priority      derived from the above plus the order's due date.
 *
 * There is no second production system here and no manually editable quantity: this is a
 * read model over ORDER -> VARIANT -> ROUTE -> STAGE -> ALLOCATION -> LEDGER.
 *
 * HOW IT STAYS BOUNDED
 *   Filters that can be evaluated in SQL - school, order number, due window, order status,
 *   one order, one batch - are pushed down and bound the candidate set. Filters that depend
 *   on a DERIVED figure (current stage, priority, blocked-only) cannot be pushed into the
 *   page without first deriving it, so the candidate set is derived in one pass, capped at
 *   `deriveCap`, then filtered and paged. The cap is reported in the response as
 *   `window: { derived, capped }` rather than being silent about it, and the ordering
 *   (earliest due date first) means the capped window is always the most urgent work.
 *   Either way the statement count is constant: about nine queries for a page or for a
 *   thousand batches. No table is ever loaded whole, and no stage is queried one at a time.
 */

/** How many batches may be derived in one pass before the window is reported as capped. */
export const DERIVE_CAP = 1000;

export type ControlFilters = {
  orderId?: number | null;
  batchId?: number | null;
  /** Free text against the order number or the school's name. */
  search?: string | null;
  /** Only orders not already COMPLETED or CANCELLED. The default. */
  openOnly?: boolean;
  /** Due today or within this many days. Overdue work is always included. */
  dueWithinDays?: number | null;
  /** Derived filters, applied to the derived window. */
  stage?: string | null;
  priority?: number | null;
  blockedOnly?: boolean;
  /**
   * Only batches whose support work has stopped.
   *
   * Derived rather than pushed into SQL, because "paused" is a property of the
   * support rows behind a batch's stages and the board already derives the window in
   * one pass - so this names itself in `appliedAfterDerivation` like the other
   * derived filters, and the UI can say the list is narrowed.
   */
  supportPausedOnly?: boolean;
  limit?: number;
  offset?: number;
};

export type StageWorker = { workerId: number; name: string; quantity: number; remaining: number };

export type StageControl = {
  operationId: number;
  position: number;
  stage: string;
  method: string | null;
  status: string;
  received: number;
  submitted: number;
  approved: number;
  rework: number;
  rejected: number;
  remaining: number;
  /** Submitted but not yet judged - work that is finished and waiting on somebody. */
  awaitingInspection: number;
  /** Live allocation quantity at this stage, and the shares behind it. */
  assigned: number;
  workers: StageWorker[];
  /** Dispatches sent out and not yet accounted for. */
  openDispatches: number;
  /**
   * Support work handed out from this stage - or null when the stage has none.
   *
   * A stage's own counters describe what the stage holds; they say nothing about the
   * part of it a tailor gave to a helper. Without this the board reported a stage as
   * ordinary in-progress work while the support it was waiting on had stopped, which
   * is precisely the case a controller has to see.
   *
   * NULL RATHER THAN A ZEROED OBJECT, deliberately. Most stages of most batches have no
   * support work at all, and emitting ten zero fields for each of them added 48 KB to a
   * full board without saying anything - which is how a feature that makes the board
   * more useful made it slower to load. A stage nobody delegated from carries no support
   * object; a stage that was delegated from carries the real figures, including once
   * they are all settled, because "20 handed out, 20 accepted" is still worth showing.
   */
  support: StageSupport | null;
  isCurrent: boolean;
};

export type ControlRow = {
  batchId: number;
  batchNumber: string | null;
  orderId: number;
  orderNumber: string;
  orderStatus: string;
  school: string;
  dueDate: string | null;
  /** Negative when the order is already late. Null when no due date was set. */
  daysToDue: number | null;
  itemId: number | null;
  product: string | null;
  variantId: number | null;
  variant: string | null;
  size: string | null;
  color: string | null;
  /** What was put into production for this exact variant. */
  ordered: number;
  /** Approved at the FINAL stage of this batch's frozen route - garments finished. */
  finished: number;
  /** Still to finish. Never negative, never typed in. */
  remaining: number;
  currentPosition: number | null;
  currentStage: string | null;
  routeLength: number;
  /** Live shares at the current stage. */
  assigned: number;
  /** Submitted and unjudged at the current stage, and across the whole route. */
  awaitingInspection: number;
  awaitingInspectionTotal: number;
  rework: number;
  rejected: number;
  /** The incomplete stage holding the most work - where this batch is piling up. */
  bottleneck: { position: number; stage: string; quantity: number } | null;
  /**
   * This batch's support work, rolled up across its whole route.
   *
   * "50 assigned, 20 delegated, 15 approved, 5 still out" has to be one answer on the
   * board and one answer on the support screen, so it is summed here from the same
   * per-stage figures rather than derived twice. `pausedStages` names the stages a
   * helper has stopped on, because a controller acts on a stage, not on a count.
   */
  support: {
    delegated: number;
    approved: number;
    outstanding: number;
    paused: number;
    reworkOpen: number;
    blocking: boolean;
    pausedStages: { stage: string; reason: string | null }[];
  };
  flags: string[];
  stuck: boolean;
  priority: number;
  priorityLabel: string;
  route: StageControl[];
};

export type ControlResult = {
  rows: ControlRow[];
  total: number;
  window: { derived: number; capped: boolean; cap: number };
  /** Filters that could only be applied after derivation, so the UI can label them. */
  appliedAfterDerivation: string[];
};

/* -------------------------------------------------------------------------- */
/* Pure derivation. Exported so the rules can be tested without a database.    */
/* -------------------------------------------------------------------------- */

/** 'YYYY-MM-DD' -> whole days from today, negative when already late. */
export function daysUntil(date: string | Date | null | undefined, today = new Date()): number | null {
  if (!date) return null;
  const text = date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [y, m, d] = text.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d);
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target - now) / 86400000);
}

/**
 * The stage a batch is AT: the earliest position on its own frozen route that still has
 * work left. A route that skips or reorders stages reports its own order, because the
 * positions were frozen onto the batch when it was created.
 */
export function currentPositionOf(stages: { position: number; remaining: number }[]): number | null {
  const open = stages.filter((stage) => stage.remaining > 0).sort((a, b) => a.position - b.position);
  if (open.length) return open[0].position;
  if (!stages.length) return null;
  // Nothing is left anywhere: the batch sits at the end of its own route.
  return stages.reduce((last, stage) => Math.max(last, stage.position), 0);
}

/**
 * Where work is piling up: the incomplete stage holding the most quantity. Ties go to the
 * earliest stage, because that is the one everything behind it is waiting on.
 */
export function bottleneckOf(
  stages: { position: number; stage: string; remaining: number }[]
): { position: number; stage: string; quantity: number } | null {
  let best: { position: number; stage: string; quantity: number } | null = null;
  for (const stage of stages) {
    if (stage.remaining <= 0) continue;
    if (!best || stage.remaining > best.quantity || (stage.remaining === best.quantity && stage.position < best.position)) {
      best = { position: stage.position, stage: stage.stage, quantity: stage.remaining };
    }
  }
  return best;
}

/**
 * What is stopping this batch. Every flag is derived; none can be typed in, and none
 * changes a quantity. A flag is a statement about records that already exist.
 */
export function flagsFor(input: {
  remaining: number;
  daysToDue: number | null;
  current: StageControl | null;
  routeComplete: boolean;
}): string[] {
  const flags: string[] = [];
  if (input.remaining <= 0) {
    flags.push("COMPLETE");
    return flags;
  }
  if (input.daysToDue !== null && input.daysToDue < 0) flags.push("OVERDUE");
  else if (input.daysToDue !== null && input.daysToDue <= 3) flags.push("DUE_SOON");

  const stage = input.current;
  if (!stage) {
    // Work is left to do but the batch has no stage to do it at: it was never routed.
    flags.push("NO_ROUTE");
    return flags;
  }
  if (stage.received <= 0 && stage.position > 1) flags.push("WAITING_UPSTREAM");
  if (stage.awaitingInspection > 0) flags.push("AWAITING_INSPECTION");
  if (stage.rework > 0 && stage.remaining > 0) flags.push("REWORK_PENDING");
  if (stage.openDispatches > 0) flags.push("OUTSOURCED_WAITING");
  /* ---- support work is part of this stage, not a side note ----
   *
   * A helper who has stopped is a hard block: the tailor cannot finish the stage
   * until those pieces come back, so the batch must not read as merely in progress.
   * Pieces handed back for the helper to redo are the same kind of block. Delegated
   * work that is simply still in hand is NOT a block - it is normal production - but
   * it is reported, because "20 of these 50 are with a helper" is what makes the
   * stage's own remaining figure interpretable.
   */
  const support = stage.support;
  if (support) {
    if (support.paused > 0) flags.push("SUPPORT_PAUSED");
    if (support.reworkOpen > 0) flags.push("SUPPORT_REWORK");
    if (support.outstanding > 0) flags.push("SUPPORT_IN_PROGRESS");
  }
  if (stage.received > 0 && stage.assigned <= 0 && stage.workers.length === 0 && stage.openDispatches === 0)
    flags.push("UNASSIGNED");
  return flags;
}

/**
 * Flags that mean work exists but is not moving.
 *
 * SUPPORT_PAUSED and SUPPORT_REWORK are blocking: the stage is waiting on somebody
 * else and cannot complete. SUPPORT_IN_PROGRESS deliberately is NOT - a helper
 * working is production happening, and calling it a block would put every delegated
 * garment on the stuck list and make the list mean nothing.
 */
const BLOCKING_FLAGS = new Set([
  "AWAITING_INSPECTION", "REWORK_PENDING", "OUTSOURCED_WAITING", "UNASSIGNED", "WAITING_UPSTREAM", "NO_ROUTE",
  "SUPPORT_PAUSED", "SUPPORT_REWORK",
]);

export function isStuck(flags: string[], remaining: number): boolean {
  return remaining > 0 && flags.some((flag) => BLOCKING_FLAGS.has(flag));
}

/**
 * Priority is derived, ordered, and never editable.
 *
 * 1 OVERDUE   past its due date with work left
 * 2 DUE_SOON  due within three days with work left
 * 3 BLOCKED   work left and something is stopping it
 * 4 SCHEDULED due within a fortnight
 * 5 NORMAL    work left, nothing otherwise pressing
 * 6 COMPLETE  nothing left to do
 */
export function priorityFor(input: { remaining: number; daysToDue: number | null; stuck: boolean }): {
  rank: number; label: string;
} {
  if (input.remaining <= 0) return { rank: 6, label: "COMPLETE" };
  if (input.daysToDue !== null && input.daysToDue < 0) return { rank: 1, label: "OVERDUE" };
  if (input.daysToDue !== null && input.daysToDue <= 3) return { rank: 2, label: "DUE SOON" };
  if (input.stuck) return { rank: 3, label: "BLOCKED" };
  if (input.daysToDue !== null && input.daysToDue <= 14) return { rank: 4, label: "SCHEDULED" };
  return { rank: 5, label: "NORMAL" };
}

export const PRIORITY_LABELS: Record<number, string> = {
  1: "OVERDUE", 2: "DUE SOON", 3: "BLOCKED", 4: "SCHEDULED", 5: "NORMAL", 6: "COMPLETE",
};

/** The size/colour pair as one readable label. */
/**
 * How a variant reads on the board.
 *
 * Delegates to `variantLabel`, which is how the same garment already reads on the
 * production board, the operations list and the worker's dashboard ("Navy • Size 10").
 * One fact, one rendering: a controller comparing this screen with any other must not
 * have to translate. The only difference is the empty case, which is null here rather
 * than a sentence, because this field is optional in the row and the screen prefers to
 * print nothing than to print a placeholder in a table column.
 */
export function variantText(size: string | null, color: string | null): string | null {
  const parts = [size, color].filter((v): v is string => !!v && String(v).trim() !== "");
  return parts.length ? variantLabel(size, color) : null;
}

/* -------------------------------------------------------------------------- */
/* The read model.                                                             */
/* -------------------------------------------------------------------------- */

function dayString(offsetDays: number, today = new Date()): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offsetDays));
  return d.toISOString().slice(0, 10);
}

export async function productionControl(
  filters: ControlFilters = {},
  today = new Date()
): Promise<ControlResult> {
  const openOnly = filters.openOnly !== false;
  const search = filters.search ? String(filters.search).trim() : "";
  const limit = Number.isSafeInteger(filters.limit) && (filters.limit as number) > 0
    ? Math.min(filters.limit as number, 500) : 100;
  const offset = Number.isSafeInteger(filters.offset) && (filters.offset as number) > 0
    ? (filters.offset as number) : 0;

  // ---- 1. the candidate set, filtered in SQL ----
  const where = and(
    sql`${productionBatches.status} <> 'CANCELLED'`,
    filters.orderId ? eq(productionBatches.orderId, filters.orderId) : undefined,
    filters.batchId ? eq(productionBatches.id, filters.batchId) : undefined,
    openOnly ? sql`${orders.status} not in ('CANCELLED', 'COMPLETED')` : undefined,
    // A due window always includes work that is already late.
    filters.dueWithinDays !== null && filters.dueWithinDays !== undefined && Number.isFinite(filters.dueWithinDays)
      ? sql`${orders.dueDate} <= ${dayString(Math.max(0, Math.trunc(filters.dueWithinDays)), today)}`
      : undefined,
    search
      ? or(like(orders.orderNumber, `%${search}%`), like(customers.name, `%${search}%`))
      : undefined
  );

  const selectShape = {
    batchId: productionBatches.id,
    batchNumber: productionBatches.batchNumber,
    batchQuantity: productionBatches.quantity,
    batchStatus: productionBatches.status,
    orderId: productionBatches.orderId,
    orderItemId: productionBatches.orderItemId,
    orderVariantId: productionBatches.orderVariantId,
    size: productionBatches.size,
    color: productionBatches.color,
    orderNumber: orders.orderNumber,
    orderStatus: orders.status,
    dueDate: orders.dueDate,
    school: customers.name,
  };

  const [totalRow, candidates] = await Promise.all([
    db.select({ total: sql<number>`count(*)` })
      .from(productionBatches)
      .innerJoin(orders, eq(orders.id, productionBatches.orderId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(where),
    // Earliest due date first, so a capped window is always the most urgent work.
    db.select(selectShape)
      .from(productionBatches)
      .innerJoin(orders, eq(orders.id, productionBatches.orderId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(where)
      .orderBy(asc(orders.dueDate), asc(productionBatches.id))
      .limit(DERIVE_CAP),
  ]);
  const derivedCount = candidates.length;
  const capped = derivedCount >= DERIVE_CAP;
  if (!derivedCount) {
    return { rows: [], total: 0, window: { derived: 0, capped: false, cap: DERIVE_CAP }, appliedAfterDerivation: [] };
  }

  // ---- 2. every stage of every candidate batch, in route order, in ONE query ----
  const batchIds = candidates.map((row) => row.batchId);
  const operations = await db
    .select({
      id: productionOperations.id,
      productionBatchId: productionOperations.productionBatchId,
      stage: productionOperations.stage,
      routePosition: productionOperations.routePosition,
      method: productionOperations.method,
      status: productionOperations.status,
      workerId: productionOperations.workerId,
    })
    .from(productionOperations)
    .where(inArray(productionOperations.productionBatchId, batchIds))
    .orderBy(asc(productionOperations.productionBatchId), asc(productionOperations.routePosition), asc(productionOperations.id));
  const operationIds = operations.map((row) => row.id);

  /* ---- 3. the ledger, the shares, the open dispatches and the support work ----
   *
   * Four queries for the whole window, run together. Support work joins here rather
   * than in a later pass so that it costs ONE statement however many batches the
   * window holds: it is aggregated in SQL by stage and state, never read assignment
   * by assignment.
   */
  const [ledger, allocations, dispatchRows, support] = await Promise.all([
    deriveQuantitiesBulk(db, operationIds),
    allocationsByOperation(operationIds),
    operationIds.length
      ? db.select({
          operationId: externalWorkOrders.productionOperationId,
          open: sql<number>`count(*)`,
        })
          .from(externalWorkOrders)
          .where(and(inArray(externalWorkOrders.productionOperationId, operationIds), eq(externalWorkOrders.status, "SENT")))
          .groupBy(externalWorkOrders.productionOperationId)
      : Promise.resolve([] as { operationId: number; open: number }[]),
    supportByOperation(db, operationIds),
  ]);
  // Every worker named on any share in the window, in one further query - so the
  // statement count stays constant however many batches the window holds.
  const names = await workerNames([...new Set(
    operations.flatMap((operation) => [
      operation.workerId ?? 0,
      ...(allocations.get(operation.id) ?? []).map((share: { workerId: number }) => share.workerId),
    ]).filter((id) => id > 0)
  )]);
  const openDispatches = new Map<number, number>(dispatchRows.map((row) => [Number(row.operationId), Number(row.open) || 0]));

  // ---- 4. the exact garment each batch is for, batched not per-row ----
  const itemIds = [...new Set(candidates.map((row) => row.orderItemId).filter((v): v is number => !!v))];
  const variantIds = [...new Set(candidates.map((row) => row.orderVariantId).filter((v): v is number => !!v))];
  const [itemRows, variantRows] = await Promise.all([
    itemIds.length
      ? db.select({ id: orderItems.id, productId: orderItems.productId, quantity: orderItems.quantity })
          .from(orderItems).where(inArray(orderItems.id, itemIds))
      : [],
    variantIds.length
      ? db.select({ id: orderItemSizes.id, size: orderItemSizes.size, color: orderItemSizes.color, quantity: orderItemSizes.quantity })
          .from(orderItemSizes).where(inArray(orderItemSizes.id, variantIds))
      : [],
  ]);
  const productIds = [...new Set(itemRows.map((row) => row.productId).filter((v): v is number => !!v))];
  const productRows = productIds.length
    ? await db.select({ id: products.id, name: products.name }).from(products).where(inArray(products.id, productIds))
    : [];
  const itemById = new Map(itemRows.map((row) => [row.id, row]));
  const variantById = new Map(variantRows.map((row) => [row.id, row]));
  const productById = new Map(productRows.map((row) => [row.id, row]));

  const operationsByBatch = new Map<number, typeof operations>();
  for (const operation of operations) {
    const list = operationsByBatch.get(operation.productionBatchId) ?? [];
    list.push(operation);
    operationsByBatch.set(operation.productionBatchId, list);
  }

  // ---- 5. derive one row per batch ----
  const derived: ControlRow[] = candidates.map((candidate) => {
    const stages: StageControl[] = (operationsByBatch.get(candidate.batchId) ?? []).map((operation) => {
      const detail = detailOrZero(ledger, operation.id);
      const shares: { workerId: number; quantityAllocated: number; quantityApproved: number; quantityRejected: number; quantitySubmitted: number }[] =
        allocations.get(operation.id) ?? [];
      const assigned = shares.reduce((sum, share) => sum + Math.max(0, share.quantityAllocated), 0);
      const workers: StageWorker[] = shares.map((share) => ({
        workerId: share.workerId,
        name: names.get(share.workerId) ?? "-",
        quantity: share.quantityAllocated,
        remaining: Math.max(
          0,
          share.quantityAllocated - share.quantityApproved - share.quantityRejected - share.quantitySubmitted
        ),
      }));
      // A stage with no shares yet still has a nominal worker, and the dashboard must
      // say who is on it rather than reporting a stage nobody is holding.
      if (!workers.length && operation.workerId) {
        workers.push({
          workerId: operation.workerId,
          name: names.get(operation.workerId) ?? "-",
          quantity: 0,
          remaining: 0,
        });
      }
      return {
        operationId: operation.id,
        position: operation.routePosition ?? 0,
        stage: operation.stage,
        method: operation.method,
        status: operation.status,
        received: detail.quantityReceived,
        submitted: detail.quantityCompleted,
        approved: detail.quantityApproved,
        rework: detail.quantityRework,
        rejected: detail.quantityRejected,
        remaining: detail.quantityRemaining,
        awaitingInspection: Math.max(0, detail.quantityCompleted - detail.quantityApproved - detail.quantityRework - detail.quantityRejected),
        assigned,
        workers,
        openDispatches: openDispatches.get(operation.id) ?? 0,
        support: support.get(operation.id) ?? null,
        isCurrent: false,
      };
    });

    const ordered = Math.max(0, candidate.batchQuantity ?? 0);
    const currentPosition = currentPositionOf(stages);
    const current = stages.find((stage) => stage.position === currentPosition) ?? null;
    for (const stage of stages) stage.isCurrent = stage.position === currentPosition;

    // Garments finished means approved at the LAST stage of THIS batch's route.
    const lastPosition = stages.length ? stages.reduce((max, stage) => Math.max(max, stage.position), 0) : null;
    const finalStage = lastPosition === null ? null : stages.find((stage) => stage.position === lastPosition) ?? null;
    const finished = finalStage ? finalStage.approved : 0;
    const remaining = Math.max(0, ordered - finished);

    const variant = candidate.orderVariantId ? variantById.get(candidate.orderVariantId) : undefined;
    const item = candidate.orderItemId ? itemById.get(candidate.orderItemId) : undefined;
    const due = daysUntil(candidate.dueDate, today);
    const flags = flagsFor({ remaining, daysToDue: due, current, routeComplete: remaining <= 0 });
    const stuck = isStuck(flags, remaining);
    const priority = priorityFor({ remaining, daysToDue: due, stuck });

    return {
      batchId: candidate.batchId,
      batchNumber: candidate.batchNumber,
      orderId: candidate.orderId ?? 0,
      orderNumber: candidate.orderNumber,
      orderStatus: candidate.orderStatus,
      school: candidate.school ?? "School not recorded",
      dueDate: candidate.dueDate ? String(candidate.dueDate).slice(0, 10) : null,
      daysToDue: due,
      itemId: candidate.orderItemId,
      product: item ? productById.get(item.productId ?? -1)?.name ?? null : null,
      variantId: candidate.orderVariantId,
      variant: variantText(variant?.size ?? candidate.size, variant?.color ?? candidate.color),
      size: variant?.size ?? candidate.size ?? null,
      color: variant?.color ?? candidate.color ?? null,
      ordered,
      finished,
      remaining,
      currentPosition,
      currentStage: current?.stage ?? null,
      routeLength: stages.length,
      assigned: current?.assigned ?? 0,
      awaitingInspection: current?.awaitingInspection ?? 0,
      awaitingInspectionTotal: stages.reduce((sum, stage) => sum + stage.awaitingInspection, 0),
      rework: stages.reduce((sum, stage) => sum + stage.rework, 0),
      rejected: stages.reduce((sum, stage) => sum + stage.rejected, 0),
      bottleneck: bottleneckOf(stages),
      support: (() => {
        // `stage.support` is null on a stage nobody delegated from, so every read goes
        // through the narrowed list rather than assuming an object is there.
        const delegated = stages.filter(
          (stage): stage is (typeof stage & { support: StageSupport }) => stage.support !== null
        );
        return {
          delegated: delegated.reduce((sum, stage) => sum + stage.support.delegated, 0),
          approved: delegated.reduce((sum, stage) => sum + stage.support.approved, 0),
          outstanding: delegated.reduce((sum, stage) => sum + stage.support.outstanding, 0),
          paused: delegated.reduce((sum, stage) => sum + stage.support.paused, 0),
          reworkOpen: delegated.reduce((sum, stage) => sum + stage.support.reworkOpen, 0),
          blocking: delegated.some((stage) => stage.support.blocking),
          pausedStages: delegated
            .filter((stage) => stage.support.paused > 0)
            .map((stage) => ({ stage: stage.stage, reason: stage.support.pausedReason })),
        };
      })(),
      flags,
      stuck,
      priority: priority.rank,
      priorityLabel: priority.label,
      route: stages,
    };
  });

  // ---- 6. derived filters, then the page ----
  const appliedAfterDerivation: string[] = [];
  let rows = derived;
  if (filters.stage) {
    appliedAfterDerivation.push("stage");
    const wanted = String(filters.stage).trim().toUpperCase();
    rows = rows.filter((row) => (row.currentStage ?? "").toUpperCase() === wanted);
  }
  if (filters.priority !== null && filters.priority !== undefined) {
    appliedAfterDerivation.push("priority");
    rows = rows.filter((row) => row.priority === Number(filters.priority));
  }
  if (filters.blockedOnly) {
    appliedAfterDerivation.push("blockedOnly");
    rows = rows.filter((row) => row.stuck);
  }
  if (filters.supportPausedOnly) {
    appliedAfterDerivation.push("supportPausedOnly");
    rows = rows.filter((row) => row.support.paused > 0);
  }
  // Most urgent first, then soonest due, then oldest batch. Deterministic, so paging
  // through the same filters always shows the same rows in the same order.
  rows = [...rows].sort(
    (a, b) =>
      a.priority - b.priority ||
      (a.daysToDue ?? 999999) - (b.daysToDue ?? 999999) ||
      b.remaining - a.remaining ||
      a.batchId - b.batchId
  );

  const page = rows.slice(offset, offset + limit);
  return {
    rows: page,
    total: rows.length,
    window: { derived: derivedCount, capped, cap: DERIVE_CAP },
    appliedAfterDerivation,
  };
}

/**
 * The same rows rolled up per school/order, which is how the control board is read:
 * one line per order with its worst stage and its most urgent priority.
 *
 * Derived from the rows already built, so it can never disagree with them.
 */
export function rollUpByOrder(rows: ControlRow[]) {
  const byOrder = new Map<number, {
    orderId: number;
    orderNumber: string;
    school: string;
    dueDate: string | null;
    daysToDue: number | null;
    ordered: number;
    finished: number;
    remaining: number;
    assigned: number;
    awaitingInspection: number;
    rework: number;
    rejected: number;
    batches: number;
    stages: { stage: string; quantity: number }[];
    priority: number;
    priorityLabel: string;
    stuck: boolean;
    flags: string[];
    /** Support work across every batch of this order, summed from the batch rows. */
    support: {
      delegated: number; approved: number; outstanding: number;
      paused: number; reworkOpen: number; blocking: boolean;
      pausedStages: { stage: string; reason: string | null }[];
    };
  }>();
  for (const row of rows) {
    const found = byOrder.get(row.orderId) ?? {
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      school: row.school,
      dueDate: row.dueDate,
      daysToDue: row.daysToDue,
      ordered: 0, finished: 0, remaining: 0, assigned: 0, awaitingInspection: 0,
      rework: 0, rejected: 0, batches: 0, stages: [],
      priority: 6, priorityLabel: "COMPLETE", stuck: false, flags: [] as string[],
      support: {
        delegated: 0, approved: 0, outstanding: 0, paused: 0, reworkOpen: 0,
        blocking: false, pausedStages: [] as { stage: string; reason: string | null }[],
      },
    };
    found.ordered += row.ordered;
    found.finished += row.finished;
    found.remaining += row.remaining;
    found.assigned += row.assigned;
    found.awaitingInspection += row.awaitingInspectionTotal;
    found.rework += row.rework;
    found.rejected += row.rejected;
    found.batches += 1;
    if (row.currentStage && row.remaining > 0) found.stages.push({ stage: row.currentStage, quantity: row.remaining });
    // The order is as urgent as its most urgent batch, and as blocked as any of them.
    if (row.priority < found.priority) {
      found.priority = row.priority;
      found.priorityLabel = row.priorityLabel;
    }
    if (row.stuck) found.stuck = true;
    for (const flag of row.flags) if (!found.flags.includes(flag)) found.flags.push(flag);
    // Support work rolls up the same way: summed where it is a quantity, and the
    // order is as blocked as any batch whose helper has stopped.
    found.support.delegated += row.support.delegated;
    found.support.approved += row.support.approved;
    found.support.outstanding += row.support.outstanding;
    found.support.paused += row.support.paused;
    found.support.reworkOpen += row.support.reworkOpen;
    if (row.support.blocking) found.support.blocking = true;
    for (const paused of row.support.pausedStages) {
      if (!found.support.pausedStages.some((entry) => entry.stage === paused.stage && entry.reason === paused.reason))
        found.support.pausedStages.push(paused);
    }
    byOrder.set(row.orderId, found);
  }
  return [...byOrder.values()]
    .map((order) => ({
      ...order,
      // Where the order as a whole is piling up, across its variants.
      stages: order.stages
        .reduce<{ stage: string; quantity: number }[]>((list, entry) => {
          const existing = list.find((item) => item.stage === entry.stage);
          if (existing) existing.quantity += entry.quantity;
          else list.push({ ...entry });
          return list;
        }, [])
        .sort((a, b) => b.quantity - a.quantity),
    }))
    .sort((a, b) => a.priority - b.priority || (a.daysToDue ?? 999999) - (b.daysToDue ?? 999999) || a.orderId - b.orderId);
}

/* -------------------------------------------------------------------------- */
/* One order, end to end.                                                      */
/* -------------------------------------------------------------------------- */

export type OrderFulfilment = {
  /** What the customer ordered: the sum of the order's own item quantities. */
  ordered: number;
  /** What was actually released onto the factory floor, across its batches. */
  releasedToProduction: number;
  /** Released but not yet finished and approved. */
  inProduction: number;
  /** Produced AND approved at the last stage of each batch's own frozen route. */
  approved: number;
  /** Ordered but not yet approved. Never negative. */
  remaining: number;
  assigned: number;
  awaitingInspection: number;
  rework: number;
  rejected: number;
  /**
   * Support work handed out from this order's stages.
   *
   * The order page and the control board read the SAME rollup, so "20 delegated, 15
   * approved, 5 still out" cannot differ between them - which matters because one of
   * those screens is the Owner's and one is the production manager's.
   */
  support: {
    delegated: number;
    approved: number;
    outstanding: number;
    paused: number;
    reworkOpen: number;
    blocking: boolean;
    pausedStages: { stage: string; reason: string | null }[];
  };
  packed: number;
  delivered: number;
  /** Approved and not yet shipped: what is genuinely ready to go out. */
  readyForDelivery: number;
  /** Ordered and not yet shipped. */
  undelivered: number;
  /**
   * Genuinely complete: everything ordered was produced and approved, and everything
   * ordered has been delivered. Derived from the ledger - never from the status column.
   */
  complete: boolean;
  /** What the status column claims, so a mismatch is visible rather than trusted. */
  statusSaysComplete: boolean;
  statusMatchesProduction: boolean;
  productionStarted: boolean;
  /**
   * The most that may still be packed or delivered against this order, and where that
   * figure came from. Once an order has entered production the ledger is the authority;
   * an order that never did - a historical order, or one satisfied entirely off the floor -
   * keeps the ceiling it has always had, so nothing that works today starts failing.
   */
  ceiling: number;
  ceilingSource: "production" | "ordered";
};

/**
 * The whole lifecycle of one order in derived figures: ordered -> released -> approved ->
 * packed -> delivered -> complete.
 *
 * Every quantity here comes from the production ledger and the packing and delivery records
 * that already exist. None of it can be typed in by hand, and none of it is a second
 * implementation: `approved` is the same figure the control board shows, summed by the same
 * `rollUpByOrder`, so the order page, the board and the packing and delivery guards cannot
 * disagree about how much of an order actually exists.
 */
export async function orderFulfilment(orderId: number): Promise<OrderFulfilment | null> {
  const [order] = await db
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) return null;

  // openOnly false: an order the ledger has already finished is exactly the one management
  // most needs to see the completion figures for.
  const control = await productionControl({ orderId, openOnly: false, limit: 500 });
  const rolled = rollUpByOrder(control.rows).find((entry) => entry.orderId === orderId);

  const [itemRow, batchRow, packRow, delRow] = await Promise.all([
    db.select({ total: sql<number>`coalesce(sum(${orderItems.quantity}), 0)` })
      .from(orderItems).where(eq(orderItems.orderId, orderId)),
    db.select({ total: sql<number>`coalesce(sum(${productionBatches.quantity}), 0)` })
      .from(productionBatches)
      .where(and(eq(productionBatches.orderId, orderId), sql`${productionBatches.status} <> 'CANCELLED'`)),
    db.select({ total: sql<number>`coalesce(sum(${packingRecords.quantityPacked}), 0)` })
      .from(packingRecords).where(eq(packingRecords.orderId, orderId)),
    db.select({ total: sql<number>`coalesce(sum(${deliveries.deliveredQuantity}), 0)` })
      .from(deliveries).where(eq(deliveries.orderId, orderId)),
  ]);

  const ordered = Number(itemRow[0]?.total) || 0;
  const released = Number(batchRow[0]?.total) || 0;
  const packed = Number(packRow[0]?.total) || 0;
  const delivered = Number(delRow[0]?.total) || 0;
  const approved = rolled?.finished ?? 0;
  const productionStarted = released > 0;

  const complete = ordered > 0 && approved >= ordered && delivered >= ordered;
  const statusSaysComplete = order.status === "COMPLETED";

  return {
    ordered,
    releasedToProduction: released,
    inProduction: Math.max(0, released - approved),
    approved,
    remaining: Math.max(0, ordered - approved),
    assigned: rolled?.assigned ?? 0,
    awaitingInspection: rolled?.awaitingInspection ?? 0,
    rework: rolled?.rework ?? 0,
    rejected: rolled?.rejected ?? 0,
    support: rolled?.support ?? {
      delegated: 0, approved: 0, outstanding: 0, paused: 0, reworkOpen: 0,
      blocking: false, pausedStages: [],
    },
    packed,
    delivered,
    readyForDelivery: Math.max(0, approved - delivered),
    undelivered: Math.max(0, ordered - delivered),
    complete,
    statusSaysComplete,
    statusMatchesProduction: statusSaysComplete === complete,
    productionStarted,
    ceiling: productionStarted ? approved : ordered,
    ceilingSource: productionStarted ? "production" : "ordered",
  };
}
