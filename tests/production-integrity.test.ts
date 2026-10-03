/**
 * Production quantity integrity: the ledger, derived counters and audited
 * corrections.
 *
 * WHAT THIS FILE GUARDS
 *   Before Task 2 the seven quantity counters on `production_operations` could be
 *   typed in directly through PUT /api/operations. Four attacks were measured as
 *   ACCEPTED against the running code, not theorised:
 *
 *     C1  inflate a stage's `quantity_received` from 90 to 500 - HTTP 200, and
 *         ZERO rows written to any audit table;
 *     C2  fabricate `quantity_completed` = 400 on a job where nobody had
 *         submitted anything - HTTP 200;
 *     C3  approve that fabricated 400 - MONOGRAMMING then received 400 garments
 *         although only 90 had ever been approved at CUTTING;
 *     C4  lower `quantity_rejected` from 2 to 0 on a COMPLETED job, leaving the
 *         counter contradicting its own inspection rows, and flipping the job
 *         back to IN_PROGRESS.
 *
 *   Every one of them is asserted REFUSED here, and the legitimate need behind
 *   them (a real mis-count on the floor) is asserted WORKING through an audited
 *   correction that records who, when and why.
 *
 * Runs against an empty database. Every fixture is created here through the API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/db";
import { productionMovements } from "@/db/schema";
import { inspectionEarnings } from "@/lib/job-pay";
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

/** Owner + a cutter and a tailor who can each sign in, plus a 10-piece batch. */
async function world(quantity = 10) {
  const owner = await createOwner();
  const cutterName = unique("Integrity Cutter");
  const tailorName = unique("Integrity Tailor");
  const cutter = await createWorker(owner.cookie, { name: cutterName, specialty: "Cutter", paymentType: "PER_PIECE" });
  const tailor = await createWorker(owner.cookie, { name: tailorName, specialty: "Tailor", paymentType: "PER_PIECE" });
  const cutterLogin = await createStaff(owner.cookie, { name: cutterName, role: "WORKER" });
  const tailorLogin = await createStaff(owner.cookie, { name: tailorName, role: "WORKER" });
  const order = await createOrder(owner.cookie, { quantity, unitPrice: 4500 });
  const batch = await api("POST", "/api/batches", {
    cookie: owner.cookie,
    body: {
      orderId: order.orderId, orderItemId: order.itemId, quantity,
      workerId: cutter.id, cuttingRate: 200, tailorId: tailor.id, sewingRate: 450,
    },
  });
  await expectStatus(batch, 201, "Create the batch under test");
  const stages = await stagesOf(owner.cookie, batch.data.id);
  return { owner, cutter, tailor, cutterLogin, tailorLogin, order, batchId: batch.data.id, stages };
}

async function stagesOf(cookie: string, batchId: number) {
  const jobs = await api("GET", "/api/operations", { cookie });
  await expectStatus(jobs, 200, "Load the batch's stages");
  return new Map<string, any>(
    jobs.data.filter((job: any) => job.productionBatchId === batchId).map((job: any) => [job.stage, job])
  );
}

/** A worker submits `qty`; the Owner then inspects the split given. */
async function submitAndInspect(
  w: Awaited<ReturnType<typeof world>>,
  stage: string,
  submitQty: number,
  inspection: { approved: number; rework?: number; rejected?: number; notes?: string }
) {
  const login = stage === "CUTTING" ? w.cutterLogin.cookie : w.tailorLogin.cookie;
  const job = w.stages.get(stage)!;
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: login, body: { id: job.id, submitQty } }),
    200, `${stage} worker submits ${submitQty}`
  );
  const result = await api("POST", "/api/inspections", {
    cookie: w.owner.cookie,
    body: {
      operationId: job.id,
      quantityApproved: inspection.approved,
      quantityRework: inspection.rework ?? 0,
      quantityRejected: inspection.rejected ?? 0,
      ...(inspection.notes ? { notes: inspection.notes } : {}),
    },
  });
  return result;
}

async function fresh(w: Awaited<ReturnType<typeof world>>, stage: string) {
  const stages = await stagesOf(w.owner.cookie, w.batchId);
  return stages.get(stage)!;
}

// ---------------------------------------------------------------------------
// 1. Quantities are derived from events, and the trail agrees with the counters.
// ---------------------------------------------------------------------------

test("every quantity counter is derived from the events that produced it", async () => {
  const w = await world();

  await expectStatus(
    await submitAndInspect(w, "CUTTING", 10, { approved: 7, rework: 2, rejected: 1, notes: "Two off-grain, one ruined" }),
    201, "Split inspection at cutting"
  );
  const cutting = await fresh(w, "CUTTING");
  assert.equal(cutting.quantityReceived, 10, "Received is the batch allocation");
  assert.equal(cutting.quantityCompleted, 10, "Completed is what the cutter submitted");
  assert.equal(cutting.quantityApproved, 7, "Approved is what the inspection approved");
  assert.equal(cutting.quantityRework, 2);
  assert.equal(cutting.quantityRejected, 1);
  assert.equal(cutting.quantityInspected, 10, "Inspected is the sum of the three outcomes");
  assert.equal(cutting.quantityRemaining, 2, "Remaining is received minus approved minus rejected");

  // Reconciliation compares every stored counter with the ledger behind it.
  const report = await api("GET", `/api/production-corrections?batchId=${w.batchId}&reconcile=1`, { cookie: w.owner.cookie });
  await expectStatus(report, 200, "Reconcile the batch");
  assert.deepEqual(report.data.drift, [], "No counter may disagree with its own audit trail");
  assert.equal(report.data.checked, 8, "All eight stages were checked");
});

test("the ledger records who, when and why for every quantity that moved", async () => {
  const w = await world();
  await expectStatus(
    await submitAndInspect(w, "CUTTING", 4, { approved: 3, rejected: 1, notes: "One torn" }),
    201, "Partial inspection"
  );
  const cutting = await fresh(w, "CUTTING");
  const trail = await api("GET", `/api/production-corrections?operationId=${cutting.id}`, { cookie: w.owner.cookie });
  await expectStatus(trail, 200, "Load the ledger");

  const types = trail.data.map((row: any) => row.eventType).sort();
  assert.deepEqual(types, [
    "ALLOCATION", "INSPECTION_APPROVED", "INSPECTION_REJECTED", "SUBMISSION",
  ].sort(), "One row per event that moved a quantity");

  for (const row of trail.data) {
    assert.ok(row.actorName, `A ${row.eventType} row must name who recorded it`);
    assert.ok(row.occurredAt, `A ${row.eventType} row must be timestamped`);
    assert.equal(row.stage, "CUTTING", "Stage identity travels with the row");
    assert.equal(row.source, "LIVE", "Recorded as it happened, not reconstructed");
  }
  const submission = trail.data.find((row: any) => row.eventType === "SUBMISSION");
  assert.equal(submission.quantity, 4);
  assert.equal(submission.workerId, w.cutter.id, "The submission names the person who made it");
});

// ---------------------------------------------------------------------------
// 2. The four measured attacks are now refused - and change nothing.
// ---------------------------------------------------------------------------

test("C1: an Owner cannot inflate a stage's received quantity by typing it in", async () => {
  const w = await world();
  await expectStatus(
    await submitAndInspect(w, "CUTTING", 10, { approved: 7, rework: 2, rejected: 1, notes: "Split" }),
    201, "Cutting inspected"
  );
  const sewing = await fresh(w, "SEWING");
  assert.equal(sewing.quantityReceived, 7, "Sewing holds the 7 approved upstream");

  const attack = await api("PUT", "/api/operations", {
    cookie: w.owner.cookie,
    body: { id: sewing.id, quantityReceived: 500 },
  });
  assert.equal(attack.status, 400, "Typing a received quantity is refused");
  assert.match(String(attack.data.error), /quantity received/i, "The refusal names the field");
  assert.match(String(attack.data.error), /correction/i, "And points at the audited route");

  const after = await fresh(w, "SEWING");
  assert.equal(after.quantityReceived, 7, "The figure did not move");

  // Even a genuine correction cannot exceed what upstream approved - see test 6.
  const report = await api("GET", `/api/production-corrections?operationId=${sewing.id}&reconcile=1`, { cookie: w.owner.cookie });
  assert.deepEqual(report.data.drift, [], "Counters still agree with the trail after the refused attack");
});

test("C2: nobody can fabricate a completed quantity that was never submitted", async () => {
  const w = await world();
  const cutting = w.stages.get("CUTTING")!;

  const attack = await api("PUT", "/api/operations", {
    cookie: w.owner.cookie,
    body: { id: cutting.id, quantityCompleted: 400 },
  });
  assert.equal(attack.status, 400, "Typing a completed quantity is refused");

  const after = await fresh(w, "CUTTING");
  assert.equal(after.quantityCompleted, 0, "Nothing was submitted, so nothing is complete");
});

test("C3: fabricated work can no longer be approved and pushed downstream", async () => {
  const w = await world();
  await expectStatus(
    await submitAndInspect(w, "CUTTING", 10, { approved: 9, rejected: 1, notes: "One ruined" }),
    201, "Cutting: 9 approved of 10"
  );

  // The old attack fabricated 400 completed at SEWING and approved them, which
  // pushed 400 into MONOGRAMMING. Fabrication is refused, so the only quantity
  // sewing can inspect is what it actually submitted from the 9 it received.
  const sewing = await fresh(w, "SEWING");
  const fabricated = await api("PUT", "/api/operations", {
    cookie: w.owner.cookie,
    body: { id: sewing.id, quantityCompleted: 400 },
  });
  assert.equal(fabricated.status, 400, "The fabrication is refused");

  const overInspect = await api("POST", "/api/inspections", {
    cookie: w.owner.cookie,
    body: { operationId: sewing.id, quantityApproved: 400 },
  });
  assert.equal(overInspect.status, 400, "Nothing is awaiting inspection, so nothing can be approved");
  assert.match(String(overInspect.data.error), /awaiting inspection/, "The refusal says why");

  const monogram = await fresh(w, "MONOGRAMMING");
  assert.equal(monogram.quantityReceived, 0, "The next stage received nothing that was never approved");
});

test("C4: a recorded rejection cannot be quietly lowered", async () => {
  const w = await world();
  await expectStatus(
    await submitAndInspect(w, "CUTTING", 10, { approved: 7, rework: 1, rejected: 2, notes: "Two unusable" }),
    201, "Cutting: 2 rejected"
  );
  const cutting = await fresh(w, "CUTTING");
  assert.equal(cutting.quantityRejected, 2);

  const attack = await api("PUT", "/api/operations", {
    cookie: w.owner.cookie,
    body: { id: cutting.id, quantityRejected: 0, status: "IN_PROGRESS" },
  });
  assert.equal(attack.status, 400, "Typing a rejected quantity is refused");

  const after = await fresh(w, "CUTTING");
  assert.equal(after.quantityRejected, 2, "The inspection's 2 rejections still stand");
  assert.equal(after.status, cutting.status, "And the job's status was not flipped by the attempt");
});

// ---------------------------------------------------------------------------
// 3. The legitimate need behind those writes still works - with an audit trail.
// ---------------------------------------------------------------------------

test("a genuine mis-count is correctable, and the correction is itself audited", async () => {
  const w = await world();
  const cutting = w.stages.get("CUTTING")!;

  // The floor counted 10 into the batch but only 8 bundles actually arrived.
  const correction = await api("POST", "/api/production-corrections", {
    cookie: w.owner.cookie,
    body: { operationId: cutting.id, field: "quantityReceived", setTo: 8, reason: "Two garments were never cut; the batch was over-counted on the floor" },
  });
  await expectStatus(correction, 201, "Owner records the correction");
  assert.equal(correction.data.from, 10);
  assert.equal(correction.data.to, 8);
  assert.equal(correction.data.movement, -2, "The ledger stores the signed movement");

  const after = await fresh(w, "CUTTING");
  assert.equal(after.quantityReceived, 8, "The corrected figure is in place");
  assert.equal(after.quantityRemaining, 8, "And remaining follows it");

  const trail = await api("GET", `/api/production-corrections?operationId=${cutting.id}`, { cookie: w.owner.cookie });
  await expectStatus(trail, 200, "Load the trail");
  const rows = trail.data.filter((row: any) => row.eventType === "RECEIVED_CORRECTION");
  assert.equal(rows.length, 1, "Exactly one correction row");
  assert.equal(rows[0].quantity, -2);
  assert.match(String(rows[0].reason), /over-counted/, "The written reason is kept");
  assert.ok(rows[0].actorName, "So is who made it");
  assert.ok(rows[0].occurredAt, "And when");

  // Append-only: the original allocation is still on the trail beside it.
  assert.ok(
    trail.data.some((row: any) => row.eventType === "ALLOCATION" && row.quantity === 10),
    "The original allocation of 10 was not overwritten or removed"
  );
  const report = await api("GET", `/api/production-corrections?operationId=${cutting.id}&reconcile=1`, { cookie: w.owner.cookie });
  assert.deepEqual(report.data.drift, [], "The corrected counter still equals its ledger");
});

test("a correction cannot push a stage above what the previous stage approved", async () => {
  const w = await world();
  await expectStatus(
    await submitAndInspect(w, "CUTTING", 10, { approved: 7, rework: 2, rejected: 1, notes: "Split" }),
    201, "Cutting: 7 approved"
  );
  const sewing = await fresh(w, "SEWING");

  // 9 is inside the batch's 10 garments but above the 7 cutting approved, so
  // this isolates the upstream rule from the batch-ceiling rule tested next.
  const over = await api("POST", "/api/production-corrections", {
    cookie: w.owner.cookie,
    body: { operationId: sewing.id, field: "quantityReceived", setTo: 9, reason: "Trying to invent downstream quantity" },
  });
  assert.equal(over.status, 400, "Downstream can never exceed approved upstream");
  assert.match(String(over.data.error), /only 7 garment/i, "The refusal states the approved ceiling");

  const absurd = await api("POST", "/api/production-corrections", {
    cookie: w.owner.cookie,
    body: { operationId: sewing.id, field: "quantityReceived", setTo: 500, reason: "Trying to invent a quantity larger than the batch" },
  });
  assert.equal(absurd.status, 400, "Nor can it exceed the batch itself");
  assert.match(String(absurd.data.error), /only holds 10 garment/i);

  const after = await fresh(w, "SEWING");
  assert.equal(after.quantityReceived, 7, "The figure did not move");
});

test("a correction cannot exceed the batch it belongs to", async () => {
  const w = await world(10);
  const cutting = w.stages.get("CUTTING")!;
  const over = await api("POST", "/api/production-corrections", {
    cookie: w.owner.cookie,
    body: { operationId: cutting.id, field: "quantityReceived", setTo: 40, reason: "Trying to inflate the first stage beyond its batch" },
  });
  assert.equal(over.status, 400, "The first stage is bounded by its batch quantity");
  assert.match(String(over.data.error), /only holds 10 garment/i);
});

test("a correction cannot lower a rejection below what inspections recorded", async () => {
  const w = await world();
  await expectStatus(
    await submitAndInspect(w, "CUTTING", 10, { approved: 8, rejected: 2, notes: "Two unusable" }),
    201, "Cutting: 2 rejected"
  );
  const cutting = await fresh(w, "CUTTING");

  const unwind = await api("POST", "/api/production-corrections", {
    cookie: w.owner.cookie,
    body: { operationId: cutting.id, field: "quantityRejected", setTo: 0, reason: "We would rather the rejects disappeared" },
  });
  assert.equal(unwind.status, 400, "Inspection outcomes are not correctable downwards");
  assert.match(String(unwind.data.error), /inspections recorded 2/i);

  const after = await fresh(w, "CUTTING");
  assert.equal(after.quantityRejected, 2, "The audit trail still stands");
});

test("a correction cannot take submitted work below what was already inspected", async () => {
  const w = await world();
  await expectStatus(
    await submitAndInspect(w, "CUTTING", 6, { approved: 5, rejected: 1, notes: "One ruined" }),
    201, "Cutting: 6 submitted, 6 inspected"
  );
  const cutting = await fresh(w, "CUTTING");

  const shrink = await api("POST", "/api/production-corrections", {
    cookie: w.owner.cookie,
    body: { operationId: cutting.id, field: "quantityCompleted", setTo: 2, reason: "Trying to erase submitted work that was inspected" },
  });
  assert.equal(shrink.status, 400, "Inspected work cannot be un-submitted");
  assert.match(String(shrink.data.error), /already been inspected/);
  assert.equal((await fresh(w, "CUTTING")).quantityCompleted, 6, "Unchanged");
});

test("approved quantity can never be corrected - only inspected", async () => {
  const w = await world();
  const cutting = w.stages.get("CUTTING")!;
  for (const field of ["quantityApproved", "quantityRework", "quantityInspected", "quantityRemaining"]) {
    const attempt = await api("POST", "/api/production-corrections", {
      cookie: w.owner.cookie,
      body: { operationId: cutting.id, field, setTo: 10, reason: "Trying to approve work without an inspection" },
    });
    assert.equal(attempt.status, 403, `${field} is not correctable`);
    assert.match(String(attempt.data.error), /inspection/i, `${field} refusal points at inspection`);
  }
});

test("a correction needs a real written reason", async () => {
  const w = await world();
  const cutting = w.stages.get("CUTTING")!;
  for (const reason of ["", "   ", "typo"]) {
    const attempt = await api("POST", "/api/production-corrections", {
      cookie: w.owner.cookie,
      body: { operationId: cutting.id, field: "quantityReceived", setTo: 9, reason },
    });
    assert.equal(attempt.status, 400, `Reason ${JSON.stringify(reason)} is not good enough`);
    assert.match(String(attempt.data.error), /explain why/i);
  }
  const after = await fresh(w, "CUTTING");
  assert.equal(after.quantityReceived, 10, "Nothing changed while the reason was refused");
});

test("a supervisor cannot correct the quantities on their own job", async () => {
  const owner = await createOwner();
  const name = unique("Supervisor Cutter");
  const person = await createWorker(owner.cookie, { name, specialty: "Cutter" });
  const manager = await createStaff(owner.cookie, { name, role: "PRODUCTION_MANAGER", workerId: person.id });
  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 4500 });
  const batch = await api("POST", "/api/batches", {
    cookie: owner.cookie,
    body: { orderId: order.orderId, orderItemId: order.itemId, quantity: 10, workerId: person.id, cuttingRate: 200 },
  });
  await expectStatus(batch, 201, "Batch assigned to the cutter-supervisor");
  const stages = await stagesOf(owner.cookie, batch.data.id);

  const selfDealing = await api("POST", "/api/production-corrections", {
    cookie: manager.cookie,
    body: { operationId: stages.get("CUTTING")!.id, field: "quantityReceived", setTo: 40, reason: "Paying myself for garments that do not exist" },
  });
  assert.equal(selfDealing.status, 403, "Separation of duties applies to corrections too");
  assert.match(String(selfDealing.data.error), /your own production job/i);

  const byOwner = await api("POST", "/api/production-corrections", {
    cookie: owner.cookie,
    body: { operationId: stages.get("CUTTING")!.id, field: "quantityReceived", setTo: 9, reason: "One garment was cut twice and scrapped" },
  });
  await expectStatus(byOwner, 201, "The Owner can still correct it");
});

test("a Worker cannot reach the correction endpoint at all", async () => {
  const w = await world();
  const cutting = w.stages.get("CUTTING")!;
  const attempt = await api("POST", "/api/production-corrections", {
    cookie: w.cutterLogin.cookie,
    body: { operationId: cutting.id, field: "quantityReceived", setTo: 999, reason: "A worker inventing their own quantity" },
  });
  assert.equal(attempt.status, 403, "Corrections are a supervisor authority");
  const read = await api("GET", `/api/production-corrections?operationId=${cutting.id}`, { cookie: w.cutterLogin.cookie });
  assert.equal(read.status, 403, "And so is reading the correction trail");
});

// ---------------------------------------------------------------------------
// 4. Forward compatibility: the ledger is data, not a closed enum.
// ---------------------------------------------------------------------------

test("an unknown ledger event type cannot move a quantity counter", async () => {
  const w = await world();
  const cutting = w.stages.get("CUTTING")!;

  // Task 3 will add SENT_EXTERNAL / RETURNED_EXTERNAL / RECEIVED_READYMADE rows
  // to this same table. Until one is explicitly mapped into a bucket it must be
  // inert, so a new event type can never silently corrupt a derived counter.
  await db.insert(productionMovements).values({
    productionOperationId: cutting.id,
    productionBatchId: w.batchId,
    stage: "CUTTING",
    eventType: "SENT_EXTERNAL",
    quantity: 999,
    actorName: "Future Task 3 code",
    source: "LIVE",
  });

  // Reading the stored counter is not enough - that would pass even if the event
  // type had been mapped into a bucket. The point is that DERIVATION ignores it,
  // so force a re-derivation by submitting work and then read the result.
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: w.cutterLogin.cookie, body: { id: cutting.id, submitQty: 3 } }),
    200, "A real submission, which recomputes every counter from the ledger"
  );

  const after = await fresh(w, "CUTTING");
  assert.equal(after.quantityCompleted, 3, "The mapped submission event counted");
  assert.equal(after.quantityReceived, 10, "An unmapped event type is ignored by derivation");
  assert.equal(after.quantityRemaining, 10, "And it cannot inflate what is outstanding");

  const trail = await api("GET", `/api/production-corrections?operationId=${cutting.id}`, { cookie: w.owner.cookie });
  await expectStatus(trail, 200, "But it is still on the trail");
  assert.ok(trail.data.some((row: any) => row.eventType === "SENT_EXTERNAL"), "Recorded, just not counted");
});

// ---------------------------------------------------------------------------
// 5. The DELIVERY stage is no longer ungated.
// ---------------------------------------------------------------------------

test("the delivery stage now requires a Packer", async () => {
  const w = await world();
  const delivery = w.stages.get("DELIVERY")!;

  const wrongRole = await api("PUT", "/api/operations", {
    cookie: w.owner.cookie,
    body: { id: delivery.id, workerId: w.cutter.id, status: "IN_PROGRESS" },
  });
  assert.equal(wrongRole.status, 400, "A Cutter is not a delivery role");
  assert.match(String(wrongRole.data.error), /needs a Packer/i, "The refusal names the role");

  const packer = await createWorker(w.owner.cookie, { name: unique("Packer"), specialty: "Packer" });
  const rightRole = await api("PUT", "/api/operations", {
    cookie: w.owner.cookie,
    body: { id: delivery.id, workerId: packer.id, pieceRate: 100, status: "IN_PROGRESS" },
  });
  await expectStatus(rightRole, 200, "A Packer can be assigned to delivery");
});

// ---------------------------------------------------------------------------
// 6. The payroll SQL and the pure pay rule must agree.
// ---------------------------------------------------------------------------

test("the grouped payroll SQL agrees with inspectionEarnings, the pure pay rule", async () => {
  const w = await world();
  await expectStatus(
    await submitAndInspect(w, "CUTTING", 10, { approved: 6, rework: 3, rejected: 1, notes: "Three to rework" }),
    201, "Cutting: 6 approved at the job rate of 200"
  );

  // lib/job-pay.ts remains the definition of the rule. Recompute it by hand from
  // the inspection row and compare with what the SQL aggregate produced.
  const trail = await api("GET", `/api/inspections?operationId=${w.stages.get("CUTTING")!.id}`, { cookie: w.owner.cookie });
  await expectStatus(trail, 200, "Load the inspection rows");
  const cutting = await fresh(w, "CUTTING");
  const expected = trail.data.reduce(
    (sum: number, check: any) =>
      sum + inspectionEarnings(check, { pieceRate: cutting.pieceRate }, { paymentType: "PER_PIECE", paymentRate: 0 }),
    0
  );
  assert.equal(expected, 6 * 200, "The pure rule says 6 approved pieces at the agreed N200");

  const profile = await api("GET", `/api/workers?id=${w.cutter.id}`, { cookie: w.owner.cookie });
  await expectStatus(profile, 200, "Load the worker profile");
  assert.equal(profile.data.earnings, expected, "The SQL lifetime-earnings aggregate matches the pure rule");

  const payroll = await api("GET", `/api/payroll?workerId=${w.cutter.id}`, { cookie: w.owner.cookie });
  await expectStatus(payroll, 200, "Load the month's payroll");
  const accrual = payroll.data.history[payroll.data.history.length - 1];
  assert.equal(accrual.pieces, 6, "Only approved pieces are counted");
  assert.equal(accrual.piecework, expected, "And only approved pieces are paid");
});

// ---------------------------------------------------------------------------
// 7. Order edits are atomic and report honestly.
// ---------------------------------------------------------------------------

test("an order edit that carries only items succeeds instead of half-committing", async () => {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 4500 });

  // Used to return HTTP 500 "No values to set" AFTER the item quantity and the
  // order total had already been committed - the client saw a failure while the
  // database had changed. There is now nothing to fail: an empty header change
  // set simply does not issue an UPDATE, and the item edit is one transaction.
  const response = await api("PUT", `/api/orders/${order.orderId}`, {
    cookie: owner.cookie,
    body: { items: [{ productId: order.productId, quantity: 4, unitPrice: 4500 }] },
  });
  assert.equal(response.status, 200, `Expected 200, got ${response.status}: ${JSON.stringify(response.data)}`);
  assert.equal(response.data.totalAmount, 4 * 4500, "The order total follows the items");

  const reloaded = await api("GET", `/api/orders/${order.orderId}`, { cookie: owner.cookie });
  await expectStatus(reloaded, 200, "Reload the order");
  const stored = reloaded.data.order ?? reloaded.data;
  assert.equal(stored.totalAmount, 4 * 4500, "And it persisted, because it committed cleanly");
  assert.equal(reloaded.data.items.length, 1, "The item was updated in place, not duplicated");
  assert.equal(reloaded.data.items[0].quantity, 4, "With the corrected quantity");
});

test("C9: an order line cannot be cut below what is already in production", async () => {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 4500 });
  const batch = await api("POST", "/api/batches", {
    cookie: owner.cookie,
    body: { orderId: order.orderId, orderItemId: order.itemId, quantity: 10 },
  });
  await expectStatus(batch, 201, "All 10 garments go into production");

  // This used to be ACCEPTED with no audit row at all, leaving a 10-piece batch in
  // production against a 4-piece order - over-allocation created after the fact.
  const shrink = await api("PUT", `/api/orders/${order.orderId}`, {
    cookie: owner.cookie,
    body: { items: [{ productId: order.productId, quantity: 4, unitPrice: 4500 }] },
  });
  assert.equal(shrink.status, 400, "An order line cannot drop below its committed production");
  assert.match(String(shrink.data.error), /already in production/i, "And the refusal says why");

  const reloaded = await api("GET", `/api/orders/${order.orderId}`, { cookie: owner.cookie });
  await expectStatus(reloaded, 200, "Reload the order");
  assert.equal(reloaded.data.items[0].quantity, 10, "The refused edit changed nothing");
  assert.equal(reloaded.data.order.totalAmount, 10 * 4500, "Nor did the total move");

  // Reducing to exactly what is committed is still allowed.
  const exact = await api("PUT", `/api/orders/${order.orderId}`, {
    cookie: owner.cookie,
    body: { items: [{ productId: order.productId, quantity: 10, unitPrice: 5000 }] },
  });
  await expectStatus(exact, 200, "A price change at the committed quantity is fine");
  assert.equal(exact.data.totalAmount, 10 * 5000);
});
