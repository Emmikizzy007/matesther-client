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
import { desc } from "drizzle-orm";
import { batchProgress } from "@/lib/server";
import { workerAccruals, buildGrowth, currentMonth } from "@/lib/payroll";
import { guard, getSessionUser, ANYONE } from "@/lib/authz";

const STAGES = ["CUTTING", "SEWING", "MONOGRAMMING", "BUTTONHOLE", "BUTTON_TACKING", "IRONING", "PACKING", "DELIVERY"];

function norm(s: string) {
  return (s || "")
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|miss|alaji|alhaba|dr)\b\.?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function GET(req: Request) {
  const __g = await guard(req, ANYONE);
  if (__g) return __g;
  const __u = await getSessionUser(req);
  try {
    const { searchParams } = new URL(req.url);
    // The view is forced by the signed-in role - never by a client parameter.
    const view =
      __u?.role === "PRODUCTION_MANAGER" ? "pm" : __u?.role === "WORKER" ? "worker" : "owner";
    const userName =
      __u?.role === "WORKER" ? __u.name : (searchParams.get("name") || "");

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
      purchaseRows,
      usageRows,
      inspectionRows,
      productRows,
    ] = await Promise.all([
      db.select().from(orders).orderBy(desc(orders.createdAt)),
      db.select().from(customers),
      db.select().from(orderItems),
      db.select().from(productionBatches),
      db.select().from(productionOperations),
      db.select().from(workers),
      db.select().from(expenses).orderBy(desc(expenses.expenseDate)),
      db.select().from(payments).orderBy(desc(payments.paymentDate)),
      db.select().from(materials),
      db.select().from(materialPurchases),
      db.select().from(materialUsage),
      db.select().from(stageInspections).orderBy(desc(stageInspections.inspectedAt)),
      db.select().from(products),
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
    const materialCost = purchaseRows.reduce((s, p) => s + (p.totalCost ?? 0), 0);
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
        orderId: order?.id ?? null,
        orderNumber: order?.orderNumber ?? "-",
        customer: customerMap.get(order?.customerId ?? -1)?.name ?? "-",
        garment: item?.productId ? productMap.get(item.productId)?.name ?? null : "Full order",
        workerName: o.workerId ? workerMap.get(o.workerId)?.name ?? null : null,
        pendingInspection: Math.max(0, (o.quantityCompleted ?? 0) - (o.quantityInspected ?? 0)),
      };
    };
    const inspectionContext = (i: typeof inspectionRows[number]) => {
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

      return NextResponse.json({
        view: "pm",
        today: {
          dueTodayJobs,
          awaitingInspection: awaiting,
          rework: reworkOps,
        },
        pipeline,
        workerActivity,
        inspection: {
          awaiting,
          recentApproved: inspectionRows.slice(0, 6).map(inspectionContext),
          reworkRequired: inspectionRows.filter((i) => i.quantityRework > 0).slice(0, 6).map(inspectionContext),
        },
      });
    }

    /* ================= WORKER view - personal journal & earnings ================= */
    if (view === "worker") {
      const worker =
        workerRows.find((w) => norm(w.name) === norm(userName)) ||
        (userName ? workerRows.find((w) => norm(w.name).includes(norm(userName))) : undefined);
      if (!worker)
        return NextResponse.json(
          { error: "No production profile is linked to this login. Ask the owner to match your worker record." },
          { status: 400 }
        );

      const mine = opRows.filter((o) => o.workerId === worker.id);
      const active = mine
        .filter((o) => o.status === "IN_PROGRESS" || o.status === "SUBMITTED" || o.status === "PENDING")
        .map(opContext);

      const perPiece = worker.paymentType === "PER_PIECE";
      const myInspections = inspectionRows.filter((i) => mine.some((o) => o.id === i.productionOperationId));
      const events = myInspections
        .filter((i) => i.quantityApproved > 0 && perPiece)
        .map((i) => {
          const ctx = inspectionContext(i);
          return {
            ...ctx,
            amount: i.quantityApproved * (worker.paymentRate ?? 0),
          };
        });
      const sumIn = (from: Date) =>
        events
          .filter((e) => new Date(e.inspectedAt ?? 0) >= from)
          .reduce((s, e) => s + e.amount, 0);
      const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
      const weekAgo = new Date(today.getTime() - 7 * 86400000);

      return NextResponse.json({
        view: "worker",
        profile: { ...worker, perPiece },
        todayJobs: active,
        earnings: {
          today: sumIn(today),
          week: sumIn(weekAgo),
          month: sumIn(monthStart),
          total: sumIn(new Date(2000, 0, 1)),
          events: events.slice(0, 30),
        },
        recentJobs: mine
          .filter((o) => o.status === "COMPLETED")
          .map(opContext)
          .slice(0, 10),
        journal: mine.map(opContext),
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
        materialCost,
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
      recentInspections: inspectionRows.slice(0, 6).map(inspectionContext),
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
