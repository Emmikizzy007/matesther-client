import { NextResponse } from "next/server";
import { guard, OWNER } from "@/lib/authz";
import { db } from "@/db";
import {
  orders,
  customers,
  orderItems,
  productionBatches,
  productionOperations,
  workers,
  stageInspections,
  materials,
  materialPurchases,
  materialUsage,
  expenses,
} from "@/db/schema";
import { inspectionEarnings } from "@/lib/job-pay";

export async function GET(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    const [
      orderRows,
      customerRows,
      itemRows,
      batchRows,
      opRows,
      workerRows,
      materialRows,
      purchaseRows,
      usageRows,
      expenseRows,
      inspectionRows,
    ] = await Promise.all([
      db.select().from(orders),
      db.select().from(customers),
      db.select().from(orderItems),
      db.select().from(productionBatches),
      db.select().from(productionOperations),
      db.select().from(workers),
      db.select().from(materials),
      db.select().from(materialPurchases),
      db.select().from(materialUsage),
      db.select().from(expenses),
      db.select().from(stageInspections),
    ]);
    const cMap = new Map(customerRows.map((c) => [c.id, c]));

    // Profitability per order
    const profitability = orderRows.map((o) => {
      const usage = usageRows
        .filter((u) => u.orderId === o.id)
        .reduce((s, u) => s + (u.totalCost ?? 0), 0);
      const exp = expenseRows
        .filter((e) => e.orderId === o.id)
        .reduce((s, e) => s + (e.amount ?? 0), 0);
      const cost = usage + exp;
      const revenue = o.totalAmount ?? 0;
      const profit = revenue - cost;
      return {
        orderId: o.id,
        orderNumber: o.orderNumber,
        customer: cMap.get(o.customerId ?? -1)?.name ?? "-",
        status: o.status,
        quantity: itemRows.filter((i) => i.orderId === o.id).reduce((s, i) => s + (i.quantity ?? 0), 0),
        revenue,
        materialCost: usage,
        expenseCost: exp,
        totalCost: cost,
        profit,
        margin: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0,
      };
    });

    // Production performance per stage (official 8-stage Matesther workflow)
    const STAGES = ["CUTTING", "SEWING", "MONOGRAMMING", "BUTTONHOLE", "BUTTON_TACKING", "IRONING", "PACKING", "DELIVERY"];
    const production = STAGES.map((stage) => {
      const sop = opRows.filter((o) => o.stage === stage);
      return {
        stage,
        operations: sop.length,
        received: sop.reduce((s, o) => s + (o.quantityReceived ?? 0), 0),
        submitted: sop.reduce((s, o) => s + (o.quantityCompleted ?? 0), 0),
        approved: sop.reduce((s, o) => s + (o.quantityApproved ?? 0), 0),
        rework: sop.reduce((s, o) => s + (o.quantityRework ?? 0), 0),
        rejected: sop.reduce((s, o) => s + (o.quantityRejected ?? 0), 0),
        remaining: sop.reduce((s, o) => s + (o.quantityRemaining ?? 0), 0),
      };
    });

    // Material consumption
    const materialsReport = materialRows.map((m) => {
      const purchased = purchaseRows.filter((p) => p.materialId === m.id).reduce((s, p) => s + (p.quantity ?? 0), 0);
      const used = usageRows.filter((u) => u.materialId === m.id).reduce((s, u) => s + (u.quantityUsed ?? 0), 0);
      return {
        id: m.id,
        name: m.name,
        unit: m.unit,
        category: m.category,
        purchased,
        used,
        stock: m.currentStock ?? 0,
        stockValue: (m.currentStock ?? 0) * (m.unitCost ?? 0),
      };
    });

    // Worker performance
    const workersReport = workerRows.map((w) => {
      const mine = opRows.filter((o) => o.workerId === w.id);
      return {
        id: w.id,
        name: w.name,
        specialty: w.specialty,
        tasks: mine.length,
        assigned: mine.reduce((s, o) => s + (o.quantityReceived ?? 0), 0),
        completed: mine.reduce((s, o) => s + (o.quantityCompleted ?? 0), 0),
        rejected: mine.reduce((s, o) => s + (o.quantityRejected ?? 0), 0),
      };
    });

    // Worker earnings - pieceworkers earn on APPROVED pieces; monthly workers show their wage
    const workerEarnings = workerRows.map((w) => {
      const mine = opRows.filter((o) => o.workerId === w.id);
      const byId = new Map(mine.map((operation) => [operation.id, operation]));
      const approved = mine.reduce((s, o) => s + (o.quantityApproved ?? 0), 0);
      const earnings = w.paymentType === "PER_PIECE"
        ? inspectionRows.reduce((sum, check) => {
            const operation = byId.get(check.productionOperationId);
            return operation ? sum + inspectionEarnings(check, operation, w) : sum;
          }, 0)
        : w.paymentType === "MONTHLY" ? (w.paymentRate ?? 0) : 0;
      return {
        id: w.id,
        name: w.name,
        specialty: w.specialty,
        paymentType: w.paymentType,
        paymentRate: w.paymentRate ?? 0,
        status: w.status,
        approved,
        earnings,
      };
    });

    // Expenses by category
    const byCat = new Map<string, number>();
    for (const e of expenseRows)
      byCat.set(e.category, (byCat.get(e.category) ?? 0) + (e.amount ?? 0));
    const expensesByCategory = [...byCat.entries()].map(([category, amount]) => ({
      category,
      amount,
      count: expenseRows.filter((e) => e.category === category).length,
    }));

    return NextResponse.json({
      profitability,
      production,
      materials: materialsReport,
      workers: workersReport,
      workerEarnings,
      expensesByCategory,
      totals: {
        revenue: profitability.reduce((s, p) => s + p.revenue, 0),
        cost: profitability.reduce((s, p) => s + p.totalCost, 0),
        profit: profitability.reduce((s, p) => s + p.profit, 0),
        batches: batchRows.length,
        workerPieceworkTotal: workerEarnings
          .filter((w) => w.paymentType === "PER_PIECE")
          .reduce((s, w) => s + w.earnings, 0),
        monthlyPayroll: workerEarnings
          .filter((w) => w.paymentType === "MONTHLY")
          .reduce((s, w) => s + w.paymentRate, 0),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.queryError?.message || e?.cause?.message || e?.message || "Unknown error" }, { status: 500 });
  }
}
