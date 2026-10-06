import { db } from "@/db";
import {
  orderItemSizes,
  productionBatches,
  productionOperations,
  productionRouteStages,
  productionRoutes,
} from "@/db/schema";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { MOVEMENT_EVENTS, applyMovements, type DerivedQuantities } from "@/lib/production-ledger";
import { STAGES, STAGE_ROLES, stageIndex, type ProductionMethod, PRODUCTION_METHODS } from "@/lib/format";

/**
 * ROUTE-DRIVEN PRODUCTION.
 *
 * WHAT WAS WRONG
 *   Every batch was forced through the same eight stages, created up front, in a
 *   fixed order hardcoded in five independent places. That meant:
 *     - a polo bought in cut-and-sew form still got a CUTTING row nobody could
 *       ever work, and the control board reported it as "stuck at CUTTING";
 *     - a ready-made cardigan got SEWING, MONOGRAMMING and BUTTONHOLE rows that
 *       could never be filled, and read as "waiting for SEWING" forever;
 *     - "the next stage" meant `STAGES[STAGES.indexOf(stage) + 1]`, a global array
 *       index, so a garment could not have its own order.
 *
 * WHAT THIS DOES INSTEAD
 *   A route is an ordered SUBSET of the existing stages. It may include all eight,
 *   skip stages, start later or end earlier. It never invents a stage - every
 *   `stage` value still comes from lib/format.ts, so roles, labels, inspection,
 *   separation of duties and payroll all keep working unchanged.
 *
 *   THE ROUTE IS FROZEN ONTO THE BATCH. A batch's own route is its set of
 *   `production_operations` rows read in `route_position` order. Nothing is copied
 *   into a snapshot column, because the operations ARE the snapshot: editing a
 *   product's route next month cannot rewrite what a batch already committed to,
 *   and deleting a route cannot orphan a batch in production.
 *
 *   LEGACY BATCHES KEEP WORKING. `route_position` is NULL on every operation that
 *   existed before routes did. For those, `frozenRoute` falls back to the
 *   eight-stage order, so no historical batch changes behaviour and no backfill is
 *   needed - which is why migration 0007 writes no data at all.
 */

/** Accepts the db handle or a transaction handle, like the other lib modules. */
type Db = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RouteStage = {
  position: number;
  stage: string;
  method: string;
  roleRequired: string | null;
  /** The route definition row this came from, when there was one. */
  routeStageId: number | null;
};

export type ResolvedRoute = {
  routeId: number | null;
  name: string;
  /** Where the route came from - recorded on the batch for auditability. */
  source: "explicit" | "product" | "organization" | "builtin";
  stages: RouteStage[];
};

/** The route Matesther has always run: all eight stages, all in-house. */
export function builtinRoute(): RouteStage[] {
  return STAGES.map((stage, index) => ({
    position: index + 1,
    stage,
    method: "INTERNAL",
    roleRequired: null,
    routeStageId: null,
  }));
}

/** Reject anything that is not a stage Matesther actually has. */
export function unknownStages(stages: string[]): string[] {
  return stages.filter((stage) => !(STAGES as readonly string[]).includes(stage));
}

/** Reject anything that is not one of the five production methods. */
export function unknownMethods(methods: string[]): string[] {
  return methods.filter((method) => !(PRODUCTION_METHODS as readonly string[]).includes(method));
}

/**
 * Normalise and validate a caller-supplied stage list into a route.
 *
 * Deliberately strict, and deliberately server-side: a route with a repeated
 * stage would create two rows competing to be "the" monogramming stage for one
 * batch, and a route with an invented stage would silently drop out of every
 * role, label and payroll lookup.
 */
export function normaliseStages(
  input: unknown
): { stages: RouteStage[] } | { error: string } {
  const raw = Array.isArray(input) ? input : [];
  if (!raw.length) return { error: "A route needs at least one stage." };
  if (raw.length > STAGES.length)
    return { error: `A route cannot have more than ${STAGES.length} stages.` };

  const seen = new Set<string>();
  const stages: RouteStage[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index] as { stage?: unknown; method?: unknown; roleRequired?: unknown };
    const stage = String(entry?.stage ?? "").trim().toUpperCase();
    if (!stage) return { error: `Stage ${index + 1} is missing.` };
    if (!(STAGES as readonly string[]).includes(stage))
      return { error: `${stage} is not one of Matesther's production stages.` };
    if (seen.has(stage)) return { error: `${stage} appears twice in this route.` };
    seen.add(stage);
    const requestedMethod = String(entry?.method ?? "INTERNAL").trim().toUpperCase();
    const method = (PRODUCTION_METHODS as readonly string[]).includes(requestedMethod)
      ? requestedMethod
      : "INTERNAL";
    const roleRequired = entry?.roleRequired ? String(entry.roleRequired).trim().slice(0, 60) || null : null;
    // A bought-in finished garment is how a route STARTS, not something that
    // happens part-way through making one. Allowing it mid-route would put a
    // purchase beside work already released from upstream, and nobody could say
    // which of the two the stage was holding.
    if (method === "READY_MADE" && index !== 0)
      return { error: `${stage} cannot be a ready-made purchase part-way through a route. A bought-in finished garment is where production starts - put it first, or make this stage in-house or outsourced.` };
    stages.push({ position: index + 1, stage, method, roleRequired, routeStageId: null });
  }
  return { stages };
}

/**
 * Resolve the route a NEW batch should be built from.
 *
 * Precedence, highest first:
 *   1. an explicit `stages` list on the request (a one-off route for this batch);
 *   2. an explicit `routeId`;
 *   3. the product's own default route;
 *   4. the organization's generic default route;
 *   5. the built-in eight-stage route.
 *
 * Falling all the way through to (5) is what makes this backwards compatible: a
 * request shaped exactly like the old one gets exactly the old eight stages.
 */
export async function resolveRoute(options: {
  organizationId?: number | null;
  productId?: number | null;
  routeId?: number | null;
  stages?: unknown;
}): Promise<ResolvedRoute | { error: string }> {
  if (Array.isArray(options.stages) && options.stages.length) {
    const normalised = normaliseStages(options.stages);
    if ("error" in normalised) return normalised;
    return { routeId: null, name: "One-off route for this batch", source: "explicit", stages: normalised.stages };
  }

  const byId = async (routeId: number): Promise<ResolvedRoute | null> => {
    const [route] = await db.select().from(productionRoutes).where(eq(productionRoutes.id, routeId)).limit(1);
    if (!route || !route.isActive) return null;
    const rows = await db
      .select()
      .from(productionRouteStages)
      .where(eq(productionRouteStages.routeId, route.id))
      .orderBy(asc(productionRouteStages.position));
    if (!rows.length) return null;
    return {
      routeId: route.id,
      name: route.name,
      source: "explicit",
      stages: rows.map((row, index) => ({
        position: row.position ?? index + 1,
        stage: row.stage,
        method: row.method,
        roleRequired: row.roleRequired,
        routeStageId: row.id,
      })),
    };
  };

  if (options.routeId) {
    const found = await byId(Number(options.routeId));
    if (!found) return { error: "That production route no longer exists or is inactive." };
    return found;
  }

  // The product's own default route, then the organization's generic default.
  const candidates = await db
    .select()
    .from(productionRoutes)
    .where(
      and(
        eq(productionRoutes.isDefault, true),
        eq(productionRoutes.isActive, true),
        options.productId
          ? eq(productionRoutes.productId, options.productId)
          : isNull(productionRoutes.productId)
      )
    )
    .limit(1);
  const productDefault = candidates[0];
  if (productDefault) {
    const found = await byId(productDefault.id);
    if (found) return { ...found, source: options.productId ? "product" : "organization" };
  }
  if (options.productId) {
    const [generic] = await db
      .select()
      .from(productionRoutes)
      .where(and(eq(productionRoutes.isDefault, true), eq(productionRoutes.isActive, true), isNull(productionRoutes.productId)))
      .limit(1);
    if (generic) {
      const found = await byId(generic.id);
      if (found) return { ...found, source: "organization" };
    }
  }

  return { routeId: null, name: "Matesther standard eight-stage route", source: "builtin", stages: builtinRoute() };
}

export type FrozenStage = RouteStage & {
  operationId: number;
  workerId: number | null;
  status: string;
  quantityReceived: number;
  quantityApproved: number;
};

/**
 * The route THIS BATCH is actually following - its own operations, in position
 * order. This is the frozen route: the authority on what comes next.
 *
 * `legacy` is true when the batch predates routes (no positions stored). Those
 * batches are ordered by the eight-stage list instead, so their behaviour is
 * byte-for-byte what it was before Task 3.
 */
export async function frozenRoute(handle: Db, batchId: number): Promise<{ stages: FrozenStage[]; legacy: boolean }> {
  const ops = await handle
    .select({
      id: productionOperations.id,
      stage: productionOperations.stage,
      method: productionOperations.method,
      routePosition: productionOperations.routePosition,
      routeStageId: productionOperations.routeStageId,
      workerId: productionOperations.workerId,
      status: productionOperations.status,
      quantityReceived: productionOperations.quantityReceived,
      quantityApproved: productionOperations.quantityApproved,
    })
    .from(productionOperations)
    .where(eq(productionOperations.productionBatchId, batchId));
  if (!ops.length) return { stages: [], legacy: false };

  const legacy = ops.every((op) => op.routePosition === null);
  const ordered = legacy
    ? [...ops].sort((a, b) => stageIndex(a.stage) - stageIndex(b.stage))
    : [...ops].sort((a, b) => (a.routePosition ?? 0) - (b.routePosition ?? 0));

  return {
    legacy,
    stages: ordered.map((op, index) => ({
      operationId: op.id,
      position: op.routePosition ?? index + 1,
      stage: op.stage,
      method: op.method ?? "INTERNAL",
      roleRequired: null,
      routeStageId: op.routeStageId,
      workerId: op.workerId,
      status: op.status,
      quantityReceived: op.quantityReceived,
      quantityApproved: op.quantityApproved,
    })),
  };
}

/**
 * The operation that follows `operation` in ITS OWN batch's route.
 *
 * This replaces `nextStage(op.stage)` plus a lookup by stage name, which assumed
 * every garment follows the same eight stages in the same order. Reading the
 * batch's own frozen route is what lets a polo skip CUTTING and a ready-made
 * cardigan start at PACKING without either one being reported as stuck at a stage
 * it does not have.
 */
export async function nextRouteOperation(
  handle: Db,
  operation: { id: number; productionBatchId: number; stage: string; routePosition: number | null }
): Promise<typeof productionOperations.$inferSelect | null> {
  const { stages } = await frozenRoute(handle, operation.productionBatchId);
  const index = stages.findIndex((stage) => stage.operationId === operation.id);
  if (index < 0 || index >= stages.length - 1) return null;
  const following = stages[index + 1];
  const [row] = await handle
    .select()
    .from(productionOperations)
    .where(eq(productionOperations.id, following.operationId))
    .limit(1);
  return row ?? null;
}

/**
 * The status a stage should show, given its derived quantities.
 *
 * One rule, used by internal inspection, external acceptance and ready-made
 * acceptance alike, so a stage cannot end up COMPLETED on one path and
 * IN_PROGRESS on another for the same numbers.
 *
 *   nothing outstanding          -> COMPLETED
 *   work back but not yet judged -> SUBMITTED
 *   otherwise                    -> IN_PROGRESS
 */
export function statusFromQuantities(derived: DerivedQuantities): "COMPLETED" | "SUBMITTED" | "IN_PROGRESS" {
  if (derived.quantityRemaining <= 0) return "COMPLETED";
  return derived.quantityCompleted > derived.quantityInspected ? "SUBMITTED" : "IN_PROGRESS";
}

/**
 * Release what this stage has had APPROVED into the next APPLICABLE ROUTE STAGE.
 *
 * This is the one place that moves quantity forward, and it is shared by:
 *   - POST /api/inspections        (internal work accepted by an inspector)
 *   - PUT  /api/external-work      (returned work accepted back from outside)
 *   - POST /api/ready-made         (a bought-in finished garment accepted)
 *
 * so all three obey the same rule: only the APPROVED figure is released, only into
 * the stage that actually follows in THIS batch's frozen route, and only as a
 * signed ledger delta - never by overwriting a counter.
 *
 * Returns the operation that received the work, or null when this is the last
 * stage of the route (packing/delivery, or wherever a short route ends).
 */
export async function releaseApprovedToNextStage(
  handle: Db,
  operation: { id: number; productionBatchId: number; stage: string; routePosition: number | null },
  approvedTotal: number,
  actor: { userId: number | null; name: string }
): Promise<typeof productionOperations.$inferSelect | null> {
  if (approvedTotal <= 0) return null;
  const next = await nextRouteOperation(handle, operation);
  if (!next) return null;
  const flow = approvedTotal - (next.quantityReceived ?? 0);
  if (flow > 0) {
    await applyMovements(handle, next, actor, [
      {
        type: MOVEMENT_EVENTS.STAGE_RECEIPT, quantity: flow, workerId: next.workerId,
        referenceType: "PRODUCTION_OPERATION", referenceId: operation.id,
        reason: `${flow} piece(s) approved at ${operation.stage} and released to ${next.stage}`,
      },
    ]);
    // A stage that has just been given work is workable. Leaving it PENDING meant
    // someone had to open every downstream job and flip its status by hand before
    // the worker assigned to it could submit anything.
    if (next.status === "PENDING") {
      await handle
        .update(productionOperations)
        .set({ status: "IN_PROGRESS" })
        .where(and(eq(productionOperations.id, next.id), eq(productionOperations.status, "PENDING")));
    }
  }
  const [refreshed] = await handle
    .select()
    .from(productionOperations)
    .where(eq(productionOperations.id, next.id))
    .limit(1);
  return refreshed ?? next;
}

/**
 * The role a stage requires, honouring a route-level override.
 *
 * `STAGE_ROLES` remains the default for every stage, so a batch created before
 * routes existed is gated exactly as it was. A route may name a different role for
 * a stage - which is how a route can demand a Packer at DELIVERY on one garment
 * and a Driver on another without a code change.
 */
export async function roleForStage(
  handle: Db,
  operation: { stage: string; routeStageId: number | null }
): Promise<string | null> {
  if (operation.routeStageId) {
    const [routeStage] = await handle
      .select({ roleRequired: productionRouteStages.roleRequired })
      .from(productionRouteStages)
      .where(eq(productionRouteStages.id, operation.routeStageId))
      .limit(1);
    if (routeStage?.roleRequired) return routeStage.roleRequired;
  }
  return STAGE_ROLES[operation.stage as keyof typeof STAGE_ROLES] ?? null;
}

/**
 * How many of one exact variant are FINISHED - derived from the production ledger,
 * not typed in.
 *
 * `order_item_sizes.completed` used to be a free-text field: a quantity with no
 * event behind it, editable by anyone with an Owner session and recorded nowhere.
 * The truthful figure is the quantity approved at the LAST stage of each batch
 * producing that variant, summed across those batches. That is what this returns.
 *
 * A batch whose route ends at IRONING contributes its IRONING approvals; a batch
 * that runs all the way to DELIVERY contributes its DELIVERY approvals. Neither is
 * compared against a stage it does not have.
 */
export type VariantCompletion = {
  /**
   * Garments of this exact variant that are FINISHED: approved at the last stage of each
   * batch producing it, summed across those batches. Submitted, uninspected, rework and
   * rejected quantities are not in here, and a stage in the middle of a route cannot
   * contribute - only the batch's own final stage can.
   */
  completed: number;
  /**
   * Whether any live batch has ever been produced against this variant. This is what makes
   * the figure authoritative: a variant WITH production is reported from the ledger even when
   * the ledger says zero, while a variant with no production at all keeps whatever figure was
   * recorded against it, because there is no ledger to consult and quietly zeroing a number
   * somebody wrote down is exactly the kind of silent overwrite this system refuses.
   */
  produced: boolean;
};

/** The final stage of one batch's OWN frozen route, not of the house eight-stage list. */
function lastStageOfBatch(
  list: { stage: string; routePosition: number | null; quantityApproved: number | null }[]
) {
  return [...list].sort((a, b) =>
    a.routePosition !== null || b.routePosition !== null
      ? (b.routePosition ?? 0) - (a.routePosition ?? 0)
      : stageIndex(b.stage) - stageIndex(a.stage)
  )[0];
}

/**
 * How many of EACH exact variant are finished, in two queries however many variants are
 * asked for.
 *
 * The single-variant `completedForVariant` below is now a wrapper on this. It used to be the
 * other way round: the order-sizes endpoint called it once per variant inside a
 * `Promise.all`, which is three queries per variant - an order with twelve size/colour
 * combinations ran thirty-six queries to draw one table. Nothing about the arithmetic has
 * changed, only how many round trips it takes to do it.
 *
 * A batch whose route ends at IRONING contributes its IRONING approvals; a batch that runs
 * all the way to DELIVERY contributes its DELIVERY approvals. Neither is compared against a
 * stage it does not have, and no batch can contribute twice: exactly one stage per batch is
 * read, its own last.
 */
export async function completedForVariants(variantIds: number[]): Promise<Map<number, VariantCompletion>> {
  const result = new Map<number, VariantCompletion>();
  const ids = [...new Set(variantIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  for (const id of ids) result.set(id, { completed: 0, produced: false });
  if (!ids.length) return result;

  const batches = await db
    .select({
      id: productionBatches.id,
      variantId: productionBatches.orderVariantId,
      status: productionBatches.status,
    })
    .from(productionBatches)
    .where(inArray(productionBatches.orderVariantId, ids));

  const batchToVariant = new Map<number, number>();
  const liveBatchIds: number[] = [];
  for (const batch of batches) {
    if (batch.variantId === null || batch.status === "CANCELLED") continue;
    batchToVariant.set(batch.id, batch.variantId);
    liveBatchIds.push(batch.id);
    // A live batch means this variant HAS production, so the ledger is the authority from
    // here on - even if nothing has been approved yet.
    result.set(batch.variantId, { completed: 0, produced: true });
  }
  if (!liveBatchIds.length) return result;

  const ops = await db
    .select({
      batchId: productionOperations.productionBatchId,
      stage: productionOperations.stage,
      routePosition: productionOperations.routePosition,
      quantityApproved: productionOperations.quantityApproved,
    })
    .from(productionOperations)
    .where(inArray(productionOperations.productionBatchId, liveBatchIds));

  const byBatch = new Map<number, typeof ops>();
  for (const op of ops) {
    const list = byBatch.get(op.batchId) ?? [];
    list.push(op);
    byBatch.set(op.batchId, list);
  }
  for (const [batchId, list] of byBatch) {
    if (!list.length) continue;
    const variantId = batchToVariant.get(batchId);
    if (variantId === undefined) continue;
    const entry = result.get(variantId) ?? { completed: 0, produced: true };
    entry.completed += lastStageOfBatch(list).quantityApproved ?? 0;
    result.set(variantId, entry);
  }
  return result;
}

/**
 * How many of ONE exact variant are finished - derived from the production ledger, not typed
 * in. `order_item_sizes.completed` used to be a free-text field: a quantity with no event
 * behind it, editable by anyone with an Owner session and recorded nowhere. The truthful
 * figure is the quantity approved at the LAST stage of each batch producing that variant.
 */
export async function completedForVariant(variantId: number): Promise<number> {
  const derived = await completedForVariants([variantId]);
  return derived.get(variantId)?.completed ?? 0;
}

/** Every route, with its stages, for the route editor. */
export async function listRoutes(productId?: number | null) {
  const routes = await db
    .select()
    .from(productionRoutes)
    .orderBy(asc(productionRoutes.productId), asc(productionRoutes.name));
  const ids = routes.map((route) => route.id);
  const stageRows = ids.length
    ? await db.select().from(productionRouteStages).where(inArray(productionRouteStages.routeId, ids)).orderBy(asc(productionRouteStages.position))
    : [];
  const byRoute = new Map<number, typeof stageRows>();
  for (const row of stageRows) {
    const list = byRoute.get(row.routeId) ?? [];
    list.push(row);
    byRoute.set(row.routeId, list);
  }
  const shaped = routes.map((route) => ({ ...route, stages: byRoute.get(route.id) ?? [] }));
  return productId === undefined ? shaped : shaped.filter((route) => route.productId === productId);
}

/** How much of a variant is still unallocated, computed server-side. */
export async function variantAvailability(variantId: number): Promise<{ ordered: number; allocated: number; available: number }> {
  const [variant] = await db.select().from(orderItemSizes).where(eq(orderItemSizes.id, variantId)).limit(1);
  if (!variant) return { ordered: 0, allocated: 0, available: 0 };
  const [row] = await db
    .select({ allocated: sql`coalesce(sum(${productionBatches.quantity}), 0)` })
    .from(productionBatches)
    .where(and(eq(productionBatches.orderVariantId, variantId), sql`${productionBatches.status} <> 'CANCELLED'`));
  const allocated = Number(row?.allocated ?? 0);
  const ordered = variant.quantity ?? 0;
  return { ordered, allocated, available: Math.max(0, ordered - allocated) };
}

export type { ProductionMethod };
