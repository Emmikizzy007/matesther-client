import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { workers, organizations, sessions, users, payrollStatements, payrollStatementLines, stageInspections, supportInspections } from "@/db/schema";
import { api, createOwner, createStaff, createWorker, createOrder, startSupport, expectStatus, signIn, testEmail } from "./support/harness";
import { currentMonth, shiftMonth } from "@/lib/payroll";
import { calculatePaye2026 } from "@/lib/nigerian-paye";
import { appliesInMonth } from "@/lib/payroll-deductions";
import { hashPassword } from "@/lib/password";
import { SUPPORT_ROLE } from "@/lib/format";
import { damageInspectionPayload } from "@/lib/payroll-incident-selection";

const suffix = () => `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
const today = () => new Date().toISOString().slice(0, 10);
const previous = () => shiftMonth(currentMonth(), -1);

async function salary(owner: string, amount = 90_000, department = "Operations") {
  const worker = await createWorker(owner, { name: `Payroll Test ${suffix()}`, specialty: "Office Staff", paymentType: "MONTHLY", paymentRate: amount, department });
  // Empty isolated pg-mem fixture: this employee was already engaged last month.
  await db.update(workers).set({ createdAt: new Date(`${previous()}-01T00:00:00Z`) }).where(eq(workers.id, worker.id));
  return worker;
}
const proposal = (workerId: number, categoryCode: string, amount: number, ref = suffix()) => ({
  workerId, categoryCode, description: `${categoryCode} agreed for this employee`, method: "FIXED", amount,
  reference: `TEST-${ref}`, startMonth: previous(), lateReason: "Agreed before closing last month's payroll",
  consentRef: `SIGNED-${ref}`, consentOn: `${previous()}-01`, authorityRef: `LEGAL-${ref}`,
});
const rowFor = async (cookie: string, workerId: number, month = previous()) => {
  const response = await api("GET", `/api/payroll?month=${month}`, { cookie });
  await expectStatus(response, 200, "Payroll preview");
  return response.data.workers.find((w: any) => w.workerId === workerId);
};

test("a reviewed deduction is previewed, posted once, then frozen alongside cash payments", async () => {
  const owner = await createOwner();
  const w = await salary(owner.cookie);
  const create = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: proposal(w.id, "HOUSE_RENT", 4_000) });
  const draft = await expectStatus(create, 201, "Create rent proposal");
  assert.equal(draft.count, 1);
  assert.equal((await rowFor(owner.cookie, w.id)).due, 90_000, "A draft cannot move pay");
  await expectStatus(await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { id: draft.created[0].id, action: "APPROVE", reason: "Signed housing arrangement reviewed" } }), 200, "Approve rent");
  const preview = await rowFor(owner.cookie, w.id);
  assert.equal(preview.gross, 90_000);
  assert.equal(preview.due, 86_000);
  assert.equal(preview.mustPost, true);
  assert.equal(preview.deductionItems[0].amount, 4_000);
  assert.equal((await api("POST", "/api/payroll", { cookie: owner.cookie,
    body: { workerId: w.id, periodMonth: previous(), amount: 1_000 } })).status, 409,
  "A settlement cannot race an unposted deduction");
  assert.equal((await api("GET", `/api/payment-sheet?month=${previous()}`, { cookie: owner.cookie })).status, 409,
    "A bank instruction must not include an unposted deduction preview");
  const posted = await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: w.id, month: previous() } });
  await expectStatus(posted, 201, "Post completed payroll");
  const sheet = await api("GET", `/api/payment-sheet?month=${previous()}`, { cookie: owner.cookie });
  await expectStatus(sheet, 200, "Bank sheet after posting");
  const payee = sheet.data.rows.find((r: any) => r.workerId === w.id);
  assert.equal(payee.gross, 90_000);
  assert.equal(payee.totalDeductions, 4_000);
  assert.equal(payee.deductionItems[0].categoryCode, "HOUSE_RENT");
  assert.equal(payee.due, 86_000);
  assert.equal((await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: w.id, month: previous() } })).status, 409, "Never post twice");
  assert.equal((await api("POST", "/api/payroll", { cookie: owner.cookie,
    body: { workerId: w.id, periodMonth: previous(), amount: 86_001 } })).status, 409);
  await expectStatus(await api("POST", "/api/payroll", { cookie: owner.cookie,
    body: { workerId: w.id, periodMonth: previous(), amount: 86_000 } }), 201, "Pay exactly the posted net");
  await db.update(workers).set({ paymentRate: 250_000, name: "Renamed after posting", department: "Other Unit" }).where(eq(workers.id, w.id));
  const frozen = await rowFor(owner.cookie, w.id);
  assert.equal(frozen.salary, 90_000, "Later rate edits never restate a posted month");
  assert.equal(frozen.gross, 90_000);
  assert.equal(frozen.due, 86_000);
  assert.equal(frozen.balance, 0);
  assert.equal(frozen.name, w.name, "Posted payslip retains the original worker name");
  assert.equal(frozen.department, "Operations", "Posted department stays historically correct");
  const report = await api("GET", `/api/payroll-deductions?view=report&month=${previous()}&workerId=${w.id}`, { cookie: owner.cookie });
  assert.equal(report.data.rows[0].department, "Operations", "Reports use the posting snapshot, not today's department");
});

async function newCase(owner: string, body: any) {
  const result = await api("POST", "/api/payroll-deductions", { cookie: owner, body });
  return (await expectStatus(result, 201, "Create deduction proposal")).created[0];
}
async function approveCase(owner: string, id: number) {
  return expectStatus(await api("PUT", "/api/payroll-deductions", { cookie: owner,
    body: { id, action: "APPROVE", reason: "Reviewed worker authorisation and business evidence" } }), 200, "Approve reviewed case");
}

// The ENACTED annual brackets, not a flat tax percentage on each employee.
test("Nigeria Tax Act 2025/2026 PAYE bands, rent relief, exemption and rounding are traceable", () => {
  const zero = { annualGross: 800_000, annualPension: 0, annualNhf: 0, annualNhis: 0,
    annualRentPaid: 0, annualOtherRelief: 0, minimumWageExempt: false };
  assert.equal(calculatePaye2026(zero).annualTax, 0);
  assert.equal(calculatePaye2026({ ...zero, annualGross: 3_000_000 }).annualTax, 330_000);
  assert.equal(calculatePaye2026({ ...zero, annualGross: 12_000_000 }).annualTax, 1_950_000);
  assert.equal(calculatePaye2026({ ...zero, annualGross: 25_000_000 }).annualTax, 4_680_000);
  assert.equal(calculatePaye2026({ ...zero, annualGross: 50_000_000 }).annualTax, 10_430_000);
  assert.equal(calculatePaye2026({ ...zero, annualGross: 51_000_000 }).annualTax, 10_680_000);
  const relief = calculatePaye2026({ ...zero, annualGross: 3_100_000, annualPension: 100_000, annualRentPaid: 1_000_000 });
  assert.equal(relief.rentRelief, 200_000);
  assert.equal(relief.chargeableIncome, 2_800_000);
  assert.equal(relief.monthlyTax, 25_000);
  assert.equal(calculatePaye2026({ ...zero, annualGross: 10_000_000, annualRentPaid: 9_000_000 }).rentRelief, 500_000);
  assert.equal(calculatePaye2026({ ...zero, annualGross: 840_000, minimumWageExempt: true }).monthlyTax, 0);
});

test("one-time, monthly, quarterly, end-date and cancelled scheduling never repeat outside terms", () => {
  const base: any = { status: "APPROVED", startMonth: "2026-01", endMonth: "2026-12", frequencyMonths: 3 };
  assert.equal(appliesInMonth(base, "2026-01"), true);
  assert.equal(appliesInMonth(base, "2026-02"), false);
  assert.equal(appliesInMonth(base, "2026-04"), true);
  assert.equal(appliesInMonth(base, "2027-01"), false);
  assert.equal(appliesInMonth({ ...base, frequencyMonths: 0 }, "2026-04"), false);
  assert.equal(appliesInMonth({ ...base, frequencyMonths: 1 }, "2026-04"), true);
  assert.equal(appliesInMonth({ ...base, status: "CANCELLED" }, "2026-04"), false);
});

test("damage picker preserves stage versus support source even when numeric inspection IDs overlap", () => {
  assert.deepEqual(damageInspectionPayload("STAGE:7"), { incidentInspectionId: 7 });
  assert.deepEqual(damageInspectionPayload("SUPPORT:7"), { incidentSupportInspectionId: 7 });
  for (const selection of ["", "MANUAL", "STAGE:0", "SUPPORT:-1", "STAGE:7:SUPPORT:7", "SUPPORT:99999999999999999999"])
    assert.throws(() => damageInspectionPayload(selection), /Choose one rejected/);
});

test("all six built-in categories are immutable; custom categories may be managed without code or historic renaming", async () => {
  const owner = await createOwner();
  const catalogue = await api("GET", "/api/payroll-deductions/categories", { cookie: owner.cookie });
  await expectStatus(catalogue, 200, "List categories");
  assert.deepEqual(catalogue.data.builtins.map((c: any) => c.code), ["STATUTORY_TAX", "HOUSE_RENT", "COOPERATIVE", "ABSENCE", "DAMAGE", "STAFF_OCCASION"]);
  const cat = await expectStatus(await api("POST", "/api/payroll-deductions/categories", {
    cookie: owner.cookie, body: { name: `Optional Staff Welfare ${suffix()}` },
  }), 201, "Add custom category");
  const worker = await salary(owner.cookie);
  const custom = await newCase(owner.cookie, {
    ...proposal(worker.id, `CUSTOM:${cat.id}`, 2_000),
    description: "Separate staff welfare scheme contribution",
  });
  const rename = await api("PUT", "/api/payroll-deductions/categories", { cookie: owner.cookie,
    body: { id: cat.id, name: `Staff Welfare Updated ${suffix()}`, reason: "Renamed optional scheme" } });
  await expectStatus(rename, 200, "Rename custom category");
  const list = await api("GET", `/api/payroll-deductions?workerId=${worker.id}`, { cookie: owner.cookie });
  assert.equal(list.data.rows[0].deduction.categoryName, cat.name, "Proposal keeps its original name for audit");
  assert.equal(list.data.rows[0].deduction.id, custom.id);
  const reviewer = await createStaff(owner.cookie, { name: `Custom Category Reviewer ${suffix()}`, role: "OWNER" });
  assert.equal((await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { id: custom.id, action: "APPROVE", reason: "Cannot approve the category I created" } })).status, 403);
  await approveCase(reviewer.cookie, custom.id);
  await expectStatus(await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: worker.id, month: previous() } }), 201, "Post custom deduction without changing its original name");
  assert.equal((await rowFor(owner.cookie, worker.id)).deductionItems[0].categoryName, cat.name);
  await expectStatus(await api("PUT", "/api/payroll-deductions/categories", { cookie: owner.cookie,
    body: { id: cat.id, active: false, reason: "Scheme closed to new members" } }), 200, "Retire category");
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...proposal(worker.id, `CUSTOM:${cat.id}`, 1_000), reference: `NEXT-${suffix()}` } })).status, 404);
});

test("percentage rounding, recurring rent, one-time occasion and fixed savings appear on salary and cooperative ledger once", async () => {
  const owner = await createOwner();
  const worker = await salary(owner.cookie, 100_100);
  const pct = await newCase(owner.cookie, { ...proposal(worker.id, "HOUSE_RENT", 1_000),
    description: "Agreed monthly rent percentage of salary",
    reference: `RENT-${suffix()}`, method: "PERCENT", rateBps: 250, basis: "SALARY", frequencyMonths: 1, endMonth: currentMonth() });
  const coop = await newCase(owner.cookie, { ...proposal(worker.id, "COOPERATIVE", 10_000),
    reference: `COOP-${suffix()}`, description: "Voluntary savings into approved cooperative" });
  const occasion = await newCase(owner.cookie, { ...proposal(worker.id, "STAFF_OCCASION", 1_000),
    reference: `OCC-${suffix()}`, description: "Voluntary clothing for staff annual occasion" });
  for (const d of [pct, coop, occasion]) await approveCase(owner.cookie, d.id);
  const before = await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker.id}`, { cookie: owner.cookie });
  await expectStatus(before, 200, "Cooperative before posting");
  assert.equal(before.data.balance, 0, "A preview is NOT a savings credit");
  const preview = await rowFor(owner.cookie, worker.id);
  assert.equal(preview.deductionItems.find((line: any) => line.deductionId === pct.id).amount, 2_503,
    "2.5% of ₦100,100 rounds once to ₦2,503");
  assert.equal(preview.due, 86_597);
  const posted = await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: worker.id, month: previous() } });
  await expectStatus(posted, 201, "Post savings/monthly rent/occasion");
  const after = await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker.id}`, { cookie: owner.cookie });
  assert.equal(after.data.balance, 10_000);
  assert.equal(after.data.transactions.length, 1);
  assert.equal(after.data.transactions[0].line.cooperativeCredit, 10_000);
  assert.equal((await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: worker.id, month: previous() } })).status, 409);
  const again = await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker.id}`, { cookie: owner.cookie });
  assert.equal(again.data.balance, 10_000, "Retry never credits twice");
  const future = await rowFor(owner.cookie, worker.id, currentMonth());
  assert.deepEqual(future.deductionItems.map((l: any) => l.deductionId), [pct.id], "Only monthly rent repeats this month");
  assert.equal(future.due, 97_597);
  const report = await api("GET", `/api/payroll-deductions?view=report&month=${previous()}&workerId=${worker.id}`, { cookie: owner.cookie });
  await expectStatus(report, 200, "Posted report");
  assert.equal(report.data.rows.length, 3);
  assert.equal(report.data.byCategory.find((g: any) => g.label === "COOPERATIVE").cooperativeCredit, 10_000);
  assert.equal(report.data.rows[0].department, "Operations");
});

test("two-person approval and tax assessment are required; PAYE cannot be faked as a flat rate or backdated to old law", async () => {
  const owner = await createOwner();
  const reviewer = await createStaff(owner.cookie, { name: `Second Owner ${suffix()}`, role: "OWNER" });
  const worker = await salary(owner.cookie, 100_000);
  const input = { workerId: worker.id, categoryCode: "STATUTORY_TAX", description: "Annual PAYE assessment under NTA 2025",
    method: "PAYE_2026", frequencyMonths: 1, startMonth: previous(), endMonth: "2026-12",
    reference: `TAX-${suffix()}`, lateReason: "Tax assessment filed before settling last month", evidenceRef: "PIT-SIGNED-2026",
    annualGross: 3_100_000, annualPension: 100_000, annualNhf: 0, annualNhis: 0, annualRentPaid: 1_000_000, annualOtherRelief: 0 };
  if (!previous().startsWith("2026-")) return; // calendar-specific rule, no old-law rate is invented
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...input, method: "PERCENT", rateBps: 2000 } })).status, 400);
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...input, startMonth: "2025-12", endMonth: "2025-12" } })).status, 409);
  const tax = await newCase(owner.cookie, input);
  assert.equal((await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { id: tax.id, action: "APPROVE", reason: "Signed tax computation verified" } })).status, 403);
  await approveCase(reviewer.cookie, tax.id);
  const preview = await rowFor(owner.cookie, worker.id);
  assert.equal(preview.taxDeduction, 25_000);
  assert.equal(preview.due, 75_000);
  await expectStatus(await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: worker.id, month: previous() } }), 201, "Post separately assessed PAYE");
  assert.equal((await rowFor(owner.cookie, worker.id)).due, 75_000);
  const audit = await api("GET", `/api/payroll-deductions?view=audit&entityType=DEDUCTION&entityId=${tax.id}`, { cookie: owner.cookie });
  assert.deepEqual(audit.data.rows.map((a: any) => a.action), ["APPROVE", "CREATE"]);
  assert.match(audit.data.rows[0].actorName, /^Second Owner /);
  assert.equal(audit.data.rows[1].actorName, "Test Owner");
});


test("attendance records distinguish present, paid/approved leave, unpaid leave and unauthorized absence; only explicit unpaid days affect salary", async () => {
  const owner = await createOwner();
  const reviewer = await createStaff(owner.cookie, { name: `Independent Leave Reviewer ${suffix()}`, role: "OWNER" });
  const person = await salary(owner.cookie, 90_000);
  const statuses = ["PRESENT", "APPROVED_LEAVE", "PAID_LEAVE", "OTHER", "UNPAID_LEAVE", "UNAUTHORIZED_ABSENCE"];
  const days: any[] = [];
  for (const [index, status] of statuses.entries()) {
    const day = `${previous()}-${String(index + 1).padStart(2, "0")}`;
    const result = await api("POST", "/api/payroll-deductions/attendance", { cookie: owner.cookie, body: {
      workerId: person.id, day, status, reason: `Verified ${status.toLowerCase()} recorded`, evidenceRef: `LEAVE-DOC-${suffix()}`,
    } });
    days.push(await expectStatus(result, 201, `Record ${status}`));
  }
  assert.equal((await rowFor(owner.cookie, person.id)).due, 90_000, "Attendance alone never docks pay");
  const draft = (attendanceId: number, ref: string) => ({
    workerId: person.id, categoryCode: "ABSENCE", method: "ATTENDANCE", attendanceId, workingDays: 30,
    description: "Verified unpaid absence for one recorded day", startMonth: previous(), reference: ref,
    lateReason: "Unpaid day reviewed before last month payroll closure", evidenceRef: "POLICY-WORKDAYS-30",
  });
  for (const paid of days.slice(0, 4)) {
    const denied = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: draft(paid.id, `NOT-DUE-${suffix()}`) });
    assert.equal(denied.status, 400, `No automatic charge for ${paid.status}`);
  }
  const unpaid = await newCase(owner.cookie, draft(days[4].id, `UNPAID-${suffix()}`));
  const unauthorized = await newCase(owner.cookie, draft(days[5].id, `UNAUTH-${suffix()}`));
  assert.equal((await rowFor(owner.cookie, person.id)).due, 90_000, "Still drafts");
  assert.equal((await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { id: unpaid.id, action: "APPROVE", reason: "I prepared this attendance case" } })).status, 403);
  await approveCase(reviewer.cookie, unpaid.id);
  await approveCase(reviewer.cookie, unauthorized.id);
  const preview = await rowFor(owner.cookie, person.id);
  assert.equal(preview.deductionItems.length, 2);
  assert.equal(preview.due, 84_000, "Two explicitly unpaid days × ₦3,000 daily salary equivalent");
  assert.equal((await api("PUT", "/api/payroll-deductions/attendance", { cookie: owner.cookie,
    body: { id: days[4].id, status: "PAID_LEAVE", reason: "Try to erase approved unpaid day", evidenceRef: "CORRECTION-DOC" } })).status, 409,
  "Approved deduction preserves the attendance evidence until cancelled");
  await expectStatus(await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: person.id, month: previous() } }), 201, "Post two unpaid days");
  assert.equal((await rowFor(owner.cookie, person.id)).due, 84_000);
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: draft(days[4].id, `DUP-DAY-${suffix()}`) })).status, 409, "Same day cannot be docked twice");
});

async function inspectedPiecework(owner: string, person: { id: number; name: string }, rate = 300, approved = 8, rejected = 2) {
  const login = await createStaff(owner, { name: person.name, role: "WORKER" });
  const order = await createOrder(owner, { quantity: approved + rejected });
  const batch = await api("POST", "/api/batches", { cookie: owner, body: {
    orderId: order.orderId, orderItemId: order.itemId, quantity: approved + rejected,
    workerId: person.id, cuttingRate: rate,
  } });
  await expectStatus(batch, 201, "Create cutter job");
  const jobs = await api("GET", `/api/operations?batchId=${batch.data.id}`, { cookie: owner });
  const op = jobs.data.find((j: any) => j.stage === "CUTTING");
  await expectStatus(await api("PUT", "/api/operations", { cookie: login.cookie,
    body: { id: op.id, submitQty: approved + rejected } }), 200, "Submit approved + rejected work");
  await expectStatus(await api("POST", "/api/inspections", { cookie: owner, body: {
    operationId: op.id, quantityApproved: approved, quantityRejected: rejected, notes: "Rejected garments inspected separately",
  } }), 201, "Inspect and reject marked garments");
  const [inspection] = await db.select().from(stageInspections).where(eq(stageInspections.productionOperationId, op.id));
  assert.ok(inspection);
  return { op, inspection };
}

test("a rejected garment never automatically creates a damage debt; verified net loss is a separate approved case", async () => {
  const owner = await createOwner();
  const reviewer = await createStaff(owner.cookie, { name: `Damage Reviewer ${suffix()}`, role: "OWNER" });
  const tailor = await createWorker(owner.cookie, { name: `Cutter ${suffix()}`, specialty: "Cutter", paymentType: "PER_PIECE" });
  const other = await salary(owner.cookie, 50_000);
  const { inspection } = await inspectedPiecework(owner.cookie, tailor);
  const incidents = await api("GET", `/api/payroll-deductions/incidents?workerId=${tailor.id}`, { cookie: owner.cookie });
  await expectStatus(incidents, 200, "Scoped rejected-inspection picker");
  assert.ok(incidents.data.rows.some((row: any) => row.source === "STAGE" && row.id === inspection.id && row.quantityRejected === 2));
  // In-memory fixture only: this inspection was performed during last month's
  // completed production period. No production record is changed outside pg-mem.
  await db.update(stageInspections).set({ inspectedAt: new Date(`${previous()}-15T12:00:00Z`) })
    .where(eq(stageInspections.id, inspection.id));
  const before = await rowFor(owner.cookie, tailor.id);
  assert.equal(before.piecework, 8 * 300, "Only approved pieces were earned; rejected 2 × ₦300 already excluded");
  assert.equal(before.due, 2_400, "No automatic second charge for failed inspection");
  const caseBody = { workerId: tailor.id, categoryCode: "DAMAGE", description: "Proven additional repair cost due to established neglect",
    method: "FIXED", amount: 300, startMonth: previous(), reference: `LOSS-${suffix()}`,
    lateReason: "Case reviewed before closing the previous payroll month",
    incidentInspectionId: inspection.id, incidentQuantity: 2, incidentLossAmount: 400,
    authorityRef: "LABOUR-OFFICER-WRITTEN-001", evidenceRef: "COST-REPAIR-INVOICE-001",
    incidentFindings: "Witness evidence establishes wilful neglect beyond ordinary rework",
    incidentLossBasis: "Net repair cost four hundred naira after excluding unpaid rejected pieces and insurance",
  };
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...caseBody, incidentQuantity: 3 } })).status, 404, "Cannot attribute more than rejected pieces");
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...caseBody, authorityRef: "" } })).status, 400, "No labour-officer approval, no charge");
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...caseBody, amount: 700 } })).status, 400, "No double recovery over net loss");
  const damage = await newCase(owner.cookie, caseBody);
  assert.equal((await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { id: damage.id, action: "APPROVE", reason: "Self-approved fine attempt" } })).status, 403);
  await approveCase(reviewer.cookie, damage.id);
  const preview = await rowFor(owner.cookie, tailor.id);
  assert.equal(preview.due, 2_100, "Separate charge, capped by net loss and wages");
  assert.equal((await rowFor(owner.cookie, other.id)).due, 50_000, "Another worker's wages untouched");
  await expectStatus(await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: tailor.id, month: previous() } }), 201, "Post independently approved loss");
  const [unchanged] = await db.select().from(stageInspections).where(eq(stageInspections.id, inspection.id));
  assert.equal(unchanged.quantityRejected, 2, "Original inspection audit trail stays intact");
  assert.equal(unchanged.quantityApproved, 8);
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...caseBody, reference: `DUP-LOSS-${suffix()}` } })).status, 409, "One damage claim per inspection and responsible worker");
});

test("rejected support-work pieces need a separate proven, reviewed damage case tied to their helper", async () => {
  const owner = await createOwner();
  const reviewer = await createStaff(owner.cookie, { name: `Support Damage Reviewer ${suffix()}`, role: "OWNER" });
  const tailor = await createWorker(owner.cookie, { name: `Tailor ${suffix()}`, specialty: "Tailor" });
  const helper = await createWorker(owner.cookie, { name: `Helper ${suffix()}`, specialty: SUPPORT_ROLE, roles: [SUPPORT_ROLE] });
  const other = await salary(owner.cookie, 50_000);
  const tailorLogin = await createStaff(owner.cookie, { name: tailor.name, role: "WORKER" });
  const helperLogin = await createStaff(owner.cookie, { name: helper.name, role: "WORKER" });
  const order = await createOrder(owner.cookie, { quantity: 8 });
  const batch = await api("POST", "/api/batches", { cookie: owner.cookie, body: {
    orderId: order.orderId, orderItemId: order.itemId, quantity: 8,
    stages: [{ stage: "SEWING" }], assignments: [{ stage: "SEWING", workerId: tailor.id, pieceRate: 300 }],
  } });
  await expectStatus(batch, 201, "Create garment sewing work");
  const jobs = await api("GET", `/api/operations?batchId=${batch.data.id}`, { cookie: owner.cookie });
  const sewing = jobs.data.find((job: any) => job.stage === "SEWING");
  const assigned = await api("POST", "/api/support-work", { cookie: tailorLogin.cookie, body: {
    workerId: helper.id, operation: "Weaving", quantityAssigned: 8, pieceRate: 100,
    productionOperationId: sewing.id,
  } });
  await expectStatus(assigned, 201, "Assign support work on these garments");
  await startSupport(helperLogin.cookie, assigned.data.id);
  await expectStatus(await api("PUT", "/api/support-work", { cookie: helperLogin.cookie,
    body: { id: assigned.data.id, submitQty: 8 } }), 200, "Submit helper's work");
  const inspected = await api("PUT", "/api/support-work", { cookie: owner.cookie, body: {
    id: assigned.data.id, quantityApproved: 6, quantityRework: 0, quantityRejected: 2,
    notes: "Two separately rejected support-work garments; ordinary rejection is not a fine",
  } });
  await expectStatus(inspected, 201, "Inspect approved and rejected support pieces");
  const inspectionId = inspected.data.id;
  await db.update(supportInspections).set({ inspectedAt: new Date(`${previous()}-15T12:00:00Z`) })
    .where(eq(supportInspections.id, inspectionId)); // Isolated pg-mem fixture only.
  const picker = await api("GET", `/api/payroll-deductions/incidents?workerId=${helper.id}`, { cookie: owner.cookie });
  await expectStatus(picker, 200, "Owner's worker-scoped evidence picker");
  assert.ok(picker.data.rows.some((row: any) => row.source === "SUPPORT" && row.id === inspectionId &&
    row.quantityRejected === 2 && row.operation === "Weaving"));
  assert.equal((await api("GET", `/api/payroll-deductions/incidents?workerId=${other.id}`, { cookie: owner.cookie }))
    .data.rows.some((row: any) => row.source === "SUPPORT" && row.id === inspectionId), false);
  const before = await rowFor(owner.cookie, helper.id);
  assert.equal(before.supportPiecework, 600, "Six approved helper pieces earned pay; two rejected pieces did not");
  assert.equal(before.due, 600, "No automatic charge on rejected support work");
  const terms = { workerId: helper.id, categoryCode: "DAMAGE", method: "FIXED", amount: 150,
    description: "Separately evidenced net garment loss beyond rejected helper earnings",
    startMonth: previous(), lateReason: "Evidence reviewed before closing unpaid payroll",
    reference: `SUPPORT-LOSS-${suffix()}`, incidentSupportInspectionId: inspectionId,
    incidentQuantity: 2, incidentLossAmount: 180,
    incidentFindings: "Witnesses documented wilful neglect rather than an ordinary quality rejection",
    incidentLossBasis: "Net repair costs after withholding earnings for the two rejected support pieces",
    authorityRef: "PRIOR-LABOUR-OFFICER-WRITTEN-SUPPORT-001", evidenceRef: "SUPPORT-REPAIR-COST-001",
  };
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...terms, incidentInspectionId: inspectionId } })).status, 400, "Cannot link two inspection sources");
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...terms, frequencyMonths: 1, endMonth: shiftMonth(currentMonth(), 2) } })).status, 400,
  "A recurring damage request could charge the same net loss indefinitely");
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...terms, incidentQuantity: 3 } })).status, 404, "Cannot charge more support pieces than rejected");
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...terms, workerId: other.id } })).status, 404, "Another worker is not liable for this inspection");
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...terms, authorityRef: "" } })).status, 400, "Requires prior labour-officer authorisation");
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...terms, amount: 200 } })).status, 400, "Cannot recover more than proven additional net loss");
  const charge = await newCase(owner.cookie, terms);
  assert.equal(charge.incidentSupportInspectionId, inspectionId);
  assert.equal(charge.incidentInspectionId, null);
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...terms, reference: `DUP-SUPPORT-LOSS-${suffix()}` } })).status, 409);
  assert.equal((await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { id: charge.id, action: "APPROVE", reason: "Cannot approve my own support case" } })).status, 403);
  await approveCase(reviewer.cookie, charge.id);
  assert.equal((await rowFor(owner.cookie, helper.id)).due, 450);
  assert.equal((await rowFor(owner.cookie, other.id)).due, 50_000);
  await expectStatus(await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: helper.id, month: previous() } }), 201, "Post independently approved helper damage charge");
  const [unchanged] = await db.select().from(supportInspections).where(eq(supportInspections.id, inspectionId));
  assert.equal(unchanged.quantityApproved, 6);
  assert.equal(unchanged.quantityRejected, 2, "Posting cannot change support-work inspection evidence");
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...terms, reference: `POSTED-SUPPORT-LOSS-${suffix()}` } })).status, 409,
  "A posted support incident cannot be charged again");
});

test("HYBRID earns salary AND approved piecework without modifying existing MONTHLY/PER_PIECE payroll rules", async () => {
  const owner = await createOwner();
  const hybrid = await createWorker(owner.cookie, { name: `Mixed Cutter ${suffix()}`, specialty: "Cutter", paymentType: "HYBRID", paymentRate: 50_000 });
  const regular = await salary(owner.cookie, 70_000);
  const { inspection } = await inspectedPiecework(owner.cookie, hybrid, 300, 5, 5);
  const before = await rowFor(owner.cookie, hybrid.id, currentMonth());
  assert.equal(before.salary, 50_000);
  assert.equal(before.piecework, 1_500);
  assert.equal(before.gross, 51_500);
  assert.equal((await rowFor(owner.cookie, regular.id, currentMonth())).due, 70_000);
  const coop = await newCase(owner.cookie, { ...proposal(hybrid.id, "COOPERATIVE", 2_000),
    startMonth: currentMonth(), lateReason: "", reference: `HYBRID-${suffix()}` });
  await approveCase(owner.cookie, coop.id);
  const preview = await rowFor(owner.cookie, hybrid.id, currentMonth());
  assert.equal(preview.due, 49_500);
  assert.equal((await rowFor(owner.cookie, regular.id, currentMonth())).due, 70_000);
  const [original] = await db.select().from(stageInspections).where(eq(stageInspections.id, inspection.id));
  assert.equal(original.quantityApproved, 5, "Deduction did not mutate approved production");
});

test("a support worker is paid on approved support pieces only; an ordinary deduction cannot tap unapproved or another worker's earnings", async () => {
  const owner = await createOwner();
  const tailor = await createWorker(owner.cookie, { name: `Support Tailor ${suffix()}`, specialty: "Tailor" });
  const helper = await createWorker(owner.cookie, { name: `Support Helper ${suffix()}`, specialty: SUPPORT_ROLE, roles: [SUPPORT_ROLE] });
  const tailorLogin = await createStaff(owner.cookie, { name: tailor.name, role: "WORKER" });
  const helperLogin = await createStaff(owner.cookie, { name: helper.name, role: "WORKER" });
  const order = await createOrder(owner.cookie, { quantity: 10 });
  const batch = await api("POST", "/api/batches", { cookie: owner.cookie, body: {
    orderId: order.orderId, orderItemId: order.itemId, quantity: 10,
    stages: [{ stage: "SEWING" }], assignments: [{ stage: "SEWING", workerId: tailor.id, pieceRate: 300 }],
  } });
  await expectStatus(batch, 201, "Give tailor genuine sewing work");
  const jobs = await api("GET", `/api/operations?batchId=${batch.data.id}`, { cookie: owner.cookie });
  const sewing = jobs.data.find((j: any) => j.stage === "SEWING");
  const assignment = await api("POST", "/api/support-work", { cookie: tailorLogin.cookie, body: {
    workerId: helper.id, operation: "Weaving", quantityAssigned: 3, pieceRate: 100, productionOperationId: sewing.id,
  } });
  await expectStatus(assignment, 201, "Delegate work at agreed support rate");
  await startSupport(helperLogin.cookie, assignment.data.id);
  await expectStatus(await api("PUT", "/api/support-work", { cookie: helperLogin.cookie,
    body: { id: assignment.data.id, submitQty: 3 } }), 200, "Submit three support pieces");
  const savings = await newCase(owner.cookie, { ...proposal(helper.id, "COOPERATIVE", 50),
    startMonth: currentMonth(), lateReason: "", reference: `SUPPORT-${suffix()}` });
  await approveCase(owner.cookie, savings.id);
  assert.equal((await rowFor(owner.cookie, helper.id, currentMonth())).supportPiecework, 0);
  assert.equal((await rowFor(owner.cookie, helper.id, currentMonth())).previewIssues.length > 0, true,
    "Savings cannot come out of zero/unapproved support work");
  await expectStatus(await api("PUT", "/api/support-work", { cookie: owner.cookie, body: {
    id: assignment.data.id, quantityApproved: 3, quantityRework: 0, quantityRejected: 0,
  } }), 201, "Owner approves actual support work");
  const earned = await rowFor(owner.cookie, helper.id, currentMonth());
  assert.equal(earned.supportPiecework, 300);
  assert.equal(earned.due, 250);
  assert.equal((await rowFor(owner.cookie, tailor.id, currentMonth())).supportDeductionOwed, 300,
    "Delegated support shares are not charged to the helper twice");
  const checks = await db.select().from(supportInspections).where(eq(supportInspections.supportAssignmentId, assignment.data.id));
  assert.equal(checks.length, 1, "Inspection trail untouched by ordinary deductions");
});

test("variable one-time corrections need a second Owner; cancellation before posting restores unchanged earnings", async () => {
  const owner = await createOwner();
  const reviewer = await createStaff(owner.cookie, { name: `Variable Reviewer ${suffix()}`, role: "OWNER" });
  const worker = await salary(owner.cookie);
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...proposal(worker.id, "STAFF_OCCASION", 2_000), method: "VARIABLE", frequencyMonths: 1 } })).status, 400);
  const variable = await newCase(owner.cookie, { ...proposal(worker.id, "STAFF_OCCASION", 2_000),
    method: "VARIABLE", description: "One time variable staff outing contribution" });
  assert.equal((await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { id: variable.id, action: "APPROVE", reason: "Self approve attempt" } })).status, 403);
  await approveCase(reviewer.cookie, variable.id);
  assert.equal((await rowFor(owner.cookie, worker.id)).due, 88_000);
  await expectStatus(await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { id: variable.id, action: "CANCEL", reason: "Worker withdrew voluntary consent before posting" } }), 200, "Cancel unposted variable case");
  assert.equal((await rowFor(owner.cookie, worker.id)).due, 90_000);
  const history = await api("GET", `/api/payroll-deductions?view=audit&entityType=DEDUCTION&entityId=${variable.id}`, { cookie: owner.cookie });
  assert.deepEqual(history.data.rows.map((r: any) => r.action), ["CANCEL", "APPROVE", "CREATE"]);
});

test("bulk IDs, department, employment category and all eligible workers create individual proposals and require individual consent", async () => {
  const owner = await createOwner();
  const department = `Studio-${suffix()}`;
  const w1 = await salary(owner.cookie, 80_000, department);
  const w2 = await salary(owner.cookie, 80_000, department);
  const others = await salary(owner.cookie, 80_000, `Other-${suffix()}`);
  const base = { categoryCode: "STAFF_OCCASION", description: `Voluntary staff occasion ${suffix()}`,
    method: "FIXED", amount: 2_000, startMonth: previous(), lateReason: "Agreed before closing staff event payroll",
    authorityRef: "DOCUMENTED-STAFF-EVENT-RULE", reference: `BULK-${suffix()}` };
  const ids = { type: "IDS", workerIds: [w1.id, w2.id] };
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...base, selection: ids, consentRef: "ONE-SHARED-CONSENT", consentOn: today() } })).status, 400,
  "A single blanket consent cannot authorize two people");
  const consents = [w1, w2].map((w) => ({ workerId: w.id, consentRef: `SIGNED-${w.id}-${suffix()}`, consentOn: `${previous()}-02` }));
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    ...base, selection: ids, consents: consents.map((item) => ({ ...item, consentRef: "ONE-COPIED-REFERENCE" })),
  } })).status, 400, "Copying one reference across all selected workers is not individual consent");
  const created = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...base, selection: ids, consents } });
  await expectStatus(created, 201, "Bulk with distinct written consent");
  assert.deepEqual(created.data.created.map((r: any) => r.workerId).sort(), [w1.id, w2.id].sort());
  assert.notEqual(created.data.created[0].consentRef, created.data.created[1].consentRef);
  await approveCase(owner.cookie, created.data.created[0].id);
  assert.equal((await rowFor(owner.cookie, w1.id)).due, 78_000);
  assert.equal((await rowFor(owner.cookie, w2.id)).due, 80_000, "Other worker's pending case cannot affect pay");
  assert.equal((await rowFor(owner.cookie, others.id)).due, 80_000);

  const dept = await api("GET", `/api/payroll-deductions/workers?view=eligible&type=DEPARTMENT&department=${encodeURIComponent(department)}`, { cookie: owner.cookie });
  assert.deepEqual(dept.data.rows.map((r: any) => r.id).sort(), [w1.id, w2.id].sort());
  const categorical = await api("GET", "/api/payroll-deductions/workers?view=eligible&type=EMPLOYMENT_CATEGORY&category=Salaried%20%2F%20Non-Production%20Staff", { cookie: owner.cookie });
  assert.equal(categorical.data.rows.some((r: any) => r.id === w1.id), true);
  const picker = await api("GET", `/api/payroll-deductions/workers?search=${encodeURIComponent(w1.name)}&limit=20`, { cookie: owner.cookie });
  await expectStatus(picker, 200, "Paginated worker picker");
  assert.ok(picker.data.rows.some((r: any) => r.id === w1.id));
  const departmentBody = { ...base, reference: `DEPT-${suffix()}`, description: `Cooperative department ${suffix()}`,
    categoryCode: "COOPERATIVE", startMonth: shiftMonth(currentMonth(), 1), lateReason: "",
    selection: { type: "DEPARTMENT", department }, consents };
  const group = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: departmentBody });
  await expectStatus(group, 201, "Department selection creates two traceable rows");
  assert.equal(group.data.count, 2);
  const all = await api("GET", "/api/payroll-deductions/workers?view=eligible&type=ALL", { cookie: owner.cookie });
  await expectStatus(all, 200, "Server-side all eligible preview (bounded)");
  assert.ok(all.data.count >= 3);
  const allCase = await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: {
    ...base, description: `All worker one-time contribution ${suffix()}`, reference: `ALL-${suffix()}`,
    startMonth: shiftMonth(currentMonth(), 2), lateReason: "", selection: { type: "ALL" },
    consents: all.data.rows.map((r: any) => ({ workerId: r.id, consentRef: `SIGNED-ALL-${r.id}-${suffix()}`, consentOn: today() })),
  } });
  await expectStatus(allCase, 201, "All eligible explicitly documented worker by worker");
  assert.equal(allCase.data.count, all.data.count);
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...base, selection: { type: "IDS", workerIds: [w1.id, w1.id] }, consents } })).status, 400);
});

test("legally available pay, one-third ceiling, tax+company combination, and already-paid periods cannot be bypassed by direct requests", async () => {
  const owner = await createOwner();
  const reviewer = await createStaff(owner.cookie, { name: `Limit Reviewer ${suffix()}`, role: "OWNER" });
  const worker = await salary(owner.cookie, 90_000);
  const big = await newCase(owner.cookie, { ...proposal(worker.id, "HOUSE_RENT", 40_000), reference: `LIMIT-${suffix()}` });
  await approveCase(owner.cookie, big.id);
  const preview = await rowFor(owner.cookie, worker.id);
  assert.equal(preview.due, 90_000, "Illegal preview does not reduce displayed payable amount");
  assert.match(preview.previewIssues.join(" "), /one-third/);
  assert.equal((await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: worker.id, month: previous() } })).status, 409);
  await expectStatus(await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { id: big.id, action: "CANCEL", reason: "Exceeded legal one-third ceiling" } }), 200, "Remove unsafe proposal");
  const tax = await newCase(owner.cookie, { workerId: worker.id, categoryCode: "STATUTORY_TAX",
    description: "Assessed annual PAYE with signed review", method: "PAYE_2026", frequencyMonths: 1,
    startMonth: previous(), endMonth: "2026-12", lateReason: "Assessment completed before payroll closure",
    reference: `TAXCAP-${suffix()}`, evidenceRef: "PAYE-ASSESSMENT-SIGNED",
    annualGross: 3_000_000, annualPension: 0, annualNhf: 0, annualNhis: 0, annualRentPaid: 0, annualOtherRelief: 0,
  });
  await approveCase(reviewer.cookie, tax.id);
  const comp = await newCase(owner.cookie, { ...proposal(worker.id, "COOPERATIVE", 10_000),
    description: "Additional voluntary cooperative saving contribution", reference: `COOPCAP-${suffix()}` });
  await approveCase(owner.cookie, comp.id);
  const combined = await rowFor(owner.cookie, worker.id);
  assert.equal(combined.taxDeduction, 0, "Over-cap preview is not applied to pay");
  assert.match(combined.previewIssues.join(" "), /one-third/);
  assert.equal((await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: worker.id, month: previous() } })).status, 409);
  assert.equal((await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker.id}`, { cookie: owner.cookie })).data.balance, 0);
  await expectStatus(await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { id: comp.id, action: "CANCEL", reason: "Combined with PAYE it exceeds legal ceiling" } }), 200, "Cancel over-cap saving");
  const settled = await api("POST", "/api/payroll", { cookie: owner.cookie, body: {
    workerId: worker.id, amount: 1_000, periodMonth: previous(), idempotencyKey: `PAID-${suffix()}`,
  } });
  assert.equal(settled.status, 409, "An approved tax assessment must be posted before payment");
  await expectStatus(await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: worker.id, month: previous() } }), 201, "Post compliant PAYE only");
  assert.equal((await rowFor(owner.cookie, worker.id)).due, 62_500, "₦27,500 PAYE is not a flat percentage");
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...proposal(worker.id, "HOUSE_RENT", 1_000), reference: `POSTPAID-${suffix()}` } })).status, 409,
  "No new proposal can rewrite a posted worker-month");
});


test("an evidenced minimum-wage PAYE assessment posts zero without assuming every worker has the same tax", async () => {
  const owner = await createOwner();
  const reviewer = await createStaff(owner.cookie, { name: `Tax Reviewer ${suffix()}`, role: "OWNER" });
  const worker = await salary(owner.cookie, 70_000);
  const p = { workerId: worker.id, categoryCode: "STATUTORY_TAX", method: "PAYE_2026",
    description: "Signed 2026 minimum-wage PAYE exemption", reference: `WAGE-TAX-${suffix()}`,
    frequencyMonths: 1, startMonth: previous(), endMonth: "2026-12", evidenceRef: "SIGNED-MIN-WAGE-DECLARATION",
    lateReason: "Reviewed signed tax exemption before last month closure", annualGross: 840_000,
    annualPension: 0, annualNhf: 0, annualNhis: 0, annualRentPaid: 0, annualOtherRelief: 0,
    minimumWageExempt: true };
  const d = await newCase(owner.cookie, p);
  await approveCase(reviewer.cookie, d.id);
  const row = await rowFor(owner.cookie, worker.id);
  assert.equal(row.deductionItems[0].amount, 0);
  assert.equal(row.due, 70_000);
  await expectStatus(await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: worker.id, month: previous() } }), 201, "Post evidenced zero tax");
  assert.equal((await rowFor(owner.cookie, worker.id)).deductionItems[0].calculation.includes("minimum-wage exemption"), true);
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...p, reference: `WAGE-TAX-OTHER-${suffix()}`, startMonth: currentMonth(), endMonth: "2026-12", lateReason: "" } })).status, 409,
  "Overlapping tax assessments cannot withhold twice");
});

test("posted cooperative savings can be refunded only by independently approved next-month compensating entries; balance and history stay consistent", async () => {
  const owner = await createOwner();
  const reviewer = await createStaff(owner.cookie, { name: `Reversal Reviewer ${suffix()}`, role: "OWNER" });
  const worker = await salary(owner.cookie, 90_000);
  const saving = await newCase(owner.cookie, { ...proposal(worker.id, "COOPERATIVE", 10_000),
    description: "Voluntary contribution requiring correction", reference: `REV-COOP-${suffix()}` });
  await approveCase(owner.cookie, saving.id);
  await expectStatus(await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: worker.id, month: previous() } }), 201, "Post cooperative credit");
  const balance = await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker.id}`, { cookie: owner.cookie });
  assert.equal(balance.data.balance, 10_000);
  const line = balance.data.transactions[0].line;
  assert.equal((await api("POST", "/api/payroll-deductions/reversals", { cookie: owner.cookie,
    body: { sourceLineId: line.id, targetMonth: previous(), reason: "Try to change already posted historical period" } })).status, 409);
  const request = await api("POST", "/api/payroll-deductions/reversals", { cookie: owner.cookie,
    body: { sourceLineId: line.id, targetMonth: currentMonth(), reason: "Worker provided evidence the cooperative consent was withdrawn" } });
  await expectStatus(request, 201, "Request future compensating refund");
  assert.equal((await api("POST", "/api/payroll-deductions/reversals", { cookie: owner.cookie,
    body: { sourceLineId: line.id, targetMonth: currentMonth(), reason: "Attempt to refund again with duplicate transaction" } })).status, 409);
  assert.equal((await api("PUT", "/api/payroll-deductions/reversals", { cookie: owner.cookie,
    body: { id: request.data.id, action: "APPROVE", reason: "Self approval of own refund request" } })).status, 403);
  await expectStatus(await api("PUT", "/api/payroll-deductions/reversals", { cookie: reviewer.cookie,
    body: { id: request.data.id, action: "APPROVE", reason: "Independently reviewed signed worker dispute and original line" } }), 200, "Independent reviewer approves refund");
  const preview = await rowFor(owner.cookie, worker.id, currentMonth());
  assert.equal(preview.due, 100_000, "Refund increases this month's pay; original month is untouched");
  assert.equal(preview.deductionItems[0].amount, -10_000);
  assert.equal((await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker.id}`, { cookie: owner.cookie })).data.balance, 10_000,
    "Not yet posted: still owed by the cooperative");
  assert.equal((await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: worker.id, month: currentMonth() } })).status, 409,
  "Open month cannot be frozen by refund request");

  // Advance only the isolated test clock to the FIRST DAY OF NEXT MONTH so the
  // current payroll becomes a closed month. Session validity is explicitly
  // extended in pg-mem; never touches production or inserts fake financial data.
  const closingMonth = currentMonth();
  await db.update(sessions).set({ expiresAt: new Date(`${shiftMonth(closingMonth, 3)}-01T00:00:00Z`) });
  mock.timers.enable({ apis: ["Date"], now: new Date(`${shiftMonth(closingMonth, 1)}-01T00:00:00Z`) });
  try {
    await expectStatus(await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
      body: { workerId: worker.id, month: closingMonth } }), 201, "Post next-period refund");
    const returned = await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker.id}`, { cookie: owner.cookie });
    assert.equal(returned.data.balance, 0, "Credit and debit reconcile from the same immutable line ledger");
    assert.deepEqual(returned.data.transactions.map((t: any) => t.line.cooperativeCredit).sort((a: number, b: number) => a - b), [-10_000, 10_000]);
    assert.equal((await rowFor(owner.cookie, worker.id, previous())).due, 100_000, "Refund period net is posted");
    const original = await api("GET", `/api/payroll?month=${shiftMonth(closingMonth, -1)}&workerId=${worker.id}`, { cookie: owner.cookie });
    assert.equal(original.data.history.find((h: any) => h.month === shiftMonth(closingMonth, -1)).due, 80_000, "Original period stays posted exactly as it was");
  } finally { mock.timers.reset(); }
});

test("Owner-only backend permissions, forged actors, cross-site mutations and status overrides do not bypass approval", async () => {
  const owner = await createOwner();
  const manager = await createStaff(owner.cookie, { name: `Manager ${suffix()}`, role: "PRODUCTION_MANAGER" });
  const worker = await salary(owner.cookie);
  const login = await createStaff(owner.cookie, { name: worker.name, role: "WORKER" });
  const urls = ["/api/payroll-deductions", "/api/payroll-deductions/categories", "/api/payroll-deductions/attendance",
    "/api/payroll-deductions/cooperative?workerId=1", "/api/payroll-deductions/workers", "/api/payroll-deductions/reversals"];
  for (const path of urls) {
    assert.equal((await api("GET", path)).status, 401, `No session: ${path}`);
    assert.equal((await api("GET", path, { cookie: manager.cookie })).status, 403, `No manager financial read: ${path}`);
    assert.equal((await api("GET", path, { cookie: login.cookie })).status, 403, `No worker financial read: ${path}`);
  }
  const data = proposal(worker.id, "HOUSE_RENT", 2_000);
  for (const cookie of [manager.cookie, login.cookie]) {
    assert.equal((await api("POST", "/api/payroll-deductions", { cookie, body: data })).status, 403);
    assert.equal((await api("POST", "/api/payroll-deductions/post", { cookie,
      body: { workerId: worker.id, month: previous() } })).status, 403);
    assert.equal((await api("PUT", "/api/payroll-deductions", { cookie,
      body: { id: 1, action: "APPROVE", reason: "Forge privilege" } })).status, 403);
  }
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie, body: data,
    headers: { Origin: "https://attacker.invalid" } })).status, 403, "Cross-site writes refused by the existing guard");
  const [created] = (await expectStatus(await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...data, organizationId: 999, status: "APPROVED", approvedByName: "Fake Owner",
      createdById: manager.id, workerId: worker.id, amount: 2_000 } }), 201, "Record forced to server-owned attributes")).created;
  assert.equal(created.status, "PENDING");
  assert.equal(created.organizationId, 1);
  assert.equal(created.approvedByName, null);
  assert.equal(created.createdByName, "Test Owner");
  assert.equal((await rowFor(owner.cookie, worker.id)).due, 90_000, "Forged approval had no effect on payroll");
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...data, reference: `NO-CONSENT-${suffix()}`, consentRef: "" } })).status, 400);
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...data, reference: `INVALID-AMT-${suffix()}`, amount: "Infinity" } })).status, 400);
});

test("all new payroll reads and writes isolate organizations, including single-worker ID enumeration", async () => {
  const owner = await createOwner();
  const own = await salary(owner.cookie, 90_000);
  const org2 = await db.select().from(organizations).where(eq(organizations.id, 2));
  if (!org2.length) await db.insert(organizations).values({ id: 2, name: "Another isolated test company" });
  const email = testEmail("foreign-owner");
  const password = "Foreign!Owner123";
  await db.insert(users).values({ organizationId: 2, name: "Second Company Owner", email,
    passwordHash: hashPassword(password), role: "OWNER", status: "ACTIVE" });
  const foreignCookie = await signIn(email, password);
  const [foreign] = await db.insert(workers).values({ organizationId: 2, name: `Other Company Worker ${suffix()}`,
    specialty: "Office Staff", paymentType: "MONTHLY", paymentRate: 40_000, status: "ACTIVE",
    createdAt: new Date(`${previous()}-01T00:00:00Z`) }).returning();
  const foreignCat = await api("POST", "/api/payroll-deductions/categories", { cookie: foreignCookie,
    body: { name: `Foreign Benefit ${suffix()}` } });
  await expectStatus(foreignCat, 201, "Other company creates its own category");
  const ownList = await api("GET", "/api/payroll-deductions/categories", { cookie: owner.cookie });
  assert.equal(ownList.data.custom.some((c: any) => c.id === foreignCat.data.id), false);
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: proposal(foreign.id, "HOUSE_RENT", 2_000) })).status, 404);
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...proposal(own.id, `CUSTOM:${foreignCat.data.id}`, 2_000), reference: `FOREIGN-CAT-${suffix()}` } })).status, 404);
  assert.equal((await api("GET", `/api/payroll?month=${previous()}&workerId=${foreign.id}`, { cookie: owner.cookie })).status, 404);
  assert.equal((await api("GET", `/api/payroll-deductions/cooperative?workerId=${foreign.id}`, { cookie: owner.cookie })).status, 404);
  assert.equal((await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: foreign.id, month: previous() } })).status, 404);
  assert.equal((await api("POST", "/api/payroll", { cookie: owner.cookie,
    body: { workerId: foreign.id, amount: 1_000, periodMonth: previous() } })).status, 404);
  assert.equal((await api("POST", "/api/payroll-deductions/attendance", { cookie: owner.cookie,
    body: { workerId: foreign.id, day: `${previous()}-05`, status: "UNPAID_LEAVE",
      reason: "Foreign worker document", evidenceRef: "FOREIGN-DOC" } })).status, 404);
  const ownPay = await api("GET", `/api/payroll?month=${previous()}`, { cookie: owner.cookie });
  assert.equal(ownPay.data.workers.some((r: any) => r.workerId === foreign.id), false);
  const foreignPay = await api("GET", `/api/payroll?month=${previous()}`, { cookie: foreignCookie });
  assert.equal(foreignPay.data.workers.some((r: any) => r.workerId === own.id), false);
  assert.equal(foreignPay.data.workers.some((r: any) => r.workerId === foreign.id), true);
});

test("racing post requests still create one statement and one cooperative credit (pg-mem emulation)", async () => {
  const owner = await createOwner();
  const worker = await salary(owner.cookie, 90_000);
  const coop = await newCase(owner.cookie, { ...proposal(worker.id, "COOPERATIVE", 5_000), reference: `RACE-${suffix()}` });
  await approveCase(owner.cookie, coop.id);
  const [one, two] = await Promise.all([
    api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie, body: { workerId: worker.id, month: previous() } }),
    api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie, body: { workerId: worker.id, month: previous() } }),
  ]);
  assert.deepEqual([one.status, two.status].sort(), [201, 409]);
  const ledger = await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker.id}`, { cookie: owner.cookie });
  assert.equal(ledger.data.balance, 5_000);
  assert.equal(ledger.data.total, 1);
  const statements = await db.select().from(payrollStatements).where(and(eq(payrollStatements.workerId, worker.id), eq(payrollStatements.periodMonth, previous())));
  assert.equal(statements.length, 1);
  const booked = await db.select().from(payrollStatementLines).where(eq(payrollStatementLines.statementId, statements[0].id));
  assert.equal(booked.length, 1);
});

test("cancelled, never-posted attendance can be audited/corrected and resubmitted, but the day cannot be recorded or charged twice", async () => {
  const owner = await createOwner();
  const worker = await salary(owner.cookie, 60_000);
  const recorded = await api("POST", "/api/payroll-deductions/attendance", { cookie: owner.cookie, body: {
    workerId: worker.id, day: `${previous()}-02`, status: "UNAUTHORIZED_ABSENCE",
    reason: "First investigation required review", evidenceRef: "INITIAL-FLOOR-JOURNAL",
  } });
  await expectStatus(recorded, 201, "Record one day");
  assert.equal((await api("POST", "/api/payroll-deductions/attendance", { cookie: owner.cookie, body: {
    workerId: worker.id, day: `${previous()}-02`, status: "UNAUTHORIZED_ABSENCE",
    reason: "Try second record for same day", evidenceRef: "DUPLICATE-JOURNAL",
  } })).status, 409);
  const terms = { workerId: worker.id, categoryCode: "ABSENCE", method: "ATTENDANCE", description: "Recorded unauthorized unpaid leave day",
    reference: `DAY-${suffix()}`, attendanceId: recorded.data.id, workingDays: 20,
    startMonth: previous(), lateReason: "Day reviewed before payroll month closed", evidenceRef: "POLICY-20-WORKDAYS" };
  const first = await newCase(owner.cookie, terms);
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { ...terms, reference: `DAY-DOUBLE-${suffix()}` } })).status, 409, "Only one active proposal per actual day");
  await expectStatus(await api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
    body: { id: first.id, action: "CANCEL", reason: "Fact check uncovered an original categorization error" } }), 200, "Cancel before any posting");
  const corrected = await api("PUT", "/api/payroll-deductions/attendance", { cookie: owner.cookie,
    body: { id: recorded.data.id, status: "UNPAID_LEAVE", reason: "Worker confirmed leave was approved but unpaid",
      evidenceRef: "REVISED-LEAVE-REQUEST" } });
  await expectStatus(corrected, 200, "Correct with audit, not a silent overwrite");
  const later = await newCase(owner.cookie, { ...terms, reference: `CORRECTED-DAY-${suffix()}`, description: "Approved but unpaid leave as documented" });
  assert.equal(later.attendanceId, recorded.data.id);
  const trail = await api("GET", `/api/payroll-deductions?view=audit&entityType=ATTENDANCE&entityId=${recorded.data.id}`, { cookie: owner.cookie });
  assert.deepEqual(trail.data.rows.map((r: any) => r.action), ["CORRECT", "CREATE"]);
});

test("racing payment and approval cannot retroactively reduce money already settled", async () => {
  const owner = await createOwner();
  const worker = await salary(owner.cookie);
  const proposalRow = await newCase(owner.cookie, { ...proposal(worker.id, "HOUSE_RENT", 2_000), reference: `RACE-PAY-${suffix()}` });
  const [payment, approval] = await Promise.all([
    api("POST", "/api/payroll", { cookie: owner.cookie,
      body: { workerId: worker.id, amount: 1_000, periodMonth: previous(), idempotencyKey: `RACE-CASH-${suffix()}` } }),
    api("PUT", "/api/payroll-deductions", { cookie: owner.cookie,
      body: { id: proposalRow.id, action: "APPROVE", reason: "Read signed consent before paying" } }),
  ]);
  assert.equal(Number(payment.status === 201) + Number(approval.status === 200), 1,
    "Exactly ONE competing operation can succeed; the other must be refused");
  assert.equal(payment.status === 201 ? approval.status : payment.status, 409);
  if (payment.status === 201) {
    assert.equal((await rowFor(owner.cookie, worker.id)).due, 90_000);
    assert.equal((await rowFor(owner.cookie, worker.id)).paid, 1_000);
  } else {
    assert.equal(approval.status, 200);
    assert.equal((await rowFor(owner.cookie, worker.id)).mustPost, true);
  }
});

test("an established worker cannot be retroactively switched into HYBRID and have past salary/approved work recalculated", async () => {
  const owner = await createOwner();
  const established = await salary(owner.cookie, 50_000);
  const before = await rowFor(owner.cookie, established.id);
  const attempted = await api("PUT", "/api/workers", { cookie: owner.cookie,
    body: { id: established.id, name: established.name, specialty: "Office Staff", paymentType: "HYBRID", paymentRate: 50_000 } });
  assert.equal(attempted.status, 409);
  assert.match(attempted.data.error, /past earnings/);
  assert.equal((await rowFor(owner.cookie, established.id)).due, before.due);
  const fresh = await createWorker(owner.cookie, { name: `Fresh mixed worker ${suffix()}`, specialty: "Cutter",
    paymentType: "MONTHLY", paymentRate: 50_000 });
  const changed = await api("PUT", "/api/workers", { cookie: owner.cookie, body: {
    id: fresh.id, name: fresh.name, specialty: "Cutter", paymentType: "HYBRID", paymentRate: 50_000,
  } });
  await expectStatus(changed, 200, "Unused same-month profile may explicitly choose salary plus approved pieces");
});

test("a worker already paid through legacy payroll cannot have that month silently posted or backdated", async () => {
  const owner = await createOwner();
  const worker = await salary(owner.cookie);
  await expectStatus(await api("POST", "/api/payroll", { cookie: owner.cookie,
    body: { workerId: worker.id, periodMonth: previous(), amount: 10_000, salaryAmount: 10_000,
      idempotencyKey: `LEGACY-PAID-${suffix()}` } }), 201, "Existing append-only cash payment");
  assert.equal((await api("POST", "/api/payroll-deductions/post", { cookie: owner.cookie,
    body: { workerId: worker.id, month: previous() } })).status, 409);
  assert.equal((await api("POST", "/api/payroll-deductions", { cookie: owner.cookie,
    body: proposal(worker.id, "HOUSE_RENT", 1_000) })).status, 409);
  const original = await rowFor(owner.cookie, worker.id);
  assert.equal(original.due, 90_000);
  assert.equal(original.paid, 10_000);
  assert.equal(original.finalized, false);
});
