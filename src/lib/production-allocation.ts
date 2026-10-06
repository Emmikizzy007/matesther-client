import { db } from "@/db";
import { productionAllocations, productionOperations, workers } from "@/db/schema";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { MOVEMENT_EVENTS, applyMovements, deriveQuantities } from "@/lib/production-ledger";

/**
 * PRODUCTION ALLOCATIONS: one exact stage, split across several workers.
 *
 * The problem this solves is concrete. 100 navy size-10 polos reach SEWING. Three
 * tailors will work them: 40, 35 and 25. Before this module the only way to express
 * that was three batches - which fragments the variant, fragments the route, and
 * makes the order's own allocation ceiling harder to see. `production_operations`
 * holds ONE `worker_id`, so a stage could only ever belong to one person.
 *
 * This is a SUB-TABLE, not more stage rows. Migration 0006 made
 * (production_batch_id, stage) unique and migration 0007 made
 * (production_batch_id, route_position) unique, because "the next applicable stage"
 * must be unambiguous. Both stay. The constraint that actually blocked several
 * workers was the single worker_id column, and that is what evolves here - the same
 * shape `support_assignments` already uses against its parent operation, so this is
 * not a second production system.
 *
 * THE TWO THINGS THAT MUST NOT CHANGE
 *   1. The movement ledger stays the only source of a stage's quantities. An
 *      allocation splits what the stage ALREADY HOLDS; it never creates quantity.
 *      `WORKER_ALLOCATION` events are recorded in NO derived bucket, exactly like
 *      `EXTERNAL_SENT`, so allocating work cannot inflate a counter.
 *   2. Approved quantity stays the sole source of downstream availability. Splitting
 *      a stage across three workers changes WHO is credited, never HOW MUCH moves
 *      on: `releaseApprovedToNextStage` still reads the stage's approved total.
 *
 * A STAGE WITH NO ALLOCATION ROWS BEHAVES EXACTLY AS IT DID BEFORE. That is every
 * historical stage, which is why migration 0008 writes no data and needs no
 * backfill.
 */

/** Accepts the db handle or a transaction handle, like the other lib modules. */
type Db = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const ALLOC_STATUSES = ["ASSIGNED", "ACTIVE", "COMPLETED", "TRANSFERRED", "CANCELLED"] as const;
/** An allocation that still holds work. Closed rows are audit trail only. */
export const LIVE_ALLOC_STATUSES: string[] = ["ASSIGNED", "ACTIVE"];

export type Actor = { userId: number | null; name: string };

export type Allocation = typeof productionAllocations.$inferSelect;

/** What a worker may still submit against one allocation. */
export function allocationRemaining(allocation: {
  quantityAllocated: number; quantitySubmitted: number;
}): number {
  return Math.max(0, (allocation.quantityAllocated ?? 0) - (allocation.quantitySubmitted ?? 0));
}

/** Submitted work on one allocation that no inspection has judged yet. */
export function allocationUnjudged(allocation: {
  quantitySubmitted: number; quantityApproved: number; quantityRework: number; quantityRejected: number;
}): number {
  return Math.max(
    0,
    (allocation.quantitySubmitted ?? 0) -
      (allocation.quantityApproved ?? 0) -
      (allocation.quantityRework ?? 0) -
      (allocation.quantityRejected ?? 0)
  );
}

/** Live allocations for one stage, oldest first (a stable order for the UI). */
export async function liveAllocations(handle: Db, operationId: number): Promise<Allocation[]> {
  return handle
    .select()
    .from(productionAllocations)
    .where(
      and(
        eq(productionAllocations.productionOperationId, operationId),
        inArray(productionAllocations.status, LIVE_ALLOC_STATUSES)
      )
    )
    .orderBy(asc(productionAllocations.id));
}

/** Every allocation for one stage, including closed ones - the audit trail. */
export async function allocationsIncludingClosed(handle: Db, operationId: number): Promise<Allocation[]> {
  return handle
    .select()
    .from(productionAllocations)
    .where(eq(productionAllocations.productionOperationId, operationId))
    .orderBy(asc(productionAllocations.id));
}

/**
 * How many garments at a stage are NOT yet spoken for by any worker.
 *
 * The ceiling every split is checked against: the stage's held quantity comes from
 * the movement ledger (what the previous route stage actually approved into it),
 * and what is subtracted is the sum of the live allocations. Neither side is a
 * typed figure, so the sum of the shares can never exceed what the stage holds.
 */
export async function deriveFree(handle: Db, operationId: number): Promise<{ holds: number; allocated: number; free: number }> {
  const derived = await deriveQuantities(handle, operationId);
  const existing = await liveAllocations(handle, operationId);
  const allocated = allocatedTotal(existing);
  return { holds: derived.quantityReceived, allocated, free: Math.max(0, derived.quantityReceived - allocated) };
}

/** How much of a stage is already spoken for by live allocations. */
export function allocatedTotal(allocations: { quantityAllocated: number }[]): number {
  return allocations.reduce((sum, row) => sum + (row.quantityAllocated ?? 0), 0);
}

/**
 * Carry over work already submitted before the stage was split.
 *
 * A stage may have been worked by its single assigned worker for days before anyone
 * decides to split it. Those submitted pieces are real, they belong to that worker,
 * and they are owed pay for them - so they cannot be left outside the allocation
 * set, where an inspection would have no allocation to attribute them to.
 *
 * This is not a guess and not a policy choice: it records a fact that already
 * exists. The original worker gets an allocation exactly equal to what they already
 * submitted, marked as carried over, and the split then happens around it within
 * what is left of the stage's own ceiling.
 */
export async function ensureCarryOverAllocation(
  handle: Db,
  operation: typeof productionOperations.$inferSelect,
  actor: Actor
): Promise<Allocation | null> {
  const existing = await liveAllocations(handle, operation.id);
  if (existing.length) return null;
  // `quantity_completed` is this schema's name for work a worker has submitted.
  if (!operation.workerId || operation.quantityCompleted <= 0) return null;
  if (operation.quantityCompleted > operation.quantityReceived) return null;
  const [row] = await handle
    .insert(productionAllocations)
    .values({
      productionOperationId: operation.id,
      productionBatchId: operation.productionBatchId,
      stage: operation.stage,
      workerId: operation.workerId,
      // The rate already agreed for this stage travels with the work already done.
      pieceRate: operation.pieceRate,
      quantityAllocated: operation.quantityCompleted,
      quantitySubmitted: operation.quantityCompleted,
      quantityApproved: operation.quantityApproved,
      quantityRework: operation.quantityRework,
      quantityRejected: operation.quantityRejected,
      status: "ACTIVE",
      assignedByUserId: actor.userId,
      assignedByName: actor.name,
      reason: "Carried over from this stage's original single assignment, so work already submitted stays attributed to the person who did it",
    })
    .returning();
  return row;
}

/**
 * Give `quantity` of one stage to one worker.
 *
 * The ceiling is the stage's own held quantity, read from the movement ledger -
 * never a typed figure - minus what live allocations already claim. So the sum of
 * the splits can never exceed what the previous stage actually approved into this
 * one, which is the over-allocation guarantee applied one level down.
 *
 * Allocating to a worker who already holds a live allocation on this stage
 * increases that allocation rather than opening a second one, so the partial unique
 * index and the arithmetic agree.
 */
export async function allocate(
  handle: Db,
  operation: typeof productionOperations.$inferSelect,
  actor: Actor,
  input: { workerId: number; quantity: number; pieceRate?: number | null; reason?: string | null; notes?: string | null }
): Promise<Allocation> {
  const existing = await liveAllocations(handle, operation.id);
  const derived = await deriveQuantities(handle, operation.id);
  const free = Math.max(0, derived.quantityReceived - allocatedTotal(existing));
  if (input.quantity > free) {
    throw new AllocationError(
      free > 0
        ? `Only ${free} of the ${derived.quantityReceived} garment(s) at this stage are still unallocated. ${allocatedTotal(existing)} are already assigned to other workers.`
        : `All ${derived.quantityReceived} garment(s) at this stage are already allocated to workers.`
    );
  }
  const mine = existing.find((row) => row.workerId === input.workerId);
  const pieceRate = input.pieceRate === undefined ? null : input.pieceRate;

  const saved = await upsertAllocation(handle, operation, actor, input, mine, pieceRate);

  // Recorded on the ledger with the worker and the quantity, but in NO derived
  // bucket: splitting work between people does not create a single garment. The
  // stage's counters are unaffected, which is the point.
  await applyMovements(handle, operation, actor, [{
    type: "WORKER_ALLOCATION",
    quantity: input.quantity,
    workerId: input.workerId,
    referenceType: "PRODUCTION_ALLOCATION",
    referenceId: saved.id,
    reason: input.reason?.trim() ||
      `${input.quantity} of ${derived.quantityReceived} garment(s) at ${operation.stage} allocated to a worker`,
    notes: input.notes ?? null,
  }]);
  return saved;
}

async function upsertAllocation(
  handle: Db,
  operation: typeof productionOperations.$inferSelect,
  actor: Actor,
  input: { workerId: number; quantity: number; reason?: string | null; notes?: string | null },
  mine: Allocation | undefined,
  pieceRate: number | null
): Promise<Allocation> {
  if (mine) {
    const [row] = await handle
      .update(productionAllocations)
      .set({
        quantityAllocated: mine.quantityAllocated + input.quantity,
        // A rate is only ever set, never silently cleared: an agreed rate that has
        // already been worked against must survive an increase in quantity.
        pieceRate: pieceRate === null ? mine.pieceRate : pieceRate,
        status: mine.quantitySubmitted > 0 ? "ACTIVE" : mine.status,
        notes: input.notes ?? mine.notes,
      })
      .where(eq(productionAllocations.id, mine.id))
      .returning();
    return row;
  }
  const [row] = await handle
    .insert(productionAllocations)
    .values({
      productionOperationId: operation.id,
      productionBatchId: operation.productionBatchId,
      stage: operation.stage,
      workerId: input.workerId,
      pieceRate,
      quantityAllocated: input.quantity,
      status: "ASSIGNED",
      assignedByUserId: actor.userId,
      assignedByName: actor.name,
      reason: input.reason?.trim() || null,
      notes: input.notes ?? null,
    })
    .returning();
  return row;
}

/** Raised for a business-rule refusal, so a route can answer 400 rather than 500. */
export class AllocationError extends Error {}

/**
 * Move the UNWORKED remainder of an allocation to another worker.
 *
 * This is the reassignment the old model could not do. `PUT /api/operations`
 * refuses to change a stage's worker once the stage has any production history,
 * because the single `worker_id` column carried that history with it - changing it
 * would have moved approved work, and the pay for it, to somebody else.
 *
 * A transfer cannot do that, by construction:
 *   - only `quantity_allocated - quantity_submitted` moves;
 *   - what the original worker already submitted stays theirs, along with every
 *     approval it earns and therefore every naira it pays;
 *   - the old row is closed (TRANSFERRED, or CANCELLED if it was never worked) and
 *     kept, and the new row points back at it with the reason, so the trail shows
 *     who had the work first, how much they did, and why it moved.
 */
export async function transferAllocation(
  handle: Db,
  allocationId: number,
  actor: Actor,
  input: { toWorkerId: number; reason: string; pieceRate?: number | null }
): Promise<{ closed: Allocation; opened: Allocation; moved: number }> {
  const [current] = await handle
    .select()
    .from(productionAllocations)
    .where(eq(productionAllocations.id, allocationId))
    .limit(1);
  if (!current) throw new AllocationError("Allocation not found.");
  if (!LIVE_ALLOC_STATUSES.includes(current.status))
    throw new AllocationError("That allocation is already closed. Its history stays with the worker who did the work.");
  if (current.workerId === input.toWorkerId)
    throw new AllocationError("That worker already holds this allocation.");
  if (!input.reason || input.reason.trim().length < 5)
    throw new AllocationError("Explain why this work is moving to another worker. The reason is kept on the audit trail.");

  const [operation] = await handle
    .select()
    .from(productionOperations)
    .where(eq(productionOperations.id, current.productionOperationId))
    .limit(1);
  if (!operation) throw new AllocationError("The production stage behind this allocation no longer exists.");

  const moved = allocationRemaining(current);
  if (moved < 1)
    throw new AllocationError(
      `${current.quantitySubmitted} of the ${current.quantityAllocated} garment(s) were already submitted, so there is no unworked quantity left to move. The submitted work stays with the worker who did it.`
    );

  const existing = await liveAllocations(handle, operation.id);
  const target = existing.find((row) => row.workerId === input.toWorkerId);
  if (target)
    throw new AllocationError(
      "That worker already holds a live allocation on this stage. Increase theirs instead of transferring a second one."
    );

  const [closed] = await handle
    .update(productionAllocations)
    .set({
      // Keep exactly what they worked; the rest leaves.
      quantityAllocated: current.quantitySubmitted,
      status: current.quantitySubmitted > 0 ? "TRANSFERRED" : "CANCELLED",
      reason: input.reason.trim(),
      notes: current.notes,
    })
    .where(eq(productionAllocations.id, current.id))
    .returning();

  const [opened] = await handle
    .insert(productionAllocations)
    .values({
      organizationId: current.organizationId,
      productionOperationId: current.productionOperationId,
      productionBatchId: current.productionBatchId,
      stage: current.stage,
      workerId: input.toWorkerId,
      pieceRate: input.pieceRate === undefined || input.pieceRate === null ? current.pieceRate : input.pieceRate,
      quantityAllocated: moved,
      status: "ASSIGNED",
      assignedByUserId: actor.userId,
      assignedByName: actor.name,
      transferredFromId: current.id,
      reason: input.reason.trim(),
      notes: null,
    })
    .returning();

  await applyMovements(handle, operation, actor, [{
    type: MOVEMENT_EVENTS.REASSIGNMENT,
    quantity: 0,
    audit: true,
    workerId: input.toWorkerId,
    referenceType: "PRODUCTION_ALLOCATION",
    referenceId: opened.id,
    reason: `${moved} unworked garment(s) moved to another worker at ${operation.stage}: ${input.reason.trim()}`,
  }]);
  return { closed, opened, moved };
}

/**
 * Change how many garments an allocation holds.
 *
 * Bounded both ways: it may not take the stage above what it holds (the same
 * ceiling `allocate` enforces), and it may not go below what this worker already
 * submitted, because submitted work belongs to them and to their pay.
 */
export async function resizeAllocation(
  handle: Db,
  allocationId: number,
  actor: Actor,
  input: { quantity: number; reason: string }
): Promise<Allocation> {
  const [current] = await handle
    .select()
    .from(productionAllocations)
    .where(eq(productionAllocations.id, allocationId))
    .limit(1);
  if (!current) throw new AllocationError("Allocation not found.");
  if (!LIVE_ALLOC_STATUSES.includes(current.status))
    throw new AllocationError("That allocation is closed and cannot be resized.");
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 0)
    throw new AllocationError("The allocated quantity must be a non-negative whole number.");
  if (input.quantity < current.quantitySubmitted)
    throw new AllocationError(
      `This worker already submitted ${current.quantitySubmitted} garment(s). An allocation cannot be reduced below work that is already in, and already theirs to be paid for.`
    );
  if (!input.reason || input.reason.trim().length < 5)
    throw new AllocationError("Explain why this allocation is changing. The reason is kept on the audit trail.");

  const [operation] = await handle
    .select()
    .from(productionOperations)
    .where(eq(productionOperations.id, current.productionOperationId))
    .limit(1);
  if (!operation) throw new AllocationError("The production stage behind this allocation no longer exists.");

  const others = (await liveAllocations(handle, operation.id)).filter((row) => row.id !== current.id);
  const derived = await deriveQuantities(handle, operation.id);
  const free = Math.max(0, derived.quantityReceived - allocatedTotal(others));
  if (input.quantity > free)
    throw new AllocationError(
      `This stage holds ${derived.quantityReceived} garment(s) and ${allocatedTotal(others)} are allocated to other workers, so this allocation cannot exceed ${free}.`
    );

  const [row] = await handle
    .update(productionAllocations)
    .set({
      quantityAllocated: input.quantity,
      status: input.quantity === current.quantitySubmitted && current.quantitySubmitted > 0 ? "COMPLETED" : current.quantitySubmitted > 0 ? "ACTIVE" : "ASSIGNED",
      reason: input.reason.trim(),
    })
    .where(eq(productionAllocations.id, current.id))
    .returning();

  const delta = input.quantity - current.quantityAllocated;
  if (delta !== 0) {
    await applyMovements(handle, operation, actor, [{
      type: "WORKER_ALLOCATION",
      quantity: delta,
      workerId: current.workerId,
      referenceType: "PRODUCTION_ALLOCATION",
      referenceId: row.id,
      reason: `Allocation changed from ${current.quantityAllocated} to ${input.quantity}: ${input.reason.trim()}`,
    }]);
  }
  return row;
}

/**
 * Record a worker's submission against their own allocation.
 *
 * Returns the allocation the submission landed on, or null when the stage has no
 * allocations at all - which is the legacy single-worker case, where the caller
 * falls back to `production_operations.worker_id` exactly as it did before.
 */
export async function submitAgainstAllocation(
  handle: Db,
  operation: typeof productionOperations.$inferSelect,
  workerId: number,
  quantity: number
): Promise<Allocation | null | { error: string }> {
  const existing = await liveAllocations(handle, operation.id);
  if (!existing.length) return null;
  const mine = existing.find((row) => row.workerId === workerId);
  if (!mine)
    return {
      error: `This stage is split between ${existing.length} worker${existing.length === 1 ? "" : "s"} and you do not hold a share of it. Your work is on the stages allocated to you.`,
    };
  const free = allocationRemaining(mine);
  if (quantity > free)
    return {
      error: `You are allocated ${mine.quantityAllocated} garment(s) at this stage and have already submitted ${mine.quantitySubmitted}, so you can submit between 1 and ${free}.`,
    };
  const [row] = await handle
    .update(productionAllocations)
    .set({ quantitySubmitted: mine.quantitySubmitted + quantity, status: "ACTIVE" })
    .where(eq(productionAllocations.id, mine.id))
    .returning();
  return row;
}

/* ---------------------------------------------------------------------------
 * ATTRIBUTING AN INSPECTION ACROSS A SPLIT STAGE
 * ------------------------------------------------------------------------- */

export type Attribution = { allocationId: number; approved: number; rework: number; rejected: number };

/**
 * Check a caller-supplied per-worker breakdown of one inspection.
 *
 * DELIBERATELY NOT GUESSED. When a stage is split, deciding which worker's pieces
 * were the approved ones and which were the rejects is a business fact that only
 * the person standing at the inspection table knows. Inventing a rule here - oldest
 * submission first, or pro-rata by allocation - would silently decide who gets paid
 * for the good work and who carries the rejects, and no part of this codebase can
 * tell us which rule Matesther uses. So a split stage must be attributed
 * explicitly, and this function is what makes that attribution safe:
 *
 *   - every named allocation must be live and belong to this stage;
 *   - no allocation may be judged beyond the work it actually has un-judged;
 *   - the three columns must sum to exactly the inspection's own three totals, so
 *     the per-worker split and the stage's ledger can never disagree.
 *
 * A stage with one worker, or with none, needs no attribution at all and keeps
 * behaving exactly as it did before split allocation existed.
 */
export function validateAttributions(
  allocations: Allocation[],
  attributions: unknown,
  totals: { approved: number; rework: number; rejected: number }
): { ok: true; rows: Attribution[] } | { ok: false; error: string } {
  if (!Array.isArray(attributions))
    return { ok: false, error: "Pass an attributions list naming each worker's share of this inspection." };
  const live = new Map(allocations.map((row) => [row.id, row]));
  const seen = new Set<number>();
  const rows: Attribution[] = [];
  let approved = 0, rework = 0, rejected = 0;
  for (const entry of attributions) {
    const allocationId = Number((entry as any)?.allocationId);
    const allocation = live.get(allocationId);
    if (!allocation)
      return { ok: false, error: `Allocation ${allocationId} is not a live allocation on this stage.` };
    if (seen.has(allocationId))
      return { ok: false, error: `Allocation ${allocationId} appears twice. Give each worker one line.` };
    seen.add(allocationId);
    const a = Number((entry as any)?.quantityApproved ?? 0);
    const r = Number((entry as any)?.quantityRework ?? 0);
    const j = Number((entry as any)?.quantityRejected ?? 0);
    if (![a, r, j].every((value) => Number.isSafeInteger(value) && value >= 0))
      return { ok: false, error: "Attributed quantities must be non-negative whole garments." };
    const unjudged = allocationUnjudged(allocation);
    if (a + r + j > unjudged)
      return {
        ok: false,
        error: `Only ${unjudged} of this worker's submitted garment(s) are awaiting judgement, so ${a + r + j} cannot be attributed to them.`,
      };
    rows.push({ allocationId, approved: a, rework: r, rejected: j });
    approved += a; rework += r; rejected += j;
  }
  if (approved !== totals.approved || rework !== totals.rework || rejected !== totals.rejected)
    return {
      ok: false,
      error: `The per-worker shares must add up to the inspection itself: approved ${approved} of ${totals.approved}, rework ${rework} of ${totals.rework}, rejected ${rejected} of ${totals.rejected}.`,
    };
  return { ok: true, rows };
}

/** Every worker with a live allocation on any of these stages, for list views. */
export async function allocationsByOperation(operationIds: number[]): Promise<Map<number, Allocation[]>> {
  const out = new Map<number, Allocation[]>();
  if (!operationIds.length) return out;
  const rows = await db
    .select()
    .from(productionAllocations)
    .where(and(inArray(productionAllocations.productionOperationId, operationIds), inArray(productionAllocations.status, LIVE_ALLOC_STATUSES)))
    .orderBy(asc(productionAllocations.id));
  for (const row of rows) {
    const list = out.get(row.productionOperationId) ?? [];
    list.push(row);
    out.set(row.productionOperationId, list);
  }
  return out;
}

/**
 * Which stages a worker has ANY allocation on - what makes their dashboard exact.
 *
 * Deliberately NOT restricted to live shares. Visibility is not authority: the
 * moment a share is fully judged it becomes COMPLETED, and if that hid the stage the
 * worker would lose their own earnings history and their completed-jobs list at the
 * exact instant they finished the work. What a worker may still SUBMIT against is
 * governed separately, by `liveAllocations`, which is restricted to live shares.
 */
export async function operationIdsForWorker(workerId: number): Promise<number[]> {
  const rows = await db
    .select({ operationId: productionAllocations.productionOperationId })
    .from(productionAllocations)
    .where(eq(productionAllocations.workerId, workerId));
  return [...new Set(rows.map((row) => row.operationId))];
}

/**
 * Every stage that has EVER been split.
 *
 * Needed by any view that also aggregates `production_operations.worker_id`: a split
 * stage still names one worker on the stage row, so counting BOTH the stage and its
 * allocations would credit that worker with the whole stage on top of their own
 * share. Callers must exclude these stages from the legacy per-stage aggregate.
 *
 * Closed shares are included on purpose. Once a share is COMPLETED the stage is no
 * longer "live", but the stage row still names its first worker - so excluding it
 * here while the allocation totals also ignored it would make the work vanish from
 * both halves of the sum.
 */
export async function operationIdsWithAllocations(): Promise<number[]> {
  const rows = await db.select({ operationId: productionAllocations.productionOperationId }).from(productionAllocations);
  return [...new Set(rows.map((row) => row.operationId))];
}

/**
 * Per-worker totals across every allocation they have ever held.
 *
 * Lifetime sums, matching what the legacy per-stage aggregate has always reported:
 * the Workers page shows what a person has been given and got approved in total, not
 * only what is open right now. `activeStages` is the count that still has work in
 * it, which is what feeds "current tasks".
 */
export async function allocatedTotalsByWorker(): Promise<Map<number, {
  allocated: number; submitted: number; approved: number; rejected: number; stages: number; activeStages: number;
}>> {
  const rows = await db
    .select({
      workerId: productionAllocations.workerId,
      stages: sql<number>`count(*)`,
      activeStages: sql<number>`coalesce(sum(case when ${productionOperations.status} in ('IN_PROGRESS', 'SUBMITTED') then 1 else 0 end), 0)`,
      allocated: sql<number>`coalesce(sum(${productionAllocations.quantityAllocated}), 0)`,
      submitted: sql<number>`coalesce(sum(${productionAllocations.quantitySubmitted}), 0)`,
      approved: sql<number>`coalesce(sum(${productionAllocations.quantityApproved}), 0)`,
      rejected: sql<number>`coalesce(sum(${productionAllocations.quantityRejected}), 0)`,
    })
    .from(productionAllocations)
    .innerJoin(productionOperations, eq(productionOperations.id, productionAllocations.productionOperationId))
    .groupBy(productionAllocations.workerId);
  return new Map(
    rows.map((row) => [
      Number(row.workerId),
      {
        stages: Number(row.stages) || 0,
        activeStages: Number(row.activeStages) || 0,
        allocated: Number(row.allocated) || 0,
        submitted: Number(row.submitted) || 0,
        approved: Number(row.approved) || 0,
        rejected: Number(row.rejected) || 0,
      },
    ])
  );
}

/** Worker names for a set of allocations, one indexed lookup. */
export async function workerNames(workerIds: number[]): Promise<Map<number, string>> {
  if (!workerIds.length) return new Map();
  const rows = await db.select({ id: workers.id, name: workers.name }).from(workers).where(inArray(workers.id, workerIds));
  return new Map(rows.map((row) => [row.id, row.name]));
}
