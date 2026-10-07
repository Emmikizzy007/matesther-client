import { NextResponse } from "next/server";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { workers, users, productionOperations, productionBatches, orders, customers, stageInspections, workerPayments, workerOvertime } from "@/db/schema";
import { guard, getSessionUser, getLinkedWorkerId, ANYONE, OWNER, STAFF } from "@/lib/authz";
import { SUPPORT_ROLE, hasRole } from "@/lib/format";
import { allocatedTotalsByWorker, operationIdsWithAllocations } from "@/lib/production-allocation";
import {
  normaliseRoles,
  replaceWorkerRoles,
  rolesByWorker,
  rolesForWorker,
  unknownRoles,
} from "@/lib/worker-roles";

/**
 * Lifetime piecework for one worker, as SQL.
 *
 * This is the SAME rate precedence lib/job-pay.ts defines - inspection snapshot,
 * then the job's agreed rate, then the worker's legacy profile rate - and only
 * PER_PIECE people earn it. It replaced a loop that re-scanned every inspection
 * in the database once per worker: O(workers x all inspections ever).
 */
const LIFETIME_EARNINGS = sql`coalesce(sum(case when ${workers.paymentType} = 'PER_PIECE' then ${stageInspections.quantityApproved} * coalesce(${stageInspections.pieceRate}, ${productionOperations.pieceRate}, ${workers.paymentRate}) else 0 end), 0)`;

/**
 * Who an inspection's approved pieces belong to - the same rule lib/payroll.ts uses.
 * NULL on every inspection recorded before a stage could be split across workers,
 * where the answer is the stage's own worker, so this page and the payroll sheet can
 * never disagree about who earned what.
 */
const PAID_WORKER = sql`coalesce(${stageInspections.workerId}, ${productionOperations.workerId})`;

/**
 * `?view=slim` - what a worker DROPDOWN needs and nothing more.
 *
 * Seven screens fetch /api/workers purely to populate a <select>. Each of them
 * used to trigger the full aggregation below (per-worker production totals,
 * lifetime earnings, payroll history) and, for an Owner, the entire worker row.
 * The Workers page itself still gets the complete profile.
 */
const SLIM_COLUMNS = {
  id: workers.id,
  name: workers.name,
  specialty: workers.specialty,
  status: workers.status,
  paymentType: workers.paymentType,
  isInspector: workers.isInspector,
};

/**
 * `?supportHelpers=1` - WHO A TAILOR MAY HAND WORK TO, and nothing else.
 *
 * WHY THIS EXISTS
 *   A tailor handing out support work has to choose a helper, so they need to know
 *   which of their colleagues hold the Support Worker role. `GET /api/workers` is
 *   STAFF-only - correctly, because it carries phone numbers, pay rates, departments
 *   and per-worker production and earnings totals - and the support screen was
 *   swallowing that 403 with `.catch(() => [])`. The helper dropdown was therefore
 *   always empty for a tailor, the form could never be completed, and the feature
 *   looked broken from the factory floor even though `POST /api/support-work` had
 *   permitted a tailor all along.
 *
 *   The fix is NOT to open the workers list to every Worker. It is this view: a
 *   purpose-limited answer to the one question the workflow actually asks.
 *
 * WHAT IT RETURNS, AND WHAT IT DELIBERATELY DOES NOT
 *   id, name, roles, paymentType and status - exactly what the picker needs, and
 *   exactly what it needs in order to tell a PER_PIECE helper (who must be offered an
 *   agreed rate) from a salaried one. No phone number, no pay rate, no department, no
 *   job title, no production totals, no earnings, no payroll history: a tailor is not
 *   entitled to a colleague's private terms, and this endpoint cannot be widened into
 *   the staff list by adding a parameter, because it selects five columns and returns
 *   only people who hold the Support Worker role.
 *
 *   A tailor may of course appear here themselves if they hold that role. `POST
 *   /api/support-work` refuses to let them hand work to themselves, so listing them
 *   costs nothing and keeps the rule about what may be DONE rather than about what
 *   may be SEEN.
 */
async function supportHelperList(req: Request) {
  // ANYONE rather than STAFF: the whole point is that a linked Worker may ask.
  const denied = await guard(req, ANYONE);
  if (denied) return denied;
  const session = await getSessionUser(req);
  if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  // A Worker with no factory profile of their own can hold no production, so they can
  // have nothing to delegate from. Refusing is the same answer the support screen
  // already gives them, rather than a list of colleagues they cannot hand work to.
  if (session.role === "WORKER" && (await getLinkedWorkerId(session)) === null)
    return NextResponse.json([], { headers: { "Cache-Control": "private, no-store" } });
  const rows = await db
    .select({
      id: workers.id,
      name: workers.name,
      specialty: workers.specialty,
      status: workers.status,
      paymentType: workers.paymentType,
      organizationId: workers.organizationId,
    })
    .from(workers)
    .where(and(
      eq(workers.status, "ACTIVE"),
      // Organisation isolation in the query: another company's people are never read.
      session.organizationId === null ? undefined : eq(workers.organizationId, session.organizationId),
    ));
  // Roles are resolved through the same effective-roles rule as everywhere else -
  // stored role rows plus the legacy specialty - so this list can never disagree with
  // what the Workers screen shows or with what POST /api/support-work will accept.
  const roleMap = await rolesByWorker();
  const helpers = rows
    .filter((person) => hasRole(roleMap.get(person.id) ?? [person.specialty], SUPPORT_ROLE))
    .map(({ organizationId, ...person }) => ({
      ...person,
      roles: roleMap.get(person.id) ?? [person.specialty],
    }));
  return NextResponse.json(helpers, { headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(req: Request) {
  // Handled before the STAFF gate, because it has its own narrower gate and its own
  // narrower answer: it must not fall through to the staff-shaped response below.
  if (new URL(req.url).searchParams.get("supportHelpers") === "1") return supportHelperList(req);
  const denied = await guard(req, STAFF);
  if (denied) return denied;
  try {
    const isManager = (await getSessionUser(req))?.role === "PRODUCTION_MANAGER";
    const query = new URL(req.url).searchParams;
    const slim = query.get("view") === "slim";
    const showArchived = query.get("showArchived") === "1";
    const roleMap = await rolesByWorker();

    // A dropdown needs names and roles. It must not cost an aggregation pass
    // over the whole production history.
    if (slim) {
      const rows = await db
        .select(SLIM_COLUMNS)
        .from(workers)
        .where(showArchived ? undefined : eq(workers.status, "ACTIVE"));
      const list = rows.map((person) => ({
        ...person,
        roles: roleMap.get(person.id) ?? [person.specialty],
      }));
      return NextResponse.json(list, { headers: { "Cache-Control": "private, no-store" } });
    }

    const idFilter = query.get("id") ? Number(query.get("id")) : null;
    // Split stages are counted through their allocations, never through the stage
    // row, so the two aggregates have to be kept disjoint.
    const splitStageIds = await operationIdsWithAllocations();
    const allocationStats = await allocatedTotalsByWorker();
    // Everything below is grouped by worker in SQL, so each table is read ONCE
    // rather than once per person.
    const [people, opStats, earnedRows, payIds, overtimeIds] = await Promise.all([
      db
        .select()
        .from(workers)
        .where(idFilter ? eq(workers.id, idFilter) : showArchived ? undefined : eq(workers.status, "ACTIVE")),
      // Stages that name this worker AND are not split. A split stage still names
      // one worker on the stage row, so counting it here as well as counting its
      // allocations would credit that person with the whole stage on top of their
      // own share. `splitStageIds` is what keeps the two halves from overlapping.
      db
        .select({
          workerId: productionOperations.workerId,
          jobs: sql<number>`count(*)`,
          currentTasks: sql<number>`coalesce(sum(case when ${productionOperations.status} in ('IN_PROGRESS', 'SUBMITTED') then 1 else 0 end), 0)`,
          assigned: sql<number>`coalesce(sum(${productionOperations.quantityReceived}), 0)`,
          completed: sql<number>`coalesce(sum(${productionOperations.quantityCompleted}), 0)`,
          rejected: sql<number>`coalesce(sum(${productionOperations.quantityRejected}), 0)`,
          approved: sql<number>`coalesce(sum(${productionOperations.quantityApproved}), 0)`,
        })
        .from(productionOperations)
        .where(
          and(
            idFilter ? eq(productionOperations.workerId, idFilter) : undefined,
            splitStageIds.length ? notInArray(productionOperations.id, splitStageIds) : undefined
          )
        )
        .groupBy(productionOperations.workerId),
      // Earnings are only ever shown to the Owner; a Production Manager is
      // already blocked from seeing pay, so the query is skipped entirely.
      isManager
        ? Promise.resolve([] as { workerId: number; earnings: number }[])
        : db
            .select({ workerId: PAID_WORKER, earnings: LIFETIME_EARNINGS })
            .from(stageInspections)
            .innerJoin(productionOperations, eq(productionOperations.id, stageInspections.productionOperationId))
            .innerJoin(workers, eq(workers.id, PAID_WORKER))
            .where(idFilter ? eq(PAID_WORKER, idFilter) : undefined)
            .groupBy(PAID_WORKER),
      db
        .select({ workerId: workerPayments.workerId })
        .from(workerPayments)
        .where(idFilter ? eq(workerPayments.workerId, idFilter) : undefined)
        .groupBy(workerPayments.workerId),
      db
        .select({ workerId: workerOvertime.workerId })
        .from(workerOvertime)
        .where(idFilter ? eq(workerOvertime.workerId, idFilter) : undefined)
        .groupBy(workerOvertime.workerId),
    ]);
    const statsByWorker = new Map(opStats.map((row) => [Number(row.workerId), row]));
    const earnedByWorker = new Map(earnedRows.map((row) => [Number(row.workerId), Number(row.earnings) || 0]));
    const hasPay = new Set(payIds.map((row) => Number(row.workerId)));
    const hasOvertime = new Set(overtimeIds.map((row) => Number(row.workerId)));

    const personView = (person: typeof workers.$inferSelect) => isManager
      ? { id: person.id, name: person.name, phone: person.phone, specialty: person.specialty, status: person.status,
          paymentType: person.paymentType, isInspector: person.isInspector, createdAt: person.createdAt,
          department: person.department, jobTitle: person.jobTitle }
      : person;
    const expanded = people.map((person) => {
      const stats = statsByWorker.get(person.id);
      // Their share of any split stage, added to the stages they hold outright.
      const share = allocationStats.get(person.id);
      // MONTHLY people are shown their salary, exactly as before.
      const earned = person.paymentType === "MONTHLY"
        ? person.paymentRate
        : earnedByWorker.get(person.id) ?? 0;
      return {
        ...personView(person),
        // Additive: every person still carries `specialty`; `roles` is the
        // full set, so a Cutter who also sews appears in both filters.
        roles: roleMap.get(person.id) ?? [person.specialty],
        currentTasks: Number(stats?.currentTasks ?? 0) + (share?.activeStages ?? 0),
        assigned: Number(stats?.assigned ?? 0) + (share?.allocated ?? 0),
        completed: Number(stats?.completed ?? 0) + (share?.submitted ?? 0),
        rejected: Number(stats?.rejected ?? 0) + (share?.rejected ?? 0),
        approved: Number(stats?.approved ?? 0) + (share?.approved ?? 0),
        hasHistory: Number(stats?.jobs ?? 0) > 0 || !!share || hasPay.has(person.id) || hasOvertime.has(person.id),
        ...(!isManager ? { earnings: earned } : {}),
      };
    });

    if (idFilter) {
      const profile = expanded.find((person) => person.id === idFilter);
      if (!profile) return NextResponse.json({ error: "Worker not found." }, { status: 404 });
      // One person's history: filter in SQL instead of scanning every batch,
      // order and customer to find the handful that belong to them.
      const historyOps = await db.select().from(productionOperations).where(eq(productionOperations.workerId, idFilter));
      const batchIds = [...new Set(historyOps.map((op) => op.productionBatchId))];
      const historyBatches = batchIds.length
        ? await db.select().from(productionBatches).where(inArray(productionBatches.id, batchIds))
        : [];
      const orderIds = [...new Set(historyBatches.map((batch) => batch.orderId))];
      const historyOrders = orderIds.length
        ? await db.select().from(orders).where(inArray(orders.id, orderIds))
        : [];
      const customerIds = [...new Set(historyOrders.map((order) => order.customerId).filter((value): value is number => !!value))];
      const historySchools = customerIds.length
        ? await db.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, customerIds))
        : [];
      const batchMap = new Map(historyBatches.map((batch) => [batch.id, batch]));
      const orderMap = new Map(historyOrders.map((order) => [order.id, order]));
      const schoolMap = new Map(historySchools.map((school) => [school.id, school]));
      const history = historyOps.map((op) => {
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
    return NextResponse.json(expanded, { headers: { "Cache-Control": "private, no-store" } });
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
