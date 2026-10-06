import { NextResponse } from "next/server";
import { guard, OWNER } from "@/lib/authz";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import {
  orders,
  customers,
  orderItems,
  productionBatches,
  productionOperations,
  workers,
  materials,
  materialPurchases,
  materialUsage,
  expenses,
} from "@/db/schema";
import { allTimePiecework } from "@/lib/payroll";
import { STAGES as SHARED_STAGES } from "@/lib/format";
import { orderCosts, unattributableCosts, COST_LINES } from "@/lib/order-cost";

export async function GET(req: Request) {
  const __g = await guard(req, OWNER); if (__g) return __g;
  try {
    /**
     * Bounded report data.
     *
     * Was eleven `db.select().from(x)` with no WHERE and no limit - every order, customer,
     * item, batch, production operation, worker, material, purchase, usage record, expense
     * and stage inspection in the database, loaded whole and then filtered in JavaScript once
     * per row of the report. On the Task 2 measurement fixture that is tens of thousands of
     * rows read to print a screen of about a hundred, and the operation/inspection pair was
     * crossed in a loop for worker earnings.
     *
     * Now the only tables read row-for-row are the ones the report genuinely prints one row
     * per record - orders, workers and materials - and even those select only the columns
     * they use. Everything else arrives pre-aggregated: one row per stage, per worker, per
     * material, per category, per order. Statement count is constant whatever the size of the
     * book, and no figure changes: each grouped sum below is the same expression the
     * JavaScript filter-and-reduce used to run.
     */
    const [
      orderRows,
      customerRows,
      workerRows,
      materialRows,
      qtyRows,
      batchCountRows,
      stageRows,
      workerOpRows,
      purchaseRows,
      usageByMaterialRows,
      usageByOrderRows,
      expenseByOrderRows,
      expenseCategoryRows,
      piecework,
    ] = await Promise.all([
      db.select({
        id: orders.id, orderNumber: orders.orderNumber, customerId: orders.customerId,
        status: orders.status, totalAmount: orders.totalAmount,
      }).from(orders),
      db.select({ id: customers.id, name: customers.name }).from(customers),
      db.select({
        id: workers.id, name: workers.name, specialty: workers.specialty,
        paymentType: workers.paymentType, paymentRate: workers.paymentRate, status: workers.status,
      }).from(workers),
      db.select({
        id: materials.id, name: materials.name, unit: materials.unit, category: materials.category,
        currentStock: materials.currentStock, unitCost: materials.unitCost,
      }).from(materials),
      // Ordered quantity per order, summed in the database instead of in a filter loop.
      db.select({
        orderId: orderItems.orderId,
        quantity: sql<number>`coalesce(sum(${orderItems.quantity}), 0)`,
      }).from(orderItems).groupBy(orderItems.orderId),
      db.select({ total: sql<number>`count(*)::int` }).from(productionBatches),
      // Production performance, grouped over every operation once rather than filtering the
      // whole operation table once per stage.
      db.select({
        stage: productionOperations.stage,
        operations: sql<number>`count(*)::int`,
        received: sql<number>`coalesce(sum(${productionOperations.quantityReceived}), 0)`,
        submitted: sql<number>`coalesce(sum(${productionOperations.quantityCompleted}), 0)`,
        approved: sql<number>`coalesce(sum(${productionOperations.quantityApproved}), 0)`,
        rework: sql<number>`coalesce(sum(${productionOperations.quantityRework}), 0)`,
        rejected: sql<number>`coalesce(sum(${productionOperations.quantityRejected}), 0)`,
        remaining: sql<number>`coalesce(sum(${productionOperations.quantityRemaining}), 0)`,
      }).from(productionOperations).groupBy(productionOperations.stage),
      // The same table grouped by worker instead, for the worker performance section.
      db.select({
        workerId: productionOperations.workerId,
        tasks: sql<number>`count(*)::int`,
        assigned: sql<number>`coalesce(sum(${productionOperations.quantityReceived}), 0)`,
        completed: sql<number>`coalesce(sum(${productionOperations.quantityCompleted}), 0)`,
        rejected: sql<number>`coalesce(sum(${productionOperations.quantityRejected}), 0)`,
        approved: sql<number>`coalesce(sum(${productionOperations.quantityApproved}), 0)`,
      }).from(productionOperations).groupBy(productionOperations.workerId),
      db.select({
        materialId: materialPurchases.materialId,
        quantity: sql<number>`coalesce(sum(${materialPurchases.quantity}), 0)`,
      }).from(materialPurchases).groupBy(materialPurchases.materialId),
      db.select({
        materialId: materialUsage.materialId,
        quantityUsed: sql<number>`coalesce(sum(${materialUsage.quantityUsed}), 0)`,
      }).from(materialUsage).groupBy(materialUsage.materialId),
      // Kept as the raw record total exactly as before: `materialCost` is the legacy figure
      // the screen has always shown, and `orderCosts()` is what now decides profit.
      db.select({
        orderId: materialUsage.orderId,
        totalCost: sql<number>`coalesce(sum(${materialUsage.totalCost}), 0)`,
      }).from(materialUsage).groupBy(materialUsage.orderId),
      db.select({
        orderId: expenses.orderId,
        amount: sql<number>`coalesce(sum(${expenses.amount}), 0)`,
      }).from(expenses).groupBy(expenses.orderId),
      db.select({
        category: expenses.category,
        amount: sql<number>`coalesce(sum(${expenses.amount}), 0)`,
        count: sql<number>`count(*)::int`,
      }).from(expenses).groupBy(expenses.category),
      // Earnings straight from the payroll module's own SQL, so this report and the payroll
      // screen cannot disagree about what a piece is worth.
      allTimePiecework(),
    ]);
    const cMap = new Map(customerRows.map((c) => [c.id, c]));
    const qtyByOrder = new Map(qtyRows.map((row) => [row.orderId, Number(row.quantity) || 0]));
    // Both of these are nullable foreign keys: usage and expenses recorded against the
    // business rather than a job. The null group is simply never looked up by an order id,
    // which is the same result the old `filter(e => e.orderId === o.id)` produced.
    const usageCostByOrder = new Map<number, number>(
      usageByOrderRows
        .filter((row) => row.orderId !== null)
        .map((row) => [row.orderId as number, Number(row.totalCost) || 0])
    );
    const expenseByOrder = new Map<number, number>(
      expenseByOrderRows
        .filter((row) => row.orderId !== null)
        .map((row) => [row.orderId as number, Number(row.amount) || 0])
    );
    const stageSums = new Map(stageRows.map((row) => [row.stage, row]));
    const opsByWorker = new Map<number, { tasks: number; assigned: number; completed: number; rejected: number; approved: number }>(
      workerOpRows
        .filter((row) => row.workerId !== null)
        .map((row) => [
          row.workerId as number,
          {
            tasks: row.tasks, assigned: Number(row.assigned) || 0, completed: Number(row.completed) || 0,
            rejected: Number(row.rejected) || 0, approved: Number(row.approved) || 0,
          },
        ])
    );
    const purchasedByMaterial = new Map(purchaseRows.map((row) => [row.materialId, Number(row.quantity) || 0]));
    const usedByMaterial = new Map(usageByMaterialRows.map((row) => [row.materialId, Number(row.quantityUsed) || 0]));

    /**
     * Profitability per order.
     *
     * Was: filter every material_usage row and every expense row in JavaScript for each
     * order, and call the sum "cost" - which counted no labour at all. Now one grouped pass
     * over the cost records costs every order at once, in the nine categories the business
     * actually runs on. See `lib/order-cost.ts`.
     *
     * `materialCost` and `expenseCost` are kept as the raw record totals so nothing that read
     * them breaks, and `legacy` carries the old formula's answer beside the restated one
     * rather than overwriting history.
     */
    const costedByOrder = await orderCosts(orderRows.map((o) => o.id));
    const profitability = orderRows.map((o) => {
      const usage = usageCostByOrder.get(o.id) ?? 0;
      const exp = expenseByOrder.get(o.id) ?? 0;
      const costed = costedByOrder.get(o.id);
      return {
        orderId: o.id,
        orderNumber: o.orderNumber,
        customer: cMap.get(o.customerId ?? -1)?.name ?? "-",
        status: o.status,
        quantity: qtyByOrder.get(o.id) ?? 0,
        revenue: o.totalAmount ?? 0,
        materialCost: usage,
        expenseCost: exp,
        totalCost: costed?.totalCost ?? 0,
        profit: costed?.profit ?? 0,
        margin: costed?.margin ?? 0,
        lines: COST_LINES.map(({ key, label }) => ({ key, label, amount: (costed?.[key] as number) ?? 0 })),
        legacy: costed?.legacy ?? { totalCost: usage + exp, profit: (o.totalAmount ?? 0) - (usage + exp), margin: 0 },
      };
    });

    /**
     * Costs no single order can carry: salaries, and expenses recorded against the business
     * rather than a job. Reported beside order profit so an order's margin is never read as
     * the whole business's margin.
     */
    const businessCosts = await unattributableCosts();

    // Production performance per stage (official 8-stage Matesther workflow)
    // Shared with api/dashboard, api/inspections and Settings - this file used
    // to keep its own private copy of the stage list. A stage with no operations at all
    // still reports a row of zeros, exactly as the filter-and-reduce produced before.
    const STAGES = SHARED_STAGES;
    const production = STAGES.map((stage) => {
      const sums = stageSums.get(stage);
      return {
        stage,
        operations: sums?.operations ?? 0,
        received: Number(sums?.received ?? 0),
        submitted: Number(sums?.submitted ?? 0),
        approved: Number(sums?.approved ?? 0),
        rework: Number(sums?.rework ?? 0),
        rejected: Number(sums?.rejected ?? 0),
        remaining: Number(sums?.remaining ?? 0),
      };
    });

    // Material consumption: purchased and used arrive pre-summed per material.
    const materialsReport = materialRows.map((m) => {
      const purchased = purchasedByMaterial.get(m.id) ?? 0;
      const used = usedByMaterial.get(m.id) ?? 0;
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

    // Worker performance, from the operation table grouped by worker once.
    const workersReport = workerRows.map((w) => {
      const mine = opsByWorker.get(w.id);
      return {
        id: w.id,
        name: w.name,
        specialty: w.specialty,
        tasks: mine?.tasks ?? 0,
        assigned: Number(mine?.assigned ?? 0),
        completed: Number(mine?.completed ?? 0),
        rejected: Number(mine?.rejected ?? 0),
      };
    });

    /**
     * Worker earnings - pieceworkers earn on APPROVED pieces; monthly workers show their wage.
     *
     * The piecework figure comes from `allTimePiecework()`, which is the payroll module's own
     * grouped SQL. This used to load every stage inspection and every production operation and
     * cross them in a loop calling `inspectionEarnings()` per pair - the same rate precedence,
     * computed the slow way, in a second place where it could drift from payroll. There is now
     * one implementation of "what is this piece worth".
     */
    const workerEarnings = workerRows.map((w) => {
      const approved = Number(opsByWorker.get(w.id)?.approved ?? 0);
      const earnings = w.paymentType === "PER_PIECE"
        ? piecework.get(w.id)?.piecework ?? 0
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

    // Expenses by category, summed and counted in the database.
    const expensesByCategory = expenseCategoryRows.map((row) => ({
      category: row.category,
      amount: Number(row.amount) || 0,
      count: row.count,
    }));

    return NextResponse.json({
      profitability,
      /** The nine cost categories, labelled, so the screen can render them in order. */
      costLines: COST_LINES,
      /**
       * What order profit deliberately leaves out. An order's margin is a DIRECT-cost
       * margin: salaries and business-wide expenses are real costs but belong to no
       * single order, and Matesther has no rule for spreading them - so none is invented.
       */
      businessCosts,
      production,
      materials: materialsReport,
      workers: workersReport,
      workerEarnings,
      expensesByCategory,
      totals: {
        revenue: profitability.reduce((s, p) => s + p.revenue, 0),
        cost: profitability.reduce((s, p) => s + p.totalCost, 0),
        profit: profitability.reduce((s, p) => s + p.profit, 0),
        batches: Number(batchCountRows[0]?.total ?? 0),
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
