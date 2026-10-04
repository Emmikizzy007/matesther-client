import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  workers,
  productionOperations,
  productionBatches,
  orders,
  customers,
  orderItems,
  products,
  stageInspections,
  supportAssignments,
  supportInspections,
  productionAllocations,
} from "@/db/schema";
import { getLinkedWorkerId, type SessionUser } from "@/lib/authz";
import { inspectionPieceRate } from "@/lib/job-pay";
import { methodLabel, variantLabel } from "@/lib/format";
import { LIVE_ALLOC_STATUSES, operationIdsForWorker } from "@/lib/production-allocation";

/** Personal jobs and earnings, also available to a manager for their own factory work. No company-level figures. */
export async function getWorkerDashboard(user: SessionUser) {
  const workerId = await getLinkedWorkerId(user);
  const [profile] = workerId
    ? await db.select().from(workers).where(eq(workers.id, workerId)).limit(1)
    : [];

  if (!profile || profile.organizationId !== user.organizationId) {
    return {
      view: "worker" as const,
      linked: false,
      profile: null,
      todayJobs: [],
      earnings: { today: 0, week: 0, month: 0, total: 0, events: [] },
      recentJobs: [],
      journal: [],
      supportJobs: [],
    };
  }

  // Stages this worker holds a share of, because a stage may now be split across
  // several people and `production_operations.worker_id` alone would hide it.
  const allocatedOperationIds = await operationIdsForWorker(profile.id);
  const myAllocations = allocatedOperationIds.length
    ? await db
        .select()
        .from(productionAllocations)
        .where(
          and(
            eq(productionAllocations.workerId, profile.id),
            inArray(productionAllocations.status, LIVE_ALLOC_STATUSES),
            inArray(productionAllocations.productionOperationId, allocatedOperationIds)
          )
        )
    : [];
  const allocationByOperation = new Map(myAllocations.map((row) => [row.productionOperationId, row]));
  // How many people share each of those stages, so the screen can say "you hold 40
  // of the 100 at this stage, split between 3 tailors" instead of implying the whole
  // stage is theirs.
  const allShares = allocatedOperationIds.length
    ? await db
        .select({ operationId: productionAllocations.productionOperationId })
        .from(productionAllocations)
        .where(
          and(
            inArray(productionAllocations.status, LIVE_ALLOC_STATUSES),
            inArray(productionAllocations.productionOperationId, allocatedOperationIds)
          )
        )
    : [];
  const sharesByOperation = new Map<number, number>();
  for (const row of allShares) sharesByOperation.set(row.operationId, (sharesByOperation.get(row.operationId) ?? 0) + 1);

  // Fetch only work assigned to the linked worker, never all company finances.
  // A stage belongs to them either because it names them (the original single-worker
  // model, and every stage created before split allocation existed) or because they
  // hold an allocation on it.
  const rows = await db
    .select({
      operation: productionOperations,
      batch: productionBatches,
      order: orders,
      customer: customers,
      item: orderItems,
      garment: products,
    })
    .from(productionOperations)
    .innerJoin(productionBatches, eq(productionOperations.productionBatchId, productionBatches.id))
    .innerJoin(orders, eq(productionBatches.orderId, orders.id))
    .leftJoin(customers, eq(orders.customerId, customers.id))
    .leftJoin(orderItems, eq(productionBatches.orderItemId, orderItems.id))
    .leftJoin(products, eq(orderItems.productId, products.id))
    .where(
      allocatedOperationIds.length
        ? or(eq(productionOperations.workerId, profile.id), inArray(productionOperations.id, allocatedOperationIds))
        : eq(productionOperations.workerId, profile.id)
    );

  // How long each batch's own route is, so a card can say "stage 2 of 3" instead
  // of implying the eight-stage pipeline. One grouped query for this worker's
  // batches only.
  const workerBatchIds = [...new Set(rows.map(({ batch }) => batch.id))];
  const routeLengthRows = workerBatchIds.length
    ? await db
        .select({ batchId: productionOperations.productionBatchId, stages: sql<number>`count(*)` })
        .from(productionOperations)
        .where(inArray(productionOperations.productionBatchId, workerBatchIds))
        .groupBy(productionOperations.productionBatchId)
    : [];
  const routeLengthByBatch = new Map(routeLengthRows.map((row) => [Number(row.batchId), Number(row.stages)]));

  const journal = rows.map(({ operation, batch, order, customer, garment }) => {
    // THEIR SHARE, not the stage's total. On a stage split three ways the worker is
    // allocated a specific number of a specific garment, and that is what their own
    // screen must show - the stage total belongs on the supervisor's board.
    const mine = allocationByOperation.get(operation.id) ?? null;
    const stagePending = Math.max(0, operation.quantityCompleted - operation.quantityInspected);
    return {
    ...operation,
    batchNumber: batch.batchNumber,
    batchQuantity: batch.quantity,
    size: batch.size,
    color: batch.color,
    // THE EXACT GARMENT. A worker is allocated a specific item, size and colour in
    // a specific quantity - not "the order". These four fields are what makes that
    // visible on their own screen, and `quantityReceived` is their allocation of it.
    variant: variantLabel(batch.size, batch.color),
    orderVariantId: batch.orderVariantId,
    method: operation.method,
    methodLabel: methodLabel(operation.method),
    routePosition: operation.routePosition,
    routeLength: routeLengthByBatch.get(batch.id) ?? 0,
    orderId: order.id,
    orderNumber: order.orderNumber,
    dueDate: order.dueDate,
    customer: customer?.name ?? "School not recorded",
    garment: garment?.name ?? "Uniform order",
    workerName: profile.name,
    pendingInspection: stagePending,
    availableToSubmit: mine
      ? // Bounded by their own allocation: one tailor cannot submit the garments
        // that were allocated to another.
        Math.max(0, mine.quantityAllocated - mine.quantitySubmitted)
      : Math.max(0, operation.quantityRemaining - stagePending),
    // Their own figures on this stage. On an unsplit stage these are the stage's
    // figures, so every screen that already reads them keeps working.
    allocated: mine ? mine.quantityAllocated : operation.quantityReceived,
    mySubmitted: mine ? mine.quantitySubmitted : operation.quantityCompleted,
    myApproved: mine ? mine.quantityApproved : operation.quantityApproved,
    myPieceRate: mine ? mine.pieceRate : operation.pieceRate,
    myAllocationId: mine?.id ?? null,
    stageSplitBetween: sharesByOperation.get(operation.id) ?? (mine ? 1 : 0),
  };
  });

  const opIds = rows.map(({ operation }) => operation.id);
  const inspections = opIds.length
    ? await db.select().from(stageInspections).where(inArray(stageInspections.productionOperationId, opIds))
    : [];
  const jobById = new Map(journal.map((job) => [job.id, job]));
  const perPiece = profile.paymentType === "PER_PIECE";
  const productionEvents = inspections
    // A split stage has one inspection row PER WORKER credited, all pointing at the
    // same operation. Without this filter a tailor sharing a stage would see - and
    // be shown earnings for - every other tailor's approved pieces on it. An
    // unattributed row belongs to the stage's own worker, which is how every
    // inspection recorded before split allocation existed is still credited.
    .filter((check) => check.workerId === profile.id || (check.workerId === null && jobById.get(check.productionOperationId)?.workerId === profile.id))
    .filter((check) => check.quantityApproved > 0 && perPiece)
    .map((check) => {
      const job = jobById.get(check.productionOperationId);
      return {
        id: check.id,
        source: "PRODUCTION" as const,
        productionOperationId: check.productionOperationId,
        inspectedAt: check.inspectedAt,
        quantityApproved: check.quantityApproved,
        pieceRate: inspectionPieceRate(check, job ?? { pieceRate: null }, profile),
        amount: check.quantityApproved * inspectionPieceRate(check, job ?? { pieceRate: null }, profile),
        stage: job?.stage ?? "",
        orderNumber: job?.orderNumber ?? "",
        batchNumber: job?.batchNumber ?? "",
        customer: job?.customer ?? "",
      };
    });

  // Tailor support work pays on approved pieces too, at the rate agreed for it.
  const supportRows = await db
    .select()
    .from(supportAssignments)
    .where(eq(supportAssignments.workerId, profile.id));
  const supportIds = supportRows.map((row) => row.id);
  const supportChecks = supportIds.length
    ? await db.select().from(supportInspections).where(inArray(supportInspections.supportAssignmentId, supportIds))
    : [];
  const supportById = new Map(supportRows.map((row) => [row.id, row]));
  const supportEvents = supportChecks
    .filter((check) => check.quantityApproved > 0 && perPiece)
    .map((check) => {
      const assignment = supportById.get(check.supportAssignmentId);
      const rate = inspectionPieceRate(check, assignment ?? { pieceRate: null }, profile);
      return {
        id: check.id,
        source: "SUPPORT" as const,
        productionOperationId: assignment?.productionOperationId ?? null,
        inspectedAt: check.inspectedAt,
        quantityApproved: check.quantityApproved,
        pieceRate: rate,
        amount: check.quantityApproved * rate,
        stage: assignment?.operation ?? "Support work",
        orderNumber: "",
        batchNumber: "",
        customer: "Support work",
      };
    });

  const events = [...productionEvents, ...supportEvents].sort(
    (a, b) => (b.inspectedAt?.getTime() ?? 0) - (a.inspectedAt?.getTime() ?? 0)
  );

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfWeek = new Date(today.getTime() - 7 * 86400000);
  const sumSince = (date: Date) => events
    .filter((event) => event.inspectedAt && event.inspectedAt >= date)
    .reduce((sum, event) => sum + event.amount, 0);

  return {
    view: "worker" as const,
    linked: true,
    profile: { ...profile, perPiece },
    todayJobs: journal.filter((job) => ["IN_PROGRESS", "SUBMITTED", "PENDING"].includes(job.status)),
    earnings: {
      today: sumSince(today),
      week: sumSince(startOfWeek),
      month: sumSince(startOfMonth),
      total: events.reduce((sum, event) => sum + event.amount, 0),
      events: events.slice(0, 30),
    },
    recentJobs: journal.filter((job) => job.status === "COMPLETED").slice(0, 10),
    journal,
    // Their own support work: what was handed to them and what was approved.
    supportJobs: supportRows.map((row) => ({
      ...row,
      pending: Math.max(
        0,
        row.quantitySubmitted - (row.quantityApproved + row.quantityRejected + row.quantityRework)
      ),
    })),
  };
}
