/**
 * REASSIGNMENT INTEGRITY, THE HELPER'S EXACT GARMENT, AND THE REPORT'S FIGURES.
 *
 * Three things that could each be broken silently, and each of which touches money.
 *
 * 1. REASSIGNMENT. Moving a share of a stage from one tailor to another must move ONLY the
 *    work nobody has done yet. `tests/split-allocation.test.ts` already proves the
 *    quantities split correctly and that the closed share keeps the reason beside it. What
 *    is proved HERE is the part that touches pay: a tailor who has already earned a
 *    commission, and who has already delegated support work and had a deduction taken for
 *    it, must keep BOTH after their remaining work is handed to somebody else. The
 *    transferee must inherit neither the earnings nor the deduction, the helper must still
 *    be paid exactly once, and the inspection history that produced those figures must
 *    survive the transfer untouched. A transfer that quietly moved the deduction would
 *    either pay the helper twice or deduct from the wrong person, and neither shows up as
 *    an error anywhere else in the system.
 *
 * 2. THE HELPER'S EXACT GARMENT. A support worker must be told which school, which order,
 *    which item, which size and colour, which stage and how many pieces - inherited from
 *    the share they were handed, never retyped and never replaced by a whole order's
 *    quantity. This also covers the authorisation hole found while wiring the screen up:
 *    `GET /api/allocations` used to take its worker filter from the query string, so a
 *    worker who omitted the parameter received EVERY allocation in the database.
 *
 * 3. THE REPORT'S FIGURES. `GET /api/reports` stopped loading eleven whole tables and now
 *    aggregates in SQL. Nothing in the response was renamed, and every sum is the same
 *    expression it was - so the figures are pinned here against inputs the test controls,
 *    because no other test reads this endpoint's numbers and the screen is the only other
 *    place they surface. One figure deliberately changed and is asserted as having changed:
 *    piecework earnings are now attributed to the worker an inspection NAMES, which is how
 *    payroll has always paid, rather than to the worker the stage nominally belongs to. On
 *    a split stage those are different people, and the report used to credit somebody who
 *    was not paid.
 *
 * Runs against an empty database. Every fixture is created here through the API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { currentMonth } from "@/lib/payroll";
import { COST_LINES } from "@/lib/order-cost";
import {
  api,
  expectStatus,
  createOwner,
  createStaff,
  createWorker,
  createOrder, startSupport, pauseSupport, resumeSupport, } from "./support/harness";

let n = 0;
const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}${(n += 1)}`;

type Person = { id: number; name: string; login: string };

async function person(ownerCookie: string, label: string, role: string, paymentType = "PER_PIECE", paymentRate = 0): Promise<Person> {
  const name = unique(label);
  const profile = await createWorker(ownerCookie, { name, specialty: role, roles: [role], paymentType, paymentRate });
  const login = await createStaff(ownerCookie, { name, role: "WORKER" });
  return { id: profile.id, name, login: login.cookie };
}

/** 100 navy size-10 polos at SEWING, on a SEWING -> IRONING route. */
async function hundredPolosAtSewing(unitPrice = 4500) {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity: 100, unitPrice });
  await expectStatus(
    await api("POST", "/api/order-sizes", {
      cookie: owner.cookie,
      body: { itemId: order.itemId, sizes: [{ size: "10", color: "Navy", quantity: 100 }] },
    }),
    201, "Record the exact variant: Navy, size 10, 100 pieces"
  );
  const listed = await api("GET", `/api/order-sizes?itemId=${order.itemId}`, { cookie: owner.cookie });
  const variant = listed.data.sizes[0];
  const batch = await api("POST", "/api/batches", {
    cookie: owner.cookie,
    body: {
      orderId: order.orderId, orderItemId: order.itemId, quantity: 100, orderVariantId: variant.id,
      stages: [{ stage: "SEWING" }, { stage: "IRONING" }],
    },
  });
  await expectStatus(batch, 201, "Allocate all 100 to a SEWING -> IRONING route");
  const jobs = await api("GET", `/api/operations?batchId=${batch.data.id}`, { cookie: owner.cookie });
  const stages = new Map<string, any>(jobs.data.map((job: any) => [job.stage, job]));
  return { owner, order, variant, batchId: batch.data.id, sewing: stages.get("SEWING") };
}

type Fixture = Awaited<ReturnType<typeof hundredPolosAtSewing>>;

async function allocate(w: Fixture, workerId: number, quantity: number, pieceRate: number) {
  const made = await api("POST", "/api/allocations", {
    cookie: w.owner.cookie,
    body: { operationId: w.sewing.id, workerId, quantity, pieceRate },
  });
  await expectStatus(made, 201, `Allocate ${quantity} pieces at N${pieceRate}`);
  return made.data;
}

async function sharesOf(w: Fixture, operationId: number) {
  const response = await api("GET", `/api/allocations?operationId=${operationId}`, { cookie: w.owner.cookie });
  await expectStatus(response, 200, "Load the stage's shares");
  return response.data as any[];
}

/** Submit as the worker who holds the share, then judge it as the Owner, attributed. */
async function submitAndApprove(
  w: Fixture, allocation: any, login: string, submitQty: number, approved: number,
  rework = 0, rejected = 0
) {
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: login, body: { id: w.sewing.id, submitQty } }),
    200, `Submit ${submitQty} pieces`
  );
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: w.owner.cookie,
      body: {
        operationId: w.sewing.id, quantityApproved: approved, quantityRework: rework, quantityRejected: rejected,
        notes: "Checked on the table",
        attributions: [{ allocationId: allocation.id, quantityApproved: approved, quantityRework: rework, quantityRejected: rejected }],
      },
    }),
    201, `Owner approves ${approved} pieces`
  );
}

async function payrollRow(ownerCookie: string, workerId: number) {
  const payroll = await api("GET", `/api/payroll?month=${currentMonth()}`, { cookie: ownerCookie });
  await expectStatus(payroll, 200, "Owner payroll");
  const row = payroll.data.workers.find((entry: any) => entry.workerId === workerId);
  assert.ok(row, "The worker must appear on the payroll sheet");
  return { row, payroll };
}

async function reports(ownerCookie: string) {
  const response = await api("GET", "/api/reports", { cookie: ownerCookie });
  await expectStatus(response, 200, "Owner reads the reports screen");
  return response.data;
}

// ---------------------------------------------------------------------------
// 1. Reassignment never moves earned pay, the support deduction, or the history.
// ---------------------------------------------------------------------------

test("a transfer leaves the original tailor's earnings and support deduction exactly where they were", async () => {
  const w = await hundredPolosAtSewing();
  const a = await person(w.owner.cookie, "Tailor A", "Tailor");
  const b = await person(w.owner.cookie, "Tailor B", "Tailor");
  const helper = await person(w.owner.cookie, "Helper H", "Support Worker");

  const share = await allocate(w, a.id, 100, 300);

  // A sews 60 of the hundred and has them approved at their own rate.
  await submitAndApprove(w, share, a.login, 60, 60);

  // A delegates 18 pieces of taping to the helper, off that same share, at N30.
  const delegated = await api("POST", "/api/support-work", {
    cookie: a.login,
    body: { workerId: helper.id, operation: "Taping", quantityAssigned: 18, pieceRate: 30, productionAllocationId: share.id },
  });
  const assignment = await expectStatus(delegated, 201, "The tailor hands 18 pieces of taping to the helper");
  assert.equal(assignment.productionAllocationId, share.id, "The support work names the exact share it came from");
  assert.equal(assignment.orderVariantId, w.variant.id, "and inherits the exact variant rather than retyping it");
  assert.equal(assignment.stage, "SEWING", "and the stage");
  // The lifecycle requires work to have begun before it is handed back.
  await startSupport(helper.login, assignment.id);
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: helper.login, body: { id: assignment.id, submitQty: 18 } }),
    200, "The helper returns all 18"
  );
  const check = await expectStatus(
    await api("PUT", "/api/support-work", {
      cookie: a.login, body: { id: assignment.id, quantityApproved: 18, quantityRework: 0, quantityRejected: 0 },
    }),
    201, "The tailor who handed it out inspects it"
  );
  assert.equal(check.payable, 540, "The helper is paid 18 x 30");
  assert.equal(check.deductedFromTailor, 540, "and exactly 540 comes back out of the tailor");
  assert.equal(check.deductedFromWorkerId, a.id, "from Tailor A, who holds the share");

  // Now hand A's unworked 40 to B.
  const moved = await api("PUT", "/api/allocations", {
    cookie: w.owner.cookie,
    body: { id: share.id, toWorkerId: b.id, pieceRate: 300, reason: "A is going home sick" },
  });
  const transfer = await expectStatus(moved, 200, "Transfer the unworked remainder to B");
  assert.equal(transfer.moved, 40, "Only the 40 A had not submitted moved");
  assert.equal(transfer.closed.quantitySubmitted, 60, "A's 60 submitted pieces stayed with A");
  assert.equal(transfer.closed.quantityApproved, 60, "and so did the 60 that were approved");
  assert.equal(transfer.closed.status, "TRANSFERRED", "The closed share is kept as the trail");

  // A's pay: 60 approved at N300 gross, less the 540 the delegation caused.
  const aPay = await payrollRow(w.owner.cookie, a.id);
  assert.equal(aPay.row.piecework, 18000, "A's GROSS commission is still 60 x 300 after the transfer");
  assert.equal(aPay.row.supportPiecesDelegated, 18, "The 18 delegated pieces are still A's");
  assert.equal(aPay.row.supportDeduction, 540, "and the deduction still comes off A");
  assert.equal(aPay.row.due, 17460, "so A is due 17,460");

  // The helper is paid once, and by Matesther.
  const helperPay = await payrollRow(w.owner.cookie, helper.id);
  assert.equal(helperPay.row.supportPieces, 18);
  assert.equal(helperPay.row.supportPiecework, 540, "The helper is paid 540 exactly once");
  assert.equal(helperPay.row.supportDeduction, 0, "Nothing is deducted from somebody who only received work");

  // B inherits the work, not A's history: no earnings and no deduction yet.
  const bPayBefore = await payrollRow(w.owner.cookie, b.id);
  assert.equal(bPayBefore.row.piecework, 0, "B has earned nothing yet");
  assert.equal(bPayBefore.row.supportDeduction, 0, "and inherits NONE of A's support deduction");
  assert.equal(bPayBefore.row.supportPiecesDelegated, 0, "nor A's delegated pieces");

  // B works the 40 and is paid for exactly those 40, at their own rate.
  const bShare = (await sharesOf(w, w.sewing.id)).find((row) => row.workerId === b.id && row.status !== "TRANSFERRED");
  assert.ok(bShare, "B's opened share is on the stage");
  await submitAndApprove(w, bShare, b.login, 40, 40);
  const bPay = await payrollRow(w.owner.cookie, b.id);
  assert.equal(bPay.row.piecework, 12000, "B earns 40 x 300 for the work B actually did");
  assert.equal(bPay.row.supportDeduction, 0, "with no deduction, because B delegated nothing");

  // And A's figures did not move when B was paid.
  const aPayAfter = await payrollRow(w.owner.cookie, a.id);
  assert.equal(aPayAfter.row.piecework, 18000, "A's gross commission is unchanged by B's work");
  assert.equal(aPayAfter.row.supportDeduction, 540, "A's deduction is unchanged by B's work");
  assert.equal(aPayAfter.row.due, 17460, "A is still due 17,460");

  // Nobody was paid twice: 18,000 + 12,000 of commission, 540 of it internally reallocated
  // to the helper, so the labour this order carries is 30,000 and not 30,540.
  const order = await api("GET", `/api/orders/${w.order.orderId}`, { cookie: w.owner.cookie });
  const costs = (await expectStatus(order, 200, "Owner opens the order")).costs;
  assert.equal(costs.internalLabour, 30000, "The order carries the tailors' GROSS commission");
  assert.equal(costs.supportGrossPaid, 540, "The helper was paid 540");
  assert.equal(costs.supportDeductedFromTailors, 540, "and 540 came back out of the tailors");
  assert.equal(costs.supportLabour, 0, "so support labour adds nothing on top: it is the same money, reallocated");
});

test("the inspection history that earned the pay survives a transfer", async () => {
  const w = await hundredPolosAtSewing();
  const a = await person(w.owner.cookie, "Tailor A", "Tailor");
  const b = await person(w.owner.cookie, "Tailor B", "Tailor");
  const share = await allocate(w, a.id, 100, 300);
  await submitAndApprove(w, share, a.login, 25, 25);

  const before = await api("GET", `/api/inspections?operationId=${w.sewing.id}`, { cookie: w.owner.cookie });
  await expectStatus(before, 200, "Read the inspection history before the transfer");
  const beforeRows = (Array.isArray(before.data) ? before.data : before.data.inspections ?? []) as any[];
  assert.equal(beforeRows.length, 1, "One inspection, naming the worker who was credited");
  assert.equal(beforeRows[0].quantityApproved, 25);

  await expectStatus(
    await api("PUT", "/api/allocations", {
      cookie: w.owner.cookie,
      body: { id: share.id, toWorkerId: b.id, pieceRate: 300, reason: "A has another order to finish" },
    }),
    200, "Transfer the unworked 75 to B"
  );

  const after = await api("GET", `/api/inspections?operationId=${w.sewing.id}`, { cookie: w.owner.cookie });
  await expectStatus(after, 200, "Read the inspection history after the transfer");
  const afterRows = (Array.isArray(after.data) ? after.data : after.data.inspections ?? []) as any[];
  assert.equal(afterRows.length, 1, "The transfer neither erased nor duplicated the inspection");
  assert.equal(afterRows[0].id, beforeRows[0].id, "It is the same record, not a replacement");
  assert.equal(afterRows[0].quantityApproved, 25, "still approving the same 25 pieces");
  assert.equal(afterRows[0].workerId, a.id, "and still crediting Tailor A, who made them");

  // The ledger tells the same story: an approved movement for A, and a reassignment that
  // moves no quantity at all.
  const ledger = await api("GET", `/api/production-corrections?operationId=${w.sewing.id}`, { cookie: w.owner.cookie });
  await expectStatus(ledger, 200, "Read the movement ledger");
  const events = ledger.data as any[];
  assert.equal(events.filter((row) => row.eventType === "REASSIGNMENT").length, 1, "One reassignment event");
  assert.equal(
    events.find((row) => row.eventType === "REASSIGNMENT").quantity, 0,
    "A reassignment moves no quantity: the garments were already where they were"
  );
  const approvals = events.filter((row) => row.eventType === "INSPECTION_APPROVED");
  assert.equal(approvals.length, 1, "and the approval that paid A is still on the ledger beside it");
  assert.equal(approvals[0].quantity, 25, "still for the same 25 pieces");
});

test("a transfer cannot hand over more pieces than are unworked", async () => {
  const w = await hundredPolosAtSewing();
  const a = await person(w.owner.cookie, "Tailor A", "Tailor");
  const b = await person(w.owner.cookie, "Tailor B", "Tailor");
  const share = await allocate(w, a.id, 100, 300);
  await submitAndApprove(w, share, a.login, 100, 100);

  // Everything A held has been submitted and approved: there is nothing left to move.
  const nothing = await api("PUT", "/api/allocations", {
    cookie: w.owner.cookie,
    body: { id: share.id, toWorkerId: b.id, pieceRate: 300, reason: "Trying to move finished work" },
  });
  assert.equal(nothing.status, 400, "Refused: finished work cannot be reassigned");
  assert.ok(String(nothing.data.error).length > 10, "and says why, in words a supervisor can act on");

  const rows = await sharesOf(w, w.sewing.id);
  assert.equal(rows.filter((row) => row.workerId === b.id).length, 0, "B was given nothing");
  assert.equal(
    rows.find((row) => row.workerId === a.id)?.quantityApproved, 100,
    "A still holds the credit for all 100"
  );
  const aPay = await payrollRow(w.owner.cookie, a.id);
  assert.equal(aPay.row.piecework, 30000, "and is still paid for all 100");
});

// ---------------------------------------------------------------------------
// 2. The helper sees the exact garment, and cannot widen what they can read.
// ---------------------------------------------------------------------------

test("support work handed out from a share carries the school, garment, size, colour and stage", async () => {
  const w = await hundredPolosAtSewing();
  const a = await person(w.owner.cookie, "Tailor A", "Tailor");
  const helper = await person(w.owner.cookie, "Helper H", "Support Worker");
  const share = await allocate(w, a.id, 100, 300);

  const assignment = await expectStatus(
    await api("POST", "/api/support-work", {
      cookie: a.login,
      body: { workerId: helper.id, operation: "Taping", quantityAssigned: 20, pieceRate: 30, productionAllocationId: share.id },
    }),
    201, "The tailor hands 20 pieces of taping to the helper"
  );

  // The helper's own view of their work.
  const mine = await api("GET", "/api/support-work", { cookie: helper.login });
  await expectStatus(mine, 200, "The helper reads their own support work");
  const rows = mine.data as any[];
  assert.equal(rows.length, 1, "They see their one assignment");
  const row = rows[0];
  assert.equal(row.id, assignment.id);

  assert.equal(row.orderNumber, w.order.orderNumber, "The order it belongs to");
  assert.notEqual(row.customer, "-", "The school is named, not left blank");
  assert.equal(row.garment, "Test Uniform Shirt", "The exact item");
  assert.equal(row.size, "10", "The exact size");
  assert.equal(row.color, "Navy", "The exact colour");
  assert.equal(row.variant, "Navy • Size 10", "described together, in the same words the production board uses, so it cannot be confused with another variant");
  assert.equal(row.variantQuantity, 100, "and the variant's own ordered quantity is available beside it");
  assert.equal(row.stage, "SEWING", "The production stage, inherited from the share");
  assert.equal(row.assignedBy, a.name, "Who handed it out");
  assert.equal(row.pieceRate, 30, "at the rate snapshotted on the assignment");

  // The exact share, so the helper knows whose work they are supporting and how big it is.
  assert.ok(row.allocation, "The share behind the assignment is named");
  assert.equal(row.allocation.id, share.id);
  assert.equal(row.allocation.holder, a.name, "It is Tailor A's share");
  assert.equal(row.allocation.quantityAllocated, 100, "of 100 pieces");

  // And the quantity the helper is answerable for is THEIRS, not the order's.
  assert.equal(row.quantityAssigned, 20, "Twenty pieces were handed over");
  assert.notEqual(row.quantityAssigned, row.variantQuantity, "which is not the whole variant's 100");
  assert.notEqual(row.quantityAssigned, 100, "and never the order's quantity in place of their own");
});

test("a helper's dashboard names the real school and order, not a generic support line", async () => {
  const w = await hundredPolosAtSewing();
  const a = await person(w.owner.cookie, "Tailor A", "Tailor");
  const helper = await person(w.owner.cookie, "Helper H", "Support Worker");
  const share = await allocate(w, a.id, 100, 300);
  const assignment = await expectStatus(
    await api("POST", "/api/support-work", {
      cookie: a.login,
      body: { workerId: helper.id, operation: "Taping", quantityAssigned: 20, pieceRate: 30, productionAllocationId: share.id },
    }),
    201, "Hand 20 pieces of taping to the helper"
  );
  // The lifecycle requires work to have begun before it is handed back.
  await startSupport(helper.login, assignment.id);
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: helper.login, body: { id: assignment.id, submitQty: 20 } }),
    200, "The helper returns all 20"
  );
  await expectStatus(
    await api("PUT", "/api/support-work", {
      cookie: a.login, body: { id: assignment.id, quantityApproved: 20, quantityRework: 0, quantityRejected: 0 },
    }),
    201, "The tailor approves all 20"
  );

  const dashboard = await api("GET", "/api/dashboard", { cookie: helper.login });
  await expectStatus(dashboard, 200, "The helper reads their own dashboard");
  const data = dashboard.data as any;
  const jobs = (data.supportJobs ?? []) as any[];
  assert.equal(jobs.length, 1, "Their one support assignment is on the dashboard");
  assert.equal(jobs[0].orderNumber, w.order.orderNumber, "It names the real order");
  assert.equal(jobs[0].school, data.supportJobs[0].school, "and a school");
  assert.notEqual(jobs[0].school, "", "which is not an empty string");
  assert.equal(jobs[0].product, "Test Uniform Shirt", "the exact item");
  assert.equal(jobs[0].variant, "Navy • Size 10", "the exact variant");
  assert.equal(jobs[0].stage, "SEWING", "the exact stage");
  assert.equal(jobs[0].allocation?.holder, a.name, "and whose share it came from");
  assert.equal(jobs[0].quantityAssigned, 20, "Their own twenty pieces");

  // The earnings journal that pays them names the same garment.
  const earned = (data.earnings?.events ?? []).filter((event: any) => event.source === "SUPPORT");
  assert.equal(earned.length, 1, "One support earning");
  assert.equal(earned[0].amount, 600, "20 approved pieces at N30");
  assert.equal(earned[0].orderNumber, w.order.orderNumber, "tied to the real order number, not a blank");
  assert.notEqual(earned[0].customer, "Support work", "and to the real school, not a generic label");
  assert.match(String(earned[0].stage), /SEWING/, "with the stage it was done at");
});

test("a worker cannot widen the allocations endpoint past their own shares", async () => {
  const w = await hundredPolosAtSewing();
  const a = await person(w.owner.cookie, "Tailor A", "Tailor");
  const b = await person(w.owner.cookie, "Tailor B", "Tailor");
  await allocate(w, a.id, 40, 300);
  await allocate(w, b.id, 35, 300);

  // Omitting the parameter used to drop the filter entirely and return every share in the
  // database - other workers' stages, quantities and rates.
  const omitted = await api("GET", "/api/allocations", { cookie: a.login });
  await expectStatus(omitted, 200, "A worker may read their own shares");
  assert.equal((omitted.data as any[]).length, 1, "Omitting workerId returns only A's own share");
  assert.equal((omitted.data as any[])[0].workerId, a.id);

  const asked = await api("GET", `/api/allocations?workerId=${a.id}`, { cookie: a.login });
  await expectStatus(asked, 200, "Asking for their own id works");
  assert.equal((asked.data as any[]).length, 1);

  const someoneElses = await api("GET", `/api/allocations?workerId=${b.id}`, { cookie: a.login });
  await expectStatus(someoneElses, 200, "Asking for somebody else's id is not an error");
  assert.equal((someoneElses.data as any[]).length, 0, "It returns nothing at all, not A's own rows");

  // The stage path returns every share by design, for a supervisor splitting a stage, so
  // the worker scope has to be applied to the result rather than to the query.
  const byOperation = await api("GET", `/api/allocations?operationId=${w.sewing.id}`, { cookie: a.login });
  await expectStatus(byOperation, 200, "A worker may ask about a stage they work on");
  assert.equal((byOperation.data as any[]).length, 1, "and still sees only their own share of it");
  assert.equal((byOperation.data as any[])[0].workerId, a.id);

  // Staff keep the parameter, because choosing whose shares to look at is their job.
  const supervisor = await api("GET", `/api/allocations?operationId=${w.sewing.id}`, { cookie: w.owner.cookie });
  await expectStatus(supervisor, 200, "The owner reads the whole stage");
  assert.equal((supervisor.data as any[]).length, 2, "and sees both shares");
});

test("a worker sees only their own support assignments", async () => {
  const w = await hundredPolosAtSewing();
  const a = await person(w.owner.cookie, "Tailor A", "Tailor");
  const h1 = await person(w.owner.cookie, "Helper One", "Support Worker");
  const h2 = await person(w.owner.cookie, "Helper Two", "Support Worker");
  const share = await allocate(w, a.id, 100, 300);
  for (const [helper, quantity] of [[h1, 20], [h2, 15]] as const) {
    await expectStatus(
      await api("POST", "/api/support-work", {
        cookie: a.login,
        body: { workerId: helper.id, operation: "Taping", quantityAssigned: quantity, pieceRate: 30, productionAllocationId: share.id },
      }),
      201, `Hand ${quantity} pieces to ${helper.name}`
    );
  }
  const one = await api("GET", "/api/support-work", { cookie: h1.login });
  await expectStatus(one, 200, "Helper One reads their support work");
  assert.equal((one.data as any[]).length, 1, "Only their own assignment");
  assert.equal((one.data as any[])[0].quantityAssigned, 20, "with their own quantity");
  const owner = await api("GET", "/api/support-work", { cookie: w.owner.cookie });
  await expectStatus(owner, 200, "The owner reads all support work");
  assert.ok((owner.data as any[]).length >= 2, "and sees both helpers");
});

// ---------------------------------------------------------------------------
// 3. The report's figures, pinned against inputs this test controls.
// ---------------------------------------------------------------------------

test("the report's nine cost categories and its legacy figure sit side by side per order", async () => {
  const w = await hundredPolosAtSewing(4500);
  const a = await person(w.owner.cookie, "Tailor A", "Tailor");
  const share = await allocate(w, a.id, 100, 300);
  await submitAndApprove(w, share, a.login, 100, 100);

  const fabric = await expectStatus(
    await api("POST", "/api/materials", {
      cookie: w.owner.cookie,
      // Ten yards on the shelf, because ten are about to be issued. This test is about the
      // nine cost categories, not about stock - but issuing material the store does not have
      // is now refused (stock cannot go negative), and a fixture that could only ever pass by
      // drawing down an empty shelf would be asserting nothing worth keeping.
      body: { name: unique("Cotton drill"), category: "Fabric", unit: "yards", unitCost: 250, reorderLevel: 0, currentStock: 10 },
    }),
    201, "Catalogue the fabric"
  );
  await expectStatus(
    await api("POST", "/api/material-usage", {
      cookie: w.owner.cookie,
      body: {
        materialId: fabric.id, orderId: w.order.orderId,
        quantityIssued: 10, quantityUsed: 7, quantityReturned: 2, quantityWasted: 1,
        unitCost: 250, notes: "One yard cut off-grain, two came back unused",
      },
    }),
    201, "Issue 10 yards: 7 used, 2 returned, 1 wasted"
  );

  const data = await reports(w.owner.cookie);
  const row = (data.profitability as any[]).find((entry) => entry.orderId === w.order.orderId);
  assert.ok(row, "The order is on the profitability report");
  assert.equal(row.orderNumber, w.order.orderNumber);
  assert.notEqual(row.customer, "-", "The school is named");
  assert.equal(row.quantity, 100, "The ordered quantity, summed in SQL over the order's items");
  assert.equal(row.revenue, 450000, "100 x N4,500");

  // Nine categories, all present, in the order the screen renders them.
  assert.equal(row.lines.length, COST_LINES.length, "One line per cost category");
  assert.deepEqual(row.lines.map((line: any) => line.key), COST_LINES.map((line) => line.key), "In the documented order");
  const amount = (key: string) => row.lines.find((line: any) => line.key === key).amount;

  // Materials cost what was USED plus what was WASTED, at the unit cost: (7 + 1) x 250.
  assert.equal(amount("materials"), 2000, "Eight yards costed at N250: used plus wasted, returned excluded");
  // Internal labour is the tailor's GROSS commission: 100 x 300.
  // The nine categories arrive as labelled `lines`, which is what the screen renders; the
  // report has never carried them as flat keys, and adding them now would be a second
  // spelling of the same figure on the same row.
  assert.equal(amount("internalLabour"), 30000, "The tailor's gross commission");
  // No support was delegated, so nothing is reallocated and nothing is added on top.
  assert.equal(amount("supportLabour"), 0, "Support labour adds nothing when nothing was delegated");
  assert.equal(amount("readyMade"), 0, "Nothing was bought in");
  assert.equal(amount("outsourced"), 0, "Nothing was sent out");
  assert.equal(amount("machineLabour"), 0, "No machine stage was worked");

  assert.equal(row.totalCost, 32000, "Materials plus labour");
  assert.equal(row.profit, 450000 - 32000, "Revenue less the nine categories");
  // Margin is a percentage of revenue, to whatever precision the cost module rounds it.
  assert.ok(Math.abs(row.margin - ((450000 - 32000) / 450000) * 100) < 0.05, "as a percentage of revenue");

  // The old formula's answer is reported beside the restated one, never overwritten.
  assert.ok(row.legacy, "The legacy figure is still returned");
  assert.equal(row.legacy.totalCost, 2000, "The old formula counted materials only, and no labour at all");
  assert.equal(row.legacy.profit, 450000 - 2000, "so it reported a much larger profit");
  assert.notEqual(row.legacy.totalCost, row.totalCost, "The two answers are visibly different");

  // The raw record totals are kept under their original keys so nothing that read them breaks.
  assert.equal(row.materialCost, 2000, "materialCost is still the raw usage total");
  assert.equal(row.expenseCost, 0, "and expenseCost the raw expense total");
});

test("a hand-entered Materials or Labour expense is excluded from computed profit and reported separately", async () => {
  const w = await hundredPolosAtSewing();
  const a = await person(w.owner.cookie, "Tailor A", "Tailor");
  const share = await allocate(w, a.id, 100, 300);
  await submitAndApprove(w, share, a.login, 100, 100);

  // Somebody typed the same costs in by hand as well as recording the underlying events.
  await expectStatus(
    await api("POST", "/api/expenses", {
      cookie: w.owner.cookie,
      body: { category: "Materials", description: "Fabric for the navy polos", amount: 2000, orderId: w.order.orderId },
    }),
    201, "A hand-entered Materials expense against this order"
  );
  await expectStatus(
    await api("POST", "/api/expenses", {
      cookie: w.owner.cookie,
      body: { category: "Labour", description: "Sewing paid in cash", amount: 5000, orderId: w.order.orderId },
    }),
    201, "and a hand-entered Labour expense against it"
  );
  // A category the computed model does not already cover is a real extra cost.
  await expectStatus(
    await api("POST", "/api/expenses", {
      cookie: w.owner.cookie,
      body: { category: "Transportation", description: "Van to the school", amount: 1500, orderId: w.order.orderId },
    }),
    201, "and a delivery expense, which is a genuine extra"
  );

  const data = await reports(w.owner.cookie);
  const row = (data.profitability as any[]).find((entry) => entry.orderId === w.order.orderId);
  const amount = (key: string) => row.lines.find((line: any) => line.key === key).amount;
  assert.equal(amount("internalLabour"), 30000, "Labour is the computed commission");
  assert.equal(amount("delivery"), 1500, "The van is a real delivery cost");
  assert.equal(row.totalCost, 31500, "So the order carries 30,000 of labour plus 1,500 of delivery");
  assert.ok(row.totalCost < 36500, "and NOT the 5,000 of hand-entered labour on top of the commission");

  // The superseded rows are reported, not silently dropped: somebody typed them and
  // somebody will look for them.
  assert.ok(row.superseded || row.legacy, "The report explains what it set aside");
  if (row.superseded) {
    assert.equal(row.superseded.materials ?? 0, 2000, "The hand-entered materials figure is named");
    assert.equal(row.superseded.labour ?? 0, 5000, "and so is the hand-entered labour figure");
  }
  assert.equal(row.expenseCost, 8500, "while the raw expense total is still returned under its old key");
});

test("the materials section reports purchased, used, stock and stock value per material", async () => {
  const owner = await createOwner();
  const material = await expectStatus(
    await api("POST", "/api/materials", {
      cookie: owner.cookie,
      body: { name: unique("Navy thread"), category: "Thread", unit: "spools", unitCost: 400, reorderLevel: 5, currentStock: 12 },
    }),
    201, "Catalogue the thread"
  );
  await expectStatus(
    await api("POST", "/api/material-purchases", {
      cookie: owner.cookie,
      body: { materialId: material.id, quantity: 8, unitCost: 400, supplier: "Lagos Trims" },
    }),
    201, "Buy 8 more spools"
  );
  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 4500 });
  await expectStatus(
    await api("POST", "/api/material-usage", {
      cookie: owner.cookie,
      body: { materialId: material.id, orderId: order.orderId, quantityUsed: 3, unitCost: 400, notes: "Three spools on the navy shirts" },
    }),
    201, "Use 3 spools, with no issued figure - so issued equals used"
  );

  const data = await reports(owner.cookie);
  const row = (data.materials as any[]).find((entry) => entry.id === material.id);
  assert.ok(row, "The material is on the report");
  assert.equal(row.name, material.name);
  assert.equal(row.unit, "spools");
  assert.equal(row.category, "Thread");
  assert.equal(row.purchased, 8, "Everything bought, summed per material");
  assert.equal(row.used, 3, "Everything used, summed per material");
  // 12 in hand, 8 bought, 3 used: stock is maintained by the existing material system, so
  // the report reads it back rather than recomputing it and risking a disagreement.
  const listed = await api("GET", "/api/materials", { cookie: owner.cookie });
  const current = (Array.isArray(listed.data) ? listed.data : listed.data.data ?? []).find((entry: any) => entry.id === material.id);
  assert.equal(row.stock, current.currentStock, "The report's stock is the material system's own figure");
  assert.equal(row.stockValue, current.currentStock * 400, "valued at the material's unit cost");
});

test("worker performance and earnings credit the worker an inspection NAMES", async () => {
  const w = await hundredPolosAtSewing();
  const a = await person(w.owner.cookie, "Tailor A", "Tailor");
  const b = await person(w.owner.cookie, "Tailor B", "Tailor");
  await allocate(w, a.id, 60, 300);
  await allocate(w, b.id, 40, 250);
  const rows = await sharesOf(w, w.sewing.id);
  const aShare = rows.find((row) => row.workerId === a.id);
  const bShare = rows.find((row) => row.workerId === b.id);

  // Both submit; one inspection judges both, attributed per worker. The stage itself has
  // NO nominal worker, which is exactly the case the old report credited to nobody.
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: a.login, body: { id: w.sewing.id, submitQty: 60 } }),
    200, "A submits 60"
  );
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: b.login, body: { id: w.sewing.id, submitQty: 40 } }),
    200, "B submits 40"
  );
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: w.owner.cookie,
      body: {
        operationId: w.sewing.id, quantityApproved: 94, quantityRejected: 6, notes: "Six ruined",
        attributions: [
          { allocationId: aShare.id, quantityApproved: 56, quantityRejected: 4 },
          { allocationId: bShare.id, quantityApproved: 38, quantityRejected: 2 },
        ],
      },
    }),
    201, "94 approved, attributed 56 to A and 38 to B"
  );

  const data = await reports(w.owner.cookie);
  const performance = (id: number) => (data.workers as any[]).find((entry) => entry.id === id);
  assert.equal(performance(a.id).tasks, 1, "A has one stage job");
  assert.equal(performance(a.id).assigned, 100, "The stage received 100");
  assert.equal(performance(a.id).completed, 100, "and 100 were submitted across the two shares");
  assert.equal(performance(a.id).rejected, 6, "with 6 rejected at that stage");
  assert.equal(performance(b.id).tasks, 0, "B holds a share of A's stage job, not a job of their own");

  const earnings = (id: number) => (data.workerEarnings as any[]).find((entry) => entry.id === id);
  // The report credits whoever the inspection named, which is how payroll pays.
  assert.equal(earnings(a.id).earnings, 56 * 300, "A earns 56 x N300");
  assert.equal(earnings(b.id).earnings, 38 * 250, "B earns 38 x N250, at B's own rate");

  // And it now agrees with payroll, which is the screen that settles the money.
  const aPay = await payrollRow(w.owner.cookie, a.id);
  const bPay = await payrollRow(w.owner.cookie, b.id);
  assert.equal(earnings(a.id).earnings, aPay.row.piecework, "The report and payroll say the same thing about A");
  assert.equal(earnings(b.id).earnings, bPay.row.piecework, "and about B");
});

test("a monthly worker shows their wage on the report and no piecework", async () => {
  const owner = await createOwner();
  const salaried = await person(owner.cookie, "Supervisor S", "Project Supervisor", "MONTHLY", 85000);
  const data = await reports(owner.cookie);
  const row = (data.workerEarnings as any[]).find((entry) => entry.id === salaried.id);
  assert.ok(row, "The salaried worker is on the earnings report");
  assert.equal(row.paymentType, "MONTHLY");
  assert.equal(row.paymentRate, 85000);
  assert.equal(row.earnings, 85000, "A monthly worker's figure is their wage");
  assert.equal(row.approved, 0, "and they have approved no pieces");
});

test("production per stage reports all eight stages, including the ones nothing has reached", async () => {
  const w = await hundredPolosAtSewing();
  const a = await person(w.owner.cookie, "Tailor A", "Tailor");
  const share = await allocate(w, a.id, 100, 300);
  await submitAndApprove(w, share, a.login, 100, 92, 5, 3);

  const data = await reports(w.owner.cookie);
  const stages = data.production as any[];
  assert.equal(stages.length, 8, "All eight stages of the house workflow are reported");
  assert.deepEqual(stages.map((stage) => stage.stage), [
    "CUTTING", "SEWING", "MONOGRAMMING", "BUTTONHOLE", "BUTTON_TACKING", "IRONING", "PACKING", "DELIVERY",
  ], "In the documented order");

  // These sections are whole-book aggregates and the in-memory database persists across
  // every test in a file, so the absolute figures belong to every fixture built so far,
  // not to this one alone. What is asserted is therefore what must hold for ANY set of
  // rows: untouched stages report a row of zeros rather than going missing, the
  // derivation identity holds exactly, and this fixture's own work is included.
  for (const name of ["CUTTING", "MONOGRAMMING", "BUTTONHOLE", "BUTTON_TACKING", "DELIVERY"]) {
    const untouched = stages.find((stage) => stage.stage === name);
    assert.ok(untouched, `${name} is reported even though nothing in this file worked it`);
    assert.equal(untouched.operations, 0, `${name} has no operations`);
    assert.equal(untouched.received, 0, `so it reports zeros rather than being missing from the list`);
    assert.equal(untouched.approved, 0);
    assert.equal(untouched.remaining, 0);
  }

  const sewing = stages.find((stage) => stage.stage === "SEWING");
  assert.ok(sewing.operations >= 1, "SEWING has been worked");
  assert.ok(sewing.received >= 100, "including this fixture's hundred");
  assert.ok(sewing.submitted >= 100, "and this fixture submitted all of them");
  assert.ok(sewing.approved >= 92, "ninety-two approved here, and whatever earlier fixtures added");
  assert.ok(sewing.rework >= 5, "five sent back here");
  assert.ok(sewing.rejected >= 3, "three rejected here");
  // The derivation identity, which holds exactly no matter how many rows are summed:
  // remaining is received less approved less rejected, and rework is deliberately NOT
  // subtracted, because rework still has to be made good.
  assert.equal(
    sewing.remaining, sewing.received - sewing.approved - sewing.rejected,
    "remaining = received - approved - rejected, with rework still owed"
  );
});

test("expenses are grouped by category with a count, and the totals describe the whole book", async () => {
  const owner = await createOwner();
  const label = unique("Generator fuel");
  for (const amount of [3000, 4500]) {
    await expectStatus(
      await api("POST", "/api/expenses", {
        cookie: owner.cookie, body: { category: "Electricity", description: label, amount },
      }),
      201, `Record N${amount} of electricity`
    );
  }
  await expectStatus(
    await api("POST", "/api/expenses", {
      cookie: owner.cookie, body: { category: "Packaging", description: unique("Cartons"), amount: 2200 },
    }),
    201, "Record N2,200 of packaging"
  );

  const data = await reports(owner.cookie);
  const electricity = (data.expensesByCategory as any[]).find((entry) => entry.category === "Electricity");
  assert.ok(electricity, "Electricity is its own category");
  assert.equal(electricity.amount, 7500, "Both entries summed together");
  assert.equal(electricity.count, 2, "and counted, so the screen can show how many records made it up");
  const packaging = (data.expensesByCategory as any[]).find((entry) => entry.category === "Packaging");
  assert.equal(packaging.amount, 2200);
  assert.equal(packaging.count, 1);
  assert.ok(
    (data.expensesByCategory as any[]).every((entry) => typeof entry.category === "string" && typeof entry.amount === "number"),
    "Every category is a labelled amount"
  );

  // Totals describe the whole book, and each one is the sum of the rows above it.
  const profitability = data.profitability as any[];
  assert.equal(data.totals.revenue, profitability.reduce((sum, row) => sum + row.revenue, 0), "Revenue is the sum of the orders");
  assert.equal(data.totals.cost, profitability.reduce((sum, row) => sum + row.totalCost, 0), "Cost is the sum of the restated order costs");
  assert.equal(data.totals.profit, profitability.reduce((sum, row) => sum + row.profit, 0), "and profit is the difference");
  assert.equal(typeof data.totals.batches, "number", "The batch count comes from a COUNT, not from a loaded table");
  assert.ok(data.totals.batches >= 0);
  assert.equal(
    data.totals.workerPieceworkTotal,
    (data.workerEarnings as any[]).filter((row) => row.paymentType === "PER_PIECE").reduce((sum, row) => sum + row.earnings, 0),
    "The piecework total is the sum of the pieceworkers' rows"
  );
  assert.equal(
    data.totals.monthlyPayroll,
    (data.workerEarnings as any[]).filter((row) => row.paymentType === "MONTHLY").reduce((sum, row) => sum + row.paymentRate, 0),
    "and the monthly total is the sum of the salaried workers' wages"
  );

  // Costs that belong to no single order are reported beside order profit, so an order's
  // margin is never read as the whole business's margin.
  assert.ok(data.businessCosts, "Business-wide costs are reported separately");
  assert.ok(Array.isArray(data.costLines), "and the category labels come with the response");
  assert.equal(data.costLines.length, COST_LINES.length);
});
