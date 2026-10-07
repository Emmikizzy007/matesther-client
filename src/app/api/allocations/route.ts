import { NextResponse } from "next/server";
import { db } from "@/db";
import { productionAllocations, productionBatches, productionOperations, supportAssignments, workers } from "@/db/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { refreshBatchAndOrder } from "@/lib/server";
import { guard, getSessionUser, getLinkedWorkerId, productionAccess, ANYONE, STAFF } from "@/lib/authz";
import { isExternalMethod, isPurchasedMethod, methodLabel, sameRole } from "@/lib/format";
import { workerHoldsRole, type RoleCache } from "@/lib/worker-roles";
import { roleForStage } from "@/lib/production-route";
import {
  AllocationError,
  LIVE_ALLOC_STATUSES,
  allocate,
  allocationsIncludingClosed,
  deriveFree,
  ensureCarryOverAllocation,
  liveAllocations,
  resizeAllocation,
  transferAllocation,
} from "@/lib/production-allocation";

export const dynamic = "force-dynamic";

/**
 * PRODUCTION ALLOCATIONS: splitting one exact stage across several workers.
 *
 * 100 navy size-10 polos at SEWING, worked 40 / 35 / 25 by three tailors, is one
 * stage with three allocations - not three batches. The stage keeps one set of
 * counters derived from the movement ledger; the allocations say who is doing which
 * part of it.
 *
 * Everything that made the single-worker model safe is still enforced here, one
 * level down:
 *   - the splits may never sum to more than the stage holds, and what a stage holds
 *     comes from the ledger, not from a typed figure;
 *   - only a worker who holds the role this stage requires can be allocated to it;
 *   - a cutter-supervisor still may not allocate cutting work;
 *   - a stage that is outsourced or bought in has no worker to allocate to at all;
 *   - a reassignment moves only unworked quantity, so approved work and the pay for
 *     it stay with the person who earned them, and the closed allocation is kept
 *     with the reason beside the new one.
 */

/** GET /api/allocations?operationId=&batchId=&workerId= */
export async function GET(req: Request) {
  const denied = await guard(req, ANYONE);
  if (denied) return denied;
  try {
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
    const query = new URL(req.url).searchParams;
    const operationId = query.get("operationId") ? Number(query.get("operationId")) : null;
    const batchId = query.get("batchId") ? Number(query.get("batchId")) : null;
    /**
     * A Worker sees ONLY their own allocations, whatever the query string says.
     *
     * Two holes closed here, both of which handed a Worker the whole-stage view they
     * must never get:
     *   - the `workerId` filter was taken from the query string, so a Worker who simply
     *     omitted it dropped the filter entirely and received every share in the
     *     database, and a Worker who supplied somebody else's id received that person's;
     *   - the `operationId` path returns every allocation on a stage by design, because
     *     a supervisor splitting a stage needs to see all of them.
     * So the worker's own id is resolved from their login and the scope is applied to the
     * RESULT, which makes it impossible for either query path to widen it. Staff keep the
     * parameter, because choosing whose shares to look at is their job.
     */
    const isWorkerSession = session.role === "WORKER";
    const myWorkerId = isWorkerSession ? await getLinkedWorkerId(session) : null;
    if (isWorkerSession && myWorkerId === null)
      return NextResponse.json([], { headers: { "Cache-Control": "private, no-store" } });
    const requestedWorkerId = query.get("workerId") ? Number(query.get("workerId")) : null;
    // Asking for somebody else's shares returns NOTHING rather than the worker's own:
    // silently substituting their own rows would hide the fact that a wider id was asked
    // for, and this way the answer to a probe is indistinguishable from "no such work".
    if (
      isWorkerSession && requestedWorkerId !== null &&
      Number.isSafeInteger(requestedWorkerId) && requestedWorkerId !== myWorkerId
    )
      return NextResponse.json([], { headers: { "Cache-Control": "private, no-store" } });
    const workerId = isWorkerSession ? myWorkerId : requestedWorkerId;

    // `live=1` narrows to shares that can still be worked, which is what a picker of
    // "hand this out" needs; without it the caller would download every share ever made.
    const liveOnly = query.get("live") === "1";
    const rawLimit = query.get("limit") ? Number(query.get("limit")) : NaN;
    const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : null;
    const rawOffset = query.get("offset") ? Number(query.get("offset")) : 0;
    const offset = Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;

    const fetched = operationId
      ? await allocationsIncludingClosed(db, operationId)
      : await (async () => {
          const builder = db
            .select()
            .from(productionAllocations)
            .where(
              and(
                batchId ? eq(productionAllocations.productionBatchId, batchId) : undefined,
                workerId !== null && Number.isSafeInteger(workerId) ? eq(productionAllocations.workerId, workerId) : undefined,
                liveOnly ? inArray(productionAllocations.status, LIVE_ALLOC_STATUSES) : undefined
              )
            )
            .orderBy(desc(productionAllocations.assignedAt), desc(productionAllocations.id));
          return limit === null ? builder : builder.limit(limit).offset(offset);
        })();
    const rows = isWorkerSession ? fetched.filter((row) => row.workerId === myWorkerId) : fetched;

    const workerIds = [...new Set(rows.map((row) => row.workerId))];
    const opIds = [...new Set(rows.map((row) => row.productionOperationId))];
    const [people, ops] = await Promise.all([
      workerIds.length ? db.select({ id: workers.id, name: workers.name }).from(workers).where(inArray(workers.id, workerIds)) : [],
      opIds.length
        ? db.select({
            id: productionOperations.id, stage: productionOperations.stage, method: productionOperations.method,
            quantityReceived: productionOperations.quantityReceived, quantityApproved: productionOperations.quantityApproved,
            quantityRemaining: productionOperations.quantityRemaining, status: productionOperations.status,
            productionBatchId: productionOperations.productionBatchId, workerId: productionOperations.workerId,
          }).from(productionOperations).where(inArray(productionOperations.id, opIds))
        : [],
    ]);
    const nameById = new Map(people.map((person) => [person.id, person.name]));
    const opById = new Map(ops.map((op) => [op.id, op]));
    const batchIds = [...new Set(ops.map((op) => op.productionBatchId))];
    const batches = batchIds.length
      ? await db.select({ id: productionBatches.id, batchNumber: productionBatches.batchNumber, size: productionBatches.size, color: productionBatches.color, quantity: productionBatches.quantity })
        .from(productionBatches).where(inArray(productionBatches.id, batchIds))
      : [];
    const batchById = new Map(batches.map((batch) => [batch.id, batch]));
    // How much of each stage is already spoken for, so a caller can see the free
    // quantity without doing the arithmetic itself.
    const allocatedByOp = new Map<number, number>();
    for (const row of rows) {
      if (!LIVE_ALLOC_STATUSES.includes(row.status)) continue;
      allocatedByOp.set(row.productionOperationId, (allocatedByOp.get(row.productionOperationId) ?? 0) + row.quantityAllocated);
    }

    /* ---- what each share has already delegated to support workers ----
     *
     * ONE grouped query for the whole page, keyed by share id. A tailor handing out
     * support work has to be able to see "20 of my 40 are already out with a helper"
     * before they choose a quantity, because the ceiling the server enforces is per
     * (share, supporting operation) and an invisible ceiling is one people keep
     * hitting. Cancelled hand-overs are excluded in SQL, so withdrawing one gives the
     * pieces back rather than leaving them counted against the share.
     */
    const shareIds = rows.map((row) => row.id);
    const supportRows = shareIds.length
      ? await db
          .select({
            allocationId: supportAssignments.productionAllocationId,
            operation: supportAssignments.operation,
            delegated: sql<number>`coalesce(sum(${supportAssignments.quantityAssigned}), 0)`,
            approved: sql<number>`coalesce(sum(${supportAssignments.quantityApproved}), 0)`,
            rework: sql<number>`coalesce(sum(${supportAssignments.quantityRework}), 0)`,
            rejected: sql<number>`coalesce(sum(${supportAssignments.quantityRejected}), 0)`,
            paused: sql<number>`count(case when ${supportAssignments.status} = 'PAUSED' then 1 end)`,
          })
          .from(supportAssignments)
          .where(and(
            inArray(supportAssignments.productionAllocationId, shareIds),
            sql`${supportAssignments.status} <> 'CANCELLED'`
          ))
          .groupBy(supportAssignments.productionAllocationId, supportAssignments.operation)
      : [];
    const supportByShare = new Map<number, {
      delegated: number; approved: number; outstanding: number; paused: number;
      /** Per supporting operation, because that is the unit the ceiling is counted in. */
      byOperation: { operation: string; delegated: number; remaining: number }[];
    }>();
    for (const row of supportRows) {
      const allocationId = Number(row.allocationId);
      const current = supportByShare.get(allocationId) ?? { delegated: 0, approved: 0, outstanding: 0, paused: 0, byOperation: [] };
      const delegated = Number(row.delegated) || 0;
      const approved = Number(row.approved) || 0;
      const settled = approved + (Number(row.rework) || 0) + (Number(row.rejected) || 0);
      current.delegated += delegated;
      current.approved += approved;
      current.outstanding += Math.max(0, delegated - settled);
      current.paused += Number(row.paused) || 0;
      current.byOperation.push({ operation: row.operation, delegated, remaining: Math.max(0, delegated - settled) });
      supportByShare.set(allocationId, current);
    }

    return NextResponse.json(
      rows.map((row) => {
        const op = opById.get(row.productionOperationId);
        const batch = op ? batchById.get(op.productionBatchId) : undefined;
        return {
          ...row,
          workerName: nameById.get(row.workerId) ?? "-",
          stage: row.stage,
          method: op?.method ?? null,
          stageHolds: op?.quantityReceived ?? 0,
          stageAllocated: allocatedByOp.get(row.productionOperationId) ?? 0,
          stageFree: Math.max(0, (op?.quantityReceived ?? 0) - (allocatedByOp.get(row.productionOperationId) ?? 0)),
          batchNumber: batch?.batchNumber ?? "-",
          size: batch?.size ?? null,
          color: batch?.color ?? null,
          outstanding: Math.max(0, row.quantityAllocated - row.quantitySubmitted),
          unjudged: Math.max(0, row.quantitySubmitted - row.quantityApproved - row.quantityRework - row.quantityRejected),
          live: LIVE_ALLOC_STATUSES.includes(row.status),
          /**
           * The share's delegation picture: what has been handed to helpers, what they
           * have had accepted, what is still out, and how many hand-overs are paused.
           * Derived from the same rows the server enforces its ceiling against, so the
           * figure shown and the figure enforced cannot disagree.
           */
          supportDelegated: supportByShare.get(row.id)?.delegated ?? 0,
          supportApproved: supportByShare.get(row.id)?.approved ?? 0,
          supportOutstanding: supportByShare.get(row.id)?.outstanding ?? 0,
          supportPaused: supportByShare.get(row.id)?.paused ?? 0,
          supportByOperation: supportByShare.get(row.id)?.byOperation ?? [],
        };
      }),
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    console.error("Allocation list failed", error);
    return NextResponse.json({ error: "Could not load production allocations." }, { status: 500 });
  }
}

/**
 * POST /api/allocations - give part of a stage to a worker.
 * { operationId, workerId, quantity, pieceRate?, reason?, notes? }
 */
export async function POST(req: Request) {
  const denied = await guard(req, STAFF);
  if (denied) return denied;
  try {
    const body = await req.json();
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

    const operationId = Number(body.operationId);
    if (!Number.isSafeInteger(operationId) || operationId < 1)
      return NextResponse.json({ error: "Choose the production stage to split." }, { status: 400 });
    const [op] = await db.select().from(productionOperations).where(eq(productionOperations.id, operationId)).limit(1);
    if (!op) return NextResponse.json({ error: "Production stage not found." }, { status: 404 });

    // Work that leaves the factory, or that is bought in finished, has no worker to
    // allocate to: it has a vendor or a purchase instead.
    if (isExternalMethod(op.method) || isPurchasedMethod(op.method))
      return NextResponse.json({
        error: `${op.stage.replaceAll("_", " ")} on this batch is ${methodLabel(op.method).toLowerCase()}, so it is not split between workers. Record it under External Work & Ready-made instead.`,
      }, { status: 400 });

    const workerId = Number(body.workerId);
    if (!Number.isSafeInteger(workerId) || workerId < 1)
      return NextResponse.json({ error: "Choose the worker receiving this share." }, { status: 400 });
    const [person] = await db.select().from(workers).where(eq(workers.id, workerId)).limit(1);
    if (!person || person.status !== "ACTIVE" || (person.organizationId && session.organizationId && person.organizationId !== session.organizationId))
      return NextResponse.json({ error: "Choose an active Matesther worker." }, { status: 400 });

    // The same role gate as assigning a stage outright, and the same cutter
    // restriction: a supervisor who also cuts may not hand cutting work to anyone.
    const requiredRole = await roleForStage(db, op);
    const roleCache: RoleCache = new Map();
    if (requiredRole && !(await workerHoldsRole(person, requiredRole, roleCache)))
      return NextResponse.json({ error: `${op.stage.replaceAll("_", " ")} needs a ${requiredRole}. ${person.name} does not hold that role.` }, { status: 400 });
    if (session.role === "PRODUCTION_MANAGER") {
      const access = await productionAccess(session);
      if (access.cutterSupervisor && sameRole(requiredRole, "Cutter"))
        return NextResponse.json({
          error: "Cutter assignments must be made by the Owner or a non-cutting supervisor.",
        }, { status: 403 });
      // And a supervisor may not allocate work to themselves on a stage they are
      // already on: that is the same self-dealing the inspection rules block.
      if (access.workerId && access.workerId === workerId && op.workerId === access.workerId)
        return NextResponse.json({
          error: "You cannot allocate work to yourself on your own stage. Ask the Owner or another supervisor.",
        }, { status: 403 });
    }

    const quantity = Number(body.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1)
      return NextResponse.json({ error: "Enter how many garments this worker gets, as a whole number of at least 1." }, { status: 400 });

    const existing = await liveAllocations(db, op.id);
    const mine = existing.find((row) => row.workerId === workerId);
    if (person.paymentType === "PER_PIECE" && !mine) {
      const rate = Number(body.pieceRate);
      if (!Number.isSafeInteger(rate) || rate < 1)
        return NextResponse.json({ error: `Enter the agreed amount per approved piece for ${person.name} on this stage.` }, { status: 400 });
    }

    const actor = { userId: session.id, name: session.name };
    const created = await db.transaction(async (tx) => {
      // If this stage was already being worked by one person before it was split,
      // their submitted work is carried into an allocation first so it stays
      // attributable to them - and so it counts against the ceiling.
      await ensureCarryOverAllocation(tx, op, actor);
      const saved = await allocate(tx, op, actor, {
        workerId,
        quantity,
        pieceRate: body.pieceRate === undefined || body.pieceRate === "" || body.pieceRate === null ? null : Number(body.pieceRate),
        reason: body.reason ? String(body.reason).slice(0, 2000) : null,
        notes: body.notes ? String(body.notes).slice(0, 2000) : null,
      });
      // The stage's own worker_id becomes the first person allocated to it, so every
      // screen that already reads it keeps showing someone sensible. It is no longer
      // the authority on who is working the stage - the allocations are.
      if (op.workerId === null) {
        await tx.update(productionOperations).set({ workerId, status: op.status === "PENDING" ? "IN_PROGRESS" : op.status })
          .where(eq(productionOperations.id, op.id));
      }
      return saved;
    });
    await refreshBatchAndOrder(op.productionBatchId);
    const free = await deriveFree(db, op.id);
    return NextResponse.json({ ...created, workerName: person.name, stageFree: free }, { status: 201 });
  } catch (error) {
    if (error instanceof AllocationError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("Allocation failed", error);
    return NextResponse.json({ error: "Could not allocate this work." }, { status: 500 });
  }
}

/**
 * PUT /api/allocations - move unworked work to another worker, or resize a share.
 * { id, toWorkerId?, pieceRate?, reason }   transfer
 * { id, quantity, reason }                  resize
 */
export async function PUT(req: Request) {
  const denied = await guard(req, STAFF);
  if (denied) return denied;
  try {
    const body = await req.json();
    const session = await getSessionUser(req);
    if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1)
      return NextResponse.json({ error: "Choose the allocation to change." }, { status: 400 });
    const [current] = await db.select().from(productionAllocations).where(eq(productionAllocations.id, id)).limit(1);
    if (!current) return NextResponse.json({ error: "Allocation not found." }, { status: 404 });
    const [op] = await db.select().from(productionOperations).where(eq(productionOperations.id, current.productionOperationId)).limit(1);
    if (!op) return NextResponse.json({ error: "The production stage behind this allocation no longer exists." }, { status: 404 });

    const actor = { userId: session.id, name: session.name };
    const reason = String(body.reason ?? "").trim();

    if (body.toWorkerId !== undefined && body.toWorkerId !== null && body.toWorkerId !== "") {
      const toWorkerId = Number(body.toWorkerId);
      if (!Number.isSafeInteger(toWorkerId) || toWorkerId < 1)
        return NextResponse.json({ error: "Choose the worker taking this work over." }, { status: 400 });
      const [person] = await db.select().from(workers).where(eq(workers.id, toWorkerId)).limit(1);
      if (!person || person.status !== "ACTIVE" || (person.organizationId && session.organizationId && person.organizationId !== session.organizationId))
        return NextResponse.json({ error: "Choose an active Matesther worker." }, { status: 400 });
      const requiredRole = await roleForStage(db, op);
      if (requiredRole && !(await workerHoldsRole(person, requiredRole)))
        return NextResponse.json({ error: `${op.stage.replaceAll("_", " ")} needs a ${requiredRole}. ${person.name} does not hold that role.` }, { status: 400 });
      if (session.role === "PRODUCTION_MANAGER") {
        const access = await productionAccess(session);
        if (access.cutterSupervisor && sameRole(requiredRole, "Cutter"))
          return NextResponse.json({ error: "Cutter assignments must be made by the Owner or a non-cutting supervisor." }, { status: 403 });
      }
      const result = await db.transaction(async (tx) =>
        transferAllocation(tx, id, actor, {
          toWorkerId,
          reason,
          pieceRate: body.pieceRate === undefined || body.pieceRate === "" || body.pieceRate === null ? null : Number(body.pieceRate),
        })
      );
      await refreshBatchAndOrder(op.productionBatchId);
      return NextResponse.json({ ...result, workerName: person.name });
    }

    if (body.quantity === undefined)
      return NextResponse.json({ error: "Say who takes this work over, or how many garments it should hold." }, { status: 400 });
    const resized = await db.transaction(async (tx) =>
      resizeAllocation(tx, id, actor, { quantity: Number(body.quantity), reason })
    );
    await refreshBatchAndOrder(op.productionBatchId);
    return NextResponse.json(resized);
  } catch (error) {
    if (error instanceof AllocationError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error("Allocation change failed", error);
    return NextResponse.json({ error: "Could not change this allocation." }, { status: 500 });
  }
}
