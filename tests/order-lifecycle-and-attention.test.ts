/**
 * ORDER LIFECYCLE, DELIVERY CONTROL, STATUS VISIBILITY AND THE TRUSTWORTHY ACTOR.
 *
 * Task 5's question is whether the ERP can be operated day to day, which comes down to four
 * things this file pins:
 *
 *   1. One order, end to end. Ordered -> released to production -> approved -> packed ->
 *      delivered -> complete, every figure derived from the ledger and the records that
 *      already exist, and `complete` meaning the production and the deliveries actually
 *      happened - NOT that somebody set a status.
 *
 *   2. Packing and delivery cannot run ahead of production. Both used to be bounded only by
 *      what was ordered (packing by nothing at all), so a hundred garments could be packed
 *      and delivered with sixty made and forty that never existed.
 *
 *   3. What needs attention is visible without a notification system. The alerts are the
 *      control board's own flags and the same derived figures, so they cannot disagree with
 *      the screens they link to.
 *
 *   4. Who recorded a payment is not something the caller gets to say.
 *
 * Runs against an empty database. Every fixture is created here through the API.
 *
 * NOTE ON ASSERTIONS: pg-mem state persists across every test in one file, so the attention
 * endpoint - which summarises the whole book - accumulates. Alerts are therefore asserted on
 * KIND and on `count >= expected`, never on an exact global total.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGE_ROLES } from "@/lib/format";
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

type Person = { id: number; name: string; login: string };

async function person(ownerCookie: string, label: string, role: string): Promise<Person> {
  const name = unique(label);
  const profile = await createWorker(ownerCookie, { name, specialty: role, roles: [role], paymentType: "PER_PIECE" });
  const login = await createStaff(ownerCookie, { name, role: "WORKER" });
  return { id: profile.id, name, login: login.cookie };
}

type Fixture = {
  owner: { cookie: string; name?: string };
  order: Awaited<ReturnType<typeof createOrder>>;
  batchId: number;
  stages: Map<string, any>;
  cutter: Person | null;
  people: Map<string, Person>;
};

/** An order of `quantity` exact variants, frozen on a two-stage route, ready to be worked. */
async function orderOnRoute(
  quantity: number,
  stages: { stage: string }[] = [{ stage: "CUTTING" }, { stage: "SEWING" }]
): Promise<Fixture> {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity, unitPrice: 4500 });
  await expectStatus(
    await api("POST", "/api/order-sizes", {
      cookie: owner.cookie,
      body: { itemId: order.itemId, sizes: [{ size: "10", color: "Navy", quantity }] },
    }),
    201, "Record the exact variant"
  );
  const listed = await api("GET", `/api/order-sizes?itemId=${order.itemId}`, { cookie: owner.cookie });
  const variant = listed.data.sizes[0];
  const cutter = stages[0]?.stage === "CUTTING" ? await person(owner.cookie, "Cutter", "Cutter") : null;
  const batch = await api("POST", "/api/batches", {
    cookie: owner.cookie,
    body: {
      orderId: order.orderId, orderItemId: order.itemId, quantity, orderVariantId: variant.id,
      ...(cutter ? { workerId: cutter.id, cuttingRate: 200 } : {}),
      stages,
    },
  });
  await expectStatus(batch, 201, "Freeze the route");
  const jobs = await api("GET", `/api/operations?batchId=${batch.data.id}`, { cookie: owner.cookie });
  return {
    owner, order, batchId: batch.data.id,
    stages: new Map<string, any>(jobs.data.map((job: any) => [job.stage, job])),
    cutter, people: new Map(),
  };
}

async function refresh(f: Fixture) {
  const jobs = await api("GET", `/api/operations?batchId=${f.batchId}`, { cookie: f.owner.cookie });
  f.stages = new Map<string, any>(jobs.data.map((job: any) => [job.stage, job]));
  return f;
}

/** Assign, submit and judge one stage, so `approved` pieces move downstream. */
async function workStage(
  f: Fixture, stage: string,
  opts: { submitQty: number; approved?: number; rework?: number; rejected?: number; allocate?: number }
) {
  const job = f.stages.get(stage);
  assert.ok(job, `The route has a ${stage} stage`);
  const worker = stage === "CUTTING" && f.cutter
    ? f.cutter
    : (f.people.get(stage) ?? await person(f.owner.cookie, `${stage} worker`, STAGE_ROLES[stage] ?? "Tailor"));
  if (stage !== "CUTTING") f.people.set(stage, worker);
  if (opts.allocate !== undefined)
    await expectStatus(
      await api("POST", "/api/allocations", {
        cookie: f.owner.cookie,
        body: { operationId: job.id, workerId: worker.id, quantity: opts.allocate, pieceRate: 300 },
      }),
      201, `${stage}: assign ${opts.allocate}`
    );
  if (opts.submitQty <= 0) return refresh(f);
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: worker.login, body: { id: job.id, submitQty: opts.submitQty } }),
    200, `${stage}: submit ${opts.submitQty}`
  );
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: f.owner.cookie,
      body: {
        operationId: job.id, quantityApproved: opts.approved ?? 0,
        quantityRework: opts.rework ?? 0, quantityRejected: opts.rejected ?? 0,
        notes: "Checked on the table",
      },
    }),
    201, `${stage}: approve ${opts.approved ?? 0}`
  );
  return refresh(f);
}

async function fulfilmentOf(f: Fixture) {
  const order = await api("GET", `/api/orders/${f.order.orderId}`, { cookie: f.owner.cookie });
  const data = await expectStatus(order, 200, "Owner opens the order");
  assert.ok(data.fulfilment, "The order reports its own lifecycle");
  return data.fulfilment;
}

// ---------------------------------------------------------------------------
// 1. The lifecycle, derived.
// ---------------------------------------------------------------------------

test("an order's lifecycle is derived end to end, and complete is not whatever the status says", async () => {
  const f = await orderOnRoute(100);

  // Nothing has been made yet.
  const before = await fulfilmentOf(f);
  assert.equal(before.ordered, 100, "What the customer ordered comes from the order's own lines");
  assert.equal(before.releasedToProduction, 100, "and what was put on the floor comes from its batches");
  assert.equal(before.approved, 0, "Nothing has been approved");
  assert.equal(before.remaining, 100);
  assert.equal(before.inProduction, 100, "Everything released is still in production");
  assert.equal(before.complete, false, "The order is not complete");
  assert.equal(before.productionStarted, true);
  assert.equal(before.ceiling, 0, "With nothing approved, nothing may be packed or delivered");
  assert.equal(before.ceilingSource, "production", "because the ledger, not the order lines, is the authority");

  // Cutting finishes; sewing gets 60 of the 100 through.
  await workStage(f, "CUTTING", { allocate: 100, submitQty: 100, approved: 100 });
  await workStage(f, "SEWING", { allocate: 100, submitQty: 60, approved: 60 });

  const part = await fulfilmentOf(f);
  assert.equal(part.approved, 60, "Sixty garments are finished and approved at the route's last stage");
  assert.equal(part.remaining, 40, "Forty of the hundred ordered are still to make");
  assert.equal(part.inProduction, 40, "and forty are still in production");
  assert.equal(part.complete, false, "An order sixty percent made is not complete");
  assert.equal(part.ceiling, 60, "Only what production approved may go out");
  assert.equal(part.packed, 0);
  assert.equal(part.delivered, 0);
  assert.equal(part.readyForDelivery, 60, "Sixty are approved and none have been shipped");
  assert.equal(part.undelivered, 100, "Against the order, a hundred are still undelivered");

  // The status column is changed by hand, with forty garments still to make.
  await expectStatus(
    await api("PUT", `/api/orders/${f.order.orderId}`, { cookie: f.owner.cookie, body: { status: "COMPLETED" } }),
    200, "Owner marks the order complete by hand"
  );
  const claimed = await fulfilmentOf(f);
  assert.equal(claimed.statusSaysComplete, true, "The status says complete");
  assert.equal(claimed.complete, false, "The production says it is not");
  assert.equal(claimed.statusMatchesProduction, false, "and the two are reported as disagreeing, not reconciled silently");
  assert.equal(claimed.remaining, 40, "The derived figure did not move because the status did");

  // Deliver what genuinely exists, and the derived completion follows the deliveries.
  await expectStatus(
    await api("POST", "/api/deliveries", {
      cookie: f.owner.cookie,
      body: {
        orderId: f.order.orderId, deliveryDate: new Date().toISOString().slice(0, 10),
        lines: [{ orderItemId: f.order.itemId, quantity: 60, size: "10" }],
      },
    }),
    201, "Deliver the sixty that were actually made"
  );
  const afterDelivery = await fulfilmentOf(f);
  assert.equal(afterDelivery.delivered, 60);
  assert.equal(afterDelivery.readyForDelivery, 0, "Everything approved has now been shipped");
  assert.equal(afterDelivery.complete, false, "Still not complete: forty were never made");
  assert.equal(afterDelivery.statusMatchesProduction, false, "and the hand-set status still does not match");
});

test("packing and delivering cannot run ahead of what production approved", async () => {
  const f = await orderOnRoute(50);
  await workStage(f, "CUTTING", { allocate: 50, submitQty: 50, approved: 50 });
  await workStage(f, "SEWING", { allocate: 50, submitQty: 30, approved: 30 });
  const now = await fulfilmentOf(f);
  assert.equal(now.approved, 30, "Thirty of the fifty are finished and approved");

  // Packing used to accept any positive number against any order id.
  const tooMuchPacking = await api("POST", "/api/packing", {
    cookie: f.owner.cookie, body: { orderId: f.order.orderId, quantityPacked: 50 },
  });
  assert.equal(tooMuchPacking.status, 400, "Fifty cannot be packed when thirty exist");
  assert.match(String(tooMuchPacking.data.error), /approved 30/i, "The refusal says what production approved");
  assert.match(String(tooMuchPacking.data.error), /cannot run ahead of approved production/i);
  assert.equal((await fulfilmentOf(f)).packed, 0, "and nothing was packed by the refused request");

  await expectStatus(
    await api("POST", "/api/packing", {
      cookie: f.owner.cookie, body: { orderId: f.order.orderId, quantityPacked: 30, packageCount: 3 },
    }),
    201, "Pack the thirty that exist"
  );
  const packed = await fulfilmentOf(f);
  assert.equal(packed.packed, 30);

  const oneMorePack = await api("POST", "/api/packing", {
    cookie: f.owner.cookie, body: { orderId: f.order.orderId, quantityPacked: 1 },
  });
  assert.equal(oneMorePack.status, 400, "Not one more garment can be packed than was approved");
  assert.equal((await fulfilmentOf(f)).packed, 30, "Packing stopped at what production made");

  // Delivery is bounded the same way, on top of the ordered ceiling it always had.
  const tooMuchDelivery = await api("POST", "/api/deliveries", {
    cookie: f.owner.cookie,
    body: {
      orderId: f.order.orderId, deliveryDate: new Date().toISOString().slice(0, 10),
      lines: [{ orderItemId: f.order.itemId, quantity: 50, size: "10" }],
    },
  });
  assert.equal(tooMuchDelivery.status, 400, "Fifty cannot be delivered when thirty were approved");
  assert.match(String(tooMuchDelivery.data.error), /approved 30 of the 50 garments ordered/i);
  assert.equal((await fulfilmentOf(f)).delivered, 0, "Nothing was delivered by the refused request");

  await expectStatus(
    await api("POST", "/api/deliveries", {
      cookie: f.owner.cookie,
      body: {
        orderId: f.order.orderId, deliveryDate: new Date().toISOString().slice(0, 10),
        lines: [{ orderItemId: f.order.itemId, quantity: 30, size: "10" }],
      },
    }),
    201, "Deliver the thirty that exist"
  );
  const done = await fulfilmentOf(f);
  assert.equal(done.delivered, 30);
  assert.equal(done.readyForDelivery, 0);

  // Approving the rest raises the ceiling - it follows the ledger, not a status.
  await workStage(f, "SEWING", { submitQty: 20, approved: 20 });
  const raised = await fulfilmentOf(f);
  assert.equal(raised.approved, 50, "All fifty are now approved");
  assert.equal(raised.remaining, 0, "Nothing is left to make");
  assert.equal(raised.ceiling, 50, "So fifty may now go out");
  assert.equal(raised.readyForDelivery, 20, "Twenty are approved and still on the shelf");
  assert.equal(raised.complete, false, "Made in full, but only thirty have been delivered");

  await expectStatus(
    await api("POST", "/api/deliveries", {
      cookie: f.owner.cookie,
      body: {
        orderId: f.order.orderId, deliveryDate: new Date().toISOString().slice(0, 10),
        lines: [{ orderItemId: f.order.itemId, quantity: 20, size: "10" }],
      },
    }),
    201, "Deliver the remaining twenty"
  );
  const rest = await fulfilmentOf(f);
  assert.equal(rest.delivered, 50);
  assert.equal(rest.readyForDelivery, 0);
  assert.equal(rest.complete, true, "Everything ordered was made and approved, and everything ordered was delivered");
});

test("an order that never entered production packs and delivers exactly as it did before", async () => {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity: 12, unitPrice: 3000 });

  const read = await api("GET", `/api/orders/${order.orderId}`, { cookie: owner.cookie });
  const fulfilment = (await expectStatus(read, 200, "Owner opens the order")).fulfilment;
  assert.equal(fulfilment.productionStarted, false, "This order never went onto the floor");
  assert.equal(fulfilment.ceilingSource, "ordered", "So the ceiling it has always had still applies");
  assert.equal(fulfilment.ceiling, 12, "What was ordered");

  // A historical order, or one satisfied entirely off the floor, must not become impossible
  // to pack or deliver just because it has no batches.
  await expectStatus(
    await api("POST", "/api/packing", { cookie: owner.cookie, body: { orderId: order.orderId, quantityPacked: 12 } }),
    201, "Pack the twelve"
  );
  await expectStatus(
    await api("POST", "/api/deliveries", {
      cookie: owner.cookie,
      body: { orderId: order.orderId, deliveryDate: new Date().toISOString().slice(0, 10), lines: [{ orderItemId: order.itemId, quantity: 12 }] },
    }),
    201, "Deliver the twelve"
  );
  const after = await api("GET", `/api/orders/${order.orderId}`, { cookie: owner.cookie });
  const done = (await expectStatus(after, 200, "Owner reopens the order")).fulfilment;
  assert.equal(done.packed, 12);
  assert.equal(done.delivered, 12);
  assert.equal(done.complete, false, "Delivered in full, but production never approved anything - so it is not claimed as complete");

  const over = await api("POST", "/api/packing", {
    cookie: owner.cookie, body: { orderId: order.orderId, quantityPacked: 1 },
  });
  assert.equal(over.status, 400, "Even off the floor, more than was ordered cannot be packed");

  const ghost = await api("POST", "/api/packing", {
    cookie: owner.cookie, body: { orderId: 999999, quantityPacked: 1 },
  });
  assert.equal(ghost.status, 404, "Packing against an order that does not exist is refused, not written");
});

// ---------------------------------------------------------------------------
// 2. Status visibility, pulled from derivations that already exist.
// ---------------------------------------------------------------------------

test("what needs attention is derived from the board, and is not a worker's business", async () => {
  const f = await orderOnRoute(40);
  await workStage(f, "CUTTING", { allocate: 40, submitQty: 40, approved: 40 });

  // Submitted and not yet judged: the one thing that stops the next stage starting. A worker
  // may only submit a stage they are actually allocated to, so the share is assigned first
  // (`submitQty: 0` means assign and stop) and then submitted without anybody judging it.
  await workStage(f, "SEWING", { allocate: 25, submitQty: 0 });
  const sewer = f.people.get("SEWING");
  assert.ok(sewer, "The sewing stage now has somebody on it");
  await expectStatus(
    await api("PUT", "/api/operations", {
      cookie: sewer.login,
      body: { id: f.stages.get("SEWING").id, submitQty: 25 },
    }),
    200, "Sewing submits 25 without anybody judging them yet"
  );

  const worker = await createStaff(f.owner.cookie, { name: unique("Factory hand"), role: "WORKER" });
  const refused = await api("GET", "/api/attention", { cookie: worker.cookie });
  assert.equal(refused.status, 403, "Management-wide alerts are not a worker's to read");

  const anonymous = await api("GET", "/api/attention", { cookie: "" });
  assert.equal(anonymous.status, 401, "And nobody reads them without signing in");

  const result = await api("GET", "/api/attention", { cookie: f.owner.cookie });
  const attention = await expectStatus(result, 200, "Owner asks what needs attention");
  assert.ok(Array.isArray(attention.alerts), "A list of alerts");
  assert.equal(attention.total, attention.alerts.length, "The badge count is the list length");
  assert.equal(
    attention.high, attention.alerts.filter((a: any) => a.severity === "high").length,
    "and the high count agrees with the list"
  );

  const kinds = attention.alerts.map((a: any) => a.kind);
  assert.ok(kinds.includes("AWAITING_INSPECTION"), "Work submitted and unjudged is the first thing management needs to know");
  const awaiting = attention.alerts.find((a: any) => a.kind === "AWAITING_INSPECTION");
  assert.ok(awaiting.count >= 25, "At least the twenty-five pieces just submitted");
  assert.equal(awaiting.unit, "pieces");
  assert.match(awaiting.href, /^\/production\/inspection/, "It links to the screen that deals with it");

  for (const alert of attention.alerts) {
    assert.ok(alert.count > 0, "An alert with nothing behind it is not an alert");
    assert.match(alert.href, /^\//, `Every alert links to a screen in this app (${alert.kind})`);
    assert.ok(alert.title && alert.detail, `Every alert says what it is and what to do (${alert.kind})`);
    assert.ok(["high", "medium", "low"].includes(alert.severity), `Severity is one of three (${alert.kind})`);
  }
  // Most urgent first, so a badge and a list read the same way.
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const ranks = attention.alerts.map((a: any) => rank[a.severity]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "Alerts are ordered by severity");
});

test("rework, a hand-completed order, and a short shelf each raise their own alert", async () => {
  const f = await orderOnRoute(30);
  await workStage(f, "CUTTING", { allocate: 30, submitQty: 30, approved: 30 });
  await workStage(f, "SEWING", { allocate: 30, submitQty: 20, approved: 14, rework: 6 });

  // An order whose status was set by hand while its batches are still open.
  await expectStatus(
    await api("PUT", `/api/orders/${f.order.orderId}`, { cookie: f.owner.cookie, body: { status: "COMPLETED" } }),
    200, "Owner marks it complete with rework still outstanding"
  );

  // A material at or below its reorder level.
  const short = unique("Gold braid");
  await expectStatus(
    await api("POST", "/api/materials", {
      cookie: f.owner.cookie,
      body: { name: short, category: "Trim", unit: "rolls", unitCost: 1200, reorderLevel: 5, currentStock: 2 },
    }),
    201, "Catalogue a trim that is already running out"
  );

  const attention = await expectStatus(
    await api("GET", "/api/attention", { cookie: f.owner.cookie }), 200, "Owner asks again"
  );
  const kinds = attention.alerts.map((a: any) => a.kind);

  assert.ok(kinds.includes("REWORK_PENDING"), "Six pieces sent back for rework need somebody");
  const rework = attention.alerts.find((a: any) => a.kind === "REWORK_PENDING");
  assert.ok(rework.count >= 6, "At least the six just sent back");

  assert.ok(kinds.includes("COMPLETED_ORDER_WITH_OPEN_BATCHES"), "An order marked complete while production is open is called out");
  const mismatch = attention.alerts.find((a: any) => a.kind === "COMPLETED_ORDER_WITH_OPEN_BATCHES");
  assert.equal(mismatch.severity, "high", "Because the status is lying about the factory");
  assert.match(mismatch.detail, /changed by hand/i);

  assert.ok(kinds.includes("MATERIAL_SHORTAGE"), "A material below its reorder level is called out");
  const shortage = attention.alerts.find((a: any) => a.kind === "MATERIAL_SHORTAGE");
  assert.match(shortage.detail, new RegExp(short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "naming the material that is short");
  assert.equal(shortage.href, "/materials", "and linking to the screen that orders more");

  // Nothing here is a notification system: no new table, no push, one read.
  assert.ok(attention.generatedAt, "The snapshot is timestamped");
  assert.ok(attention.window, "and it reports the derivation window it read, so a truncated view is visible");
});

// ---------------------------------------------------------------------------
// 3. Purchases are read in pages, and the actor on a payment is not forgeable.
// ---------------------------------------------------------------------------

test("purchases are filtered and paged in the database rather than downloaded whole", async () => {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 2000 });
  const fabric = await expectStatus(
    await api("POST", "/api/materials", {
      cookie: owner.cookie,
      body: { name: unique("Poplin"), category: "Fabric", unit: "yards", unitCost: 300, reorderLevel: 0, currentStock: 0 },
    }),
    201, "Catalogue the fabric"
  );
  for (let i = 0; i < 5; i += 1)
    await expectStatus(
      await api("POST", "/api/material-purchases", {
        cookie: owner.cookie,
        body: { materialId: fabric.id, quantity: 10 + i, unitCost: 300, orderId: order.orderId, supplier: `Supplier ${i}` },
      }),
      201, `Record purchase ${i + 1}`
    );

  const all = await api("GET", "/api/material-purchases", { cookie: owner.cookie });
  const everyRow = await expectStatus(all, 200, "Read the purchases");
  assert.ok(Array.isArray(everyRow), "Still a bare array, so nothing that reads it had to change");
  assert.ok(everyRow.length >= 5);
  assert.ok(everyRow.every((r: any) => r.materialName && r.unit !== undefined), "Names are still resolved for the page returned");

  const paged = await api("GET", "/api/material-purchases?limit=2&offset=0", { cookie: owner.cookie });
  const page = await expectStatus(paged, 200, "Read the first page");
  assert.equal(page.length, 2, "Only the page asked for comes back");
  assert.ok(Number(paged.headers.get("X-Total-Count")) >= 5, "and the total is reported in a header, not by counting rows in the browser");

  const second = await api("GET", "/api/material-purchases?limit=2&offset=2", { cookie: owner.cookie });
  const pageTwo = await expectStatus(second, 200, "Read the second page");
  assert.equal(pageTwo.length, 2);
  assert.equal(
    pageTwo.some((r: any) => page.some((first: any) => first.id === r.id)), false,
    "The pages do not overlap"
  );

  const filtered = await api("GET", `/api/material-purchases?orderId=${order.orderId}`, { cookie: owner.cookie });
  const forOrder = await expectStatus(filtered, 200, "Filter to one order");
  assert.ok(forOrder.length >= 5);
  assert.ok(forOrder.every((r: any) => r.orderId === order.orderId), "Nothing from another order leaks in");
  assert.ok(forOrder.every((r: any) => r.orderNumber), "and the order number is still resolved");
});

test("who recorded a payment comes from the session, not from the request", async () => {
  const owner = await createOwner();
  const worker = await createWorker(owner.cookie, {
    name: unique("Paid tailor"), specialty: "Tailor", roles: ["Tailor"], paymentType: "PER_PIECE",
  });

  // The body names somebody else entirely. It must not be believed.
  const paid = await api("POST", "/api/payroll", {
    cookie: owner.cookie,
    body: {
      kind: "payment", workerId: worker.id, amount: 15000, pieceworkAmount: 15000,
      method: "Bank Transfer", paidBy: "Somebody Else Entirely",
      reference: `MTH-${Date.now()}`,
    },
  });
  const row = await expectStatus(paid, 201, "Record the payment");
  assert.notEqual(row.paidBy, "Somebody Else Entirely", "The caller does not get to say who paid");
  assert.equal(typeof row.paidBy, "string", "Somebody is named");
  assert.ok((row.paidBy ?? "").length > 0, "and it is not left blank");

  const sheet = await api("GET", `/api/payroll?month=${new Date().toISOString().slice(0, 7)}`, { cookie: owner.cookie });
  const payroll = await expectStatus(sheet, 200, "Read the payroll back");
  const listed = payroll.workers.find((entry: any) => entry.workerId === worker.id);
  assert.ok(listed, "The worker is on the payroll");
  assert.equal(listed.paid, 15000, "The payment itself is exactly what was recorded");
});

// ---------------------------------------------------------------------------
// 4. One authoritative profit. Three screens, one implementation.
// ---------------------------------------------------------------------------

test("the dashboard, the reports screen and the order page report the same profit", async () => {
  const f = await orderOnRoute(20);
  await workStage(f, "CUTTING", { allocate: 20, submitQty: 20, approved: 20 });
  await workStage(f, "SEWING", { allocate: 20, submitQty: 20, approved: 20 });

  // Material on the order, so the legacy formula has something to count and the difference
  // between the two figures is entirely the labour the legacy formula never counted.
  const fabric = await expectStatus(
    await api("POST", "/api/materials", {
      cookie: f.owner.cookie,
      body: { name: unique("Suiting"), category: "Fabric", unit: "yards", unitCost: 400, reorderLevel: 0, currentStock: 60 },
    }),
    201, "Catalogue the fabric"
  );
  await expectStatus(
    await api("POST", "/api/material-usage", {
      cookie: f.owner.cookie,
      body: { materialId: fabric.id, orderId: f.order.orderId, quantityIssued: 40, quantityUsed: 40, notes: "Cutting the twenty suits" },
    }),
    201, "Issue forty yards to the order"
  );

  const dash = await api("GET", "/api/dashboard", { cookie: f.owner.cookie });
  const kpis = (await expectStatus(dash, 200, "Owner opens the home screen")).kpis;
  const reportRows = await api("GET", "/api/reports", { cookie: f.owner.cookie });
  const reports = await expectStatus(reportRows, 200, "Owner opens the reports screen");
  const orderPage = await api("GET", `/api/orders/${f.order.orderId}`, { cookie: f.owner.cookie });
  const costs = (await expectStatus(orderPage, 200, "Owner opens the order")).costs;

  // The home screen used to compute its own profit as revenue - (expenses + material usage),
  // which counted NO LABOUR AT ALL: no tailor commission, no support pay, no machine work, no
  // vendor bill. On the most-read screen in the business that reported as profit most of what
  // the company actually pays out. It now calls the same implementation as everything else.
  assert.equal(kpis.profit, reports.totals.profit, "The dashboard and the reports screen agree on profit for the same book");
  assert.equal(kpis.totalCost, reports.totals.cost, "and on what it cost to earn it");
  assert.equal(kpis.profit, kpis.revenue - kpis.totalCost, "so the figures on the card still reconcile");

  assert.ok(kpis.legacy, "What this screen used to report is kept beside it, not silently replaced");
  assert.ok(
    kpis.legacy.profit > kpis.profit,
    `The legacy figure (${kpis.legacy.profit}) is higher than the true one (${kpis.profit}) because it counted no labour`
  );
  // Whole book: the gap between the two formulas is the sum of the gap on every order, so the
  // home screen is not restating the reports screen's answer in a different shape.
  const gapPerOrder = reports.profitability.reduce(
    (sum: number, row: any) => sum + (row.totalCost - row.legacy.totalCost), 0
  );
  assert.equal(
    kpis.totalCost - kpis.legacy.totalCost, gapPerOrder,
    "The dashboard's gap between the two formulas is the same gap the reports screen shows per order"
  );

  // This order: the gap is exactly the labour the legacy formula never counted.
  const thisOrder = reports.profitability.find((row: any) => row.orderId === f.order.orderId);
  assert.ok(thisOrder, "This order is on the reports screen");
  assert.equal(
    thisOrder.totalCost - thisOrder.legacy.totalCost,
    costs.internalLabour + costs.supportLabour + costs.machineLabour + costs.readyMade + costs.outsourced,
    "On an order with no expenses, the whole difference is labour and external cost"
  );
  assert.equal(costs.materials, 40 * 400, "and the material both formulas count is the forty yards issued");
  assert.ok(kpis.businessCosts, "Business costs that belong to no job are reported beside order profit, never merged into it");

  // The order page's own figure is the same implementation at a smaller scope.
  assert.equal(costs.profit, costs.revenue - costs.totalCost, "The order page reconciles the same way");
  assert.ok(costs.internalLabour > 0, "Labour is counted on the order - two stages at a piece rate");
});
