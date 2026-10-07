/**
 * ADMINISTRATIVE TEST-DATA CLEANUP, and the guarded ordinary deletion beside it.
 *
 * WHAT IS BEING PROVEN
 *   That a test order carrying real production and real money can be removed - because
 *   clearing test data before the business goes live genuinely requires it - WITHOUT that
 *   becoming a way to destroy a live order, and without corrupting anything shared.
 *
 *   So each test here is a control with something pointed at it that the control is
 *   supposed to stop: a non-Owner, another organisation's order, the wrong school name, a
 *   preview that has gone stale, a fingerprint replayed a second time, a shelf that cannot
 *   give the stock back, a ready-made purchase that must not be treated as fabric, and the
 *   unrelated order, worker, material and payroll sitting right next to the one being
 *   removed.
 *
 *   The assertions are written against what the DATABASE holds afterwards, not against what
 *   the endpoint returned about itself. A cleanup that reports "removed 40 records" and
 *   left 40 records in place would pass a test that read its own response, which is why
 *   none of these do.
 *
 * ONE HONEST LIMITATION, STATED RATHER THAN PAPERED OVER
 *   The purge runs as a single `db.transaction`, so on PostgreSQL a failure part-way
 *   through leaves the database exactly as it was. That cannot be demonstrated here: the
 *   suite runs on pg-mem, whose adapter does NOT roll back - verified directly, by throwing
 *   inside a transaction after an insert and watching the insert survive. So instead of
 *   asserting a rollback this suite cannot produce, the tests assert the two properties
 *   that ARE observable and that the rollback depends on:
 *     - every refusal happens BEFORE any write at all, so a refused purge changes nothing;
 *     - stock is restored from the records being removed, inside the same transaction and
 *       before they are deleted, so the adjustment and its justification cannot be
 *       separated by ordering.
 *   See `deploy/upgrade-test-data-cleanup.sql` for the manual check to run against a real
 *   PostgreSQL before relying on the atomicity claim.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/db";
import {
  customers,
  expenses,
  organizations,
  materials,
  materialPurchases,
  materialUsage,
  orderItems,
  orders,
  productionBatches,
  productionOperations,
  stageInspections,
  supportAssignments,
  testDataPurges,
  orderDeletions,
  workerPayments,
  payments,
  workers,
  products,
  productionRoutes,
} from "@/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import {
  api,
  createOwner,
  createStaff,
  createWorker,
  expectStatus,
  signIn,
  testEmail,
  pauseSupport,
  startSupport,
} from "./support/harness";
import { hashPassword } from "@/lib/password";
import { users } from "@/db/schema";
import { currentMonth } from "@/lib/payroll";

let n = 0;
const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}${(n += 1)}`;

/** A factory person with a linked login, so they can hold and submit their own work. */
async function person(ownerCookie: string, role: string, rate = 300) {
  const name = unique(role);
  const profile = await createWorker(ownerCookie, { name, specialty: role, roles: [role], paymentRate: rate });
  const email = testEmail(name.toLowerCase().replace(/[^a-z]/g, ""));
  const password = "PersonTest!2345";
  await db.insert(users).values({
    organizationId: 1, name, email,
    passwordHash: hashPassword(password), role: "WORKER", status: "ACTIVE", workerId: profile.id,
  });
  return { ...profile, login: await signIn(email, password), name };
}

/** A school, and an order for `quantity` garments of one product. */
async function schoolOrder(ownerCookie: string, productId: number, schoolName: string, quantity: number, unitPrice = 3000) {
  const customer = await api("POST", "/api/customers", { cookie: ownerCookie, body: { name: schoolName, type: "SCHOOL" } });
  await expectStatus(customer, 201, `Create ${schoolName}`);
  const order = await api("POST", "/api/orders", {
    cookie: ownerCookie,
    body: {
      customerId: customer.data.id, orderDate: "2026-10-01", dueDate: "2026-11-15",
      items: [{ productId, quantity, unitPrice }],
    },
  });
  await expectStatus(order, 201, `Create the order for ${schoolName}`);
  const detail = await api("GET", `/api/orders/${order.data.id}`, { cookie: ownerCookie });
  await expectStatus(detail, 200, "Load the order");
  return {
    orderId: order.data.id as number,
    orderNumber: order.data.orderNumber as string,
    itemId: detail.data.items[0].id as number,
    customerId: customer.data.id as number,
    schoolName,
  };
}

type World = Awaited<ReturnType<typeof world>>;

/**
 * A business with one test order that has genuinely gone somewhere, and a real order
 * beside it that must survive.
 *
 * The test order carries: a batch on the eight-stage route, cutting submitted and
 * APPROVED, sewing submitted and approved, support work handed from the tailor's own
 * stage and approved, fabric issued from the store, a ready-made purchase, a customer
 * payment, an expense, and a settled payroll payment for the month the work was approved
 * in. That is the shape the requirement describes, and it is what makes the cleanup hard.
 */
async function world() {
  const owner = await createOwner();
  const cutter = await person(owner.cookie, "Cutter", 150);
  const tailor = await person(owner.cookie, "Tailor", 300);
  const helper = await person(owner.cookie, "Support Worker", 30);
  const manager = await createStaff(owner.cookie, { name: unique("Manager"), role: "PRODUCTION_MANAGER" });

  const shirt = await api("POST", "/api/products", { cookie: owner.cookie, body: { name: unique("Test Shirt"), category: "Shirts", sellingPrice: 3000 } });
  await expectStatus(shirt, 201, "Create the garment");
  const cardigan = await api("POST", "/api/products", { cookie: owner.cookie, body: { name: unique("Test Cardigan"), category: "Cardigans", sellingPrice: 5000 } });
  await expectStatus(cardigan, 201, "Create the ready-made garment");

  // A shared fabric the two orders both draw from, so "did the other order's stock
  // survive" is a real question rather than a trivial one.
  const fabric = await api("POST", "/api/materials", {
    cookie: owner.cookie,
    body: { name: unique("Shared Cotton"), category: "Fabric", unit: "yards", currentStock: 400, reorderLevel: 50, unitCost: 900 },
  });
  await expectStatus(fabric, 201, "Create the shared fabric");
  const readyMade = await api("POST", "/api/materials", {
    cookie: owner.cookie,
    body: { name: unique("Bought-in Cardigan"), category: "Ready-made garment", unit: "pcs", currentStock: 0, unitCost: 5000 },
  });
  await expectStatus(readyMade, 201, "Create the ready-made material");

  const schoolName = unique("Glorious Hope School");
  // The test order has TWO lines: 50 sewn shirts, and 5 cardigans bought in finished. One
  // order, two routes, one of them ready-made - so the cleanup has to handle a purchase
  // that is a cost and not stock, alongside production that is both.
  const testCustomer = await api("POST", "/api/customers", { cookie: owner.cookie, body: { name: schoolName, type: "SCHOOL" } });
  await expectStatus(testCustomer, 201, "Create the test school");
  const testOrder = await api("POST", "/api/orders", {
    cookie: owner.cookie,
    body: {
      customerId: testCustomer.data.id, orderDate: "2026-10-01", dueDate: "2026-11-15",
      items: [
        { productId: shirt.data.id, quantity: 50, unitPrice: 3000 },
        { productId: cardigan.data.id, quantity: 5, unitPrice: 5000 },
      ],
    },
  });
  await expectStatus(testOrder, 201, "Create the test order");
  const testDetail = await api("GET", `/api/orders/${testOrder.data.id}`, { cookie: owner.cookie });
  await expectStatus(testDetail, 200, "Load the test order");
  const shirtItem = testDetail.data.items.find((row: any) => row.productId === shirt.data.id);
  const cardiganItem = testDetail.data.items.find((row: any) => row.productId === cardigan.data.id);
  assert.ok(shirtItem && cardiganItem, "Both lines are on the test order");
  const test = {
    orderId: testOrder.data.id as number,
    orderNumber: testOrder.data.orderNumber as string,
    itemId: shirtItem.id as number,
    cardiganItemId: cardiganItem.id as number,
    customerId: testCustomer.data.id as number,
    schoolName,
  };
  const keep = await schoolOrder(owner.cookie, shirt.data.id, unique("Saint Martins College"), 30);

  // ---- the test order goes into production and gets approved ----
  const batch = await api("POST", "/api/batches", {
    cookie: owner.cookie,
    body: {
      orderId: test.orderId, orderItemId: test.itemId, quantity: 50,
      workerId: cutter.id, cuttingRate: 150, tailorId: tailor.id, sewingRate: 300,
    },
  });
  await expectStatus(batch, 201, "Start production on the test order");
  const stages = await api("GET", `/api/operations?batchId=${batch.data.id}`, { cookie: owner.cookie });
  await expectStatus(stages, 200, "Read the batch's stages");
  const cutting = stages.data.find((row: any) => row.stage === "CUTTING");
  const sewing = stages.data.find((row: any) => row.stage === "SEWING");
  assert.ok(cutting && sewing, "The eight-stage route gives the batch a cutting and a sewing stage");

  await expectStatus(
    await api("PUT", "/api/operations", { cookie: cutter.login, body: { id: cutting.id, submitQty: 50 } }),
    200, "The cutter submits all 50"
  );
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: owner.cookie, body: { operationId: cutting.id, quantityApproved: 50, quantityRejected: 0, quantityRework: 0 },
    }),
    201, "50 approved at cutting - this is the history an ordinary delete must refuse to destroy"
  );
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: tailor.login, body: { id: sewing.id, submitQty: 50 } }),
    200, "The tailor submits all 50"
  );
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: manager.cookie, body: { operationId: sewing.id, quantityApproved: 50, quantityRejected: 0, quantityRework: 0 },
    }),
    201, "50 approved at sewing"
  );

  // ---- the tailor hands part of their own stage to a helper ----
  const handed = await api("POST", "/api/support-work", {
    cookie: tailor.login,
    body: { workerId: helper.id, operation: "Weaving", quantityAssigned: 20, pieceRate: 30, productionOperationId: sewing.id },
  });
  await expectStatus(handed, 201, "The tailor delegates 20 pieces of weaving");
  await startSupport(helper.login, handed.data.id);
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: helper.login, body: { id: handed.data.id, submitQty: 20 } }),
    200, "The helper returns all 20"
  );
  await expectStatus(
    await api("PUT", "/api/support-work", {
      cookie: tailor.login, body: { id: handed.data.id, quantityApproved: 20, quantityRework: 0, quantityRejected: 0 },
    }),
    201, "The tailor approves the helper's 20"
  );

  // ---- fabric issued to the test order, and to the order that must survive ----
  await expectStatus(
    await api("POST", "/api/material-usage", {
      cookie: owner.cookie, body: { orderId: test.orderId, materialId: fabric.data.id, quantityUsed: 100, unitCost: 900 },
    }),
    201, "Issue 100 yards to the test order"
  );
  await expectStatus(
    await api("POST", "/api/material-usage", {
      cookie: owner.cookie, body: { orderId: keep.orderId, materialId: fabric.data.id, quantityUsed: 40, unitCost: 900 },
    }),
    201, "Issue 40 yards to the order that must survive"
  );
  // 20 of the test order's yards came back to the store while the job was running, so the
  // shelf was already credited for them once. Only the 80 still out may come back.
  const issued = await api("GET", `/api/material-usage?orderId=${test.orderId}`, { cookie: owner.cookie });
  await expectStatus(issued, 200, "Read the issue");
  const issueRow = (Array.isArray(issued.data) ? issued.data : []).find((row: any) => row.materialId === fabric.data.id);
  assert.ok(issueRow, "The test order's issue is listed");
  await expectStatus(
    await api("PUT", "/api/material-usage", {
      cookie: owner.cookie, body: { id: issueRow.id, quantityUsed: 80, quantityReturned: 20, quantityWasted: 0, notes: "20 yards came back" },
    }),
    200, "Record 20 yards returned to the store"
  );

  /* ---- a ready-made purchase on the test order: a cost, never raw stock ----
   *
   * A ready-made purchase has to satisfy a route stage whose METHOD is READY_MADE - it is
   * not a free-standing expense. So the cardigan gets its own route starting at a bought-in
   * stage, its own order line and its own batch, and the purchase is recorded against that
   * stage. That is the real shape of a finished garment bought in, and it is what makes
   * "did the cleanup treat it as fabric?" a meaningful question.
   */
  const readyRoute = await api("POST", "/api/routes", {
    cookie: owner.cookie,
    body: {
      name: unique("Bought-in cardigan"), productId: cardigan.data.id, isDefault: true,
      stages: [{ stage: "PACKING", method: "READY_MADE" }, { stage: "DELIVERY", method: "INTERNAL" }],
    },
  });
  await expectStatus(readyRoute, 201, "Define the cardigan's bought-in route");
  // On the TEST order's own cardigan line, so the purchase is genuinely part of what the
  // cleanup has to remove - and genuinely part of what it has to leave alone on the shelf.
  const cardiganBatch = await api("POST", "/api/batches", {
    cookie: owner.cookie,
    body: { orderId: test.orderId, orderItemId: test.cardiganItemId, quantity: 5, routeId: readyRoute.data.id },
  });
  await expectStatus(cardiganBatch, 201, "Start the bought-in batch on the test order's cardigan line");
  const cardiganStages = await api("GET", `/api/operations?batchId=${cardiganBatch.data.id}`, { cookie: owner.cookie });
  await expectStatus(cardiganStages, 200, "Read its stages");
  const packing = cardiganStages.data.find((row: any) => row.stage === "PACKING");
  assert.equal(packing.method, "READY_MADE", "The route froze a bought-in packing stage onto the batch");
  await expectStatus(
    await api("POST", "/api/ready-made", {
      cookie: owner.cookie,
      body: { operationId: packing.id, materialId: readyMade.data.id, quantity: 5, unitCost: 5000, supplier: "Test supplier" },
    }),
    201, "Buy in 5 finished cardigans against that stage"
  );

  // ---- money: a customer payment, an expense, and a settled payroll payment ----
  await expectStatus(
    await api("POST", "/api/payments", {
      cookie: owner.cookie, body: { orderId: test.orderId, amount: 60000, paymentDate: "2026-10-03", reference: "TEST-DEPOSIT" },
    }),
    201, "The school pays a deposit on the test order"
  );
  await expectStatus(
    await api("POST", "/api/expenses", {
      cookie: owner.cookie, body: { orderId: test.orderId, category: "Transportation", description: "Test delivery run", amount: 2500, expenseDate: "2026-10-04" },
    }),
    201, "An expense against the test order"
  );
  // Settled for the month the approvals landed in, covering BOTH orders' work - which is
  // precisely why it may not be deleted or edited by a cleanup aimed at one of them.
  await expectStatus(
    await api("POST", "/api/payroll", {
      cookie: owner.cookie,
      body: { workerId: tailor.id, amount: 15000, periodMonth: currentMonth(), paymentDate: "2026-10-05", method: "Bank Transfer", reference: "TEST-PAY-1" },
    }),
    201, "The tailor is paid for the month"
  );
  await expectStatus(
    await api("POST", "/api/payroll", {
      cookie: owner.cookie,
      body: { workerId: helper.id, amount: 600, periodMonth: currentMonth(), paymentDate: "2026-10-05", method: "Cash" },
    }),
    201, "The helper is paid for the month"
  );

  // ---- production on the order that must survive, so it is not merely an empty row ----
  const keepBatch = await api("POST", "/api/batches", {
    cookie: owner.cookie,
    body: { orderId: keep.orderId, orderItemId: keep.itemId, quantity: 30, workerId: cutter.id, cuttingRate: 150 },
  });
  await expectStatus(keepBatch, 201, "Start production on the surviving order");
  const keepStages = await api("GET", `/api/operations?batchId=${keepBatch.data.id}`, { cookie: owner.cookie });
  const keepCutting = keepStages.data.find((row: any) => row.stage === "CUTTING");
  await api("PUT", "/api/operations", { cookie: cutter.login, body: { id: keepCutting.id, submitQty: 30 } });
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: owner.cookie, body: { operationId: keepCutting.id, quantityApproved: 30, quantityRejected: 0, quantityRework: 0 },
    }),
    201, "30 approved on the surviving order"
  );

  return {
    owner, cutter, tailor, helper, manager, shirt, cardigan, fabric, readyMade, test, keep,
    batchId: batch.data.id as number,
    sewingId: sewing.id as number,
  };
}

/**
 * This world's records, as counts, so "nothing else moved" can be asserted exactly.
 *
 * SCOPED TO THE WORLD, NOT TO THE DATABASE. Every test in this file builds its own
 * business through the public API, and they all run in one process against one in-memory
 * database - so an unscoped count would include the eleven other worlds and every
 * assertion would compare one test's total to another's. Each count is therefore bounded
 * to the rows this world can own: its own orders, its own workers, and the children of
 * those. That is also what makes the assertion meaningful - "the surviving order's
 * inspection is still there" is only a statement about THIS world's inspection.
 */
async function census(w: World) {
  const orderIds = [w.test.orderId, w.keep.orderId];
  const countWhere = async (table: any, condition: any) =>
    Number(((await db.select({ total: sql<number>`count(*)` }).from(table).where(condition))[0] as any)?.total ?? 0);

  const batchRows = await db.select({ id: productionBatches.id }).from(productionBatches).where(inArray(productionBatches.orderId, orderIds));
  const batchIds = batchRows.map((row) => row.id);
  const opRows = batchIds.length
    ? await db.select({ id: productionOperations.id }).from(productionOperations).where(inArray(productionOperations.productionBatchId, batchIds))
    : [];
  const operationIds = opRows.map((row) => row.id);
  const workerIds = [w.cutter.id, w.tailor.id, w.helper.id];

  const [fabric] = await db.select().from(materials).where(eq(materials.id, w.fabric.data.id));
  const [readyMade] = await db.select().from(materials).where(eq(materials.id, w.readyMade.data.id));
  return {
    orders: await countWhere(orders, inArray(orders.id, orderIds)),
    orderItems: await countWhere(orderItems, inArray(orderItems.orderId, orderIds)),
    batches: batchIds.length,
    operations: operationIds.length,
    inspections: operationIds.length
      ? await countWhere(stageInspections, inArray(stageInspections.productionOperationId, operationIds))
      : 0,
    support: await countWhere(supportAssignments, inArray(supportAssignments.orderId, orderIds)),
    payments: await countWhere(payments, inArray(payments.orderId, orderIds)),
    expenses: await countWhere(expenses, inArray(expenses.orderId, orderIds)),
    usage: await countWhere(materialUsage, inArray(materialUsage.orderId, orderIds)),
    purchases: await countWhere(materialPurchases, inArray(materialPurchases.orderId, orderIds)),
    workerPayments: await countWhere(workerPayments, inArray(workerPayments.workerId, workerIds)),
    workers: await countWhere(workers, inArray(workers.id, workerIds)),
    products: await countWhere(products, inArray(products.id, [w.shirt.data.id, w.cardigan.data.id])),
    customers: await countWhere(customers, inArray(customers.id, [w.test.customerId, w.keep.customerId])),
    routes: await countWhere(productionRoutes, eq(productionRoutes.productId, w.cardigan.data.id)),
    fabricStock: fabric?.currentStock ?? null,
    readyMadeStock: readyMade?.currentStock ?? null,
    // The audit tables are global by nature - they record what was destroyed - so they are
    // scoped by the order ids this world owns rather than by a count of every row.
    purges: await countWhere(testDataPurges, inArray(testDataPurges.orderId, orderIds)),
    deletions: await countWhere(orderDeletions, inArray(orderDeletions.orderId, orderIds)),
  };
}

const VALID_REASON = "Test order created while trialling production before go-live";

/** Preview, then execute with both confirmations correct. Returns the execution result. */
async function purge(w: World, overrides: Record<string, unknown> = {}) {
  const preview = await api("GET", `/api/test-data-cleanup?orderId=${w.test.orderId}`, { cookie: w.owner.cookie });
  await expectStatus(preview, 200, "Preview the cleanup");
  return api("POST", "/api/test-data-cleanup", {
    cookie: w.owner.cookie,
    body: {
      orderId: w.test.orderId,
      confirmCustomerName: preview.data.customerName,
      confirmOrderNumber: preview.data.orderNumber,
      reason: VALID_REASON,
      fingerprint: preview.data.fingerprint,
      ...overrides,
    },
  });
}

// ---------------------------------------------------------------------------
// 1. Authorisation
// ---------------------------------------------------------------------------

test("a Project Manager cannot preview or run a cleanup, and is not told what is behind the order", async () => {
  const w = await world();
  const before = await census(w);

  const preview = await api("GET", `/api/test-data-cleanup?orderId=${w.test.orderId}`, { cookie: w.manager.cookie });
  assert.equal(preview.status, 403, "The preview is Owner-only");

  const run = await api("POST", "/api/test-data-cleanup", {
    cookie: w.manager.cookie,
    body: {
      orderId: w.test.orderId, confirmCustomerName: w.test.schoolName,
      confirmOrderNumber: w.test.orderNumber, reason: "A manager trying to clear records", fingerprint: "0".repeat(64),
    },
  });
  assert.equal(run.status, 403, "So is the execution");

  const after = await census(w);
  assert.deepEqual(after, before, "A refused cleanup changed nothing at all");
});

test("a Worker cannot preview or run a cleanup", async () => {
  const w = await world();
  const before = await census(w);
  const preview = await api("GET", `/api/test-data-cleanup?orderId=${w.test.orderId}`, { cookie: w.tailor.login });
  assert.equal(preview.status, 403);
  const run = await api("POST", "/api/test-data-cleanup", {
    cookie: w.tailor.login,
    body: { orderId: w.test.orderId, confirmCustomerName: w.test.schoolName, confirmOrderNumber: w.test.orderNumber, reason: "A tailor clearing their own trail", fingerprint: "0".repeat(64) },
  });
  assert.equal(run.status, 403);
  assert.deepEqual(await census(w), before, "Nothing was removed");
});

test("an unauthenticated caller is refused before anything is read", async () => {
  const w = await world();
  const before = await census(w);
  const preview = await api("GET", `/api/test-data-cleanup?orderId=${w.test.orderId}`);
  assert.equal(preview.status, 401);
  const run = await api("POST", "/api/test-data-cleanup", {
    body: { orderId: w.test.orderId, confirmCustomerName: w.test.schoolName, confirmOrderNumber: w.test.orderNumber, reason: "Anonymous", fingerprint: "0".repeat(64) },
  });
  assert.equal(run.status, 401);
  assert.deepEqual(await census(w), before);
});

test("an order belonging to another organisation is not found, rather than found and refused", async () => {
  const w = await world();
  const before = await census(w);
  // A second organisation, with an order of its own. Nothing about it may be reachable
  // from the first one's Owner - and the answer must not reveal that the id exists.
  await db.insert(organizations).values({ id: 2, name: "Another Company" });
  const [otherCustomer] = await db.insert(customers).values({ organizationId: 2, name: "Other Company School" }).returning();
  const [otherProduct] = await db.insert(products).values({ organizationId: 2, name: "Other Uniform", sellingPrice: 1000 }).returning();
  const [otherOrder] = await db.insert(orders).values({
    organizationId: 2, customerId: otherCustomer.id, orderNumber: unique("OTHER-"), orderDate: "2026-10-01",
    status: "PENDING", totalAmount: 10000, amountPaid: 0, balance: 10000,
  }).returning();
  await db.insert(orderItems).values({ orderId: otherOrder.id, productId: otherProduct.id, quantity: 10, unitPrice: 1000, totalPrice: 10000 });

  const preview = await api("GET", `/api/test-data-cleanup?orderId=${otherOrder.id}`, { cookie: w.owner.cookie });
  assert.equal(preview.status, 404, "Another organisation's order is not found");
  assert.match(String(preview.data.error), /could not be found/i);

  const run = await api("POST", "/api/test-data-cleanup", {
    cookie: w.owner.cookie,
    body: { orderId: otherOrder.id, confirmCustomerName: "Other Company School", confirmOrderNumber: otherOrder.orderNumber, reason: "Pointed at another company's order", fingerprint: "0".repeat(64) },
  });
  assert.equal(run.status, 404, "And cannot be executed on");

  const [stillThere] = await db.select().from(orders).where(eq(orders.id, otherOrder.id));
  assert.ok(stillThere, "The other organisation's order survives untouched");
  assert.equal(stillThere.organizationId, 2, "and still belongs to its own organisation");
  // Asserted about THIS world rather than as a global count: every test in this file
  // builds its own business in the same in-memory database, so a database-wide total
  // measures the other tests, not this one.
  const after = await census(w);
  assert.deepEqual(after, before, "This world's own records were not touched by the probe");
});

// ---------------------------------------------------------------------------
// 2. The confirmations
// ---------------------------------------------------------------------------

test("the wrong school name is refused, and the neighbouring order is what makes that matter", async () => {
  const w = await world();
  const before = await census(w);
  // The name of a DIFFERENT real school in the same database: the mistake this control
  // exists to stop, because it would otherwise look plausible.
  const run = await purge(w, { confirmCustomerName: w.keep.schoolName });
  assert.equal(run.status, 409, "Refused");
  assert.match(String(run.data.error), /not the school on this order/i);
  assert.deepEqual(await census(w), before, "Nothing was removed, and no audit row was written");
});

test("a school name that differs only by spacing or case is accepted, because a person typed it", async () => {
  const w = await world();
  const run = await purge(w, { confirmCustomerName: `  ${w.test.schoolName.toUpperCase()}  ` });
  await expectStatus(run, 200, "Whitespace and case are not a reason to refuse a correct confirmation");
  assert.equal(run.data.orderNumber, w.test.orderNumber);
});

test("the wrong order number is refused", async () => {
  const w = await world();
  const before = await census(w);
  const run = await purge(w, { confirmOrderNumber: w.keep.orderNumber });
  assert.equal(run.status, 409);
  assert.match(String(run.data.error), /not this order's number/i);
  assert.deepEqual(await census(w), before);
});

test("a reason is mandatory, and a token one is not enough", async () => {
  const w = await world();
  const before = await census(w);
  // Each of these is under the 10-character minimum. "not long enough" is NOT in the
  // list, because it is 15 characters and would be accepted - the first version of this
  // test used it, purged the order on the first iteration, and then failed every later
  // test in the file by removing the fixture they were about to build.
  for (const reason of ["", "   ", "test", "too short", "123456789"]) {
    const run = await purge(w, { reason });
    assert.equal(run.status, 400, `Refused: "${reason}"`);
    assert.match(String(run.data.error), /reason/i);
  }
  assert.deepEqual(await census(w), before, "Four refusals changed nothing");
});

test("a fingerprint that was never issued is refused rather than treated as a wildcard", async () => {
  const w = await world();
  const before = await census(w);
  // Malformed: not a digest at all, so it is refused as a bad request before anything is
  // looked up.
  for (const fingerprint of ["", "abc", "f".repeat(63), "z".repeat(64)]) {
    const run = await purge(w, { fingerprint });
    assert.equal(run.status, 400, `Refused as malformed: "${fingerprint.slice(0, 8) || "(empty)"}"`);
    assert.match(String(run.data.error), /current preview/i);
  }
  // Well-formed but not the digest of THIS order's records: refused as stale. Both answers
  // are refusals, and the distinction matters because 409 tells the Owner to take a fresh
  // preview while 400 tells them the request was not shaped properly.
  const wrongDigest = await purge(w, { fingerprint: "0".repeat(64) });
  assert.equal(wrongDigest.status, 409, "A digest that does not match is refused as stale");
  assert.match(String(wrongDigest.data.error), /changed since the preview/i);
  assert.deepEqual(await census(w), before, "Five refusals removed nothing");
});

// ---------------------------------------------------------------------------
// 3. Staleness and single use
// ---------------------------------------------------------------------------

test("a preview goes stale when anything about the order changes, and the purge is refused", async () => {
  const w = await world();
  const preview = await api("GET", `/api/test-data-cleanup?orderId=${w.test.orderId}`, { cookie: w.owner.cookie });
  await expectStatus(preview, 200, "Take a preview");
  const before = await census(w);

  // Somebody records another expense against the order between the preview and the click.
  await expectStatus(
    await api("POST", "/api/expenses", {
      cookie: w.owner.cookie, body: { orderId: w.test.orderId, category: "Packaging", description: "Added after the preview", amount: 500, expenseDate: "2026-10-06" },
    }),
    201, "An expense is added after the preview was taken"
  );

  const run = await api("POST", "/api/test-data-cleanup", {
    cookie: w.owner.cookie,
    body: {
      orderId: w.test.orderId, confirmCustomerName: w.test.schoolName, confirmOrderNumber: w.test.orderNumber,
      reason: "Confirming against a preview that no longer describes the order", fingerprint: preview.data.fingerprint,
    },
  });
  assert.equal(run.status, 409, "The stale confirmation is refused");
  assert.match(String(run.data.error), /changed since the preview/i);

  const after = await census(w);
  assert.equal(after.expenses, before.expenses + 1, "The only change is the expense that was genuinely added");
  assert.equal(after.orders, before.orders, "and the order is still there");
  assert.equal(after.purges, 0, "A refused purge writes no audit row claiming it happened");
});

test("a preview goes stale when production is added to the order", async () => {
  const w = await world();
  const preview = await api("GET", `/api/test-data-cleanup?orderId=${w.test.orderId}`, { cookie: w.owner.cookie });
  await expectStatus(preview, 200, "Take a preview");

  // A second batch appears on the same order: more production, more ledger, more rows.
  const second = await api("POST", "/api/batches", {
    cookie: w.owner.cookie, body: { orderId: w.test.orderId, orderItemId: w.test.itemId, quantity: 0 },
  });
  // Quantity 0 is refused by the batches route, so add a real one within the ceiling.
  assert.equal(second.status, 400, "A zero-quantity batch is refused, so the order is unchanged");

  const run = await api("POST", "/api/test-data-cleanup", {
    cookie: w.owner.cookie,
    body: {
      orderId: w.test.orderId, confirmCustomerName: w.test.schoolName, confirmOrderNumber: w.test.orderNumber,
      reason: "Still pointing at the old preview", fingerprint: preview.data.fingerprint,
    },
  });
  await expectStatus(run, 200, "Nothing changed, so the preview is still current and the purge proceeds");
  assert.equal(run.data.orderNumber, w.test.orderNumber);
});

test("the same fingerprint cannot be used twice", async () => {
  const w = await world();
  const preview = await api("GET", `/api/test-data-cleanup?orderId=${w.test.orderId}`, { cookie: w.owner.cookie });
  await expectStatus(preview, 200, "Take a preview");
  const body = {
    orderId: w.test.orderId, confirmCustomerName: w.test.schoolName, confirmOrderNumber: w.test.orderNumber,
    reason: "Test order created while trialling production before go-live", fingerprint: preview.data.fingerprint,
  };
  const first = await api("POST", "/api/test-data-cleanup", { cookie: w.owner.cookie, body });
  await expectStatus(first, 200, "The first execution succeeds");

  // Replaying the identical request must not succeed again. The order is gone, so the
  // honest answer is "not found" - and crucially not a second audit row.
  const second = await api("POST", "/api/test-data-cleanup", { cookie: w.owner.cookie, body });
  assert.equal(second.status, 404, "A replayed confirmation finds nothing to remove");
  // Scoped to this order: other tests in this file purge their own orders in the same
  // in-memory database, so a database-wide count would measure them.
  const auditRows = await db.select().from(testDataPurges).where(eq(testDataPurges.orderId, w.test.orderId));
  assert.equal(auditRows.length, 1, "Exactly one purge was recorded for this order, not two");
});

// ---------------------------------------------------------------------------
// 4. What is removed, and what is not
// ---------------------------------------------------------------------------

test("every record belonging to the test order is removed, including support work that would otherwise be orphaned", async () => {
  const w = await world();
  // Support work references the order with ON DELETE SET NULL, so an ordinary cascade
  // would leave the helper's assignment pointing at nothing. It has to be removed
  // deliberately, and this is the assertion that would catch it being missed.
  const [supportBefore] = await db.select({ total: sql<number>`count(*)` }).from(supportAssignments).where(eq(supportAssignments.orderId, w.test.orderId));
  assert.ok(Number((supportBefore as any).total) > 0, "The test order has support work behind it");

  const run = await purge(w);
  await expectStatus(run, 200, "Run the cleanup");

  const remaining = {
    orders: await db.select().from(orders).where(eq(orders.id, w.test.orderId)),
    items: await db.select().from(orderItems).where(eq(orderItems.orderId, w.test.orderId)),
    batches: await db.select().from(productionBatches).where(eq(productionBatches.orderId, w.test.orderId)),
    support: await db.select().from(supportAssignments).where(eq(supportAssignments.orderId, w.test.orderId)),
    payments: await db.select().from(payments).where(eq(payments.orderId, w.test.orderId)),
    expenses: await db.select().from(expenses).where(eq(expenses.orderId, w.test.orderId)),
    usage: await db.select().from(materialUsage).where(eq(materialUsage.orderId, w.test.orderId)),
    purchases: await db.select().from(materialPurchases).where(eq(materialPurchases.orderId, w.test.orderId)),
  };
  for (const [name, rows] of Object.entries(remaining))
    assert.equal(rows.length, 0, `No ${name} belonging to the removed order survives`);

  // Orphans are the failure mode that a count of the order's own rows would miss.
  const [orphanSupport] = await db.select({ total: sql<number>`count(*)` }).from(supportAssignments).where(sql`${supportAssignments.orderId} is null`);
  assert.equal(Number((orphanSupport as any).total), 0, "No support assignment was orphaned by the removal");
  const [orphanOperations] = await db.select({ total: sql<number>`count(*)` })
    .from(sql`(select po."id" from "production_operations" po left join "production_batches" pb on pb."id" = po."production_batch_id" where pb."id" is null) as x`);
  assert.equal(Number((orphanOperations as any).total), 0, "No production stage was left without its batch");
  const [orphanInspections] = await db.select({ total: sql<number>`count(*)` })
    .from(sql`(select si."id" from "stage_inspections" si left join "production_operations" po on po."id" = si."production_operation_id" where po."id" is null) as x`);
  assert.equal(Number((orphanInspections as any).total), 0, "No inspection was left without its stage");
});

test("the preview's counts are what actually disappeared", async () => {
  const w = await world();
  const before = await census(w);
  const preview = await api("GET", `/api/test-data-cleanup?orderId=${w.test.orderId}`, { cookie: w.owner.cookie });
  await expectStatus(preview, 200, "Take the preview");
  const run = await api("POST", "/api/test-data-cleanup", {
    cookie: w.owner.cookie,
    body: {
      orderId: w.test.orderId, confirmCustomerName: w.test.schoolName, confirmOrderNumber: w.test.orderNumber,
      reason: "Test order created while trialling production before go-live", fingerprint: preview.data.fingerprint,
    },
  });
  await expectStatus(run, 200, "Run the cleanup");
  const after = await census(w);

  // The point of the assertion: the preview is a PROMISE, and the database is what has to
  // keep it. A preview that under-reported would let an Owner confirm something larger
  // than what they were shown.
  assert.equal(before.orders - after.orders, preview.data.counts.orders, "The order count fell by exactly what was promised");
  assert.equal(before.orderItems - after.orderItems, preview.data.counts.order_items);
  assert.equal(before.batches - after.batches, preview.data.counts.production_batches);
  assert.equal(before.operations - after.operations, preview.data.counts.production_operations);
  assert.equal(before.inspections - after.inspections, preview.data.counts.stage_inspections);
  assert.equal(before.support - after.support, preview.data.counts.support_assignments);
  assert.equal(before.payments - after.payments, preview.data.counts.payments);
  assert.equal(before.expenses - after.expenses, preview.data.counts.expenses);
  assert.equal(before.usage - after.usage, preview.data.counts.material_usage);
  assert.deepEqual(run.data.removed, preview.data.counts, "And the result reports the same figures the preview showed");
});

test("shared master data survives: the school, the garments, the workers, the routes and the materials", async () => {
  const w = await world();
  const before = await census(w);
  const run = await purge(w);
  await expectStatus(run, 200, "Run the cleanup");
  const after = await census(w);

  assert.equal(after.customers, before.customers, "The school is a shared master record and survives");
  assert.equal(after.products, before.products, "So are the garments");
  assert.equal(after.workers, before.workers, "So are the people - a purge must never remove a worker");
  assert.equal(after.routes, before.routes, "So are the route definitions");

  const [school] = await db.select().from(customers).where(eq(customers.id, w.test.customerId));
  assert.ok(school, "The test order's own school still exists, because a school is not owned by one order");
  const [tailor] = await db.select().from(workers).where(eq(workers.id, w.tailor.id));
  assert.ok(tailor, "The tailor who worked on it still exists, with their history on other orders");
  const [fabric] = await db.select().from(materials).where(eq(materials.id, w.fabric.data.id));
  assert.ok(fabric, "The shared fabric record survives");
});

test("an unrelated order and its production survive untouched", async () => {
  const w = await world();
  const run = await purge(w);
  await expectStatus(run, 200, "Run the cleanup");

  const [survivor] = await db.select().from(orders).where(eq(orders.id, w.keep.orderId));
  assert.ok(survivor, "The neighbouring order for a different school still exists");
  assert.equal(survivor.totalAmount, 30 * 3000, "with its own value intact");

  const keepBatches = await db.select().from(productionBatches).where(eq(productionBatches.orderId, w.keep.orderId));
  assert.equal(keepBatches.length, 1, "Its batch survives");
  const keepOps = await db.select().from(productionOperations).where(eq(productionOperations.productionBatchId, keepBatches[0].id));
  assert.ok(keepOps.length > 0, "and so do its stages");
  const keepInspections = await db.select().from(stageInspections).where(eq(stageInspections.productionOperationId, keepOps.find((op) => op.stage === "CUTTING")!.id));
  assert.equal(keepInspections.length, 1, "and its approved inspection - the other order's history is not collateral");
  assert.equal(keepInspections[0].quantityApproved, 30);

  const keepUsage = await db.select().from(materialUsage).where(eq(materialUsage.orderId, w.keep.orderId));
  assert.equal(keepUsage.length, 1, "Its material issue survives");
  assert.equal(keepUsage[0].quantityUsed, 40, "unchanged - it is the surviving order's own 40 yards");
});

// ---------------------------------------------------------------------------
// 5. Payroll
// ---------------------------------------------------------------------------

test("settled payroll is reported and never rewritten, and an unrelated worker's pay is untouched", async () => {
  const w = await world();
  const tailorPayBefore = await db.select().from(workerPayments).where(eq(workerPayments.workerId, w.tailor.id));
  const helperPayBefore = await db.select().from(workerPayments).where(eq(workerPayments.workerId, w.helper.id));
  assert.equal(tailorPayBefore.length, 1, "The tailor has one settled payment");
  assert.equal(helperPayBefore.length, 1, "and so does the helper");

  const preview = await api("GET", `/api/test-data-cleanup?orderId=${w.test.orderId}`, { cookie: w.owner.cookie });
  await expectStatus(preview, 200, "Take the preview");
  // The preview has to NAME the money already paid, or the Owner is confirming blind.
  assert.ok(preview.data.payroll.settledPayments.length >= 1, "The preview reports settled payroll");
  const reported = preview.data.payroll.settledPayments.find((row: any) => row.workerId === w.tailor.id);
  assert.ok(reported, "including the tailor's");
  assert.equal(reported.paidAmount, 15000, "with the amount actually paid");
  assert.ok(reported.fromThisOrder > 0, "and what this order contributed to it");

  const run = await api("POST", "/api/test-data-cleanup", {
    cookie: w.owner.cookie,
    body: {
      orderId: w.test.orderId, confirmCustomerName: w.test.schoolName, confirmOrderNumber: w.test.orderNumber,
      reason: "Test order created while trialling production before go-live", fingerprint: preview.data.fingerprint,
    },
  });
  await expectStatus(run, 200, "Run the cleanup");

  const tailorPayAfter = await db.select().from(workerPayments).where(eq(workerPayments.workerId, w.tailor.id));
  assert.equal(tailorPayAfter.length, 1, "The settled payment was NOT deleted");
  assert.equal(tailorPayAfter[0].amount, 15000, "and NOT reduced - money that reached a bank is a fact, not a row to tidy");
  assert.equal(tailorPayAfter[0].reference, "TEST-PAY-1", "It is byte-for-byte the same payment");
  const helperPayAfter = await db.select().from(workerPayments).where(eq(workerPayments.workerId, w.helper.id));
  assert.equal(helperPayAfter.length, 1, "The helper's payment is untouched too");
  assert.equal(helperPayAfter[0].amount, 600);

  // The audit row carries the report, so the Owner can act on it later.
  const [audit] = await db.select().from(testDataPurges).where(eq(testDataPurges.orderId, w.test.orderId));
  assert.ok(audit.payrollReport, "The payroll report was recorded permanently");
  assert.match(audit.payrollReport!, /15000/, "and it names the settled amount");
});

test("the earnings accrual disappears with the approvals behind it, so payroll recomputes without the test order", async () => {
  const w = await world();
  const before = await api("GET", `/api/payroll?month=${currentMonth()}`, { cookie: w.owner.cookie });
  await expectStatus(before, 200, "Payroll before the cleanup");
  const tailorBefore = before.data.workers.find((row: any) => row.workerId === w.tailor.id);
  assert.ok(tailorBefore, "The tailor is on the payroll sheet");
  assert.ok(tailorBefore.piecework > 0, "with piecework from the approved production");

  await expectStatus(await purge(w), 200, "Run the cleanup");

  const after = await api("GET", `/api/payroll?month=${currentMonth()}`, { cookie: w.owner.cookie });
  await expectStatus(after, 200, "Payroll after the cleanup");
  const tailorAfter = after.data.workers.find((row: any) => row.workerId === w.tailor.id);
  // The test order's approvals are gone, so the accrual they created is gone with them.
  assert.ok(!tailorAfter || tailorAfter.piecework < tailorBefore.piecework,
    "The piecework accrual fell once the approvals behind it were removed");
});

// ---------------------------------------------------------------------------
// 6. Inventory
// ---------------------------------------------------------------------------

test("stock is restored by what stayed out, not by the full issue, and the other order's draw is left alone", async () => {
  const w = await world();
  // 400 bought, 100 issued to the test order, 40 to the survivor, and 20 of the test
  // order's yards already came back - so the shelf reads 400 - 100 + 20 - 40 = 280.
  const [fabricBefore] = await db.select().from(materials).where(eq(materials.id, w.fabric.data.id));
  assert.equal(fabricBefore.currentStock, 280, "The shelf is where the issues and the return left it");

  const preview = await api("GET", `/api/test-data-cleanup?orderId=${w.test.orderId}`, { cookie: w.owner.cookie });
  await expectStatus(preview, 200, "Take the preview");
  const restock = preview.data.inventory.restock.find((entry: any) => entry.materialId === w.fabric.data.id);
  assert.ok(restock, "The preview says stock will come back");
  assert.equal(restock.quantity, 80, "and it is the 80 that stayed out, NOT the 100 that was issued");

  const run = await api("POST", "/api/test-data-cleanup", {
    cookie: w.owner.cookie,
    body: {
      orderId: w.test.orderId, confirmCustomerName: w.test.schoolName, confirmOrderNumber: w.test.orderNumber,
      reason: "Test order created while trialling production before go-live", fingerprint: preview.data.fingerprint,
    },
  });
  await expectStatus(run, 200, "Run the cleanup");

  const [fabricAfter] = await db.select().from(materials).where(eq(materials.id, w.fabric.data.id));
  // 280 + 80 = 360: the test order's 80 come home, and the survivor's 40 stay out.
  assert.equal(fabricAfter.currentStock, 360, "Only the removed order's material came back");
  assert.notEqual(fabricAfter.currentStock, 400, "and the surviving order's issue was NOT reversed - it really was consumed");
});

test("a ready-made purchase is removed as a cost and never touches raw-material stock", async () => {
  const w = await world();
  const [readyBefore] = await db.select().from(materials).where(eq(materials.id, w.readyMade.data.id));
  assert.equal(readyBefore.currentStock, 0, "A bought-in finished garment never entered raw inventory");

  const preview = await api("GET", `/api/test-data-cleanup?orderId=${w.test.orderId}`, { cookie: w.owner.cookie });
  await expectStatus(preview, 200, "Take the preview");
  const readyEntry = preview.data.inventory.readyMade.find((entry: any) => entry.materialId === w.readyMade.data.id);
  assert.ok(readyEntry, "The preview classifies it as ready-made");
  assert.equal(readyEntry.quantity, 5);
  assert.ok(
    !preview.data.inventory.despurchase.some((entry: any) => entry.materialId === w.readyMade.data.id),
    "and does NOT propose taking finished garments off the fabric shelf"
  );

  await expectStatus(await purge(w), 200, "Run the cleanup");

  const [readyAfter] = await db.select().from(materials).where(eq(materials.id, w.readyMade.data.id));
  assert.equal(readyAfter.currentStock, 0, "Its stock figure did not move in either direction");
  assert.equal(readyBefore.currentStock, 0, "It was never stock in the first place");
  assert.ok(readyAfter, "and the ready-made material record itself survives, because it is shared master data");
  const left = await db.select().from(materialPurchases).where(eq(materialPurchases.orderId, w.test.orderId));
  assert.equal(left.length, 0, "The purchase record belonging to the order is gone");
});

test("a cleanup that would drive stock negative refuses to run and changes nothing", async () => {
  const w = await world();
  // Buy in raw fabric against the test order, so removing the purchase has to take it
  // back off the shelf...
  await expectStatus(
    await api("POST", "/api/material-purchases", {
      cookie: w.owner.cookie, body: { materialId: w.fabric.data.id, orderId: w.test.orderId, supplier: "Test mill", quantity: 200, unitCost: 900, purchaseDate: "2026-10-02" },
    }),
    201, "Buy 200 yards against the test order"
  );
  // ...then consume more than the shelf would be left holding, on the OTHER order, so the
  // reversal cannot honestly be performed. 400 opened, +200 bought, -100 and -40 issued,
  // +20 returned = 480 on the shelf; consuming 450 leaves 30, and giving back the
  // purchase's 200 would need 230 more than that.
  await expectStatus(
    await api("POST", "/api/material-usage", {
      cookie: w.owner.cookie, body: { orderId: w.keep.orderId, materialId: w.fabric.data.id, quantityUsed: 450, unitCost: 900 },
    }),
    201, "The surviving order consumes the shelf"
  );
  const before = await census(w);
  const [fabricNow] = await db.select().from(materials).where(eq(materials.id, w.fabric.data.id));

  const preview = await api("GET", `/api/test-data-cleanup?orderId=${w.test.orderId}`, { cookie: w.owner.cookie });
  await expectStatus(preview, 200, "Take the preview");
  assert.ok(preview.data.blockers.length > 0, "The preview says the cleanup cannot run");
  assert.match(String(preview.data.blockers[0]), /cannot go negative/i);

  const run = await api("POST", "/api/test-data-cleanup", {
    cookie: w.owner.cookie,
    body: {
      orderId: w.test.orderId, confirmCustomerName: w.test.schoolName, confirmOrderNumber: w.test.orderNumber,
      reason: "Trying to clear a test order whose stock cannot be given back", fingerprint: preview.data.fingerprint,
    },
  });
  assert.equal(run.status, 409, "And the execution refuses for the same reason");
  assert.match(String(run.data.error), /cannot go negative/i);

  const after = await census(w);
  assert.deepEqual(after, before, "Nothing at all was removed, and no stock figure moved");
  assert.equal(after.purges, 0, "A refused purge leaves no audit row behind");
  const [orderStill] = await db.select().from(orders).where(eq(orders.id, w.test.orderId));
  assert.ok(orderStill, "The test order is still there, to be dealt with once the stock figure is corrected");
  assert.equal(fabricNow.currentStock, after.fabricStock, "The shelf reads exactly as it did");
});

// ---------------------------------------------------------------------------
// 7. The ordinary deletion, and the line between the two
// ---------------------------------------------------------------------------

test("an order with approved production cannot be deleted from the Orders screen, and the refusal says where to go", async () => {
  const w = await world();
  const before = await census(w);
  const run = await api("DELETE", `/api/orders/${w.test.orderId}?reason=${encodeURIComponent("Clearing a test order")}`, { cookie: w.owner.cookie });
  assert.equal(run.status, 409, "Refused");
  assert.match(String(run.data.error), /real history/i);
  assert.match(String(run.data.error), /Test data cleanup|Settings/i, "and it points at the administrative route instead");
  assert.deepEqual(await census(w), before, "Nothing was removed");
});

test("an order with a customer payment cannot be deleted from the Orders screen", async () => {
  const w = await world();
  // An order with money but no production: still not removable by a click, because a
  // receipt is a document somebody has been given.
  const customer = await api("POST", "/api/customers", { cookie: w.owner.cookie, body: { name: unique("Paid Only School"), type: "SCHOOL" } });
  const order = await api("POST", "/api/orders", {
    cookie: w.owner.cookie,
    body: { customerId: customer.data.id, orderDate: "2026-10-01", items: [{ productId: w.shirt.data.id, quantity: 5, unitPrice: 3000 }] },
  });
  await expectStatus(order, 201, "Create the order");
  await expectStatus(
    await api("POST", "/api/payments", { cookie: w.owner.cookie, body: { orderId: order.data.id, amount: 5000, paymentDate: "2026-10-02" } }),
    201, "Take a payment"
  );
  const before = await census(w);
  const run = await api("DELETE", `/api/orders/${order.data.id}?reason=${encodeURIComponent("A paid test order")}`, { cookie: w.owner.cookie });
  assert.equal(run.status, 409);
  assert.match(String(run.data.error), /customer payment/i);
  assert.deepEqual(await census(w), before);
});

test("an untouched order can still be deleted from the Orders screen, with a reason, and the removal is recorded", async () => {
  const w = await world();
  // The protection must not become an obstacle to tidying an ordinary mistake: an order
  // that never went anywhere is still removable the easy way.
  const customer = await api("POST", "/api/customers", { cookie: w.owner.cookie, body: { name: unique("Mistake School"), type: "SCHOOL" } });
  const order = await api("POST", "/api/orders", {
    cookie: w.owner.cookie,
    body: { customerId: customer.data.id, orderDate: "2026-10-01", items: [{ productId: w.shirt.data.id, quantity: 5, unitPrice: 3000 }] },
  });
  await expectStatus(order, 201, "Create an order that goes nowhere");

  const tooShort = await api("DELETE", `/api/orders/${order.data.id}?reason=typo`, { cookie: w.owner.cookie });
  assert.equal(tooShort.status, 400, "A reason is required here too");

  const run = await api("DELETE", `/api/orders/${order.data.id}?reason=${encodeURIComponent("Created in error while testing")}`, { cookie: w.owner.cookie });
  await expectStatus(run, 200, "Removing it succeeds");
  const [gone] = await db.select().from(orders).where(eq(orders.id, order.data.id));
  assert.ok(!gone, "The order is gone");
  const [audit] = await db.select().from(orderDeletions).where(eq(orderDeletions.orderId, order.data.id));
  assert.ok(audit, "and the removal was recorded permanently");
  assert.equal(audit.reason, "Created in error while testing");
  assert.equal(audit.deletedByName, "Test Owner", "with the actor taken from the session");
});

test("a Project Manager cannot delete an order either", async () => {
  const w = await world();
  const customer = await api("POST", "/api/customers", { cookie: w.owner.cookie, body: { name: unique("PM Target School"), type: "SCHOOL" } });
  const order = await api("POST", "/api/orders", {
    cookie: w.owner.cookie,
    body: { customerId: customer.data.id, orderDate: "2026-10-01", items: [{ productId: w.shirt.data.id, quantity: 5, unitPrice: 3000 }] },
  });
  await expectStatus(order, 201, "Create the order");
  const before = await census(w);
  const run = await api("DELETE", `/api/orders/${order.data.id}?reason=${encodeURIComponent("A manager removing an order")}`, { cookie: w.manager.cookie });
  assert.equal(run.status, 403, "Deletion stays Owner-only");
  assert.deepEqual(await census(w), before);
});

// ---------------------------------------------------------------------------
// 8. The audit trail
// ---------------------------------------------------------------------------

test("a purge is recorded permanently with the actor, the reason, the confirmations and what went", async () => {
  const w = await world();
  const run = await purge(w);
  await expectStatus(run, 200, "Run the cleanup");

  const audits = await db.select().from(testDataPurges).where(eq(testDataPurges.orderId, w.test.orderId));
  assert.equal(audits.length, 1, "Exactly one audit row for this order");
  const audit = audits[0];
  assert.ok(audit, "The audit row exists");
  assert.equal(audit.orderId, w.test.orderId);
  assert.equal(audit.orderNumber, w.test.orderNumber, "It names the order number, which survives the order");
  assert.equal(audit.customerName, w.test.schoolName, "and the school");
  assert.equal(audit.confirmedCustomerName, w.test.schoolName, "and what the Owner typed to confirm it");
  assert.equal(audit.ranByName, "Test Owner", "The actor comes from the session");
  assert.match(audit.reason, /before go-live/);
  assert.ok(audit.previewFingerprint, "The fingerprint it was authorised by is kept");
  const counts = JSON.parse(audit.previewCounts ?? "{}");
  assert.equal(counts.orders, 1, "The counts it promised are kept");
  assert.ok(counts.production_operations > 0, "including the production behind the order");

  const history = await api("GET", "/api/test-data-cleanup?history=1", { cookie: w.owner.cookie });
  await expectStatus(history, 200, "The Owner can read the record back");
  assert.ok(
    history.data.purges.some((row: any) => row.orderId === w.test.orderId),
    "and it lists this purge among them"
  );
});

test("a forged actor in the request body is ignored, because the audit names the session", async () => {
  const w = await world();
  const preview = await api("GET", `/api/test-data-cleanup?orderId=${w.test.orderId}`, { cookie: w.owner.cookie });
  await expectStatus(preview, 200, "Take the preview");
  const run = await api("POST", "/api/test-data-cleanup", {
    cookie: w.owner.cookie,
    body: {
      orderId: w.test.orderId, confirmCustomerName: w.test.schoolName, confirmOrderNumber: w.test.orderNumber,
      reason: "Test order created while trialling production before go-live", fingerprint: preview.data.fingerprint,
      // Somebody else's name, offered by the caller.
      ranByName: "Somebody Else", actor: { name: "Somebody Else" },
    },
  });
  await expectStatus(run, 200, "The purge runs");
  const [audit] = await db.select().from(testDataPurges).where(eq(testDataPurges.orderId, w.test.orderId));
  assert.equal(audit.ranByName, "Test Owner", "and the record names who was actually signed in");
  assert.notEqual(audit.ranByName, "Somebody Else");
});

test("the cleanup history is Owner-only", async () => {
  const w = await world();
  await expectStatus(await purge(w), 200, "Run a cleanup so there is history to protect");
  const asManager = await api("GET", "/api/test-data-cleanup?history=1", { cookie: w.manager.cookie });
  assert.equal(asManager.status, 403, "A Project Manager cannot read it");
  const asWorker = await api("GET", "/api/test-data-cleanup?history=1", { cookie: w.tailor.login });
  assert.equal(asWorker.status, 403, "and neither can a Worker");
  const anonymous = await api("GET", "/api/test-data-cleanup?history=1");
  assert.equal(anonymous.status, 401, "nor anybody unsigned-in");
});
