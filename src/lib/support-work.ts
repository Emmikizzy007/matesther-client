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
