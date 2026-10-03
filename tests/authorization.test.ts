/**
 * Role-based access control: what each role may and may not see or change.
 *
 * Runs against an empty database. Every fixture is created here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  api,
  expectStatus,
  createOwner,
  createStaff,
  createWorker,
  createOrder,
} from "./support/harness";

let n = 0;
const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}${(n += 1)}`;

test("Owner can read the owner-only financial endpoints", async () => {
  const owner = await createOwner();
  assert.equal((await api("GET", "/api/payroll", { cookie: owner.cookie })).status, 200);
  assert.equal((await api("GET", "/api/reports", { cookie: owner.cookie })).status, 200);
  assert.equal((await api("GET", "/api/expenses", { cookie: owner.cookie })).status, 200);
});

test("Project Manager is forbidden from every owner-only financial endpoint", async () => {
  const owner = await createOwner();
  const manager = await createStaff(owner.cookie, { name: unique("PM Finance"), role: "PRODUCTION_MANAGER" });

  const forbiddenReads = ["/api/payroll", "/api/reports"];
  for (const path of forbiddenReads) {
    const result = await api("GET", path, { cookie: manager.cookie });
    assert.equal(result.status, 403, `GET ${path} must be forbidden for a Project Manager`);
  }

  const forbiddenWrites: [string, string, unknown][] = [
    ["POST", "/api/payroll", { workerId: 1, amount: 500 }],
    ["POST", "/api/workers", { name: unique("Sneaky") }],
    ["POST", "/api/users", { name: unique("Sneaky"), email: "sneaky@test.matesther.invalid", password: "abcdef", role: "WORKER" }],
    ["POST", "/api/customers", { name: unique("Sneaky School") }],
    ["POST", "/api/products", { name: "Sneaky Product" }],
    ["POST", "/api/payments", { orderId: 1, amount: 100 }],
    ["DELETE", "/api/workers?id=1", undefined],
    ["DELETE", "/api/batches?id=1", undefined],
  ];
  for (const [method, path, body] of forbiddenWrites) {
    const result = await api(method, path, { cookie: manager.cookie, body });
    assert.equal(result.status, 403, `${method} ${path} must be forbidden for a Project Manager`);
  }
});

test("Project Manager keeps full access to production endpoints", async () => {
  const owner = await createOwner();
  const manager = await createStaff(owner.cookie, { name: unique("PM Production"), role: "PRODUCTION_MANAGER" });

  const allowed = [
    "/api/production-access",
    "/api/production-orders",
    "/api/operations",
    "/api/inspections",
    "/api/workers",
    "/api/batches",
    "/api/dashboard",
  ];
  for (const path of allowed) {
    const result = await api("GET", path, { cookie: manager.cookie });
    assert.equal(result.status, 200, `GET ${path} must be allowed for a Project Manager`);
  }
});

test("Worker is forbidden from staff, finance and inspection endpoints", async () => {
  const owner = await createOwner();
  const workerName = unique("Worker Limited");
  await createWorker(owner.cookie, { name: workerName, specialty: "Tailor" });
  const worker = await createStaff(owner.cookie, { name: workerName, role: "WORKER" });

  for (const path of ["/api/payroll", "/api/reports", "/api/workers", "/api/users", "/api/expenses"]) {
    const result = await api("GET", path, { cookie: worker.cookie });
    assert.equal(result.status, 403, `GET ${path} must be forbidden for a Worker`);
  }

  const inspection = await api("POST", "/api/inspections", {
    cookie: worker.cookie,
    body: { operationId: 1, quantityApproved: 1, quantityRework: 0, quantityRejected: 0 },
  });
  assert.equal(inspection.status, 403, "A Worker must never be able to inspect work");
});

test("Project Manager dashboard never contains company financials", async () => {
  const owner = await createOwner();
  const manager = await createStaff(owner.cookie, { name: unique("PM Dashboard"), role: "PRODUCTION_MANAGER" });

  // Explicitly ask for the owner view; the server must refuse to honour it.
  const forced = await api("GET", "/api/dashboard?view=owner", { cookie: manager.cookie });
  await expectStatus(forced, 200, "PM dashboard");
  assert.equal(forced.data.view, "pm", "A Project Manager must be pinned to the pm view");
  assert.equal("kpis" in forced.data, false, "The pm payload has no financial KPI block");
  const serialised = JSON.stringify(forced.data);
  assert.equal(serialised.includes("revenue"), false, "PM payload must not mention revenue anywhere");
  assert.equal(serialised.includes("profit"), false, "PM payload must not mention profit anywhere");

  const ownerView = await api("GET", "/api/dashboard", { cookie: owner.cookie });
  await expectStatus(ownerView, 200, "Owner dashboard");
  assert.equal(ownerView.data.view, "owner");
  assert.ok(ownerView.data.kpis, "Owner payload should carry the KPI block");
  assert.equal("revenue" in ownerView.data.kpis, true, "Owner KPIs should include revenue");
  assert.equal("profit" in ownerView.data.kpis, true, "Owner KPIs should include profit");
});

test("Worker dashboard contains no company financials", async () => {
  const owner = await createOwner();
  const workerName = unique("Worker Dashboard");
  await createWorker(owner.cookie, { name: workerName, specialty: "Tailor" });
  const worker = await createStaff(owner.cookie, { name: workerName, role: "WORKER" });

  const result = await api("GET", "/api/dashboard?view=my-work", { cookie: worker.cookie });
  await expectStatus(result, 200, "Worker dashboard");
  assert.equal(result.data.view, "worker");
  const serialised = JSON.stringify(result.data);
  assert.equal(serialised.includes("revenue"), false, "Worker payload must not mention revenue");
  assert.equal(serialised.includes("profit"), false, "Worker payload must not mention profit");
  assert.ok("earnings" in result.data, "A Worker does see their own earnings");
});

test("the production order catalogue hides selling prices from a Project Manager", async () => {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 4500 });
  const manager = await createStaff(owner.cookie, { name: unique("PM Catalogue"), role: "PRODUCTION_MANAGER" });

  const catalogue = await api("GET", "/api/production-orders", { cookie: manager.cookie });
  await expectStatus(catalogue, 200, "Production order catalogue");
  const entry = catalogue.data.find((row: any) => row.id === order.orderId);
  assert.ok(entry, "The new order should appear in the production catalogue");
  assert.equal(entry.items[0].unitPrice, undefined, "unitPrice must not leak to a Project Manager");
  assert.equal(entry.items[0].totalPrice, undefined, "totalPrice must not leak to a Project Manager");
  assert.equal(entry.items[0].quantity, 10, "Quantity is production information and may be shown");
});

test("the workers list hides pay rates and earnings from a Project Manager", async () => {
  const owner = await createOwner();
  await createWorker(owner.cookie, { name: unique("Paid Tailor"), specialty: "Tailor", paymentRate: 500 });
  const manager = await createStaff(owner.cookie, { name: unique("PM Workers"), role: "PRODUCTION_MANAGER" });

  const forOwner = await api("GET", "/api/workers", { cookie: owner.cookie });
  await expectStatus(forOwner, 200, "Workers for Owner");
  const ownerRow = forOwner.data[0];
  assert.ok("paymentRate" in ownerRow, "Owner should see the payment rate");
  assert.ok("earnings" in ownerRow, "Owner should see earnings");

  const forManager = await api("GET", "/api/workers", { cookie: manager.cookie });
  await expectStatus(forManager, 200, "Workers for Project Manager");
  const managerRow = forManager.data[0];
  assert.equal("paymentRate" in managerRow, false, "paymentRate must not leak to a Project Manager");
  assert.equal("earnings" in managerRow, false, "earnings must not leak to a Project Manager");
  assert.ok("name" in managerRow && "specialty" in managerRow, "Production-relevant fields remain visible");
});

test("a Worker sees only their own production jobs", async () => {
  const owner = await createOwner();
  const cutterName = unique("Cutter Mine");
  const tailorName = unique("Tailor Mine");
  const cutter = await createWorker(owner.cookie, { name: cutterName, specialty: "Cutter" });
  const tailor = await createWorker(owner.cookie, { name: tailorName, specialty: "Tailor" });
  const cutterLogin = await createStaff(owner.cookie, { name: cutterName, role: "WORKER" });
  const tailorLogin = await createStaff(owner.cookie, { name: tailorName, role: "WORKER" });

  const order = await createOrder(owner.cookie, { quantity: 10 });
  const batch = await api("POST", "/api/batches", {
    cookie: owner.cookie,
    body: {
      orderId: order.orderId,
      orderItemId: order.itemId,
      quantity: 10,
      workerId: cutter.id,
      cuttingRate: 200,
      tailorId: tailor.id,
      sewingRate: 450,
    },
  });
  await expectStatus(batch, 201, "Create batch with two assigned workers");

  const cutterJobs = await api("GET", "/api/operations", { cookie: cutterLogin.cookie });
  await expectStatus(cutterJobs, 200, "Cutter job list");
  assert.ok(cutterJobs.data.length > 0, "Cutter should have jobs");
  assert.ok(
    cutterJobs.data.every((job: any) => job.workerId === cutter.id),
    "A Worker must only ever receive their own jobs"
  );
  assert.ok(
    cutterJobs.data.some((job: any) => job.stage === "CUTTING"),
    "Cutter should see the cutting stage"
  );

  const tailorJobs = await api("GET", "/api/operations", { cookie: tailorLogin.cookie });
  await expectStatus(tailorJobs, 200, "Tailor job list");
  assert.ok(
    tailorJobs.data.every((job: any) => job.workerId === tailor.id),
    "The other Worker must not see the cutter's jobs"
  );
});

test("a Worker cannot update somebody else's job", async () => {
  const owner = await createOwner();
  const cutterName = unique("Cutter Victim");
  const tailorName = unique("Tailor Attacker");
  const cutter = await createWorker(owner.cookie, { name: cutterName, specialty: "Cutter" });
  const tailor = await createWorker(owner.cookie, { name: tailorName, specialty: "Tailor" });
  const tailorLogin = await createStaff(owner.cookie, { name: tailorName, role: "WORKER" });

  const order = await createOrder(owner.cookie, { quantity: 8 });
  const batch = await api("POST", "/api/batches", {
    cookie: owner.cookie,
    body: { orderId: order.orderId, orderItemId: order.itemId, quantity: 8, workerId: cutter.id, cuttingRate: 200 },
  });
  await expectStatus(batch, 201, "Create batch for the cross-account test");

  const jobs = await api("GET", "/api/operations", { cookie: owner.cookie });
  const cutting = jobs.data.find((job: any) => job.productionBatchId === batch.data.id && job.stage === "CUTTING");
  assert.ok(cutting, "Cutting stage should exist");

  const attack = await api("PUT", "/api/operations", {
    cookie: tailorLogin.cookie,
    body: { id: cutting.id, submitQty: 5 },
  });
  assert.equal(attack.status, 403, "A Worker must not submit another person's job");
});

test("a Worker may only submit a completed quantity, never other fields", async () => {
  const owner = await createOwner();
  const cutterName = unique("Cutter Scope");
  const tailorName = unique("Tailor Scope");
  const cutter = await createWorker(owner.cookie, { name: cutterName, specialty: "Cutter" });
  const tailor = await createWorker(owner.cookie, { name: tailorName, specialty: "Tailor" });
  const tailorLogin = await createStaff(owner.cookie, { name: tailorName, role: "WORKER" });

  const cutterLogin = await createStaff(owner.cookie, { name: cutterName, role: "WORKER" });
  const order = await createOrder(owner.cookie, { quantity: 6 });
  const batch = await api("POST", "/api/batches", {
    cookie: owner.cookie,
    body: {
      orderId: order.orderId,
      orderItemId: order.itemId,
      quantity: 6,
      workerId: cutter.id,
      cuttingRate: 200,
      tailorId: tailor.id,
      sewingRate: 450,
    },
  });
  await expectStatus(batch, 201, "Create batch for scope test");
  const jobs = await api("GET", "/api/operations", { cookie: owner.cookie });
  const cutting = jobs.data.find((job: any) => job.productionBatchId === batch.data.id && job.stage === "CUTTING");
  const sewing = jobs.data.find((job: any) => job.productionBatchId === batch.data.id && job.stage === "SEWING");
  assert.ok(cutting && sewing, "Cutting and sewing stages should exist");

  // CHANGED, DELIBERATELY. This setup used to put 6 garments in front of the
  // tailor by TYPING `quantityReceived: 6` into the sewing job. That write path
  // no longer exists: it let anyone invent a quantity with no event behind it and
  // no record of who did it. The 6 garments now arrive the only legitimate way -
  // the cutter submits them and the Owner approves them - which is also what
  // makes the "between 1 and 6" assertion below mean something.
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: cutterLogin.cookie, body: { id: cutting.id, submitQty: 6 } }),
    200, "Cutter submits the 6 allocated garments"
  );
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: owner.cookie,
      body: { operationId: cutting.id, quantityApproved: 6, quantityRework: 0, quantityRejected: 0 },
    }),
    201, "Owner approves all 6, releasing them to sewing"
  );
  const released = await api("GET", "/api/operations", { cookie: owner.cookie });
  const sewingNow = released.data.find((job: any) => job.id === sewing.id);
  assert.equal(sewingNow.quantityReceived, 6, "Sewing holds exactly the 6 approved upstream");

  // Typing a quantity in is now refused outright, and says where to go instead.
  const typed = await api("PUT", "/api/operations", {
    cookie: owner.cookie,
    body: { id: sewing.id, quantityReceived: 500, status: "IN_PROGRESS" },
  });
  assert.equal(typed.status, 400, "An Owner may not invent a quantity either");
  assert.match(String(typed.data.error), /quantity received/i, "The refusal names the field");
  assert.match(String(typed.data.error), /correction/i, "The refusal points at the audited correction path");

  const activated = await api("PUT", "/api/operations", {
    cookie: owner.cookie,
    body: { id: sewing.id, status: "IN_PROGRESS" },
  });
  await expectStatus(activated, 200, "Owner activates the sewing job");

  const smuggled = await api("PUT", "/api/operations", {
    cookie: tailorLogin.cookie,
    body: { id: sewing.id, submitQty: 1, pieceRate: 99999 },
  });
  assert.equal(smuggled.status, 403, "A Worker must not be able to change their own pay rate");

  const oversubmit = await api("PUT", "/api/operations", {
    cookie: tailorLogin.cookie,
    body: { id: sewing.id, submitQty: 999 },
  });
  assert.equal(oversubmit.status, 400, "Cannot submit more pieces than remain");
  assert.match(String(oversubmit.data.error), /between 1 and 6/, "The limit should be the 6 pieces received");

  const valid = await api("PUT", "/api/operations", {
    cookie: tailorLogin.cookie,
    body: { id: sewing.id, submitQty: 3 },
  });
  await expectStatus(valid, 200, "Worker submits their own 3 pieces");
  assert.equal(valid.data.quantityCompleted, 3);
  assert.equal(valid.data.status, "SUBMITTED");
});
