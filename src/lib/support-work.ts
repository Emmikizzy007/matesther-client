import { db } from "@/db";
import {
  orders,
  productionAllocations,
  productionBatches,
  productionOperations,
  supportAssignments,
  supportInspections,
  supportStatusEvents,
  workers,
} from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { inspectionEarnings, inspectionPieceRate } from "@/lib/job-pay";
import { SUPPORT_OPERATIONS, isExternalMethod, isPurchasedMethod, sameRole } from "@/lib/format";
import { LIVE_ALLOC_STATUSES } from "@/lib/production-allocation";

/**
 * Pay rules for tailor support work.
 *
 * These deliberately reuse `@/lib/job-pay` rather than defining a second set of
 * rules: a support assignment carries its own agreed `pieceRate` exactly like a
 * production job, and an inspection snapshots the rate it paid at. So "approved
 * pieces x the rate agreed for that work, and nothing for unapproved work" is
 * the same calculation everywhere in Matesther.
 */

type SupportRateJob = { pieceRate: number | null };
type SupportRateWorker = { paymentType: string; paymentRate: number };
type SupportRateInspection = { pieceRate: number | null; quantityApproved: number };

/** Naira payable for one support inspection. Zero unless work was approved. */
export function supportInspectionEarnings(
  check: SupportRateInspection,
  assignment: SupportRateJob,
  worker: SupportRateWorker
): number {
  return inspectionEarnings(check, assignment, worker);
}

/** The rate a support inspection actually paid at. */
export function supportInspectionRate(
  check: SupportRateInspection,
  assignment: SupportRateJob,
  worker: SupportRateWorker
): number {
  return inspectionPieceRate(check, assignment, worker);
}

/**
 * What one approved support inspection TAKES BACK from the tailor who handed the
 * work out.
 *
 * Matesther's rule: a tailor's full piece rate belongs to the garment. If they
 * sew it themselves they keep all of it. If they hand a piece to a helper, the
 * helper's agreed rate is DEDUCTED from the tailor's rate - it is never added on
 * top as a second cost. A shirt at 300 with a helper agreed at 30 pays the helper
 * 30 and leaves the tailor 270 on that piece.
 *
 * So the deduction is numerically the helper's earnings for the same inspection:
 * one movement of money, two sides of it. Both sides settle on APPROVED pieces
 * only, at the rate snapshotted on the inspection, so approving nothing moves
 * nothing and a later rate change cannot rewrite what was already paid.
 *
 * The cutter's pay does NOT use this model, and neither does an outsourced
 * vendor: this is only for support work handed from one Matesther worker to
 * another on work the first one already holds.
 */
export function supportInspectionDeduction(
  check: SupportRateInspection,
  assignment: SupportRateJob,
  worker: SupportRateWorker
): number {
  return supportInspectionEarnings(check, assignment, worker);
}

/**
 * The most a tailor may hand out for one supporting operation on one share of a
 * stage, given what they have already handed out.
 *
 * A tailor holding 40 pieces may legitimately hand out 40 weaves AND 40 tapes -
 * two different supporting operations on the same garments. What they can never
 * do is hand out 60 weaves on 40 garments, because there is nothing for the extra
 * 20 to be on. So the ceiling is per (share, operation), not per share.
 */
export function supportHeadroom(
  holding: number,
  alreadyHandedOut: number
): number {
  return Math.max(0, holding - Math.max(0, alreadyHandedOut));
}

/** All inspections for one support assignment, oldest first. */
export async function supportInspectionsFor(assignmentId: number) {
  return db
    .select()
    .from(supportInspections)
    .where(eq(supportInspections.supportAssignmentId, assignmentId));
}

/** Accepts the db handle or a transaction handle, like the other lib modules. */
type Db = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Who moved a support assignment, resolved from the session - never from a body. */
export type SupportActor = {
  userId: number | null;
  workerId: number | null;
  name: string;
};

/**
 * Append one lifecycle event.
 *
 * The single write path for the trail, so no caller can record a transition
 * without recording who made it. Takes the handle it is given, which means a
 * transition and its event commit together or not at all - an assignment must never
 * end up PAUSED with no event saying so, or the reverse.
 */
export async function recordSupportEvent(
  handle: Db,
  entry: {
    supportAssignmentId: number;
    organizationId: number | null;
    eventType: SupportEvent;
    fromStatus: string | null;
    toStatus: string;
    actor: SupportActor;
    reason?: string | null;
    notes?: string | null;
  }
) {
  const [event] = await handle
    .insert(supportStatusEvents)
    .values({
      supportAssignmentId: entry.supportAssignmentId,
      organizationId: entry.organizationId,
      eventType: entry.eventType,
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      actorUserId: entry.actor.userId,
      actorWorkerId: entry.actor.workerId,
      actorName: entry.actor.name,
      reason: entry.reason ?? null,
      notes: entry.notes ?? null,
    })
    .returning();
  return event;
}

/** The full lifecycle trail for one assignment, oldest first. */
export async function supportEventsFor(assignmentId: number) {
  const rows = await db
    .select()
    .from(supportStatusEvents)
    .where(eq(supportStatusEvents.supportAssignmentId, assignmentId));
  return rows.sort(
    (a, b) =>
      (a.occurredAt?.getTime() ?? 0) - (b.occurredAt?.getTime() ?? 0) || a.id - b.id
  );
}

/** The worker profile for a support assignment's support worker. */
export async function supportWorkerProfile(workerId: number) {
  const [person] = await db.select().from(workers).where(eq(workers.id, workerId)).limit(1);
  return person ?? null;
}

/** Pending pieces on an assignment that may still be inspected. */
export function supportPending(assignment: {
  quantitySubmitted: number;
  quantityApproved: number;
  quantityRejected: number;
  quantityRework: number;
}): number {
  const settled = assignment.quantityApproved + assignment.quantityRejected + assignment.quantityRework;
  return Math.max(0, assignment.quantitySubmitted - settled);
}

/** Statuses a support assignment moves through. */
/**
 * THE SUPPORT-WORK LIFECYCLE.
 *
 * It used to be five states with no transitions defined: ASSIGNED, SUBMITTED,
 * APPROVED, REWORK, CANCELLED. A helper could submit work they had never begun,
 * nothing could express "the helper has stopped", and Production Control therefore
 * showed a tailor's stage as ordinary in-progress work while the support it depends
 * on was standing still.
 *
 * The seven states below are the same vocabulary with the missing middle filled in.
 * ASSIGNED, SUBMITTED, APPROVED, REWORK and CANCELLED keep their exact existing
 * meaning, so every historical row is still a legal state and nothing is restated.
 */
export const SUPPORT_STATUSES = [
  /** Handed out by the tailor. Nobody has begun. */
  "ASSIGNED",
  /** The helper has begun work. */
  "STARTED",
  /** The helper has stopped, with a recorded reason. Blocks the parent stage. */
  "PAUSED",
  /** Pieces handed back for the tailor to judge. */
  "SUBMITTED",
  /** Everything submitted has been judged and at least some was accepted. */
  "APPROVED",
  /** Judged, and what remains has to be done again. */
  "REWORK",
  /** Withdrawn before any work was submitted. */
  "CANCELLED",
] as const;

export type SupportStatus = (typeof SUPPORT_STATUSES)[number];

/**
 * WHICH TRANSITIONS ARE LEGAL, in one place.
 *
 * This is the rule the API enforces; it is not a hint the frontend may ignore. Each
 * entry is deliberately narrow, because the point is that a caller cannot reach a
 * state by asking for it:
 *
 *   - SUBMITTED is only reachable from STARTED or REWORK, so work can never be
 *     handed back before it began, and can never be handed back while PAUSED;
 *   - PAUSED is reachable from ASSIGNED and from STARTED, and from SUBMITTED with
 *     pieces still unjudged - but never from APPROVED or CANCELLED, which are
 *     settled. Pausing straight from ASSIGNED is deliberate and has a distinct
 *     meaning: the tailor who handed the work out has found they cannot give it
 *     after all, and stops it BEFORE the helper begins rather than letting them
 *     start work that is about to be withdrawn. Who may do that is an actor rule,
 *     not a transition rule, and it is enforced separately in the route;
 *   - APPROVED and REWORK are only reachable from SUBMITTED, so inspection still
 *     requires something submitted to inspect;
 *   - CANCELLED is only reachable from ASSIGNED, STARTED or PAUSED. It is NOT
 *     reachable from SUBMITTED, which preserves the existing rule that submitted
 *     work must be inspected rather than cancelled away, so history stays intact.
 *
 * A state absent from this map as a key has no legal exit except through
 * inspection, which is how APPROVED, REWORK and CANCELLED behave.
 */
export const SUPPORT_TRANSITIONS: Record<SupportStatus, readonly SupportStatus[]> = {
  ASSIGNED: ["STARTED", "PAUSED", "CANCELLED"],
  STARTED: ["SUBMITTED", "PAUSED", "CANCELLED"],
  PAUSED: ["STARTED", "CANCELLED"],
  /**
   * SUBMITTED can go back to STARTED, and that is not a mistake. Where the helper
   * handed back only PART of what was delegated and the tailor has now judged every
   * piece handed back, the work is not finished - the helper still owes the rest - so
   * the assignment returns to the helper rather than being marked APPROVED. Treating
   * it as approved is what made "10 delegated, 4 handed back, 4 judged" read as a
   * completed assignment with 6 pieces missing.
   */
  SUBMITTED: ["STARTED", "APPROVED", "REWORK", "PAUSED"],
  REWORK: ["STARTED", "SUBMITTED"],
  APPROVED: [],
  CANCELLED: [],
};

/**
 * The state an inspection produces.
 *
 * One rule, in one place, because it has to agree with the transition check that
 * runs before the write and with the row that gets written. It answers three
 * questions in order:
 *
 *   1. Are pieces still handed back and unjudged? Then nothing is settled yet and the
 *      assignment stays SUBMITTED - a partial inspection is not a terminal state.
 *   2. Does the helper still owe pieces they were never asked about, or were sent
 *      back? Then the work goes to (or stays at) STARTED, because it is the helper's
 *      turn again and the tailor has nothing left to judge.
 *   3. Everything delegated has been handed back and judged. Then it is REWORK if
 *      not one piece was accepted, and APPROVED otherwise.
 *
 * `settled` is approved + rework + rejected, and `delegated` is what was handed out.
 * Comparing against `delegated` rather than against `submitted` is the whole fix:
 * an assignment is finished when everything GIVEN OUT has been accounted for, not
 * when everything handed back so far has been judged.
 */
export function supportStatusAfterInspection(input: {
  quantityAssigned: number;
  quantitySubmitted: number;
  quantityApproved: number;
  quantityRejected: number;
  quantityRework: number;
}): SupportStatus {
  const settled = input.quantityApproved + input.quantityRejected + input.quantityRework;
  const unjudged = Math.max(0, input.quantitySubmitted - settled);
  if (unjudged > 0) return "SUBMITTED";
  const outstanding = Math.max(0, input.quantityAssigned - settled);
  if (outstanding > 0) return "STARTED";
  return input.quantityRework > 0 && input.quantityApproved === 0 ? "REWORK" : "APPROVED";
}

/** The lifecycle trail's event vocabulary. Data, not a closed enum. */
export const SUPPORT_EVENTS = {
  CREATED: "CREATED",
  STARTED: "STARTED",
  PAUSED: "PAUSED",
  RESUMED: "RESUMED",
  SUBMITTED: "SUBMITTED",
  INSPECTED: "INSPECTED",
  CANCELLED: "CANCELLED",
} as const;

export type SupportEvent = (typeof SUPPORT_EVENTS)[keyof typeof SUPPORT_EVENTS];

/** The action word a caller uses, mapped to the state it produces. */
export const SUPPORT_ACTIONS = {
  start: "STARTED",
  pause: "PAUSED",
  resume: "STARTED",
  cancel: "CANCELLED",
} as const;

export type SupportAction = keyof typeof SUPPORT_ACTIONS;

/**
 * Is this transition legal?
 *
 * Returns the reason it is not, rather than a bare false, because the answer has to
 * reach a person on a phone who needs to know what to do instead. An unknown
 * current status is refused rather than treated as permissive: a row in a state
 * this code does not recognise must not become a way through the machine.
 */
export function supportTransitionError(
  from: string,
  to: string
): string | null {
  if (!SUPPORT_STATUSES.includes(to as SupportStatus))
    return `${to} is not a support-work state.`;
  const allowed = SUPPORT_TRANSITIONS[from as SupportStatus];
  if (!allowed)
    return `Support work in state ${from} cannot be changed. Ask the Owner to look at it.`;
  // Staying where it already is is not a transition. A partial inspection leaves the
  // assignment SUBMITTED, and refusing that as "cannot move to SUBMITTED" would make
  // an ordinary second judgement of the remaining pieces impossible.
  if (from === to) return null;
  if (!allowed.includes(to as SupportStatus)) {
    // Named refusals for the cases that matter, so the message says what to do.
    if (to === "SUBMITTED" && from === "ASSIGNED")
      return "Start the work before submitting it. Pieces cannot be handed back before anyone began.";
    if (to === "SUBMITTED" && from === "PAUSED")
      return "This support work is paused. Resume it before submitting pieces.";
    if (from === "PAUSED")
      return "This support work is paused. Resume it first.";
    if (to === "CANCELLED" && from === "SUBMITTED")
      return "Work has already been submitted. Inspect it instead of cancelling, so the history stays intact.";
    if (!allowed.length)
      return `Support work that is ${from} is finished and cannot be changed.`;
    return `Support work that is ${from} cannot move to ${to}.`;
  }
  return null;
}

/**
 * The states that mean the support work is still live - pieces are out with the
 * helper or awaiting judgement, and the parent stage is still depending on it.
 *
 * ASSIGNED counts, because work handed out and never begun is still work the stage
 * is waiting on; that is precisely the case a control board must not hide.
 */
export const OPEN_SUPPORT_STATUSES: readonly string[] = [
  "ASSIGNED", "STARTED", "PAUSED", "SUBMITTED", "REWORK",
];

/** The states that mean the helper is NOT currently working: a visible block. */
export const BLOCKING_SUPPORT_STATUSES: readonly string[] = ["PAUSED", "REWORK"];

/** Is this status still live? Accepts a nullable column value. */
export function isOpenSupportStatus(status: string | null | undefined): boolean {
  return OPEN_SUPPORT_STATUSES.includes(String(status ?? ""));
}

/** Is this status a block on the parent stage? */
export function isBlockingSupportStatus(status: string | null | undefined): boolean {
  return BLOCKING_SUPPORT_STATUSES.includes(String(status ?? ""));
}

/**
 * How a support status reads on a board, in the same vocabulary the production
 * board already uses, so a controller does not have to translate between screens.
 */
export const SUPPORT_STATUS_LABELS: Record<string, string> = {
  ASSIGNED: "NOT STARTED",
  STARTED: "IN PROGRESS",
  PAUSED: "PAUSED",
  SUBMITTED: "AWAITING INSPECTION",
  APPROVED: "APPROVED",
  REWORK: "REWORK",
  CANCELLED: "CANCELLED",
};

/* -------------------------------------------------------------------------- */
/* Support work as part of the production chain.                               */
/* -------------------------------------------------------------------------- */

/**
 * What one stage owes to support work, in one figure set.
 *
 * A tailor who hands 20 of their 50 pieces to a helper has not stopped owning those
 * 20: they are still the tailor's stage, still the tailor's responsibility, and the
 * stage cannot finish until the helper's part comes back and is accepted. So the
 * board has to be able to say, for a stage: how much was delegated, how much of it
 * has been accepted, how much is still out, and whether the helper has stopped.
 */
export type StageSupport = {
  /** Pieces handed out to helpers on this stage. Cancelled hand-overs do not count. */
  delegated: number;
  /** Pieces a helper handed back and the tailor accepted. */
  approved: number;
  /** Pieces sent back to a helper to do again. */
  rework: number;
  /** Pieces a helper could not save. */
  rejected: number;
  /** Delegated and not yet settled - still out with a helper or unjudged. */
  outstanding: number;
  /** Live hand-overs on this stage, whatever their state. */
  active: number;
  /** Hand-overs where the helper has stopped, which is what blocks the stage. */
  paused: number;
  /** The most recent pause reason, so the board can say WHY rather than only that. */
  pausedReason: string | null;
  /** Hand-overs sent back for rework and not yet returned. */
  reworkOpen: number;
  /** True when something on this stage is stopped or sent back. */
  blocking: boolean;
};

export const EMPTY_STAGE_SUPPORT: StageSupport = {
  delegated: 0, approved: 0, rework: 0, rejected: 0, outstanding: 0,
  active: 0, paused: 0, pausedReason: null, reworkOpen: 0, blocking: false,
};

/** Accepts the db handle or a transaction handle, like the other lib modules. */
type SupportDb = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Support work for many stages in ONE query.
 *
 * Grouped in SQL by stage and state rather than read row by row and folded in
 * JavaScript, because the control board derives up to a thousand batches at a time
 * and a per-stage or per-assignment query there would be an N+1 across the largest
 * screen in the system. Cancelled hand-overs are excluded in the WHERE clause, so
 * they never inflate a delegated figure; a paused one is still delegated, because
 * the pieces really were given out and really are still owed.
 *
 * Support work handed out against a share that has no parent stage job is not
 * attributed to any stage here - it has no stage to be part of - but it remains
 * fully visible on the support-work screen and in payroll, which is where its own
 * money is settled.
 */
export async function supportByOperation(
  handle: SupportDb,
  operationIds: number[]
): Promise<Map<number, StageSupport>> {
  const out = new Map<number, StageSupport>();
  if (!operationIds.length) return out;
  const rows = await handle
    .select({
      operationId: supportAssignments.productionOperationId,
      status: supportAssignments.status,
      delegated: sql<number>`coalesce(sum(${supportAssignments.quantityAssigned}), 0)`,
      approved: sql<number>`coalesce(sum(${supportAssignments.quantityApproved}), 0)`,
      rework: sql<number>`coalesce(sum(${supportAssignments.quantityRework}), 0)`,
      rejected: sql<number>`coalesce(sum(${supportAssignments.quantityRejected}), 0)`,
      pausedAt: sql<number>`max(${supportAssignments.pausedAt})`,
      reason: sql<string | null>`max(${supportAssignments.pauseReason})`,
      assignments: sql<number>`count(*)`,
    })
    .from(supportAssignments)
    .where(and(
      inArray(supportAssignments.productionOperationId, operationIds),
      sql`${supportAssignments.status} <> 'CANCELLED'`
    ))
    .groupBy(supportAssignments.productionOperationId, supportAssignments.status);

  for (const row of rows) {
    const operationId = Number(row.operationId);
    const current = out.get(operationId) ?? { ...EMPTY_STAGE_SUPPORT };
    const delegated = Number(row.delegated) || 0;
    const approved = Number(row.approved) || 0;
    const rework = Number(row.rework) || 0;
    const rejected = Number(row.rejected) || 0;
    current.delegated += delegated;
    current.approved += approved;
    current.rework += rework;
    current.rejected += rejected;
    // Settled means judged: accepted, sent back or written off. Anything delegated
    // beyond that is still out with a helper or still waiting for the tailor.
    current.outstanding += Math.max(0, delegated - approved - rework - rejected);
    current.active += Number(row.assignments) || 0;
    if (row.status === "PAUSED") {
      current.paused += Number(row.assignments) || 0;
      if (row.reason) current.pausedReason = String(row.reason);
    }
    if (row.status === "REWORK") current.reworkOpen += Number(row.assignments) || 0;
    out.set(operationId, current);
  }
  for (const value of out.values()) {
    value.blocking = value.paused > 0 || value.reworkOpen > 0;
  }
  return out;
}

/**
 * There is deliberately NO "support for one stage, or the empty set" helper here.
 *
 * One existed, and it was the reason the production control board grew by 48 KB the day
 * support work was added to it: it turned "this stage has no support work" into a real
 * object carrying ten zeros, for every stage of every batch on the board, and most stages
 * of most batches have no support work at all. Callers now read the map directly and get
 * `undefined`, which serialises to no key at all.
 *
 * `EMPTY_STAGE_SUPPORT` stays, but only as the accumulator a grouped row starts from
 * inside `supportByOperation` - it is never handed back as an answer.
 */
export { supportAssignments, supportInspections };

/* -------------------------------------------------------------------------- */
/* What a tailor may hand out from - ONE resolver for the list and the write.  */
/* -------------------------------------------------------------------------- */

/**
 * A piece of production a person may hand part of to a support worker.
 *
 * Two shapes exist, and both are real production:
 *   - SHARE: a live `production_allocations` row - one tailor's share of a stage that
 *     was split between several people. Its holding is the share's quantity.
 *   - STAGE: an unsplit stage job whose `production_operations.workerId` names the
 *     tailor. This is how ordinary "Assign Production" work is recorded, so a tailor
 *     with a plain sewing job holds production even though no share row exists. Its
 *     holding is the pieces that have actually reached the stage.
 *
 * `remaining` is the ceiling per supporting operation - the same arithmetic the write
 * path enforces - so the figure shown to a person and the figure refused by the server
 * come from one function and cannot drift apart.
 */
export type DelegationSource = {
  kind: "SHARE" | "STAGE";
  productionAllocationId: number | null;
  productionOperationId: number;
  productionBatchId: number;
  holderWorkerId: number;
  stage: string;
  orderId: number | null;
  orderItemId: number | null;
  orderVariantId: number | null;
  batchNumber: string | null;
  size: string | null;
  color: string | null;
  /** Pieces this production gives its holder to delegate from. */
  holding: number;
  /** Per supporting operation: pieces already handed out and not cancelled. */
  delegated: Record<string, number>;
  /** Per supporting operation: the most that may still be handed out right now. */
  remaining: Record<string, number>;
  /** Why this production cannot be handed out from at present, or null when it can. */
  blockedReason: string | null;
  /** True when the holder can hand out at least one piece of at least one operation. */
  eligible: boolean;
};

export type DelegationScope = {
  /** The caller's organisation. Every source is read through its order and checked. */
  organizationId: number | null;
  /** Only production held by this worker - what a tailor may hand out from. */
  holderWorkerId?: number;
  /** One named share. Closed shares are returned too, so the refusal can say why. */
  allocationId?: number;
  /** One named stage job. */
  operationId?: number;
  /** Bound on the listing. A supervisor's view is organisation-wide and must stay bounded. */
  limit?: number;
  /**
   * List only production still open for work: live shares and stages not yet complete.
   * The Support page sets this, so a tailor's dropdown shows what they are doing now and
   * not every garment they have ever finished. A named lookup leaves it off, so approved
   * pieces on a completed share can still be reconciled against the helper who did them.
   */
  openOnly?: boolean;
};

/** The canonical spelling of a supporting operation, or null when it is not one. */
export function canonicalSupportOperation(value: string | null | undefined): string | null {
  const found = SUPPORT_OPERATIONS.find((known) => sameRole(known, value ?? ""));
  return found ?? null;
}

/**
 * Share states a tailor may still hand support work out from.
 *
 * ASSIGNED and ACTIVE are live. COMPLETED is included on purpose: a tailor who has sewn
 * and had their pieces approved may still have helpers working the same garments, and the
 * approved-pieces deduction is settled against exactly that share. TRANSFERRED and
 * CANCELLED are closed - the work moved to someone else or never happened - so nothing may
 * be handed out from them.
 */
const DELEGABLE_ALLOC_STATUSES: string[] = [...LIVE_ALLOC_STATUSES, "COMPLETED"];

/** A stage that is split is judged by ANY share still holding work, not only live ones. */
const HOLDING_ALLOC_STATUSES: string[] = DELEGABLE_ALLOC_STATUSES;

/** A stage whose work is finished. Listed only on request, never offered as open work. */
const FINISHED_STAGE_STATUS = "COMPLETED";

/**
 * Load the production a scope may hand out from, with its live delegation picture.
 *
 * Read in a fixed number of grouped queries however many sources there are - never one
 * query per source - and bounded by the scope. Organisation is checked through each
 * source's ORDER, not through the allocation's own organisation column, because shares
 * created by the stage-allocation flow do not carry one.
 *
 * Pass a transaction handle from a write path so the figures are read after the parent
 * row has been locked (see POST /api/support-work).
 */
export async function loadDelegationSources(
  handle: SupportDb,
  scope: DelegationScope
): Promise<DelegationSource[]> {
  const namedShare = scope.allocationId !== undefined;
  const namedStage = scope.operationId !== undefined;

  // Shares. A named share is read whatever its state, so a closed one can be refused with
  // a reason. A holder's listing reads that holder's delegable shares. A named STAGE reads
  // no shares at all - and a supervisor's organisation view reads the bounded live set.
  // Reading every share for a named stage was a bug: the first row returned could belong to
  // a different tailor entirely.
  const shareWhere = namedStage
    ? null
    : and(
        namedShare ? eq(productionAllocations.id, scope.allocationId!) : undefined,
        scope.holderWorkerId !== undefined ? eq(productionAllocations.workerId, scope.holderWorkerId) : undefined,
        namedShare ? undefined : inArray(productionAllocations.status, scope.openOnly ? LIVE_ALLOC_STATUSES : DELEGABLE_ALLOC_STATUSES)
      );
  const shareRows = shareWhere === null
    ? []
    : await handle
        .select()
        .from(productionAllocations)
        .where(shareWhere)
        .orderBy(productionAllocations.id)
        .limit(scope.limit ?? 500);

  // Stage jobs. A named share needs none of its own (its stage is read below); a named
  // stage is read by id, whoever holds it, so a refusal can say whose it is; a listing
  // reads the holder's stages, or every staffed stage for a bounded supervisor view.
  const stageWhere = namedShare
    ? null
    : namedStage
      ? eq(productionOperations.id, scope.operationId!)
      : and(
          scope.holderWorkerId !== undefined
            ? eq(productionOperations.workerId, scope.holderWorkerId)
            : sql`${productionOperations.workerId} is not null`,
          scope.openOnly ? sql`${productionOperations.status} <> ${FINISHED_STAGE_STATUS}` : undefined
        );
  const stageRows = stageWhere === null
    ? []
    : await handle
        .select()
        .from(productionOperations)
        .where(stageWhere)
        .orderBy(productionOperations.id)
        .limit(scope.limit ?? 500);

  const opIds = [...new Set([
    ...shareRows.map((row) => row.productionOperationId),
    ...stageRows.map((row) => row.id),
  ])];
  if (!opIds.length) return [];

  const [opRows, liveRows, supportRows] = await Promise.all([
    handle.select().from(productionOperations).where(inArray(productionOperations.id, opIds)),
    handle
      .select({ productionOperationId: productionAllocations.productionOperationId })
      .from(productionAllocations)
      .where(and(
        inArray(productionAllocations.productionOperationId, opIds),
        inArray(productionAllocations.status, HOLDING_ALLOC_STATUSES)
      )),
    handle
      .select({
        allocationId: supportAssignments.productionAllocationId,
        operationId: supportAssignments.productionOperationId,
        operation: supportAssignments.operation,
        delegated: sql<number>`coalesce(sum(${supportAssignments.quantityAssigned}), 0)`,
      })
      .from(supportAssignments)
      .where(and(
        inArray(supportAssignments.productionOperationId, opIds),
        sql`${supportAssignments.status} <> 'CANCELLED'`
      ))
      .groupBy(supportAssignments.productionAllocationId, supportAssignments.productionOperationId, supportAssignments.operation),
  ]);
  const opById = new Map(opRows.map((row) => [row.id, row]));
  const batchIds = [...new Set(opRows.map((row) => row.productionBatchId))];
  const batchRows = batchIds.length
    ? await handle.select().from(productionBatches).where(inArray(productionBatches.id, batchIds))
    : [];
  const batchById = new Map(batchRows.map((row) => [row.id, row]));
  const orderIds = [...new Set(batchRows.map((row) => row.orderId))];
  const orderRows = orderIds.length
    ? await handle.select({ id: orders.id, organizationId: orders.organizationId }).from(orders).where(inArray(orders.id, orderIds))
    : [];
  const orderById = new Map(orderRows.map((row) => [row.id, row]));
  const liveOps = new Set(liveRows.map((row) => row.productionOperationId));

  // Delegation already on each (share | stage, operation). Cancelled rows are excluded in
  // SQL, so withdrawing a hand-over gives its pieces back.
  const delegatedByKey = new Map<string, number>();
  for (const row of supportRows) {
    const operation = canonicalSupportOperation(row.operation) ?? row.operation;
    const key = `${row.allocationId ?? "stage"}|${row.operationId}|${operation.toLowerCase()}`;
    delegatedByKey.set(key, (delegatedByKey.get(key) ?? 0) + (Number(row.delegated) || 0));
  }

  const orderVisible = (orderId: number | null) => {
    if (orderId === null) return false;
    const order = orderById.get(orderId);
    if (!order) return false;
    // Legacy rows with no organisation are not refused, matching the rest of the system;
    // anything that names another organisation never is.
    return order.organizationId === null || scope.organizationId === null
      || order.organizationId === scope.organizationId;
  };

  const build = (args: {
    kind: "SHARE" | "STAGE";
    allocationId: number | null;
    op: typeof productionOperations.$inferSelect;
    holding: number;
    holder: number;
    blocked: string | null;
  }): DelegationSource | null => {
    const batch = batchById.get(args.op.productionBatchId);
    if (!batch || !orderVisible(batch.orderId)) return null;
    const delegated: Record<string, number> = {};
    const remaining: Record<string, number> = {};
    for (const operation of SUPPORT_OPERATIONS) {
      const key = `${args.allocationId ?? "stage"}|${args.op.id}|${operation.toLowerCase()}`;
      const handed = delegatedByKey.get(key) ?? 0;
      delegated[operation] = handed;
      remaining[operation] = args.blocked ? 0 : supportHeadroom(args.holding, handed);
    }
    const anyLeft = Object.values(remaining).some((value) => value > 0);
    const blockedReason = args.blocked
      ?? (anyLeft ? null : "Every piece of this production is already handed out to support workers.");
    return {
      kind: args.kind,
      productionAllocationId: args.allocationId,
      productionOperationId: args.op.id,
      productionBatchId: batch.id,
      holderWorkerId: args.holder,
      stage: args.op.stage,
      orderId: batch.orderId,
      orderItemId: batch.orderItemId,
      orderVariantId: batch.orderVariantId,
      batchNumber: batch.batchNumber,
      size: batch.size,
      color: batch.color,
      holding: args.holding,
      delegated,
      remaining,
      blockedReason,
      eligible: blockedReason === null,
    };
  };

  const out: DelegationSource[] = [];
  for (const share of shareRows) {
    const op = opById.get(share.productionOperationId);
    if (!op) continue;
    const built = build({
      kind: "SHARE",
      allocationId: share.id,
      op,
      holding: share.quantityAllocated,
      holder: share.workerId,
      blocked: (DELEGABLE_ALLOC_STATUSES as string[]).includes(share.status)
        ? null
        : "This share is closed. Its pieces were moved to another worker or cancelled, so nothing more can be handed out from it.",
    });
    if (built) out.push(built);
  }
  for (const stage of stageRows) {
    // External and bought-in stages have no worker to hand work out from.
    if (isExternalMethod(stage.method) || isPurchasedMethod(stage.method)) continue;
    const split = liveOps.has(stage.id);
    const built = build({
      kind: "STAGE",
      allocationId: null,
      op: stage,
      holding: stage.quantityReceived,
      holder: stage.workerId ?? 0,
      blocked: stage.workerId === null
        ? "Nobody holds this stage yet, so there is no production to hand out from."
        : split
          ? "This stage is split between workers. Hand out from your own share of it."
          : stage.quantityReceived < 1
            ? "No pieces have reached this stage yet."
            : null,
    });
    if (built) out.push(built);
  }
  // A named lookup returns exactly the row it named, never a neighbour.
  return out.filter((source) =>
    namedShare ? source.kind === "SHARE" && source.productionAllocationId === scope.allocationId
      : namedStage ? source.kind === "STAGE" && source.productionOperationId === scope.operationId
        : true
  );
}

/** The ceiling for one operation on a source, read back for an error message. */
export function remainingFor(source: DelegationSource, operation: string): number {
  return source.remaining[canonicalSupportOperation(operation) ?? operation] ?? 0;
}

/**
 * Lock the parent production row for the rest of the transaction.
 *
 * The headroom check and the insert are a read followed by a write. Two hand-outs
 * arriving together would both read the same headroom and both be accepted, which
 * over-delegates pieces that do not exist. Touching the parent row first makes the
 * second transaction wait for the first to commit, then read the committed total. The
 * statement sets the column to itself, so no value changes.
 */
export async function lockDelegationSource(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  source: { kind: "SHARE" | "STAGE"; productionAllocationId: number | null; productionOperationId: number }
): Promise<void> {
  if (source.kind === "SHARE" && source.productionAllocationId !== null) {
    await tx
      .update(productionAllocations)
      .set({ quantityAllocated: sql`${productionAllocations.quantityAllocated}` })
      .where(eq(productionAllocations.id, source.productionAllocationId));
    return;
  }
  await tx
    .update(productionOperations)
    .set({ quantityReceived: sql`${productionOperations.quantityReceived}` })
    .where(eq(productionOperations.id, source.productionOperationId));
}
