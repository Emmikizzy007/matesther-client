/**
 * PRODUCTION INCIDENTS: damaged, lost and incomplete clothes.
 *
 * An authorised supervisor records an incident against an EXISTING work
 * assignment — even when the work has not been completed, inspected or
 * approved. Recording deducts nothing. The company reviews the incident,
 * establishes responsibility, and only an approved incident can support ONE
 * separately proposed, independently approved deduction. Every step is
 * preserved: assignment → incident → review → correction/approval → deduction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/db";
import { payrollDeductions, payrollStatementLines, payrollStatements, productionIncidents, workers } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { api, createOrder, createOwner, createStaff, createWorker, expectStatus } from "./support/harness";
import { currentMonth, shiftMonth } from "@/lib/payroll";
import { SUPPORT_ROLE } from "@/lib/format";

const suffix = () => `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
const previous = () => shiftMonth(currentMonth(), -1);

async function salary(owner: string, amount = 90_000) {
  // A Cutter holds the role the CUTTING stage assignment requires; the tests
  // never inspect any of their work, so they earn salary only.
  const worker = await createWorker(owner, { name: `Incident Worker ${suffix()}`, specialty: "Cutter", paymentType: "MONTHLY", paymentRate: amount, department: "Operations" });
  await db.update(workers).set({ createdAt: new Date(`${previous()}-01T00:00:00Z`) }).where(eq(workers.id, worker.id));
  return worker;
}

/** An ordinary stage assignment on fresh garments: work assigned but NOT
 * completed, NOT inspected and NOT approved. */
async function assignWork(owner: string, workerId: number, quantity = 10) {
  const order = await createOrder(owner, { quantity });
  const batch = await api("POST", "/api/batches", { cookie: owner, body: {
    orderId: order.orderId, orderItemId: order.itemId, quantity, workerId, cuttingRate: 300,
  } });
  await expectStatus(batch, 201, "Assign stage work");
  const jobs = await api("GET", `/api/operations?batchId=${batch.data.id}`, { cookie: owner });
  const op = jobs.data.find((j: any) => j.stage === "CUTTING");
  assert.ok(op, "The cutting assignment exists");
  return op;
}

test("a supervisor records an incident against uncompleted, uninspected, unapproved work — and no money moves", async () => {
  const owner = await createOwner();
  const supervisor = await createStaff(owner.cookie, { name: `Floor Supervisor ${suffix()}`, role: "PRODUCTION_MANAGER" });
  const worker = await salary(owner.cookie);
  const op = await assignWork(owner.cookie, worker.id, 10);
  const reported = await api("POST", "/api/production-incidents", { cookie: supervisor.cookie, body: {
    workerId: worker.id, assignmentSource: "STAGE_OPERATION", productionOperationId: op.id,
    incidentType: "INCOMPLETE_WORK", description: "Four garments left unfinished when the worker was reassigned",
    incompleteQuantity: 4,
  } });
  const incident = await expectStatus(reported, 201, "Supervisor reports incomplete work");
  assert.equal(incident.status, "REPORTED");
  assert.equal(incident.assignedQuantity, 10, "The assigned quantity is shown on the incident");
  assert.equal(incident.incompleteQuantity, 4);
  assert.equal(incident.productionOperationId, op.id, "Linked to the original assignment");
  assert.equal(incident.workerId, worker.id, "Linked to the responsible worker");
  // Recording an incident must NOT automatically deduct money.
  assert.equal((await api("GET", `/api/payroll?month=${currentMonth()}&workerId=${worker.id}`, { cookie: owner.cookie }))
    .data.history.find((h: any) => h.month === currentMonth()).payrollDeductions, 0);
  const rows = await db.select().from(payrollDeductions).where(eq(payrollDeductions.workerId, worker.id));
  assert.equal(rows.length, 0, "No deduction proposal is created by an incident report");
});

test("damaged, lost and incomplete incidents each record their own quantities and refuse impossible ones", async () => {
  const owner = await createOwner();
  const worker = await salary(owner.cookie);
  const op = await assignWork(owner.cookie, worker.id, 8);
  assert.equal((await api("POST", "/api/production-incidents", { cookie: owner.cookie, body: {
    workerId: worker.id, assignmentSource: "STAGE_OPERATION", productionOperationId: op.id,
    incidentType: "DAMAGED_CLOTHES", description: "Missing the damaged count",
  } })).status, 400, "Damaged-clothes incidents record at least one damaged piece");
  assert.equal((await api("POST", "/api/production-incidents", { cookie: owner.cookie, body: {
    workerId: worker.id, assignmentSource: "STAGE_OPERATION", productionOperationId: op.id,
    incidentType: "LOST_CLOTHES", description: "Missing the lost count",
  } })).status, 400);
  assert.equal((await api("POST", "/api/production-incidents", { cookie: owner.cookie, body: {
    workerId: worker.id, assignmentSource: "STAGE_OPERATION", productionOperationId: op.id,
    incidentType: "INCOMPLETE_WORK", description: "Nine incomplete of eight assigned", incompleteQuantity: 9,
  } })).status, 400, "Quantities cannot exceed the assignment");
  const damaged = await api("POST", "/api/production-incidents", { cookie: owner.cookie, body: {
    workerId: worker.id, assignmentSource: "STAGE_OPERATION", productionOperationId: op.id,
    incidentType: "DAMAGED_CLOTHES", description: "Two sleeves cut wrongly during pressing",
    damagedQuantity: 2, completedQuantity: 3, proposedAmount: 900,
    proposedCalculation: "2 damaged × ₦450 repair cost",
  } });
  await expectStatus(damaged, 201, "Damaged clothes");
  assert.equal(damaged.data.damagedQuantity, 2);
  assert.equal(damaged.data.proposedAmount, 900);
  const lost = await api("POST", "/api/production-incidents", { cookie: owner.cookie, body: {
    workerId: worker.id, assignmentSource: "STAGE_OPERATION", productionOperationId: op.id,
    incidentType: "LOST_CLOTHES", description: "One garment missing after the store count",
    missingQuantity: 1,
  } });
  await expectStatus(lost, 201, "Lost clothes");
  const other = await api("POST", "/api/production-incidents", { cookie: owner.cookie, body: {
    workerId: worker.id, assignmentSource: "STAGE_OPERATION", productionOperationId: op.id,
    incidentType: "OTHER", description: "Thread and trim wastage documented on the floor journal",
  } });
  await expectStatus(other, 201, "Other documented incident");
  // One OPEN incident of a type per assignment — duplicates are refused.
  assert.equal((await api("POST", "/api/production-incidents", { cookie: owner.cookie, body: {
    workerId: worker.id, assignmentSource: "STAGE_OPERATION", productionOperationId: op.id,
    incidentType: "LOST_CLOTHES", description: "Trying to report the same loss twice", missingQuantity: 1,
  } })).status, 409, "Duplicate incident prevention");
  // Wrong worker or wrong organisation's assignment is refused.
  const otherWorker = await salary(owner.cookie);
  assert.equal((await api("POST", "/api/production-incidents", { cookie: owner.cookie, body: {
    workerId: otherWorker.id, assignmentSource: "STAGE_OPERATION", productionOperationId: op.id,
    incidentType: "INCOMPLETE_WORK", description: "Blaming a worker who never held this assignment", incompleteQuantity: 1,
  } })).status, 404);
  assert.equal((await api("POST", "/api/production-incidents", { cookie: owner.cookie, body: {
    workerId: worker.id, assignmentSource: "STAGE_OPERATION", productionOperationId: 999_999,
    incidentType: "INCOMPLETE_WORK", description: "Nonexistent assignment probe", incompleteQuantity: 1,
  } })).status, 404);
});

test("an incident is reviewed before any deduction: correction-only and rejected outcomes justify no charge", async () => {
  const owner = await createOwner();
  const reviewer = await createStaff(owner.cookie, { name: `Incident Reviewer ${suffix()}`, role: "OWNER" });
  const worker = await salary(owner.cookie);
  const op = await assignWork(owner.cookie, worker.id, 6);
  const reported = await api("POST", "/api/production-incidents", { cookie: owner.cookie, body: {
    workerId: worker.id, assignmentSource: "STAGE_OPERATION", productionOperationId: op.id,
    incidentType: "DAMAGED_CLOTHES", description: "One collar pressed with a shine mark; correctable by rework",
    damagedQuantity: 1,
  } });
  const incident = await expectStatus(reported, 201, "Report");
  // Review by the company distinguishes correctable work from chargeable loss.
  await expectStatus(await api("PUT", "/api/production-incidents", { cookie: reviewer.cookie, body: {
    id: incident.id, action: "CORRECTION_ONLY",
    reason: "Rework fixes the mark; no loss to the company, so no deduction is justified",
  } }), 200, "Correction-only outcome");
  assert.equal((await db.select().from(payrollDeductions).where(eq(payrollDeductions.workerId, worker.id))).length, 0);
  // A deduction can only follow an incident approved for deduction.
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "DAMAGE", method: "FIXED", amount: 500,
    incidentProductionId: incident.id, startMonth: previous(), lateReason: "Reviewed before closing last month",
  } })).status, 409, "A correction-only incident never supports a deduction");

  const rejected = await api("POST", "/api/production-incidents", { cookie: owner.cookie, body: {
    workerId: worker.id, assignmentSource: "STAGE_OPERATION", productionOperationId: op.id,
    incidentType: "OTHER", description: "Scraps claimed to be the worker's fault but unproven",
  } });
  const second = await expectStatus(rejected, 201, "Second incident type");
  await expectStatus(await api("PUT", "/api/production-incidents", { cookie: reviewer.cookie, body: {
    id: second.id, action: "REJECTED", reason: "No evidence links the scraps to this worker's conduct",
  } }), 200, "Rejected outcome");
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "DAMAGE", method: "FIXED", amount: 500,
    incidentProductionId: second.id, startMonth: previous(), lateReason: "Reviewed before closing last month",
  } })).status, 409);
});

test("a reviewed incident supports exactly one approved deduction — never automatically, never twice", async () => {
  const owner = await createOwner();
  const reporter = await createStaff(owner.cookie, { name: `Reporting Owner ${suffix()}`, role: "OWNER" });
  const reviewer = await createStaff(owner.cookie, { name: `Deduction Authoriser ${suffix()}`, role: "OWNER" });
  const approver = await createStaff(owner.cookie, { name: `Deduction Approver ${suffix()}`, role: "OWNER" });
  const worker = await salary(owner.cookie, 90_000);
  const op = await assignWork(owner.cookie, worker.id, 10);
  const reported = await api("POST", "/api/production-incidents", { cookie: reporter.cookie, body: {
    workerId: worker.id, assignmentSource: "STAGE_OPERATION", productionOperationId: op.id,
    incidentType: "LOST_CLOTHES", description: "Two finished garments missing from the finishing table",
    missingQuantity: 2, proposedAmount: 1_200, proposedCalculation: "2 garments × agreed ₦600 loss value",
  } });
  const incident = await expectStatus(reported, 201, "Lost clothes reported");
  // The reporter cannot approve their own incident for a deduction.
  assert.equal((await api("PUT", "/api/production-incidents", { cookie: reporter.cookie, body: {
    id: incident.id, action: "APPROVED_FOR_DEDUCTION", approvedAmount: 1_200,
    reason: "Trying to authorise my own report for a charge",
  } })).status, 403, "Separation of duties on incident review");
  await expectStatus(await api("PUT", "/api/production-incidents", { cookie: reviewer.cookie, body: {
    id: incident.id, action: "APPROVED_FOR_DEDUCTION", approvedAmount: 1_000,
    reason: "Responsibility established; ₦1,000 of the proven loss is justified after the withheld pieces",
  } }), 200, "Approve for deduction at a justified amount");
  const payBefore = (await api("GET", `/api/payroll?month=${previous()}&workerId=${worker.id}`, { cookie: owner.cookie }))
    .data.history.find((h: any) => h.month === previous()).due;
  assert.equal(payBefore, 90_000, "Even an approved incident deducts nothing until a deduction is posted");
  // The charge is capped by the reviewed amount.
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "DAMAGE", method: "FIXED", amount: 1_001,
    incidentProductionId: incident.id, startMonth: previous(), lateReason: "Reviewed before closing last month",
  } })).status, 400, "A charge cannot exceed the reviewed incident amount");
  const charge = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "DAMAGE", method: "FIXED", amount: 1_000,
    incidentProductionId: incident.id, startMonth: previous(), lateReason: "Reviewed before closing last month",
  } });
  const [row] = (await expectStatus(charge, 201, "Incident deduction proposal")).created;
  assert.equal(row.incidentProductionId, incident.id);
  assert.equal(row.status, "PENDING", "The financial deduction itself still needs the normal approval");
  // A second claim on the same incident is refused while one is active…
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "DAMAGE", method: "FIXED", amount: 500,
    incidentProductionId: incident.id, startMonth: previous(), lateReason: "Reviewed before closing last month",
  } })).status, 409, "Duplicate deduction prevention for the same incident");
  // …and the incident-based charge needs independent Owner approval.
  assert.equal((await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    id: row.id, action: "APPROVE", reason: "Trying to approve my own damage charge",
  } })).status, 403);
  await expectStatus(await api("PUT", "/api/payroll-deductions", { cookie: approver.cookie, body: {
    id: row.id, action: "APPROVE", reason: "Reviewed the incident findings and the justified loss",
  } }), 200, "Independent approval of the charge");
  const preview = (await api("GET", `/api/payroll?month=${previous()}&workerId=${worker.id}`, { cookie: owner.cookie }))
    .data.history.find((h: any) => h.month === previous());
  assert.equal(preview.due, 89_000);
  await expectStatus(await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie, body: {
    workerId: worker.id, month: previous() } }), 201, "Post the approved charge");
  // After posting the incident can never be charged again.
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: worker.id, categoryCode: "DAMAGE", method: "FIXED", amount: 100,
    incidentProductionId: incident.id, startMonth: currentMonth(), lateReason: "",
  } })).status, 409, "A posted incident is never charged twice");
  // The assignment's production history is untouched.
  const [inc] = await db.select().from(productionIncidents).where(eq(productionIncidents.id, incident.id));
  assert.equal(inc.status, "APPROVED_FOR_DEDUCTION");
  const [statement] = await db.select().from(payrollStatements)
    .where(and(eq(payrollStatements.workerId, worker.id), eq(payrollStatements.periodMonth, previous())));
  assert.equal(statement.companyDeductions, 1_000);
  const lines = await db.select().from(payrollStatementLines).where(eq(payrollStatementLines.statementId, statement.id));
  assert.equal(lines.length, 1, "Exactly one booked charge for the incident");
});

test("incidents can be recorded on support-work assignments and follow the same review trail", async () => {
  const owner = await createOwner();
  const reviewer = await createStaff(owner.cookie, { name: `Support Incident Reviewer ${suffix()}`, role: "OWNER" });
  const tailor = await createWorker(owner.cookie, { name: `Tailor ${suffix()}`, specialty: "Tailor" });
  const helper = await createWorker(owner.cookie, { name: `Helper ${suffix()}`, specialty: SUPPORT_ROLE, roles: [SUPPORT_ROLE] });
  const tailorLogin = await createStaff(owner.cookie, { name: tailor.name, role: "WORKER" });
  const order = await createOrder(owner.cookie, { quantity: 6 });
  const batch = await api("POST", "/api/batches", { cookie: owner.cookie, body: {
    orderId: order.orderId, orderItemId: order.itemId, quantity: 6,
    stages: [{ stage: "SEWING" }], assignments: [{ stage: "SEWING", workerId: tailor.id, pieceRate: 300 }],
  } });
  await expectStatus(batch, 201, "Sewing job");
  const jobs = await api("GET", `/api/operations?batchId=${batch.data.id}`, { cookie: owner.cookie });
  const sewing = jobs.data.find((j: any) => j.stage === "SEWING");
  const assigned = await api("POST", "/api/support-work", { cookie: tailorLogin.cookie, body: {
    workerId: helper.id, operation: "Weaving", quantityAssigned: 6, pieceRate: 100, productionOperationId: sewing.id,
  } });
  const support = await expectStatus(assigned, 201, "Support assignment");
  // The helper has not finished or submitted anything — the incident can still
  // be recorded against the assignment.
  const reported = await api("POST", "/api/production-incidents", { cookie: owner.cookie, body: {
    workerId: helper.id, assignmentSource: "SUPPORT_ASSIGNMENT", supportAssignmentId: support.id,
    incidentType: "DAMAGED_CLOTHES", description: "One support piece scorched while unattended",
    damagedQuantity: 1, proposedAmount: 150, proposedCalculation: "1 piece × ₦150 repair contribution",
  } });
  const incident = await expectStatus(reported, 201, "Support incident");
  assert.equal(incident.assignedQuantity, 6);
  assert.equal(incident.supportAssignmentId, support.id);
  await expectStatus(await api("PUT", "/api/production-incidents", { cookie: reviewer.cookie, body: {
    id: incident.id, action: "APPROVED_FOR_DEDUCTION", approvedAmount: 150,
    reason: "Carelessness established; agreed repair contribution is justified",
  } }), 200, "Approved for deduction");
  const charge = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    workerId: helper.id, categoryCode: "DAMAGE", method: "FIXED", amount: 150,
    incidentProductionId: incident.id, startMonth: previous(), lateReason: "Reviewed before closing last month",
  } });
  const [row] = (await expectStatus(charge, 201, "Charge follows the support incident")).created;
  assert.equal(row.incidentSupportInspectionId, null, "A production incident is not an inspection case");
  const incidents = await api("GET", `/api/production-incidents?workerId=${helper.id}`, { cookie: owner.cookie });
  assert.equal(incidents.data.rows.length, 1);
  assert.equal(incidents.data.rows[0].incident.assignmentSource, "SUPPORT_ASSIGNMENT");
  assert.equal(incidents.data.rows[0].deduction.id, row.id, "The register links the incident to its deduction");
});

test("incident reports and reviews are permissioned and fully audited", async () => {
  const owner = await createOwner();
  const worker = await salary(owner.cookie);
  const login = await createStaff(owner.cookie, { name: worker.name, role: "WORKER" });
  const op = await assignWork(owner.cookie, worker.id, 4);
  const body = {
    workerId: worker.id, assignmentSource: "STAGE_OPERATION", productionOperationId: op.id,
    incidentType: "INCOMPLETE_WORK", description: "Worker attempts to file their own incident", incompleteQuantity: 1,
  };
  assert.equal((await api("POST", "/api/production-incidents", { cookie: login.cookie, body })).status, 403,
    "Workers cannot file production incidents");
  assert.equal((await api("POST", "/api/production-incidents", { body })).status, 401);
  const reported = await api("POST", "/api/production-incidents", { cookie: owner.cookie, body });
  const incident = await expectStatus(reported, 201, "Owner reports");
  assert.equal((await api("PUT", "/api/production-incidents", { cookie: login.cookie, body: {
    id: incident.id, action: "REJECTED", reason: "Worker tries to dismiss the case",
  } })).status, 403);
  await expectStatus(await api("PUT", "/api/production-incidents", { cookie: owner.cookie, body: {
    id: incident.id, action: "REJECTED", reason: "Investigation found the shortfall was a counting error",
  } }), 200, "Owner reviews");
  const trail = await api("GET", `/api/payroll-deductions?view=audit&entityType=PRODUCTION_INCIDENT&entityId=${incident.id}`, { cookie: owner.cookie });
  assert.deepEqual(trail.data.rows.map((r: any) => r.action), ["REJECTED", "REPORT"],
    "Report and review are both preserved in the audit trail with actor and time");
  assert.equal(trail.data.rows[0].actorName, "Test Owner");
  // A cancelled report may be corrected and resubmitted; the trail survives.
  const second = await api("POST", "/api/production-incidents", { cookie: owner.cookie, body: {
    ...body, incidentType: "LOST_CLOTHES", missingQuantity: 1,
    description: "Two garments unaccounted for at the daily count",
  } });
  const lost = await expectStatus(second, 201, "Lost-clothes report");
  await expectStatus(await api("PUT", "/api/production-incidents", { cookie: owner.cookie, body: {
    id: lost.id, action: "CANCEL", reason: "Reported against the wrong batch; resubmitting correctly",
  } }), 200, "Cancel mistaken report");
  await expectStatus(await api("POST", "/api/production-incidents", { cookie: owner.cookie, body: {
    ...body, incidentType: "LOST_CLOTHES", missingQuantity: 1,
    description: "Two garments unaccounted for at the daily count (correct batch)",
  } }), 201, "Resubmitted after cancellation");
});
