import { NextResponse } from "next/server";
import { db } from "@/db";
import { productionBatches, productionOperations } from "@/db/schema";
import { eq } from "drizzle-orm";
import { guard, getSessionUser, productionAccess, STAFF } from "@/lib/authz";
import { previousStage } from "@/lib/format";
import {
  MOVEMENT_EVENTS,
  approvedAtStage,
  applyMovements,
  inspectionSubtotal,
  movementsForBatch,
  movementsForOperation,
  reconcileQuantities,
} from "@/lib/production-ledger";

/**
 * AUDITED QUANTITY CORRECTIONS.
 *
 * PUT /api/operations used to accept `quantityReceived`, `quantityCompleted` and
 * `quantityRejected` as free text. That was the largest integrity hole in the
 * system, and it was measured rather than theorised:
 *
 *   - a stage's received figure could be raised from 90 to 500 with no event
 *     behind it and no audit row written;
 *   - a completed figure of 400 could be invented on a job where nobody had
 *     submitted anything, then APPROVED - which pushed 400 garments into the next
 *     stage when only 90 had ever been approved upstream;
 *   - a rejected figure could be lowered from 2 to 0 on a COMPLETED job, leaving
 *     the counter flatly contradicting the inspection rows that produced it.
 *
 * Those writes are gone. A genuine mistake - a mis-keyed allocation, a bundle
 * counted twice on the floor - is still correctable here, but only as a signed
 * ledger event recording who made it, when, why, and what it changed. Nothing is
 * overwritten: the correction is an additional row, so the original figure and
 * the evidence behind it both survive.
 */

/** Which fields may be corrected, and the ledger event each one becomes. */
const CORRECTABLE = {
  quantityReceived: MOVEMENT_EVENTS.RECEIVED_CORRECTION,
  quantityCompleted: MOVEMENT_EVENTS.SUBMITTED_CORRECTION,
  quantityRejected: MOVEMENT_EVENTS.REJECTED_CORRECTION,
} as const;

type CorrectableField = keyof typeof CORRECTABLE;

/**
 * Deliberately NOT correctable: quantityApproved, quantityRework, quantityInspected.
 *
 * Approved quantity is what payroll pays on and what the next stage may receive,
 * so it can only move through an inspection performed by someone other than the
 * person who did the work. Letting a correction touch it would be letting a
 * supervisor approve their own output by another name.
 */
const NEVER_CORRECTABLE = ["quantityApproved", "quantityRework", "quantityInspected", "quantityRemaining"];

/** Read the trail behind a job or a batch, or reconcile counters against it. */
export async function GET(req: Request) {
  const denied = await guard(req, STAFF);
  if (denied) return denied;
  try {
    const query = new URL(req.url).searchParams;
    const operationId = query.get("operationId") ? Number(query.get("operationId")) : null;
    const batchId = query.get("batchId") ? Number(query.get("batchId")) : null;

    // `?reconcile=1` compares every stored counter with the ledger behind it and
    // REPORTS any disagreement. It never repairs one: silently rewriting a
    // historical quantity is exactly what this ledger exists to prevent.
    if (query.get("reconcile") === "1") {
      const report = await reconcileQuantities(batchId ?? undefined);
      return NextResponse.json(report, { headers: { "Cache-Control": "private, no-store" } });
    }
    if (operationId) {
      const rows = await movementsForOperation(operationId);
      return NextResponse.json(rows, { headers: { "Cache-Control": "private, no-store" } });
    }
    if (batchId) {
      const rows = await movementsForBatch(batchId);
      return NextResponse.json(rows, { headers: { "Cache-Control": "private, no-store" } });
    }
    return NextResponse.json({ error: "Pass operationId or batchId." }, { status: 400 });
  } catch (error) {
    console.error("Production ledger load failed", error);
    return NextResponse.json({ error: "Unable to load the production ledger." }, { status: 500 });
  }
}

/**
 * POST /api/production-corrections
 * { operationId, field, setTo | adjustBy, reason }
 *
 * `setTo` states the corrected total; `adjustBy` states a signed movement. The
 * ledger stores the signed movement either way, so both the before and the after
 * figure are recoverable from the trail.
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
      return NextResponse.json({ error: "Choose the production job to correct." }, { status: 400 });

    const field = String(body.field ?? "") as CorrectableField;
    if (NEVER_CORRECTABLE.includes(field))
      return NextResponse.json({
        error: `${label(field)} cannot be corrected. Approved work only changes through an inspection by someone other than the person who produced it.`,
      }, { status: 403 });
    if (!(field in CORRECTABLE))
      return NextResponse.json({ error: `Choose one of: ${Object.keys(CORRECTABLE).map(label).join(", ")}.` }, { status: 400 });

    const reason = String(body.reason ?? "").trim();
    if (reason.length < 5)
      return NextResponse.json({ error: "Explain why this quantity is being corrected. The reason is kept on the audit trail." }, { status: 400 });
    if (reason.length > 2000)
      return NextResponse.json({ error: "That reason is too long. Keep it under 2000 characters." }, { status: 400 });

    const [op] = await db.select().from(productionOperations).where(eq(productionOperations.id, operationId)).limit(1);
    if (!op) return NextResponse.json({ error: "Production job not found." }, { status: 404 });
    const [batch] = await db.select().from(productionBatches).where(eq(productionBatches.id, op.productionBatchId)).limit(1);

    // Separation of duties, the same rule as inspection: a supervisor who is also
    // on the factory floor may not rewrite the quantities on their own job.
    if (session.role === "PRODUCTION_MANAGER") {
      const access = await productionAccess(session);
      if (access.workerId && op.workerId === access.workerId)
        return NextResponse.json({
          error: "You cannot correct the quantities on your own production job. Ask the Owner.",
        }, { status: 403 });
    }

    const current = op[field] ?? 0;
    let movement: number;
    if (body.setTo !== undefined) {
      const target = Number(body.setTo);
      if (!Number.isSafeInteger(target) || target < 0)
        return NextResponse.json({ error: "The corrected quantity must be a non-negative whole number." }, { status: 400 });
      movement = target - current;
    } else {
      const adjust = Number(body.adjustBy);
      if (!Number.isSafeInteger(adjust) || adjust === 0)
        return NextResponse.json({ error: "Enter the amount to add or subtract, for example -4 or 3." }, { status: 400 });
      movement = adjust;
    }
    if (movement === 0)
      return NextResponse.json({ error: `That job already records ${current}. There is nothing to correct.` }, { status: 400 });
    const proposed = current + movement;
    if (proposed < 0)
      return NextResponse.json({ error: `A correction cannot take this below zero. It currently records ${current}.` }, { status: 400 });

    // Downstream can never exceed what upstream actually approved. This is the
    // guard that stops a corrected `quantity_received` from reopening the hole
    // the free-text field left.
    if (field === "quantityReceived") {
      if (batch && proposed > batch.quantity)
        return NextResponse.json({
          error: `Batch ${batch.batchNumber} only holds ${batch.quantity} garment(s). A stage cannot receive more than its batch.`,
        }, { status: 400 });
      const upstream = previousStage(op.stage);
      if (upstream) {
        const approvedUpstream = await approvedAtStage(db, op.productionBatchId, upstream);
        if (proposed > approvedUpstream)
          return NextResponse.json({
            error: `Only ${approvedUpstream} garment(s) were approved at ${label(upstream)}. ${label(op.stage)} cannot receive more than the stage before it approved.`,
          }, { status: 400 });
      }
    }
    // Submitted work can never be corrected below work already inspected.
    if (field === "quantityCompleted" && proposed < op.quantityInspected)
      return NextResponse.json({
        error: `${op.quantityInspected} piece(s) have already been inspected. Submitted work cannot be corrected below that.`,
      }, { status: 400 });
    // A rejection cannot be unwound below what the inspection trail recorded. A
    // rejected garment that turns out to be fine is re-approved by an inspection,
    // not by quietly lowering the count.
    if (field === "quantityRejected") {
      const inspected = await inspectionSubtotal(db, op.id);
      if (proposed < inspected.rejected)
        return NextResponse.json({
          error: `Inspections recorded ${inspected.rejected} rejected piece(s) on this job. Re-record the garment through an inspection instead of lowering the count.`,
        }, { status: 400 });
    }

    const actor = { userId: session.id, name: session.name };
    const derived = await db.transaction(async (tx) =>
      applyMovements(tx, op, actor, [{
        type: CORRECTABLE[field],
        quantity: movement,
        workerId: op.workerId,
        referenceType: "PRODUCTION_OPERATION",
        referenceId: op.id,
        reason,
        notes: `Corrected ${field} from ${current} to ${proposed}`,
      }])
    );

    const [row] = await db
      .select()
      .from(productionOperations)
      .where(eq(productionOperations.id, operationId))
      .limit(1);
    return NextResponse.json(
      { corrected: true, field, from: current, to: proposed, movement, reason, by: actor.name, derived, operation: row },
      { status: 201 }
    );
  } catch (error) {
    console.error("Production correction failed", error);
    return NextResponse.json({ error: "Could not record this correction." }, { status: 500 });
  }
}

/** `quantity_received` -> "quantity received"; also used for stage names. */
function label(value: string): string {
  return value.replaceAll("_", " ").replace(/([A-Z])/g, " $1").trim().toLowerCase();
}
