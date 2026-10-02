import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { workers, users, productionOperations, productionBatches, orders, customers, stageInspections, workerPayments, workerOvertime } from "@/db/schema";
import { guard, getSessionUser, OWNER, STAFF } from "@/lib/authz";
import { inspectionEarnings } from "@/lib/job-pay";
import {
  normaliseRoles,
  replaceWorkerRoles,
  rolesByWorker,
  rolesForWorker,
  unknownRoles,
} from "@/lib/worker-roles";

export async function GET(req: Request) {
  const denied = await guard(req, STAFF);
  if (denied) return denied;
  try {
    const isManager = (await getSessionUser(req))?.role === "PRODUCTION_MANAGER";
    const query = new URL(req.url).searchParams;
    const [people, operations, inspections, payRows, overtimeRows, roleMap] = await Promise.all([
      db.select().from(workers), db.select().from(productionOperations), db.select().from(stageInspections),
      db.select().from(workerPayments), db.select().from(workerOvertime), rolesByWorker(),
    ]);
    const personView = (person: typeof workers.$inferSelect) => isManager
      ? { id: person.id, name: person.name, phone: person.phone, specialty: person.specialty, status: person.status,
          paymentType: person.paymentType, isInspector: person.isInspector, createdAt: person.createdAt,
          department: person.department, jobTitle: person.jobTitle }
      : person;
    const expanded = people.map((person) => {
      const mine = operations.filter((op) => op.workerId === person.id);
      const byId = new Map(mine.map((op) => [op.id, op]));
      const approved = mine.reduce((sum, op) => sum + op.quantityApproved, 0);
      const earned = person.paymentType === "PER_PIECE"
        ? inspections.reduce((sum, check) => {
            const op = byId.get(check.productionOperationId);
            return op ? sum + inspectionEarnings(check, op, person) : sum;
          }, 0)
        : person.paymentType === "MONTHLY" ? person.paymentRate : 0;
      return {
        ...personView(person),
        // Additive: every person still carries `specialty`; `roles` is the
        // full set, so a Cutter who also sews appears in both filters.
        roles: roleMap.get(person.id) ?? [person.specialty],
        currentTasks: mine.filter((op) => ["IN_PROGRESS", "SUBMITTED"].includes(op.status)).length,
        assigned: mine.reduce((sum, op) => sum + op.quantityReceived, 0),
        completed: mine.reduce((sum, op) => sum + op.quantityCompleted, 0),
        rejected: mine.reduce((sum, op) => sum + op.quantityRejected, 0),
        approved,
        hasHistory: mine.length > 0 || payRows.some((p) => p.workerId === person.id) || overtimeRows.some((p) => p.workerId === person.id),
        ...(!isManager ? { earnings: earned } : {}),
      };
    });
    const id = Number(query.get("id"));
    if (query.get("id")) {
      const profile = expanded.find((person) => person.id === id);
      if (!profile) return NextResponse.json({ error: "Worker not found." }, { status: 404 });
      const [batches, orderRows, schools] = await Promise.all([
        db.select().from(productionBatches), db.select().from(orders), db.select().from(customers),
      ]);
      const batchMap = new Map(batches.map((batch) => [batch.id, batch]));
      const orderMap = new Map(orderRows.map((order) => [order.id, order]));
      const schoolMap = new Map(schools.map((school) => [school.id, school]));
      const history = operations.filter((op) => op.workerId === id).map((op) => {
        const batch = batchMap.get(op.productionBatchId);
        const order = batch ? orderMap.get(batch.orderId) : undefined;
        return {
          ...op, ...(!isManager ? {} : { pieceRate: undefined }),
          batchNumber: batch?.batchNumber ?? "-", size: batch?.size ?? null, color: batch?.color ?? null,
          orderId: order?.id, orderNumber: order?.orderNumber ?? "-",
          customer: schoolMap.get(order?.customerId ?? -1)?.name ?? "-",
        };
      });
      return NextResponse.json({ ...profile, history }, { headers: { "Cache-Control": "private, no-store" } });
    }
    const list = query.get("showArchived") === "1" ? expanded : expanded.filter((person) => person.status === "ACTIVE");
    return NextResponse.json(list, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Workers load failed", error);
    return NextResponse.json({ error: "Unable to load workers." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const body = await req.json();
    const name = String(body.name ?? "").trim();
    if (!name) return NextResponse.json({ error: "Worker name is required." }, { status: 400 });
    const paymentType = ["PER_PIECE", "MONTHLY", "DAILY"].includes(body.paymentType) ? body.paymentType : "PER_PIECE";
    const rate = Number(body.paymentRate) || 0;
    if (!Number.isSafeInteger(rate) || rate < 0 || (paymentType === "MONTHLY" && rate < 1))
      return NextResponse.json({ error: "Enter a valid monthly salary, or set the per-piece amount when assigning the job." }, { status: 400 });
    const roles = normaliseRoles(body.roles, String(body.specialty ?? "Tailor").trim() || "Tailor");
    const invalid = unknownRoles(roles);
    if (invalid.length)
      return NextResponse.json({ error: `${invalid.join(", ")} is not one of Matesther's roles.` }, { status: 400 });
    const specialty = String(body.specialty ?? "").trim() || roles[0] || "Tailor";
    const created = await db.transaction(async (tx) => {
      const [row] = await tx.insert(workers).values({
        organizationId: 1, name, phone: String(body.phone ?? "").trim() || null,
        specialty,
        department: String(body.department ?? "").trim() || null,
        jobTitle: String(body.jobTitle ?? "").trim() || null,
        paymentType, paymentRate: rate, status: "ACTIVE", isInspector: !!body.isInspector,
      }).returning();
      // Roles live in worker_roles; the person row is created exactly once.
      await replaceWorkerRoles(tx, row.id, roles);
      return row;
    });
    return NextResponse.json({ ...created, roles }, { status: 201 });
  } catch (error) {
    console.error("Worker creation failed", error);
    return NextResponse.json({ error: "Unable to add this worker." }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const body = await req.json();
    const id = Number(body.id);
    if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ error: "Select a worker." }, { status: 400 });
    const [existing] = await db.select().from(workers).where(eq(workers.id, id)).limit(1);
    if (!existing) return NextResponse.json({ error: "Worker not found." }, { status: 404 });
    const paymentType = ["PER_PIECE", "MONTHLY", "DAILY"].includes(body.paymentType) ? body.paymentType : existing.paymentType;
    const rate = Number(body.paymentRate);
    if (!Number.isSafeInteger(rate) || rate < 0 || (paymentType === "MONTHLY" && rate < 1))
      return NextResponse.json({ error: "Enter a valid salary. Per-piece pay is set on each production job." }, { status: 400 });
    const status = body.status === "INACTIVE" ? "INACTIVE" : "ACTIVE";
    const roles = body.roles === undefined ? null : normaliseRoles(body.roles, existing.specialty);
    const invalid = roles ? unknownRoles(roles) : [];
    if (invalid.length)
      return NextResponse.json({ error: `${invalid.join(", ")} is not one of Matesther's roles.` }, { status: 400 });
    const specialty = String(body.specialty ?? "").trim() || (roles ? roles[0] : existing.specialty);
    const [updated] = await db.update(workers).set({
      name: String(body.name ?? "").trim() || existing.name,
      phone: String(body.phone ?? "").trim() || null,
      specialty,
      department: String(body.department ?? "").trim() || null,
      jobTitle: String(body.jobTitle ?? "").trim() || null,
      paymentType, paymentRate: rate,
      isInspector: !!body.isInspector,
      status,
      archivedAt: status === "INACTIVE" ? existing.archivedAt ?? new Date() : null,
    }).where(eq(workers.id, id)).returning();
    // Editing the role set touches worker_roles only. Dropping a role never
    // removes the person or their production and pay history.
    if (roles) await replaceWorkerRoles(db, id, roles);
    return NextResponse.json({ ...updated, roles: roles ?? (await rolesForWorker(id)) });
  } catch (error) {
    console.error("Worker update failed", error);
    return NextResponse.json({ error: "Unable to update this worker." }, { status: 500 });
  }
}

/** Hard-delete only unused people; archive anyone with a production/payroll trail. */
export async function DELETE(req: Request) {
  const denied = await guard(req, OWNER);
  if (denied) return denied;
  try {
    const id = Number(new URL(req.url).searchParams.get("id"));
    if (!Number.isSafeInteger(id) || id < 1) return NextResponse.json({ error: "Select a worker." }, { status: 400 });
    const [person] = await db.select().from(workers).where(eq(workers.id, id)).limit(1);
    if (!person) return NextResponse.json({ error: "Worker not found." }, { status: 404 });
    const [jobs, wages, overtime] = await Promise.all([
      db.select({ id: productionOperations.id }).from(productionOperations).where(eq(productionOperations.workerId, id)).limit(1),
      db.select({ id: workerPayments.id }).from(workerPayments).where(eq(workerPayments.workerId, id)).limit(1),
      db.select({ id: workerOvertime.id }).from(workerOvertime).where(eq(workerOvertime.workerId, id)).limit(1),
    ]);
    const archived = jobs.length > 0 || wages.length > 0 || overtime.length > 0;
    await db.transaction(async (tx) => {
      await tx.update(users).set({ status: "INACTIVE" }).where(eq(users.workerId, id));
      if (archived) await tx.update(workers).set({ status: "INACTIVE", archivedAt: person.archivedAt ?? new Date() }).where(eq(workers.id, id));
      else await tx.delete(workers).where(eq(workers.id, id));
    });
    return NextResponse.json({ ok: true, archived, message: archived
      ? "Worker archived. Production and pay history remain available under Show archived. Any linked login was disabled."
      : "Unused worker deleted. Any linked login was disabled." });
  } catch (error) {
    console.error("Worker removal failed", error);
    return NextResponse.json({ error: "Unable to remove this worker." }, { status: 500 });
  }
}
