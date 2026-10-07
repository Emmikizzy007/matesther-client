/**
 * PERFORMANCE PROBE — measures the real cost of the endpoints a screen actually calls.
 *
 * WHY THIS EXISTS
 *   "This page feels slow" is not a diagnosis. This script turns it into three numbers
 *   per endpoint: how many SQL statements ran, how many rows they read, and how many
 *   bytes of JSON reached the browser. Run it before a change and after it, and the
 *   claim "this is faster" is either supported or it is not.
 *
 * HOW IT MEASURES
 *   It drives the REAL Next.js route handlers through tests/support/harness.ts, against
 *   the real Drizzle data layer, on pg-mem with the repository's real migrations applied.
 *   Statement counting happens in the driver shim (tests/support/pg-shim.cjs), which is
 *   the one layer the suite already owns — no application code is instrumented, so the
 *   numbers describe the code that ships.
 *
 *   Row counts come from parsing `select ... from` statements is NOT attempted; instead
 *   every statement is recorded and grouped, and the payload is measured from the actual
 *   Response body. Statement count + payload size are the two figures that transfer to a
 *   real PostgreSQL: the first is round trips, the second is bytes over the wire.
 *
 * WHAT IT IS NOT
 *   Not a benchmark of PostgreSQL. pg-mem has no network, no planner and no disk, so the
 *   millisecond figures describe in-process work only and are reported for completeness,
 *   never as latency. The statement COUNT is the transferable figure, because one
 *   statement is one round trip against a real database too.
 *
 * RUN
 *   npx tsx --require ./tests/support/preload.cjs scripts/perf-probe.ts
 */
import { performance } from "node:perf_hooks";
import { api, createOwner, createOrder, createStaff, createWorker, expectStatus, signIn, testEmail } from "../tests/support/harness";
import { db } from "@/db";
import { hashPassword } from "@/lib/password";
import { users } from "@/db/schema";

type Statement = { sql: string; ms: number };
const STATEMENTS = (globalThis as any).__PGMEM_STATEMENTS__ as Statement[];

/** How many orders/batches to build, so the tables are not trivially small. */
const SCALE_ORDERS = Number(process.env.PERF_ORDERS ?? 24);
const SCALE_BATCHES_PER_ORDER = Number(process.env.PERF_BATCHES ?? 3);

type EndpointReport = {
  label: string;
  path: string;
  status: number;
  statements: number;
  payloadBytes: number;
  rows: number | null;
  ms: number;
  /** The statements that read a whole table with no WHERE at all. */
  unboundedReads: string[];
};

const reports: EndpointReport[] = [];

function isUnboundedRead(sql: string): boolean {
  if (!/^select/i.test(sql)) return false;
  return !/\bwhere\b/i.test(sql) && !/\bfrom\s+\(/i.test(sql);
}

/** Run one endpoint with the counter on, and report its true cost. */
async function measure(label: string, cookie: string, method: string, path: string): Promise<EndpointReport> {
  STATEMENTS.length = 0;
  (globalThis as any).__PGMEM_COUNT__ = true;
  const started = performance.now();
  const result = await api(method, path, { cookie });
  const ms = performance.now() - started;
  (globalThis as any).__PGMEM_COUNT__ = false;

  const captured = STATEMENTS.slice();
  const body = JSON.stringify(result.data ?? {});
  const rows = Array.isArray(result.data) ? result.data.length : null;
  const report: EndpointReport = {
    label,
    path,
    status: result.status,
    statements: captured.length,
    payloadBytes: Buffer.byteLength(body, "utf8"),
    rows,
    ms: Number(ms.toFixed(1)),
    unboundedReads: [...new Set(captured.filter((s) => isUnboundedRead(s.sql)).map((s) => s.sql.slice(0, 90)))],
  };
  reports.push(report);
  return report;
}

/** Build a realistic dataset through the public API only. No demo data, no seeds. */
async function buildDataset() {
  const owner = await createOwner();

  const cutter = await createWorker(owner.cookie, { name: "Probe Cutter", specialty: "Cutter", paymentRate: 150 });
  const tailor = await createWorker(owner.cookie, { name: "Probe Tailor", specialty: "Tailor", paymentRate: 300 });
  const helper = await createWorker(owner.cookie, {
    name: "Probe Helper", specialty: "Support Worker", roles: ["Support Worker", "Tailor"], paymentRate: 30,
  });
  const inspector = await createWorker(owner.cookie, { name: "Probe Inspector", specialty: "Inspection Officer", isInspector: true });

  /**
   * Linked Worker logins, so the worker-scoped endpoints are measured as a worker
   * actually sees them, and so submissions come from the worker who holds the stage
   * — which is what PUT /api/operations requires.
   */
  async function workerLogin(profile: { id: number; name: string }): Promise<string> {
    const email = testEmail(profile.name.toLowerCase().replace(/\s+/g, ""));
    const password = "WorkerTest!2345";
    await db.insert(users).values({
      organizationId: 1, name: profile.name, email,
      passwordHash: hashPassword(password), role: "WORKER", status: "ACTIVE", workerId: profile.id,
    });
    return signIn(email, password);
  }
  const tailorCookie = await workerLogin(tailor);
  const cutterCookie = await workerLogin(cutter);
  const manager = await createStaff(owner.cookie, { name: "Probe Manager", role: "PRODUCTION_MANAGER", workerId: null });

  // A garment with its own product-specific route, and one without, so route
  // resolution is exercised on both paths.
  const routed = await api("POST", "/api/products", { cookie: owner.cookie, body: { name: "Probe Polo", category: "Polos", sellingPrice: 5000 } });
  await expectStatus(routed, 201, "Create routed product");
  const plain = await api("POST", "/api/products", { cookie: owner.cookie, body: { name: "Probe Blazer", category: "Blazers", sellingPrice: 9000 } });
  await expectStatus(plain, 201, "Create plain product");

  const route = await api("POST", "/api/routes", {
    cookie: owner.cookie,
    body: {
      name: "Probe polo route", productId: routed.data.id, isDefault: true,
      stages: [
        { stage: "SEWING", method: "INTERNAL" },
        { stage: "MONOGRAMMING", method: "OUTSOURCED" },
        { stage: "IRONING", method: "INTERNAL" },
        { stage: "PACKING", method: "INTERNAL" },
      ],
    },
  });
  await expectStatus(route, 201, "Create product route");

  // Materials, so the material endpoints have something to page through. Their real
  // ids are kept rather than assumed, because a serial column is nobody's to guess.
  const materialIds: number[] = [];
  for (let index = 0; index < 12; index += 1) {
    const material = await api("POST", "/api/materials", {
      cookie: owner.cookie,
      body: { name: `Probe Fabric ${index}`, category: "Fabric", unit: "yards", currentStock: 5000, reorderLevel: 200, unitCost: 900 },
    });
    await expectStatus(material, 201, `Create material ${index}`);
    materialIds.push(material.data.id);
  }

  let batches = 0;
  let inspections = 0;
  let supportRows = 0;
  for (let index = 0; index < SCALE_ORDERS; index += 1) {
    const useRouted = index % 2 === 0;
    const customer = await api("POST", "/api/customers", {
      cookie: owner.cookie, body: { name: `Probe School ${index}`, type: "SCHOOL" },
    });
    await expectStatus(customer, 201, "Create probe school");
    const order = await api("POST", "/api/orders", {
      cookie: owner.cookie,
      body: {
        customerId: customer.data.id, orderDate: "2026-09-01", dueDate: "2026-11-01",
        items: [{ productId: useRouted ? routed.data.id : plain.data.id, quantity: 60, unitPrice: useRouted ? 5000 : 9000 }],
      },
    });
    await expectStatus(order, 201, "Create probe order");
    const detail = await api("GET", `/api/orders/${order.data.id}`, { cookie: owner.cookie });
    await expectStatus(detail, 200, "Load probe order");
    const itemId = detail.data.items[0].id;

    // Two exact variants per order line, so variant ceilings are real. The endpoint is
    // replace-all on `itemId` + `sizes`, which is the contract it has always had.
    const saved = await api("POST", "/api/order-sizes", {
      cookie: owner.cookie,
      body: { itemId, sizes: [{ size: "M", color: "Navy", quantity: 30 }, { size: "L", color: "Navy", quantity: 30 }] },
    });
    await expectStatus(saved, 201, "Record the order's exact variants");

    for (let batchIndex = 0; batchIndex < SCALE_BATCHES_PER_ORDER; batchIndex += 1) {
      const batch = await api("POST", "/api/batches", {
        cookie: owner.cookie,
        body: {
          orderId: order.data.id, orderItemId: itemId, quantity: 10,
          size: batchIndex === 0 ? "M" : "L", color: "Navy",
          workerId: cutter.id, cuttingRate: 150, tailorId: tailor.id, sewingRate: 300,
        },
      });
      if (batch.status !== 201) continue;
      batches += 1;

      // Push work through the REAL flow, submitted by the worker who holds each stage
      // and inspected by a supervisor, so the ledger, inspections and payroll all have
      // genuine rows to aggregate. Nothing here writes a counter directly.
      const ops = await api("GET", `/api/operations?batchId=${batch.data.id}`, { cookie: owner.cookie });
      const list = Array.isArray(ops.data) ? ops.data : [];
      for (const op of list) {
        const holder = op.stage === "CUTTING" ? cutterCookie : op.stage === "SEWING" ? tailorCookie : null;
        if (!holder) continue;
        const submit = await api("PUT", "/api/operations", { cookie: holder, body: { id: op.id, submitQty: 10 } });
        if (submit.status !== 200) continue;
        const inspect = await api("POST", "/api/inspections", {
          cookie: manager.cookie,
          body: { operationId: op.id, quantityApproved: 8, quantityRework: 1, quantityRejected: 1, notes: "probe inspection" },
        });
        if (inspect.status === 201) inspections += 1;

        // The tailor hands part of THEIR OWN stage to a helper, which is the workflow
        // under test. Bounded by what the stage holds.
        if (op.stage === "SEWING") {
          const handed = await api("POST", "/api/support-work", {
            cookie: tailorCookie,
            body: {
              workerId: helper.id, operation: "Weaving", quantityAssigned: 4, pieceRate: 30,
              productionOperationId: op.id,
            },
          });
          if (handed.status === 201) supportRows += 1;
        }
      }

      // Material issued against the order, so stock movement is real.
      await api("POST", "/api/material-usage", {
        cookie: owner.cookie,
        body: { orderId: order.data.id, materialId: materialIds[index % materialIds.length], quantityUsed: 12, unitCost: 900 },
      });
    }

    // A customer payment and an expense per order, so those lists are non-trivial.
    await api("POST", "/api/payments", {
      cookie: owner.cookie, body: { orderId: order.data.id, amount: 50000, paymentDate: "2026-09-05", reference: `PROBE-${index}` },
    });
    await api("POST", "/api/expenses", {
      cookie: owner.cookie, body: { orderId: order.data.id, category: "Transportation", description: "Probe delivery run", amount: 2500, expenseDate: "2026-09-06" },
    });
  }

  return { owner: owner.cookie, tailorCookie, cutterCookie, manager: manager.cookie, batches, inspections, supportRows, helper, materialIds };
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function main() {
  const built = await buildDataset();

  console.log(`\nDATASET: ${SCALE_ORDERS} orders, ${built.batches} batches, ${built.inspections} inspections, ${built.supportRows} support assignments\n`);

  const ownerEndpoints: [string, string][] = [
    ["Orders list", "/api/orders"],
    ["Order detail (one)", "/api/orders/1"],
    ["Production orders (assign screen)", "/api/production-orders"],
    ["Routes list", "/api/routes"],
    ["Workers (slim)", "/api/workers?view=slim"],
    ["Allocations (live, capped)", "/api/allocations?live=1&limit=500"],
    ["Operations", "/api/operations?limit=100"],
    ["Production control board", "/api/production-control?limit=100"],
    ["Support work list", "/api/support-work"],
    ["Inspection queue", "/api/inspections"],
    ["Payments list", "/api/payments"],
    ["Packing list", "/api/packing"],
    ["Expenses list", "/api/expenses"],
    ["Material purchases", "/api/material-purchases?limit=50"],
    ["Material usage", "/api/material-usage?limit=50"],
    ["Dashboard", "/api/dashboard"],
    ["Reports", "/api/reports"],
    ["Attention", "/api/attention"],
    ["Payroll", "/api/payroll"],
    ["Payment sheet", "/api/payment-sheet?month=2026-09"],
  ];
  for (const [label, path] of ownerEndpoints) await measure(label, built.owner, "GET", path);

  const workerEndpoints: [string, string][] = [
    ["WORKER support work list", "/api/support-work"],
    ["WORKER own allocations", "/api/allocations?live=1&limit=500"],
    ["WORKER operations", "/api/operations"],
    ["WORKER worker list (helpers)", "/api/workers?view=slim"],
  ];
  for (const [label, path] of workerEndpoints) await measure(label, built.tailorCookie, "GET", path);

  const managerEndpoints: [string, string][] = [
    ["PM production control", "/api/production-control?limit=100"],
    ["PM inspection queue", "/api/inspections"],
    ["PM support work", "/api/support-work"],
  ];
  for (const [label, path] of managerEndpoints) await measure(label, built.manager, "GET", path);

  console.log("ENDPOINT".padEnd(38) + "STMTS".padStart(7) + "ROWS".padStart(7) + "PAYLOAD".padStart(12) + "  UNBOUNDED READS");
  console.log("-".repeat(110));
  for (const report of reports) {
    console.log(
      report.label.padEnd(38) +
      String(report.statements).padStart(7) +
      String(report.rows ?? "-").padStart(7) +
      kb(report.payloadBytes).padStart(12) +
      (report.unboundedReads.length ? `  ${report.unboundedReads.length} full-table SELECT(s)` : "")
    );
  }

  const totals = reports.reduce(
    (acc, r) => ({ statements: acc.statements + r.statements, bytes: acc.bytes + r.payloadBytes }),
    { statements: 0, bytes: 0 }
  );
  console.log("-".repeat(110));
  console.log(`TOTAL across ${reports.length} endpoint calls: ${totals.statements} statements, ${kb(totals.bytes)} of JSON`);

  const worst = [...reports].sort((a, b) => b.statements - a.statements).slice(0, 5);
  console.log("\nMOST STATEMENTS:");
  for (const report of worst) console.log(`  ${String(report.statements).padStart(4)}  ${report.label}  (${report.path})`);
  const heaviest = [...reports].sort((a, b) => b.payloadBytes - a.payloadBytes).slice(0, 5);
  console.log("\nLARGEST PAYLOADS:");
  for (const report of heaviest) console.log(`  ${kb(report.payloadBytes).padStart(10)}  ${report.label}  (${report.path})`);
  const unbounded = reports.filter((r) => r.unboundedReads.length);
  console.log(`\nENDPOINTS WITH FULL-TABLE SELECTs: ${unbounded.length}`);
  for (const report of unbounded) {
    console.log(`  ${report.label} (${report.path})`);
    for (const sql of report.unboundedReads) console.log(`      ${sql}`);
  }
  console.log("");
}

main().catch((error) => {
  console.error("Probe failed:", error);
  process.exit(1);
});
