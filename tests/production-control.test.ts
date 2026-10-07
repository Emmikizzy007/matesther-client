/**
 * PRODUCTION CONTROL: the route-aware board, and the fact that every figure on it is
 * derived from records that already exist.
 *
 * The requirement this file exists for is that a production controller can answer, for
 * every school and order: what was ordered, what is approved, what is left, WHICH STAGE
 * the work is at right now, how much is assigned and to whom, what is waiting for
 * inspection, what is in rework, what was rejected, where the bottleneck is, and what
 * should be worked on first - with no quantity anywhere on the screen that a person typed.
 *
 * Two things make that hard, and both are asserted here rather than assumed:
 *
 *   1. "Which stage is it at" is NOT a position in the global eight-stage array. A route
 *      is frozen on the batch when the batch is made, and it may skip stages. A batch
 *      routed CUTTING -> IRONING has IRONING at position 2, and reporting it as position
 *      6 because IRONING is sixth in the house list would send the controller to the
 *      wrong place. So the board reads each batch's OWN frozen route.
 *
 *   2. None of these numbers may be stored anywhere. Storing a "remaining" column creates
 *      a second source of truth that can disagree with the ledger, and the moment it does
 *      somebody has to decide which one to believe. Everything here comes out of the
 *      production movement ledger, the allocations and the route, through the same bucket
 *      definitions `deriveDetail()` uses - so this board cannot show a quantity the ledger
 *      disagrees with.
 *
 * The derivation rules are also tested directly as pure functions, because the ranking
 * (what counts as overdue, what counts as blocked, which stage is the bottleneck) is
 * business logic that must not depend on today's date, or on what happens to be in the
 * database, to be checked.
 *
 * Runs against an empty database. Every fixture is created here through the API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGE_ROLES } from "@/lib/format";
import {
  daysUntil,
  currentPositionOf,
  bottleneckOf,
  flagsFor,
  isStuck,
  priorityFor,
  variantText,
  PRIORITY_LABELS,
  type StageControl,
} from "@/lib/production-control";
import * as controlRoute from "@/app/api/production-control/route";
import { EMPTY_STAGE_SUPPORT } from "@/lib/support-work";
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

type Person = { id: number; name: string; login: string };

/** A worker who holds one role, earns per piece, and can sign in to submit their work. */
async function person(ownerCookie: string, label: string, role: string): Promise<Person> {
  const name = unique(label);
  const profile = await createWorker(ownerCookie, { name, specialty: role, roles: [role], paymentType: "PER_PIECE" });
  const login = await createStaff(ownerCookie, { name, role: "WORKER" });
  return { id: profile.id, name, login: login.cookie };
}

/** The due date the harness gives every test order. */
const FIXTURE_DUE = "2026-10-01";

type Fixture = {
  owner: { cookie: string };
  order: Awaited<ReturnType<typeof createOrder>>;
  batchId: number;
  stages: Map<string, any>;
  /** The cutter named on the batch when its route starts at CUTTING. */
  cutter: Person | null;
  /** One worker per stage, created on first use and reused, so a stage keeps its people. */
  people: Map<string, Person>;
};

/**
 * One exact variant on a frozen route, built through the real API.
 *
 * The order is created big enough for every variant the test intends to add, because a
 * batch may not claim more pieces than the order item holds.
 */
async function variantOnRoute(
  stages: { stage: string; method?: string }[],
  opts: { quantity?: number; orderQuantity?: number; cuttingRate?: number; size?: string; color?: string } = {}
): Promise<Fixture> {
  const owner = await createOwner();
  const quantity = opts.quantity ?? 100;
  const order = await createOrder(owner.cookie, { quantity: opts.orderQuantity ?? quantity, unitPrice: 4500 });
  const size = opts.size ?? "10";
  const color = opts.color ?? "Navy";
  await expectStatus(
    await api("POST", "/api/order-sizes", {
      cookie: owner.cookie,
      body: { itemId: order.itemId, sizes: [{ size, color, quantity }] },
    }),
    201, `Record the exact variant (${color}, size ${size}, ${quantity} pieces)`
  );
  const listed = await api("GET", `/api/order-sizes?itemId=${order.itemId}`, { cookie: owner.cookie });
  const variant = listed.data.sizes[0];

  const cutter = stages[0]?.stage === "CUTTING" ? await person(owner.cookie, "Cutter", "Cutter") : null;
  const batch = await api("POST", "/api/batches", {
    cookie: owner.cookie,
    body: {
      orderId: order.orderId,
      orderItemId: order.itemId,
      quantity,
      orderVariantId: variant.id,
      ...(cutter ? { workerId: cutter.id, cuttingRate: opts.cuttingRate ?? 200 } : {}),
      stages,
    },
  });
  await expectStatus(batch, 201, `Freeze the route ${stages.map((s) => s.stage).join(" -> ")}`);
  const jobs = await api("GET", `/api/operations?batchId=${batch.data.id}`, { cookie: owner.cookie });
  return {
    owner, order, batchId: batch.data.id,
    stages: new Map<string, any>(jobs.data.map((job: any) => [job.stage, job])),
    cutter, people: new Map(),
  };
}

async function refresh(f: Fixture) {
  const jobs = await api("GET", `/api/operations?batchId=${f.batchId}`, { cookie: f.owner.cookie });
  f.stages = new Map<string, any>(jobs.data.map((job: any) => [job.stage, job]));
  return f;
}

/** The board, filtered to one batch so a test only ever looks at its own fixture. */
async function board(cookie: string, batchId: number, extra = "") {
  const response = await api("GET", `/api/production-control?batchId=${batchId}${extra}`, { cookie });
  await expectStatus(response, 200, "Load the production control board");
  const rows = response.data.rows as any[];
  assert.equal(rows.length, 1, `Exactly one batch row for batch ${batchId}`);
  return { row: rows[0], response };
}

/**
 * Work one stage: put the quantity into a named worker's hands, have THAT worker submit
 * it, and have the owner judge it.
 *
 * The submission must come from the worker who holds the stage - `PUT /api/operations`
 * refuses anybody else - and cutting already names its cutter on the batch, so it needs
 * no allocation row. `allocate` is optional so a stage can be worked twice (once, then
 * again to clear rework) without double-assigning the same pieces.
 */
async function workStage(
  f: Fixture,
  stage: string,
  opts: { submitQty: number; approved: number; rejected?: number; rework?: number; allocate?: number; pieceRate?: number }
) {
  const job = f.stages.get(stage);
  assert.ok(job, `The route has a ${stage} stage`);
  const worker = stage === "CUTTING" && f.cutter
    ? f.cutter
    : (f.people.get(stage) ?? await person(f.owner.cookie, `${stage} worker`, STAGE_ROLES[stage] ?? "Tailor"));
  if (stage !== "CUTTING") f.people.set(stage, worker);

  if (opts.allocate !== undefined) {
    await expectStatus(
      await api("POST", "/api/allocations", {
        cookie: f.owner.cookie,
        body: { operationId: job.id, workerId: worker.id, quantity: opts.allocate, pieceRate: opts.pieceRate ?? 300 },
      }),
      201, `${stage}: assign ${opts.allocate} to ${worker.name}`
    );
  }
  // `submitQty: 0` means "assign the stage and stop": the endpoint rightly refuses a
  // submission of zero pieces, so there is nothing to submit and nothing to judge.
  if (opts.submitQty <= 0) {
    await refresh(f);
    return f.stages.get(stage);
  }
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: worker.login, body: { id: job.id, submitQty: opts.submitQty } }),
    200, `${stage}: ${worker.name} submits ${opts.submitQty}`
  );
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: f.owner.cookie,
      body: {
        operationId: job.id, quantityApproved: opts.approved,
        quantityRejected: opts.rejected ?? 0, quantityRework: opts.rework ?? 0,
        notes: "Checked on the table",
      },
    }),
    201, `${stage}: owner approves ${opts.approved}`
  );
  await refresh(f);
  return f.stages.get(stage);
}

/**
 * A StageControl for the pure-function tests, with everything zeroed by default.
 *
 * `support` defaults to the shared EMPTY_STAGE_SUPPORT rather than a copy of it, so a
 * test that overrides one support figure cannot accidentally leave another stale, and
 * the empty value under test is the same object the production code falls back to.
 */
function stageControl(overrides: Partial<StageControl> = {}): StageControl {
  return {
    operationId: 1, position: 1, stage: "SEWING", method: null, status: "IN_PROGRESS",
    received: 0, submitted: 0, approved: 0, rework: 0, rejected: 0, remaining: 0,
    awaitingInspection: 0, assigned: 0, workers: [], openDispatches: 0,
    support: { ...EMPTY_STAGE_SUPPORT }, isCurrent: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. The derivation rules, as pure functions: no database, no today's date.
// ---------------------------------------------------------------------------

test("days until a due date is derived, and a missing or malformed date is null not zero", () => {
  const today = new Date("2026-10-04T12:00:00Z");
  assert.equal(daysUntil("2026-10-04", today), 0, "Due today is zero days away");
  assert.equal(daysUntil("2026-10-01", today), -3, "Three days past due is negative");
  assert.equal(daysUntil("2026-10-14", today), 10, "And a future date counts up");
  assert.equal(daysUntil(null, today), null, "No due date is unknown, not due today");
  assert.equal(daysUntil(undefined, today), null);
  assert.equal(daysUntil("", today), null, "An empty string is not a date");
  assert.equal(daysUntil("not-a-date", today), null, "A malformed value is refused rather than parsed as NaN");
  // A Date and its own YYYY-MM-DD text must agree, because orders.dueDate is a `date`
  // column that Drizzle hands back as a string while other callers pass a Date.
  assert.equal(daysUntil(new Date("2026-10-01T00:00:00Z"), today), daysUntil("2026-10-01", today));
});

test("the current position is the earliest stage with work left, not the last one touched", () => {
  assert.equal(currentPositionOf([]), null, "A batch with no route has no position");
  assert.equal(
    currentPositionOf([{ position: 1, remaining: 0 }, { position: 2, remaining: 40 }, { position: 3, remaining: 40 }]),
    2, "Position 1 is finished, so the work is at position 2"
  );
  assert.equal(
    currentPositionOf([{ position: 1, remaining: 10 }, { position: 2, remaining: 40 }]),
    1, "The earliest unfinished stage wins even though later stages also hold work"
  );
  assert.equal(
    currentPositionOf([{ position: 3, remaining: 0 }, { position: 1, remaining: 0 }]),
    3, "Everything finished: the batch sits at the end of its own route"
  );
});

test("the bottleneck is the unfinished stage holding the most work, ties going to the earliest", () => {
  assert.equal(bottleneckOf([]), null, "No route, no bottleneck");
  assert.equal(
    bottleneckOf([{ position: 1, stage: "CUTTING", remaining: 30 }, { position: 2, stage: "SEWING", remaining: 70 }])?.stage,
    "SEWING", "SEWING holds 70 against CUTTING's 30"
  );
  assert.equal(
    bottleneckOf([{ position: 1, stage: "CUTTING", remaining: 0 }, { position: 2, stage: "SEWING", remaining: 0 }]),
    null, "A finished batch has no bottleneck: there is nothing to unblock"
  );
  const tie = bottleneckOf([
    { position: 1, stage: "CUTTING", remaining: 25 },
    { position: 2, stage: "SEWING", remaining: 25 },
  ]);
  assert.equal(tie?.stage, "CUTTING", "A tie goes to the earlier stage, which is the one that must clear first");
  assert.equal(tie?.quantity, 25, "And it reports how much is held there");
});

test("flags are statements about records that exist, and COMPLETE short-circuits the rest", () => {
  assert.deepEqual(
    flagsFor({ remaining: 0, daysToDue: -30, current: stageControl({ rework: 5 }), routeComplete: true }),
    ["COMPLETE"], "A finished batch is not also reported as overdue or blocked"
  );
  const unassigned = flagsFor({
    remaining: 40, daysToDue: null,
    current: stageControl({ received: 40, assigned: 0, workers: [] }), routeComplete: false,
  });
  assert.ok(unassigned.includes("UNASSIGNED"), "Work is sitting at a stage nobody is assigned to");
  assert.ok(isStuck(unassigned, 40), "and that is not moving");
  assert.ok(!isStuck(["OVERDUE"], 0), "Stuck needs work left to be stuck on");
  assert.ok(!isStuck(["OVERDUE"], 40), "Being late is urgent but it is not a block: nothing is stopping the work");

  // An outsourced stage waiting on a vendor is NOT unassigned: somebody has it, they are
  // just not on the payroll.
  const outsourced = flagsFor({
    remaining: 40, daysToDue: null,
    current: stageControl({ received: 40, assigned: 0, workers: [], openDispatches: 1 }), routeComplete: false,
  });
  assert.ok(outsourced.includes("OUTSOURCED_WAITING"), "A dispatch is out with a vendor");
  assert.ok(!outsourced.includes("UNASSIGNED"), "which is not the same as nobody having the work");

  // A worker named on the stage itself, with no allocation row, still means it is manned.
  const nominal = flagsFor({
    remaining: 40, daysToDue: null,
    current: stageControl({ received: 40, assigned: 0, workers: [{ workerId: 7, name: "Tailor A", quantity: 0, remaining: 0 }] }),
    routeComplete: false,
  });
  assert.ok(!nominal.includes("UNASSIGNED"), "A stage with a worker named on it is assigned");

  const upstream = flagsFor({
    remaining: 40, daysToDue: null,
    current: stageControl({ position: 2, received: 0 }), routeComplete: false,
  });
  assert.ok(upstream.includes("WAITING_UPSTREAM"), "Position 2 holds nothing because position 1 released nothing");

  assert.deepEqual(
    flagsFor({ remaining: 40, daysToDue: null, current: null, routeComplete: false }),
    ["NO_ROUTE"], "A batch that was never routed says so, and says nothing else"
  );

  const awaiting = flagsFor({
    remaining: 40, daysToDue: null,
    current: stageControl({ received: 40, submitted: 40, approved: 0, awaitingInspection: 40 }), routeComplete: false,
  });
  assert.ok(awaiting.includes("AWAITING_INSPECTION"), "Forty pieces are back and nobody has judged them");

  assert.ok(
    flagsFor({ remaining: 15, daysToDue: null, current: stageControl({ rework: 15, remaining: 15 }), routeComplete: false })
      .includes("REWORK_PENDING"), "Fifteen pieces came back for rework"
  );
  assert.ok(
    !flagsFor({ remaining: 15, daysToDue: null, current: stageControl({ rework: 15, remaining: 0 }), routeComplete: false })
      .includes("REWORK_PENDING"), "Rework that has since been cleared is not a live block"
  );
});

test("overdue and due-soon are mutually exclusive, and overdue wins the ranking", () => {
  const late = flagsFor({ remaining: 10, daysToDue: -1, current: stageControl({ received: 10 }), routeComplete: false });
  assert.ok(late.includes("OVERDUE"), "Past its due date");
  assert.ok(!late.includes("DUE_SOON"), "It cannot be both overdue and merely due soon");
  const soon = flagsFor({ remaining: 10, daysToDue: 3, current: stageControl({ received: 10 }), routeComplete: false });
  assert.ok(soon.includes("DUE_SOON"), "Three days is the boundary, and it is inclusive");
  assert.ok(!soon.includes("OVERDUE"));
  const fine = flagsFor({ remaining: 10, daysToDue: 4, current: stageControl({ received: 10 }), routeComplete: false });
  assert.ok(!fine.includes("DUE_SOON"), "Four days is not yet due soon");
  assert.ok(!fine.includes("OVERDUE"));
  const noDate = flagsFor({ remaining: 10, daysToDue: null, current: stageControl({ received: 10 }), routeComplete: false });
  assert.ok(!noDate.includes("OVERDUE") && !noDate.includes("DUE_SOON"), "An order with no due date is neither");
});

test("priority is a derived rank, and being late outranks being blocked", () => {
  assert.deepEqual(priorityFor({ remaining: 0, daysToDue: -90, stuck: false }), { rank: 6, label: "COMPLETE" },
    "Nothing left to do sorts last, however late the order was");
  assert.deepEqual(priorityFor({ remaining: 10, daysToDue: -1, stuck: true }), { rank: 1, label: "OVERDUE" },
    "Overdue AND blocked: overdue is the more urgent fact");
  assert.deepEqual(priorityFor({ remaining: 10, daysToDue: 2, stuck: true }), { rank: 2, label: "DUE SOON" });
  assert.deepEqual(priorityFor({ remaining: 10, daysToDue: 30, stuck: true }), { rank: 3, label: "BLOCKED" },
    "Plenty of time, but nothing is moving");
  assert.deepEqual(priorityFor({ remaining: 10, daysToDue: 14, stuck: false }), { rank: 4, label: "SCHEDULED" },
    "A fortnight out is the scheduled boundary, inclusive");
  assert.deepEqual(priorityFor({ remaining: 10, daysToDue: 15, stuck: false }), { rank: 5, label: "NORMAL" });
  assert.deepEqual(priorityFor({ remaining: 10, daysToDue: null, stuck: false }), { rank: 5, label: "NORMAL" },
    "No due date: nothing to rank it by, so it is ordinary work");
  for (const rank of [1, 2, 3, 4, 5, 6]) {
    assert.equal(typeof PRIORITY_LABELS[rank], "string", `Rank ${rank} has a label, so the screen never prints a bare number`);
  }
});

test("a variant is described by the size and colour the order recorded, and by neither if it has none", () => {
  // The house rendering, used by the production board and the operations list too, so a
  // controller comparing screens never has to translate between two spellings.
  assert.equal(variantText("10", "Navy"), "Navy • Size 10");
  assert.equal(variantText(null, "Navy"), "Navy", "A colour with no size still identifies the garment");
  assert.equal(variantText("10", null), "10", "and so does a size with no colour");
  assert.equal(variantText("", "  "), null, "Blank strings are not a variant");
  assert.equal(variantText(null, null), null);
});

// ---------------------------------------------------------------------------
// 2. The board: derived from the ledger, the route and the allocations.
// ---------------------------------------------------------------------------

test("a batch that has not started reports what the order asked for and where its own route begins", async () => {
  const f = await variantOnRoute([{ stage: "CUTTING" }, { stage: "SEWING" }, { stage: "IRONING" }]);
  const { row } = await board(f.owner.cookie, f.batchId);

  assert.equal(row.ordered, 100, "Ordered is the batch quantity, taken from the record");
  assert.equal(row.finished, 0, "Nothing has been approved at the last stage yet");
  assert.equal(row.remaining, 100, "So all 100 are still to do");
  assert.equal(row.routeLength, 3, "The route frozen on this batch has three stages");
  assert.equal(row.currentPosition, 1, "The work is at position 1 of ITS route");
  assert.equal(row.currentStage, "CUTTING");
  assert.deepEqual(row.route.map((s: any) => s.stage), ["CUTTING", "SEWING", "IRONING"], "In the route's own order");
  assert.deepEqual(row.route.map((s: any) => s.position), [1, 2, 3], "Numbered by that route, not by the house list");
  assert.equal(row.route[0].received, 100, "The first stage holds the 100 the batch put into it");
  assert.equal(row.route[1].received, 0, "And nothing has been released onward");
  assert.equal(row.variant, "Navy • Size 10", "One exact garment, named the way the rest of the system names it");
  assert.equal(row.daysToDue, daysUntil(FIXTURE_DUE), "The due date is the order's own");
  // The batch names its cutter, so cutting is manned even before any allocation exists.
  assert.equal(row.route[0].workers.length, 1, "The cutter named on the batch is shown");
  assert.equal(row.route[0].workers[0].name, f.cutter?.name);
  assert.ok(!row.flags.includes("UNASSIGNED"), "A stage with a worker named on it is not unassigned");
  assert.ok(row.flags.includes("WAITING_UPSTREAM") === false, "Position 1 is not waiting on anything upstream");
});

test("work sitting at a stage with nobody named and nothing allocated is reported UNASSIGNED", async () => {
  // A route that does not start at cutting has no cutter named on the batch, and no
  // allocation has been made, so the garments are on the floor with nobody holding them.
  const f = await variantOnRoute([{ stage: "SEWING" }, { stage: "IRONING" }]);
  const { row } = await board(f.owner.cookie, f.batchId);
  assert.equal(row.route[0].received, 100, "The stage holds the work");
  assert.equal(row.route[0].assigned, 0, "Nobody is assigned to it");
  assert.equal(row.route[0].workers.length, 0, "and no worker is named on it");
  assert.ok(row.flags.includes("UNASSIGNED"), "So the board says the work is unassigned");
  assert.equal(row.stuck, true, "and that it is not moving");
  assert.equal(row.currentStage, "SEWING");
});

test("the current stage follows the batch's OWN frozen route, including stages it skips", async () => {
  // A route that skips SEWING entirely. IRONING is sixth in the house list; on this batch
  // it must be position 2, because position is a fact about THIS route.
  const f = await variantOnRoute([{ stage: "CUTTING" }, { stage: "IRONING" }]);
  const { row } = await board(f.owner.cookie, f.batchId);
  assert.equal(row.routeLength, 2, "Two stages were frozen, so two are reported");
  assert.deepEqual(row.route.map((s: any) => [s.position, s.stage]), [[1, "CUTTING"], [2, "IRONING"]]);
  assert.ok(!row.route.some((s: any) => s.stage === "SEWING"), "A stage this route does not have is not invented for it");
  assert.equal(row.currentStage, "CUTTING");

  await workStage(f, "CUTTING", { submitQty: 100, approved: 100 });
  const after = await board(f.owner.cookie, f.batchId);
  assert.equal(after.row.currentPosition, 2, "Cutting is clear, so the work is now at position 2");
  assert.equal(after.row.currentStage, "IRONING", "Which on this route is IRONING, not SEWING");
  assert.equal(after.row.route[1].received, 100, "All 100 approved at cutting were released into it");
});

test("only approved quantity moves downstream, and the board agrees with the ledger stage by stage", async () => {
  const f = await variantOnRoute([{ stage: "CUTTING" }, { stage: "SEWING" }, { stage: "PACKING" }]);
  // 100 submitted, 70 approved, 30 rejected: only the 70 may reach SEWING.
  await workStage(f, "CUTTING", { submitQty: 100, approved: 70, rejected: 30 });
  await workStage(f, "SEWING", { submitQty: 0, approved: 0, allocate: 70 });
  const { row } = await board(f.owner.cookie, f.batchId);

  const cutting = row.route.find((s: any) => s.stage === "CUTTING");
  const sewing = row.route.find((s: any) => s.stage === "SEWING");
  assert.equal(cutting.submitted, 100, "A hundred were put on the table");
  assert.equal(cutting.approved, 70, "Seventy passed");
  assert.equal(cutting.rejected, 30, "Thirty did not");
  // Rejected pieces are written off, not owed: the stage is finished with them, so its
  // own remaining is zero. The shortfall stays visible at the ORDER level, where
  // `remaining` is still 100 against a `finished` of 0 - which is the honest picture,
  // because thirty garments will never arrive unless somebody cuts thirty more.
  assert.equal(cutting.remaining, 0, "Rejected work is written off, not carried as owed");
  assert.equal(row.route.find((s: any) => s.stage === "CUTTING").rejected, 30, "and the thirty are reported as rejected");
  assert.equal(sewing.received, 70, "And exactly the approved seventy reached sewing - never the hundred submitted");
  assert.equal(sewing.remaining, 70);
  assert.equal(sewing.assigned, 70, "All seventy are in somebody's hands");
  assert.equal(row.finished, 0, "Nothing has been approved at the LAST stage, so nothing is finished");
  assert.equal(row.remaining, 100, "The order still owes its hundred");
  assert.equal(row.rejected, 30, "Rejected is surfaced at the top of the row too");
  assert.equal(row.currentStage, "SEWING", "Cutting still owes thirty, but sewing is where the garments are");
  assert.deepEqual(
    { stage: row.bottleneck.stage, quantity: row.bottleneck.quantity },
    { stage: "SEWING", quantity: 70 }, "The bottleneck is the stage holding the most unfinished work"
  );
});

test("finished is what the LAST stage of that route approved, and a clear route reports COMPLETE", async () => {
  const f = await variantOnRoute([{ stage: "CUTTING" }, { stage: "SEWING" }, { stage: "PACKING" }]);
  await workStage(f, "CUTTING", { submitQty: 100, approved: 100 });
  await workStage(f, "SEWING", { submitQty: 100, approved: 96, rework: 4, allocate: 100 });

  const midway = await board(f.owner.cookie, f.batchId);
  assert.equal(midway.row.finished, 0, "Approved at an earlier stage is not finished");
  assert.equal(midway.row.route.find((s: any) => s.stage === "SEWING").rework, 4, "Four came back for rework");
  assert.ok(midway.row.flags.includes("REWORK_PENDING"), "and that is a live block");
  assert.equal(midway.row.stuck, true);
  assert.equal(midway.row.remaining, 100, "Nothing has cleared the last stage, so the order still owes everything");

  // Clear the rework through the same worker's existing share, then finish packing.
  await workStage(f, "SEWING", { submitQty: 4, approved: 4 });
  await workStage(f, "PACKING", { submitQty: 100, approved: 100, allocate: 100 });

  // Clearing the last stage completes the batch and its order, and a closed order is out
  // of the working set by default - which is the point of the filter, so ask for it back.
  const done = await board(f.owner.cookie, f.batchId, "&all=1");
  assert.equal(done.row.finished, 100, "A hundred approved at the last stage of this route");
  assert.equal(done.row.remaining, 0, "Nothing left to do");
  assert.deepEqual(done.row.flags, ["COMPLETE"], "One flag, and no leftovers from the stages it passed through");
  assert.equal(done.row.stuck, false, "A finished batch is not stuck");
  assert.equal(done.row.priority, 6, "So it sorts last");
  assert.equal(done.row.priorityLabel, "COMPLETE");
  assert.equal(done.row.bottleneck, null, "There is nothing to unblock");
  assert.equal(done.row.route[done.row.route.length - 1].approved, 100, "The last stage of THIS route is what counts");
});

test("work submitted and not yet judged is reported as awaiting inspection, and blocks the batch", async () => {
  const f = await variantOnRoute([{ stage: "SEWING" }, { stage: "IRONING" }]);
  const worker = await person(f.owner.cookie, "Tailor A", "Tailor");
  const sewing = f.stages.get("SEWING");
  await expectStatus(
    await api("POST", "/api/allocations", {
      cookie: f.owner.cookie,
      body: { operationId: sewing.id, workerId: worker.id, quantity: 40, pieceRate: 450 },
    }), 201, "Tailor A takes 40"
  );
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: worker.login, body: { id: sewing.id, submitQty: 40 } }),
    200, "Forty pieces come back from the machine"
  );

  const { row } = await board(f.owner.cookie, f.batchId);
  const stage = row.route.find((s: any) => s.stage === "SEWING");
  assert.equal(stage.submitted, 40, "Forty were submitted");
  assert.equal(stage.approved, 0, "Nobody has judged them");
  assert.equal(stage.awaitingInspection, 40, "So all forty are waiting for inspection");
  assert.equal(row.awaitingInspectionTotal, 40, "and the row totals them across the route");
  assert.ok(row.flags.includes("AWAITING_INSPECTION"));
  assert.equal(row.stuck, true, "Work that is back and unjudged is not moving");
  assert.equal(row.finished, 0, "Unjudged work is never counted as finished");
  assert.equal(stage.assigned, 40, "It is in Tailor A's hands, so it is not unassigned");
  assert.ok(!row.flags.includes("UNASSIGNED"));
});

test("assigned is the sum of the live shares, and names the people holding them", async () => {
  const f = await variantOnRoute([{ stage: "SEWING" }, { stage: "IRONING" }]);
  const a = await person(f.owner.cookie, "Tailor A", "Tailor");
  const b = await person(f.owner.cookie, "Tailor B", "Tailor");
  const sewing = f.stages.get("SEWING");
  for (const [worker, quantity, rate] of [[a, 40, 450], [b, 35, 400]] as const) {
    await expectStatus(
      await api("POST", "/api/allocations", {
        cookie: f.owner.cookie,
        body: { operationId: sewing.id, workerId: worker.id, quantity, pieceRate: rate },
      }), 201, `${worker.name} takes ${quantity}`
    );
  }

  const { row } = await board(f.owner.cookie, f.batchId);
  const stage = row.route.find((s: any) => s.stage === "SEWING");
  assert.equal(stage.assigned, 75, "Forty plus thirty-five, summed from the allocation rows");
  assert.equal(row.assigned, 75, "and rolled up onto the batch");
  assert.equal(stage.workers.length, 2, "Two people hold it");
  assert.deepEqual(stage.workers.map((w: any) => w.name).sort(), [a.name, b.name].sort(), "Named, so the controller knows who to chase");
  assert.equal(stage.workers.find((w: any) => w.workerId === a.id).quantity, 40, "Each with their own quantity");
  assert.equal(stage.workers.find((w: any) => w.workerId === b.id).quantity, 35);
  assert.ok(!row.flags.includes("UNASSIGNED"), "The stage is no longer unassigned");
  assert.equal(row.route.find((s: any) => s.stage === "IRONING").assigned, 0, "A stage nobody has been given yet is still at zero");
});

test("an outsourced stage waiting on a vendor is flagged as waiting, not as unassigned", async () => {
  const f = await variantOnRoute([{ stage: "CUTTING" }, { stage: "SEWING", method: "OUTSOURCED" }]);
  await workStage(f, "CUTTING", { submitQty: 100, approved: 100 });
  await expectStatus(
    await api("POST", "/api/external-work", {
      cookie: f.owner.cookie,
      body: {
        operationId: f.stages.get("SEWING").id, vendorName: "Emeka Embroidery", quantitySent: 100,
        unitCost: 150, expectedReturnAt: "2026-10-20", notes: "Send the whole lot out",
      },
    }), 201, "A hundred are sent out to a vendor"
  );

  const { row } = await board(f.owner.cookie, f.batchId);
  const stage = row.route.find((s: any) => s.stage === "SEWING");
  assert.equal(stage.method, "OUTSOURCED", "The route records how the stage is done");
  assert.equal(stage.openDispatches, 1, "One dispatch is still out");
  assert.ok(row.flags.includes("OUTSOURCED_WAITING"), "So the batch is waiting on somebody else");
  assert.ok(!row.flags.includes("UNASSIGNED"), "A vendor holding the work is not the same as nobody holding it");
  assert.equal(row.stuck, true);
  assert.equal(stage.assigned, 0, "A vendor is not a worker and is never counted as an assignment");
  assert.equal(stage.workers.length, 0, "and never appears in the list of people holding the stage");
  assert.equal(row.finished, 0, "Sent out is not approved: nothing moves on until it returns AND is accepted");
});

test("a worker cannot see the production control board", async () => {
  const f = await variantOnRoute([{ stage: "SEWING" }]);
  const helper = await person(f.owner.cookie, "Support Helper", "Support Worker");
  const response = await api("GET", `/api/production-control?batchId=${f.batchId}`, { cookie: helper.login });
  assert.equal(response.status, 403, "The board is a supervisor view, not a worker one");
  assert.ok(helper.id > 0, "The worker exists and was simply refused");
});

test("the board is read-only: it exports a GET and nothing that could write", () => {
  assert.equal(typeof controlRoute.GET, "function", "GET is the only handler");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(
      (controlRoute as Record<string, unknown>)[method], undefined,
      `No ${method}: there is deliberately no way to write a quantity through this endpoint`
    );
  }
});

test("no money figure appears anywhere in the board's response", async () => {
  // A cutting rate on the batch and a piece rate on the allocation: two places a money
  // figure exists behind this board, so a leak would have something to leak.
  const f = await variantOnRoute([{ stage: "CUTTING" }, { stage: "SEWING" }], { cuttingRate: 200 });
  await workStage(f, "CUTTING", { submitQty: 100, approved: 100 });
  const a = await person(f.owner.cookie, "Tailor A", "Tailor");
  await expectStatus(
    await api("POST", "/api/allocations", {
      cookie: f.owner.cookie,
      body: { operationId: f.stages.get("SEWING").id, workerId: a.id, quantity: 40, pieceRate: 450 },
    }), 201, "Give the stage a piece rate, so a leak would have something to leak"
  );
  const { response } = await board(f.owner.cookie, f.batchId);

  // Walk every key at every depth. A rate on an allocation, a unit cost on a dispatch or a
  // price on an order must not reach a screen whose whole job is quantities.
  const moneyKeys = /(amount|price|cost|paid|payable|rate|payroll|earning|profit|margin|revenue|commission|wage|salary)/i;
  const offenders: string[] = [];
  (function walk(value: unknown, path: string) {
    if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${path}[${index}]`));
    if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (moneyKeys.test(key)) offenders.push(`${path}.${key}`);
        walk(inner, `${path}.${key}`);
      }
    }
  })(response.data, "response");
  assert.deepEqual(offenders, [], "The board carries no money field at any depth");
});

test("filters that need a derived figure narrow the window and say that they did", async () => {
  const f = await variantOnRoute([{ stage: "CUTTING" }, { stage: "SEWING" }, { stage: "IRONING" }]);

  // Search is pushed into SQL, on the order number or the school's name.
  const byNumber = await api("GET", `/api/production-control?search=${encodeURIComponent(f.order.orderNumber)}`, { cookie: f.owner.cookie });
  await expectStatus(byNumber, 200, "Search by order number");
  assert.ok((byNumber.data.rows as any[]).some((row) => row.batchId === f.batchId), "The batch is found by its order number");
  const bySchool = await api("GET", "/api/production-control?search=Definitely+No+Such+School", { cookie: f.owner.cookie });
  await expectStatus(bySchool, 200, "Search for something that is not there");
  assert.equal((bySchool.data.rows as any[]).length, 0, "A search that matches nothing returns nothing");

  // These three can only be applied AFTER derivation, because current stage, priority and
  // blocked-ness are computed rather than stored. The response must not pretend otherwise.
  const byStage = await api("GET", "/api/production-control?stage=CUTTING", { cookie: f.owner.cookie });
  await expectStatus(byStage, 200, "Filter by current stage");
  assert.ok((byStage.data.rows as any[]).every((row) => row.currentStage === "CUTTING"), "Every row returned is at cutting");
  assert.ok((byStage.data.rows as any[]).some((row) => row.batchId === f.batchId), "including this fixture");
  assert.ok(byStage.data.appliedAfterDerivation.includes("stage"), "and the response says this filter was applied after derivation");

  const byPriority = await api("GET", "/api/production-control?priority=1", { cookie: f.owner.cookie });
  await expectStatus(byPriority, 200, "Filter by priority rank");
  assert.ok((byPriority.data.rows as any[]).every((row) => row.priority === 1), "Only rank-1 rows");
  assert.ok(byPriority.data.appliedAfterDerivation.includes("priority"));

  const blocked = await api("GET", "/api/production-control?blockedOnly=1", { cookie: f.owner.cookie });
  await expectStatus(blocked, 200, "Filter to blocked batches");
  assert.ok((blocked.data.rows as any[]).every((row) => row.stuck === true), "Only stuck batches");
  assert.ok(blocked.data.appliedAfterDerivation.includes("blockedOnly"));

  // A pushed-down filter does NOT claim to have been applied after derivation.
  assert.ok(!byStage.data.appliedAfterDerivation.includes("search"), "Search went into the SQL, so it is not listed as post-derivation");
  assert.ok(!byStage.data.appliedAfterDerivation.includes("orderId"), "and neither did the order filter");
  assert.equal(typeof byStage.data.window.cap, "number", "The window reports its cap");
  assert.equal(byStage.data.window.capped, false, "A handful of fixtures does not reach it");
  assert.ok(byStage.data.window.derived >= byStage.data.rows.length, "It derived at least as many rows as it returned");
  assert.equal(byStage.data.priorities[1], "OVERDUE", "The rank labels come with the response");
  assert.equal(byStage.data.priorities[6], "COMPLETE", "so the screen can render a filter without hardcoding them");
  assert.ok(Array.isArray(byStage.data.stages), "and so does the stage list the filter dropdown needs");
});

test("an order with two exact variants rolls up into one order row without losing either batch", async () => {
  // The order is for 100; sixty navy size 10 and forty white size 12 are two separate
  // garments on two separate routes, and must not be blended into one number.
  const f = await variantOnRoute(
    [{ stage: "SEWING" }, { stage: "IRONING" }],
    { quantity: 60, orderQuantity: 100, size: "10", color: "Navy" }
  );
  await expectStatus(
    await api("POST", "/api/order-sizes", {
      cookie: f.owner.cookie,
      body: { itemId: f.order.itemId, sizes: [{ size: "12", color: "White", quantity: 40 }] },
    }), 201, "Add the second variant to the same order"
  );
  const listed = await api("GET", `/api/order-sizes?itemId=${f.order.itemId}`, { cookie: f.owner.cookie });
  const second = (listed.data.sizes as any[]).find((size: any) => size.color === "White");
  const secondBatch = await api("POST", "/api/batches", {
    cookie: f.owner.cookie,
    body: {
      orderId: f.order.orderId, orderItemId: f.order.itemId, quantity: 40, orderVariantId: second.id,
      stages: [{ stage: "SEWING" }, { stage: "IRONING" }],
    },
  });
  await expectStatus(secondBatch, 201, "Put the second variant on its own route");

  const response = await api("GET", `/api/production-control?orderId=${f.order.orderId}`, { cookie: f.owner.cookie });
  await expectStatus(response, 200, "Load the order");
  const rows = response.data.rows as any[];
  assert.equal(rows.length, 2, "One row per batch: the two variants stay separate");
  assert.deepEqual(
    rows.map((row: any) => row.variant).sort(),
    ["Navy • Size 10", "White • Size 12"].sort(),
    "Both exact garments are named, and they stay distinguishable"
  );

  const orders = response.data.orders as any[];
  assert.equal(orders.length, 1, "and they roll up into ONE order row");
  assert.equal(orders[0].orderId, f.order.orderId);
  assert.equal(orders[0].orderNumber, f.order.orderNumber);
  assert.equal(orders[0].school, rows[0].school, "The school is carried onto the order grain too");
  assert.equal(orders[0].ordered, 100, "Sixty navy plus forty white");
  assert.equal(orders[0].remaining, 100, "Neither has started");
  assert.equal(orders[0].batches, 2, "The order row says how many batches it is made of");
  assert.equal(typeof orders[0].priority, "number", "with its own derived priority");
  assert.equal(
    orders[0].priority, Math.min(...rows.map((row) => row.priority)),
    "An order is as urgent as its MOST urgent batch, never an average of them"
  );
  assert.equal(
    orders[0].daysToDue, rows[0].daysToDue, "One order, one due date"
  );
});

test("the board is bounded: total counts every match while the page returns a slice", async () => {
  const f = await variantOnRoute([{ stage: "SEWING" }]);
  const page = await api("GET", "/api/production-control?limit=1&offset=0", { cookie: f.owner.cookie });
  await expectStatus(page, 200, "Ask for one row");
  assert.equal((page.data.rows as any[]).length, 1, "One row comes back");
  assert.ok(page.data.total >= 1, "and the total describes every match, not just the page");
  assert.equal(page.headers.get("X-Total-Count"), String(page.data.total), "The header agrees with the body");
  const beyond = await api("GET", "/api/production-control?limit=1&offset=100000", { cookie: f.owner.cookie });
  await expectStatus(beyond, 200, "Ask past the end");
  assert.equal((beyond.data.rows as any[]).length, 0, "An empty page, not an error and not the whole table");
  assert.equal(beyond.data.total, page.data.total, "The total is stable across pages");
  assert.ok(f.batchId > 0, "The fixture still exists");
});

test("a closed order is out of the working set by default and comes back on request", async () => {
  const f = await variantOnRoute([{ stage: "SEWING" }]);
  await expectStatus(
    await api("PUT", `/api/orders/${f.order.orderId}`, { cookie: f.owner.cookie, body: { status: "COMPLETED" } }),
    200, "Close the order"
  );
  const closed = await api("GET", `/api/production-control?batchId=${f.batchId}`, { cookie: f.owner.cookie });
  await expectStatus(closed, 200, "Load the board");
  assert.equal((closed.data.rows as any[]).length, 0, "A closed order is out of the working set by default");
  const all = await api("GET", `/api/production-control?batchId=${f.batchId}&all=1`, { cookie: f.owner.cookie });
  await expectStatus(all, 200, "Load the board including closed orders");
  assert.equal((all.data.rows as any[]).length, 1, "and asking for it brings the batch back");
  assert.equal((all.data.rows as any[])[0].orderStatus, "COMPLETED", "Labelled as closed, not presented as open work");
});
