/**
 * THE TAILOR'S HAND-OUT, END TO END, AGAINST THE REAL HANDLERS.
 *
 * A Tailor who holds production hands part of it to a Support Worker. These tests drive
 * that chain through the real routes and the real database (the in-memory Postgres shim):
 *
 *   sign-in identity -> the Tailor holds production -> the production is offered
 *   -> the hand-out is checked on the server -> the helper gets the exact garment
 *   -> the lifecycle moves -> the pause shows on Production Control -> pay follows approval.
 *
 * Every fixture is created through the API, except a second organisation, which has no
 * API (the same convention the other cross-organisation tests use).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations, supportAssignments, users, workers } from "@/db/schema";
import { hashPassword } from "@/lib/password";
import { rolesForWorkerIds } from "@/lib/worker-roles";
import {
  api,
  expectStatus,
  createOwner,
  createStaff,
  createWorker,
  createOrder,
  signIn,
  startSupport,
  pauseSupport,
  resumeSupport,
  testEmail,
} from "./support/harness";
import { SUPPORT_ROLE } from "@/lib/format";
import { currentMonth } from "@/lib/payroll";

let n = 0;
const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}${(n += 1)}`;

/** A tailor with a login, and the profile the login is linked to by name. */
async function tailor(ownerCookie: string, label: string) {
  const name = unique(label);
  const profile = await createWorker(ownerCookie, {
    name, specialty: "Tailor", roles: ["Tailor"], paymentType: "PER_PIECE", paymentRate: 300,
  });
  const login = await createStaff(ownerCookie, { name, role: "WORKER" });
  return { ...profile, name, login: login.cookie, email: login.email, password: login.password };
}

/** A support worker with a login. */
async function helper(ownerCookie: string, label: string) {
  const name = unique(label);
  const profile = await createWorker(ownerCookie, {
    name, specialty: SUPPORT_ROLE, roles: [SUPPORT_ROLE], paymentType: "PER_PIECE",
  });
  const login = await createStaff(ownerCookie, { name, role: "WORKER" });
  return { ...profile, name, login: login.cookie };
}

/**
 * An order with one variant (Navy, size 10) of `quantity` pieces, and the tailor's SEWING
 * job for `pieces` of them. SEWING is the first stage, so every piece has reached it.
 */
async function world(quantity = 100) {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity, unitPrice: 4500 });
  await expectStatus(
    await api("POST", "/api/order-sizes", {
      cookie: owner.cookie,
      body: { itemId: order.itemId, sizes: [{ size: "10", color: "Navy", quantity }] },
    }),
    201, "Record the order's exact variant"
  );
  const listed = await api("GET", `/api/order-sizes?itemId=${order.itemId}`, { cookie: owner.cookie });
  const variant = (await expectStatus(listed, 200, "Load the variant")).sizes[0];
  const tailorA = await tailor(owner.cookie, "Tailor A");
  const tailorB = await tailor(owner.cookie, "Tailor B");
  const weaver = await helper(owner.cookie, "Weaver");
  return { owner, order, variant, tailorA, tailorB, weaver };
}

/** Give `who` the SEWING stage of a new batch of `pieces`, returning that stage job. */
async function sewingFor(w: Awaited<ReturnType<typeof world>>, who: { id: number }, pieces: number) {
  const batch = await api("POST", "/api/batches", {
    cookie: w.owner.cookie,
    body: {
      orderId: w.order.orderId, orderItemId: w.order.itemId, orderVariantId: w.variant.id, quantity: pieces,
      stages: [{ stage: "SEWING" }],
      assignments: [{ stage: "SEWING", workerId: who.id, pieceRate: 300 }],
    },
  });
  await expectStatus(batch, 201, `Start ${pieces} pieces on the tailor's SEWING stage`);
  const jobs = await api("GET", `/api/operations?batchId=${batch.data.id}`, { cookie: w.owner.cookie });
  const sewing = (await expectStatus(jobs, 200, "Read the stage")).find((job: any) => job.stage === "SEWING");
  return { batchId: batch.data.id as number, batchNumber: batch.data.batchNumber as string, sewing };
}

/** What a login may hand out from right now. */
async function delegable(cookie: string) {
  return expectStatus(await api("GET", "/api/support-work?delegable=1", { cookie }), 200, "Read the production on offer");
}

/** A hand-out as the server records it, with the ceiling it was checked against. */
function handOut(cookie: string, body: Record<string, unknown>) {
  return api("POST", "/api/support-work", { cookie, body });
}

/** The row for one stage in the delegable list. */
const stageOffer = (list: any[], operationId: number) =>
  list.find((source) => source.kind === "STAGE" && source.productionOperationId === operationId);

// ---------------------------------------------------------------------------
// 1. Who the signed-in person is, from the moment they sign in
// ---------------------------------------------------------------------------

test("a tailor's sign-in names their own worker profile, so the page knows who they are without a reload", async () => {
  const owner = await createOwner();
  const t = await tailor(owner.cookie, "Sign-in Tailor");
  const login = await api("POST", "/api/auth/login", { body: { email: t.email, password: t.password } });
  await expectStatus(login, 200, "Sign in as the tailor");
  assert.equal(login.data.workerId, t.id, "the login response carries the linked worker profile");
  assert.equal(login.data.workerName, t.name);
  const me = await expectStatus(await api("GET", "/api/auth/me", { cookie: t.login }), 200, "Session check");
  assert.equal(me.workerId, login.data.workerId, "and it is the same answer /api/auth/me gives");
});

// ---------------------------------------------------------------------------
// 2. Access: who may hand out, and from what
// ---------------------------------------------------------------------------

test("a tailor who holds an ordinary SEWING job is offered it, with the exact garment and the full ceiling", async () => {
  const w = await world();
  const { sewing, batchNumber } = await sewingFor(w, w.tailorA, 70);

  const offered = await delegable(w.tailorA.login);
  const source = stageOffer(offered, sewing.id);
  assert.ok(source, "the stage the tailor holds is on offer - it has no share, and was previously invisible");
  assert.equal(source.eligible, true, "so the button is shown");
  assert.equal(source.holderWorkerId, w.tailorA.id);
  assert.equal(source.holding, 70, "the pieces that reached the stage");
  assert.equal(source.batchNumber, batchNumber);
  assert.equal(source.garment, "Test Uniform Shirt", "the exact garment, not just the order");
  assert.match(source.variant, /Navy/);
  assert.match(source.variant, /10/);
  assert.equal(source.operations.find((o: any) => o.operation === "Weaving").remaining, 70);
});

test("a tailor with no production has nothing to hand out, and cannot create support work at all", async () => {
  const w = await world();
  await sewingFor(w, w.tailorA, 40);
  const idle = await tailor(w.owner.cookie, "Idle Tailor");

  assert.deepEqual(await delegable(idle.login), [], "nothing is offered to a tailor with no production");

  const free = await handOut(idle.login, { workerId: w.weaver.id, operation: "Weaving", quantityAssigned: 10, pieceRate: 30 });
  assert.equal(free.status, 400, "a hand-out with no production behind it is refused");
  assert.match(String(free.data.error), /comes from/i);

  const onSomeoneElses = await handOut(idle.login, {
    workerId: w.weaver.id, operation: "Weaving", quantityAssigned: 10, pieceRate: 30,
    productionOperationId: (await delegable(w.tailorA.login)).find((s: any) => s.kind === "STAGE").productionOperationId,
  });
  assert.equal(onSomeoneElses.status, 403, "pointing it at production they do not hold is refused");

  const written = await db.select().from(supportAssignments).where(eq(supportAssignments.assignedByWorkerId, idle.id));
  assert.equal(written.length, 0, "and nothing was written for them");
});

test("a tailor sees and may hand out only their own production, never another tailor's", async () => {
  const w = await world();
  const mine = await sewingFor(w, w.tailorA, 40);
  const theirs = await sewingFor(w, w.tailorB, 30);

  const aSees = await delegable(w.tailorA.login);
  assert.ok(stageOffer(aSees, mine.sewing.id), "A sees A's stage");
  assert.ok(!stageOffer(aSees, theirs.sewing.id), "A does not see B's stage");
  const bSees = await delegable(w.tailorB.login);
  assert.ok(!stageOffer(bSees, mine.sewing.id), "B does not see A's stage");

  const stolen = await handOut(w.tailorB.login, {
    workerId: w.weaver.id, operation: "Weaving", quantityAssigned: 5, pieceRate: 30,
    productionOperationId: mine.sewing.id,
  });
  assert.equal(stolen.status, 403, "B cannot hand out from A's stage");
  assert.match(String(stolen.data.error), /pieces you hold yourself/i);
});

test("a stage split between tailors is handed out only through each tailor's own share", async () => {
  const w = await world();
  // Split SEWING between two tailors: A gets 18 of the 30, B the other 12.
  const split = await api("POST", "/api/batches", {
    cookie: w.owner.cookie,
    body: {
      orderId: w.order.orderId, orderItemId: w.order.itemId, orderVariantId: w.variant.id, quantity: 30,
      stages: [{ stage: "SEWING" }],
    },
  });
  await expectStatus(split, 201, "Start 30 pieces on a SEWING stage with nobody on it yet");
  const jobs = await api("GET", `/api/operations?batchId=${split.data.id}`, { cookie: w.owner.cookie });
  const stage = (await expectStatus(jobs, 200, "Read the stage")).find((job: any) => job.stage === "SEWING");
  await expectStatus(await api("POST", "/api/allocations", { cookie: w.owner.cookie, body: { operationId: stage.id, workerId: w.tailorA.id, quantity: 18, pieceRate: 300 } }), 201, "Share 18 to A");
  await expectStatus(await api("POST", "/api/allocations", { cookie: w.owner.cookie, body: { operationId: stage.id, workerId: w.tailorB.id, quantity: 12, pieceRate: 300 } }), 201, "Share 12 to B");

  const aOffer = await delegable(w.tailorA.login);
  const share = aOffer.find((s: any) => s.kind === "SHARE" && s.productionOperationId === stage.id);
  assert.ok(share, "A is offered their own share");
  assert.equal(share.holding, 18, "at A's share, not the whole stage");
  assert.equal(share.holderWorkerId, w.tailorA.id);
  const wholeStage = stageOffer(aOffer, stage.id);
  assert.ok(wholeStage, "the split stage is listed so the reason can be shown");
  assert.equal(wholeStage.eligible, false, "but it cannot be handed out from as a whole");
  assert.match(wholeStage.blockedReason, /split between workers/i);

  const whole = await handOut(w.tailorA.login, {
    workerId: w.weaver.id, operation: "Weaving", quantityAssigned: 5, pieceRate: 30, productionOperationId: stage.id,
  });
  assert.equal(whole.status, 400, "a split stage cannot be handed out as a whole");
  assert.match(String(whole.data.error), /split between workers/i);

  const bShare = (await delegable(w.tailorB.login)).find((s: any) => s.kind === "SHARE");
  const aShareId = share.productionAllocationId;
  const stolen = await handOut(w.tailorB.login, {
    workerId: w.weaver.id, operation: "Weaving", quantityAssigned: 5, pieceRate: 30, productionAllocationId: aShareId,
  });
  assert.equal(stolen.status, 403, "B cannot hand out from A's share");
  assert.ok(bShare.holding === 12, "B's own share is 12");
});

test("a closed share cannot be handed out from, even by the tailor it used to belong to", async () => {
  const w = await world();
  const split = await api("POST", "/api/batches", {
    cookie: w.owner.cookie,
    body: {
      orderId: w.order.orderId, orderItemId: w.order.itemId, orderVariantId: w.variant.id, quantity: 20,
      stages: [{ stage: "SEWING" }],
    },
  });
  await expectStatus(split, 201, "Start 20 pieces");
  const jobs = await api("GET", `/api/operations?batchId=${split.data.id}`, { cookie: w.owner.cookie });
  const stage = (await expectStatus(jobs, 200, "Read the stage")).find((job: any) => job.stage === "SEWING");
  const share = await expectStatus(
    await api("POST", "/api/allocations", { cookie: w.owner.cookie, body: { operationId: stage.id, workerId: w.tailorA.id, quantity: 20, pieceRate: 300 } }),
    201, "Share 20 to A"
  );
  // Moving unworked work to B closes A's share.
  await expectStatus(
    await api("PUT", "/api/allocations", { cookie: w.owner.cookie, body: { id: share.id, toWorkerId: w.tailorB.id, reason: "Reassigned to B" } }),
    200, "Move the unworked share to B"
  );

  const aOffer = await delegable(w.tailorA.login);
  assert.ok(!aOffer.some((s: any) => s.productionAllocationId === share.id), "A's closed share is no longer offered");
  const attempt = await handOut(w.tailorA.login, {
    workerId: w.weaver.id, operation: "Weaving", quantityAssigned: 5, pieceRate: 30, productionAllocationId: share.id,
  });
  assert.equal(attempt.status, 400, "and cannot be used by a direct request");
  assert.match(String(attempt.data.error), /closed/i);
});

test("a finished stage drops off the offer list, but a hand-out naming it still reconciles approved pieces", async () => {
  const w = await world(100);
  const { sewing } = await sewingFor(w, w.tailorA, 100);
  await expectStatus(await api("PUT", "/api/operations", { cookie: w.tailorA.login, body: { id: sewing.id, submitQty: 100 } }), 200, "Tailor submits all 100");
  await expectStatus(
    await api("POST", "/api/inspections", { cookie: w.owner.cookie, body: { operationId: sewing.id, quantityApproved: 100, quantityRework: 0, quantityRejected: 0 } }),
    201, "All 100 approved, so the stage is finished"
  );
  const finished = (await expectStatus(await api("GET", `/api/operations?batchId=${sewing.productionBatchId}`, { cookie: w.owner.cookie }), 200, "Read"))
    .find((job: any) => job.id === sewing.id);
  assert.equal(finished.status, "COMPLETED");

  assert.equal(stageOffer(await delegable(w.tailorA.login), sewing.id), undefined, "a finished garment is not offered as open work");

  // Approved pieces still have a helper behind them, so a hand-out naming it is reconciled.
  await expectStatus(
    await handOut(w.tailorA.login, { workerId: w.weaver.id, operation: "Weaving", quantityAssigned: 20, pieceRate: 30, productionOperationId: sewing.id }),
    201, "A hand-out naming the finished stage is still accepted"
  );
});

test("a supervisor records a hand-over under the holder's name, never the typist's", async () => {
  const w = await world();
  const { sewing } = await sewingFor(w, w.tailorA, 20);
  const manager = await createStaff(w.owner.cookie, { name: unique("Project Manager"), role: "PRODUCTION_MANAGER" });

  const created = await handOut(manager.cookie, {
    workerId: w.weaver.id, operation: "Taping", quantityAssigned: 5, pieceRate: 30,
    productionOperationId: sewing.id, assignedByWorkerId: w.tailorB.id,
  });
  await expectStatus(created, 201, "A manager records 5 pieces of taping from A's stage");
  assert.equal(created.data.assignedByWorkerId, w.tailorA.id, "recorded under the tailor who holds the stage");
});

// ---------------------------------------------------------------------------
// 3. Quantity: enforced on the server, per operation, and reduced by what is out
// ---------------------------------------------------------------------------

test("a quantity that is zero, negative, fractional or above what is held is refused", async () => {
  const w = await world();
  const { sewing } = await sewingFor(w, w.tailorA, 20);
  const base = { workerId: w.weaver.id, operation: "Weaving", pieceRate: 30, productionOperationId: sewing.id };

  for (const quantityAssigned of [0, -5, 1.5, "abc"]) {
    const bad = await handOut(w.tailorA.login, { ...base, quantityAssigned });
    assert.equal(bad.status, 400, `quantity ${String(quantityAssigned)} is refused`);
  }
  const tooMany = await handOut(w.tailorA.login, { ...base, quantityAssigned: 21 });
  assert.equal(tooMany.status, 400, "21 pieces cannot be handed out from 20 held");
  assert.match(String(tooMany.data.error), /Only 20 piece/);

  await expectStatus(await handOut(w.tailorA.login, { ...base, quantityAssigned: 20 }), 201, "All 20 can be handed out");
});

test("existing hand-outs reduce what is left, per supporting operation", async () => {
  const w = await world();
  const { sewing } = await sewingFor(w, w.tailorA, 20);
  const base = { workerId: w.weaver.id, pieceRate: 30, productionOperationId: sewing.id };

  await expectStatus(await handOut(w.tailorA.login, { ...base, operation: "Weaving", quantityAssigned: 12 }), 201, "12 weaving");
  const over = await handOut(w.tailorA.login, { ...base, operation: "Weaving", quantityAssigned: 9 });
  assert.equal(over.status, 400, "only 8 weaving are left, so 9 is refused");
  assert.match(String(over.data.error), /Only 8 piece/);

  await expectStatus(await handOut(w.tailorA.login, { ...base, operation: "Weaving", quantityAssigned: 8 }), 201, "The remaining 8 weaving");
  const offer = stageOffer(await delegable(w.tailorA.login), sewing.id);
  assert.equal(offer.operations.find((o: any) => o.operation === "Weaving").remaining, 0);
  assert.equal(offer.operations.find((o: any) => o.operation === "Taping").remaining, 20, "taping is a separate operation with its own ceiling");
  await expectStatus(await handOut(w.tailorA.login, { ...base, operation: "Taping", quantityAssigned: 20 }), 201, "All 20 taping, on the same garments");
});

test("when every supporting operation is used up, the production is shown as no longer available, with the reason", async () => {
  const w = await world();
  const { sewing } = await sewingFor(w, w.tailorA, 10);
  for (const operation of ["Weaving", "Taping", "Support Work", "Other Support"]) {
    await expectStatus(
      await handOut(w.tailorA.login, { workerId: w.weaver.id, operation, quantityAssigned: 10, pieceRate: 30, productionOperationId: sewing.id }),
      201, `Hand out all 10 ${operation}`
    );
  }
  const offer = stageOffer(await delegable(w.tailorA.login), sewing.id);
  assert.equal(offer.eligible, false, "no longer offered");
  assert.match(offer.blockedReason, /already handed out/i, "with the reason");
});

test("cancelling a hand-over gives its pieces back to what can be handed out", async () => {
  const w = await world();
  const { sewing } = await sewingFor(w, w.tailorA, 20);
  const first = await expectStatus(
    await handOut(w.tailorA.login, { workerId: w.weaver.id, operation: "Weaving", quantityAssigned: 20, pieceRate: 30, productionOperationId: sewing.id }),
    201, "All 20 weaving handed out"
  );
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: w.tailorA.login, body: { id: first.id, action: "cancel", reason: "Helper not available" } }),
    200, "Withdraw the hand-over before any work"
  );
  const offer = stageOffer(await delegable(w.tailorA.login), sewing.id);
  assert.equal(offer.operations.find((o: any) => o.operation === "Weaving").remaining, 20, "the 20 are back");
  await expectStatus(
    await handOut(w.tailorA.login, { workerId: w.weaver.id, operation: "Weaving", quantityAssigned: 20, pieceRate: 30, productionOperationId: sewing.id }),
    201, "and can be handed out again"
  );
});

test("two hand-outs that together exceed what is left: only one is accepted, and nothing is over-allocated", async () => {
  const w = await world();
  const { sewing } = await sewingFor(w, w.tailorA, 20);
  const body = { workerId: w.weaver.id, operation: "Weaving", quantityAssigned: 15, pieceRate: 30, productionOperationId: sewing.id };
  const [a, b] = await Promise.all([handOut(w.tailorA.login, body), handOut(w.tailorA.login, body)]);
  assert.deepEqual([a.status, b.status].sort(), [201, 400], "exactly one of two 15s fits in 20");
  const offer = stageOffer(await delegable(w.tailorA.login), sewing.id);
  assert.equal(offer.operations.find((o: any) => o.operation === "Weaving").remaining, 5);
});

// ---------------------------------------------------------------------------
// 4. The helper's work carries the exact context, and the body cannot widen it
// ---------------------------------------------------------------------------

test("the support worker receives the exact order, garment, variant, batch and stage of the tailor's stage", async () => {
  const w = await world();
  const { sewing, batchNumber } = await sewingFor(w, w.tailorA, 20);
  const created = await expectStatus(
    await handOut(w.tailorA.login, { workerId: w.weaver.id, operation: "Taping", quantityAssigned: 8, pieceRate: 30, productionOperationId: sewing.id }),
    201, "Hand out 8 taping"
  );

  const [stored] = await db.select().from(supportAssignments).where(eq(supportAssignments.id, created.id));
  assert.equal(stored.orderId, w.order.orderId, "the order");
  assert.equal(stored.orderItemId, w.order.itemId, "the garment");
  assert.equal(stored.orderVariantId, w.variant.id, "the exact size and colour");
  assert.equal(stored.stage, "SEWING", "the stage");
  assert.equal(stored.productionOperationId, sewing.id, "the production it came from");
  assert.equal(stored.assignedByWorkerId, w.tailorA.id, "the tailor who holds it");

  const helperView = await expectStatus(await api("GET", "/api/support-work", { cookie: w.weaver.login }), 200, "Helper reads their work");
  const row = helperView.find((entry: any) => entry.id === created.id);
  assert.ok(row, "the helper sees it");
  assert.equal(row.orderNumber, w.order.orderNumber);
  assert.equal(row.garment, "Test Uniform Shirt");
  assert.match(row.variant, /Navy/);
  assert.equal(row.batchNumber, batchNumber);
  assert.equal(row.stage, "SEWING");
});

test("the request body cannot widen a hand-out: the holder, order and stage come from the production itself", async () => {
  const w = await world();
  const { sewing } = await sewingFor(w, w.tailorA, 20);
  const other = await createOrder(w.owner.cookie, { quantity: 5, unitPrice: 4500 });
  const created = await expectStatus(
    await handOut(w.tailorA.login, {
      workerId: w.weaver.id, operation: "Weaving", quantityAssigned: 5, pieceRate: 30, productionOperationId: sewing.id,
      assignedByWorkerId: w.tailorB.id, orderId: other.orderId, stage: "IRONING", orderVariantId: 999999,
    }),
    201, "A request naming someone else and another order"
  );
  assert.equal(created.assignedByWorkerId, w.tailorA.id, "the holder is recorded, not the name in the body");
  assert.equal(created.orderId, w.order.orderId, "the order is the production's order");
  assert.equal(created.stage, "SEWING", "the stage is the production's stage");
  assert.equal(created.orderVariantId, w.variant.id, "the variant is the production's variant");
});

test("a helper cannot be the tailor's own login, and cannot be given work they do not hold the role for", async () => {
  const w = await world();
  const { sewing } = await sewingFor(w, w.tailorA, 10);
  const toSelf = await handOut(w.tailorA.login, { workerId: w.tailorA.id, operation: "Weaving", quantityAssigned: 2, pieceRate: 30, productionOperationId: sewing.id });
  assert.equal(toSelf.status, 400);
  assert.match(String(toSelf.data.error), /themselves/i);

  const sales = await createWorker(w.owner.cookie, { name: unique("Sales"), specialty: "Sales", roles: ["Sales"], paymentType: "MONTHLY", paymentRate: 40000 });
  const notHelper = await handOut(w.tailorA.login, { workerId: sales.id, operation: "Weaving", quantityAssigned: 2, pieceRate: 30, productionOperationId: sewing.id });
  assert.equal(notHelper.status, 400);
  assert.match(String(notHelper.data.error), /Support Worker/);
});

// ---------------------------------------------------------------------------
// 5. Organisations
// ---------------------------------------------------------------------------

test("another organisation's staff cannot see or hand out this organisation's production", async () => {
  const w = await world();
  const { sewing } = await sewingFor(w, w.tailorA, 20);

  // A second organisation and an Owner of it, written directly: there is no API for it.
  const [existing] = await db.select().from(organizations).where(eq(organizations.id, 2));
  if (!existing) await db.insert(organizations).values({ id: 2, name: unique("Another Company") });
  const email = testEmail(unique("foreignowner").toLowerCase().replace(/[^a-z]/g, ""));
  const password = "ForeignOwner!2345";
  await db.insert(users).values({
    organizationId: 2, name: "Foreign Owner", email, passwordHash: hashPassword(password), role: "OWNER", status: "ACTIVE",
  });
  const foreign = await signIn(email, password);

  const offered = await delegable(foreign);
  assert.ok(!stageOffer(offered, sewing.id), "the other organisation's stage is not listed");

  // Refused before anything is written. The refusal may name the helper (a different
  // organisation's worker) rather than the production, which is equally a refusal.
  const attempt = await handOut(foreign, {
    workerId: w.weaver.id, operation: "Weaving", quantityAssigned: 5, pieceRate: 30, productionOperationId: sewing.id,
  });
  assert.ok([400, 404].includes(attempt.status), `and cannot be handed out from (got ${attempt.status})`);
  assert.notEqual(attempt.status, 201);
  const written = await db.select().from(supportAssignments).where(eq(supportAssignments.productionOperationId, sewing.id));
  assert.equal(written.length, 0, "nothing was written");
});

// ---------------------------------------------------------------------------
// 6. The lifecycle, through the routes
// ---------------------------------------------------------------------------

test("a hand-out moves ASSIGNED -> STARTED -> PAUSED -> RESUMED -> SUBMITTED -> APPROVED, and every move is in the trail", async () => {
  const w = await world();
  const { sewing } = await sewingFor(w, w.tailorA, 20);
  const { id } = await expectStatus(
    await handOut(w.tailorA.login, { workerId: w.weaver.id, operation: "Weaving", quantityAssigned: 20, pieceRate: 30, productionOperationId: sewing.id }),
    201, "Hand out 20 weaving"
  );
  const status = async () => (await expectStatus(await api("GET", "/api/support-work", { cookie: w.tailorA.login }), 200, "Read"))
    .find((entry: any) => entry.id === id).status;

  assert.equal(await status(), "ASSIGNED");
  await startSupport(w.weaver.login, id);
  assert.equal(await status(), "STARTED");
  await pauseSupport(w.weaver.login, id, "Thread ran out");
  assert.equal(await status(), "PAUSED");
  await resumeSupport(w.weaver.login, id);
  assert.equal(await status(), "STARTED");
  await expectStatus(await api("PUT", "/api/support-work", { cookie: w.weaver.login, body: { id, submitQty: 10 } }), 200, "Hand back 10");
  assert.equal(await status(), "SUBMITTED");
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: w.tailorA.login, body: { id, quantityApproved: 6, quantityRework: 0, quantityRejected: 0 } }),
    201, "The tailor judges 6 of the 10"
  );
  assert.equal(await status(), "SUBMITTED", "4 handed back and still unjudged");
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: w.tailorA.login, body: { id, quantityApproved: 4, quantityRework: 0, quantityRejected: 0 } }),
    201, "The tailor judges the other 4"
  );
  assert.equal(await status(), "STARTED", "10 of 20 are still owed, so the work goes back to the helper");
  await expectStatus(await api("PUT", "/api/support-work", { cookie: w.weaver.login, body: { id, submitQty: 10 } }), 200, "Hand back the rest");
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: w.tailorA.login, body: { id, quantityApproved: 10, quantityRework: 0, quantityRejected: 0 } }),
    201, "The tailor judges the last 10"
  );
  assert.equal(await status(), "APPROVED");

  const withEvents = await expectStatus(await api("GET", "/api/support-work?events=1", { cookie: w.tailorA.login }), 200, "Read the trail");
  const trail = withEvents.find((entry: any) => entry.id === id).events.map((event: any) => event.eventType);
  const expected = ["CREATED", "STARTED", "PAUSED", "RESUMED", "SUBMITTED", "INSPECTED"];
  let at = 0;
  for (const step of trail) if (step === expected[at]) at += 1;
  assert.equal(at, expected.length, `the trail records each move in order (got ${trail.join(", ")})`);
});

test("a pure rework sends the work back to the helper, who starts it again and hands it back", async () => {
  const w = await world();
  const { sewing } = await sewingFor(w, w.tailorA, 10);
  const { id } = await expectStatus(
    await handOut(w.tailorA.login, { workerId: w.weaver.id, operation: "Taping", quantityAssigned: 10, pieceRate: 30, productionOperationId: sewing.id }),
    201, "Hand out 10 taping"
  );
  await startSupport(w.weaver.login, id);
  await expectStatus(await api("PUT", "/api/support-work", { cookie: w.weaver.login, body: { id, submitQty: 10 } }), 200, "Hand back all 10");
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: w.tailorA.login, body: { id, quantityApproved: 0, quantityRework: 10, quantityRejected: 0, notes: "Redo all of it" } }),
    201, "Sent back for rework"
  );
  const [afterRework] = await db.select().from(supportAssignments).where(eq(supportAssignments.id, id));
  assert.equal(afterRework.status, "REWORK");

  await startSupport(w.weaver.login, id, "The helper starts the rework");
  // The rework is returned to the helper: they may hand all 10 back again.
  await expectStatus(await api("PUT", "/api/support-work", { cookie: w.weaver.login, body: { id, submitQty: 10 } }), 200, "Hand the reworked 10 back");
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: w.tailorA.login, body: { id, quantityApproved: 10, quantityRework: 0, quantityRejected: 0 } }),
    201, "Approved on the second pass"
  );
  const [done] = await db.select().from(supportAssignments).where(eq(supportAssignments.id, id));
  assert.equal(done.status, "APPROVED");
  assert.equal(done.quantityApproved, 10);
});

test("a helper cannot submit more than was handed out while an earlier submission is still unjudged", async () => {
  const w = await world();
  const { sewing } = await sewingFor(w, w.tailorA, 10);
  const { id } = await expectStatus(
    await handOut(w.tailorA.login, { workerId: w.weaver.id, operation: "Weaving", quantityAssigned: 10, pieceRate: 30, productionOperationId: sewing.id }),
    201, "Hand out 10 weaving"
  );
  await startSupport(w.weaver.login, id);
  await expectStatus(await api("PUT", "/api/support-work", { cookie: w.weaver.login, body: { id, submitQty: 6 } }), 200, "Hand back 6, unjudged");
  const again = await api("PUT", "/api/support-work", { cookie: w.weaver.login, body: { id, submitQty: 10 } });
  assert.equal(again.status, 400, "10 more would make 16 of 10 given out");
  assert.match(String(again.data.error), /between 1 and 4/);
});

test("a support worker cannot approve their own work; the tailor who handed it out can", async () => {
  const w = await world();
  const { sewing } = await sewingFor(w, w.tailorA, 10);
  const { id } = await expectStatus(
    await handOut(w.tailorA.login, { workerId: w.weaver.id, operation: "Weaving", quantityAssigned: 5, pieceRate: 30, productionOperationId: sewing.id }),
    201, "Hand out 5"
  );
  await startSupport(w.weaver.login, id);
  await expectStatus(await api("PUT", "/api/support-work", { cookie: w.weaver.login, body: { id, submitQty: 5 } }), 200, "Hand back 5");
  const self = await api("PUT", "/api/support-work", { cookie: w.weaver.login, body: { id, quantityApproved: 5, quantityRework: 0, quantityRejected: 0 } });
  assert.equal(self.status, 403, "the helper cannot approve it");
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: w.tailorA.login, body: { id, quantityApproved: 5, quantityRework: 0, quantityRejected: 0 } }),
    201, "The tailor approves it"
  );
});

test("a paused hand-over shows on Production Control against the stage, with the reason, through the existing history", async () => {
  const w = await world();
  const { sewing, batchId } = await sewingFor(w, w.tailorA, 20);
  const { id } = await expectStatus(
    await handOut(w.tailorA.login, { workerId: w.weaver.id, operation: "Weaving", quantityAssigned: 20, pieceRate: 30, productionOperationId: sewing.id }),
    201, "Hand out 20"
  );
  await startSupport(w.weaver.login, id);
  await pauseSupport(w.weaver.login, id, "Machine down until Thursday");

  const board = await expectStatus(await api("GET", `/api/production-control?batchId=${batchId}`, { cookie: w.owner.cookie }), 200, "Read the board");
  const row = board.rows.find((entry: any) => entry.batchId === batchId);
  const stage = row.route.find((entry: any) => entry.stage === "SEWING");
  assert.equal(stage.support.paused, 1, "the stage reports the paused hand-over");
  assert.equal(stage.support.pausedReason, "Machine down until Thursday");
  assert.ok(row.flags.includes("SUPPORT_PAUSED"));
  assert.equal(row.stuck, true, "the batch reads as waiting, not as ordinary work in progress");
});

// ---------------------------------------------------------------------------
// 7. Pay: the approved pieces, the deduction, and no double counting
// ---------------------------------------------------------------------------

test("100 pieces at ₦300 with 20 helper pieces at ₦30: the tailor nets ₦29,400, the helper gets ₦600, labour is ₦30,000", async () => {
  const w = await world(100);
  const { sewing } = await sewingFor(w, w.tailorA, 100);

  // The tailor's own SEWING: all 100 submitted and approved at ₦300.
  await expectStatus(await api("PUT", "/api/operations", { cookie: w.tailorA.login, body: { id: sewing.id, submitQty: 100 } }), 200, "Tailor submits 100");
  await expectStatus(
    await api("POST", "/api/inspections", { cookie: w.owner.cookie, body: { operationId: sewing.id, quantityApproved: 100, quantityRework: 0, quantityRejected: 0 } }),
    201, "All 100 approved"
  );

  // The tailor hands 20 weaving pieces to the helper at ₦30.
  const { id } = await expectStatus(
    await handOut(w.tailorA.login, { workerId: w.weaver.id, operation: "Weaving", quantityAssigned: 20, pieceRate: 30, productionOperationId: sewing.id }),
    201, "Hand out 20 weaving at ₦30"
  );
  const before = await payrollOf(w.owner.cookie, w.weaver.id);
  assert.equal(before.supportPiecework, 0, "nothing is payable before the helper's work is approved");

  await startSupport(w.weaver.login, id);
  await expectStatus(await api("PUT", "/api/support-work", { cookie: w.weaver.login, body: { id, submitQty: 20 } }), 200, "Helper hands back 20");
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: w.tailorA.login, body: { id, quantityApproved: 20, quantityRework: 0, quantityRejected: 0 } }),
    201, "Tailor approves all 20"
  );

  const tailorPay = await payrollOf(w.owner.cookie, w.tailorA.id);
  const helperPay = await payrollOf(w.owner.cookie, w.weaver.id);
  assert.equal(tailorPay.piecework, 30000, "the tailor's gross: 100 x 300");
  assert.equal(tailorPay.supportDeduction, 600, "20 x 30 is taken back from the tailor");
  assert.equal(tailorPay.due, 29400, "so the tailor nets 29,400");
  assert.equal(helperPay.supportPiecework, 600, "the helper is paid 20 x 30 = 600, on approved pieces");
  assert.equal(helperPay.supportPieces, 20);

  const costs = (await expectStatus(await api("GET", `/api/orders/${w.order.orderId}`, { cookie: w.owner.cookie }), 200, "Order")).costs;
  assert.equal(costs.internalLabour, 30000, "internal labour is the tailor's gross, counted once");
  assert.equal(costs.supportGrossPaid, 600, "the helper's cash is reported");
  assert.equal(costs.supportDeductedFromTailors, 600, "and the same amount is what came back out of the tailor");
  assert.equal(costs.supportLabour, 0, "so the helper adds nothing to the labour total - no double count");
});

async function payrollOf(ownerCookie: string, workerId: number) {
  const payroll = await expectStatus(await api("GET", `/api/payroll?month=${currentMonth()}`, { cookie: ownerCookie }), 200, "Owner payroll");
  const row = payroll.workers.find((entry: any) => entry.workerId === workerId);
  assert.ok(row, "the worker is on the payroll sheet");
  return row;
}

// ---------------------------------------------------------------------------
// 8. Performance: the helper list reads roles for the people it lists, not the whole table
// ---------------------------------------------------------------------------

test("role lookup for a set of workers returns exactly those workers and their roles", async () => {
  const owner = await createOwner();
  const a = await createWorker(owner.cookie, { name: unique("Role A"), specialty: "Tailor", roles: ["Tailor"] });
  const b = await createWorker(owner.cookie, { name: unique("Role B"), specialty: SUPPORT_ROLE, roles: [SUPPORT_ROLE] });
  const roles = await rolesForWorkerIds([a.id, b.id, a.id]);
  assert.deepEqual([...roles.keys()].sort((x, y) => x - y), [a.id, b.id].sort((x, y) => x - y), "only the requested people");
  assert.ok(roles.get(b.id)?.includes(SUPPORT_ROLE));
  assert.ok(roles.get(a.id)?.includes("Tailor"));
  const none = await rolesForWorkerIds([]);
  assert.equal(none.size, 0, "an empty request reads nothing");
  const [profile] = await db.select().from(workers).where(eq(workers.id, a.id));
  assert.ok(profile, "the profile exists");
});
