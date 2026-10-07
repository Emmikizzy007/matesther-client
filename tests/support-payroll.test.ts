/**
 * Support work, salaried staff and the monthly payment sheet.
 *
 * Covers the rules that must hold server-side:
 *   - production piecework and support piecework are both paid on APPROVED work
 *     only - never on work that was merely submitted, reworked or rejected;
 *   - a support worker can never approve their own work, whatever their login
 *     role, while the tailor who handed it out can;
 *   - a support assignment keeps its worker, operation, quantities,
 *     approval/rework/rejection split, agreed rate and resulting earnings;
 *   - non-production staff exist without being forced into a production
 *     specialty, and still appear in Owner payroll;
 *   - payroll separates salary, production piecework, support piecework,
 *     overtime and other payments into due, paid, balance and status;
 *   - payroll and the payment sheet are Owner-only;
 *   - a payment cannot be recorded twice, and payment history is never edited
 *     or deleted.
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
  createOrder, startSupport, pauseSupport, resumeSupport, } from "./support/harness";
import { currentMonth } from "@/lib/payroll";
import { SUPPORT_ROLE } from "@/lib/format";

let n = 0;
const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}${(n += 1)}`;

/**
 * The cast these tests need: an Owner, a tailor who hands work out, and a
 * support worker who performs it. Both tailors and helpers sign in as Workers,
 * which is exactly how Matesther uses the system.
 */
async function supportWorld() {
  const owner = await createOwner();
  const tailorName = unique("Tailor");
  const helperName = unique("Support Helper");

  const tailor = await createWorker(owner.cookie, { name: tailorName, specialty: "Tailor" });
  const helper = await createWorker(owner.cookie, {
    name: helperName,
    specialty: SUPPORT_ROLE,
    roles: [SUPPORT_ROLE],
  });

  const tailorLogin = await createStaff(owner.cookie, { name: tailorName, role: "WORKER" });
  const helperLogin = await createStaff(owner.cookie, { name: helperName, role: "WORKER" });

  const order = await createOrder(owner.cookie, { quantity: 20, unitPrice: 5000 });
  return { owner, tailor, helper, tailorLogin, helperLogin, order };
}

/** Hand out support work and return the created assignment. */
async function assignSupport(
  tailorCookie: string,
  helperId: number,
  fields: { operation?: string; quantity?: number; rate?: number; productionOperationId?: number | null } = {}
) {
  const created = await api("POST", "/api/support-work", {
    cookie: tailorCookie,
    body: {
      workerId: helperId,
      operation: fields.operation ?? "Weaving",
      quantityAssigned: fields.quantity ?? 10,
      pieceRate: fields.rate ?? 300,
      productionOperationId: fields.productionOperationId ?? null,
    },
  });
  await expectStatus(created, 201, "Hand out support work");
  return created.data;
}

/**
 * The helper returns completed work.
 *
 * Starting the work first is not a formality: the lifecycle refuses a submission
 * from ASSIGNED, because pieces cannot be handed back before anybody began. This
 * helper is the one place these fixtures submit, so it is the one place that has to
 * model the real sequence - begin, then hand back.
 *
 * `currentStatus` exists for the append-only history fixture, which submits a SECOND
 * time while the assignment is still SUBMITTED with pieces unjudged. Starting again
 * from there is not a legal move - the work never stopped - so that call passes the
 * status it knows the row is in and the start is skipped. The default reproduces a
 * first submission from ASSIGNED, which does have to start.
 */
async function submitSupport(cookie: string, id: number, quantity: number, currentStatus = "ASSIGNED") {
  if (currentStatus === "ASSIGNED" || currentStatus === "PAUSED" || currentStatus === "REWORK") {
    // PAUSED and REWORK cannot be submitted from either, and the API says so; the
    // start is attempted so the refusal is the API's own words, not a guess here.
    await startSupport(cookie, id);
  }
  const result = await api("PUT", "/api/support-work", { cookie, body: { id, submitQty: quantity } });
  await expectStatus(result, 200, "Submit support work");
  return result.data;
}

/** One payroll row for a worker, from the Owner's point of view. */
async function payrollRow(ownerCookie: string, workerId: number, month = currentMonth()) {
  const payroll = await api("GET", `/api/payroll?month=${month}`, { cookie: ownerCookie });
  await expectStatus(payroll, 200, "Owner payroll");
  const row = payroll.data.workers.find((entry: any) => entry.workerId === workerId);
  assert.ok(row, "The worker must appear on the payroll sheet");
  return { row, payroll };
}

// ---------------------------------------------------------------------------
// Support work: assignment, submission, approval and pay.
// ---------------------------------------------------------------------------

test("support earnings are paid on approved pieces only, never on submitted work", async () => {
  const { owner, helper, tailorLogin, helperLogin } = await supportWorld();
  const assignment = await assignSupport(tailorLogin.cookie, helper.id, { quantity: 10, rate: 300 });

  await submitSupport(helperLogin.cookie, assignment.id, 10);
  const submitted = await payrollRow(owner.cookie, helper.id);
  assert.equal(submitted.row.supportPieces, 0, "Returned but uninspected work is not payable");
  assert.equal(submitted.row.supportPiecework, 0);
  assert.equal(submitted.row.due, 0, "Nothing is owed before approval");

  const inspected = await api("PUT", "/api/support-work", {
    cookie: tailorLogin.cookie,
    body: { id: assignment.id, quantityApproved: 7, quantityRework: 2, quantityRejected: 1, notes: "Two to reweave, one ruined" },
  });
  const record = await expectStatus(inspected, 201, "The tailor approves 7 of the 10");
  assert.equal(record.payable, 7 * 300, "The inspection reports what it makes payable");

  const after = await payrollRow(owner.cookie, helper.id);
  assert.equal(after.row.supportPieces, 7, "Only the 7 approved pieces count");
  assert.equal(after.row.supportPiecework, 7 * 300, "7 approved pieces at the agreed ₦300");
  assert.equal(after.row.piecework, 0, "Support work never lands in production piecework");
  assert.equal(after.row.due, 7 * 300);
});

test("a support worker cannot approve their own work, but the assigning tailor can", async () => {
  const { helper, tailorLogin, helperLogin } = await supportWorld();
  const assignment = await assignSupport(tailorLogin.cookie, helper.id, { quantity: 6, rate: 250 });
  await submitSupport(helperLogin.cookie, assignment.id, 6);

  const selfApprove = await api("PUT", "/api/support-work", {
    cookie: helperLogin.cookie,
    body: { id: assignment.id, quantityApproved: 6, quantityRework: 0, quantityRejected: 0 },
  });
  assert.equal(selfApprove.status, 403, "Self-approval of support work must be refused server-side");

  const byTailor = await api("PUT", "/api/support-work", {
    cookie: tailorLogin.cookie,
    body: { id: assignment.id, quantityApproved: 6, quantityRework: 0, quantityRejected: 0 },
  });
  await expectStatus(byTailor, 201, "The tailor who handed it out may approve it");
});

test("a supervisor who does support work cannot approve their own support work", async () => {
  const owner = await createOwner();
  const tailorName = unique("Assigning Tailor");
  const supervisorName = unique("Supervisor Who Also Helps");

  const tailor = await createWorker(owner.cookie, { name: tailorName, specialty: "Tailor" });
  const tailorLogin = await createStaff(owner.cookie, { name: tailorName, role: "WORKER" });

  // The dangerous combination: a supervisor whose own worker record also holds
  // the support role, given support work by somebody else.
  const supervisorWorker = await createWorker(owner.cookie, {
    name: supervisorName,
    specialty: SUPPORT_ROLE,
    roles: [SUPPORT_ROLE, "Tailor"],
  });
  const supervisor = await createStaff(owner.cookie, {
    name: supervisorName,
    role: "PRODUCTION_MANAGER",
    workerId: supervisorWorker.id,
  });

  const assignment = await assignSupport(tailorLogin.cookie, supervisorWorker.id, { quantity: 9, rate: 400 });

  // They may submit their own work... having begun it, as the lifecycle requires.
  // Starting is the support worker's own act, so it is the supervisor's own login
  // that does it here - which is the point of this fixture.
  await startSupport(supervisor.cookie, assignment.id, "A supervisor starts their own support work");
  const submitted = await api("PUT", "/api/support-work", {
    cookie: supervisor.cookie,
    body: { id: assignment.id, submitQty: 9 },
  });
  await expectStatus(submitted, 200, "A supervisor submits their own support work");

  // ...but never approve it, even though their role would otherwise allow it.
  const selfApprove = await api("PUT", "/api/support-work", {
    cookie: supervisor.cookie,
    body: { id: assignment.id, quantityApproved: 9, quantityRework: 0, quantityRejected: 0 },
  });
  assert.equal(
    selfApprove.status,
    403,
    "Being a supervisor must not let anyone approve the support work they did themselves"
  );

  const unpaid = await payrollRow(owner.cookie, supervisorWorker.id);
  assert.equal(unpaid.row.supportPiecework, 0, "Self-approval must not have made anything payable");

  const byOwner = await api("PUT", "/api/support-work", {
    cookie: owner.cookie,
    body: { id: assignment.id, quantityApproved: 9, quantityRework: 0, quantityRejected: 0 },
  });
  await expectStatus(byOwner, 201, "The Owner inspects it instead");

  const paid = await payrollRow(owner.cookie, supervisorWorker.id);
  assert.equal(paid.row.supportPiecework, 9 * 400, "Now it is payable, once somebody else approved it");
  assert.ok(tailor, "the tailor fixture exists");
});

test("support work can only be handed to somebody who holds the support role", async () => {
  const { owner, tailor, helper, tailorLogin } = await supportWorld();

  const toSelf = await api("POST", "/api/support-work", {
    cookie: tailorLogin.cookie,
    body: { workerId: tailor.id, operation: "Weaving", quantityAssigned: 5, pieceRate: 200 },
  });
  assert.equal(toSelf.status, 400, "A tailor cannot hand support work to themselves");

  // Somebody on the staff list who is not a helper.
  const salesPerson = await createWorker(owner.cookie, {
    name: unique("Sales Girl"),
    specialty: "Sales",
    roles: ["Sales"],
    paymentType: "MONTHLY",
    paymentRate: 40000,
  });
  const notAHelper = await api("POST", "/api/support-work", {
    cookie: tailorLogin.cookie,
    body: { workerId: salesPerson.id, operation: "Weaving", quantityAssigned: 5, pieceRate: 200 },
  });
  assert.equal(notAHelper.status, 400, "Only somebody with the support role may be given support work");

  const unknownOperation = await api("POST", "/api/support-work", {
    cookie: tailorLogin.cookie,
    body: { workerId: helper.id, operation: "Flying", quantityAssigned: 5, pieceRate: 200 },
  });
  assert.equal(unknownOperation.status, 400, "The supporting operation must be one Matesther uses");

  const noRate = await api("POST", "/api/support-work", {
    cookie: tailorLogin.cookie,
    body: { workerId: helper.id, operation: "Taping", quantityAssigned: 5, pieceRate: 0 },
  });
  assert.equal(noRate.status, 400, "A per-piece helper needs an agreed rate before work starts");
});

test("a support assignment preserves worker, operation, quantities, split, rate and earnings", async () => {
  const { owner, tailor, helper, tailorLogin, helperLogin, order } = await supportWorld();

  // Link the support work to a real production job so it stays traceable.
  const batch = await api("POST", "/api/batches", {
    cookie: owner.cookie,
    body: { orderId: order.orderId, orderItemId: order.itemId, quantity: 20 },
  });
  await expectStatus(batch, 201, "Create a batch");
  const jobs = await api("GET", "/api/operations", { cookie: owner.cookie });
  const sewing = jobs.data.find((job: any) => job.productionBatchId === batch.data.id && job.stage === "SEWING");

  const assignment = await assignSupport(tailorLogin.cookie, helper.id, {
    operation: "Taping",
    quantity: 12,
    rate: 350,
    productionOperationId: sewing.id,
  });
  assert.equal(assignment.workerId, helper.id, "The support worker is recorded");
  assert.equal(assignment.assignedByWorkerId, tailor.id, "The assigning tailor is recorded");
  assert.equal(assignment.operation, "Taping");
  assert.equal(assignment.pieceRate, 350, "The agreed rate is recorded");
  assert.equal(assignment.quantityAssigned, 12);

  await submitSupport(helperLogin.cookie, assignment.id, 12);
  await expectStatus(
    await api("PUT", "/api/support-work", {
      cookie: tailorLogin.cookie,
      body: { id: assignment.id, quantityApproved: 8, quantityRework: 3, quantityRejected: 1, notes: "Three tapes puckered, one torn" },
    }),
    201,
    "Split inspection 8 / 3 / 1"
  );

  const list = await api("GET", "/api/support-work", { cookie: owner.cookie });
  await expectStatus(list, 200, "Owner loads support work");
  const row = list.data.find((entry: any) => entry.id === assignment.id);
  assert.ok(row, "The assignment is still there");
  assert.equal(row.workerId, helper.id);
  assert.equal(row.assignedByWorkerId, tailor.id);
  assert.equal(row.operation, "Taping");
  assert.equal(row.quantityAssigned, 12, "Quantity handed over");
  assert.equal(row.quantitySubmitted, 12, "Quantity returned");
  assert.equal(row.quantityApproved, 8);
  assert.equal(row.quantityRework, 3);
  assert.equal(row.quantityRejected, 1);
  assert.equal(row.pieceRate, 350, "The agreed rate survived inspection");
  assert.equal(row.status, "APPROVED");
  assert.equal(row.orderNumber, order.orderNumber, "Traceable back to the order");
  assert.notEqual(row.customer, "-", "The school is recorded");
  assert.equal(row.batchNumber, batch.data.batchNumber, "Linked to the batch it came from");
  assert.equal(row.stage, "SEWING", "Linked to the parent production stage");

  // The parent tailor's own production job is untouched by the support work.
  const jobsAfter = await api("GET", "/api/operations", { cookie: owner.cookie });
  const sewingAfter = jobsAfter.data.find((job: any) => job.id === sewing.id);
  assert.equal(sewingAfter.workerId, sewing.workerId, "The tailor's stage responsibility is unchanged");
  assert.equal(sewingAfter.quantityCompleted, 0, "Support work never inflates the parent stage");

  const earnings = await payrollRow(owner.cookie, helper.id);
  assert.equal(earnings.row.supportPiecework, 8 * 350, "Earnings follow the approved split and the agreed rate");
});

test("support-work inspections are an append-only history, never overwritten", async () => {
  const { owner, helper, tailorLogin, helperLogin } = await supportWorld();
  const assignment = await assignSupport(tailorLogin.cookie, helper.id, { quantity: 10, rate: 300 });

  await submitSupport(helperLogin.cookie, assignment.id, 4);
  await expectStatus(
    await api("PUT", "/api/support-work", {
      cookie: tailorLogin.cookie,
      body: { id: assignment.id, quantityApproved: 2, quantityRework: 2, quantityRejected: 0, notes: "Two to reweave" },
    }),
    201,
    "First inspection"
  );
  // Six pieces are still unjudged, so the assignment is SUBMITTED rather than REWORK:
  // the helper hands the rest back without the work ever having stopped.
  await submitSupport(helperLogin.cookie, assignment.id, 6, "SUBMITTED");
  await expectStatus(
    await api("PUT", "/api/support-work", {
      cookie: tailorLogin.cookie,
      body: { id: assignment.id, quantityApproved: 6, quantityRework: 0, quantityRejected: 0 },
    }),
    201,
    "Second inspection"
  );

  const history = await api("GET", `/api/support-work/inspections?assignmentId=${assignment.id}`, {
    cookie: owner.cookie,
  });
  const rows = await expectStatus(history, 200, "Support inspection history");
  assert.equal(rows.length, 2, "Both inspections remain as separate rows");
  assert.equal(
    rows.reduce((sum: number, row: any) => sum + row.quantityApproved, 0),
    8,
    "8 pieces approved across the two inspections"
  );
});

test("rework or rejection of support work requires a written reason", async () => {
  const { helper, tailorLogin, helperLogin } = await supportWorld();
  const assignment = await assignSupport(tailorLogin.cookie, helper.id, { quantity: 5, rate: 200 });
  await submitSupport(helperLogin.cookie, assignment.id, 5);

  const noReason = await api("PUT", "/api/support-work", {
    cookie: tailorLogin.cookie,
    body: { id: assignment.id, quantityApproved: 3, quantityRework: 2, quantityRejected: 0 },
  });
  assert.equal(noReason.status, 400, "Rework must be explained");
});

test("a helper can only submit and see their own support work", async () => {
  const { owner, helper, tailorLogin, helperLogin } = await supportWorld();
  const assignment = await assignSupport(tailorLogin.cookie, helper.id, { quantity: 10, rate: 300 });

  const someoneElse = await createWorker(owner.cookie, {
    name: unique("Other Helper"),
    specialty: SUPPORT_ROLE,
    roles: [SUPPORT_ROLE],
  });
  const otherLogin = await createStaff(owner.cookie, { name: someoneElse.name, role: "WORKER" });

  const foreign = await api("PUT", "/api/support-work", {
    cookie: otherLogin.cookie,
    body: { id: assignment.id, submitQty: 5 },
  });
  assert.equal(foreign.status, 403, "Another helper cannot submit somebody else's support work");

  const list = await api("GET", "/api/support-work", { cookie: otherLogin.cookie });
  await expectStatus(list, 200, "Another helper loads support work");
  assert.equal(list.data.length, 0, "They see none of it");

  const own = await api("GET", "/api/support-work", { cookie: helperLogin.cookie });
  await expectStatus(own, 200, "The helper loads their own support work");
  assert.equal(own.data.length, 1, "They see exactly their own assignment");
});

// ---------------------------------------------------------------------------
// Non-production / salaried staff.
// ---------------------------------------------------------------------------

test("salaried non-production staff exist without a production specialty", async () => {
  const owner = await createOwner();
  const name = unique("Security Guard");

  const created = await api("POST", "/api/workers", {
    cookie: owner.cookie,
    body: {
      name,
      specialty: "Security",
      roles: ["Security"],
      department: "Security",
      jobTitle: "Night Guard",
      paymentType: "MONTHLY",
      paymentRate: 60000,
    },
  });
  const person = await expectStatus(created, 201, "Record a salaried security guard");
  assert.deepEqual(person.roles, ["Security"], "No production specialty is forced on them");
  assert.equal(person.department, "Security");
  assert.equal(person.jobTitle, "Night Guard");

  const { row } = await payrollRow(owner.cookie, person.id);
  assert.equal(row.salary, 60000, "Their salary accrues with no production work at all");
  assert.equal(row.piecework, 0);
  assert.equal(row.supportPiecework, 0);
  assert.equal(row.due, 60000);
  assert.deepEqual(row.categories, ["Salaried / Non-Production Staff"], "Classified as non-production staff");
  assert.equal(row.department, "Security");

  // They must not be assignable to a production stage.
  const order = await createOrder(owner.cookie, { quantity: 10 });
  const batch = await api("POST", "/api/batches", {
    cookie: owner.cookie,
    body: { orderId: order.orderId, orderItemId: order.itemId, quantity: 10 },
  });
  await expectStatus(batch, 201, "Create a batch");
  const jobs = await api("GET", "/api/operations", { cookie: owner.cookie });
  const sewing = jobs.data.find((job: any) => job.productionBatchId === batch.data.id && job.stage === "SEWING");
  const assignStage = await api("PUT", "/api/operations", {
    cookie: owner.cookie,
    body: { id: sewing.id, workerId: person.id, pieceRate: 400, status: "IN_PROGRESS" },
  });
  assert.equal(assignStage.status, 400, "A security guard cannot be put on a production stage");
});

test("one person can be both salaried staff and a production worker", async () => {
  const owner = await createOwner();
  const name = unique("Sales And Tailor");
  const person = await createWorker(owner.cookie, {
    name,
    specialty: "Tailor",
    roles: ["Tailor", "Sales"],
    department: "Sales",
    jobTitle: "Sales Girl",
    paymentType: "PER_PIECE",
  });

  const matches = await api("GET", "/api/workers?showArchived=1", { cookie: owner.cookie });
  await expectStatus(matches, 200, "Load workers");
  const rows = matches.data.filter((entry: any) => entry.name === name);
  assert.equal(rows.length, 1, "Still exactly one person, not one record per category");
  assert.deepEqual(rows[0].roles.sort(), ["Sales", "Tailor"]);

  const { row } = await payrollRow(owner.cookie, person.id);
  assert.deepEqual(
    row.categories.sort(),
    ["Production Worker", "Salaried / Non-Production Staff"],
    "Both responsibilities are shown without duplicating the person"
  );
});

// ---------------------------------------------------------------------------
// Payroll breakdown, status and access.
// ---------------------------------------------------------------------------

test("payroll separates salary, production piecework, support piecework, overtime and other", async () => {
  const owner = await createOwner();
  const name = unique("Tailor And Helper");
  const tailorName = unique("Assigning Tailor");
  const tailor = await createWorker(owner.cookie, { name: tailorName, specialty: "Tailor" });
  const tailorLogin = await createStaff(owner.cookie, { name: tailorName, role: "WORKER" });

  // A per-piece worker who also does support work, on a salary-free profile.
  const person = await createWorker(owner.cookie, {
    name,
    specialty: "Tailor",
    roles: ["Tailor", SUPPORT_ROLE],
    paymentType: "PER_PIECE",
  });

  const assignment = await assignSupport(tailorLogin.cookie, person.id, { quantity: 10, rate: 200 });
  const helperLogin = await createStaff(owner.cookie, { name, role: "WORKER" });
  await submitSupport(helperLogin.cookie, assignment.id, 10);
  await expectStatus(
    await api("PUT", "/api/support-work", {
      cookie: tailorLogin.cookie,
      body: { id: assignment.id, quantityApproved: 5, quantityRework: 0, quantityRejected: 0 },
    }),
    201,
    "Approve 5 support pieces"
  );

  await expectStatus(
    await api("POST", "/api/payroll", {
      cookie: owner.cookie,
      body: { kind: "overtime", workerId: person.id, hours: 2, amount: 4000 },
    }),
    201,
    "Record overtime"
  );
  await expectStatus(
    await api("POST", "/api/payroll", {
      cookie: owner.cookie,
      body: { kind: "other", workerId: person.id, amount: 2500, notes: "Transport allowance" },
    }),
    201,
    "Record another approved payment"
  );

  const { row, payroll } = await payrollRow(owner.cookie, person.id);
  assert.equal(row.supportPieces, 5);
  assert.equal(row.supportPiecework, 5 * 200, "Support piecework is its own line");
  assert.equal(row.piecework, 0, "Production piecework is separate and still zero");
  assert.equal(row.salary, 0, "A per-piece worker draws no salary");
  assert.equal(row.overtime, 4000);
  assert.equal(row.other, 2500, "Other approved payments are separate from overtime");
  assert.equal(row.due, 5 * 200 + 4000 + 2500, "Total due is the sum of the parts");
  assert.equal(row.paymentStatus, "UNPAID");
  assert.ok(tailor, "the tailor fixture exists");

  // The headline totals keep their original shape; the detail is additive.
  assert.deepEqual(Object.keys(payroll.data.totals).sort(), ["balance", "due", "paid"]);
  assert.deepEqual(
    Object.keys(payroll.data.breakdown).sort(),
    // `supportDeduction` is the other side of `supportPiecework`: what approved
    // support work takes back out of the tailors who handed it out. It is its own
    // line rather than being netted into piecework so the two can be reconciled.
    ["other", "overtime", "piecework", "salary", "supportDeduction", "supportDeductionOwed", "supportPiecework"]
  );
  assert.equal(payroll.data.breakdown.supportPiecework >= 5 * 200, true);
  // This person only ever RECEIVED support work, so nothing is deducted from them.
  assert.equal(row.supportPiecesDelegated, 0);
  assert.equal(row.supportDeduction, 0);
  // The helper's 5 x 200 is deducted from the tailor who handed it out - but that
  // tailor approved no pieces of their own this month, so there is nothing for it to
  // come out of yet and it is held, not written off.
  assert.equal(payroll.data.breakdown.supportDeductionOwed >= 5 * 200, true);
});

test("payment status moves from unpaid to part paid to paid in full", async () => {
  const owner = await createOwner();
  const person = await createWorker(owner.cookie, {
    name: unique("Salaried Admin"),
    specialty: "Administration",
    roles: ["Administration"],
    paymentType: "MONTHLY",
    paymentRate: 50000,
  });

  const unpaid = await payrollRow(owner.cookie, person.id);
  assert.equal(unpaid.row.paymentStatus, "UNPAID");
  assert.equal(unpaid.row.balance, 50000);

  await expectStatus(
    await api("POST", "/api/payroll", {
      cookie: owner.cookie,
      body: { kind: "payment", workerId: person.id, periodMonth: currentMonth(), salaryAmount: 20000, amount: 20000 },
    }),
    201,
    "Part payment"
  );
  const partial = await payrollRow(owner.cookie, person.id);
  assert.equal(partial.row.paymentStatus, "PARTIAL");
  assert.equal(partial.row.paid, 20000);
  assert.equal(partial.row.balance, 30000);

  await expectStatus(
    await api("POST", "/api/payroll", {
      cookie: owner.cookie,
      body: { kind: "payment", workerId: person.id, periodMonth: currentMonth(), salaryAmount: 30000, amount: 30000 },
    }),
    201,
    "Settle the balance"
  );
  const settled = await payrollRow(owner.cookie, person.id);
  assert.equal(settled.row.paymentStatus, "PAID");
  assert.equal(settled.row.balance, 0);
});

test("payroll and the payment sheet are Owner-only", async () => {
  const owner = await createOwner();
  const manager = await createStaff(owner.cookie, { name: unique("Supervisor"), role: "PRODUCTION_MANAGER" });
  const workerName = unique("Pieceworker");
  await createWorker(owner.cookie, { name: workerName, specialty: "Cutter" });
  const worker = await createStaff(owner.cookie, { name: workerName, role: "WORKER" });
  const month = currentMonth();

  for (const [label, cookie] of [["Project Manager", manager.cookie], ["Worker", worker.cookie]] as const) {
    const payroll = await api("GET", `/api/payroll?month=${month}`, { cookie });
    assert.equal(payroll.status, 403, `${label} must not read payroll`);
    const sheet = await api("GET", `/api/payment-sheet?month=${month}`, { cookie });
    assert.equal(sheet.status, 403, `${label} must not open the bank payment sheet`);
    const record = await api("POST", "/api/payroll", {
      cookie,
      body: { kind: "payment", workerId: 1, amount: 1000 },
    });
    assert.equal(record.status, 403, `${label} must not record a payment`);
  }

  const ownerSheet = await api("GET", `/api/payment-sheet?month=${month}`, { cookie: owner.cookie });
  const sheet = await expectStatus(ownerSheet, 200, "Owner opens the payment sheet");
  assert.equal(sheet.sheetNo, `MTH-PAY-${month}`);
  assert.equal(sheet.monthLabel.length > 0, true);
  assert.deepEqual(Object.keys(sheet.totals).sort(), ["balance", "due", "paid"]);
});

test("a worker sees only their own earnings, and support work pays only for themselves", async () => {
  const { owner, helper, tailorLogin, helperLogin } = await supportWorld();
  const assignment = await assignSupport(tailorLogin.cookie, helper.id, { quantity: 8, rate: 250 });
  await submitSupport(helperLogin.cookie, assignment.id, 8);
  await expectStatus(
    await api("PUT", "/api/support-work", {
      cookie: tailorLogin.cookie,
      body: { id: assignment.id, quantityApproved: 8, quantityRework: 0, quantityRejected: 0 },
    }),
    201,
    "Approve the helper's 8 pieces"
  );

  const mine = await api("GET", "/api/dashboard?view=my-work", { cookie: helperLogin.cookie });
  const dashboard = await expectStatus(mine, 200, "The helper's own dashboard");
  assert.equal(dashboard.earnings.total, 8 * 250, "Their support earnings are visible to them");
  assert.equal(
    dashboard.earnings.events.every((event: any) => event.source === "SUPPORT"),
    true,
    "The events are their own support inspections"
  );
  assert.equal(dashboard.supportJobs.length, 1, "Their own support assignment is listed");
  assert.equal(
    JSON.stringify(dashboard).includes("revenue"),
    false,
    "No company financials reach a worker"
  );

  const otherName = unique("Unrelated Helper");
  const other = await createWorker(owner.cookie, { name: otherName, specialty: SUPPORT_ROLE, roles: [SUPPORT_ROLE] });
  const otherLogin = await createStaff(owner.cookie, { name: otherName, role: "WORKER" });
  const theirs = await api("GET", "/api/dashboard?view=my-work", { cookie: otherLogin.cookie });
  const otherDashboard = await expectStatus(theirs, 200, "An unrelated worker's dashboard");
  assert.equal(otherDashboard.earnings.total, 0, "They see none of the first helper's earnings");
  assert.equal(otherDashboard.supportJobs.length, 0);
});

// ---------------------------------------------------------------------------
// Payment integrity.
// ---------------------------------------------------------------------------

test("the same payment cannot be recorded twice", async () => {
  const owner = await createOwner();
  const person = await createWorker(owner.cookie, {
    name: unique("Salaried IT"),
    specialty: "IT",
    roles: ["IT"],
    paymentType: "MONTHLY",
    paymentRate: 80000,
  });
  const key = `payroll:${currentMonth()}:${person.id}:2026-09-30:80000:Bank Transfer:`;

  const first = await api("POST", "/api/payroll", {
    cookie: owner.cookie,
    body: {
      kind: "payment",
      workerId: person.id,
      periodMonth: currentMonth(),
      paymentDate: "2026-09-30",
      salaryAmount: 80000,
      amount: 80000,
      method: "Bank Transfer",
      idempotencyKey: key,
    },
  });
  await expectStatus(first, 201, "Record the salary payment");

  const second = await api("POST", "/api/payroll", {
    cookie: owner.cookie,
    body: {
      kind: "payment",
      workerId: person.id,
      periodMonth: currentMonth(),
      paymentDate: "2026-09-30",
      salaryAmount: 80000,
      amount: 80000,
      method: "Bank Transfer",
      idempotencyKey: key,
    },
  });
  assert.equal(second.status, 409, "A repeated payment must be refused, not recorded twice");

  const { row, payroll } = await payrollRow(owner.cookie, person.id);
  assert.equal(row.paid, 80000, "The salary was paid exactly once");
  assert.equal(row.balance, 0);
  assert.equal(
    payroll.data.payments.filter((payment: any) => payment.workerId === person.id).length,
    1,
    "Only one payment row exists"
  );
});

test("legitimate part payments still work, and payment history is never rewritten", async () => {
  const owner = await createOwner();
  const person = await createWorker(owner.cookie, {
    name: unique("Salaried Director"),
    specialty: "Director",
    roles: ["Director"],
    department: "Management",
    paymentType: "MONTHLY",
    paymentRate: 120000,
  });

  for (const amount of [40000, 40000, 40000]) {
    await expectStatus(
      await api("POST", "/api/payroll", {
        cookie: owner.cookie,
        body: {
          kind: "payment",
          workerId: person.id,
          periodMonth: currentMonth(),
          salaryAmount: amount,
          amount,
          reference: `TRF-${amount}`,
        },
      }),
      201,
      `Part payment of ${amount}`
    );
  }

  const { row, payroll } = await payrollRow(owner.cookie, person.id);
  assert.equal(row.paid, 120000, "Three separate part payments add up");
  assert.equal(row.paymentStatus, "PAID");
  const mine = payroll.data.payments.filter((payment: any) => payment.workerId === person.id);
  assert.equal(mine.length, 3, "Every payment remains as its own record");
  assert.deepEqual(
    mine.map((payment: any) => payment.reference).sort(),
    ["TRF-40000", "TRF-40000", "TRF-40000"],
    "Bank references are preserved"
  );
});

test("a payment whose breakdown does not add up is rejected", async () => {
  const owner = await createOwner();
  const person = await createWorker(owner.cookie, {
    name: unique("Salaried Office"),
    specialty: "Office Staff",
    roles: ["Office Staff"],
    paymentType: "MONTHLY",
    paymentRate: 45000,
  });

  const mismatch = await api("POST", "/api/payroll", {
    cookie: owner.cookie,
    body: {
      kind: "payment",
      workerId: person.id,
      periodMonth: currentMonth(),
      salaryAmount: 30000,
      overtimeAmount: 5000,
      amount: 45000,
    },
  });
  assert.equal(mismatch.status, 400, "The itemised breakdown must equal the total paid");

  const { row } = await payrollRow(owner.cookie, person.id);
  assert.equal(row.paid, 0, "The rejected payment changed nothing");
  assert.equal(row.balance, 45000);
});

test("the payment sheet lists staff, roles and amounts for the bank", async () => {
  const owner = await createOwner();
  const guardPerson = await createWorker(owner.cookie, {
    name: unique("Security Guard"),
    specialty: "Security",
    roles: ["Security"],
    department: "Security",
    jobTitle: "Night Guard",
    paymentType: "MONTHLY",
    paymentRate: 60000,
  });
  const tailorName = unique("Piece Tailor");
  const tailor = await createWorker(owner.cookie, { name: tailorName, specialty: "Tailor", roles: ["Tailor", SUPPORT_ROLE] });
  const tailorLogin = await createStaff(owner.cookie, { name: tailorName, role: "WORKER" });
  const helperName = unique("Weaver");
  const helper = await createWorker(owner.cookie, {
    name: helperName,
    specialty: SUPPORT_ROLE,
    roles: [SUPPORT_ROLE],
  });
  const helperLogin = await createStaff(owner.cookie, { name: helperName, role: "WORKER" });

  const assignment = await assignSupport(tailorLogin.cookie, helper.id, { quantity: 10, rate: 300 });
  await submitSupport(helperLogin.cookie, assignment.id, 10);
  await expectStatus(
    await api("PUT", "/api/support-work", {
      cookie: tailorLogin.cookie,
      body: { id: assignment.id, quantityApproved: 10, quantityRework: 0, quantityRejected: 0 },
    }),
    201,
    "Approve all 10 support pieces"
  );

  const result = await api("GET", `/api/payment-sheet?month=${currentMonth()}`, { cookie: owner.cookie });
  const sheet = await expectStatus(result, 200, "Owner builds the payment sheet");

  const names = sheet.rows.map((row: any) => row.name);
  assert.ok(names.includes(guardPerson.name), "Salaried staff appear on the sheet");
  assert.ok(names.includes(helper.name), "Support workers appear on the sheet");
  assert.equal(names.includes(tailor.name), false, "Somebody with nothing due is not listed");

  const guardRow = sheet.rows.find((row: any) => row.workerId === guardPerson.id);
  assert.deepEqual(guardRow.roles, ["Security"]);
  assert.equal(guardRow.salary, 60000);
  assert.equal(guardRow.due, 60000);
  assert.equal(guardRow.paymentStatus, "UNPAID");

  const helperRow = sheet.rows.find((row: any) => row.workerId === helper.id);
  assert.equal(helperRow.supportPiecework, 10 * 300, "Support piecework is itemised for the bank");
  assert.equal(helperRow.piecework, 0, "and kept out of production piecework");

  assert.equal(sheet.totals.due, sheet.rows.reduce((sum: number, row: any) => sum + row.due, 0));
  assert.equal(sheet.totals.balance, sheet.totals.due - sheet.totals.paid);
});
