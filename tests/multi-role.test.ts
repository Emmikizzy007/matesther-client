/**
 * Multi-role workers: one person, several production roles.
 *
 * Before this, workers.specialty held exactly one role, so a person who cut and
 * sewed had to exist as two worker records - splitting their production history
 * and their pay. These tests cover the replacement: a worker_roles table, with
 * workers.specialty still counting as a role so nobody recorded earlier breaks.
 *
 * The security half matters as much as the feature half. Every test that names a
 * restriction (cutter-supervisor, self-inspection) asserts it still holds when
 * the role involved is only ONE of several the person holds.
 *
 * Runs against an empty database. Every fixture is created here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { workers, workerRoles } from "@/db/schema";
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

/** Create a batch (as Owner) and return its per-stage operations. */
async function batchWithStages(ownerCookie: string, orderId: number, itemId: number, quantity: number) {
  const created = await api("POST", "/api/batches", {
    cookie: ownerCookie,
    body: { orderId, orderItemId: itemId, quantity },
  });
  await expectStatus(created, 201, "Create unassigned batch");
  const jobs = await api("GET", "/api/operations", { cookie: ownerCookie });
  await expectStatus(jobs, 200, "Load operations");
  const stages = new Map<string, any>(
    jobs.data.filter((job: any) => job.productionBatchId === created.data.id).map((job: any) => [job.stage, job])
  );
  return { batchId: created.data.id, stages };
}

/**
 * Drive cutting through to approval so the approved pieces reach sewing.
 *
 * Not a shortcut: only CUTTING receives a quantity when a batch is created, so
 * a sewing stage legitimately has nothing to submit until cutting is approved.
 */
async function approveCutting(
  ownerCookie: string,
  stages: Map<string, any>,
  cutterId: number,
  cutterCookie: string,
  quantity: number
): Promise<void> {
  const cutting = stages.get("CUTTING");
  await expectStatus(
    await api("PUT", "/api/operations", {
      cookie: ownerCookie,
      body: { id: cutting.id, workerId: cutterId, pieceRate: 200, status: "IN_PROGRESS" },
    }),
    200,
    "Owner assigns cutting"
  );
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: cutterCookie, body: { id: cutting.id, submitQty: quantity } }),
    200,
    "The cutter submits their own work"
  );
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: ownerCookie,
      body: { operationId: cutting.id, quantityApproved: quantity, quantityRework: 0, quantityRejected: 0 },
    }),
    201,
    "Owner approves the cutting"
  );
}

/** One worker row, as the API sees it. */
async function workersNamed(cookie: string, name: string): Promise<any> {
  const list = await api("GET", "/api/workers?showArchived=1", { cookie });
  await expectStatus(list, 200, "Load workers");
  const matches = list.data.filter((row: any) => row.name === name);
  return matches;
}

/** Load one worker's full profile, including production history. */
async function workerProfile(cookie: string, id: number): Promise<any> {
  const detail = await api("GET", `/api/workers?id=${id}`, { cookie });
  return expectStatus(detail, 200, `Load worker ${id}`);
}

// ---------------------------------------------------------------------------
// 1. One person, many roles - and still only one person.
// ---------------------------------------------------------------------------

test("one person can hold several roles without becoming duplicate worker records", async () => {
  const owner = await createOwner();
  const name = unique("Cutter And Tailor");

  const created = await api("POST", "/api/workers", {
    cookie: owner.cookie,
    body: { name, specialty: "Cutter", roles: ["Cutter", "Tailor"], paymentType: "PER_PIECE", paymentRate: 0 },
  });
  await expectStatus(created, 201, "Create a worker with two roles");
  assert.deepEqual(
    created.data.roles.sort(),
    ["Cutter", "Tailor"],
    "Both roles must be returned on creation"
  );

  const matches = await workersNamed(owner.cookie, name);
  assert.equal(matches.length, 1, "A person with two roles must still be exactly ONE worker record");
  assert.deepEqual(matches[0].roles.sort(), ["Cutter", "Tailor"]);
  assert.equal(matches[0].specialty, "Cutter", "specialty is preserved for compatibility");

  const stored = await db.select().from(workerRoles).where(eq(workerRoles.workerId, created.data.id));
  assert.equal(stored.length, 2, "Two role rows for one person");
  const people = await db.select().from(workers).where(eq(workers.name, name));
  assert.equal(people.length, 1, "Only one row in the workers table");
});

test("the same role cannot be assigned to a person twice", async () => {
  const owner = await createOwner();
  const name = unique("Deduped Roles");

  // Through the API: repeats and case variants collapse to one role.
  const created = await api("POST", "/api/workers", {
    cookie: owner.cookie,
    body: { name, specialty: "Cutter", roles: ["Cutter", "Cutter", "cutter "], paymentType: "PER_PIECE", paymentRate: 0 },
  });
  await expectStatus(created, 201, "Create worker with a repeated role");
  assert.deepEqual(created.data.roles, ["Cutter"], "A repeated role must be stored once");

  const updated = await api("PUT", "/api/workers", {
    cookie: owner.cookie,
    body: { id: created.data.id, name, roles: ["Tailor", "Tailor", "TAILOR"], paymentType: "PER_PIECE", paymentRate: 0 },
  });
  await expectStatus(updated, 200, "Replace roles with a repeated value");
  assert.deepEqual(updated.data.roles, ["Tailor"], "Still stored once after an update");

  // At the database level, where it ultimately has to hold.
  await db.insert(workerRoles).values({ workerId: created.data.id, role: "Cutter", isPrimary: true });
  let duplicateRejected = false;
  try {
    await db.insert(workerRoles).values({ workerId: created.data.id, role: "Cutter" });
  } catch {
    duplicateRejected = true;
  }
  const stored = await db.select().from(workerRoles).where(eq(workerRoles.workerId, created.data.id));
  assert.equal(duplicateRejected, true, "The unique (worker_id, role) constraint must reject a duplicate");
  assert.equal(
    stored.filter((row) => row.role.toLowerCase() === "cutter").length,
    1,
    "Exactly one Cutter row survives the duplicate attempt"
  );
});

test("removing one role keeps the person and all of their production history", async () => {
  const owner = await createOwner();
  const name = unique("Role Removed");
  const person = await createWorker(owner.cookie, { name, specialty: "Cutter", roles: ["Cutter", "Tailor"] });
  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 4500 });
  const { stages } = await batchWithStages(owner.cookie, order.orderId, order.itemId, 10);

  // Give the person real production history on the role we are about to remove.
  await expectStatus(
    await api("PUT", "/api/operations", {
      cookie: owner.cookie,
      body: { id: stages.get("CUTTING").id, workerId: person.id, pieceRate: 200, status: "IN_PROGRESS" },
    }),
    200,
    "Owner assigns cutting"
  );
  const before = await workerProfile(owner.cookie, person.id);
  assert.ok(before.history.length >= 1, "The cutting assignment is recorded history");

  const updated = await api("PUT", "/api/workers", {
    cookie: owner.cookie,
    body: { id: person.id, name, roles: ["Tailor"], paymentType: "PER_PIECE", paymentRate: 0 },
  });
  await expectStatus(updated, 200, "Remove the Cutter role");
  assert.deepEqual(updated.data.roles, ["Tailor"]);

  const after = await workerProfile(owner.cookie, person.id);
  assert.equal(after.id, person.id, "The same person record still exists");
  assert.equal(after.name, name, "Same name - this is not a replacement record");
  assert.equal(after.history.length, before.history.length, "No production history was lost");
  assert.equal(after.assigned, before.assigned, "Assigned quantity is unchanged");

  const people = await db.select().from(workers).where(eq(workers.id, person.id));
  assert.equal(people.length, 1, "The workers row was never deleted and recreated");
});

// ---------------------------------------------------------------------------
// 2. Nobody recorded before this change breaks.
// ---------------------------------------------------------------------------

test("a worker created the old way, with one specialty and no roles, still works", async () => {
  const owner = await createOwner();
  const name = unique("Legacy Cutter");

  // Exactly the payload the old client sends: specialty only, no `roles` key.
  const created = await api("POST", "/api/workers", {
    cookie: owner.cookie,
    body: { name, specialty: "Cutter", paymentType: "PER_PIECE", paymentRate: 0 },
  });
  await expectStatus(created, 201, "Legacy single-specialty creation");
  assert.deepEqual(created.data.roles, ["Cutter"], "The specialty counts as the one assigned role");

  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 4500 });
  const { stages } = await batchWithStages(owner.cookie, order.orderId, order.itemId, 10);

  await expectStatus(
    await api("PUT", "/api/operations", {
      cookie: owner.cookie,
      body: { id: stages.get("CUTTING").id, workerId: created.data.id, pieceRate: 200, status: "IN_PROGRESS" },
    }),
    200,
    "The legacy cutter can still be assigned cutting"
  );

  const wrongStage = await api("PUT", "/api/operations", {
    cookie: owner.cookie,
    body: { id: stages.get("SEWING").id, workerId: created.data.id, pieceRate: 450, status: "IN_PROGRESS" },
  });
  assert.equal(wrongStage.status, 400, "A cutter-only worker is still refused sewing");
});

// ---------------------------------------------------------------------------
// 3. A multi-role worker can receive work for every role they hold.
// ---------------------------------------------------------------------------

test("a multi-role worker can be assigned work appropriate to each of their roles", async () => {
  const owner = await createOwner();
  const person = await createWorker(owner.cookie, {
    name: unique("Cutter And Tailor"),
    specialty: "Cutter",
    roles: ["Cutter", "Tailor"],
  });
  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 4500 });
  const { stages } = await batchWithStages(owner.cookie, order.orderId, order.itemId, 10);

  const cutting = await api("PUT", "/api/operations", {
    cookie: owner.cookie,
    body: { id: stages.get("CUTTING").id, workerId: person.id, pieceRate: 200, status: "IN_PROGRESS" },
  });
  await expectStatus(cutting, 200, "Assigned to cutting on the Cutter role");
  assert.equal(cutting.data.workerId, person.id);

  const sewing = await api("PUT", "/api/operations", {
    cookie: owner.cookie,
    body: { id: stages.get("SEWING").id, workerId: person.id, pieceRate: 450, status: "IN_PROGRESS" },
  });
  await expectStatus(sewing, 200, "Assigned to sewing on the Tailor role");
  assert.equal(sewing.data.workerId, person.id);
});

test("a multi-role worker cannot be assigned work for a role they do not hold", async () => {
  const owner = await createOwner();
  const person = await createWorker(owner.cookie, {
    name: unique("Cutter And Tailor"),
    specialty: "Cutter",
    roles: ["Cutter", "Tailor"],
  });
  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 4500 });
  const { stages } = await batchWithStages(owner.cookie, order.orderId, order.itemId, 10);

  const ironing = await api("PUT", "/api/operations", {
    cookie: owner.cookie,
    body: { id: stages.get("IRONING").id, workerId: person.id, pieceRate: 100, status: "IN_PROGRESS" },
  });
  assert.equal(ironing.status, 400, "Holding two roles must not unlock every stage");
});

// ---------------------------------------------------------------------------
// 4. Cutter-supervisor restrictions survive multi-role.
// ---------------------------------------------------------------------------

test("cutter-supervisor restrictions still apply when Cutter is only one of several roles", async () => {
  const owner = await createOwner();
  const name = unique("Supervisor Who Also Cuts");
  const person = await createWorker(owner.cookie, {
    name,
    specialty: "Tailor",
    roles: ["Tailor", "Cutter"],
    isInspector: true,
  });
  const manager = await createStaff(owner.cookie, { name, role: "PRODUCTION_MANAGER", workerId: person.id });
  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 4500 });

  const rights = await api("GET", "/api/production-access", { cookie: manager.cookie });
  await expectStatus(rights, 200, "Production access");
  assert.equal(rights.data.cutterSupervisor, true, "Holding the Cutter role makes them a cutter-supervisor");
  assert.equal(rights.data.canAssignCutting, false, "So they must not assign cutting work");
  assert.deepEqual(rights.data.roles.sort(), ["Cutter", "Tailor"], "All their roles are reported");

  const batchAssign = await api("POST", "/api/batches", {
    cookie: manager.cookie,
    body: { orderId: order.orderId, orderItemId: order.itemId, quantity: 5, workerId: person.id, cuttingRate: 200 },
  });
  assert.equal(batchAssign.status, 403, "Cannot assign cutting to themselves at batch creation");

  const { stages } = await batchWithStages(owner.cookie, order.orderId, order.itemId, 10);
  const manageCutting = await api("PUT", "/api/operations", {
    cookie: manager.cookie,
    body: { id: stages.get("CUTTING").id, workerId: null, pieceRate: 200, status: "IN_PROGRESS" },
  });
  assert.equal(manageCutting.status, 403, "Cannot manage the cutting stage either");
});

test("adding the Cutter role later still triggers the cutter-supervisor restriction", async () => {
  const owner = await createOwner();
  const name = unique("Tailor Promoted To Cutter");

  // Created as a plain Tailor - the role that makes them risky comes later.
  const person = await createWorker(owner.cookie, { name, specialty: "Tailor" });
  const manager = await createStaff(owner.cookie, { name, role: "PRODUCTION_MANAGER", workerId: person.id });

  const before = await api("GET", "/api/production-access", { cookie: manager.cookie });
  await expectStatus(before, 200, "Access before the role change");
  assert.equal(before.data.cutterSupervisor, false, "A tailor-only supervisor may assign cutting");

  await expectStatus(
    await api("PUT", "/api/workers", {
      cookie: owner.cookie,
      body: { id: person.id, name, roles: ["Tailor", "Cutter"], paymentType: "PER_PIECE", paymentRate: 0 },
    }),
    200,
    "Add the Cutter role"
  );

  const after = await api("GET", "/api/production-access", { cookie: manager.cookie });
  await expectStatus(after, 200, "Access after the role change");
  assert.equal(
    after.data.cutterSupervisor,
    true,
    "The restriction follows the role, not the stored specialty - which still reads Tailor"
  );
  assert.equal(after.data.canAssignCutting, false);

  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 4500 });
  const refused = await api("POST", "/api/batches", {
    cookie: manager.cookie,
    body: { orderId: order.orderId, orderItemId: order.itemId, quantity: 5, workerId: person.id, cuttingRate: 200 },
  });
  assert.equal(refused.status, 403, "And the restriction is enforced on the write, not just reported");
});

test("a cutter-supervisor may still work the roles that are not restricted", async () => {
  const owner = await createOwner();
  const name = unique("Supervisor Who Also Cuts");
  const person = await createWorker(owner.cookie, { name, specialty: "Tailor", roles: ["Tailor", "Cutter"] });
  const manager = await createStaff(owner.cookie, { name, role: "PRODUCTION_MANAGER", workerId: person.id });
  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 4500 });
  const { stages } = await batchWithStages(owner.cookie, order.orderId, order.itemId, 10);

  // Sewing has nothing to submit until cutting is approved. The Owner may put
  // this person on cutting even though the cutter-supervisor rule blocks them
  // from managing it themselves.
  await approveCutting(owner.cookie, stages, person.id, manager.cookie, 10);

  await expectStatus(
    await api("PUT", "/api/operations", {
      cookie: owner.cookie,
      body: { id: stages.get("SEWING").id, workerId: person.id, pieceRate: 450, status: "IN_PROGRESS" },
    }),
    200,
    "The Owner assigns them sewing, their unrestricted role"
  );

  const submitted = await api("PUT", "/api/operations", {
    cookie: manager.cookie,
    body: { id: stages.get("SEWING").id, submitQty: 3 },
  });
  await expectStatus(submitted, 200, "They submit their own sewing work");
  assert.equal(submitted.data.quantityCompleted, 3);

  const cutting = await api("PUT", "/api/operations", {
    cookie: manager.cookie,
    body: { id: stages.get("CUTTING").id, workerId: null, pieceRate: 200, status: "IN_PROGRESS" },
  });
  assert.equal(cutting.status, 403, "Cutting stays closed to them regardless");
});

// ---------------------------------------------------------------------------
// 5. Separation of duty: an Inspection Officer role grants no self-approval.
// ---------------------------------------------------------------------------

test("holding the Inspection Officer role does not allow inspecting your own submitted work", async () => {
  const owner = await createOwner();
  const name = unique("Tailor And Inspector");
  const person = await createWorker(owner.cookie, {
    name,
    specialty: "Tailor",
    roles: ["Tailor", "Inspection Officer"],
    isInspector: true,
  });
  const manager = await createStaff(owner.cookie, { name, role: "PRODUCTION_MANAGER", workerId: person.id });
  const otherManager = await createStaff(owner.cookie, { name: unique("Other Supervisor"), role: "PRODUCTION_MANAGER" });

  // A separate cutter drives the batch forward so there is sewing work to do.
  const cutterName = unique("Cutter For Batch");
  const cutter = await createWorker(owner.cookie, { name: cutterName, specialty: "Cutter" });
  const cutterLogin = await createStaff(owner.cookie, { name: cutterName, role: "WORKER" });

  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 4500 });
  const { stages } = await batchWithStages(owner.cookie, order.orderId, order.itemId, 10);
  const sewing = stages.get("SEWING");

  await approveCutting(owner.cookie, stages, cutter.id, cutterLogin.cookie, 10);

  await expectStatus(
    await api("PUT", "/api/operations", {
      cookie: owner.cookie,
      body: { id: sewing.id, workerId: person.id, pieceRate: 450, status: "IN_PROGRESS" },
    }),
    200,
    "Owner assigns them sewing"
  );
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: manager.cookie, body: { id: sewing.id, submitQty: 3 } }),
    200,
    "They submit their own work"
  );

  const selfInspect = await api("POST", "/api/inspections", {
    cookie: manager.cookie,
    body: { operationId: sewing.id, quantityApproved: 3, quantityRework: 0, quantityRejected: 0 },
  });
  assert.equal(
    selfInspect.status,
    403,
    "An Inspection Officer role must not let anyone approve their own production work"
  );

  const bySomeoneElse = await api("POST", "/api/inspections", {
    cookie: otherManager.cookie,
    body: { operationId: sewing.id, quantityApproved: 3, quantityRework: 0, quantityRejected: 0 },
  });
  await expectStatus(bySomeoneElse, 201, "A different supervisor can still inspect it");
});

// ---------------------------------------------------------------------------
// 6. Authorization decisions read assigned roles, not the stored specialty.
// ---------------------------------------------------------------------------

test("stage assignment checks the assigned roles, not the single stored specialty", async () => {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 4500 });
  const { stages } = await batchWithStages(owner.cookie, order.orderId, order.itemId, 10);

  // specialty says Tailor; the assigned roles include Cutter.
  const multiRole = await api("POST", "/api/workers", {
    cookie: owner.cookie,
    body: { name: unique("Specialty Tailor"), specialty: "Tailor", roles: ["Tailor", "Cutter"], paymentType: "PER_PIECE", paymentRate: 0 },
  });
  await expectStatus(multiRole, 201, "Create the multi-role worker");
  assert.equal(multiRole.data.specialty, "Tailor", "The stored specialty is unchanged");

  const allowed = await api("PUT", "/api/operations", {
    cookie: owner.cookie,
    body: { id: stages.get("CUTTING").id, workerId: multiRole.data.id, pieceRate: 200, status: "IN_PROGRESS" },
  });
  await expectStatus(
    allowed,
    200,
    "Cutting is allowed because the Cutter role is assigned, even though specialty still says Tailor"
  );

  // Control: a genuinely tailor-only person must still be refused cutting.
  const tailorOnly = await createWorker(owner.cookie, { name: unique("Tailor Only"), specialty: "Tailor" });
  const refused = await api("PUT", "/api/operations", {
    cookie: owner.cookie,
    body: { id: stages.get("SEWING").id, workerId: tailorOnly.id, pieceRate: 450, status: "IN_PROGRESS" },
  });
  await expectStatus(refused, 200, "A tailor can still be assigned sewing");
  const wrongStage = await api("PUT", "/api/operations", {
    cookie: owner.cookie,
    body: { id: stages.get("IRONING").id, workerId: tailorOnly.id, pieceRate: 100, status: "IN_PROGRESS" },
  });
  assert.equal(wrongStage.status, 400, "The role check has not been loosened into 'allow anything'");
});

// ---------------------------------------------------------------------------
// 7. Input handling and compatibility.
// ---------------------------------------------------------------------------

test("an unrecognised role is rejected instead of being stored", async () => {
  const owner = await createOwner();
  const name = unique("Bad Role");

  const created = await api("POST", "/api/workers", {
    cookie: owner.cookie,
    body: { name, specialty: "Tailor", roles: ["Astronaut"], paymentType: "PER_PIECE", paymentRate: 0 },
  });
  assert.equal(created.status, 400, "An invented role must be refused on creation");

  const person = await createWorker(owner.cookie, { name: unique("Valid First"), specialty: "Tailor" });
  const updated = await api("PUT", "/api/workers", {
    cookie: owner.cookie,
    body: { id: person.id, name: person.name, roles: ["Tailor", "Astronaut"], paymentType: "PER_PIECE", paymentRate: 0 },
  });
  assert.equal(updated.status, 400, "An invented role must be refused on update too");

  const untouched = await workerProfile(owner.cookie, person.id);
  assert.deepEqual(untouched.roles, ["Tailor"], "The rejected update changed nothing");
});

test("a person can never be left with no roles at all", async () => {
  const owner = await createOwner();
  const person = await createWorker(owner.cookie, {
    name: unique("Roles Cleared"),
    specialty: "Tailor",
    roles: ["Tailor", "Cutter"],
  });

  const emptied = await api("PUT", "/api/workers", {
    cookie: owner.cookie,
    body: { id: person.id, name: person.name, roles: [], paymentType: "PER_PIECE", paymentRate: 0 },
  });
  await expectStatus(emptied, 200, "An empty role list is accepted");
  assert.equal(emptied.data.roles.length, 1, "It falls back to their specialty");
  assert.deepEqual(emptied.data.roles, ["Tailor"]);

  const omitted = await api("PUT", "/api/workers", {
    cookie: owner.cookie,
    body: { id: person.id, name: person.name, paymentType: "PER_PIECE", paymentRate: 0 },
  });
  await expectStatus(omitted, 200, "Omitting roles entirely");
  assert.deepEqual(omitted.data.roles, ["Tailor"], "An update that does not mention roles keeps the existing set");
});

test("managers can see roles for their dropdowns but still cannot see pay data", async () => {
  const owner = await createOwner();
  const person = await createWorker(owner.cookie, {
    name: unique("Cutter And Tailor"),
    specialty: "Cutter",
    roles: ["Cutter", "Tailor"],
    paymentType: "PER_PIECE",
    paymentRate: 250,
  });
  const manager = await createStaff(owner.cookie, { name: unique("Reading Manager"), role: "PRODUCTION_MANAGER" });

  const asOwner = await api("GET", "/api/workers", { cookie: owner.cookie });
  await expectStatus(asOwner, 200, "Owner loads workers");
  const ownerRow = asOwner.data.find((row: any) => row.id === person.id);
  assert.deepEqual(ownerRow.roles.sort(), ["Cutter", "Tailor"], "The Owner sees both roles");
  assert.equal(ownerRow.paymentRate, 250, "The Owner sees the rate");

  const asManager = await api("GET", "/api/workers", { cookie: manager.cookie });
  await expectStatus(asManager, 200, "Manager loads workers");
  const managerRow = asManager.data.find((row: any) => row.id === person.id);
  assert.ok(managerRow, "The manager can see the worker");
  assert.deepEqual(managerRow.roles.sort(), ["Cutter", "Tailor"], "Roles are needed to filter assignment dropdowns");
  assert.equal(managerRow.paymentRate, undefined, "Pay data is still hidden from managers");
  assert.equal(managerRow.earnings, undefined, "Earnings are still hidden from managers");
});
