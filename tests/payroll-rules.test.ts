/**
 * Payroll rules and the pure pay/progress helpers.
 *
 * Covers the rule that matters most to Matesther's workers: production earnings
 * come from APPROVED pieces, never from pieces merely submitted.
 *
 * Runs against an empty database. Every fixture is created here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, expectStatus, createOwner, createStaff, createWorker, createOrder } from "./support/harness";
import { currentMonth, monthKey, shiftMonth, monthLabel } from "@/lib/payroll";
import { inspectionEarnings, inspectionPieceRate, jobPieceRate } from "@/lib/job-pay";
import { batchProgress } from "@/lib/server";
import { hashPassword, verifyPassword } from "@/lib/password";

let n = 0;
const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}${(n += 1)}`;

/**
 * Create a batch, assign a cutter at a known rate, and have THAT CUTTER submit
 * their own work. Submission has to come from the assigned worker: the Owner
 * updating a job is a different code path and does not submit pieces.
 */
async function submitCutting(
  ownerCookie: string,
  order: { orderId: number; itemId: number },
  cutter: { id: number; name: string },
  rate: number,
  quantity: number,
  submit: number
) {
  const cutterLogin = await createStaff(ownerCookie, { name: cutter.name, role: "WORKER" });
  const batch = await api("POST", "/api/batches", {
    cookie: ownerCookie,
    body: { orderId: order.orderId, orderItemId: order.itemId, quantity, workerId: cutter.id, cuttingRate: rate },
  });
  await expectStatus(batch, 201, "Create batch");
  const jobs = await api("GET", "/api/operations", { cookie: ownerCookie });
  const cutting = jobs.data.find(
    (job: any) => job.productionBatchId === batch.data.id && job.stage === "CUTTING"
  );
  const submitted = await api("PUT", "/api/operations", {
    cookie: cutterLogin.cookie,
    body: { id: cutting.id, submitQty: submit },
  });
  await expectStatus(submitted, 200, "The assigned cutter submits their own work");
  return cutting.id;
}

test("a monthly-paid worker accrues their salary with no production work at all", async () => {
  const owner = await createOwner();
  const worker = await createWorker(owner.cookie, {
    name: unique("Salaried Packer"),
    specialty: "Packer",
    paymentType: "MONTHLY",
    paymentRate: 50000,
  });

  const payroll = await api("GET", `/api/payroll?month=${currentMonth()}`, { cookie: owner.cookie });
  await expectStatus(payroll, 200, "Owner payroll");
  const row = payroll.data.workers.find((entry: any) => entry.workerId === worker.id);
  assert.ok(row, "The salaried worker must appear in payroll");
  assert.equal(row.salary, 50000, "Monthly salary accrues");
  assert.equal(row.piecework, 0, "No piecework without approved production");
  assert.equal(row.due, 50000);
  assert.equal(row.paid, 0);
  assert.equal(row.balance, 50000);
});

test("recording a payment reduces the balance owed", async () => {
  const owner = await createOwner();
  const worker = await createWorker(owner.cookie, {
    name: unique("Salaried Ironer"),
    specialty: "Ironer",
    paymentType: "MONTHLY",
    paymentRate: 40000,
  });

  const paid = await api("POST", "/api/payroll", {
    cookie: owner.cookie,
    body: {
      kind: "payment",
      workerId: worker.id,
      periodMonth: currentMonth(),
      paymentDate: new Date().toISOString().slice(0, 10),
      salaryAmount: 15000,
      amount: 15000,
      method: "Bank Transfer",
    },
  });
  await expectStatus(paid, 201, "Record a part payment");

  const payroll = await api("GET", `/api/payroll?month=${currentMonth()}`, { cookie: owner.cookie });
  const row = payroll.data.workers.find((entry: any) => entry.workerId === worker.id);
  assert.equal(row.due, 40000);
  assert.equal(row.paid, 15000);
  assert.equal(row.balance, 25000, "Balance is what is still owed");
  assert.equal(payroll.data.totals.paid >= 15000, true);
});

test("overtime is added to what a worker is owed", async () => {
  const owner = await createOwner();
  const worker = await createWorker(owner.cookie, {
    name: unique("Overtime Tailor"),
    specialty: "Tailor",
    paymentType: "MONTHLY",
    paymentRate: 30000,
  });

  const overtime = await api("POST", "/api/payroll", {
    cookie: owner.cookie,
    body: {
      kind: "overtime",
      workerId: worker.id,
      workedOn: new Date().toISOString().slice(0, 10),
      hours: 3,
      amount: 6000,
      notes: "Weekend finishing",
    },
  });
  await expectStatus(overtime, 201, "Record overtime");

  const payroll = await api("GET", `/api/payroll?month=${currentMonth()}`, { cookie: owner.cookie });
  const row = payroll.data.workers.find((entry: any) => entry.workerId === worker.id);
  assert.equal(row.overtime, 6000);
  assert.equal(row.due, 36000, "Salary plus overtime");
});

test("piecework accrues from approved pieces at the rate agreed for the job", async () => {
  const owner = await createOwner();
  const cutter = await createWorker(owner.cookie, { name: unique("Piece Cutter"), specialty: "Cutter" });
  const order = await createOrder(owner.cookie, { quantity: 10 });
  const operationId = await submitCutting(owner.cookie, order, cutter, 250, 10, 10);

  const beforePayroll = await api("GET", `/api/payroll?month=${currentMonth()}`, { cookie: owner.cookie });
  const beforeRow = beforePayroll.data.workers.find((entry: any) => entry.workerId === cutter.id);
  assert.equal(beforeRow.piecework, 0, "Submitted but uninspected work is not payable");
  assert.equal(beforeRow.due, 0);

  const inspected = await api("POST", "/api/inspections", {
    cookie: owner.cookie,
    body: {
      operationId,
      quantityApproved: 8,
      quantityRework: 1,
      quantityRejected: 1,
      notes: "One to rework, one rejected",
    },
  });
  await expectStatus(inspected, 201, "Approve 8 of the 10 submitted pieces");

  const after = await api("GET", `/api/payroll?month=${currentMonth()}`, { cookie: owner.cookie });
  const row = after.data.workers.find((entry: any) => entry.workerId === cutter.id);
  assert.equal(row.pieces, 8, "Only approved pieces are counted");
  assert.equal(row.piecework, 8 * 250, "8 approved pieces at the agreed ₦250");
  assert.equal(row.due, 2000);
});

test("a per-piece worker with no approved work is owed nothing", async () => {
  const owner = await createOwner();
  const cutter = await createWorker(owner.cookie, { name: unique("Idle Cutter"), specialty: "Cutter" });
  const payroll = await api("GET", `/api/payroll?month=${currentMonth()}`, { cookie: owner.cookie });
  const row = payroll.data.workers.find((entry: any) => entry.workerId === cutter.id);
  assert.ok(row, "The worker still appears on the payroll sheet");
  assert.equal(row.due, 0, "Nothing is owed");
  assert.equal(row.paymentType, "PER_PIECE");
});

test("a payroll month with no activity still returns a well-formed sheet", async () => {
  const owner = await createOwner();
  const payroll = await api("GET", "/api/payroll?month=2000-01", { cookie: owner.cookie });
  await expectStatus(payroll, 200, "Payroll for a month with no records");
  assert.deepEqual(payroll.data.totals, { due: 0, paid: 0, balance: 0 }, "Nothing is owed for that month");
  // Staff are still listed so the sheet has a stable shape, but nobody is owed anything.
  assert.ok(
    payroll.data.workers.every((row: any) => row.due === 0 && row.paid === 0 && row.balance === 0),
    "No worker may show an amount due in a month before they were employed"
  );
  assert.equal(payroll.data.payments.length, 0);
  assert.equal(payroll.data.overtime.length, 0);
});

test("payroll rejects a zero or negative payment", async () => {
  const owner = await createOwner();
  const worker = await createWorker(owner.cookie, { name: unique("Guard"), specialty: "Packer", paymentType: "MONTHLY", paymentRate: 20000 });
  const zero = await api("POST", "/api/payroll", {
    cookie: owner.cookie,
    body: { kind: "payment", workerId: worker.id, amount: 0 },
  });
  assert.equal(zero.status, 400);
  const negative = await api("POST", "/api/payroll", {
    cookie: owner.cookie,
    body: { kind: "payment", workerId: worker.id, amount: -500 },
  });
  assert.equal(negative.status, 400);
});

/* ------------------------------------------------------------------ */
/* Pure helpers: no database involved.                                 */
/* ------------------------------------------------------------------ */

test("inspectionEarnings pays approved pieces only, and only to per-piece workers", () => {
  const perPiece = { paymentType: "PER_PIECE", paymentRate: 300 };
  const monthly = { paymentType: "MONTHLY", paymentRate: 50000 };
  const job = { pieceRate: 250 };

  assert.equal(
    inspectionEarnings({ pieceRate: 250, quantityApproved: 7 }, job, perPiece),
    1750,
    "7 approved pieces at the agreed ₦250"
  );
  assert.equal(
    inspectionEarnings({ pieceRate: 250, quantityApproved: 0 }, job, perPiece),
    0,
    "Nothing approved means nothing payable"
  );
  assert.equal(
    inspectionEarnings({ pieceRate: null, quantityApproved: 4 }, job, perPiece),
    1000,
    "Historical rows without a snapshot fall back to the job rate"
  );
  assert.equal(
    inspectionEarnings({ pieceRate: null, quantityApproved: 4 }, { pieceRate: null }, perPiece),
    1200,
    "And then to the worker's legacy profile rate"
  );
  assert.equal(
    inspectionEarnings({ pieceRate: 250, quantityApproved: 7 }, job, monthly),
    0,
    "Salaried staff are not paid per piece"
  );
});

test("rate precedence: inspection snapshot, then job rate, then profile rate", () => {
  const worker = { paymentType: "PER_PIECE", paymentRate: 100 };
  assert.equal(jobPieceRate({ pieceRate: 250 }, worker), 250);
  assert.equal(jobPieceRate({ pieceRate: null }, worker), 100);
  assert.equal(inspectionPieceRate({ pieceRate: 180, quantityApproved: 1 }, { pieceRate: 250 }, worker), 180);
  assert.equal(inspectionPieceRate({ pieceRate: null, quantityApproved: 1 }, { pieceRate: 250 }, worker), 250);
});

test("batchProgress ignores a batch with no quantity and caps at 100", () => {
  assert.equal(batchProgress([], 100), 0, "No operations means no progress");
  assert.equal(batchProgress([{ quantityCompleted: 5 }], 0), 0, "Zero-quantity batch must not divide by zero");
  assert.equal(batchProgress([{ quantityCompleted: 5 }, { quantityCompleted: 5 }], 10), 50);
  assert.equal(batchProgress([{ quantityCompleted: 999 }], 10), 100, "Progress is capped at 100%");
});

test("month helpers roll over year boundaries correctly", () => {
  assert.equal(monthKey(new Date(Date.UTC(2026, 8, 15))), "2026-09");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(shiftMonth("2026-09", 0), "2026-09");
  assert.match(monthLabel("2026-09"), /September/);
  assert.match(monthLabel("2026-09"), /2026/);
  assert.match(currentMonth(), /^\d{4}-\d{2}$/);
});

test("passwords are salted, verified in constant time, and never stored in the clear", () => {
  const password = "Str0ng!Passw0rd";
  const first = hashPassword(password);
  const second = hashPassword(password);

  assert.notEqual(first, second, "The same password must produce a different hash each time (random salt)");
  assert.equal(first.split(":").length, 2, "Stored as salt:hash");
  assert.equal(first.includes(password), false, "The plaintext must not appear in the stored value");
  assert.equal(verifyPassword(password, first), true);
  assert.equal(verifyPassword(password, second), true);
  assert.equal(verifyPassword("wrong-password", first), false);
  assert.equal(verifyPassword(password, null), false, "A missing hash must not authenticate");
  assert.equal(verifyPassword(password, "malformed"), false, "A malformed hash must not authenticate");
});
