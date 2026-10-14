/**
 * THE EVERYDAY DEDUCTION WORKFLOW, AS SIMPLIFIED.
 *
 * Select worker → select category → enter amount → choose payroll month →
 * once or monthly → add another deduction if needed → review and save.
 *
 * These tests pin the simplified contract end to end through the real route
 * handlers: no annual tax relief, lawful-basis, evidence or consent references
 * are required for ordinary deductions; several deductions can be created for
 * one worker (or several workers) in one request; the internal company "Tax"
 * stays completely separate from statutory PAYE; and none of the simplification
 * weakens duplicate prevention, approval, audit or net-pay accuracy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/db";
import { payrollDeductions, payrollStatements, payrollStatementLines, workers } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { api, createOwner, createStaff, createWorker, expectStatus } from "./support/harness";
import { currentMonth, shiftMonth } from "@/lib/payroll";

const suffix = () => `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
const previous = () => shiftMonth(currentMonth(), -1);

async function salary(owner: string, amount = 90_000, department = "Operations") {
  const worker = await createWorker(owner, { name: `Simple Deduction ${suffix()}`, specialty: "Office Staff", paymentType: "MONTHLY", paymentRate: amount, department });
  await db.update(workers).set({ createdAt: new Date(`${previous()}-01T00:00:00Z`) }).where(eq(workers.id, worker.id));
  return worker;
}
const rowFor = async (cookie: string, workerId: number, month = previous()) => {
  const response = await api("GET", `/api/payroll?month=${month}`, { cookie });
  await expectStatus(response, 200, "Payroll preview");
  return response.data.workers.find((w: any) => w.workerId === workerId);
};

test("an ordinary deduction needs only worker, category, amount, month and frequency", async () => {
  const owner = await createOwner();
  const worker = await salary(owner.cookie, 90_000);
  const simple = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "HOUSE_RENT", amount: 10_000,
    startMonth: previous(), frequencyMonths: 0, lateReason: "Agreed before closing last month's payroll",
  } });
  const created = await expectStatus(simple, 201, "Simple house-rent deduction");
  assert.equal(created.count, 1);
  const row = created.created[0];
  assert.equal(row.status, "PENDING");
  assert.equal(row.amount, 10_000);
  assert.equal(row.categoryCode, "HOUSE_RENT");
  assert.equal(row.reference.startsWith("AUTO-"), true, "A reference is generated, not demanded from the administrator");
  assert.equal(row.consentRef, null, "The simple form never asks for consent paperwork");
  assert.equal(row.authorityRef, null);
  assert.equal(row.evidenceRef, null);
  assert.ok(row.description.length >= 3);
  // Review and save: the proposal is approved through the normal process.
  await expectStatus(await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { id: row.id, action: "APPROVE", reason: "Reviewed the everyday rent arrangement" } }), 200, "Approve");
  const preview = await rowFor(owner.cookie, worker.id);
  assert.equal(preview.deductionItems.length, 1);
  assert.equal(preview.deductionItems[0].amount, 10_000);
  assert.equal(preview.due, 80_000, "Net pay reflects the scheduled deduction");
});

test("one worker can have several different deductions in the same payroll month, created together", async () => {
  const owner = await createOwner();
  const worker = await salary(owner.cookie, 90_000);
  const batch = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    items: [
      { workerId: worker.id, categoryCode: "INTERNAL_TAX", amount: 100, startMonth: previous(), frequencyMonths: 0, lateReason: "Agreed before closing last month's payroll" },
      { workerId: worker.id, categoryCode: "HOUSE_RENT", amount: 10_000, startMonth: previous(), frequencyMonths: 0, lateReason: "Agreed before closing last month's payroll" },
      { workerId: worker.id, categoryCode: "COOPERATIVE", amount: 5_000, startMonth: previous(), frequencyMonths: 1, lateReason: "Agreed before closing last month's payroll" },
      { workerId: worker.id, categoryCode: "LOAN_REPAYMENT", amount: 2_000, startMonth: previous(), frequencyMonths: 1, lateReason: "Agreed before closing last month's payroll" },
    ],
  } });
  const created = await expectStatus(batch, 201, "Four deductions for one worker");
  assert.equal(created.count, 4);
  for (const row of created.created) {
    assert.equal(row.workerId, worker.id);
    assert.equal(row.status, "PENDING");
    await expectStatus(await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
      body: { id: row.id, action: "APPROVE", reason: "Reviewed this scheduled deduction entry" } }), 200, "Approve entry");
  }
  const preview = await rowFor(owner.cookie, worker.id);
  assert.equal(preview.deductionItems.length, 4, "Each deduction is displayed separately");
  assert.deepEqual(preview.deductionItems.map((i: any) => i.amount).sort((a: number, b: number) => a - b), [100, 2_000, 5_000, 10_000]);
  assert.equal(preview.payrollDeductions, 17_100, "Total scheduled deductions is calculated");
  assert.equal(preview.due, 72_900);
  // Only the monthly ones repeat next month.
  const future = await rowFor(owner.cookie, worker.id, currentMonth());
  assert.deepEqual(future.deductionItems.map((i: any) => i.amount).sort((a: number, b: number) => a - b), [2_000, 5_000]);
});

test("internal Tax supports several workers with per-worker amounts and never needs statutory assessment fields", async () => {
  const owner = await createOwner();
  const a = await salary(owner.cookie);
  const b = await salary(owner.cookie);
  const c = await salary(owner.cookie);
  const tax = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    categoryCode: "INTERNAL_TAX", amount: 150,
    selection: { type: "IDS", workerIds: [a.id, b.id, c.id] },
    workerAmounts: [
      { workerId: a.id, amount: 100 },
      { workerId: b.id, amount: 200 },
      { workerId: c.id, amount: 150 },
    ],
    startMonth: previous(), frequencyMonths: 0, lateReason: "Agreed before closing last month's payroll",
  } });
  const created = await expectStatus(tax, 201, "Tax for three workers at different amounts");
  assert.equal(created.count, 3);
  const amounts = new Map(created.created.map((row: any) => [row.workerId, row.amount]));
  assert.deepEqual([amounts.get(a.id), amounts.get(b.id), amounts.get(c.id)], [100, 200, 150]);
  // No annual gross, pension, NHF, NHIS, rent, relief, consent or lawful-basis
  // fields were sent — and none were demanded.
  for (const row of created.created) assert.equal(row.annualGross, null);
  for (const row of created.created) {
    await expectStatus(await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
      body: { id: row.id, action: "APPROVE", reason: "Reviewed internal tax withholding" } }), 200, "Approve tax entry");
  }
  assert.equal((await rowFor(owner.cookie, a.id)).due, 89_900);
  assert.equal((await rowFor(owner.cookie, b.id)).due, 89_800);
  assert.equal((await rowFor(owner.cookie, c.id)).due, 89_850);
});

test("the internal Tax deduction is separated from statutory PAYE in calculation and reporting", async () => {
  const owner = await createOwner();
  const reviewer = await createStaff(owner.cookie, { name: `PAYE Reviewer ${suffix()}`, role: "OWNER" });
  const worker = await salary(owner.cookie, 100_000);
  if (!previous().startsWith("2026-")) return; // PAYE schedule is 2026-only by design
  const internal = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "INTERNAL_TAX", amount: 500,
    startMonth: previous(), frequencyMonths: 0, lateReason: "Agreed before closing last month's payroll",
  } });
  const [internalRow] = (await expectStatus(internal, 201, "Internal tax")).created;
  await expectStatus(await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { id: internalRow.id, action: "APPROVE", reason: "Reviewed internal tax withholding" } }), 200, "Approve internal tax");
  const paye = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "STATUTORY_TAX", description: "Annual PAYE assessment under NTA 2025",
    method: "PAYE_2026", frequencyMonths: 1, startMonth: previous(), endMonth: "2026-12",
    lateReason: "Assessment filed before last month payroll closed", evidenceRef: "PIT-SIGNED-2026",
    annualGross: 1_200_000, annualPension: 0, annualNhf: 0, annualNhis: 0, annualRentPaid: 0, annualOtherRelief: 0,
  } });
  const [payeRow] = (await expectStatus(paye, 201, "Statutory PAYE")).created;
  await expectStatus(await api("PUT", "/api/payroll-deductions", { cookie: reviewer.cookie,
    body: { id: payeRow.id, action: "APPROVE", reason: "Verified signed statutory assessment" } }), 200, "Approve PAYE");
  // Statutory PAYE still refuses to run without its assessment fields.
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "STATUTORY_TAX", method: "PAYE_2026", frequencyMonths: 1,
    startMonth: previous(), endMonth: "2026-12", lateReason: "Missing the assessment on purpose",
  } })).status, 400, "Genuine PAYE keeps its statutory requirements");
  await expectStatus(await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: worker.id, month: previous() } }), 201, "Post tax month");
  const [statement] = await db.select().from(payrollStatements)
    .where(and(eq(payrollStatements.workerId, worker.id), eq(payrollStatements.periodMonth, previous())));
  assert.equal(statement.taxDeduction, 5_000, "Only statutory PAYE counts as tax");
  assert.equal(statement.companyDeductions, 500, "Internal Tax is a company deduction, not a government remittance");
  const report = await api("GET", `/api/payroll-deductions?view=report&month=${previous()}&workerId=${worker.id}`, { cookie: owner.cookie });
  await expectStatus(report, 200, "Report");
  assert.equal(report.data.byCategory.find((g: any) => g.label === "INTERNAL_TAX").amount, 500);
  assert.equal(report.data.byCategory.find((g: any) => g.label === "STATUTORY_TAX").amount, 5_000,
    "Internal company Tax is reported separately from statutory PAYE");
});

test("recurring ordinary deductions start, can be stopped and restated without ever double-charging a month", async () => {
  const owner = await createOwner();
  const worker = await salary(owner.cookie, 90_000);
  const rent = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "HOUSE_RENT", amount: 6_000,
    startMonth: previous(), frequencyMonths: 1, lateReason: "Agreed before closing last month's payroll",
  } });
  const [row] = (await expectStatus(rent, 201, "Recurring rent")).created;
  await expectStatus(await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { id: row.id, action: "APPROVE", reason: "Reviewed recurring rent arrangement" } }), 200, "Approve recurring rent");
  assert.equal((await rowFor(owner.cookie, worker.id)).due, 84_000);
  await expectStatus(await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: worker.id, month: previous() } }), 201, "Post first month");
  // Same month can never be recalculated into a second charge.
  assert.equal((await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: worker.id, month: previous() } })).status, 409);
  // Authorised change of a recurring amount = stop the old arrangement, start
  // a corrected one; the posted month is never rewritten.
  await expectStatus(await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { id: row.id, action: "CANCEL", reason: "Rent amount changed by agreement" } }), 200, "Stop recurring rent");
  const changed = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "HOUSE_RENT", amount: 7_500,
    startMonth: currentMonth(), frequencyMonths: 1,
  } });
  const [next] = (await expectStatus(changed, 201, "Restated rent")).created;
  await expectStatus(await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { id: next.id, action: "APPROVE", reason: "Reviewed the restated rent amount" } }), 200, "Approve restated rent");
  assert.equal((await rowFor(owner.cookie, worker.id, previous())).due, 84_000, "The posted month stays frozen");
  assert.equal((await rowFor(owner.cookie, worker.id, currentMonth())).due, 82_500, "Only the new amount applies going forward");
  // An identical duplicate of the new arrangement is refused.
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "HOUSE_RENT", amount: 7_500,
    startMonth: currentMonth(), frequencyMonths: 1,
    description: `House rent for ${currentMonth()}`,
  } })).status, 409);
});

test("one worker may not have duplicate Tax or cooperative arrangements in the same payroll month", async () => {
  const owner = await createOwner();
  const worker = await salary(owner.cookie, 90_000);
  const first = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "COOPERATIVE", amount: 5_000,
    startMonth: previous(), frequencyMonths: 0, lateReason: "Agreed before closing last month's payroll",
  } });
  await expectStatus(first, 201, "First cooperative contribution");
  const duplicate = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "COOPERATIVE", amount: 3_000,
    startMonth: previous(), frequencyMonths: 0, lateReason: "Agreed before closing last month's payroll",
  } });
  assert.equal(duplicate.status, 409, "Same worker and payroll period cannot be charged twice");
  const tax = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "INTERNAL_TAX", amount: 200,
    startMonth: previous(), frequencyMonths: 0, lateReason: "Agreed before closing last month's payroll",
  } });
  await expectStatus(tax, 201, "First tax arrangement");
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "INTERNAL_TAX", amount: 100,
    startMonth: previous(), frequencyMonths: 0, lateReason: "Agreed before closing last month's payroll",
  } })).status, 409, "One tax arrangement per worker per month");
  // But the same worker may have cooperative AND tax AND rent in that month.
  await expectStatus(await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "HOUSE_RENT", amount: 1_000,
    startMonth: previous(), frequencyMonths: 0, lateReason: "Agreed before closing last month's payroll",
  } }), 201, "Different categories are not duplicates");
});

test("different workers keep different amounts and arrangements in one batch", async () => {
  const owner = await createOwner();
  const w1 = await salary(owner.cookie, 80_000);
  const w2 = await salary(owner.cookie, 60_000);
  const w3 = await salary(owner.cookie, 40_000);
  const created = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    items: [
      { workerId: w1.id, categoryCode: "HOUSE_RENT", amount: 8_000, startMonth: previous(), frequencyMonths: 0, lateReason: "Agreed before closing last month's payroll" },
      { workerId: w1.id, categoryCode: "INTERNAL_TAX", amount: 100, startMonth: previous(), frequencyMonths: 0, lateReason: "Agreed before closing last month's payroll" },
      { workerId: w2.id, categoryCode: "COOPERATIVE", amount: 2_500, startMonth: previous(), frequencyMonths: 1, lateReason: "Agreed before closing last month's payroll" },
      { workerId: w3.id, categoryCode: "LOAN_REPAYMENT", amount: 1_000, startMonth: previous(), frequencyMonths: 1, lateReason: "Agreed before closing last month's payroll" },
    ],
  } });
  await expectStatus(created, 201, "Mixed arrangements");
  assert.equal(created.data.count, 4);
  assert.deepEqual(created.data.created.map((r: any) => r.amount).sort((a: number, b: number) => a - b), [100, 1_000, 2_500, 8_000]);
  for (const row of created.data.created) {
    await expectStatus(await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
      body: { id: row.id, action: "APPROVE", reason: "Reviewed this worker's arrangement" } }), 200, "Approve batch item");
  }
  assert.equal((await rowFor(owner.cookie, w1.id)).due, 71_900);
  assert.equal((await rowFor(owner.cookie, w2.id)).due, 57_500);
  assert.equal((await rowFor(owner.cookie, w3.id)).due, 39_000);
});

test("a salary-plus-production worker's statement separates earnings, each deduction and net pay", async () => {
  const owner = await createOwner();
  const hybrid = await createWorker(owner.cookie, { name: `Mixed Earner ${suffix()}`, specialty: "Cutter", paymentType: "HYBRID", paymentRate: 50_000 });
  await db.update(workers).set({ createdAt: new Date(`${previous()}-01T00:00:00Z`) }).where(eq(workers.id, hybrid.id));
  const created = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    items: [
      { workerId: hybrid.id, categoryCode: "INTERNAL_TAX", amount: 1_000, startMonth: previous(), frequencyMonths: 0, lateReason: "Agreed before closing last month's payroll" },
      { workerId: hybrid.id, categoryCode: "COOPERATIVE", amount: 2_000, startMonth: previous(), frequencyMonths: 0, lateReason: "Agreed before closing last month's payroll" },
    ],
  } });
  for (const row of (await expectStatus(created, 201, "Hybrid deductions")).created)
    await expectStatus(await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
      body: { id: row.id, action: "APPROVE", reason: "Reviewed mixed earner deductions" } }), 200, "Approve mixed earner deduction");
  await expectStatus(await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: hybrid.id, month: previous() } }), 201, "Post hybrid month");
  const [statement] = await db.select().from(payrollStatements)
    .where(and(eq(payrollStatements.workerId, hybrid.id), eq(payrollStatements.periodMonth, previous())));
  assert.equal(statement.salary, 50_000, "Fixed salary earning is captured");
  assert.equal(statement.piecework, 0, "No production earnings this month");
  assert.equal(statement.gross, 50_000);
  assert.equal(statement.companyDeductions, 3_000);
  assert.equal(statement.net, 47_000, "Net amount payable is exact");
  const lines = await db.select().from(payrollStatementLines).where(eq(payrollStatementLines.statementId, statement.id));
  assert.equal(lines.length, 2, "Each deduction appears separately");
  assert.equal(lines.filter((l) => l.categoryCode === "COOPERATIVE").reduce((s, l) => s + l.cooperativeCredit, 0), 2_000,
    "The cooperative ledger is credited exactly once");
});

test("simple requests still cannot forge approvals, statuses, organisations or other workers", async () => {
  const owner = await createOwner();
  const manager = await createStaff(owner.cookie, { name: `Forged ${suffix()}`, role: "PRODUCTION_MANAGER" });
  const worker = await salary(owner.cookie);
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: manager.cookie, body: {
    workerId: worker.id, categoryCode: "HOUSE_RENT", amount: 1_000, startMonth: previous(),
  } })).status, 403, "Deductions stay Owner-only on the backend");
  const forged = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "INTERNAL_TAX", amount: 100, startMonth: previous(),
    frequencyMonths: 0, lateReason: "Agreed before closing last month's payroll",
    status: "APPROVED", organizationId: 999, createdByName: "Someone Else",
  } });
  const [row] = (await expectStatus(forged, 201, "Server-owned status")).created;
  assert.equal(row.status, "PENDING");
  assert.equal(row.organizationId, 1);
  assert.equal(row.createdByName, "Test Owner");
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "HOUSE_RENT", amount: "Infinity", startMonth: previous(),
  } })).status, 400, "Amounts are validated on the server");
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    items: [],
  } })).status, 400, "An empty batch is refused");
  const trail = await api("GET", `/api/payroll-deductions?view=audit&entityType=DEDUCTION&entityId=${row.id}`, { cookie: owner.cookie });
  assert.equal(trail.data.rows[0].action, "CREATE", "Every proposal writes an audit event");
});
