/**
 * VARIANT COMPLETION FROM APPROVED PRODUCTION, AND WHO RECORDED THE DOCUMENT.
 *
 * Two hardening items, both about a number nobody may simply assert:
 *
 *   1. `order_item_sizes.completed` - how many of one EXACT garment (size and colour) are
 *      finished. It used to be free text: a quantity with no event behind it, editable by
 *      anyone with an Owner session. A derived figure already existed beside it, but the
 *      derivation only won when it was GREATER THAN ZERO, so a number somebody typed survived
 *      whenever production had approved nothing yet - twenty pieces submitted and awaiting
 *      inspection, or every piece rejected, still showed the typed figure as finished. The
 *      ledger now decides wherever production exists, including when it says zero, and the
 *      recorded figure stands only where there is no production to consult.
 *
 *   2. `payments`, `packing_records` and `deliveries` - the only money-and-goods mutations
 *      that could answer WHAT and WHEN but not WHO. Each now carries the actor taken from the
 *      authenticated session, and nothing may supply it from the request body.
 *
 * Runs against an empty database. Every fixture is created here through the API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGE_ROLES } from "@/lib/format";
import { completedForVariants } from "@/lib/production-route";
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

async function person(ownerCookie: string, label: string, role: string): Promise<Person> {
  const name = unique(label);
  const profile = await createWorker(ownerCookie, { name, specialty: role, roles: [role], paymentType: "PER_PIECE" });
  const login = await createStaff(ownerCookie, { name, role: "WORKER" });
  return { id: profile.id, name, login: login.cookie };
}

type World = { owner: { cookie: string }; order: Awaited<ReturnType<typeof createOrder>>; variants: any[] };

/** An order whose item carries several exact variants, each with a recorded `completed`. */
async function world(
  variants: { size: string; color: string; quantity: number; completed?: number }[]
): Promise<World> {
  const owner = await createOwner();
  const total = variants.reduce((sum, v) => sum + v.quantity, 0);
  const order = await createOrder(owner.cookie, { quantity: total, unitPrice: 4500 });
  await expectStatus(
    await api("POST", "/api/order-sizes", {
      cookie: owner.cookie,
      body: {
        itemId: order.itemId,
        sizes: variants.map((v) => ({ size: v.size, color: v.color, quantity: v.quantity, completed: v.completed ?? 0 })),
      },
    }),
    201, "Record the exact variants"
  );
  return { owner, order, variants: await sizesOf(owner, order.itemId) };
}

async function sizesOf(owner: { cookie: string }, itemId: number) {
  const res = await api("GET", `/api/order-sizes?itemId=${itemId}`, { cookie: owner.cookie });
  return (await expectStatus(res, 200, "Read the variants back")).sizes;
}

type Batch = { batchId: number; stages: Map<string, any>; cutter: Person | null };

/** Freeze a route over one exact variant. */
async function makeBatch(w: World, variantId: number, quantity: number, stages: string[]): Promise<Batch> {
  const cutter = stages[0] === "CUTTING" ? await person(w.owner.cookie, "Cutter", "Cutter") : null;
  const created = await api("POST", "/api/batches", {
    cookie: w.owner.cookie,
    body: {
      orderId: w.order.orderId, orderItemId: w.order.itemId, quantity, orderVariantId: variantId,
      ...(cutter ? { workerId: cutter.id, cuttingRate: 200 } : {}),
      stages: stages.map((stage) => ({ stage })),
    },
  });
  await expectStatus(created, 201, `Freeze the route ${stages.join(" -> ")} over ${quantity} pieces`);
  const jobs = await api("GET", `/api/operations?batchId=${created.data.id}`, { cookie: w.owner.cookie });
  return { batchId: created.data.id, stages: new Map(jobs.data.map((j: any) => [j.stage, j])), cutter };
}

/**
 * Work one stage: allocate it (optionally split across several workers), submit, and judge.
 * `submit` is what the workers hand in; `approve` / `rework` / `reject` is the inspection.
 * Pass `inspect: false` to submit and leave it unjudged.
 */
async function workStage(
  w: World, b: Batch, stage: string,
  opts: { shares?: number[]; submit?: number; approve?: number; rework?: number; reject?: number; inspect?: boolean }
) {
  const job = b.stages.get(stage);
  assert.ok(job, `The route has a ${stage} stage`);
  const shares = opts.shares ?? [opts.submit ?? 0];
  for (const share of shares) {
    const who = stage === "CUTTING" && b.cutter && shares.length === 1
      ? b.cutter
      : await person(w.owner.cookie, `${stage} hand`, STAGE_ROLES[stage] ?? "Tailor");
    await expectStatus(
      await api("POST", "/api/allocations", {
        cookie: w.owner.cookie,
        body: { operationId: job.id, workerId: who.id, quantity: share, pieceRate: 300 },
      }),
      201, `${stage}: assign ${share} to ${who.name}`
    );
    await expectStatus(
      await api("PUT", "/api/operations", { cookie: who.login, body: { id: job.id, submitQty: share } }),
      200, `${stage}: ${who.name} submits ${share}`
    );
  }
  if (opts.inspect === false) return;
  const submitted = shares.reduce((sum, s) => sum + s, 0);
  const approve = opts.approve ?? submitted;
  const body: Record<string, unknown> = {
    operationId: job.id,
    quantityApproved: approve,
    quantityRework: opts.rework ?? 0,
    quantityRejected: opts.reject ?? 0,
    notes: "Checked on the table",
  };
  // A stage split across several workers is judged through the attribution mechanism that
  // already exists: one line per share, naming whose work was approved. That is what keeps
  // each person's pay attached to their own pieces.
  if (shares.length > 1) {
    const listed = await api("GET", `/api/allocations?operationId=${job.id}`, { cookie: w.owner.cookie });
    const allocations = await expectStatus(listed, 200, "Read the shares back");
    const rows = Array.isArray(allocations) ? allocations : allocations.data ?? [];
    assert.equal(rows.length, shares.length, "One live share per worker");
    let leftApprove = approve;
    let leftRework = opts.rework ?? 0;
    let leftReject = opts.reject ?? 0;
    body.attributions = rows.map((row: any) => {
      const cap = Number(row.quantityAllocated ?? row.quantity ?? 0);
      const a = Math.min(cap, leftApprove); leftApprove -= a;
      const r = Math.min(cap - a, leftRework); leftRework -= r;
      const j = Math.min(cap - a - r, leftReject); leftReject -= j;
      return { allocationId: row.id, quantityApproved: a, quantityRework: r, quantityRejected: j };
    });
  }
  await expectStatus(
    await api("POST", "/api/inspections", { cookie: w.owner.cookie, body }),
    201, `${stage}: approve ${approve}`
  );
}

// ---------------------------------------------------------------------------
// 1. A size's completed quantity comes from approved production.
// ---------------------------------------------------------------------------

test("a variant with no production keeps the figure somebody recorded, and says which it is", async () => {
  const w = await world([
    { size: "10", color: "Navy", quantity: 20, completed: 7 },
    { size: "12", color: "Navy", quantity: 10 },
  ]);
  const [navy, twelve] = w.variants;

  assert.equal(navy.produced, false, "Nothing has been produced against this variant");
  assert.equal(navy.completedFromProduction, 0, "so the ledger has nothing to say");
  assert.equal(navy.completed, 7, "and the recorded figure stands rather than being quietly zeroed");
  assert.equal(navy.completedRecorded, 7, "reported separately, so the two are never confused");
  assert.equal(twelve.completed, 0, "A variant nobody recorded anything against is simply zero");
});

test("submitted but unapproved production does not complete anything, and replaces the typed figure", async () => {
  // This is the hole the derivation used to have: `derived > 0 ? derived : recorded` let a
  // number somebody typed survive whenever production had approved nothing yet.
  const w = await world([{ size: "10", color: "Navy", quantity: 20, completed: 7 }]);
  const variant = w.variants[0];
  const b = await makeBatch(w, variant.id, 20, ["CUTTING", "SEWING"]);

  await workStage(w, b, "CUTTING", { submit: 20, approve: 20 });
  await workStage(w, b, "SEWING", { submit: 20, inspect: false });

  const [after] = await sizesOf(w.owner, w.order.itemId);
  assert.equal(after.produced, true, "This variant has production behind it");
  assert.equal(after.completedFromProduction, 0, "Twenty pieces are sitting unjudged, so nothing is finished");
  assert.equal(after.completed, 0, "So the answer is zero - NOT the seven somebody typed");
  assert.notEqual(after.completed, 7, "A typed figure cannot survive once production exists");
  assert.equal(after.completedRecorded, 7, "and what was typed is still visible, not overwritten");

  // Judging them is what completes them.
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: w.owner.cookie,
      body: { operationId: b.stages.get("SEWING").id, quantityApproved: 20, notes: "Checked on the table" },
    }),
    201, "The owner judges the twenty"
  );
  const [judged] = await sizesOf(w.owner, w.order.itemId);
  assert.equal(judged.completedFromProduction, 20, "Approved at the last stage of the route");
  assert.equal(judged.completed, 20, "and that is what the variant reports as finished");
});

test("rework and rejected quantities are never counted as completed", async () => {
  const w = await world([{ size: "M", color: "Navy", quantity: 20 }]);
  const variant = w.variants[0];
  const b = await makeBatch(w, variant.id, 20, ["CUTTING", "SEWING"]);

  await workStage(w, b, "CUTTING", { submit: 20, approve: 20 });
  await workStage(w, b, "SEWING", { submit: 20, approve: 10, rework: 4, reject: 6 });

  const [row] = await sizesOf(w.owner, w.order.itemId);
  assert.equal(row.completed, 10, "Only the ten approved are finished");
  assert.notEqual(row.completed, 20, "Not the twenty that were submitted");
  assert.notEqual(row.completed, 14, "and rework is not completed work");
});

test("a stage in the middle of a route completes nothing, and each batch's own last stage decides", async () => {
  const w = await world([{ size: "L", color: "Navy", quantity: 30 }]);
  const variant = w.variants[0];

  // One batch runs CUTTING -> SEWING, the other stops at IRONING. Neither may be measured
  // against a stage its own frozen route does not have.
  const full = await makeBatch(w, variant.id, 20, ["CUTTING", "SEWING"]);
  const short = await makeBatch(w, variant.id, 10, ["CUTTING", "IRONING"]);

  await workStage(w, full, "CUTTING", { submit: 20, approve: 20 });
  await workStage(w, short, "CUTTING", { submit: 10, approve: 10 });

  let [row] = await sizesOf(w.owner, w.order.itemId);
  assert.equal(row.completed, 0, "Thirty pieces approved at CUTTING complete nothing: neither route ends there");

  await workStage(w, short, "IRONING", { submit: 10, approve: 8, reject: 2 });
  [row] = await sizesOf(w.owner, w.order.itemId);
  assert.equal(row.completed, 8, "The batch that ends at IRONING contributes its IRONING approvals");

  await workStage(w, full, "SEWING", { submit: 20, approve: 15, rework: 5 });
  [row] = await sizesOf(w.owner, w.order.itemId);
  assert.equal(row.completed, 23, "Eight from one batch and fifteen from the other, added once each");

  // Two batches, one last stage each: nothing is counted twice.
  const derived = await completedForVariants([variant.id]);
  assert.equal(derived.get(variant.id)?.completed, 23, "The library and the endpoint agree");
  assert.equal(derived.get(variant.id)?.produced, true);
});

test("different sizes and different colours stay separate and are never mixed", async () => {
  const w = await world([
    { size: "10", color: "Navy", quantity: 20, completed: 5 },
    { size: "10", color: "House Red", quantity: 20 },
    { size: "12", color: "Navy", quantity: 10 },
  ]);
  const [navyTen, redTen, navyTwelve] = w.variants;
  assert.notEqual(navyTen.id, redTen.id, "Same size, different colour, is a different variant");

  const b = await makeBatch(w, redTen.id, 20, ["CUTTING", "SEWING"]);
  await workStage(w, b, "CUTTING", { submit: 20, approve: 20 });
  await workStage(w, b, "SEWING", { submit: 20, approve: 18, reject: 2 });

  const rows = await sizesOf(w.owner, w.order.itemId);
  const red = rows.find((r: any) => r.color === "House Red");
  const navy = rows.find((r: any) => r.color === "Navy" && r.size === "10");
  const twelve = rows.find((r: any) => r.size === "12");

  assert.equal(red.completed, 18, "The red variant reports its own approved production");
  assert.equal(navy.completed, 5, "The navy size 10 keeps its recorded figure: it has no production");
  assert.equal(navy.produced, false, "and is not treated as produced because a sibling variant is");
  assert.equal(twelve.completed, 0, "The size 12 is untouched by either");
  assert.equal(rows.reduce((s: number, r: any) => s + r.completedFromProduction, 0), 18,
    "Eighteen pieces were made in total, and they are all attributed to the one variant");
});

test("several workers sharing one stage do not double-count what they finish", async () => {
  const w = await world([{ size: "S", color: "Navy", quantity: 20 }]);
  const variant = w.variants[0];
  const b = await makeBatch(w, variant.id, 20, ["CUTTING", "SEWING"]);

  await workStage(w, b, "CUTTING", { submit: 20, approve: 20 });
  // Two workers, ten pieces each, on the SAME stage of the SAME batch.
  await workStage(w, b, "SEWING", { shares: [10, 10], approve: 20 });

  const [row] = await sizesOf(w.owner, w.order.itemId);
  assert.equal(row.completed, 20, "Twenty pieces were approved once, by whoever sewed them");
  assert.notEqual(row.completed, 40, "Not twenty per worker");
});

test("partial production reports exactly what was approved, and is capped by what was ordered", async () => {
  const w = await world([{ size: "XL", color: "Navy", quantity: 12 }]);
  const variant = w.variants[0];
  const b = await makeBatch(w, variant.id, 12, ["CUTTING", "SEWING"]);

  await workStage(w, b, "CUTTING", { submit: 12, approve: 12 });
  await workStage(w, b, "SEWING", { submit: 5, approve: 5 });

  let [row] = await sizesOf(w.owner, w.order.itemId);
  assert.equal(row.completed, 5, "Five of twelve finished is five, not twelve and not zero");
  assert.equal(row.quantity, 12, "against the twelve ordered");

  const derived = await completedForVariants([variant.id, 999999]);
  assert.equal(derived.get(variant.id)?.completed, 5);
  assert.deepEqual(derived.get(999999), { completed: 0, produced: false }, "An unknown variant is simply nothing, not an error");
  assert.equal((await completedForVariants([])).size, 0, "and asking for nothing asks the database for nothing");
});

// ---------------------------------------------------------------------------
// 2. Who recorded the document.
// ---------------------------------------------------------------------------

test("a receipt, a packing record and a delivery each name the person who recorded them", async () => {
  const w = await world([{ size: "10", color: "Navy", quantity: 10 }]);

  const receipt = await expectStatus(
    await api("POST", "/api/payments", {
      cookie: w.owner.cookie,
      body: { orderId: w.order.orderId, amount: 5000, paymentMethod: "Bank Transfer", reference: `MTH-${Date.now()}` },
    }),
    201, "Record a receipt"
  );
  assert.equal(receipt.recordedByName, "Test Owner", "The signed-in user, from the session");
  assert.equal(typeof receipt.recordedById, "number", "and their user id, so a rename cannot lose it");

  const packed = await expectStatus(
    await api("POST", "/api/packing", {
      cookie: w.owner.cookie, body: { orderId: w.order.orderId, quantityPacked: 10 },
    }),
    201, "Record a packing list"
  );
  assert.equal(packed.recordedByName, "Test Owner", "The packing record names who packed it");
  assert.equal(typeof packed.recordedById, "number");

  const delivered = await expectStatus(
    await api("POST", "/api/deliveries", {
      cookie: w.owner.cookie,
      body: {
        orderId: w.order.orderId, deliveryDate: new Date().toISOString().slice(0, 10),
        lines: [{ orderItemId: w.order.itemId, quantity: 10, size: "10" }],
      },
    }),
    201, "Record a delivery"
  );
  assert.equal(delivered.recordedByName, "Test Owner", "The delivery note names who recorded it");
  assert.equal(typeof delivered.recordedById, "number");

  // A second owner records a different name, which is the whole point of deriving it.
  const other = await createOwner();
  const second = await expectStatus(
    await api("POST", "/api/payments", {
      cookie: other.cookie,
      body: { orderId: w.order.orderId, amount: 1000, reference: `MTH-${Date.now()}-b` },
    }),
    201, "A different owner records another receipt"
  );
  assert.equal(second.recordedByName, "Test Owner", "Both are called Test Owner by the harness");
  assert.notEqual(second.recordedById, receipt.recordedById, "but they are different users, and the ids tell them apart");
});

test("an actor supplied in the request body is ignored, not believed", async () => {
  const w = await world([{ size: "10", color: "Navy", quantity: 6 }]);
  const forged = { recordedById: 999999, recordedByName: "Somebody Else Entirely", recordedBy: "Somebody Else Entirely" };

  const receipt = await expectStatus(
    await api("POST", "/api/payments", {
      cookie: w.owner.cookie,
      body: { orderId: w.order.orderId, amount: 2500, reference: `MTH-${Date.now()}`, ...forged },
    }),
    201, "Record a receipt with a forged actor"
  );
  assert.notEqual(receipt.recordedByName, "Somebody Else Entirely", "A caller cannot name somebody else");
  assert.notEqual(receipt.recordedById, 999999, "nor point at a user who was not there");
  assert.equal(receipt.recordedByName, "Test Owner", "The session decides");

  const packed = await expectStatus(
    await api("POST", "/api/packing", {
      cookie: w.owner.cookie, body: { orderId: w.order.orderId, quantityPacked: 6, ...forged },
    }),
    201, "Record packing with a forged actor"
  );
  assert.equal(packed.recordedByName, "Test Owner", "Packing takes its actor from the session too");

  const delivered = await expectStatus(
    await api("POST", "/api/deliveries", {
      cookie: w.owner.cookie,
      body: {
        orderId: w.order.orderId, deliveryDate: new Date().toISOString().slice(0, 10),
        lines: [{ orderItemId: w.order.itemId, quantity: 6, size: "10" }], ...forged,
      },
    }),
    201, "Record a delivery with a forged actor"
  );
  assert.equal(delivered.recordedByName, "Test Owner", "and so does a delivery");
});

test("only an owner may create these documents, and an actor is never a way in", async () => {
  const w = await world([{ size: "10", color: "Navy", quantity: 4 }]);
  const worker = await createStaff(w.owner.cookie, { name: unique("Factory hand"), role: "WORKER" });
  const manager = await createStaff(w.owner.cookie, { name: unique("Floor manager"), role: "PRODUCTION_MANAGER" });

  for (const [label, cookie] of [["a Worker", worker.cookie], ["a Project Manager", manager.cookie]] as const) {
    const receipt = await api("POST", "/api/payments", {
      cookie, body: { orderId: w.order.orderId, amount: 1000, recordedByName: "Test Owner" },
    });
    assert.equal(receipt.status, 403, `${label} cannot record a receipt, whatever actor they claim`);

    const packed = await api("POST", "/api/packing", {
      cookie, body: { orderId: w.order.orderId, quantityPacked: 4, recordedByName: "Test Owner" },
    });
    assert.equal(packed.status, 403, `${label} cannot record packing`);

    const delivered = await api("POST", "/api/deliveries", {
      cookie,
      body: {
        orderId: w.order.orderId, deliveryDate: new Date().toISOString().slice(0, 10),
        lines: [{ orderItemId: w.order.itemId, quantity: 4, size: "10" }], recordedByName: "Test Owner",
      },
    });
    assert.equal(delivered.status, 403, `${label} cannot record a delivery`);
  }

  const anonymous = await api("POST", "/api/payments", { cookie: "", body: { orderId: w.order.orderId, amount: 1000 } });
  assert.equal(anonymous.status, 401, "and nobody records anything without signing in");
});

test("the actor columns are nullable and nothing was backfilled onto existing rows", async () => {
  // Historical receipts, packing records and deliveries predate this change, and the truth
  // about them is that the system did not record who entered them. Inventing an actor for a
  // financial document would be worse than leaving the question open, so the migration adds
  // nullable columns and writes no data. Asserted against the migration itself, because that
  // is the artefact that runs on the production database.
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync("drizzle/0010_actor_audit.sql", "utf8");

  for (const table of ["payments", "packing_records", "deliveries"]) {
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ADD COLUMN "recorded_by_id" integer;`), `${table} gains a nullable actor id`);
    assert.match(sql, new RegExp(`ALTER TABLE "${table}" ADD COLUMN "recorded_by_name" text;`), `${table} gains a nullable actor name`);
  }
  // Comments stripped first: the header explains that no column is NOT NULL, and that
  // sentence must not be mistaken for a statement that says so.
  const statements = sql.replace(/--.*$/gm, "");
  assert.equal(/NOT NULL/.test(statements), false, "No actor column is NOT NULL, so every existing row stays valid");
  assert.equal(/DEFAULT/.test(statements), false, "and none has a default that would fill existing rows in");
  // Matched at the START of a statement, because a foreign key clause legitimately reads
  // "ON DELETE set null ON UPDATE no action" and a substring search would call that destructive.
  assert.equal(/^\s*(UPDATE|INSERT|DELETE|TRUNCATE|DROP)\b/im.test(statements), false,
    "The migration writes, changes and destroys no data at all");

  const deploy = readFileSync("deploy/upgrade-actor-audit.sql", "utf8");
  const live = deploy.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  assert.equal(/^\s*(UPDATE|INSERT|DELETE|TRUNCATE|DROP)\b/im.test(live), false, "Nor does the production script");
  assert.match(live, /ADD COLUMN IF NOT EXISTS/g, "It is idempotent");
  assert.match(live, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint/, "and its foreign keys are added only once");
  assert.equal((live.match(/ADD COLUMN IF NOT EXISTS/g) || []).length, 6, "Six columns, three tables, two each");
});
