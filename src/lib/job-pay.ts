export type RateWorker = { paymentType: string; paymentRate: number };
export type RateJob = { pieceRate: number | null };
export type RateInspection = { pieceRate: number | null; quantityApproved: number };

/** A new job stores its own agreed rate. Null exists only on historical jobs. */
export function jobPieceRate(job: RateJob, worker: RateWorker): number {
  return job.pieceRate ?? worker.paymentRate;
}

/** Inspection's immutable snapshot wins; historical rows use the job/old rate. */
export function inspectionPieceRate(check: RateInspection, job: RateJob, worker: RateWorker): number {
  return check.pieceRate ?? jobPieceRate(job, worker);
}

export function inspectionEarnings(check: RateInspection, job: RateJob, worker: RateWorker): number {
  if (worker.paymentType !== "PER_PIECE") return 0;
  return check.quantityApproved * inspectionPieceRate(check, job, worker);
}
