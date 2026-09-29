import { eq, inArray } from "drizzle-orm";
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
} from "@/db/schema";
import { getLinkedWorkerId, type SessionUser } from "@/lib/authz";
import { inspectionPieceRate } from "@/lib/job-pay";

/** The only dashboard payload available to a worker. No company-level figures. */
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
    };
  }

  // Fetch only work assigned to the linked worker, never all company finances.
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
    .where(eq(productionOperations.workerId, profile.id));

  const journal = rows.map(({ operation, batch, order, customer, garment }) => ({
    ...operation,
    batchNumber: batch.batchNumber,
    batchQuantity: batch.quantity,
    size: batch.size,
    color: batch.color,
    orderId: order.id,
    orderNumber: order.orderNumber,
    dueDate: order.dueDate,
    customer: customer?.name ?? "School not recorded",
    garment: garment?.name ?? "Uniform order",
    workerName: profile.name,
    pendingInspection: Math.max(0, operation.quantityCompleted - operation.quantityInspected),
    availableToSubmit: Math.max(0, operation.quantityRemaining - Math.max(0, operation.quantityCompleted - operation.quantityInspected)),
  }));

  const opIds = rows.map(({ operation }) => operation.id);
  const inspections = opIds.length
    ? await db.select().from(stageInspections).where(inArray(stageInspections.productionOperationId, opIds))
    : [];
  const jobById = new Map(journal.map((job) => [job.id, job]));
  const perPiece = profile.paymentType === "PER_PIECE";
  const events = inspections
    .filter((check) => check.quantityApproved > 0 && perPiece)
    .map((check) => {
      const job = jobById.get(check.productionOperationId);
      return {
        id: check.id,
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
    })
    .sort((a, b) => (b.inspectedAt?.getTime() ?? 0) - (a.inspectedAt?.getTime() ?? 0));

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
  };
}
