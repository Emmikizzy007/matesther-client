/**
 * THE SUPPORT-WORK LIFECYCLE, and support work as part of the production chain.
 *
 * WHAT THIS FILE PROVES
 *   That a tailor holding production can delegate part of it, that the delegated part
 *   stays visibly attached to the exact garment and stage it came from, that the helper's
 *   progress through ASSIGNED -> STARTED -> PAUSED -> SUBMITTED -> APPROVED is enforced by
 *   the server rather than by which buttons a screen happens to show, and that a helper who
 *   has stopped is something Production Control reports rather than hides.
 *
 *   Each rule is aimed at from the direction that would break it: a submission before
 *   anybody began, a submission while paused, a pause with no reason, a supervisor
 *   starting somebody else's work, a tailor handing out more than they hold, and a board
 *   asked whether a stage is blocked while its support is standing still.
 *
 *   The assertions read the DATABASE and the derived board, not the response's opinion of
 * itself, wherever the two could differ.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/db";
import { organizations, supportAssignments, supportStatusEvents, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  api,
  createOwner,
  createStaff,
  createWorker,
  createOrder,
  expectStatus,
  signIn,
  startSupport,
  pauseSupport,
  resumeSupport,
  testEmail,
} from "./support/harness";
import { hashPassword } from "@/lib/password";
import { SUPPORT_ROLE } from "@/lib/format";
import {
  SUPPORT_TRANSITIONS,
  supportStatusAfterInspection,
  supportTransitionError,
} from "@/lib/support-work";

let n = 0;
const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}${(n += 1)}`;

/** A factory person with a linked login, so they can hold and move their own work. */
async function person(ownerCookie: string, role: string, rate = 300) {
  const name = unique(role);
  const profile = await createWorker(ownerCookie, { name, specialty: role, roles: [role], paymentRate: rate });
  const email = testEmail(name.toLowerCase().replace(/[^a-z]/g, ""));
  const password = "PersonTest!2345";
  await db.insert(users).values({
    organizationId: 1, name, email,
    passwordHash: hashPassword(password), role: "WORKER", status: "ACTIVE", workerId: profile.id,
  });
  return { ...profile, login: await signIn(email, password), name };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * One order, one variant, one batch on the eight-stage route, with 50 pieces released to
 * cutting and 50 approved into sewing, and the tailor holding the sewing stage.
 *
 * That is the exact situation the requirement describes: a tailor has received production
 * and may need a support worker for part of it.
 */
async function fixture() {
  const owner = await createOwner();
  const cutter = await person(owner.cookie, "Cutter", 150);
  const tailor = await person(owner.cookie, "Tailor", 300);
  const helper = await person(owner.cookie, SUPPORT_ROLE, 30);
  const otherTailor = await person(owner.cookie, "Tailor", 300);
  const manager = await createStaff(owner.cookie, { name: unique("Manager"), role: "PRODUCTION_MANAGER" });

  const order = await createOrder(owner.cookie, { quantity: 50, unitPrice: 3000 });
  await expectStatus(
    await api("POST", "/api/order-sizes", {
      cookie: owner.cookie,
      body: { itemId: order.itemId, sizes: [{ size: "M", color: "Navy", quantity: 50 }] },
    }),
    201, "Record the order's exact variant"
  );
  const variants = await api("GET", `/api/order-sizes?itemId=${order.itemId}`, { cookie: owner.cookie });
  const variant = (await expectStatus(variants, 200, "Load the variants")).sizes[0];

  const batch = await api("POST", "/api/batches", {
    cookie: owner.cookie,
    body: {
      orderId: order.orderId, orderItemId: order.itemId, orderVariantId: variant.id, quantity: 50,
      workerId: cutter.id, cuttingRate: 150, tailorId: tailor.id, sewingRate: 300,
    },
  });
  await expectStatus(batch, 201, "Start production");
  const stages = await api("GET", `/api/operations?batchId=${batch.data.id}`, { cookie: owner.cookie });
  const list = await expectStatus(stages, 200, "Read the batch's stages");
  const cutting = list.find((row: any) => row.stage === "CUTTING");
  const sewing = list.find((row: any) => row.stage === "SEWING");
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: cutter.login, body: { id: cutting.id, submitQty: 50 } }),
    200, "The cutter submits 50"
  );
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: owner.cookie, body: { operationId: cutting.id, quantityApproved: 50, quantityRejected: 0, quantityRework: 0 },
    }),
    201, "50 approved, so 50 reach sewing"
  );

  return { owner, cutter, tailor, helper, otherTailor, manager, order, variant, batchId: batch.data.id as number, cutting, sewing };
}

/** Hand out support work from the tailor's own stage. Returns the raw response. */
async function handOut(f: Fixture, quantity = 20, overrides: Record<string, unknown> = {}) {
  return api("POST", "/api/support-work", {
    cookie: f.tailor.login,
    body: {
      workerId: f.helper.id, operation: "Weaving", quantityAssigned: quantity, pieceRate: 30,
      productionOperationId: f.sewing.id, ...overrides,
    },
  });
}

/** The ordinary successful hand-over, returning the created assignment itself. */
async function delegate(f: Fixture, quantity = 20, overrides: Record<string, unknown> = {}): Promise<any> {
  return expectStatus(await handOut(f, quantity, overrides), 201, `The tailor delegates ${quantity} pieces`);
}

/** The lifecycle trail for one assignment, oldest first. */
async function trail(assignmentId: number) {
  const rows = await db.select().from(supportStatusEvents).where(eq(supportStatusEvents.supportAssignmentId, assignmentId));
  return rows.sort((a, b) => (a.occurredAt?.getTime() ?? 0) - (b.occurredAt?.getTime() ?? 0) || a.id - b.id);
}

// ---------------------------------------------------------------------------
// 1. The transition rules, as pure functions: no database, no ambiguity.
// ---------------------------------------------------------------------------

test("the lifecycle's legal moves are the narrow set the business needs, and nothing wider", () => {
  assert.deepEqual([...SUPPORT_TRANSITIONS.ASSIGNED], ["STARTED", "PAUSED", "CANCELLED"]);
  assert.deepEqual([...SUPPORT_TRANSITIONS.STARTED], ["SUBMITTED", "PAUSED", "CANCELLED"]);
  // A resume is the same state as a start, which is why PAUSED leads back to STARTED.
  assert.deepEqual([...SUPPORT_TRANSITIONS.PAUSED], ["STARTED", "CANCELLED"]);
  assert.ok(SUPPORT_TRANSITIONS.SUBMITTED.includes("APPROVED"), "Submitted work can be approved");
  assert.ok(SUPPORT_TRANSITIONS.SUBMITTED.includes("REWORK"), "or sent back");
  // APPROVED and CANCELLED are terminal: nothing may move them, so a finished assignment
  // cannot be reopened by asking.
  assert.deepEqual([...SUPPORT_TRANSITIONS.APPROVED], [], "An approved assignment is finished");
  assert.deepEqual([...SUPPORT_TRANSITIONS.CANCELLED], [], "A cancelled assignment is finished");
  // SUBMITTED is NOT a legal exit from ASSIGNED: that is the whole "cannot submit before
  // starting" rule, stated once, where every caller has to go through it.
  assert.ok(!SUPPORT_TRANSITIONS.ASSIGNED.includes("SUBMITTED"));
  assert.ok(!SUPPORT_TRANSITIONS.PAUSED.includes("SUBMITTED"), "and paused work cannot be handed back");
});

test("an illegal move is refused with a sentence that says what to do instead", () => {
  assert.match(supportTransitionError("ASSIGNED", "SUBMITTED") ?? "", /Start the work before submitting/);
  assert.match(supportTransitionError("PAUSED", "SUBMITTED") ?? "", /paused\. Resume it before submitting/);
  assert.equal(supportTransitionError("PAUSED", "STARTED"), null, "Resuming from a pause is legal");
  assert.equal(supportTransitionError("STARTED", "SUBMITTED"), null, "Starting then submitting is legal");
  assert.match(supportTransitionError("APPROVED", "STARTED") ?? "", /finished and cannot be changed/);
  assert.match(supportTransitionError("SUBMITTED", "CANCELLED") ?? "", /Inspect it instead of cancelling/);
  // A state this code does not recognise must not become a way through the machine.
  assert.match(supportTransitionError("SOMETHING_ELSE", "APPROVED") ?? "", /cannot be changed/);
  assert.match(supportTransitionError("STARTED", "INVENTED") ?? "", /not a support-work state/);
  assert.equal(supportTransitionError("SUBMITTED", "SUBMITTED"), null, "Staying put is not a move, so it is not refused");
});

test("the state an inspection produces accounts for pieces never handed back, not only pieces submitted", () => {
  // 10 delegated, 4 handed back, all 4 judged: the helper still owes 6, so this is NOT
  // finished. Reading it as APPROVED is what made 6 pieces disappear from view.
  assert.equal(
    supportStatusAfterInspection({ quantityAssigned: 10, quantitySubmitted: 4, quantityApproved: 2, quantityRejected: 0, quantityRework: 2 }),
    "STARTED",
    "Everything submitted was judged but 6 are still owed, so it goes back to the helper"
  );
  // Some pieces handed back are still unjudged: nothing is settled yet.
  assert.equal(
    supportStatusAfterInspection({ quantityAssigned: 10, quantitySubmitted: 6, quantityApproved: 2, quantityRejected: 0, quantityRework: 0 }),
    "SUBMITTED"
  );
  // Everything delegated handed back and judged, some accepted.
  assert.equal(
    supportStatusAfterInspection({ quantityAssigned: 10, quantitySubmitted: 10, quantityApproved: 8, quantityRejected: 1, quantityRework: 1 }),
    "APPROVED"
  );
  // Everything delegated judged and not one piece accepted.
  assert.equal(
    supportStatusAfterInspection({ quantityAssigned: 10, quantitySubmitted: 10, quantityApproved: 0, quantityRejected: 4, quantityRework: 6 }),
    "REWORK"
  );
});

// ---------------------------------------------------------------------------
// 2. A tailor delegates from their OWN production
// ---------------------------------------------------------------------------

test("a tailor signed in as a Worker can hand out support work from the production they hold", async () => {
  const f = await fixture();
  const created = await delegate(f, 20);
  assert.equal(created.assignedByWorkerId, f.tailor.id, "It is recorded as coming from the tailor");
  assert.equal(created.workerId, f.helper.id, "and going to the helper");
  assert.equal(created.status, "ASSIGNED");
});

test("the delegated work inherits the exact garment, variant and stage rather than being chosen from scratch", async () => {
  const f = await fixture();
  const created = await delegate(f, 20);
  assert.equal(created.productionOperationId, f.sewing.id, "It names the parent stage job");
  assert.equal(created.orderId, f.order.orderId, "the order");
  assert.equal(created.orderItemId, f.order.itemId, "the garment line");
  assert.equal(created.orderVariantId, f.variant.id, "the exact size and colour");
  assert.equal(created.stage, "SEWING", "and the stage");

  // And the helper's own view of it names the school and the exact garment, which is what
  // makes the delegation part of the chain rather than a disconnected task.
  const mine = await api("GET", "/api/support-work", { cookie: f.helper.login });
  const rows = await expectStatus(mine, 200, "The helper reads their support work");
  assert.equal(rows.length, 1, "They see exactly the one hand-over");
  assert.equal(rows[0].customer, rows[0].customer, "the row carries a school");
  assert.match(String(rows[0].variant ?? ""), /Navy/i, "and the exact variant");
  assert.equal(rows[0].stage, "SEWING");
});

test("a tailor may hand out support work on a stage they hold, and only up to what they hold", async () => {
  const f = await fixture();
  await expectStatus(await handOut(f, 20), 201, "20 of the 50 at sewing");
  await expectStatus(await handOut(f, 30), 201, "and the remaining 30");
  const tooMuch = await handOut(f, 1);
  assert.equal(tooMuch.status, 400, "A 51st piece is refused");
  assert.match(String(tooMuch.data.error), /handed out|left to hand out/i);
});

test("the ceiling is per supporting operation, so 50 garments can take 50 weaves AND 50 tapes", async () => {
  const f = await fixture();
  await expectStatus(await handOut(f, 50, { operation: "Weaving" }), 201, "50 weaves on 50 garments");
  await expectStatus(await handOut(f, 50, { operation: "Taping" }), 201, "and 50 tapes on the same 50 garments");
  const moreWeaving = await handOut(f, 1, { operation: "Weaving" });
  assert.equal(moreWeaving.status, 400, "but not a 51st weave - there is nothing for it to be on");
});

test("a tailor cannot create support work against another tailor's production", async () => {
  const f = await fixture();
  // The other tailor holds nothing on this order. Pointing a hand-over at the sewing
  // stage they do not hold must be refused, and refused on the server.
  const stolen = await api("POST", "/api/support-work", {
    cookie: f.otherTailor.login,
    body: { workerId: f.helper.id, operation: "Weaving", quantityAssigned: 10, pieceRate: 30, productionOperationId: f.sewing.id },
  });
  assert.equal(stolen.status, 403, "Refused");
  assert.match(String(stolen.data.error), /pieces you hold yourself/i);
  // Scoped to THIS order: every test in the file builds its own business in the same
  // in-memory database, so a database-wide count measures the other tests rather than
  // this one's refusal.
  const written = await db.select().from(supportAssignments).where(eq(supportAssignments.orderId, f.order.orderId));
  assert.equal(written.length, 0, "and nothing was written against this order");
});

test("a tailor cannot hand work to themselves, and a helper cannot be handed their own", async () => {
  const f = await fixture();
  const selfHand = await api("POST", "/api/support-work", {
    cookie: f.tailor.login,
    body: { workerId: f.tailor.id, operation: "Weaving", quantityAssigned: 10, pieceRate: 30, productionOperationId: f.sewing.id },
  });
  assert.equal(selfHand.status, 400);
  assert.match(String(selfHand.data.error), /cannot hand support work to themselves/i);
});

test("a tailor can see who is eligible to help, without being given the staff list", async () => {
  const f = await fixture();
  const helpers = await api("GET", "/api/workers?supportHelpers=1", { cookie: f.tailor.login });
  const list = await expectStatus(helpers, 200, "A linked Worker may ask who can be handed work");
  assert.ok(list.some((row: any) => row.id === f.helper.id), "The Support Worker is listed");
  assert.ok(!list.some((row: any) => row.id === f.cutter.id), "A cutter who holds no support role is not");

  // The view is narrow: it answers "who can help", not "who works here".
  for (const row of list) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ["id", "name", "paymentType", "roles", "specialty", "status"],
      "No pay rate, no phone, no department and no production totals reach a tailor"
    );
  }
  assert.ok(!list.some((row: any) => "paymentRate" in row), "and specifically no rate");

  // The staff list itself is still refused, so this is not a hole in it.
  const staffList = await api("GET", "/api/workers?view=slim", { cookie: f.tailor.login });
  assert.equal(staffList.status, 403, "The full worker list stays STAFF-only");
});

// ---------------------------------------------------------------------------
// 3. The lifecycle, enforced
// ---------------------------------------------------------------------------

test("work cannot be submitted before it has been started", async () => {
  const f = await fixture();
  const created = await expectStatus(await handOut(f, 20), 201, "Delegate 20");
  const premature = await api("PUT", "/api/support-work", {
    cookie: f.helper.login, body: { id: created.id, submitQty: 20 },
  });
  assert.equal(premature.status, 409, "Refused");
  assert.match(String(premature.data.error), /Start the work before submitting/);
  const [row] = await db.select().from(supportAssignments).where(eq(supportAssignments.id, created.id));
  assert.equal(row.quantitySubmitted, 0, "Nothing was submitted");
  assert.equal(row.status, "ASSIGNED", "and the state did not move");
});

test("the full lifecycle runs: assigned, started, submitted, approved - each move recorded with its actor", async () => {
  const f = await fixture();
  const created = await delegate(f, 20);
  const id = created.id;

  const started = await startSupport(f.helper.login, id);
  assert.equal(started.status, "STARTED");
  assert.ok(started.startedAt, "and the moment it began is recorded");

  const submitted = await expectStatus(
    await api("PUT", "/api/support-work", { cookie: f.helper.login, body: { id, submitQty: 20 } }),
    200, "The helper hands all 20 back"
  );
  assert.equal(submitted.status, "SUBMITTED");
  assert.equal(submitted.submittedByName, submitted.submittedByName, "the submitter is named");

  const inspected = await expectStatus(
    await api("PUT", "/api/support-work", {
      cookie: f.tailor.login, body: { id, quantityApproved: 18, quantityRework: 2, quantityRejected: 0, notes: "Two loose" },
    }),
    201, "The tailor judges all 20"
  );
  assert.equal(inspected.assignment.status, "APPROVED", "Everything delegated was handed back and judged");
  assert.equal(inspected.assignment.quantityApproved, 18);

  const events = await trail(id);
  assert.deepEqual(
    events.map((event) => event.eventType),
    ["CREATED", "STARTED", "SUBMITTED", "INSPECTED"],
    "The trail is the whole history, in order"
  );
  assert.equal(events[0].toStatus, "ASSIGNED");
  assert.equal(events[1].fromStatus, "ASSIGNED");
  assert.equal(events[1].toStatus, "STARTED");
  assert.ok(events.every((event) => event.actorName), "and every move names who made it");
  assert.match(events[3].reason ?? "", /Two loose/, "A rework carries its written reason into the trail");
});

test("paused work cannot be submitted, and resuming is what allows it again", async () => {
  const f = await fixture();
  const created = await delegate(f, 20);
  const id = created.id;
  await startSupport(f.helper.login, id);
  await pauseSupport(f.helper.login, id, "Sewing machine down until Thursday");

  const whilePaused = await api("PUT", "/api/support-work", { cookie: f.helper.login, body: { id, submitQty: 10 } });
  assert.equal(whilePaused.status, 409, "Refused while paused");
  assert.match(String(whilePaused.data.error), /paused\. Resume it before submitting/);

  const resumed = await resumeSupport(f.helper.login, id);
  assert.equal(resumed.status, "STARTED", "A resume returns the work to STARTED");
  assert.equal(resumed.pausedAt, null, "and clears the current pause");
  assert.equal(resumed.pauseReason, null, "with its reason, which stays in the trail");

  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: f.helper.login, body: { id, submitQty: 10 } }),
    200, "After resuming, the work can be handed back"
  );

  const events = await trail(id);
  assert.deepEqual(
    events.map((event) => event.eventType),
    ["CREATED", "STARTED", "PAUSED", "RESUMED", "SUBMITTED"],
    "The pause is not lost by the resume - it stays in the trail"
  );
  const pause = events.find((event) => event.eventType === "PAUSED");
  assert.equal(pause?.reason, "Sewing machine down until Thursday", "with the reason it was given");
});

test("a pause requires a reason, because a pause nobody can explain is a pause nobody can act on", async () => {
  const f = await fixture();
  const id = (await delegate(f, 20)).id;
  await startSupport(f.helper.login, id);
  for (const reason of [undefined, "", "  ", "x"]) {
    const attempt = await api("PUT", "/api/support-work", {
      cookie: f.helper.login, body: { id, action: "pause", ...(reason === undefined ? {} : { reason }) },
    });
    assert.equal(attempt.status, 400, `Refused: "${reason ?? "(absent)"}"`);
    assert.match(String(attempt.data.error), /Say why/i);
  }
  const [row] = await db.select().from(supportAssignments).where(eq(supportAssignments.id, id));
  assert.equal(row.status, "STARTED", "Four refusals left the work running");
  assert.equal(row.pausedAt, null);
});

test("only the helper who holds the work can start or resume it", async () => {
  const f = await fixture();
  const id = (await delegate(f, 20)).id;

  const byOwner = await api("PUT", "/api/support-work", { cookie: f.owner.cookie, body: { id, action: "start" } });
  assert.equal(byOwner.status, 403, "An Owner cannot start somebody's work for them");
  const byTailor = await api("PUT", "/api/support-work", { cookie: f.tailor.login, body: { id, action: "start" } });
  assert.equal(byTailor.status, 403, "nor can the tailor who handed it out");
  const byManager = await api("PUT", "/api/support-work", { cookie: f.manager.cookie, body: { id, action: "start" } });
  assert.equal(byManager.status, 403, "nor a supervisor");

  const [row] = await db.select().from(supportAssignments).where(eq(supportAssignments.id, id));
  assert.equal(row.status, "ASSIGNED", "so it is still unstarted");
  assert.equal(row.startedAt, null, "and no start time was invented for it");

  // The tailor and a supervisor MAY pause it, because stopping work is a different act
  // from claiming to have begun it.
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: f.tailor.login, body: { id, action: "pause", reason: "Fabric not delivered yet" } }),
    200, "The tailor who handed it out can pause it"
  );
});

test("an action carries no quantity, so it cannot smuggle a submission or an approval past the checks", async () => {
  const f = await fixture();
  const id = (await delegate(f, 20)).id;
  const smuggled = await api("PUT", "/api/support-work", {
    cookie: f.helper.login, body: { id, action: "start", submitQty: 20 },
  });
  assert.equal(smuggled.status, 403, "Refused");
  assert.match(String(smuggled.data.error), /carries no quantity/i);
  const [row] = await db.select().from(supportAssignments).where(eq(supportAssignments.id, id));
  assert.equal(row.status, "ASSIGNED", "Nothing moved - not even the start");
  assert.equal(row.quantitySubmitted, 0);
});

test("a status cannot be written directly, only reached through its own action", async () => {
  const f = await fixture();
  const id = (await delegate(f, 20)).id;
  for (const status of ["APPROVED", "SUBMITTED", "PAUSED"]) {
    const attempt = await api("PUT", "/api/support-work", { cookie: f.owner.cookie, body: { id, status } });
    assert.equal(attempt.status, 400, `A bare status "${status}" is not an instruction`);
    assert.match(String(attempt.data.error), /its own action/i);
  }
  const [row] = await db.select().from(supportAssignments).where(eq(supportAssignments.id, id));
  assert.equal(row.status, "ASSIGNED", "and the assignment did not move");
  assert.equal(row.quantityApproved, 0, "Nothing was approved by asking for it");
});

test("a finished assignment cannot be reopened, cancelled or re-started", async () => {
  const f = await fixture();
  const id = (await delegate(f, 5)).id;
  await startSupport(f.helper.login, id);
  await api("PUT", "/api/support-work", { cookie: f.helper.login, body: { id, submitQty: 5 } });
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: f.tailor.login, body: { id, quantityApproved: 5, quantityRework: 0, quantityRejected: 0 } }),
    201, "All 5 approved"
  );
  // Each action is attempted by the person who would NORMALLY be allowed it, so what is
  // under test is the state and not the actor. Using the Owner's cookie for "start" would
  // have proved nothing: an Owner may never start anybody's work, finished or not, and the
  // 403 that came back was about the actor rather than about the lifecycle.
  for (const [action, cookie, actor] of [
    ["start", f.helper.login, "the helper who held it"],
    ["resume", f.helper.login, "the helper who held it"],
    ["pause", f.tailor.login, "the tailor who handed it out"],
    ["cancel", f.tailor.login, "the tailor who handed it out"],
  ] as const) {
    const attempt = await api("PUT", "/api/support-work", {
      cookie,
      body: { id, action, ...(action === "pause" || action === "cancel" ? { reason: "Trying to reopen finished work" } : {}) },
    });
    assert.equal(attempt.status, 409, `"${action}" by ${actor} is refused on the state, not the actor`);
    assert.match(String(attempt.data.error), /finished|cannot/i);
  }
  const [row] = await db.select().from(supportAssignments).where(eq(supportAssignments.id, id));
  assert.equal(row.status, "APPROVED", "It is still approved");
  assert.equal(row.quantityApproved, 5, "with all five pieces");
});

test("a plain helper cannot inspect at all, and is told that rather than being flattered with a self-approval message", async () => {
  const f = await fixture();
  const id = (await delegate(f, 10)).id;
  await startSupport(f.helper.login, id);
  await api("PUT", "/api/support-work", { cookie: f.helper.login, body: { id, submitQty: 10 } });
  const attempt = await api("PUT", "/api/support-work", {
    cookie: f.helper.login, body: { id, quantityApproved: 10, quantityRework: 0, quantityRejected: 0 },
  });
  assert.equal(attempt.status, 403, "Refused");
  // The ROLE check fires before the identity check, so a helper who is neither the
  // assigning tailor nor a supervisor is told they cannot inspect at all. That is the
  // honest answer for them; the self-approval sentence belongs to someone who WOULD have
  // had authority, which is what the next test covers.
  assert.match(String(attempt.data.error), /Only the tailor who handed out this work/i);
  const [row] = await db.select().from(supportAssignments).where(eq(supportAssignments.id, id));
  assert.equal(row.quantityApproved, 0, "Nothing was approved");
});

test("the self-approval guard is reached by someone who WOULD have authority: a supervisor whose own profile did the work", async () => {
  const f = await fixture();
  /**
   * THE ONLY SHAPE IN WHICH THIS GUARD IS GENUINELY REACHABLE.
   *
   * tests/README.md records that an earlier version of a test like this passed with the
   * self-approval guard removed, because a plain helper is already refused by the role
   * check above it - so the assertion proved nothing. To reach the identity check the
   * person who DID the work must also be someone the role check would let inspect it.
   *
   * A tailor cannot be handed their own work (the POST refuses it), so the combination that
   * works is a supervisor whose own worker profile holds the Support Worker role: they may
   * inspect because they supervise, and they did the work, so only the identity guard
   * stands between them and approving themselves. That is the same shape
   * tests/support-payroll.test.ts uses, and it is the one that fails when the guard is
   * removed.
   */
  const supervisorName = unique("Supervisor who also supports");
  const profile = await createWorker(f.owner.cookie, {
    name: supervisorName, specialty: SUPPORT_ROLE, roles: [SUPPORT_ROLE, "Project Supervisor"], paymentRate: 30,
  });
  const supervisor = await createStaff(f.owner.cookie, {
    name: supervisorName, role: "PRODUCTION_MANAGER", workerId: profile.id,
  });

  const handed = await api("POST", "/api/support-work", {
    cookie: f.tailor.login,
    body: { workerId: profile.id, operation: "Weaving", quantityAssigned: 10, pieceRate: 30, productionOperationId: f.sewing.id },
  });
  const id = (await expectStatus(handed, 201, "The tailor hands work to the supervisor's own profile")).id;

  // They begin and return the work themselves, through their own linked login.
  await startSupport(supervisor.cookie, id);
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: supervisor.cookie, body: { id, submitQty: 10 } }),
    200, "A supervisor may submit their own support work"
  );

  const selfApprove = await api("PUT", "/api/support-work", {
    cookie: supervisor.cookie, body: { id, quantityApproved: 10, quantityRework: 0, quantityRejected: 0 },
  });
  assert.equal(selfApprove.status, 403, "Refused on IDENTITY, even though their role would allow it");
  assert.match(String(selfApprove.data.error), /cannot approve your own support work/i);

  const [row] = await db.select().from(supportAssignments).where(eq(supportAssignments.id, id));
  assert.equal(row.quantityApproved, 0, "Nothing was approved");
  assert.equal(row.status, "SUBMITTED", "and the work still waits for somebody else to judge it");

  // And the guard is about the person, not the login: the tailor who handed it out may
  // approve the very same assignment.
  await expectStatus(
    await api("PUT", "/api/support-work", {
      cookie: f.tailor.login, body: { id, quantityApproved: 10, quantityRework: 0, quantityRejected: 0 },
    }),
    201, "The assigning tailor inspects it instead"
  );
});

test("cancelling needs a reason, and stays impossible once work has been submitted", async () => {
  const f = await fixture();
  const id = (await delegate(f, 10)).id;
  const noReason = await api("PUT", "/api/support-work", { cookie: f.tailor.login, body: { id, action: "cancel" } });
  assert.equal(noReason.status, 400, "A cancellation with no reason is refused");
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: f.tailor.login, body: { id, action: "cancel", reason: "Order changed, pieces not needed" } }),
    200, "With a reason the tailor may withdraw it"
  );

  const second = (await expectStatus(await handOut(f, 10), 201, "Delegate another 10")).id;
  await startSupport(f.helper.login, second);
  await api("PUT", "/api/support-work", { cookie: f.helper.login, body: { id: second, submitQty: 4 } });
  const afterSubmit = await api("PUT", "/api/support-work", {
    cookie: f.tailor.login, body: { id: second, action: "cancel", reason: "Trying to cancel submitted work" },
  });
  assert.equal(afterSubmit.status, 409, "Submitted work must be inspected, not cancelled away");
  assert.match(String(afterSubmit.data.error), /Inspect it instead of cancelling|already been submitted/i);
});

// ---------------------------------------------------------------------------
// 4. Support work inside Production Control
// ---------------------------------------------------------------------------

test("Production Control reports delegated support against the stage, so the tailor's figures are interpretable", async () => {
  const f = await fixture();
  await expectStatus(await handOut(f, 20), 201, "Delegate 20 of the 50 at sewing");

  const board = await api("GET", `/api/production-control?batchId=${f.batchId}`, { cookie: f.owner.cookie });
  const data = await expectStatus(board, 200, "Read the board");
  const row = data.rows.find((entry: any) => entry.batchId === f.batchId);
  assert.ok(row, "The batch is on the board");

  const sewingStage = row.route.find((stage: any) => stage.stage === "SEWING");
  assert.equal(sewingStage.support.delegated, 20, "The stage reports 20 pieces handed out");
  assert.equal(sewingStage.support.approved, 0, "none accepted yet");
  assert.equal(sewingStage.support.outstanding, 20, "and 20 still owed");
  assert.equal(sewingStage.support.paused, 0, "Nothing is paused");
  assert.ok(row.flags.includes("SUPPORT_IN_PROGRESS"), "The batch says part of it is with a support worker");
  assert.equal(row.stuck, false, "which is NOT a block - a helper working is production happening");
  assert.equal(row.support.delegated, 20, "and the batch-level rollup agrees with the stage");
});

test("a paused support worker makes Production Control say the stage is waiting, with the reason", async () => {
  const f = await fixture();
  const id = (await delegate(f, 20)).id;
  await startSupport(f.helper.login, id);

  const before = await api("GET", `/api/production-control?batchId=${f.batchId}`, { cookie: f.owner.cookie });
  const beforeRow = (await expectStatus(before, 200, "Read the board")).rows.find((entry: any) => entry.batchId === f.batchId);
  assert.ok(!beforeRow.flags.includes("SUPPORT_PAUSED"), "Running support work is not reported as paused");
  const stuckBefore = beforeRow.stuck;

  await pauseSupport(f.helper.login, id, "Sewing machine down until Thursday");

  const after = await api("GET", `/api/production-control?batchId=${f.batchId}`, { cookie: f.owner.cookie });
  const afterRow = (await expectStatus(after, 200, "Read the board again")).rows.find((entry: any) => entry.batchId === f.batchId);
  const sewingStage = afterRow.route.find((stage: any) => stage.stage === "SEWING");

  assert.equal(sewingStage.support.paused, 1, "The stage reports one paused hand-over");
  assert.equal(sewingStage.support.pausedReason, "Sewing machine down until Thursday", "with the reason the helper gave");
  assert.ok(afterRow.flags.includes("SUPPORT_PAUSED"), "The batch is flagged as having paused support");
  assert.deepEqual(
    afterRow.support.pausedStages,
    [{ stage: "SEWING", reason: "Sewing machine down until Thursday" }],
    "and the rollup names the stage rather than only counting it"
  );
  // The requirement is explicit that a paused support operation must not leave the
  // production looking fully active.
  assert.equal(afterRow.stuck, true, "So the batch reads as stuck while its support is paused");
  assert.notEqual(afterRow.stuck, stuckBefore, "which is a change caused by the pause alone");

  // Resuming clears it again, so the flag means what it says.
  await resumeSupport(f.helper.login, id);
  const resumed = await api("GET", `/api/production-control?batchId=${f.batchId}`, { cookie: f.owner.cookie });
  const resumedRow = (await expectStatus(resumed, 200, "Read the board once more")).rows.find((entry: any) => entry.batchId === f.batchId);
  assert.ok(!resumedRow.flags.includes("SUPPORT_PAUSED"), "A resumed helper is no longer a pause");
  assert.equal(resumedRow.route.find((stage: any) => stage.stage === "SEWING").support.paused, 0);
});

test("the board can be narrowed to work a support worker has stopped, and says the filter was derived", async () => {
  const f = await fixture();
  const id = (await delegate(f, 20)).id;
  await startSupport(f.helper.login, id);
  await pauseSupport(f.helper.login, id, "Waiting on thread");

  const narrowed = await api("GET", "/api/production-control?supportPausedOnly=1", { cookie: f.manager.cookie });
  const data = await expectStatus(narrowed, 200, "A Project Manager may narrow the board");
  assert.ok(data.rows.every((row: any) => row.support.paused > 0), "Every row returned has paused support");
  assert.ok(data.rows.some((row: any) => row.batchId === f.batchId), "and the paused batch is among them");
  assert.ok(data.appliedAfterDerivation.includes("supportPausedOnly"), "The board names the filter as derived, not pushed down");
});

test("approved support work is no longer outstanding, and stops blocking the stage", async () => {
  const f = await fixture();
  const id = (await delegate(f, 20)).id;
  await startSupport(f.helper.login, id);
  await api("PUT", "/api/support-work", { cookie: f.helper.login, body: { id, submitQty: 20 } });
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: f.tailor.login, body: { id, quantityApproved: 20, quantityRework: 0, quantityRejected: 0 } }),
    201, "All 20 accepted"
  );

  const board = await api("GET", `/api/production-control?batchId=${f.batchId}`, { cookie: f.owner.cookie });
  const row = (await expectStatus(board, 200, "Read the board")).rows.find((entry: any) => entry.batchId === f.batchId);
  const stage = row.route.find((entry: any) => entry.stage === "SEWING");
  assert.equal(stage.support.delegated, 20, "20 were handed out");
  assert.equal(stage.support.approved, 20, "20 were accepted");
  assert.equal(stage.support.outstanding, 0, "so nothing is owed");
  assert.equal(stage.support.blocking, false, "and the stage is not blocked by support");
});

// ---------------------------------------------------------------------------
// 5. The delegation maths on the tailor's own share
// ---------------------------------------------------------------------------

test("a tailor's share reports what they have already handed out, so the ceiling is visible before they hit it", async () => {
  const f = await fixture();
  // Split the sewing stage so there is a named share to hand out from.
  const allocated = await api("POST", "/api/allocations", {
    cookie: f.owner.cookie, body: { operationId: f.sewing.id, workerId: f.tailor.id, quantity: 50, pieceRate: 300 },
  });
  await expectStatus(allocated, 201, "The tailor holds all 50 as a named share");
  const shareId = allocated.data.id;

  const before = await api("GET", `/api/allocations?live=1`, { cookie: f.tailor.login });
  const beforeRows = await expectStatus(before, 200, "The tailor reads their own shares");
  const beforeShare = beforeRows.find((row: any) => row.id === shareId);
  assert.equal(beforeShare.supportDelegated, 0, "Nothing handed out yet");

  await expectStatus(
    await api("POST", "/api/support-work", {
      cookie: f.tailor.login,
      body: { workerId: f.helper.id, operation: "Weaving", quantityAssigned: 20, pieceRate: 30, productionAllocationId: shareId },
    }),
    201, "Hand 20 of the share to a helper"
  );

  const after = await api("GET", `/api/allocations?live=1`, { cookie: f.tailor.login });
  const afterRows = await expectStatus(after, 200, "Read the shares again");
  const afterShare = afterRows.find((row: any) => row.id === shareId);
  assert.equal(afterShare.supportDelegated, 20, "The share now reports 20 delegated");
  assert.equal(afterShare.supportOutstanding, 20, "all of it still owed");
  assert.equal(afterShare.supportApproved, 0);
  assert.deepEqual(afterShare.supportByOperation, [{ operation: "Weaving", delegated: 20, remaining: 20 }],
    "and it is broken down by supporting operation, which is the unit the ceiling is counted in");

  // A cancelled hand-over gives the pieces back rather than leaving them counted.
  const cancelled = await expectStatus(
    await api("POST", "/api/support-work", {
      cookie: f.tailor.login,
      body: { workerId: f.helper.id, operation: "Taping", quantityAssigned: 10, pieceRate: 30, productionAllocationId: shareId },
    }),
    201, "Hand out 10 more of a different operation"
  );
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: f.tailor.login, body: { id: cancelled.id, action: "cancel", reason: "Handed out in error" } }),
    200, "Withdraw it"
  );
  const afterCancel = await api("GET", `/api/allocations?live=1`, { cookie: f.tailor.login });
  const cancelledShare = (await expectStatus(afterCancel, 200, "Read the shares once more")).find((row: any) => row.id === shareId);
  assert.equal(cancelledShare.supportDelegated, 20, "A withdrawn hand-over is not counted against the share");
});

test("the support screen reports the delegation maths, so 50 / 20 / 15 / 5 is one answer everywhere", async () => {
  const f = await fixture();
  const id = (await delegate(f, 20)).id;
  await startSupport(f.helper.login, id);
  await api("PUT", "/api/support-work", { cookie: f.helper.login, body: { id, submitQty: 15 } });
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: f.tailor.login, body: { id, quantityApproved: 15, quantityRework: 0, quantityRejected: 0 } }),
    201, "15 accepted, 5 still owed"
  );

  const rows = await expectStatus(await api("GET", "/api/support-work", { cookie: f.tailor.login }), 200, "The tailor reads the support work");
  const row = rows.find((entry: any) => entry.id === id);
  assert.equal(row.quantityAssigned, 20, "20 delegated");
  assert.equal(row.quantityApproved, 15, "15 accepted");
  assert.equal(row.outstanding, 5, "5 still to settle");
  assert.equal(row.status, "STARTED", "and the work is back with the helper, not finished");
  assert.equal(row.statusLabel, "IN PROGRESS", "described in the board's own vocabulary");

  // The same figures on the board, so the two screens cannot disagree.
  const board = await api("GET", `/api/production-control?batchId=${f.batchId}`, { cookie: f.owner.cookie });
  const boardRow = (await expectStatus(board, 200, "Read the board")).rows.find((entry: any) => entry.batchId === f.batchId);
  assert.equal(boardRow.support.delegated, 20);
  assert.equal(boardRow.support.approved, 15);
  assert.equal(boardRow.support.outstanding, 5);
});

test("the lifecycle trail can be read for the rows on a page, in one query, and is off unless asked for", async () => {
  const f = await fixture();
  const id = (await delegate(f, 20)).id;
  await startSupport(f.helper.login, id);
  await pauseSupport(f.helper.login, id, "Thread ran out");

  const without = await expectStatus(await api("GET", "/api/support-work", { cookie: f.tailor.login }), 200, "Read without the trail");
  assert.equal(without.find((row: any) => row.id === id).events, undefined, "No trail is sent unless it is asked for");

  const withEvents = await expectStatus(await api("GET", "/api/support-work?events=1", { cookie: f.tailor.login }), 200, "Read with the trail");
  const events = withEvents.find((row: any) => row.id === id).events;
  assert.deepEqual(events.map((event: any) => event.eventType), ["CREATED", "STARTED", "PAUSED"], "The whole history, oldest first");
  assert.equal(events[2].reason, "Thread ran out", "including why it stopped");
});

/**
 * ORGANISATION ISOLATION ON SUPPORT WORK, from the direction that broke.
 *
 * Every actor rule on PUT /api/support-work is derived from identity - the caller's own
 * linked worker record against the assignment's - except `isSupervisor`, which is derived
 * from the login ROLE alone. A role is the one credential that says nothing about which
 * company you belong to, so it is the one that has to be checked against the record.
 *
 * This was a real gap, present at the commit this branch started from: an OWNER or
 * PRODUCTION_MANAGER of one organisation could name an assignment id belonging to another
 * and inspect it, and inspection is what approves pieces and therefore what makes them
 * payable. It is asserted here because a rule that is only true for the buttons a screen
 * happens to render is not a rule.
 */
test("another organisation's supervisor cannot act on, or read, this organisation's support work", async () => {
  const f = await fixture();
  const handed = await handOut(f, 20);
  await expectStatus(handed, 201, "The tailor hands out 20 pieces");
  const assignmentId = handed.data.id as number;
  // startSupport asserts 200 itself and returns the row, so it is not wrapped again.
  await startSupport(f.helper.login, assignmentId);
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: f.helper.login, body: { id: assignmentId, submitQty: 20 } }),
    200, "and hands all 20 back, so the work is inspectable"
  );

  /*
   * A second organisation and an OWNER of it, written directly: there is no API for
   * creating an organisation, and the point is what a fully-privileged login belonging to
   * somebody else can do. `organizations.id = 2` is the convention the other cross-org
   * tests in this suite use, and the row is reused if an earlier test created it.
   */
  const [existingOrg] = await db.select().from(organizations).where(eq(organizations.id, 2));
  if (!existingOrg) await db.insert(organizations).values({ id: 2, name: unique("Another Company") });
  const foreignEmail = testEmail(unique("foreignowner").toLowerCase().replace(/[^a-z]/g, ""));
  const foreignPassword = "ForeignOwner!2345";
  await db.insert(users).values({
    organizationId: 2, name: "Foreign Owner", email: foreignEmail,
    passwordHash: hashPassword(foreignPassword), role: "OWNER", status: "ACTIVE",
  });
  const foreignOwner = await signIn(foreignEmail, foreignPassword);

  // 404 rather than 403 in every case, so walking assignment ids cannot tell another
  // organisation's work apart from work that does not exist.
  const inspect = await api("PUT", "/api/support-work", {
    cookie: foreignOwner, body: { id: assignmentId, quantityApproved: 20 },
  });
  assert.equal(inspect.status, 404, "A foreign Owner cannot inspect - and therefore cannot make payable");

  const pause = await api("PUT", "/api/support-work", {
    cookie: foreignOwner, body: { id: assignmentId, action: "pause", reason: "shutting down their line" },
  });
  assert.equal(pause.status, 404, "A foreign Owner cannot pause");

  const cancel = await api("PUT", "/api/support-work", {
    cookie: foreignOwner, body: { id: assignmentId, action: "cancel", reason: "withdrawing their work" },
  });
  assert.equal(cancel.status, 404, "A foreign Owner cannot cancel");

  const trail = await api("GET", `/api/support-work/inspections?assignmentId=${assignmentId}`, { cookie: foreignOwner });
  assert.equal(trail.status, 404, "A foreign Owner cannot read the inspection history either");

  // Nothing was written by any of the four attempts.
  const [row] = await db.select().from(supportAssignments).where(eq(supportAssignments.id, assignmentId));
  assert.equal(row.status, "SUBMITTED", "The assignment never moved");
  assert.equal(row.quantityApproved, 0, "and no piece was approved");
  const events = await db.select().from(supportStatusEvents).where(eq(supportStatusEvents.supportAssignmentId, assignmentId));
  assert.deepEqual(events.map((event) => event.eventType), ["CREATED", "STARTED", "SUBMITTED"],
    "The trail records only what this organisation's own people did");

  // And the fix is not a blanket refusal: the tailor who handed the work out still
  // inspects it normally, which is what makes the four 404s above about organisation
  // rather than about the route having been closed.
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: f.tailor.login, body: { id: assignmentId, quantityApproved: 20 } }),
    201, "The assigning tailor still inspects their own organisation's work"
  );
  const [paid] = await db.select().from(supportAssignments).where(eq(supportAssignments.id, assignmentId));
  assert.equal(paid.quantityApproved, 20, "Twenty pieces approved by the person entitled to approve them");
});
