import { NextResponse } from "next/server";
import { db } from "@/db";
import {
  payrollDeductions, payrollDeductionAudit, payrollDeductionCategories, payrollAttendance,
  payrollStatements, payrollStatementLines, stageInspections, supportInspections, supportAssignments,
  productionOperations, productionBatches, orders, workers,
} from "@/db/schema";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { guard, getSessionUser, OWNER, type SessionUser } from "@/lib/authz";
import {
  BUILTIN_DEDUCTIONS, PayrollError, appliesInMonth, assertMonth, assertUnsettled,
  auditPayroll, lockPayrollWorker, money, previousOpenMonth, requiredOrganization,
  safeId, shortText,
} from "@/lib/payroll-deductions";
import { payrollFailure, PRIVATE_RESPONSE } from "@/lib/payroll-deduction-http";
import { currentMonth } from "@/lib/payroll";
import { chooseWorkers } from "@/lib/payroll-worker-selection";
import { calculatePaye2026 } from "@/lib/nigerian-paye";

function day(value: unknown, label: string) {
  const date = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new PayrollError(`${label} must be a real YYYY-MM-DD date.`);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || date > new Date().toISOString().slice(0, 10))
    throw new PayrollError(`${label} must be a real date, not in the future.`);
  return date;
}


function requireConsent(body: any, workerId: number, bulk: boolean) {
  const record = bulk ? (Array.isArray(body.consents) ? body.consents.find((item: any) => Number(item?.workerId) === workerId) : null) : body;
  if (!record || (bulk && body.consents.filter((item: any) => Number(item?.workerId) === workerId).length !== 1))
    throw new PayrollError(`Document separate consent for worker ${workerId}; selecting everyone is not consent.`);
  return {
    consentRef: shortText(record.consentRef, `Worker ${workerId} written consent reference`, 5, 200),
    consentOn: day(record.consentOn, `Worker ${workerId} consent date`),
  };
}

/** Every body is untrusted. Only these server-built columns can reach the insert;
 * status, identity, organisation, amount, tax, incident attribution and approval
 * cannot be supplied by a forged POST. Bulk always inserts a separate proposal
 * and uses one worker's OWN written authorisation for that worker only. */
export async function POST(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const organizationId = requiredOrganization(actor);
    const body = await req.json();
    const startMonth = assertMonth(body.startMonth);
    if (startMonth < previousOpenMonth()) throw new PayrollError("Only the current or previous unprocessed month (or a future month) may be proposed. Paid history cannot be backdated.", 409);
    const endMonth = body.endMonth ? assertMonth(body.endMonth) : null;
    if (endMonth && endMonth < startMonth) throw new PayrollError("End month must be on or after the start month.");
    const frequencyMonths = body.frequencyMonths === undefined ? 0 : Number(body.frequencyMonths);
    if (!Number.isSafeInteger(frequencyMonths) || frequencyMonths < 0 || frequencyMonths > 12)
      throw new PayrollError("Frequency must be 0 (once) or every 1–12 months.");
    if (frequencyMonths === 0 && endMonth && endMonth !== startMonth)
      throw new PayrollError("A one-time deduction has only one payroll month.");
    const description = shortText(body.description, "Description", 8, 500);
    const reference = shortText(body.reference, "Unique case/agreement reference", 5, 200).toUpperCase();
    const evidenceRef = body.evidenceRef ? shortText(body.evidenceRef, "Supporting evidence reference", 5, 500) : null;
    const authorityRef = body.authorityRef ? shortText(body.authorityRef, "Legal authorisation reference", 5, 500) : null;
    const selection = body.selection ?? { type: "IDS", workerIds: body.workerId ? [body.workerId] : [] };
    const people = await chooseWorkers(organizationId, selection);
    const bulk = selection.type !== "IDS" || people.length > 1;
    const categoryInput = shortText(body.categoryCode, "Deduction category", 3, 100);
    let categoryCode: string;
    let categoryName: string;
    let customCategoryId: number | null = null;
    if (categoryInput.startsWith("CUSTOM:")) {
      customCategoryId = safeId(categoryInput.slice(7), "custom category");
      const [category] = await db.select().from(payrollDeductionCategories).where(and(
        eq(payrollDeductionCategories.id, customCategoryId), eq(payrollDeductionCategories.organizationId, organizationId),
        eq(payrollDeductionCategories.active, true),
      )).limit(1);
      if (!category) throw new PayrollError("Active custom category not found in your organisation.", 404);
      categoryCode = `CUSTOM:${category.id}`;
      categoryName = category.name;
    } else {
      const builtin = BUILTIN_DEDUCTIONS.find((item) => item.code === categoryInput);
      if (!builtin) throw new PayrollError("Unknown deduction category.");
      categoryCode = builtin.code;
      categoryName = builtin.name;
    }
    const method = shortText(body.method, "Calculation method", 3, 30);
    const basis = body.basis === undefined ? "AFTER_SUPPORT" : String(body.basis);
    if (!["AFTER_SUPPORT", "SALARY"].includes(basis)) throw new PayrollError("Choose salary or earned pay after support work as the percentage base.");
    const special = ["STATUTORY_TAX", "ABSENCE", "DAMAGE"].includes(categoryCode);
    if (special && bulk) throw new PayrollError("Tax, attendance and damage require separate, individually reviewed worker cases. Bulk selection is not allowed.");
    if (categoryCode === "STATUTORY_TAX" ? method !== "PAYE_2026" :
      categoryCode === "ABSENCE" ? method !== "ATTENDANCE" :
      categoryCode === "DAMAGE" ? method !== "FIXED" :
      !["FIXED", "PERCENT", "VARIABLE"].includes(method))
      throw new PayrollError("That calculation method is not lawful/supported for this category.");
    if (method === "VARIABLE" && frequencyMonths !== 0)
      throw new PayrollError("Variable amounts need an individually reviewed one-time proposal for each period.");
    if (categoryCode === "STAFF_OCCASION" && frequencyMonths !== 0)
      throw new PayrollError("A staff occasion must be one-time. Create a new proposal for another event.");
    if (categoryCode === "DAMAGE" && frequencyMonths !== 0)
      throw new PayrollError("A damage case is one-time. Repeating a charge could recover more than the proven net loss.");
    let amount: number | null = null, rateBps: number | null = null;
    if (["FIXED", "VARIABLE"].includes(method)) amount = money(body.amount, "Deduction amount");
    if (method === "PERCENT") {
      rateBps = Number(body.rateBps);
      if (!Number.isSafeInteger(rateBps) || rateBps < 1 || rateBps > 10_000)
        throw new PayrollError("Percentage must be 0.01%–100%, supplied as whole basis points (100 = 1%).");
    }
    const prevReason = startMonth < currentMonth()
      ? shortText(body.lateReason, "Late entry reason for a previous unpaid month", 10, 500) : null;
    if (!special && !authorityRef)
      throw new PayrollError("Document the lawful basis/scheme approval for this company deduction (reference required).");
    if (categoryCode === "COOPERATIVE" && !authorityRef)
      throw new PayrollError("Cooperative savings need the approved scheme authorisation reference.");
    if (categoryCode === "DAMAGE" && (!authorityRef || !evidenceRef))
      throw new PayrollError("Garment loss requires prior written labour-officer consent and evidence of the net loss.");
    if (categoryCode === "ABSENCE" && !evidenceRef)
      throw new PayrollError("Give the documented working-day and unpaid-leave policy reference.");
    if (categoryCode === "STATUTORY_TAX" && (startMonth < "2026-01" || startMonth > "2026-12" ||
      frequencyMonths !== 1 || endMonth !== "2026-12" || !evidenceRef))
      throw new PayrollError("PAYE needs an evidenced 2026 annual assessment, monthly frequency, and end month 2026-12. Other tax years need a reviewed schedule.");

    // Validate all worker-specific evidence BEFORE any insert. pg-mem has no
    // rollback; PostgreSQL also benefits from cheap validation before locks.
    const consent = new Map<number, { consentRef: string; consentOn: string }>();
    if (!special) {
      for (const person of people) consent.set(person.id, requireConsent(body, person.id, bulk));
      if (bulk && new Set([...consent.values()].map((entry) => entry.consentRef.toLowerCase())).size !== people.length)
        throw new PayrollError("Each worker in a bulk request needs a distinct written consent reference, not one document copied to everyone.");
    }

    let attendance: typeof payrollAttendance.$inferSelect | undefined;
    if (categoryCode === "ABSENCE") {
      const attendanceId = safeId(body.attendanceId, "attendance day");
      [attendance] = await db.select().from(payrollAttendance).where(and(
        eq(payrollAttendance.id, attendanceId), eq(payrollAttendance.organizationId, organizationId),
        eq(payrollAttendance.workerId, people[0].id),
      )).limit(1);
      if (!attendance || !["UNAUTHORIZED_ABSENCE", "UNPAID_LEAVE"].includes(attendance.status) || attendance.day.slice(0, 7) !== startMonth || frequencyMonths !== 0)
        throw new PayrollError("Only an explicitly recorded unauthorized absence or unpaid leave in this month can be proposed once.");
      if (!["MONTHLY", "HYBRID"].includes((await db.select({ paymentType: workers.paymentType }).from(workers).where(eq(workers.id, people[0].id)))[0]?.paymentType))
        throw new PayrollError("Attendance deduction requires a monthly salary. Never subtract a missed day from unapproved piecework.");
    }
    const workingDays = method === "ATTENDANCE" ? Number(body.workingDays) : null;
    if (method === "ATTENDANCE" && (!Number.isSafeInteger(workingDays) || workingDays! < 1 || workingDays! > 31))
      throw new PayrollError("Document 1–31 payable working days under the policy for this month.");

    let incidentInspectionId: number | null = null, incidentSupportInspectionId: number | null = null;
    let incidentQuantity: number | null = null, incidentLossAmount: number | null = null;
    let incidentFindings: string | null = null, incidentLossBasis: string | null = null;
    if (categoryCode === "DAMAGE") {
      const hasStage = body.incidentInspectionId !== undefined && body.incidentInspectionId !== "" && body.incidentInspectionId !== null;
      const hasSupport = body.incidentSupportInspectionId !== undefined && body.incidentSupportInspectionId !== "" && body.incidentSupportInspectionId !== null;
      if (hasStage === hasSupport)
        throw new PayrollError("Choose exactly one rejected stage OR support-work inspection for a damage case.");
      incidentInspectionId = hasStage ? safeId(body.incidentInspectionId, "rejected stage inspection") : null;
      incidentSupportInspectionId = hasSupport ? safeId(body.incidentSupportInspectionId, "rejected support inspection") : null;
      incidentQuantity = money(body.incidentQuantity, "Damaged garment quantity");
      incidentLossAmount = money(body.incidentLossAmount, "Provable net loss after unpaid/rejected production");
      incidentFindings = shortText(body.incidentFindings, "Finding of wilful misconduct or neglect (not mere rejection)", 20, 2000);
      incidentLossBasis = shortText(body.incidentLossBasis, "Evidence of net loss after production non-payment", 20, 2000);
      if (amount! > incidentLossAmount) throw new PayrollError("A damage charge cannot exceed the proven net loss AFTER rejected pieces were excluded from payable work.");
      if (incidentInspectionId) {
        const [incident] = await db.select({
          id: stageInspections.id, workerId: stageInspections.workerId,
          fallbackWorkerId: productionOperations.workerId, rejected: stageInspections.quantityRejected,
          organizationId: orders.organizationId,
        }).from(stageInspections).innerJoin(productionOperations, eq(productionOperations.id, stageInspections.productionOperationId))
          .innerJoin(productionBatches, eq(productionBatches.id, productionOperations.productionBatchId))
          .innerJoin(orders, eq(orders.id, productionBatches.orderId))
          .where(eq(stageInspections.id, incidentInspectionId)).limit(1);
        if (!incident || incident.organizationId !== organizationId ||
          (incident.workerId ?? incident.fallbackWorkerId) !== people[0].id || incident.rejected < incidentQuantity)
          throw new PayrollError("Rejected stage inspection, responsible worker and quantity must match. Rework/approval alone is not a damage charge.", 404);
      } else {
        const [incident] = await db.select({
          workerId: supportAssignments.workerId, rejected: supportInspections.quantityRejected,
        }).from(supportInspections)
          .innerJoin(supportAssignments, eq(supportAssignments.id, supportInspections.supportAssignmentId))
          .innerJoin(productionOperations, eq(productionOperations.id, supportAssignments.productionOperationId))
          .innerJoin(productionBatches, eq(productionBatches.id, productionOperations.productionBatchId))
          .innerJoin(orders, eq(orders.id, productionBatches.orderId))
          .where(and(eq(supportInspections.id, incidentSupportInspectionId!),
            eq(supportAssignments.organizationId, organizationId), eq(orders.organizationId, organizationId),
            eq(supportAssignments.orderId, orders.id))).limit(1);
        if (!incident || incident.workerId !== people[0].id || incident.rejected < incidentQuantity)
          throw new PayrollError("Rejected support-work inspection must belong to this worker and a documented garment/order in your organisation.", 404);
      }
    }
    let taxFields: Partial<typeof payrollDeductions.$inferInsert> = {};
    if (categoryCode === "STATUTORY_TAX") {
      const annualGross = money(body.annualGross, "Assessed annual taxable earnings");
      const annualPension = money(body.annualPension ?? 0, "Verified annual pension", true);
      const annualNhf = money(body.annualNhf ?? 0, "Verified annual NHF", true);
      const annualNhis = money(body.annualNhis ?? 0, "Verified annual NHIS", true);
      const annualRentPaid = money(body.annualRentPaid ?? 0, "Verified annual rent actually paid", true);
      const annualOtherRelief = money(body.annualOtherRelief ?? 0, "Verified other statutory relief", true);
      const otherReliefBasis = annualOtherRelief ? shortText(body.otherReliefBasis, "Legal basis for other relief", 10, 500) : null;
      const minimumWageExempt = body.minimumWageExempt === true;
      if (annualPension + annualNhf + annualNhis + annualOtherRelief + Math.min(500_000, Math.floor(annualRentPaid / 5)) > annualGross)
        throw new PayrollError("Documented annual relief cannot exceed assessed annual gross earnings.");
      if (minimumWageExempt && annualGross > 840_000)
        throw new PayrollError("Minimum-wage exemption requires assessed annual gross at or below ₦70,000 × 12 and supporting evidence.");
      // Uses the enacted progressive bands; the caller cannot send a flat rate.
      calculatePaye2026({ annualGross, annualPension, annualNhf, annualNhis, annualRentPaid, annualOtherRelief, minimumWageExempt });
      taxFields = { annualGross, annualPension, annualNhf, annualNhis, annualRentPaid,
        annualOtherRelief, otherReliefBasis, minimumWageExempt };
    }

    const inserted = await db.transaction(async (tx) => {
      const rows = [];
      for (const person of people.sort((a, b) => a.id - b.id)) {
        const locked = await lockPayrollWorker(tx, organizationId, person.id);
        if (locked.status !== "ACTIVE") throw new PayrollError("Worker is no longer active.", 409);
        // If a recurring proposal begins before an already-paid/current month,
        // approval will check again under this same lock. A one-off past payment
        // must be refused even at draft stage so it cannot be approved later.
        await assertUnsettled(tx, person.id, startMonth);
        if (!special) {
          const [duplicate] = await tx.select({ id: payrollDeductions.id }).from(payrollDeductions)
            .where(and(eq(payrollDeductions.workerId, person.id), eq(payrollDeductions.organizationId, organizationId),
              inArray(payrollDeductions.status, ["PENDING", "APPROVED"]),
              eq(payrollDeductions.categoryCode, categoryCode), eq(payrollDeductions.startMonth, startMonth),
              eq(payrollDeductions.description, description), eq(payrollDeductions.method, method),
              amount !== null ? eq(payrollDeductions.amount, amount) : eq(payrollDeductions.rateBps, rateBps!),
            )).limit(1);
          if (duplicate) throw new PayrollError(`Worker ${person.name} already has this proposal for ${startMonth}.`, 409);
        }
        if (categoryCode === "STATUTORY_TAX") {
          const [anotherTax] = await tx.select({ id: payrollDeductions.id }).from(payrollDeductions)
            .where(and(eq(payrollDeductions.organizationId, organizationId), eq(payrollDeductions.workerId, person.id),
              eq(payrollDeductions.categoryCode, "STATUTORY_TAX"), inArray(payrollDeductions.status, ["PENDING", "APPROVED"]),
              lte(payrollDeductions.startMonth, endMonth ?? "2026-12"),
              gte(payrollDeductions.endMonth, startMonth))).limit(1);
          if (anotherTax) throw new PayrollError("Only one active PAYE assessment may cover this worker and tax year.", 409);
        }
        if (incidentInspectionId || incidentSupportInspectionId) {
          const prior = await tx.select({ id: payrollDeductions.id, status: payrollDeductions.status })
            .from(payrollDeductions).where(and(incidentInspectionId
              ? eq(payrollDeductions.incidentInspectionId, incidentInspectionId)
              : eq(payrollDeductions.incidentSupportInspectionId, incidentSupportInspectionId!),
              eq(payrollDeductions.workerId, person.id)));
          if (prior.some((r) => ["PENDING", "APPROVED"].includes(r.status)))
            throw new PayrollError("This inspection already has an active damage case for this worker.", 409);
          if (prior.length) {
            const [posted] = await tx.select({ id: payrollStatementLines.id }).from(payrollStatementLines)
              .where(inArray(payrollStatementLines.deductionId, prior.map((r) => r.id))).limit(1);
            if (posted) throw new PayrollError("This inspection was already charged in posted payroll. Refund/correct later; never charge twice.", 409);
          }
        }
        if (attendance?.id) {
          const [currentDay] = await tx.select().from(payrollAttendance)
            .where(eq(payrollAttendance.id, attendance.id)).limit(1);
          if (!currentDay || currentDay.workerId !== person.id || currentDay.day.slice(0, 7) !== startMonth ||
            !["UNAUTHORIZED_ABSENCE", "UNPAID_LEAVE"].includes(currentDay.status))
            throw new PayrollError("The attendance evidence changed during this request. Review the current day before proposing a deduction.", 409);
          const [old] = await tx.select({ id: payrollDeductions.id }).from(payrollDeductions)
            .where(and(eq(payrollDeductions.attendanceId, attendance.id),
              inArray(payrollDeductions.status, ["PENDING", "APPROVED"]))).limit(1);
          if (old) throw new PayrollError("This unpaid day already has an active deduction case.", 409);
          const prior = await tx.select({ id: payrollDeductions.id }).from(payrollDeductions)
            .where(eq(payrollDeductions.attendanceId, attendance.id));
          if (prior.length) {
            const [posted] = await tx.select({ id: payrollStatementLines.id }).from(payrollStatementLines)
              .where(inArray(payrollStatementLines.deductionId, prior.map((r) => r.id))).limit(1);
            if (posted) throw new PayrollError("This day already affected posted payroll. Do not deduct it twice.", 409);
          }
        }
        const [row] = await tx.insert(payrollDeductions).values({
          organizationId, workerId: person.id, categoryCode, categoryName, customCategoryId,
          description, method, basis, amount, rateBps, frequencyMonths, startMonth, endMonth,
          reference, evidenceRef, authorityRef,
          consentRef: consent.get(person.id)?.consentRef ?? null,
          consentOn: consent.get(person.id)?.consentOn ?? null,
          attendanceId: attendance?.id ?? null, workingDays,
          incidentInspectionId, incidentSupportInspectionId, incidentQuantity, incidentLossAmount,
          incidentFindings, incidentLossBasis,
          ...taxFields, status: "PENDING", createdById: actor.id, createdByName: actor.name,
        }).returning();
        await auditPayroll(tx, actor, "DEDUCTION", row.id, "CREATE",
          `${prevReason ? `${prevReason}. ` : ""}Proposed ${categoryName}: ${description}. Worker ${person.name}; reference ${reference}.` +
          (body.incidentFindings ? ` Findings: ${String(body.incidentFindings).trim()}. Net loss basis: ${String(body.incidentLossBasis).trim()}.` : ""), undefined, row);
        rows.push(row);
      }
      return rows;
    });
    return NextResponse.json({ created: inserted, count: inserted.length }, { status: 201, headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}

/** Review, reject or cancel an UNPOSTED proposal. A cancellation only stops
 * FUTURE application; immutable statement lines survive. Reviewed tax, damage,
 * absence, variable and custom proposals need a second Owner account. */
export async function PUT(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const organizationId = requiredOrganization(actor);
    const b = await req.json();
    const id = safeId(b.id, "deduction proposal");
    const action = String(b.action ?? "");
    if (!["APPROVE", "REJECT", "CANCEL"].includes(action)) throw new PayrollError("Choose approve, reject or cancel.");
    const reason = shortText(b.reason, "Review/cancellation reason", 8, 1000);
    const [candidate] = await db.select({ workerId: payrollDeductions.workerId }).from(payrollDeductions)
      .where(and(eq(payrollDeductions.id, id), eq(payrollDeductions.organizationId, organizationId))).limit(1);
    if (!candidate) throw new PayrollError("Proposal not found in your organisation.", 404);
    const row = await db.transaction(async (tx) => {
      await lockPayrollWorker(tx, organizationId, candidate.workerId);
      const [record] = await tx.select().from(payrollDeductions).where(and(
        eq(payrollDeductions.id, id), eq(payrollDeductions.organizationId, organizationId))).for("update").limit(1);
      if (!record) throw new PayrollError("Proposal not found.", 404);
      if (action === "APPROVE") {
        if (record.status !== "PENDING") throw new PayrollError("Only pending proposals can be approved.", 409);
        if (["STATUTORY_TAX", "DAMAGE", "ABSENCE"].includes(record.categoryCode) ||
          record.method === "VARIABLE" || record.categoryCode.startsWith("CUSTOM:")) {
          if (actor.id === record.createdById)
            throw new PayrollError("An independent Owner must review this exceptional case; the proposer cannot approve it.", 403);
        }
        // Validate from start to today, not just the first month: a recurring
        // proposal may otherwise reduce a later month already paid.
        await assertUnsettled(tx, record.workerId, record.startMonth);
        for (let month = record.startMonth; month <= currentMonth(); month = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 7)) {
          if (record.endMonth && month > record.endMonth) break;
          if (appliesInMonth({ ...record, status: "APPROVED" }, month)) await assertUnsettled(tx, record.workerId, month);
        }
        if (record.attendanceId) {
          const [day] = await tx.select().from(payrollAttendance).where(eq(payrollAttendance.id, record.attendanceId)).limit(1);
          if (!day || !["UNAUTHORIZED_ABSENCE", "UNPAID_LEAVE"].includes(day.status) || day.workerId !== record.workerId)
            throw new PayrollError("The recorded day is not an unpaid absence. Correct the record before review.", 409);
        }
      } else if (action === "REJECT" ? record.status !== "PENDING" : !["PENDING", "APPROVED"].includes(record.status)) {
        throw new PayrollError("This proposal cannot be rejected/cancelled in its current state.", 409);
      }
      const status = action === "APPROVE" ? "APPROVED" : action === "REJECT" ? "REJECTED" : "CANCELLED";
      const [updated] = await tx.update(payrollDeductions).set({
        status, decisionReason: reason,
        ...(status === "APPROVED" ? { approvedById: actor.id, approvedByName: actor.name, approvedAt: new Date() } : {}),
        ...(status !== "APPROVED" ? { cancelledById: actor.id, cancelledByName: actor.name, cancelledAt: new Date() } : {}),
      }).where(eq(payrollDeductions.id, id)).returning();
      await auditPayroll(tx, actor, "DEDUCTION", id, action, reason, record, updated);
      return updated;
    });
    return NextResponse.json(row, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}

export async function GET(req: Request) {
  const denied = await guard(req, OWNER); if (denied) return denied;
  try {
    const actor = (await getSessionUser(req))!;
    const organizationId = requiredOrganization(actor);
    const p = new URL(req.url).searchParams;
    const view = p.get("view") || "list";
    const limit = p.has("limit") ? Number(p.get("limit")) : 25;
    const offset = p.has("offset") ? Number(p.get("offset")) : 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000)
      throw new PayrollError("Use a limit of 1–100 and a non-negative offset.");
    if (view === "audit") {
      const entityType = p.get("entityType");
      const entityId = p.get("entityId") ? safeId(p.get("entityId"), "entity") : null;
      const rows = await db.select().from(payrollDeductionAudit).where(and(
        eq(payrollDeductionAudit.organizationId, organizationId),
        entityType ? eq(payrollDeductionAudit.entityType, entityType) : undefined,
        entityId ? eq(payrollDeductionAudit.entityId, entityId) : undefined,
      )).orderBy(desc(payrollDeductionAudit.id)).limit(limit).offset(offset);
      return NextResponse.json({ rows }, { headers: PRIVATE_RESPONSE });
    }
    if (view === "report") {
      const month = assertMonth(p.get("month"));
      const workerId = p.has("workerId") ? safeId(p.get("workerId"), "worker") : null;
      const category = p.get("categoryCode");
      const department = p.get("department");
      const rows = await db.select({
        workerId: payrollStatements.workerId, workerName: payrollStatements.workerName,
        department: payrollStatements.department,
        categoryCode: payrollStatementLines.categoryCode, categoryName: payrollStatementLines.categoryName,
        amount: sql<number>`coalesce(sum(${payrollStatementLines.amount}), 0)`,
        cooperativeCredit: sql<number>`coalesce(sum(${payrollStatementLines.cooperativeCredit}), 0)`,
        count: sql<number>`count(${payrollStatementLines.id})`,
      }).from(payrollStatementLines).innerJoin(payrollStatements, eq(payrollStatements.id, payrollStatementLines.statementId))
        .where(and(eq(payrollStatements.organizationId, organizationId), eq(payrollStatements.periodMonth, month),
          workerId ? eq(payrollStatements.workerId, workerId) : undefined,
          category ? eq(payrollStatementLines.categoryCode, category) : undefined,
          department ? eq(payrollStatements.department, department) : undefined))
        .groupBy(payrollStatements.workerId, payrollStatements.workerName, payrollStatements.department,
          payrollStatementLines.categoryCode, payrollStatementLines.categoryName);
      // Aggregate only grouped report rows (not all workers/inspections) for the
      // overview; signed refunds appear as negatives instead of hiding corrections.
      const sum = (key: "categoryCode" | "workerId" | "department") => {
        const grouped = new Map<string, { label: string; amount: number; cooperativeCredit: number; count: number }>();
        for (const r of rows) {
          const label = String(r[key] ?? "Unassigned");
          const entry = grouped.get(label) ?? { label, amount: 0, cooperativeCredit: 0, count: 0 };
          entry.amount += Number(r.amount); entry.cooperativeCredit += Number(r.cooperativeCredit); entry.count += Number(r.count);
          grouped.set(label, entry);
        }
        return [...grouped.values()];
      };
      return NextResponse.json({ month, rows, byCategory: sum("categoryCode"), byWorker: sum("workerId"), byDepartment: sum("department") }, { headers: PRIVATE_RESPONSE });
    }
    if (view !== "list") throw new PayrollError("Unknown deductions view.");
    const workerId = p.has("workerId") ? safeId(p.get("workerId"), "worker") : null;
    const status = p.get("status");
    if (status && !["PENDING", "APPROVED", "CANCELLED", "REJECTED"].includes(status)) throw new PayrollError("Unknown proposal status.");
    const category = p.get("categoryCode");
    const period = p.has("month") ? assertMonth(p.get("month")) : null;
    const department = p.get("department");
    const filter = and(eq(payrollDeductions.organizationId, organizationId),
      workerId ? eq(payrollDeductions.workerId, workerId) : undefined,
      status ? eq(payrollDeductions.status, status) : undefined,
      category ? eq(payrollDeductions.categoryCode, category) : undefined,
      department ? eq(workers.department, department) : undefined,
      period ? lte(payrollDeductions.startMonth, period) : undefined,
      period ? gte(sql`coalesce(${payrollDeductions.endMonth}, '9999-12')`, period) : undefined);
    const [rows, count] = await Promise.all([
      db.select({ deduction: payrollDeductions, workerName: workers.name, department: workers.department })
        .from(payrollDeductions).innerJoin(workers, eq(workers.id, payrollDeductions.workerId))
        .where(filter).orderBy(desc(payrollDeductions.id)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)` }).from(payrollDeductions)
        .innerJoin(workers, eq(workers.id, payrollDeductions.workerId)).where(filter),
    ]);
    return NextResponse.json({ rows, total: Number(count[0]?.count ?? 0), limit, offset }, { headers: PRIVATE_RESPONSE });
  } catch (error) { return payrollFailure(error); }
}
