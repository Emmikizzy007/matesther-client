import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  orders,
  customers,
  orderItems,
  productionBatches,
  productionOperations,
  workers,
  expenses,
  payments,
  materials,
  materialPurchases,
  materialUsage,
  stageInspections,
  products,
} from "@/db/schema";
import { desc, gt, sql } from "drizzle-orm";
import { batchProgress } from "@/lib/server";
import { workerAccruals, buildGrowth, currentMonth } from "@/lib/payroll";
import { guard, getSessionUser, ANYONE } from "@/lib/authz";
import { getWorkerDashboard } from "@/lib/worker-dashboard";
import { batchApprovedProgress } from "@/lib/server";
// One definition of stage order, shared with api/inspections, api/reports and
// Settings. This file used to keep its own private copy of the array.
import { STAGES } from "@/lib/format";

export async function GET(req: Request) {
  const denied = await guard(req, ANYONE);
  if (denied) return denied;
  const sessionUser = await getSessionUser(req);
  if (!sessionUser) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  try {
    // A manager can request their OWN work and earnings, never company financials.
    // Workers always receive only their personal view regardless of URL parameters.
    const requestedView = new URL(req.url).searchParams.get("view");
    if (sessionUser.role === "WORKER" || (sessionUser.role === "PRODUCTION_MANAGER" && requestedView === "my-work")) {
      return NextResponse.json(await getWorkerDashboard(sessionUser), {
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    // Owner can supervise production. A Project Manager can never request owner finances.
    const view = sessionUser.role === "PRODUCTION_MANAGER" || requestedView === "pm" ? "pm" : "owner";

    const [
      orderRows,
      customerRows,
      itemRows,
      batchRows,
      opRows,
      workerRows,
      expenseRows,
      paymentRows,
      materialRows,
      purchaseTotalRows,
      usageRows,
      recentInspectionRows,
      reworkInspectionRows,
      productRows,
    ] = await Promise.all([
      // Every one of these used to be `select()` - a whole row of every table in
      // the business, most of whose columns this route never reads. Each now asks
      // for exactly the columns it uses, and the two "recent" lists and the
      // material total are resolved by the database instead of by downloading the
      // table and slicing it in Node.
      db.select({
        id: orders.id, orderNumber: orders.orderNumber, status: orders.status,
        orderDate: orders.orderDate, dueDate: orders.dueDate, totalAmount: orders.totalAmount,
        balance: orders.balance, customerId: orders.customerId, createdAt: orders.createdAt,
      }).from(orders).orderBy(desc(orders.createdAt)),
      db.select({ id: customers.id, name: customers.name }).from(customers),
      db.select({
        id: orderItems.id, orderId: orderItems.orderId,
        productId: orderItems.productId, quantity: orderItems.quantity,
      }).from(orderItems),
      db.select({
        id: productionBatches.id, orderId: productionBatches.orderId, orderItemId: productionBatches.orderItemId,
        batchNumber: productionBatches.batchNumber, quantity: productionBatches.quantity,
        size: productionBatches.size, color: productionBatches.color, status: productionBatches.status,
      }).from(productionBatches),
      db.select().from(productionOperations),
      db.select({
        id: workers.id, name: workers.name, specialty: workers.specialty, status: workers.status,
      }).from(workers),
      db.select({
        id: expenses.id, description: expenses.description, category: expenses.category,
        amount: expenses.amount, expenseDate: expenses.expenseDate, orderId: expenses.orderId,
      }).from(expenses).orderBy(desc(expenses.expenseDate)),
      // Only the five most recent payments are ever shown.
      db.select({
        id: payments.id, amount: payments.amount, paymentDate: payments.paymentDate,
        paymentMethod: payments.paymentMethod, reference: payments.reference, orderId: payments.orderId,
      }).from(payments).orderBy(desc(payments.paymentDate)).limit(5),
      db.select({
        id: materials.id, name: materials.name, unit: materials.unit,
        currentStock: materials.currentStock, reorderLevel: materials.reorderLevel, unitCost: materials.unitCost,
      }).from(materials),
      // A single number, so a single aggregate: this was a full scan of every
      // purchase ever made just to add one column up.
      db.select({ total: sql<number>`coalesce(sum(${materialPurchases.totalCost}), 0)` }).from(materialPurchases),
      db.select({ usedAt: materialUsage.usedAt, totalCost: materialUsage.totalCost }).from(materialUsage),
      // Six recent inspections, and six needing rework - not every inspection ever
      // recorded. At the measured scale this table held 15,638 rows and both lists
      // were produced by downloading all of them.
      db.select().from(stageInspections).orderBy(desc(stageInspections.inspectedAt)).limit(6),
      db.select().from(stageInspections).where(gt(stageInspections.quantityRework, 0))
        .orderBy(desc(stageInspections.inspectedAt)).limit(6),
      db.select({ id: products.id, name: products.name }).from(products),
    ]);
    const productMap = new Map(productRows.map((p) => [p.id, p]));
    const itemMap = new Map(itemRows.map((i) => [i.id, i]));

    const customerMap = new Map(customerRows.map((c) => [c.id, c]));
    const workerMap = new Map(workerRows.map((w) => [w.id, w]));
    const orderMap = new Map(orderRows.map((o) => [o.id, o]));
    const batchMap = new Map(batchRows.map((b) => [b.id, b]));
    const opMap = new Map(opRows.map((o) => [o.id, o]));

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const in14 = new Date(today.getTime() + 14 * 86400000);
    const tomorrow = new Date(today.getTime() + 86400000);

    const notDone = (s: string) => s !== "COMPLETED" && s !== "CANCELLED";
    const activeOrders = orderRows.filter((o) => notDone(o.status)).length;
    const inProduction = orderRows.filter((o) => o.status === "IN_PROGRESS").length;
    const completedOrders = orderRows.filter((o) => o.status === "COMPLETED").length;
    const dueSoon = orderRows.filter((o) => {
      if (!o.dueDate || !notDone(o.status)) return false;
      const d = new Date(o.dueDate);
      return d >= today && d <= in14;
    }).length;
    const delayed = orderRows.filter((o) => {
      if (!o.dueDate || !notDone(o.status)) return false;
      return new Date(o.dueDate) < today;
    }).length;
    const dueToday = orderRows.filter((o) => {
      if (!o.dueDate || !notDone(o.status)) return false;
      const d = new Date(o.dueDate);
      return d >= today && d <= tomorrow;
    }).length;

    const revenue = orderRows.reduce((s, o) => s + (o.totalAmount ?? 0), 0);
    const expenseTotal = expenseRows.reduce((s, e) => s + (e.amount ?? 0), 0);
    const purchaseCost = Number(purchaseTotalRows[0]?.total ?? 0);
    const usageCost = usageRows.reduce((s, u) => s + (u.totalCost ?? 0), 0);
    const outstanding = orderRows
      .filter((o) => o.status !== "CANCELLED")
      .reduce((s, o) => s + Math.max(0, o.balance ?? 0), 0);
    const totalCost = expenseTotal + usageCost;
    const profit = revenue - totalCost;
    const stockValue = materialRows.reduce((s, m) => s + (m.currentStock ?? 0) * (m.unitCost ?? 0), 0);

    const opsByBatch = new Map<number, typeof opRows>();
    for (const op of opRows) {
      const arr = opsByBatch.get(op.productionBatchId) ?? [];
      arr.push(op);
      opsByBatch.set(op.productionBatchId, arr);
    }
    const batchesByOrder = new Map<number, typeof batchRows>();
    for (const b of batchRows) {
      const arr = batchesByOrder.get(b.orderId) ?? [];
      arr.push(b);
      batchesByOrder.set(b.orderId, arr);
    }
    // Cancelled batches with zero approved work don't count toward progress
    function batchCounts(b: any) {
      const os = opsByBatch.get(b.id) ?? [];
      return {
        progress: batchProgress(os, b.quantity ?? 0),
        // Progress measured on APPROVED pieces, not merely submitted ones. The
        // submitted figure counts work nobody has accepted yet, so it can read
        // 100% on a batch that has failed every inspection.
        approvedProgress: batchApprovedProgress(os, b.quantity ?? 0),
        approved: os.reduce((s: number, o: any) => s + (o.quantityApproved ?? 0), 0),
      };
    }
    function orderProgress(orderId: number): number {
      const batches = (batchesByOrder.get(orderId) ?? []).filter(
        (b) => !(b.status === "CANCELLED" && batchCounts(b).approved === 0)
      );
      if (batches.length === 0) return 0;
      const ps = batches.map((b) => batchCounts(b).progress);
      return ps.reduce((a, b) => a + b, 0) / ps.length;
    }
    /** The same roll-up, on approved pieces only. */
    function orderApprovedProgress(orderId: number): number {
      const batches = (batchesByOrder.get(orderId) ?? []).filter(
        (b) => !(b.status === "CANCELLED" && batchCounts(b).approved === 0)
      );
      if (batches.length === 0) return 0;
      const ps = batches.map((b) => batchCounts(b).approvedProgress);
      return ps.reduce((a, b) => a + b, 0) / ps.length;
    }
    const qtyByOrder = new Map<number, number>();
    for (const it of itemRows)
      qtyByOrder.set(it.orderId, (qtyByOrder.get(it.orderId) ?? 0) + (it.quantity ?? 0));

    const pipeline = STAGES.map((stage) => {
      const sop = opRows.filter((o) => o.stage === stage);
      return {
        stage,
        active: sop.filter((o) => o.status === "IN_PROGRESS").length,
        pending: sop.filter((o) => o.status === "PENDING").length,
        awaitingInspection: sop.filter(
          (o) => (o.quantityCompleted ?? 0) > (o.quantityInspected ?? 0)
        ).length,
        done: sop.filter((o) => o.status === "COMPLETED").length,
        completed: sop.reduce((s, o) => s + (o.quantityCompleted ?? 0), 0),
        approved: sop.reduce((s, o) => s + (o.quantityApproved ?? 0), 0),
        rework: sop.reduce((s, o) => s + (o.quantityRework ?? 0), 0),
        rejected: sop.reduce((s, o) => s + (o.quantityRejected ?? 0), 0),
        total: sop.length,
      };
    });

    const opContext = (o: typeof opRows[number]) => {
      const batch = batchMap.get(o.productionBatchId);
      const order = batch ? orderMap.get(batch.orderId) : undefined;
      const item = batch?.orderItemId ? itemMap.get(batch.orderItemId) : undefined;
      return {
        ...o,
        batchNumber: batch?.batchNumber ?? "-",
        size: batch?.size ?? null,
        color: batch?.color ?? null,
        orderId: order?.id ?? null,
        orderNumber: order?.orderNumber ?? "-",
        customer: customerMap.get(order?.customerId ?? -1)?.name ?? "-",
        garment: item?.productId ? productMap.get(item.productId)?.name ?? null : "Full order",
        workerName: o.workerId ? workerMap.get(o.workerId)?.name ?? null : null,
        pendingInspection: Math.max(0, (o.quantityCompleted ?? 0) - (o.quantityInspected ?? 0)),
      };
    };
    const inspectionContext = (i: typeof recentInspectionRows[number]) => {
      const op = opMap.get(i.productionOperationId);
      const batch = op ? batchMap.get(op.productionBatchId) : undefined;
      const order = batch ? orderMap.get(batch.orderId) : undefined;
      return {
        ...i,
        stage: op?.stage ?? "-",
        batchNumber: batch?.batchNumber ?? "-",
        orderId: order?.id ?? null,
        orderNumber: order?.orderNumber ?? "-",
        customer: customerMap.get(order?.customerId ?? -1)?.name ?? "-",
      };
    };

    /* ================= PROJECT MANAGER view - production only, NO financials ================= */
    if (view === "pm") {
      const awaiting = opRows
        .filter((o) => (o.quantityCompleted ?? 0) > (o.quantityInspected ?? 0) && o.status !== "CANCELLED")
        .map(opContext);
      const reworkOps = opRows
        .filter((o) => (o.quantityRework ?? 0) > 0 && o.status !== "COMPLETED" && o.status !== "CANCELLED")
        .map(opContext);
      const dueTodayJobs = opRows
        .filter((o) => {
          if (!o.expectedCompletionDate || o.status === "COMPLETED" || o.status === "CANCELLED") return false;
          const d = new Date(o.expectedCompletionDate);
          return d >= today && d <= tomorrow;
        })
        .map(opContext);

      const workerActivity = workerRows
        .map((w) => {
          const mine = opRows.filter((o) => o.workerId === w.id);
          const overdue = mine.filter((o) => {
            if (!o.expectedCompletionDate || o.status === "COMPLETED" || o.status === "CANCELLED") return false;
            return new Date(o.expectedCompletionDate) < today;
          }).length;
          return {
            name: w.name,
            specialty: w.specialty,
            status: w.status,
            activeJobs: mine.filter((o) => o.status === "IN_PROGRESS" || o.status === "SUBMITTED").length,
            assigned: mine.reduce((s, o) => s + (o.quantityReceived ?? 0), 0),
            submitted: mine.reduce((s, o) => s + (o.quantityCompleted ?? 0), 0),
            approved: mine.reduce((s, o) => s + (o.quantityApproved ?? 0), 0),
            overdue,
          };
        })
        .filter((w) => w.assigned > 0 || w.activeJobs > 0);

      const ownWork = await getWorkerDashboard(sessionUser);
      return NextResponse.json({
        view: "pm",
        personal: {
          linked: ownWork.linked,
          specialty: ownWork.profile?.specialty ?? null,
          activeJobs: ownWork.todayJobs.length,
          earnings: ownWork.earnings,
        },
        today: {
          dueTodayJobs,
          awaitingInspection: awaiting,
          rework: reworkOps,
        },
        pipeline,
        workerActivity,
        inspection: {
          awaiting,
          recentApproved: recentInspectionRows.map(inspectionContext),
          reworkRequired: reworkInspectionRows.map(inspectionContext),
        },
      });
    }

    /* ================= OWNER view - business + production + money ================= */
    const thisMonth = currentMonth();
    const payroll = await workerAccruals(thisMonth);
    const growth = buildGrowth(orderRows, expenseRows, usageRows);

    const recentOrders = orderRows.slice(0, 5).map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      customer: customerMap.get(o.customerId ?? -1)?.name ?? "-",
      dueDate: o.dueDate,
      status: o.status,
      totalAmount: o.totalAmount,
      balance: o.balance,
      quantity: qtyByOrder.get(o.id) ?? 0,
      progress: Math.round(orderProgress(o.id)),
      approvedProgress: Math.round(orderApprovedProgress(o.id)),
    }));

    const nearDeadline = orderRows
      .filter((o) => o.dueDate && notDone(o.status))
      .sort((a, b) => +new Date(a.dueDate!) - +new Date(b.dueDate!))
      .slice(0, 5)
      .map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        customer: customerMap.get(o.customerId ?? -1)?.name ?? "-",
        dueDate: o.dueDate,
        status: o.status,
        progress: Math.round(orderProgress(o.id)),
        approvedProgress: Math.round(orderApprovedProgress(o.id)),
      }));

    const tasks = opRows
      .filter((o) => ["IN_PROGRESS", "SUBMITTED", "PENDING"].includes(o.status))
      .sort((a, b) => {
        const rank = (s: string) => (s === "SUBMITTED" ? 0 : s === "IN_PROGRESS" ? 1 : 2);
        return rank(a.status) - rank(b.status);
      })
      .slice(0, 8)
      .map(opContext);

    return NextResponse.json({
      view: "owner",
      payroll: {
        month: thisMonth,
        due: payroll.totals.due,
        paid: payroll.totals.paid,
        balance: payroll.totals.balance,
        workers: payroll.workers.filter((w: any) => w.due > 0).length,
      },
      growth,
      kpis: {
        activeOrders,
        inProduction,
        dueSoon,
        dueToday,
        completedOrders,
        delayed,
        revenue,
        expenseTotal,
        materialCost: purchaseCost,
        outstanding,
        profit,
        totalCost,
        stockValue,
        inspectionQueue: opRows.filter(
          (o) => (o.quantityCompleted ?? 0) > (o.quantityInspected ?? 0)
        ).length,
        reworkPending: opRows.reduce(
          (s, o) => s + (o.status !== "COMPLETED" ? (o.quantityRework ?? 0) : 0),
          0
        ),
      },
      pipeline,
      recentOrders,
      nearDeadline,
      tasks,
      lowStock: materialRows
        .filter((m) => (m.currentStock ?? 0) <= (m.reorderLevel ?? 0))
        .map((m) => ({
          id: m.id,
          name: m.name,
          unit: m.unit,
          currentStock: m.currentStock,
          reorderLevel: m.reorderLevel,
        })),
      recentExpenses: expenseRows.slice(0, 5).map((e) => ({
        id: e.id,
        description: e.description,
        category: e.category,
        amount: e.amount,
        date: e.expenseDate,
        orderNumber: e.orderId ? orderMap.get(e.orderId)?.orderNumber ?? null : null,
      })),
      recentPayments: paymentRows.slice(0, 5).map((p) => ({
        id: p.id,
        amount: p.amount,
        date: p.paymentDate,
        method: p.paymentMethod,
        reference: p.reference,
        orderNumber: orderMap.get(p.orderId)?.orderNumber ?? "-",
        customer: customerMap.get(orderMap.get(p.orderId)?.customerId ?? -1)?.name ?? "-",
      })),
      recentInspections: recentInspectionRows.map(inspectionContext),
      inspectionQueue: opRows
        .filter((o) => (o.quantityCompleted ?? 0) > (o.quantityInspected ?? 0) && o.status !== "CANCELLED")
        .map(opContext)
        .slice(0, 6),
    });
  } catch (e: any) {
    const msg = e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error";
    return NextResponse.json(
      { error: msg + " - Check that deploy/full-setup.sql was run in the Supabase project your DATABASE_URL points to." },
      { status: 500 }
    );
  }
}
