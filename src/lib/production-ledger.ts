import { db } from "@/db";
import { productionMovements, productionOperations } from "@/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

/**
 * THE PRODUCTION MOVEMENT LEDGER.
 *
 * `production_operations` stores seven quantity counters. Until now two routes
 * could write those counters directly, so a quantity could be moved with no
 * record of who moved it, when or why - and could even be moved *below* the
 * figure its own inspection history proves.
 *
 * This module makes the ledger the source of truth and the counters a derived
 * cache:
 *
 *   quantity_received  = ALLOCATION + STAGE_RECEIPT + RECEIVED_CORRECTION
 *   quantity_completed = SUBMISSION + SUBMITTED_CORRECTION
 *   quantity_approved  = INSPECTION_APPROVED
 *   quantity_rework    = INSPECTION_REWORK
 *   quantity_rejected  = INSPECTION_REJECTED + REJECTED_CORRECTION
 *   quantity_inspected = approved + rework + rejected
 *   quantity_remaining = max(0, received - approved - rejected)
 *
 * Every one of those formulas is exactly what the previous hand-written
 * arithmetic produced, so no historical figure changes meaning. What changes is
 * that a quantity can now only move by appending an event, and a correction is
 * itself an event carrying a reason, an actor and a timestamp.
 *
 * TASK 3 FORWARD COMPATIBILITY (two obligations, both deliberate):
 *   1. `event_type` is DATA, never a closed enum in code. Task 3 adds
 *      SENT_EXTERNAL / RETURNED_EXTERNAL / ACCEPTED_RETURN / RECEIVED_READYMADE /
 *      MATERIAL_ISSUED rows to this same table. Unknown event types are IGNORED
 *      by derivation on purpose: a new type cannot silently corrupt a counter,
 *      it has to be mapped into a bucket explicitly before it counts.
 *   2. `stage` is stored on every row, so stage identity never depends on a
 *      row's position in a global eight-element array. When garments stop
 *      following the same eight stages, a route position replaces the index and
 *      the ledger needs no change.
 *
 * Rows are append-only. Nothing here updates or deletes a movement.
 */

/** Event vocabulary. Stored as text so Task 3 can extend it without a migration. */
export const MOVEMENT_EVENTS = {
  /** Quantity placed in front of a stage when a batch is created. */
  ALLOCATION: "ALLOCATION",
  /** Approved quantity that flowed in from the previous stage. */
  STAGE_RECEIPT: "STAGE_RECEIPT",
  /** A worker submitted pieces for inspection. */
  SUBMISSION: "SUBMISSION",
  /** Inspection outcomes - one row per outcome kind, mirroring stage_inspections. */
  INSPECTION_APPROVED: "INSPECTION_APPROVED",
  INSPECTION_REWORK: "INSPECTION_REWORK",
  INSPECTION_REJECTED: "INSPECTION_REJECTED",
  /** The worker on a job changed. Quantity is 0; the reason is the point. */
  REASSIGNMENT: "REASSIGNMENT",
  /** Audited corrections. Each requires a written reason. Signed, so a
   *  correction can reduce a quantity - visibly, and with its author recorded. */
  RECEIVED_CORRECTION: "RECEIVED_CORRECTION",
  SUBMITTED_CORRECTION: "SUBMITTED_CORRECTION",
  REJECTED_CORRECTION: "REJECTED_CORRECTION",
} as const;

export type MovementEvent = (typeof MOVEMENT_EVENTS)[keyof typeof MOVEMENT_EVENTS];

/** Which counter each event type feeds. Unknown types are deliberately absent. */
const RECEIVED_EVENTS: string[] = [
  MOVEMENT_EVENTS.ALLOCATION,
  MOVEMENT_EVENTS.STAGE_RECEIPT,
  MOVEMENT_EVENTS.RECEIVED_CORRECTION,
];
const COMPLETED_EVENTS: string[] = [MOVEMENT_EVENTS.SUBMISSION, MOVEMENT_EVENTS.SUBMITTED_CORRECTION];
const REJECTED_EVENTS: string[] = [MOVEMENT_EVENTS.INSPECTION_REJECTED, MOVEMENT_EVENTS.REJECTED_CORRECTION];

/** Events that move a quantity. Used to reject a correction with no real effect. */
export const CORRECTION_EVENTS: string[] = [
  MOVEMENT_EVENTS.RECEIVED_CORRECTION,
  MOVEMENT_EVENTS.SUBMITTED_CORRECTION,
  MOVEMENT_EVENTS.REJECTED_CORRECTION,
];

export type Actor = { userId: number | null; name: string };

export type DerivedQuantities = {
  quantityReceived: number;
  quantityCompleted: number;
  quantityInspected: number;
  quantityApproved: number;
  quantityRework: number;
  quantityRejected: number;
  quantityRemaining: number;
};

/** Accepts the db handle or a transaction handle, like worker-roles.ts does. */
type Db = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const sumBucket = (types: string[]) =>
  sql`coalesce(sum(case when ${productionMovements.eventType} in (${sql.join(
    types.map((t) => sql`${t}`),
    sql`, `
  )}) then ${productionMovements.quantity} else 0 end), 0)`;

/**
 * Recompute all seven counters for one operation from its ledger rows.
 * One indexed aggregate query - not a table scan.
 */
export async function deriveQuantities(
  handle: Db,
  operationId: number
): Promise<DerivedQuantities> {
  const [row] = await handle
    .select({
      received: sumBucket(RECEIVED_EVENTS),
      completed: sumBucket(COMPLETED_EVENTS),
      approved: sumBucket([MOVEMENT_EVENTS.INSPECTION_APPROVED]),
      rework: sumBucket([MOVEMENT_EVENTS.INSPECTION_REWORK]),
      rejected: sumBucket(REJECTED_EVENTS),
    })
    .from(productionMovements)
    .where(eq(productionMovements.productionOperationId, operationId));

  const quantityReceived = Math.max(0, Number(row?.received ?? 0));
  const quantityCompleted = Math.max(0, Number(row?.completed ?? 0));
  const quantityApproved = Math.max(0, Number(row?.approved ?? 0));
  const quantityRework = Math.max(0, Number(row?.rework ?? 0));
  const quantityRejected = Math.max(0, Number(row?.rejected ?? 0));
  return {
    quantityReceived,
    quantityCompleted,
    quantityApproved,
    quantityRework,
    quantityRejected,
    quantityInspected: quantityApproved + quantityRework + quantityRejected,
    quantityRemaining: Math.max(0, quantityReceived - quantityApproved - quantityRejected),
  };
}

/**
 * Append events, then rewrite the operation's counters from the ledger.
 *
 * Always call this inside the same transaction as the change that caused it, so
 * a ledger row and the counter it produces can never disagree.
 */
export async function applyMovements(
  handle: Db,
  operation: { id: number; productionBatchId: number; stage: string },
  actor: Actor,
  events: { type: MovementEvent | string; quantity: number; workerId?: number | null;
    referenceType?: string | null; referenceId?: number | null; reason?: string | null;
    notes?: string | null; occurredAt?: Date | null;
    /** Set for events that carry no quantity but must still be on the trail,
     *  e.g. a reassignment. Without it they would be filtered out as no-ops. */
    audit?: boolean }[]
): Promise<DerivedQuantities> {
  const rows = events.filter((event) => Number(event.quantity) !== 0 || event.audit === true);
  if (rows.length) {
    await handle.insert(productionMovements).values(
      rows.map((event) => ({
        productionOperationId: operation.id,
        productionBatchId: operation.productionBatchId,
        stage: operation.stage,
        eventType: String(event.type),
        quantity: Number(event.quantity),
        workerId: event.workerId ?? null,
        actorUserId: actor.userId,
        actorName: actor.name,
        source: "LIVE",
        referenceType: event.referenceType ?? null,
        referenceId: event.referenceId ?? null,
        reason: event.reason ?? null,
        notes: event.notes ?? null,
        occurredAt: event.occurredAt ?? new Date(),
      }))
    );
  }
  const derived = await deriveQuantities(handle, operation.id);
  await handle
    .update(productionOperations)
    .set(derived)
    .where(eq(productionOperations.id, operation.id));
  return derived;
}

/**
 * How many pieces a stage has had APPROVED - the only figure the next stage may
 * ever receive. Computed from the ledger, never read from a stored counter, so
 * an approved quantity that was later corrected cannot leave a stale "available"
 * figure behind. This is the hook Task 3 uses for accepted external returns.
 */
export async function approvedAtStage(
  handle: Db,
  batchId: number,
  stage: string
): Promise<number> {
  const [row] = await handle
    .select({ approved: sumBucket([MOVEMENT_EVENTS.INSPECTION_APPROVED]) })
    .from(productionMovements)
    .where(
      and(
        eq(productionMovements.productionBatchId, batchId),
        eq(productionMovements.stage, stage)
      )
    );
  return Math.max(0, Number(row?.approved ?? 0));
}

/**
 * The inspection-only subtotal for one operation, excluding any corrections.
 *
 * Used to stop a correction from unwinding what an inspection actually recorded:
 * a rejected garment that turns out to be fine must be re-approved through an
 * inspection, not by quietly lowering the rejection count.
 */
export async function inspectionSubtotal(
  handle: Db,
  operationId: number
): Promise<{ approved: number; rework: number; rejected: number }> {
  const [row] = await handle
    .select({
      approved: sumBucket([MOVEMENT_EVENTS.INSPECTION_APPROVED]),
      rework: sumBucket([MOVEMENT_EVENTS.INSPECTION_REWORK]),
      rejected: sumBucket([MOVEMENT_EVENTS.INSPECTION_REJECTED]),
    })
    .from(productionMovements)
    .where(eq(productionMovements.productionOperationId, operationId));
  return {
    approved: Math.max(0, Number(row?.approved ?? 0)),
    rework: Math.max(0, Number(row?.rework ?? 0)),
    rejected: Math.max(0, Number(row?.rejected ?? 0)),
  };
}

/** Full audit trail for one operation, newest first. */
export async function movementsForOperation(operationId: number) {
  return db
    .select()
    .from(productionMovements)
    .where(eq(productionMovements.productionOperationId, operationId))
    .orderBy(desc(productionMovements.occurredAt), desc(productionMovements.id));
}

/** Full audit trail for a batch, newest first - the Production History source. */
export async function movementsForBatch(batchId: number) {
  return db
    .select()
    .from(productionMovements)
    .where(eq(productionMovements.productionBatchId, batchId))
    .orderBy(desc(productionMovements.occurredAt), desc(productionMovements.id));
}

/**
 * Reconcile every operation's stored counters against its ledger.
 *
 * Read-only. It REPORTS drift, it never repairs it: silently rewriting a
 * historical quantity is exactly what this ledger exists to prevent. Run it
 * after the 0006 backfill to see whether any counter and its audit trail
 * already disagreed before the ledger existed.
 */
export async function reconcileQuantities(batchId?: number) {
  const ops = batchId
    ? await db
        .select()
        .from(productionOperations)
        .where(eq(productionOperations.productionBatchId, batchId))
    : await db.select().from(productionOperations);
  const ids = ops.map((op) => op.id);
  const sums = ids.length
    ? await db
        .select({
          operationId: productionMovements.productionOperationId,
          received: sumBucket(RECEIVED_EVENTS),
          completed: sumBucket(COMPLETED_EVENTS),
          approved: sumBucket([MOVEMENT_EVENTS.INSPECTION_APPROVED]),
          rework: sumBucket([MOVEMENT_EVENTS.INSPECTION_REWORK]),
          rejected: sumBucket(REJECTED_EVENTS),
        })
        .from(productionMovements)
        .where(inArray(productionMovements.productionOperationId, ids))
        .groupBy(productionMovements.productionOperationId)
    : [];
  const byOp = new Map(sums.map((row) => [Number(row.operationId), row]));
  const drift: {
    operationId: number; batchId: number; stage: string; field: string;
    stored: number; derived: number;
  }[] = [];
  for (const op of ops) {
    const row = byOp.get(op.id);
    const derived: DerivedQuantities = {
      quantityReceived: Math.max(0, Number(row?.received ?? 0)),
      quantityCompleted: Math.max(0, Number(row?.completed ?? 0)),
      quantityApproved: Math.max(0, Number(row?.approved ?? 0)),
      quantityRework: Math.max(0, Number(row?.rework ?? 0)),
      quantityRejected: Math.max(0, Number(row?.rejected ?? 0)),
      quantityInspected: 0,
      quantityRemaining: 0,
    };
    derived.quantityInspected = derived.quantityApproved + derived.quantityRework + derived.quantityRejected;
    derived.quantityRemaining = Math.max(0, derived.quantityReceived - derived.quantityApproved - derived.quantityRejected);
    for (const field of Object.keys(derived) as (keyof DerivedQuantities)[]) {
      if ((op[field] ?? 0) !== derived[field]) {
        drift.push({
          operationId: op.id, batchId: op.productionBatchId, stage: op.stage,
          field, stored: op[field] ?? 0, derived: derived[field],
        });
      }
    }
  }
  return { checked: ops.length, drift };
}
