import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  workers,
  productionOperations,
  productionBatches,
  orders,
  customers,
  orderItems,
  orderItemSizes,
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

  /**
   * The EXACT garment behind each piece of support work: school, order, item, size,
   * colour, variant, stage, and the share it was handed out from.
   *
   * A helper used to see the label "Support work" with no order number against it, which
   * is exactly the generic whole-order view this must never be. Every field below is
   * inherited from a record that already exists - the assignment's own order, item,
   * variant and stage columns, the parent stage job's batch, and the production
   * allocation the assignment names - so the helper sees the same exact garment the
   * tailor handed out, and never a quantity larger than their own.
   */
  const supportOrderIds = [...new Set(supportRows.map((row) => row.orderId).filter((v): v is number => !!v))];
  const supportOpIds = [...new Set(supportRows.map((row) => row.productionOperationId).filter((v): v is number => !!v))];
  const supportVariantIds = [...new Set(supportRows.map((row) => row.orderVariantId).filter((v): v is number => !!v))];
  const supportItemIds = [...new Set(supportRows.map((row) => row.orderItemId).filter((v): v is number => !!v))];
  const supportShareIds = [...new Set(supportRows.map((row) => row.productionAllocationId).filter((v): v is number => !!v))];
  const [supportOrders, supportOps, supportVariants, supportItems, supportShares] = await Promise.all([
    supportOrderIds.length
      ? db.select({ id: orders.id, orderNumber: orders.orderNumber, customerId: orders.customerId, dueDate: orders.dueDate })
          .from(orders).where(inArray(orders.id, supportOrderIds))
      : [],
    supportOpIds.length
      ? db.select({
          id: productionOperations.id, stage: productionOperations.stage, method: productionOperations.method,
          productionBatchId: productionOperations.productionBatchId,
        }).from(productionOperations).where(inArray(productionOperations.id, supportOpIds))
      : [],
    supportVariantIds.length
      ? db.select({ id: orderItemSizes.id, size: orderItemSizes.size, color: orderItemSizes.color, quantity: orderItemSizes.quantity })
          .from(orderItemSizes).where(inArray(orderItemSizes.id, supportVariantIds))
      : [],
    supportItemIds.length
      ? db.select({ id: orderItems.id, productId: orderItems.productId }).from(orderItems).where(inArray(orderItems.id, supportItemIds))
      : [],
    supportShareIds.length
      ? db.select({
          id: productionAllocations.id, workerId: productionAllocations.workerId, stage: productionAllocations.stage,
          quantityAllocated: productionAllocations.quantityAllocated,
        }).from(productionAllocations).where(inArray(productionAllocations.id, supportShareIds))
      : [],
  ]);
  const supportBatchIds = [...new Set(supportOps.map((op) => op.productionBatchId))];
  const supportCustomerIds = [...new Set(supportOrders.map((order) => order.customerId).filter((v): v is number => !!v))];
  const supportProductIds = [...new Set(supportItems.map((item) => item.productId).filter((v): v is number => !!v))];
  const supportHolderIds = [...new Set(supportShares.map((share) => share.workerId))];
  const [supportBatches, supportCustomers, supportProducts, supportHolders] = await Promise.all([
    supportBatchIds.length
      ? db.select({ id: productionBatches.id, batchNumber: productionBatches.batchNumber, size: productionBatches.size,
          color: productionBatches.color, orderItemId: productionBatches.orderItemId })
          .from(productionBatches).where(inArray(productionBatches.id, supportBatchIds))
      : [],
    supportCustomerIds.length
      ? db.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, supportCustomerIds))
      : [],
    supportProductIds.length
      ? db.select({ id: products.id, name: products.name }).from(products).where(inArray(products.id, supportProductIds))
      : [],
    supportHolderIds.length
      ? db.select({ id: workers.id, name: workers.name }).from(workers).where(inArray(workers.id, supportHolderIds))
      : [],
  ]);
  const supportOrderById = new Map(supportOrders.map((row) => [row.id, row]));
  const supportOpById = new Map(supportOps.map((row) => [row.id, row]));
  const supportVariantById = new Map(supportVariants.map((row) => [row.id, row]));
  const supportShareById = new Map(supportShares.map((row) => [row.id, row]));
  const supportBatchById = new Map(supportBatches.map((row) => [row.id, row]));
  const supportCustomerById = new Map(supportCustomers.map((row) => [row.id, row]));
  const supportProductById = new Map(supportProducts.map((row) => [row.id, row]));
  // id -> NAME, not id -> row: `holder` is printed on the helper's screen, so handing it
  // a whole record would render as an object and leak the worker's other columns with it.
  const supportHolderById = new Map<number, string>(supportHolders.map((row) => [row.id, row.name]));
  // The batch may name the item where the assignment does not, so both routes are kept.
  const supportItemIdsFromBatches = [...new Set(
    supportBatches.map((batch) => batch.orderItemId).filter((v): v is number => !!v)
  )].filter((id) => !supportItemIds.includes(id));
  const extraItems = supportItemIdsFromBatches.length
    ? await db.select({ id: orderItems.id, productId: orderItems.productId }).from(orderItems).where(inArray(orderItems.id, supportItemIdsFromBatches))
    : [];
  const supportItemById = new Map<number, { id: number; productId: number | null }>(
    [...supportItems, ...extraItems].map((row) => [row.id, row])
  );

  /** The exact context of one support assignment, inherited and never retyped. */
  function supportContext(row: typeof supportRows[number]) {
    const operation = row.productionOperationId ? supportOpById.get(row.productionOperationId) : undefined;
    const batch = operation ? supportBatchById.get(operation.productionBatchId) : undefined;
    const order = row.orderId ? supportOrderById.get(row.orderId) : undefined;
    const variant = row.orderVariantId ? supportVariantById.get(row.orderVariantId) : undefined;
    const share = row.productionAllocationId ? supportShareById.get(row.productionAllocationId) : undefined;
    const itemId = row.orderItemId ?? batch?.orderItemId ?? null;
    const product = itemId ? supportProductById.get(supportItemById.get(itemId)?.productId ?? -1) : undefined;
    const size = variant?.size ?? batch?.size ?? null;
    const color = variant?.color ?? batch?.color ?? null;
    return {
      orderNumber: order?.orderNumber ?? "",
      school: order?.customerId ? supportCustomerById.get(order.customerId)?.name ?? "" : "",
      dueDate: order?.dueDate ? String(order.dueDate).slice(0, 10) : null,
      batchNumber: batch?.batchNumber ?? null,
      product: product?.name ?? null,
      size,
      color,
      variant: variantLabel(size, color),
      variantQuantity: variant?.quantity ?? null,
      stage: row.stage ?? operation?.stage ?? share?.stage ?? null,
      method: operation?.method ?? null,
      /** Whose share of the stage this support work was handed out from, and how big it is. */
      allocation: share
        ? {
            id: share.id,
            stage: share.stage,
            holder: supportHolderById.get(share.workerId) ?? null,
            quantityAllocated: share.quantityAllocated,
          }
        : null,
    };
  }
  const supportEvents = supportChecks
    .filter((check) => check.quantityApproved > 0 && perPiece)
    .map((check) => {
      const assignment = supportById.get(check.supportAssignmentId);
      const rate = inspectionPieceRate(check, assignment ?? { pieceRate: null }, profile);
      // Resolved once per inspection, not once per field.
      const context = assignment ? supportContext(assignment) : null;
      return {
        id: check.id,
        source: "SUPPORT" as const,
        productionOperationId: assignment?.productionOperationId ?? null,
        inspectedAt: check.inspectedAt,
        quantityApproved: check.quantityApproved,
        pieceRate: rate,
        amount: check.quantityApproved * rate,
        // The helper's own earnings journal names the real garment and the real school,
        // not a generic "Support work" line with no order behind it.
        stage: context ? `${context.stage ?? ""} ${assignment?.operation ?? ""}`.trim() : "Support work",
        orderNumber: context?.orderNumber ?? "",
        batchNumber: context?.batchNumber ?? "",
        customer: context?.school || "Support work",
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
      ...supportContext(row),
      pending: Math.max(
        0,
        row.quantitySubmitted - (row.quantityApproved + row.quantityRejected + row.quantityRework)
      ),
    })),
  };
}
