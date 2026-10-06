import { db } from "@/db";
import { supportAssignments, supportInspections, workers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { inspectionEarnings, inspectionPieceRate } from "@/lib/job-pay";

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
export const SUPPORT_STATUSES = ["ASSIGNED", "SUBMITTED", "APPROVED", "REWORK", "CANCELLED"];

export { supportAssignments, supportInspections };
