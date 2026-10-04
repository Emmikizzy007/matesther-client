/**
 * SPLIT ALLOCATION: one exact garment at one stage, worked by several people.
 *
 * The case this file is built around is the one the business actually has:
 *
 *     100 Navy Size-10 polos reach SEWING. Tailor A takes 40, Tailor B takes 35,
 *     Tailor C takes 25.
 *
 * Before this, `production_operations` held ONE `worker_id`, so the only way to
 * express that was three batches - which fragments the variant, fragments the
 * route, and makes the order's own allocation ceiling harder to see. The structural
 * block was that single column, NOT the uniqueness indexes: those are kept, because
 * they are what makes a batch's route unambiguous. This is a sub-table against the
 * existing stage row, the same shape `support_assignments` already uses.
 *
 * What is asserted here, in the order the requirements were given:
 *   - one exact variant -> several workers, in partial shares, with a remaining
 *     figure per person and per stage;
 *   - over-allocation refused server-side, against what the LEDGER says the stage
 *     holds rather than a typed figure;
 *   - reassignment moves only unworked quantity, so approved work and the pay for it
 *     stay with the person who earned it, and the closed allocation is kept with the
 *     reason beside the new one;
 *   - approved quantity remains the ONLY thing that moves downstream, and route
 *     progression is unchanged by the split;
 *   - inspection and separation-of-duty rules still hold, extended to cover a
 *     supervisor who holds a share;
 *   - pay follows the person who made each approved garment, at the rate agreed with
 *     that person;
 *   - and there is still exactly ONE stage row, so no second production system.
 *
 * Runs against an empty database. Every fixture is created here through the API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/db";
import { productionOperations } from "@/db/schema";
import { eq } from "drizzle-orm";
import { validateAttributions, allocationRemaining, allocationUnjudged } from "@/lib/production-allocation";
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

/** A tailor who holds the Tailor role, earns per piece, and can sign in. */
async function tailor(ownerCookie: string, label: string) {
  const name = unique(label);
  const profile = await createWorker(ownerCookie, { name, specialty: "Tailor", roles: ["Tailor"], paymentType: "PER_PIECE" });
  const login = await createStaff(ownerCookie, { name, role: "WORKER" });
  return { ...profile, login: login.cookie, name };
}

/**
 * The canonical fixture: 100 navy size-10 polos at SEWING, on a two-stage route so
 * SEWING is where the garments enter and IRONING is what they can move on to.
 */
async function hundredPolosAtSewing() {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity: 100, unitPrice: 4500 });
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
  return { owner, order, variant, batchId: batch.data.id, stages, sewing: stages.get("SEWING"), ironing: stages.get("IRONING") };
}

async function allocationsOf(cookie: string, operationId: number) {
  const response = await api("GET", `/api/allocations?operationId=${operationId}`, { cookie });
  await expectStatus(response, 200, "Load the stage's allocations");
  return response.data as any[];
}

async function allocate(w: Awaited<ReturnType<typeof hundredPolosAtSewing>>, workerId: number, quantity: number, pieceRate: number, reason?: string) {
  return api("POST", "/api/allocations", {
    cookie: w.owner.cookie,
    body: { operationId: w.sewing.id, workerId, quantity, pieceRate, ...(reason ? { reason } : {}) },
  });
}

// ---------------------------------------------------------------------------
// 1. One exact variant, several workers, partial shares, remaining quantities.
// ---------------------------------------------------------------------------

test("100 navy size-10 polos at SEWING split 40 / 35 / 25 across three tailors", async () => {
  const w = await hundredPolosAtSewing();
  const a = await tailor(w.owner.cookie, "Tailor A");
  const b = await tailor(w.owner.cookie, "Tailor B");
  const c = await tailor(w.owner.cookie, "Tailor C");

  assert.equal(w.sewing.quantityReceived, 100, "The stage holds the 100 the route released into it");
  assert.equal(w.sewing.variant, "Navy • Size 10", "It is one exact garment");

  await expectStatus(await allocate(w, a.id, 40, 450), 201, "Tailor A takes 40");
  await expectStatus(await allocate(w, b.id, 35, 400), 201, "Tailor B takes 35");
  await expectStatus(await allocate(w, c.id, 25, 500), 201, "Tailor C takes 25");

  const rows = await allocationsOf(w.owner.cookie, w.sewing.id);
  assert.equal(rows.length, 3, "Three shares of ONE stage");
  assert.deepEqual(rows.map((row) => row.quantityAllocated).sort((x, y) => x - y), [25, 35, 40]);
  assert.equal(rows[0].stageFree, 0, "All 100 are spoken for");
  assert.equal(rows[0].stageHolds, 100, "against the 100 the stage holds");
  for (const row of rows) {
    assert.equal(row.outstanding, row.quantityAllocated, "Nothing submitted yet");
    assert.equal(row.size, "10", "Each share names the exact size");
    assert.equal(row.color, "Navy", "and the exact colour");
    assert.equal(row.batchNumber.startsWith("B-"), true);
  }
  const rates = new Map(rows.map((row) => [row.workerId, row.pieceRate]));
  assert.equal(rates.get(a.id), 450, "Each worker's own agreed rate is snapshotted on their share");
  assert.equal(rates.get(b.id), 400);
  assert.equal(rates.get(c.id), 500);

  // Still exactly ONE stage row: this is a split of one stage, not three stages.
  const stageRows = await db.select().from(productionOperations).where(eq(productionOperations.productionBatchId, w.batchId));
  assert.equal(stageRows.length, 2, "The batch still has one SEWING row and one IRONING row");
  assert.equal(stageRows.filter((row) => row.stage === "SEWING").length, 1, "Exactly one SEWING stage");
});

test("allocating to the same worker again increases their share instead of opening a second one", async () => {
  const w = await hundredPolosAtSewing();
  const a = await tailor(w.owner.cookie, "Tailor A");
  await expectStatus(await allocate(w, a.id, 30, 450), 201, "First 30");
  await expectStatus(await allocate(w, a.id, 10, 450), 201, "10 more");
  const rows = await allocationsOf(w.owner.cookie, w.sewing.id);
  assert.equal(rows.length, 1, "One allocation, not two");
  assert.equal(rows[0].quantityAllocated, 40, "Totalling 40");
  assert.equal(rows[0].stageFree, 60, "60 of the 100 still unallocated");
});

test("the remaining figure follows each share as work is submitted", async () => {
  const w = await hundredPolosAtSewing();
  const a = await tailor(w.owner.cookie, "Tailor A");
  const b = await tailor(w.owner.cookie, "Tailor B");
  await expectStatus(await allocate(w, a.id, 40, 450), 201, "A takes 40");
  await expectStatus(await allocate(w, b.id, 35, 400), 201, "B takes 35");

  await expectStatus(
    await api("PUT", "/api/operations", { cookie: a.login, body: { id: w.sewing.id, submitQty: 15 } }),
    200, "A submits 15 of their 40"
  );
  const rows = await allocationsOf(w.owner.cookie, w.sewing.id);
  const mine = rows.find((row) => row.workerId === a.id);
  const theirs = rows.find((row) => row.workerId === b.id);
  assert.equal(mine.quantitySubmitted, 15, "A's own submissions are counted against their share");
  assert.equal(mine.outstanding, 25, "and 25 remain for A");
  assert.equal(theirs.quantitySubmitted, 0, "B's share is untouched by A's work");
  assert.equal(theirs.outstanding, 35);

  const stage = (await api("GET", `/api/operations?batchId=${w.batchId}`, { cookie: w.owner.cookie })).data.find((j: any) => j.stage === "SEWING");
  assert.equal(stage.quantityCompleted, 15, "The stage's submitted total is still derived from the ledger");
  assert.equal(stage.quantityReceived, 100, "and splitting work created no garments");

  const mineDashboard = await api("GET", "/api/dashboard?view=my-work", { cookie: a.login });
  await expectStatus(mineDashboard, 200, "A's own dashboard");
  const job = mineDashboard.data.journal.find((entry: any) => entry.id === w.sewing.id);
  assert.equal(job.allocated, 40, "A sees their own 40, not the stage's 100");
  assert.equal(job.availableToSubmit, 25, "and can submit 25 more");
  assert.equal(job.stageSplitBetween, 2, "and can see the stage is shared");
  assert.equal(job.variant, "Navy • Size 10", "of an exact garment");
});

// ---------------------------------------------------------------------------
// 2. Over-allocation prevention, server-side, against the ledger.
// ---------------------------------------------------------------------------

test("the shares can never add up to more than the stage holds", async () => {
  const w = await hundredPolosAtSewing();
  const a = await tailor(w.owner.cookie, "Tailor A");
  const b = await tailor(w.owner.cookie, "Tailor B");
  await expectStatus(await allocate(w, a.id, 60, 450), 201, "A takes 60");
  await expectStatus(await allocate(w, b.id, 40, 400), 201, "B takes the last 40");

  const c = await tailor(w.owner.cookie, "Tailor C");
  const oneTooMany = await allocate(w, c.id, 1, 500);
  assert.equal(oneTooMany.status, 400, "Nothing is left to allocate");
  assert.match(String(oneTooMany.data.error), /All 100 garment\(s\) at this stage are already allocated/);

  const greedy = await allocate(w, a.id, 1, 450);
  assert.equal(greedy.status, 400, "Not even for a worker who already holds a share");
  assert.equal((await allocationsOf(w.owner.cookie, w.sewing.id)).length, 2, "Still two shares");
});

test("a share can never exceed what the stage holds on its own", async () => {
  const w = await hundredPolosAtSewing();
  const a = await tailor(w.owner.cookie, "Tailor A");
  const tooBig = await allocate(w, a.id, 101, 450);
  assert.equal(tooBig.status, 400, "101 from a stage holding 100");
  assert.match(String(tooBig.data.error), /Only 100 of the 100/);
  assert.equal((await allocationsOf(w.owner.cookie, w.sewing.id)).length, 0, "Nothing was allocated");
});

test("the ceiling is the ledger's figure, so approving less upstream shrinks it", async () => {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity: 100, unitPrice: 4500 });
  await api("POST", "/api/order-sizes", { cookie: owner.cookie, body: { itemId: order.itemId, sizes: [{ size: "10", color: "Navy", quantity: 100 }] } });
  const cutterName = unique("Cutter");
  const cutter = await createWorker(owner.cookie, { name: cutterName, specialty: "Cutter", roles: ["Cutter"], paymentType: "PER_PIECE" });
  const cutterLogin = await createStaff(owner.cookie, { name: cutterName, role: "WORKER" });
  const batch = await api("POST", "/api/batches", {
    cookie: owner.cookie,
    body: {
      orderId: order.orderId, orderItemId: order.itemId, quantity: 100,
      workerId: cutter.id, cuttingRate: 200,
      stages: [{ stage: "CUTTING" }, { stage: "SEWING" }, { stage: "IRONING" }],
    },
  });
  await expectStatus(batch, 201, "Cutting -> sewing -> ironing");
  const jobs = await api("GET", `/api/operations?batchId=${batch.data.id}`, { cookie: owner.cookie });
  const cutting = jobs.data.find((j: any) => j.stage === "CUTTING");
  const sewing = jobs.data.find((j: any) => j.stage === "SEWING");

  // Only 70 of the 100 are approved at cutting, so only 70 ever reach sewing.
  await api("PUT", "/api/operations", { cookie: cutterLogin.cookie, body: { id: cutting.id, submitQty: 100 } });
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: owner.cookie,
      body: { operationId: cutting.id, quantityApproved: 70, quantityRejected: 30, notes: "Thirty cut off-grain" },
    }),
    201, "70 approved at cutting"
  );

  const tailorA = await tailor(owner.cookie, "Tailor A");
  await expectStatus(
    await api("POST", "/api/allocations", { cookie: owner.cookie, body: { operationId: sewing.id, workerId: tailorA.id, quantity: 70, pieceRate: 450 } }),
    201, "Sewing can be split up to the 70 that actually arrived"
  );
  const tailorB = await tailor(owner.cookie, "Tailor B");
  const over = await api("POST", "/api/allocations", { cookie: owner.cookie, body: { operationId: sewing.id, workerId: tailorB.id, quantity: 30, pieceRate: 400 } });
  assert.equal(over.status, 400, "The 30 rejected upstream were never released, so they cannot be allocated");
  assert.match(String(over.data.error), /already allocated/);
});

test("resizing a share is bounded both ways", async () => {
  const w = await hundredPolosAtSewing();
  const a = await tailor(w.owner.cookie, "Tailor A");
  const b = await tailor(w.owner.cookie, "Tailor B");
  const first = await allocate(w, a.id, 40, 450);
  await expectStatus(first, 201, "A takes 40");
  await expectStatus(await allocate(w, b.id, 35, 400), 201, "B takes 35");
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: a.login, body: { id: w.sewing.id, submitQty: 20 } }),
    200, "A submits 20 of their 40"
  );

  // B holds 35, so A may hold at most 100 - 35 = 65. Growing to 50 is inside that.
  await expectStatus(
    await api("PUT", "/api/allocations", {
      cookie: w.owner.cookie, body: { id: first.data.id, quantity: 50, reason: "B is off sick today and A can take more" },
    }),
    200, "A grows to 50: 50 + 35 is still inside the 100 the stage holds"
  );
  const grow = await api("PUT", "/api/allocations", {
    cookie: w.owner.cookie, body: { id: first.data.id, quantity: 70, reason: "Trying to take more than the stage holds" },
  });
  assert.equal(grow.status, 400, "70 + B's 35 would be 105 of a 100-garment stage");
  assert.match(String(grow.data.error), /cannot exceed 65/);
  await expectStatus(
    await api("PUT", "/api/allocations", {
      cookie: w.owner.cookie, body: { id: first.data.id, quantity: 40, reason: "Back to the original 40" },
    }),
    200, "Restored to 40 for the rest of this test"
  );

  const shrink = await api("PUT", "/api/allocations", {
    cookie: w.owner.cookie, body: { id: first.data.id, quantity: 10, reason: "A can only manage 10 today" },
  });
  assert.equal(shrink.status, 400, "And cannot drop below the 20 A already submitted");
  assert.match(String(shrink.data.error), /already submitted 20/);

  const noReason = await api("PUT", "/api/allocations", {
    cookie: w.owner.cookie, body: { id: first.data.id, quantity: 30, reason: "x" },
  });
  assert.equal(noReason.status, 400, "A resize needs a real reason");

  await expectStatus(
    await api("PUT", "/api/allocations", { cookie: w.owner.cookie, body: { id: first.data.id, quantity: 30, reason: "A can only manage 30 today" } }),
    200, "30 is inside both bounds"
  );
  const rows = await allocationsOf(w.owner.cookie, w.sewing.id);
  assert.equal(rows.find((row) => row.workerId === a.id).quantityAllocated, 30);
  assert.equal(rows[0].stageFree, 35, "and 35 become free again: 100 - 30 - 35");
});

// ---------------------------------------------------------------------------
// 3. Reassignment: unworked quantity moves, earned quantity and pay do not.
// ---------------------------------------------------------------------------

test("reassignment moves only the unworked remainder and keeps the trail", async () => {
  const w = await hundredPolosAtSewing();
  const a = await tailor(w.owner.cookie, "Tailor A");
  const d = await tailor(w.owner.cookie, "Tailor D");
  const first = await allocate(w, a.id, 40, 450);
  await expectStatus(first, 201, "A takes 40");
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: a.login, body: { id: w.sewing.id, submitQty: 10 } }),
    200, "A submits 10 of them"
  );

  const moved = await api("PUT", "/api/allocations", {
    cookie: w.owner.cookie,
    body: { id: first.data.id, toWorkerId: d.id, pieceRate: 425, reason: "A is on leave for the rest of the week" },
  });
  await expectStatus(moved, 200, "Transfer the unworked 30 to D");
  assert.equal(moved.data.moved, 30, "Only the 30 A had not submitted");
  assert.equal(moved.data.closed.quantityAllocated, 10, "A keeps exactly the 10 they submitted");
  assert.equal(moved.data.closed.quantitySubmitted, 10, "Their submission is still theirs");
  assert.equal(moved.data.closed.status, "TRANSFERRED", "and the closed share is kept as the audit trail");
  assert.equal(moved.data.opened.quantityAllocated, 30, "D receives the 30");
  assert.equal(moved.data.opened.pieceRate, 425, "at the rate agreed with D");
  assert.equal(moved.data.opened.transferredFromId, first.data.id, "pointing back at the share it came from");
  assert.equal(moved.data.opened.assignedByName, moved.data.opened.assignedByName, "with who made the move");

  const rows = await allocationsOf(w.owner.cookie, w.sewing.id);
  assert.equal(rows.length, 2, "Both shares are visible: the closed one and the new one");
  const trail = rows.find((row) => row.status === "TRANSFERRED");
  assert.match(String(trail.reason), /on leave/, "The reason is kept on the closed share");

  const ledger = await api("GET", `/api/production-corrections?operationId=${w.sewing.id}`, { cookie: w.owner.cookie });
  await expectStatus(ledger, 200, "Read the movement ledger");
  const reassignments = ledger.data.filter((row: any) => row.eventType === "REASSIGNMENT");
  assert.equal(reassignments.length, 1, "The transfer is on the ledger");
  assert.equal(reassignments[0].quantity, 0, "It moves no quantity");
  assert.match(String(reassignments[0].reason), /30 unworked garment/, "and says how much moved and why");

  // A cannot submit any more; D can submit the 30.
  const aBlocked = await api("PUT", "/api/operations", { cookie: a.login, body: { id: w.sewing.id, submitQty: 1 } });
  assert.equal(aBlocked.status, 400, "A's share is closed");
  assert.match(String(aBlocked.data.error), /do not hold a share of it/, "A's share was closed by the transfer");
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: d.login, body: { id: w.sewing.id, submitQty: 30 } }),
    200, "D submits the 30 they received"
  );
});

test("a transfer needs a reason, a role, and something left to move", async () => {
  const w = await hundredPolosAtSewing();
  const a = await tailor(w.owner.cookie, "Tailor A");
  const first = await allocate(w, a.id, 40, 450);
  await expectStatus(first, 201, "A takes 40");

  const noReason = await api("PUT", "/api/allocations", {
    cookie: w.owner.cookie, body: { id: first.data.id, toWorkerId: a.id, reason: "" },
  });
  assert.equal(noReason.status, 400, "A transfer needs a written reason");

  const toSelf = await api("PUT", "/api/allocations", {
    cookie: w.owner.cookie, body: { id: first.data.id, toWorkerId: a.id, reason: "Moving it to myself" },
  });
  assert.equal(toSelf.status, 400, "And cannot be to the worker who already holds it");

  const cutterName = unique("Cutter");
  const cutter = await createWorker(w.owner.cookie, { name: cutterName, specialty: "Cutter", roles: ["Cutter"] });
  const wrongRole = await api("PUT", "/api/allocations", {
    cookie: w.owner.cookie, body: { id: first.data.id, toWorkerId: cutter.id, reason: "Handing sewing to a cutter" },
  });
  assert.equal(wrongRole.status, 400, "The receiving worker must hold the stage's role");
  assert.match(String(wrongRole.data.error), /needs a Tailor/);

  await expectStatus(
    await api("PUT", "/api/operations", { cookie: a.login, body: { id: w.sewing.id, submitQty: 40 } }),
    200, "A submits all 40"
  );
  const nothingLeft = await api("PUT", "/api/allocations", {
    cookie: w.owner.cookie, body: { id: first.data.id, toWorkerId: (await tailor(w.owner.cookie, "Tailor E")).id, reason: "Trying to move work that is already in" },
  });
  assert.equal(nothingLeft.status, 400, "Fully submitted work cannot be moved");
  assert.match(String(nothingLeft.data.error), /stays with the worker who did it/);
});

// ---------------------------------------------------------------------------
// 4. Submission is bounded by each worker's own share.
// ---------------------------------------------------------------------------

test("a worker cannot submit garments allocated to somebody else", async () => {
  const w = await hundredPolosAtSewing();
  const a = await tailor(w.owner.cookie, "Tailor A");
  const b = await tailor(w.owner.cookie, "Tailor B");
  await expectStatus(await allocate(w, a.id, 40, 450), 201, "A takes 40");
  await expectStatus(await allocate(w, b.id, 35, 400), 201, "B takes 35");

  const tooMany = await api("PUT", "/api/operations", { cookie: a.login, body: { id: w.sewing.id, submitQty: 41 } });
  assert.equal(tooMany.status, 400, "A holds 40, so 41 is refused");
  assert.match(String(tooMany.data.error), /allocated 40 garment/, "and the refusal states A's own share");

  const stranger = await tailor(w.owner.cookie, "Tailor X");
  const notMine = await api("PUT", "/api/operations", { cookie: stranger.login, body: { id: w.sewing.id, submitQty: 1 } });
  assert.equal(notMine.status, 400, "A worker with no share cannot submit against the stage");
  assert.match(String(notMine.data.error), /split between 2 workers/);

  const stage = (await api("GET", `/api/operations?batchId=${w.batchId}`, { cookie: w.owner.cookie })).data.find((j: any) => j.stage === "SEWING");
  assert.equal(stage.quantityCompleted, 0, "Neither attempt moved a quantity");
});

// ---------------------------------------------------------------------------
// 5. Inspection of a split stage: attribution is asked for, never invented.
// ---------------------------------------------------------------------------

test("inspecting a split stage requires saying whose work was judged", async () => {
  const w = await hundredPolosAtSewing();
  const a = await tailor(w.owner.cookie, "Tailor A");
  const b = await tailor(w.owner.cookie, "Tailor B");
  const c = await tailor(w.owner.cookie, "Tailor C");
  await expectStatus(await allocate(w, a.id, 40, 450), 201, "A 40");
  await expectStatus(await allocate(w, b.id, 35, 400), 201, "B 35");
  await expectStatus(await allocate(w, c.id, 25, 500), 201, "C 25");
  for (const [person, qty] of [[a, 40], [b, 35], [c, 25]] as const) {
    await expectStatus(
      await api("PUT", "/api/operations", { cookie: person.login, body: { id: w.sewing.id, submitQty: qty } }),
      200, `${person.name} submits their whole share`
    );
  }
  const rows = await allocationsOf(w.owner.cookie, w.sewing.id);
  const byWorker = new Map<number, any>(rows.map((row: any) => [row.workerId, row]));

  // No attribution at all: the server refuses rather than picking a rule.
  const unattributed = await api("POST", "/api/inspections", {
    cookie: w.owner.cookie,
    body: { operationId: w.sewing.id, quantityApproved: 90, quantityRework: 6, quantityRejected: 4, notes: "Mixed pile" },
  });
  assert.equal(unattributed.status, 400, "A split stage cannot be inspected without saying who made what");
  assert.match(String(unattributed.data.error), /attributions/i);

  // Attributions that do not add up to the inspection itself.
  const wrongTotals = await api("POST", "/api/inspections", {
    cookie: w.owner.cookie,
    body: {
      operationId: w.sewing.id, quantityApproved: 90, quantityRework: 6, quantityRejected: 4, notes: "Mixed pile",
      attributions: [
        { allocationId: byWorker.get(a.id).id, quantityApproved: 40, quantityRework: 0, quantityRejected: 0 },
        { allocationId: byWorker.get(b.id).id, quantityApproved: 30, quantityRework: 0, quantityRejected: 0 },
      ],
    },
  });
  assert.equal(wrongTotals.status, 400, "70 approved attributed against an inspection of 90");
  assert.match(String(wrongTotals.data.error), /must add up to the inspection itself/);

  // More attributed to one worker than they have un-judged.
  const tooMuch = await api("POST", "/api/inspections", {
    cookie: w.owner.cookie,
    body: {
      operationId: w.sewing.id, quantityApproved: 90, quantityRework: 6, quantityRejected: 4, notes: "Mixed pile",
      attributions: [
        { allocationId: byWorker.get(a.id).id, quantityApproved: 90, quantityRework: 6, quantityRejected: 4 },
      ],
    },
  });
  assert.equal(tooMuch.status, 400, "A submitted 40, so 100 cannot be theirs");
  assert.match(String(tooMuch.data.error), /awaiting judgement/);

  // The same worker named twice.
  const twice = await api("POST", "/api/inspections", {
    cookie: w.owner.cookie,
    body: {
      operationId: w.sewing.id, quantityApproved: 90, quantityRework: 6, quantityRejected: 4, notes: "Mixed pile",
      attributions: [
        { allocationId: byWorker.get(a.id).id, quantityApproved: 36, quantityRework: 2, quantityRejected: 2 },
        { allocationId: byWorker.get(a.id).id, quantityApproved: 54, quantityRework: 4, quantityRejected: 2 },
      ],
    },
  });
  assert.equal(twice.status, 400, "One line per worker");
  assert.match(String(twice.data.error), /appears twice/);
});

test("an attributed inspection credits each worker and releases only the approved total", async () => {
  const w = await hundredPolosAtSewing();
  const a = await tailor(w.owner.cookie, "Tailor A");
  const b = await tailor(w.owner.cookie, "Tailor B");
  const c = await tailor(w.owner.cookie, "Tailor C");
  await expectStatus(await allocate(w, a.id, 40, 450), 201, "A 40 at N450");
  await expectStatus(await allocate(w, b.id, 35, 400), 201, "B 35 at N400");
  await expectStatus(await allocate(w, c.id, 25, 500), 201, "C 25 at N500");
  for (const [person, qty] of [[a, 40], [b, 35], [c, 25]] as const) {
    await api("PUT", "/api/operations", { cookie: person.login, body: { id: w.sewing.id, submitQty: qty } });
  }
  const rows = await allocationsOf(w.owner.cookie, w.sewing.id);
  const byWorker = new Map<number, any>(rows.map((row: any) => [row.workerId, row]));

  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: w.owner.cookie,
      body: {
        operationId: w.sewing.id, quantityApproved: 90, quantityRework: 6, quantityRejected: 4,
        notes: "Six to redo, four ruined",
        attributions: [
          { allocationId: byWorker.get(a.id).id, quantityApproved: 36, quantityRework: 2, quantityRejected: 2 },
          { allocationId: byWorker.get(b.id).id, quantityApproved: 32, quantityRework: 2, quantityRejected: 1 },
          { allocationId: byWorker.get(c.id).id, quantityApproved: 22, quantityRework: 2, quantityRejected: 1 },
        ],
      },
    }),
    201, "90 approved, 6 rework, 4 rejected - attributed per worker"
  );

  // The stage's own counters are the SUM of the splits, derived from the ledger.
  const stage = (await api("GET", `/api/operations?batchId=${w.batchId}`, { cookie: w.owner.cookie })).data.find((j: any) => j.stage === "SEWING");
  assert.equal(stage.quantityApproved, 90, "36 + 32 + 22");
  assert.equal(stage.quantityRework, 6, "2 + 2 + 2");
  assert.equal(stage.quantityRejected, 4, "2 + 1 + 1");
  assert.equal(stage.quantityInspected, 100);
  // The 6 rework pieces went back to the workers, so they are still outstanding:
  // remaining is received - approved - rejected, and rework is deliberately not
  // subtracted, because it still has to be made good.
  assert.equal(stage.quantityRemaining, 6, "The 6 rework pieces are still to be finished");
  assert.equal(stage.status, "IN_PROGRESS", "so the stage is not complete");

  // Each worker's own share carries their own outcome.
  const after = await allocationsOf(w.owner.cookie, w.sewing.id);
  const afterByWorker = new Map<number, any>(after.map((row: any) => [row.workerId, row]));
  assert.equal(afterByWorker.get(a.id).quantityApproved, 36);
  assert.equal(afterByWorker.get(b.id).quantityApproved, 32);
  assert.equal(afterByWorker.get(c.id).quantityApproved, 22);
  assert.equal(afterByWorker.get(c.id).quantityRejected, 1);

  // ONLY the approved total moves on - the split changes who is credited, never how
  // much the next route stage receives.
  const ironing = (await api("GET", `/api/operations?batchId=${w.batchId}`, { cookie: w.owner.cookie })).data.find((j: any) => j.stage === "IRONING");
  assert.equal(ironing.quantityReceived, 90, "Ironing receives the 90 approved, not the 100 submitted");
  assert.equal(ironing.status, "IN_PROGRESS", "and becomes workable");

  // The audit trail: one inspection row per worker credited, each with their rate.
  const history = await api("GET", `/api/inspections?operationId=${w.sewing.id}`, { cookie: w.owner.cookie });
  await expectStatus(history, 200, "Read the inspection trail");
  assert.equal(history.data.length, 3, "One row per worker credited");
  const rateByWorker = new Map<number, any>(history.data.map((row: any) => [row.workerId, row.pieceRate]));
  assert.equal(rateByWorker.get(a.id), 450, "A's own agreed rate is snapshotted");
  assert.equal(rateByWorker.get(b.id), 400, "B's");
  assert.equal(rateByWorker.get(c.id), 500, "and C's");
  assert.equal(history.data.reduce((sum: number, row: any) => sum + row.quantityApproved, 0), 90, "summing to the inspection itself");

  // The ledger carries the same attribution.
  const ledger = await api("GET", `/api/production-corrections?operationId=${w.sewing.id}`, { cookie: w.owner.cookie });
  const approvedEvents = ledger.data.filter((row: any) => row.eventType === "INSPECTION_APPROVED");
  assert.equal(approvedEvents.length, 3, "Three approved events, one per worker");
  assert.equal(approvedEvents.reduce((sum: number, row: any) => sum + row.quantity, 0), 90);
  assert.deepEqual(new Set(approvedEvents.map((row: any) => row.workerId)), new Set([a.id, b.id, c.id]), "each naming its worker");

  // And reconciliation still finds no drift.
  const report = await api("GET", `/api/production-corrections?operationId=${w.sewing.id}&reconcile=1`, { cookie: w.owner.cookie });
  assert.deepEqual(report.data.drift, [], "No counter disagrees with the ledger behind it");
});

test("pay follows the worker who made each approved garment, at their own rate", async () => {
  const w = await hundredPolosAtSewing();
  const a = await tailor(w.owner.cookie, "Tailor A");
  const b = await tailor(w.owner.cookie, "Tailor B");
  const c = await tailor(w.owner.cookie, "Tailor C");
  await expectStatus(await allocate(w, a.id, 40, 450), 201, "A 40 at N450");
  await expectStatus(await allocate(w, b.id, 35, 400), 201, "B 35 at N400");
  await expectStatus(await allocate(w, c.id, 25, 500), 201, "C 25 at N500");
  for (const [person, qty] of [[a, 40], [b, 35], [c, 25]] as const) {
    await api("PUT", "/api/operations", { cookie: person.login, body: { id: w.sewing.id, submitQty: qty } });
  }
  const rows = await allocationsOf(w.owner.cookie, w.sewing.id);
  const byWorker = new Map<number, any>(rows.map((row: any) => [row.workerId, row]));
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: w.owner.cookie,
      body: {
        operationId: w.sewing.id, quantityApproved: 90, quantityRework: 6, quantityRejected: 4, notes: "Six to redo, four ruined",
        attributions: [
          { allocationId: byWorker.get(a.id).id, quantityApproved: 36, quantityRework: 2, quantityRejected: 2 },
          { allocationId: byWorker.get(b.id).id, quantityApproved: 32, quantityRework: 2, quantityRejected: 1 },
          { allocationId: byWorker.get(c.id).id, quantityApproved: 22, quantityRework: 2, quantityRejected: 1 },
        ],
      },
    }),
    201, "Attributed inspection"
  );

  const payroll = await api("GET", "/api/payroll", { cookie: w.owner.cookie });
  await expectStatus(payroll, 200, "Load the month's payroll");
  const byId = new Map<number, any>(payroll.data.workers.map((row: any) => [row.workerId, row]));
  assert.equal(byId.get(a.id).pieces, 36, "A is credited with the 36 they made");
  assert.equal(byId.get(a.id).piecework, 36 * 450, "at the N450 agreed with A");
  assert.equal(byId.get(b.id).pieces, 32, "B with the 32 they made");
  assert.equal(byId.get(b.id).piecework, 32 * 400, "at the N400 agreed with B");
  assert.equal(byId.get(c.id).pieces, 22, "C with the 22 they made");
  assert.equal(byId.get(c.id).piecework, 22 * 500, "at the N500 agreed with C");
  // Rework and rejects are nobody's to be paid for.
  assert.equal(byId.get(a.id).piecework + byId.get(b.id).piecework + byId.get(c.id).piecework, 36 * 450 + 32 * 400 + 22 * 500);

  // Each worker's own earnings view agrees with the payroll sheet.
  for (const [person, pieces, rate] of [[a, 36, 450], [b, 32, 400], [c, 22, 500]] as const) {
    const mine = await api("GET", "/api/dashboard?view=my-work", { cookie: person.login });
    await expectStatus(mine, 200, `${person.name}'s own earnings`);
    assert.equal(mine.data.earnings.total, pieces * rate, `${person.name} sees their own ${pieces} approved at N${rate}`);
  }

  // The Workers page agrees too, and does not double-count the stage's first worker.
  const list = await api("GET", "/api/workers", { cookie: w.owner.cookie });
  await expectStatus(list, 200, "Load the workers list");
  const listById = new Map<number, any>(list.data.map((row: any) => [row.id, row]));
  assert.equal(listById.get(a.id).approved, 36, "A's approved figure is their share, not the stage's 90");
  assert.equal(listById.get(b.id).approved, 32);
  assert.equal(listById.get(c.id).approved, 22);
  assert.equal(listById.get(a.id).assigned, 40, "and A is allocated 40, not the whole 100");
});

// ---------------------------------------------------------------------------
// 6. Separation of duties and authorization survive the split.
// ---------------------------------------------------------------------------

test("a supervisor who holds a share of a stage cannot inspect it", async () => {
  const owner = await createOwner();
  const name = unique("Supervisor Tailor");
  const profile = await createWorker(owner.cookie, { name, specialty: "Tailor", roles: ["Tailor"], paymentType: "PER_PIECE" });
  const manager = await createStaff(owner.cookie, { name, role: "PRODUCTION_MANAGER", workerId: profile.id });
  const order = await createOrder(owner.cookie, { quantity: 20, unitPrice: 4500 });
  const batch = await api("POST", "/api/batches", {
    cookie: owner.cookie,
    body: { orderId: order.orderId, orderItemId: order.itemId, quantity: 20, stages: [{ stage: "SEWING" }] },
  });
  await expectStatus(batch, 201, "A one-stage sewing route");
  const sewing = (await api("GET", `/api/operations?batchId=${batch.data.id}`, { cookie: owner.cookie })).data[0];

  // Give the supervisor a share, and someone else the rest. The stage's own
  // worker_id is not the supervisor, so only the allocation reveals the conflict.
  const other = await tailor(owner.cookie, "Other Tailor");
  await expectStatus(
    await api("POST", "/api/allocations", { cookie: owner.cookie, body: { operationId: sewing.id, workerId: other.id, quantity: 10, pieceRate: 400 } }),
    201, "Another tailor takes 10"
  );
  await expectStatus(
    await api("POST", "/api/allocations", { cookie: manager.cookie, body: { operationId: sewing.id, workerId: profile.id, quantity: 10, pieceRate: 400 } }),
    201, "The supervisor takes 10 of their own stage"
  );
  await api("PUT", "/api/operations", { cookie: manager.cookie, body: { id: sewing.id, submitQty: 10 } });

  const selfInspect = await api("POST", "/api/inspections", {
    cookie: manager.cookie, body: { operationId: sewing.id, quantityApproved: 10 },
  });
  assert.equal(selfInspect.status, 403, "Holding a share is enough to disqualify the inspector");
  assert.match(String(selfInspect.data.error), /your own production work/i);

  const shares = await allocationsOf(owner.cookie, sewing.id);
  const mineShare = shares.find((row: any) => row.workerId === profile.id);
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: owner.cookie,
      body: {
        operationId: sewing.id, quantityApproved: 10,
        attributions: [{ allocationId: mineShare.id, quantityApproved: 10, quantityRework: 0, quantityRejected: 0 }],
      },
    }),
    201, "The Owner can still inspect it, crediting the supervisor's own share"
  );
  const credited = await api("GET", `/api/inspections?operationId=${sewing.id}`, { cookie: owner.cookie });
  assert.equal(credited.data[0].workerId, profile.id, "and the pieces are attributed to the person who made them");
});

test("a worker cannot reach the allocation endpoints at all", async () => {
  const w = await hundredPolosAtSewing();
  const a = await tailor(w.owner.cookie, "Tailor A");
  const b = await tailor(w.owner.cookie, "Tailor B");
  await expectStatus(await allocate(w, a.id, 40, 450), 201, "A takes 40");

  const selfAllocate = await api("POST", "/api/allocations", {
    cookie: a.login, body: { operationId: w.sewing.id, workerId: a.id, quantity: 60, pieceRate: 999 },
  });
  assert.equal(selfAllocate.status, 403, "Allocating work is a supervisor authority");

  const selfTransfer = await api("PUT", "/api/allocations", {
    cookie: a.login, body: { id: 1, toWorkerId: b.id, reason: "Giving my work away" },
  });
  assert.equal(selfTransfer.status, 403, "And so is moving it");

  // A worker may see their OWN allocations, and only their own.
  const mine = await api("GET", `/api/allocations?workerId=${a.id}`, { cookie: a.login });
  await expectStatus(mine, 200, "A can read their own share");
  assert.equal(mine.data.length, 1);
  const someoneElses = await api("GET", `/api/allocations?workerId=${b.id}`, { cookie: a.login });
  await expectStatus(someoneElses, 200, "But the worker filter cannot be widened past themselves");
  assert.equal(someoneElses.data.length, 0, "Asking for another worker's shares returns nothing");
});

test("an outsourced or bought-in stage cannot be split between workers", async () => {
  const w = await hundredPolosAtSewing();
  const owner = w.owner;
  const order = await createOrder(owner.cookie, { quantity: 20, unitPrice: 4500 });
  const batch = await api("POST", "/api/batches", {
    cookie: owner.cookie,
    body: { orderId: order.orderId, orderItemId: order.itemId, quantity: 20, stages: [{ stage: "SEWING", method: "OUTSOURCED" }] },
  });
  await expectStatus(batch, 201, "An outsourced sewing stage");
  const sewing = (await api("GET", `/api/operations?batchId=${batch.data.id}`, { cookie: owner.cookie })).data[0];
  const a = await tailor(owner.cookie, "Tailor A");
  const attempt = await api("POST", "/api/allocations", {
    cookie: owner.cookie, body: { operationId: sewing.id, workerId: a.id, quantity: 10, pieceRate: 400 },
  });
  assert.equal(attempt.status, 400, "Work that leaves the factory has a vendor, not a workforce");
  assert.match(String(attempt.data.error), /External Work & Ready-made/);
});

// ---------------------------------------------------------------------------
// 7. Splitting an already-working stage carries the original worker's work over.
// ---------------------------------------------------------------------------

test("splitting a stage that is already being worked keeps the original worker's work theirs", async () => {
  const w = await hundredPolosAtSewing();
  const a = await tailor(w.owner.cookie, "Tailor A");
  // Assign A to the whole stage the original way, and let them work some of it.
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: w.owner.cookie, body: { id: w.sewing.id, workerId: a.id, pieceRate: 450, status: "IN_PROGRESS" } }),
    200, "A is assigned the whole stage"
  );
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: a.login, body: { id: w.sewing.id, submitQty: 25 } }),
    200, "A submits 25 before anyone thinks to split it"
  );

  const b = await tailor(w.owner.cookie, "Tailor B");
  await expectStatus(await allocate(w, b.id, 50, 400), 201, "Now split: B takes 50");

  const rows = await allocationsOf(w.owner.cookie, w.sewing.id);
  const carried = rows.find((row) => row.workerId === a.id);
  assert.ok(carried, "A was given a share automatically");
  assert.equal(carried.quantityAllocated, 25, "equal to the work A had already submitted");
  assert.equal(carried.quantitySubmitted, 25, "which is still counted as A's");
  assert.equal(carried.pieceRate, 450, "at the rate already agreed with A");
  assert.match(String(carried.reason), /Carried over/i, "and labelled as carried over, not invented");
  assert.equal(rows.find((row) => row.workerId === b.id).quantityAllocated, 50, "B's 50 is on top of it");
  assert.equal(rows[0].stageFree, 25, "100 - 25 - 50 = 25 still free");

  // A's 25 can now be judged and paid as A's, which is the whole point.
  const byWorker = new Map<number, any>(rows.map((row: any) => [row.workerId, row]));
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: w.owner.cookie,
      body: {
        operationId: w.sewing.id, quantityApproved: 25,
        attributions: [{ allocationId: byWorker.get(a.id).id, quantityApproved: 25, quantityRework: 0, quantityRejected: 0 }],
      },
    }),
    201, "A's 25 are inspected and attributed to A"
  );
  const payroll = await api("GET", `/api/payroll?workerId=${a.id}`, { cookie: w.owner.cookie });
  await expectStatus(payroll, 200, "A's payroll");
  const accrual = payroll.data.history[payroll.data.history.length - 1];
  assert.equal(accrual.pieces, 25, "A is paid for the 25 they made");
  assert.equal(accrual.piecework, 25 * 450, "at the N450 agreed with A");
});

// ---------------------------------------------------------------------------
// 8. An unsplit stage behaves exactly as it did before split allocation existed.
// ---------------------------------------------------------------------------

test("a stage with one worker still inspects as one row and pays as it always did", async () => {
  const w = await hundredPolosAtSewing();
  const a = await tailor(w.owner.cookie, "Tailor A");
  await expectStatus(await allocate(w, a.id, 100, 450), 201, "One worker takes the whole stage");
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: a.login, body: { id: w.sewing.id, submitQty: 100 } }),
    200, "and submits all 100"
  );
  // No attributions needed: there is only one person to attribute to.
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: w.owner.cookie,
      body: { operationId: w.sewing.id, quantityApproved: 95, quantityRejected: 5, notes: "Five ruined" },
    }),
    201, "Inspected without a per-worker breakdown"
  );
  const history = await api("GET", `/api/inspections?operationId=${w.sewing.id}`, { cookie: w.owner.cookie });
  assert.equal(history.data.length, 1, "One inspection row, as before");
  assert.equal(history.data[0].workerId, a.id, "attributed to the only worker");
  assert.equal(history.data[0].pieceRate, 450, "at the rate agreed for this stage");

  const ironing = (await api("GET", `/api/operations?batchId=${w.batchId}`, { cookie: w.owner.cookie })).data.find((j: any) => j.stage === "IRONING");
  assert.equal(ironing.quantityReceived, 95, "and only the approved 95 move on");
});

test("a stage that was never split is untouched by all of this", async () => {
  const w = await hundredPolosAtSewing();
  const a = await tailor(w.owner.cookie, "Tailor A");
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: w.owner.cookie, body: { id: w.sewing.id, workerId: a.id, pieceRate: 450, status: "IN_PROGRESS" } }),
    200, "Assigned the original way, with no allocations at all"
  );
  assert.equal((await allocationsOf(w.owner.cookie, w.sewing.id)).length, 0, "No allocation rows exist");
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: a.login, body: { id: w.sewing.id, submitQty: 100 } }),
    200, "A submits through the original path"
  );
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: w.owner.cookie, body: { operationId: w.sewing.id, quantityApproved: 100 },
    }),
    201, "And is inspected through the original path"
  );
  const history = await api("GET", `/api/inspections?operationId=${w.sewing.id}`, { cookie: w.owner.cookie });
  assert.equal(history.data[0].workerId, null, "The inspection row is unattributed, exactly as every historical row is");
  const payroll = await api("GET", `/api/payroll?workerId=${a.id}`, { cookie: w.owner.cookie });
  const accrual = payroll.data.history[payroll.data.history.length - 1];
  assert.equal(accrual.piecework, 100 * 450, "and pay is still attributed through the stage's own worker");
});

test("the inspection trail names the worker credited, and a worker sees only their own rows", async () => {
  const w = await hundredPolosAtSewing();
  const a = await tailor(w.owner.cookie, "Tailor A");
  const b = await tailor(w.owner.cookie, "Tailor B");
  await expectStatus(await allocate(w, a.id, 60, 450), 201, "A takes 60");
  await expectStatus(await allocate(w, b.id, 40, 400), 201, "B takes 40");
  await api("PUT", "/api/operations", { cookie: a.login, body: { id: w.sewing.id, submitQty: 60 } });
  await api("PUT", "/api/operations", { cookie: b.login, body: { id: w.sewing.id, submitQty: 40 } });
  const rows = await allocationsOf(w.owner.cookie, w.sewing.id);
  const byWorker = new Map<number, any>(rows.map((row: any) => [row.workerId, row]));
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: w.owner.cookie,
      body: {
        operationId: w.sewing.id, quantityApproved: 92, quantityRejected: 8, notes: "Eight ruined",
        attributions: [
          { allocationId: byWorker.get(a.id).id, quantityApproved: 55, quantityRework: 0, quantityRejected: 5 },
          { allocationId: byWorker.get(b.id).id, quantityApproved: 37, quantityRework: 0, quantityRejected: 3 },
        ],
      },
    }),
    201, "Attributed inspection"
  );

  // The Owner sees both rows, each naming the worker it credits.
  const ownerView = await api("GET", `/api/inspections?operationId=${w.sewing.id}`, { cookie: w.owner.cookie });
  await expectStatus(ownerView, 200, "Owner reads the trail");
  assert.equal(ownerView.data.length, 2, "One row per worker credited");
  const nameByWorker = new Map(ownerView.data.map((row: any) => [row.workerId, row.workerName]));
  assert.equal(nameByWorker.get(a.id), a.name, "A's row names A, not the stage's nominal worker");
  assert.equal(nameByWorker.get(b.id), b.name, "and B's row names B");

  // Each worker sees only their own row - a shared stage must not leak one
  // tailor's approved pieces and rate to another.
  const aView = await api("GET", `/api/inspections?operationId=${w.sewing.id}`, { cookie: a.login });
  await expectStatus(aView, 200, "A reads the trail");
  assert.equal(aView.data.length, 1, "A sees one row");
  assert.equal(aView.data[0].workerId, a.id, "and it is A's own");
  assert.equal(aView.data[0].quantityApproved, 55);
  assert.equal(aView.data[0].pieceRate, 450, "at A's own rate");

  const bView = await api("GET", `/api/inspections?operationId=${w.sewing.id}`, { cookie: b.login });
  await expectStatus(bView, 200, "B reads the trail");
  assert.equal(bView.data.length, 1, "B sees one row");
  assert.equal(bView.data[0].workerId, b.id, "and it is B's own");
  assert.equal(bView.data[0].quantityApproved, 37);
  assert.equal(bView.data[0].pieceRate, 400, "at B's own rate");
});

// ---------------------------------------------------------------------------
// 9. The attribution rule itself, as a pure function.
// ---------------------------------------------------------------------------

test("validateAttributions is a pure rule: totals must match and no share may exceed its own unjudged work", () => {
  const allocation = (id: number, submitted: number, approved = 0, rework = 0, rejected = 0) => ({
    id, productionOperationId: 1, productionBatchId: 1, stage: "SEWING", workerId: id,
    quantityAllocated: submitted, quantitySubmitted: submitted, quantityApproved: approved,
    quantityRework: rework, quantityRejected: rejected, status: "ASSIGNED",
  }) as any;
  const allocations = [allocation(1, 40), allocation(2, 35)];
  const totals = { approved: 70, rework: 3, rejected: 2 };

  assert.equal(allocationRemaining({ quantityAllocated: 40, quantitySubmitted: 15 }), 25, "remaining is allocated minus submitted");
  assert.equal(allocationUnjudged({ quantitySubmitted: 40, quantityApproved: 30, quantityRework: 5, quantityRejected: 2 }), 3, "unjudged is submitted minus everything already judged");

  const good = validateAttributions(allocations, [
    { allocationId: 1, quantityApproved: 38, quantityRework: 2, quantityRejected: 0 },
    { allocationId: 2, quantityApproved: 32, quantityRework: 1, quantityRejected: 2 },
  ], totals);
  assert.equal(good.ok, true, "A correct split is accepted");

  const missing = validateAttributions(allocations, undefined, totals);
  assert.equal(missing.ok, false, "No attributions at all is refused");

  const shortSum = validateAttributions(allocations, [
    { allocationId: 1, quantityApproved: 38, quantityRework: 2, quantityRejected: 0 },
  ], totals);
  assert.equal(shortSum.ok, false, "A split that does not reach the inspection total is refused");
  assert.match((shortSum as any).error, /must add up/);

  const overShare = validateAttributions(allocations, [
    { allocationId: 1, quantityApproved: 40, quantityRework: 3, quantityRejected: 2 },
    { allocationId: 2, quantityApproved: 30, quantityRework: 0, quantityRejected: 0 },
  ], totals);
  assert.equal(overShare.ok, false, "Attributing 45 to a worker who submitted 40 is refused");
  assert.match((overShare as any).error, /awaiting judgement/);

  const foreign = validateAttributions(allocations, [
    { allocationId: 99, quantityApproved: 70, quantityRework: 3, quantityRejected: 2 },
  ], totals);
  assert.equal(foreign.ok, false, "An allocation from another stage is refused");

  const duplicate = validateAttributions(allocations, [
    { allocationId: 1, quantityApproved: 35, quantityRework: 2, quantityRejected: 1 },
    { allocationId: 1, quantityApproved: 35, quantityRework: 1, quantityRejected: 1 },
  ], totals);
  assert.equal(duplicate.ok, false, "The same worker named twice is refused");

  const negative = validateAttributions(allocations, [
    { allocationId: 1, quantityApproved: -5, quantityRework: 8, quantityRejected: 2 },
    { allocationId: 2, quantityApproved: 75, quantityRework: -5, quantityRejected: 0 },
  ], totals);
  assert.equal(negative.ok, false, "Negative quantities are refused");
});
