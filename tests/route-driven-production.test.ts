/**
 * Route-driven production, exact garment variants, and external work.
 *
 * WHAT THIS FILE GUARDS
 *   Matesther used to force every garment through the same eight stages, created
 *   up front, in an order hardcoded in five places. That produced rows nobody could
 *   ever work - and the control views then reported a polo as "stuck at CUTTING"
 *   and a ready-made cardigan as "waiting for SEWING" when neither garment had
 *   such a stage.
 *
 *   It also could not say "10 navy blazers in size 8" and "6 black blazers in
 *   size 8" as two different things, because colour existed only as free text on a
 *   batch, never on the order.
 *
 *   These tests assert: exact variants, variant-level allocation ceilings, routes
 *   that shorten / start late / end early / skip stages, the route being FROZEN on
 *   the batch, the five production methods, and the external quantity rule that
 *   sent is not returned and returned is not accepted.
 *
 * Runs against an empty database. Every fixture is created here through the API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/db";
import { workerPayments } from "@/db/schema";
import { eq } from "drizzle-orm";
import { STAGES } from "@/lib/format";
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

const ALL_EIGHT = STAGES.map((stage) => ({ stage }));

/** An Owner, an order with variants, and the people needed to work them. */
async function world(variants: { size?: string | null; color?: string | null; quantity: number }[]) {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity: variants.reduce((s, v) => s + v.quantity, 0), unitPrice: 4500 });
  if (variants.length) {
    const saved = await api("POST", "/api/order-sizes", {
      cookie: owner.cookie,
      body: { itemId: order.itemId, sizes: variants.map((v) => ({ size: v.size ?? "", color: v.color ?? "", quantity: v.quantity })) },
    });
    await expectStatus(saved, 201, "Record the order's exact variants");
  }
  const listed = await api("GET", `/api/order-sizes?itemId=${order.itemId}`, { cookie: owner.cookie });
  await expectStatus(listed, 200, "Load the variants");
  return { owner, order, variants: listed.data.sizes as any[] };
}

/** A worker who holds `role`, plus a login for them. */
async function person(ownerCookie: string, role: string) {
  const name = unique(role);
  const profile = await createWorker(ownerCookie, { name, specialty: role, roles: [role], paymentType: "PER_PIECE" });
  const login = await createStaff(ownerCookie, { name, role: "WORKER" });
  return { ...profile, login: login.cookie, name };
}

async function stagesOf(cookie: string, batchId: number) {
  const jobs = await api("GET", `/api/operations?batchId=${batchId}`, { cookie });
  await expectStatus(jobs, 200, "Load the batch's stages");
  return new Map<string, any>(jobs.data.map((job: any) => [job.stage, job]));
}

async function createBatch(w: Awaited<ReturnType<typeof world>>, body: Record<string, unknown>) {
  const created = await api("POST", "/api/batches", {
    cookie: w.owner.cookie,
    body: { orderId: w.order.orderId, orderItemId: w.order.itemId, ...body },
  });
  return created;
}

// ---------------------------------------------------------------------------
// 1. Exact variants: item + optional size + optional colour + quantity.
// ---------------------------------------------------------------------------

test("the same size in two colours is two distinct variants", async () => {
  const w = await world([
    { size: "8", color: "Navy", quantity: 10 },
    { size: "8", color: "Black", quantity: 6 },
  ]);
  assert.equal(w.variants.length, 2, "Both lines were recorded");
  const navy = w.variants.find((v) => v.color === "Navy");
  const black = w.variants.find((v) => v.color === "Black");
  assert.equal(navy.quantity, 10);
  assert.equal(black.quantity, 6);
  assert.match(navy.variant, /Navy/, "Each variant carries a human-readable label");
  assert.match(navy.variant, /Size 8/);
});

test("a variant may have a colour and no size, or a size and no colour", async () => {
  const w = await world([{ size: "", color: "House Red", quantity: 12 }]);
  assert.equal(w.variants.length, 1, "A colour-only variant is a real variant");
  assert.equal(w.variants[0].size, null);
  assert.equal(w.variants[0].color, "House Red");
  assert.equal(w.variants[0].quantity, 12);
});

test("the same exact garment cannot be listed twice", async () => {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity: 20, unitPrice: 4500 });
  const duplicate = await api("POST", "/api/order-sizes", {
    cookie: owner.cookie,
    body: { itemId: order.itemId, sizes: [
      { size: "M", color: "Navy", quantity: 5 },
      { size: "M", color: "navy", quantity: 7 },
    ] },
  });
  assert.equal(duplicate.status, 400, "Colour is compared case-insensitively");
  assert.match(String(duplicate.data.error), /listed twice/);
});

test("variants cannot total more garments than were ordered", async () => {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 4500 });
  const over = await api("POST", "/api/order-sizes", {
    cookie: owner.cookie,
    body: { itemId: order.itemId, sizes: [{ size: "M", quantity: 8 }, { size: "L", quantity: 8 }] },
  });
  assert.equal(over.status, 400, "16 listed against 10 ordered");
  assert.match(String(over.data.error), /only 10 were ordered/);
});

test("how many of a variant are finished is derived from production, not typed", async () => {
  const w = await world([{ size: "M", color: "Navy", quantity: 10 }]);
  const cutter = await person(w.owner.cookie, "Cutter");
  const batch = await createBatch(w, {
    quantity: 10, orderVariantId: w.variants[0].id, workerId: cutter.id, cuttingRate: 200,
    stages: [{ stage: "CUTTING" }, { stage: "IRONING" }],
  });
  await expectStatus(batch, 201, "Allocate all 10 to a two-stage route");

  let sizes = await api("GET", `/api/order-sizes?itemId=${w.order.itemId}`, { cookie: w.owner.cookie });
  assert.equal(sizes.data.sizes[0].completedFromProduction, 0, "Nothing is finished before anything is approved");

  const stages = await stagesOf(w.owner.cookie, batch.data.id);
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: cutter.login, body: { id: stages.get("CUTTING").id, submitQty: 10 } }),
    200, "Cutter submits all 10"
  );
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: w.owner.cookie,
      body: { operationId: stages.get("CUTTING").id, quantityApproved: 8, quantityRejected: 2, notes: "Two cut wrong" },
    }),
    201, "8 approved at cutting, released to ironing"
  );
  // Ironing is the LAST stage of this route, so its approvals are what "finished" means.
  const ironer = await person(w.owner.cookie, "Ironer");
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: w.owner.cookie, body: { id: stages.get("IRONING").id, workerId: ironer.id, pieceRate: 100, status: "IN_PROGRESS" } }),
    200, "Assign the ironer"
  );
  await api("PUT", "/api/operations", { cookie: ironer.login, body: { id: stages.get("IRONING").id, submitQty: 8 } });
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: w.owner.cookie,
      body: { operationId: stages.get("IRONING").id, quantityApproved: 7, quantityRejected: 1, notes: "One scorched" },
    }),
    201, "7 approved at the final stage"
  );

  sizes = await api("GET", `/api/order-sizes?itemId=${w.order.itemId}`, { cookie: w.owner.cookie });
  assert.equal(sizes.data.sizes[0].completedFromProduction, 7, "Finished means approved at the route's LAST stage");
  assert.equal(sizes.data.sizes[0].completed, 7, "And that is the figure the order shows");
});

// ---------------------------------------------------------------------------
// 2. Variant-level allocation, partial allocation, and over-allocation.
// ---------------------------------------------------------------------------

test("a batch is allocated against an exact variant and snapshots its size and colour", async () => {
  const w = await world([{ size: "8", color: "Navy", quantity: 10 }, { size: "8", color: "Black", quantity: 6 }]);
  const batch = await createBatch(w, { quantity: 4, orderVariantId: w.variants.find((v) => v.color === "Navy").id });
  await expectStatus(batch, 201, "Allocate 4 navy");
  assert.equal(batch.data.size, "8", "The batch snapshots the variant's size");
  assert.equal(batch.data.color, "Navy", "and its colour");
  assert.equal(batch.data.orderVariantId, w.variants.find((v) => v.color === "Navy").id);
});

test("over-allocating one variant is refused even while the item still has room", async () => {
  const w = await world([{ size: "8", color: "Navy", quantity: 10 }, { size: "8", color: "Black", quantity: 6 }]);
  const navy = w.variants.find((v) => v.color === "Navy");

  await expectStatus(await createBatch(w, { quantity: 7, orderVariantId: navy.id }), 201, "7 navy allocated");
  const tooMany = await createBatch(w, { quantity: 4, orderVariantId: navy.id });
  assert.equal(tooMany.status, 400, "Only 3 navy remain even though 9 garments remain on the item overall");
  assert.match(String(tooMany.data.error), /3 unassigned Navy • Size 8 garment/i, "The refusal names the exact variant");

  // The black variant is untouched and still fully available.
  const black = w.variants.find((v) => v.color === "Black");
  await expectStatus(await createBatch(w, { quantity: 6, orderVariantId: black.id }), 201, "All 6 black can still be allocated");
});

test("partial allocation leaves an exact remaining figure per variant", async () => {
  const w = await world([{ size: "M", color: "White", quantity: 10 }]);
  const variant = w.variants[0];
  await expectStatus(await createBatch(w, { quantity: 4, orderVariantId: variant.id }), 201, "First 4");
  await expectStatus(await createBatch(w, { quantity: 6, orderVariantId: variant.id }), 201, "Then the remaining 6");
  const oneMore = await createBatch(w, { quantity: 1, orderVariantId: variant.id });
  assert.equal(oneMore.status, 400, "Nothing is left to allocate");
  // The item ceiling and the variant ceiling agree here (one variant, whole item),
  // so whichever fires first is correct - what matters is that it refuses.
  assert.match(String(oneMore.data.error), /0 (unassigned|garment)/);

  const catalogue = await api("GET", "/api/production-orders", { cookie: w.owner.cookie });
  await expectStatus(catalogue, 200, "The assign screen's catalogue");
  const item = catalogue.data.find((o: any) => o.id === w.order.orderId).items[0];
  assert.equal(item.variants[0].allocated, 10, "Allocation is tracked per variant, server-side");
  assert.equal(item.variants[0].available, 0);
});

test("reassigning a stage to a different worker leaves an audit trail", async () => {
  const w = await world([{ size: "M", quantity: 5 }]);
  const first = await person(w.owner.cookie, "Cutter");
  const second = await person(w.owner.cookie, "Cutter");
  const batch = await createBatch(w, { quantity: 5, orderVariantId: w.variants[0].id, workerId: first.id, cuttingRate: 200 });
  await expectStatus(batch, 201, "Batch with the first cutter");
  const stages = await stagesOf(w.owner.cookie, batch.data.id);

  await expectStatus(
    await api("PUT", "/api/operations", {
      cookie: w.owner.cookie,
      body: { id: stages.get("CUTTING").id, workerId: second.id, pieceRate: 250, notes: "First cutter is on leave" },
    }),
    200, "Reassign to the second cutter"
  );
  const trail = await api("GET", `/api/production-corrections?operationId=${stages.get("CUTTING").id}`, { cookie: w.owner.cookie });
  await expectStatus(trail, 200, "Read the ledger");
  const reassignments = trail.data.filter((row: any) => row.eventType === "REASSIGNMENT");
  assert.equal(reassignments.length, 1, "The reassignment is on the trail");
  assert.equal(reassignments[0].quantity, 0, "It moves no quantity");
  assert.match(String(reassignments[0].reason), /on leave/, "And it carries the reason");
  assert.equal(reassignments[0].workerId, second.id, "And who it went to");
});

// ---------------------------------------------------------------------------
// 3. Routes: shorter, later-starting, earlier-ending, skipping stages.
// ---------------------------------------------------------------------------

test("a batch with no route still gets all eight stages, exactly as before", async () => {
  const w = await world([{ size: "M", quantity: 5 }]);
  const batch = await createBatch(w, { quantity: 5, orderVariantId: w.variants[0].id });
  await expectStatus(batch, 201, "Legacy-shaped request");
  const jobs = await api("GET", `/api/operations?batchId=${batch.data.id}`, { cookie: w.owner.cookie });
  assert.equal(jobs.data.length, 8, "All eight stages");
  assert.deepEqual(jobs.data.map((j: any) => j.stage), [...STAGES], "In the standard order");
  assert.ok(jobs.data.every((j: any) => j.method === "INTERNAL"), "All in-house");
});

test("a shortened route creates only its own stages - no phantom rows", async () => {
  const w = await world([{ size: "M", quantity: 5 }]);
  const batch = await createBatch(w, {
    quantity: 5, orderVariantId: w.variants[0].id,
    stages: [{ stage: "SEWING" }, { stage: "IRONING" }, { stage: "PACKING" }],
  });
  await expectStatus(batch, 201, "A three-stage route");
  const jobs = await api("GET", `/api/operations?batchId=${batch.data.id}`, { cookie: w.owner.cookie });
  assert.deepEqual(jobs.data.map((j: any) => j.stage), ["SEWING", "IRONING", "PACKING"], "Only the three stages exist");
  assert.ok(!jobs.data.some((j: any) => j.stage === "CUTTING"), "No CUTTING row nobody could ever work");
  assert.equal(jobs.data[0].routeLength, 3, "A card can say how long this route is");
  assert.equal(jobs.data[0].quantityReceived, 5, "Garments enter at the route's FIRST stage, whatever it is");
  assert.equal(jobs.data[1].quantityReceived, 0, "and nowhere else");
});

test("a route that starts late puts the garments in front of its first stage", async () => {
  const w = await world([{ size: "M", quantity: 8 }]);
  // A ready-made cardigan: bought finished, so the route begins at PACKING.
  const batch = await createBatch(w, {
    quantity: 8, orderVariantId: w.variants[0].id,
    stages: [{ stage: "PACKING" }, { stage: "DELIVERY" }],
  });
  await expectStatus(batch, 201, "A route with no cutting, sewing or ironing");
  const stages = await stagesOf(w.owner.cookie, batch.data.id);
  assert.equal(stages.get("PACKING").quantityReceived, 8, "Packing holds the 8 garments");
  assert.equal(stages.get("DELIVERY").quantityReceived, 0, "Delivery waits for packing to be approved");
  assert.equal(stages.size, 2, "This garment is never reported as waiting for SEWING");
  assert.ok(!stages.has("SEWING"));
});

test("a route that ends early has no stage after its last one", async () => {
  const w = await world([{ size: "M", quantity: 4 }]);
  const cutter = await person(w.owner.cookie, "Cutter");
  const batch = await createBatch(w, {
    quantity: 4, orderVariantId: w.variants[0].id, workerId: cutter.id, cuttingRate: 200,
    stages: [{ stage: "CUTTING" }, { stage: "SEWING" }],
  });
  await expectStatus(batch, 201, "Route ends at SEWING");
  const stages = await stagesOf(w.owner.cookie, batch.data.id);
  await api("PUT", "/api/operations", { cookie: cutter.login, body: { id: stages.get("CUTTING").id, submitQty: 4 } });
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: w.owner.cookie,
      body: { operationId: stages.get("CUTTING").id, quantityApproved: 4 },
    }),
    201, "All 4 approved at cutting"
  );
  const after = await stagesOf(w.owner.cookie, batch.data.id);
  assert.equal(after.get("SEWING").quantityReceived, 4, "Released into the next stage of THIS route");
  assert.equal(after.get("SEWING").status, "IN_PROGRESS", "A stage given work becomes workable");
  assert.equal(after.size, 2, "And there is no MONOGRAMMING row for it to be stuck at");
});

test("approved work skips a stage the route does not have", async () => {
  const w = await world([{ size: "M", quantity: 6 }]);
  const cutter = await person(w.owner.cookie, "Cutter");
  // No SEWING: cutting goes straight to monogramming.
  const batch = await createBatch(w, {
    quantity: 6, orderVariantId: w.variants[0].id, workerId: cutter.id, cuttingRate: 200,
    stages: [{ stage: "CUTTING" }, { stage: "MONOGRAMMING" }, { stage: "PACKING" }],
  });
  await expectStatus(batch, 201, "A route with a gap in the middle");
  const stages = await stagesOf(w.owner.cookie, batch.data.id);
  await api("PUT", "/api/operations", { cookie: cutter.login, body: { id: stages.get("CUTTING").id, submitQty: 6 } });
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: w.owner.cookie,
      body: { operationId: stages.get("CUTTING").id, quantityApproved: 5, quantityRejected: 1, notes: "One torn" },
    }),
    201, "5 approved at cutting"
  );
  const after = await stagesOf(w.owner.cookie, batch.data.id);
  assert.equal(after.get("MONOGRAMMING").quantityReceived, 5, "Released into the next APPLICABLE stage, not the array's next element");
  assert.equal(after.get("PACKING").quantityReceived, 0, "Packing waits");
  assert.ok(!after.has("SEWING"), "There is no SEWING row at all");
});

test("a route may order stages its own way, not the global array's way", async () => {
  const w = await world([{ size: "M", quantity: 6 }]);
  const packer = await person(w.owner.cookie, "Packer");
  const ironer = await person(w.owner.cookie, "Ironer");
  // Packing BEFORE ironing is not how the standard pipeline runs. It is a legal
  // route for a garment that is packed and then press-finished, and it is the case
  // that proves progression reads THIS batch's order rather than a global array:
  // the array says what follows PACKING is DELIVERY, which this route does not have.
  const batch = await createBatch(w, {
    quantity: 6, orderVariantId: w.variants[0].id,
    // No `workerId`/`cuttingRate`: this route has no Cutter stage, and the generic
    // `assignments` list is how any stage of any route is filled.
    stages: [{ stage: "PACKING" }, { stage: "IRONING" }],
    assignments: [{ stage: "PACKING", workerId: packer.id, pieceRate: 100 }, { stage: "IRONING", workerId: ironer.id, pieceRate: 80 }],
  });
  await expectStatus(batch, 201, "A route in its own order");
  const stages = await stagesOf(w.owner.cookie, batch.data.id);
  assert.equal(stages.get("PACKING").routePosition, 1, "Packing is first on this route");
  assert.equal(stages.get("IRONING").routePosition, 2, "Ironing second");

  await api("PUT", "/api/operations", { cookie: packer.login, body: { id: stages.get("PACKING").id, submitQty: 6 } });
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: w.owner.cookie,
      body: { operationId: stages.get("PACKING").id, quantityApproved: 5, quantityRejected: 1, notes: "One box crushed" },
    }),
    201, "5 approved at packing"
  );
  const after = await stagesOf(w.owner.cookie, batch.data.id);
  assert.equal(after.get("IRONING").quantityReceived, 5, "Released into the stage that FOLLOWS on this route");
  assert.equal(after.get("IRONING").status, "IN_PROGRESS", "and it became workable");
});

test("the legacy cutter/tailor shortcut is refused on a route that has no such stage", async () => {
  const w = await world([{ size: "M", quantity: 6 }]);
  const packer = await person(w.owner.cookie, "Packer");
  // Refused rather than silently dropped: an operator must not be left believing
  // they assigned a cutter to a route that has no cutting stage. Its own order, so
  // the allocation ceiling (which is checked first, and correctly) is not what
  // produces the refusal.
  const noCutting = await createBatch(w, {
    quantity: 6, orderVariantId: w.variants[0].id, workerId: packer.id, cuttingRate: 100,
    stages: [{ stage: "PACKING" }, { stage: "IRONING" }],
  });
  assert.equal(noCutting.status, 400, "A cutter cannot be assigned to a route with no cutting stage");
  assert.match(String(noCutting.data.error), /no Cutter stage/);

  const noSewing = await createBatch(w, {
    quantity: 6, orderVariantId: w.variants[0].id, tailorId: packer.id, sewingRate: 100,
    stages: [{ stage: "PACKING" }, { stage: "IRONING" }],
  });
  assert.equal(noSewing.status, 400, "Nor a tailor to a route with no sewing stage");
  assert.match(String(noSewing.data.error), /no Tailor stage/);

  // The same shortcut still works when the route does have those stages.
  const cutter = await person(w.owner.cookie, "Cutter");
  const tailor = await person(w.owner.cookie, "Tailor");
  const fine = await createBatch(w, {
    quantity: 6, orderVariantId: w.variants[0].id,
    workerId: cutter.id, cuttingRate: 200, tailorId: tailor.id, sewingRate: 450,
    stages: [{ stage: "CUTTING" }, { stage: "SEWING" }, { stage: "PACKING" }],
  });
  await expectStatus(fine, 201, "Each lands on the route's stage for that role");
  const stages = await stagesOf(w.owner.cookie, fine.data.id);
  assert.equal(stages.get("CUTTING").workerId, cutter.id, "The cutter landed on CUTTING");
  assert.equal(stages.get("SEWING").workerId, tailor.id, "The tailor landed on SEWING");
  assert.equal(stages.get("CUTTING").pieceRate, 200, "With the rate agreed for this batch");
  assert.equal(stages.get("SEWING").pieceRate, 450);
});

test("the route is frozen on the batch: editing it later changes no existing batch", async () => {
  const w = await world([{ size: "M", quantity: 5 }]);
  const route = await api("POST", "/api/routes", {
    cookie: w.owner.cookie,
    body: { name: "Polo - no cutting", productId: w.order.productId, stages: [{ stage: "SEWING" }, { stage: "IRONING" }] },
  });
  await expectStatus(route, 201, "Define the product's route");
  const batch = await createBatch(w, { quantity: 5, orderVariantId: w.variants[0].id, routeId: route.data.id });
  await expectStatus(batch, 201, "Allocate against that route");
  assert.deepEqual((await stagesOf(w.owner.cookie, batch.data.id)).size, 2);

  // The route is then lengthened. The batch already in production must not change.
  await expectStatus(
    await api("PUT", "/api/routes", {
      cookie: w.owner.cookie,
      body: { id: route.data.id, stages: [{ stage: "CUTTING" }, { stage: "SEWING" }, { stage: "IRONING" }, { stage: "PACKING" }] },
    }),
    200, "The route is redefined"
  );
  const frozen = await stagesOf(w.owner.cookie, batch.data.id);
  assert.deepEqual([...frozen.keys()], ["SEWING", "IRONING"], "The existing batch kept the route it was created with");
  assert.equal(frozen.get("SEWING").quantityReceived, 5, "And its allocation is untouched");

  // A NEW batch follows the edited route.
  const w2 = await world([{ size: "L", quantity: 5 }]);
  const later = await api("POST", "/api/batches", {
    cookie: w2.owner.cookie,
    body: { orderId: w2.order.orderId, orderItemId: w2.order.itemId, quantity: 5, orderVariantId: w2.variants[0].id, routeId: route.data.id },
  });
  await expectStatus(later, 201, "A new batch on the edited route");
  assert.equal((await stagesOf(w2.owner.cookie, later.data.id)).size, 4, "The new batch follows the new route");
});

test("a product's default route is used without being named", async () => {
  const w = await world([{ size: "M", quantity: 5 }]);
  await expectStatus(
    await api("POST", "/api/routes", {
      cookie: w.owner.cookie,
      body: { name: "Cardigan - bought in", productId: w.order.productId, isDefault: true, stages: [{ stage: "PACKING" }, { stage: "DELIVERY" }] },
    }),
    201, "Set the product's default route"
  );
  const batch = await createBatch(w, { quantity: 5, orderVariantId: w.variants[0].id });
  await expectStatus(batch, 201, "Allocate without naming a route");
  assert.deepEqual([...(await stagesOf(w.owner.cookie, batch.data.id)).keys()], ["PACKING", "DELIVERY"], "The product default was used");
});

test("a route cannot repeat a stage or invent one", async () => {
  const owner = await createOwner();
  const repeated = await api("POST", "/api/routes", {
    cookie: owner.cookie,
    body: { name: "Broken", stages: [{ stage: "SEWING" }, { stage: "SEWING" }] },
  });
  assert.equal(repeated.status, 400, "Two rows competing to be the sewing stage");
  assert.match(String(repeated.data.error), /appears twice/);

  const invented = await api("POST", "/api/routes", {
    cookie: owner.cookie,
    body: { name: "Broken", stages: [{ stage: "SEWING" }, { stage: "SPARKLES" }] },
  });
  assert.equal(invented.status, 400, "A stage Matesther does not have");
  assert.match(String(invented.data.error), /not one of Matesther's production stages/);

  const empty = await api("POST", "/api/routes", { cookie: owner.cookie, body: { name: "Empty", stages: [] } });
  assert.equal(empty.status, 400, "A route needs at least one stage");
});

test("a route cannot have more stages than Matesther has", async () => {
  const owner = await createOwner();
  const tooLong = await api("POST", "/api/routes", {
    cookie: owner.cookie,
    body: { name: "Too long", stages: [...ALL_EIGHT, { stage: "CUTTING" }] },
  });
  assert.equal(tooLong.status, 400);
});

// ---------------------------------------------------------------------------
// 4. Production methods, and keeping the five of them distinct.
// ---------------------------------------------------------------------------

test("each stage carries its own production method", async () => {
  const w = await world([{ size: "M", quantity: 20 }]);
  const batch = await createBatch(w, {
    quantity: 20, orderVariantId: w.variants[0].id,
    stages: [
      { stage: "CUTTING", method: "INTERNAL" },
      { stage: "SEWING", method: "OUTSOURCED" },
      { stage: "MONOGRAMMING", method: "VENDOR_PROCESSING" },
      { stage: "IRONING", method: "MACHINE" },
      { stage: "PACKING", method: "INTERNAL" },
    ],
  });
  await expectStatus(batch, 201, "One batch, four different methods");
  const stages = await stagesOf(w.owner.cookie, batch.data.id);
  assert.equal(stages.get("CUTTING").method, "INTERNAL");
  assert.equal(stages.get("SEWING").method, "OUTSOURCED");
  assert.equal(stages.get("MONOGRAMMING").method, "VENDOR_PROCESSING");
  assert.equal(stages.get("IRONING").method, "MACHINE");
  assert.equal(stages.get("IRONING").methodLabel, "Machine", "With a label a supervisor can read");
  assert.equal(stages.get("CUTTING").routePosition, 1, "Positions are stored, so the route is frozen");
  assert.equal(stages.get("PACKING").routePosition, 5);
});

test("an in-house stage cannot be sent out, and an outsourced stage cannot be bought in", async () => {
  const w = await world([{ size: "M", quantity: 10 }]);
  const batch = await createBatch(w, {
    quantity: 10, orderVariantId: w.variants[0].id,
    stages: [{ stage: "CUTTING", method: "INTERNAL" }, { stage: "SEWING", method: "OUTSOURCED" }],
  });
  await expectStatus(batch, 201, "Cutting in-house, sewing outsourced");
  const stages = await stagesOf(w.owner.cookie, batch.data.id);

  const wrongWay = await api("POST", "/api/external-work", {
    cookie: w.owner.cookie,
    body: { operationId: stages.get("CUTTING").id, vendorName: "Someone", quantitySent: 5 },
  });
  assert.equal(wrongWay.status, 400, "An in-house stage is not sent out");
  assert.match(String(wrongWay.data.error), /produced in-house/);

  const alsoWrong = await api("POST", "/api/ready-made", {
    cookie: w.owner.cookie,
    body: { operationId: stages.get("SEWING").id, materialId: 1, quantity: 5 },
  });
  assert.equal(alsoWrong.status, 400, "An outsourced stage is not a purchase");
  assert.match(String(alsoWrong.data.error), /not a ready-made stage/, "And the refusal says which route to use instead");
});

// ---------------------------------------------------------------------------
// 5. External work: sent is not returned, returned is not accepted.
// ---------------------------------------------------------------------------

/** A batch whose SEWING is outsourced, with cutting already approved into it. */
async function outsourcedWorld(sentQuantity = 10) {
  const w = await world([{ size: "M", color: "Navy", quantity: sentQuantity }]);
  const cutter = await person(w.owner.cookie, "Cutter");
  const batch = await createBatch(w, {
    quantity: sentQuantity, orderVariantId: w.variants[0].id, workerId: cutter.id, cuttingRate: 200,
    stages: [{ stage: "CUTTING" }, { stage: "SEWING", method: "OUTSOURCED" }, { stage: "PACKING" }],
  });
  await expectStatus(batch, 201, "Cutting in-house, sewing outsourced, then packing");
  const stages = await stagesOf(w.owner.cookie, batch.data.id);
  await api("PUT", "/api/operations", { cookie: cutter.login, body: { id: stages.get("CUTTING").id, submitQty: sentQuantity } });
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: w.owner.cookie,
      body: { operationId: stages.get("CUTTING").id, quantityApproved: sentQuantity },
    }),
    201, `All ${sentQuantity} approved at cutting and released to the outsourced sewing stage`
  );
  const refreshed = await stagesOf(w.owner.cookie, batch.data.id);
  return { ...w, batchId: batch.data.id, stages: refreshed, cutter };
}

test("a dispatch may not send out more garments than the stage holds", async () => {
  const o = await outsourcedWorld(10);
  const sewing = o.stages.get("SEWING");
  assert.equal(sewing.quantityReceived, 10, "The outsourced stage received the 10 approved upstream");
  assert.equal(sewing.status, "IN_PROGRESS", "and became workable automatically");

  const tooMany = await api("POST", "/api/external-work", {
    cookie: o.owner.cookie,
    body: { operationId: sewing.id, vendorName: "Lagos Embroidery", quantitySent: 40 },
  });
  assert.equal(tooMany.status, 400, "Cannot send out more than the stage holds");
  assert.match(String(tooMany.data.error), /Only 10 garment\(s\) are available/);

  const unnamed = await api("POST", "/api/external-work", {
    cookie: o.owner.cookie,
    body: { operationId: sewing.id, vendorName: "  ", quantitySent: 5 },
  });
  assert.equal(unnamed.status, 400, "And the vendor must be named");
  assert.match(String(unnamed.data.error), /Record who the work is going to/);
});

test("the same garments cannot be dispatched twice", async () => {
  const o = await outsourcedWorld(10);
  const sewing = o.stages.get("SEWING");
  await expectStatus(
    await api("POST", "/api/external-work", { cookie: o.owner.cookie, body: { operationId: sewing.id, vendorName: "Lagos Embroidery", quantitySent: 8 } }),
    201, "8 sent out"
  );
  const again = await api("POST", "/api/external-work", {
    cookie: o.owner.cookie,
    body: { operationId: sewing.id, vendorName: "Another Vendor", quantitySent: 5 },
  });
  assert.equal(again.status, 400, "Only 2 are still free");
  assert.match(String(again.data.error), /Only 2 garment\(s\) are available/);
  assert.match(String(again.data.error), /8 are already out/);
  await expectStatus(
    await api("POST", "/api/external-work", { cookie: o.owner.cookie, body: { operationId: sewing.id, vendorName: "Another Vendor", quantitySent: 2 } }),
    201, "The remaining 2 can go to a second vendor"
  );
});

test("sending work out moves no quantity counter", async () => {
  const o = await outsourcedWorld(10);
  const sewing = o.stages.get("SEWING");
  await expectStatus(
    await api("POST", "/api/external-work", { cookie: o.owner.cookie, body: { operationId: sewing.id, vendorName: "Lagos Embroidery", quantitySent: 10, unitCost: 350 } }),
    201, "All 10 sent out at N350 each"
  );
  const after = (await stagesOf(o.owner.cookie, o.batchId)).get("SEWING");
  assert.equal(after.quantityReceived, 10, "Received is unchanged");
  assert.equal(after.quantityCompleted, 0, "Nothing has been produced yet");
  assert.equal(after.quantityApproved, 0, "Nothing has been accepted yet");
  assert.equal(after.quantityRemaining, 10, "And all 10 are still outstanding");
  assert.equal((await stagesOf(o.owner.cookie, o.batchId)).get("PACKING").quantityReceived, 0, "Nothing reached packing");

  const trail = await api("GET", `/api/production-corrections?operationId=${sewing.id}`, { cookie: o.owner.cookie });
  assert.ok(trail.data.some((row: any) => row.eventType === "EXTERNAL_SENT" && row.quantity === 10), "But the dispatch is on the audit trail");
});

test("100 sent / 96 returned / 94 accepted / 2 rejected / 4 short keeps all five figures", async () => {
  const o = await outsourcedWorld(100);
  const sewing = o.stages.get("SEWING");
  await expectStatus(
    await api("POST", "/api/external-work", { cookie: o.owner.cookie, body: { operationId: sewing.id, vendorName: "Lagos Embroidery", quantitySent: 100 } }),
    201, "100 sent out"
  );
  const dispatch = (await api("GET", `/api/external-work?operationId=${sewing.id}`, { cookie: o.owner.cookie })).data[0];

  const returned = await api("PUT", "/api/external-work", {
    cookie: o.owner.cookie,
    body: { id: dispatch.id, quantityReturned: 96, quantityAccepted: 94, quantityRejected: 2, quantityShort: 4, notes: "Two came back with loose seams, four never arrived" },
  });
  await expectStatus(returned, 200, "Record the outcome");
  assert.equal(returned.data.quantitySent, 100, "Sent");
  assert.equal(returned.data.quantityReturned, 96, "Returned");
  assert.equal(returned.data.quantityAccepted, 94, "Accepted");
  assert.equal(returned.data.quantityRejected, 2, "Rejected or damaged");
  assert.equal(returned.data.quantityShort, 4, "Short - and distinct from rejected");
  assert.equal(returned.data.status, "CLOSED", "Fully accounted for: 94 + 2 + 4 = 100");

  const stage = returned.data.stage;
  assert.equal(stage.quantityCompleted, 96, "What came back is what was submitted for acceptance");
  assert.equal(stage.quantityApproved, 94, "Only the accepted figure is approved");
  assert.equal(stage.quantityRejected, 2);
  assert.equal(stage.quantityRemaining, 0, "100 received - 94 approved - 2 rejected - 4 short = 0 outstanding");
  assert.equal(returned.data.variant, "Navy • Size M", "The dispatch names the exact garment");
});

test("only the ACCEPTED quantity is released to the next route stage", async () => {
  const o = await outsourcedWorld(100);
  const sewing = o.stages.get("SEWING");
  await api("POST", "/api/external-work", { cookie: o.owner.cookie, body: { operationId: sewing.id, vendorName: "Lagos Embroidery", quantitySent: 100 } });
  const list = await api("GET", `/api/external-work?operationId=${sewing.id}`, { cookie: o.owner.cookie });
  const dispatch = list.data[0];

  await expectStatus(
    await api("PUT", "/api/external-work", {
      cookie: o.owner.cookie,
      body: { id: dispatch.id, quantityReturned: 96, quantityAccepted: 94, quantityRejected: 2, quantityShort: 4, notes: "Four never arrived, two damaged" },
    }),
    200, "Accept 94 of the 100 sent"
  );

  const packing = (await stagesOf(o.owner.cookie, o.batchId)).get("PACKING");
  assert.equal(packing.quantityReceived, 94, "Packing receives the 94 accepted - not the 100 sent, not the 96 returned");
  assert.equal(packing.status, "IN_PROGRESS", "and becomes workable");
});

test("returned work cannot be judged beyond what came back", async () => {
  const o = await outsourcedWorld(100);
  const sewing = o.stages.get("SEWING");
  await api("POST", "/api/external-work", { cookie: o.owner.cookie, body: { operationId: sewing.id, vendorName: "Lagos Embroidery", quantitySent: 100 } });
  const dispatch = (await api("GET", `/api/external-work?operationId=${sewing.id}`, { cookie: o.owner.cookie })).data[0];

  const overReturn = await api("PUT", "/api/external-work", {
    cookie: o.owner.cookie, body: { id: dispatch.id, quantityReturned: 150 },
  });
  assert.equal(overReturn.status, 400, "More came back than went out");
  assert.match(String(overReturn.data.error), /no more than that can come back/);

  const overJudge = await api("PUT", "/api/external-work", {
    cookie: o.owner.cookie, body: { id: dispatch.id, quantityReturned: 90, quantityAccepted: 95 },
  });
  assert.equal(overJudge.status, 400, "More judged than returned");
  assert.match(String(overJudge.data.error), /Record the return first/);

  const overShort = await api("PUT", "/api/external-work", {
    cookie: o.owner.cookie, body: { id: dispatch.id, quantityReturned: 90, quantityShort: 20, notes: "Trying to write off too many" },
  });
  assert.equal(overShort.status, 400, "More written off as short than is unaccounted for");
  assert.match(String(overShort.data.error), /can be recorded as short/);

  const unexplained = await api("PUT", "/api/external-work", {
    cookie: o.owner.cookie, body: { id: dispatch.id, quantityReturned: 90, quantityAccepted: 88, quantityRejected: 2 },
  });
  assert.equal(unexplained.status, 400, "Damaged goods need a reason, exactly like an internal rejection");
  assert.match(String(unexplained.data.error), /Explain what was damaged/);
});

test("an accepted figure cannot be quietly un-accepted", async () => {
  const o = await outsourcedWorld(100);
  const sewing = o.stages.get("SEWING");
  await api("POST", "/api/external-work", { cookie: o.owner.cookie, body: { operationId: sewing.id, vendorName: "Lagos Embroidery", quantitySent: 100 } });
  const dispatch = (await api("GET", `/api/external-work?operationId=${sewing.id}`, { cookie: o.owner.cookie })).data[0];
  // 90 of the 100 come back and are accepted; 10 are still unaccounted for, so the
  // dispatch is not yet closed and a further edit is still possible - which is
  // exactly when an un-accept attempt has to be caught.
  await expectStatus(
    await api("PUT", "/api/external-work", {
      cookie: o.owner.cookie, body: { id: dispatch.id, quantityReturned: 90, quantityAccepted: 90 },
    }),
    200, "90 back and accepted"
  );

  const rewind = await api("PUT", "/api/external-work", {
    cookie: o.owner.cookie, body: { id: dispatch.id, quantityReturned: 90, quantityAccepted: 40 },
  });
  assert.equal(rewind.status, 400, "Accepted work cannot be un-accepted");
  assert.match(String(rewind.data.error), /cannot be un-recorded/);

  const stage = (await stagesOf(o.owner.cookie, o.batchId)).get("SEWING");
  assert.equal(stage.quantityApproved, 90, "The acceptance stands");

  // Once every garment is accounted for the dispatch closes and cannot be reopened.
  await expectStatus(
    await api("PUT", "/api/external-work", {
      cookie: o.owner.cookie, body: { id: dispatch.id, quantityReturned: 96, quantityAccepted: 94, quantityRejected: 2, quantityShort: 4, notes: "Two damaged, four never arrived" },
    }),
    200, "The remaining outcome is recorded"
  );
  const closed = await api("PUT", "/api/external-work", {
    cookie: o.owner.cookie, body: { id: dispatch.id, quantityReturned: 96, quantityAccepted: 94, quantityRejected: 2, quantityShort: 4 },
  });
  assert.equal(closed.status, 400, "A fully accounted dispatch is closed");
  assert.match(String(closed.data.error), /already fully accounted for/);
});

test("a supervisor who sent work out cannot be the one to accept it back", async () => {
  const w = await world([{ size: "M", quantity: 20 }]);
  const name = unique("Supervisor Who Sends");
  const profile = await createWorker(w.owner.cookie, { name, specialty: "Tailor", roles: ["Tailor"] });
  const manager = await createStaff(w.owner.cookie, { name, role: "PRODUCTION_MANAGER", workerId: profile.id });
  const batch = await createBatch(w, {
    quantity: 20, orderVariantId: w.variants[0].id,
    stages: [{ stage: "SEWING", method: "OUTSOURCED" }, { stage: "PACKING" }],
  });
  await expectStatus(batch, 201, "Sewing is the first stage and is outsourced");
  const stages = await stagesOf(w.owner.cookie, batch.data.id);

  await expectStatus(
    await api("POST", "/api/external-work", { cookie: manager.cookie, body: { operationId: stages.get("SEWING").id, vendorName: "Lagos Embroidery", quantitySent: 20 } }),
    201, "The supervisor sends the work out"
  );
  const dispatch = (await api("GET", `/api/external-work?operationId=${stages.get("SEWING").id}`, { cookie: w.owner.cookie })).data[0];

  const selfAccept = await api("PUT", "/api/external-work", {
    cookie: manager.cookie, body: { id: dispatch.id, quantityReturned: 20, quantityAccepted: 20 },
  });
  assert.equal(selfAccept.status, 403, "The same person may not send and accept");
  assert.match(String(selfAccept.data.error), /you sent this work out/i);

  await expectStatus(
    await api("PUT", "/api/external-work", { cookie: w.owner.cookie, body: { id: dispatch.id, quantityReturned: 20, quantityAccepted: 20 } }),
    200, "The Owner accepts it"
  );
  assert.equal(dispatch.sentBy, name, "The sender is recorded either way");
});

// ---------------------------------------------------------------------------
// 6. Ready-made: a purchase, never labour, never outsourced production.
// ---------------------------------------------------------------------------

test("a ready-made purchase is a purchase, releases only what is accepted, and pays nobody", async () => {
  const w = await world([{ size: "L", color: "Cream", quantity: 50 }]);
  // The finished garment lives in the materials catalogue, as category says.
  const garment = await api("POST", "/api/materials", {
    cookie: w.owner.cookie,
    body: { name: "Ready-made cream cardigan", category: "Ready-made garment", unit: "pcs", unitCost: 9000, reorderLevel: 0 },
  });
  await expectStatus(garment, 201, "Catalogue the finished garment");

  const batch = await createBatch(w, {
    quantity: 50, orderVariantId: w.variants[0].id,
    stages: [{ stage: "PACKING", method: "READY_MADE" }, { stage: "DELIVERY" }],
  });
  await expectStatus(batch, 201, "A bought-in cardigan only needs packing and delivery");
  const stages = await stagesOf(w.owner.cookie, batch.data.id);
  const packing = stages.get("PACKING");
  assert.equal(packing.method, "READY_MADE");

  const receipt = await api("POST", "/api/ready-made", {
    cookie: w.owner.cookie,
    body: { operationId: packing.id, materialId: garment.data.id, quantity: 50, unitCost: 9000, supplier: "Abuja Garments Ltd" },
  });
  await expectStatus(receipt, 201, "Buy in 50 finished cardigans");
  assert.equal(receipt.data.totalCost, 450000, "The purchase carries its own cost");
  assert.equal(receipt.data.productionOperationId, packing.id, "Tied to the route stage it satisfies");
  assert.equal(receipt.data.orderVariantId, w.variants[0].id, "and to the exact variant");

  const afterBuy = (await stagesOf(w.owner.cookie, batch.data.id)).get("PACKING");
  assert.equal(afterBuy.quantityCompleted, 50, "The garments are received at the stage");
  assert.equal(afterBuy.quantityApproved, 0, "but not yet accepted");
  assert.equal((await stagesOf(w.owner.cookie, batch.data.id)).get("DELIVERY").quantityReceived, 0, "so nothing has moved on");

  // 4 arrive in the wrong colour.
  await expectStatus(
    await api("PUT", "/api/ready-made", {
      cookie: w.owner.cookie,
      body: { id: receipt.data.id, quantityAccepted: 46, quantityRejected: 4, notes: "Four were navy, not cream" },
    }),
    200, "Accept 46, reject 4"
  );
  const delivery = (await stagesOf(w.owner.cookie, batch.data.id)).get("DELIVERY");
  assert.equal(delivery.quantityReceived, 46, "Only the 46 accepted reach delivery");

  // A purchase is not labour: no worker is paid for it. The payroll TOTAL is not
  // a usable assertion here because every test in this file shares one database, so
  // earlier fixtures have their own accruals - what matters is that this purchase
  // moved nobody's pay.
  const wages = await db.select().from(workerPayments).where(eq(workerPayments.workerId, -1));
  assert.equal(wages.length, 0, "No worker payment exists for a non-existent worker");
  const allWages = await db.select().from(workerPayments);
  assert.equal(allWages.length, 0, "A ready-made purchase creates no worker payment at all");
});

test("a ready-made receipt cannot be judged twice", async () => {
  const w = await world([{ size: "L", quantity: 10 }]);
  const garment = await api("POST", "/api/materials", {
    cookie: w.owner.cookie, body: { name: "Ready-made polo", category: "Ready-made garment", unit: "pcs", unitCost: 5000 },
  });
  const batch = await createBatch(w, {
    quantity: 10, orderVariantId: w.variants[0].id,
    stages: [{ stage: "PACKING", method: "READY_MADE" }],
  });
  const stages = await stagesOf(w.owner.cookie, batch.data.id);
  const receipt = await api("POST", "/api/ready-made", {
    cookie: w.owner.cookie, body: { operationId: stages.get("PACKING").id, materialId: garment.data.id, quantity: 10, unitCost: 5000 },
  });
  await expectStatus(receipt, 201, "Buy in 10");
  await expectStatus(
    await api("PUT", "/api/ready-made", { cookie: w.owner.cookie, body: { id: receipt.data.id, quantityAccepted: 10 } }),
    200, "Accept all 10"
  );
  const again = await api("PUT", "/api/ready-made", {
    cookie: w.owner.cookie, body: { id: receipt.data.id, quantityAccepted: 4 },
  });
  assert.equal(again.status, 400, "The same receipt cannot be re-judged");
  assert.match(String(again.data.error), /already been accepted/);
  assert.equal((await stagesOf(w.owner.cookie, batch.data.id)).get("PACKING").quantityApproved, 10, "The first acceptance stands");
});

test("a ready-made stage cannot be bought in beyond what the route released to it", async () => {
  const w = await world([{ size: "L", quantity: 10 }]);
  const garment = await api("POST", "/api/materials", {
    cookie: w.owner.cookie, body: { name: "Ready-made polo", category: "Ready-made garment", unit: "pcs", unitCost: 5000 },
  });
  const batch = await createBatch(w, {
    quantity: 10, orderVariantId: w.variants[0].id, stages: [{ stage: "PACKING", method: "READY_MADE" }],
  });
  const stages = await stagesOf(w.owner.cookie, batch.data.id);
  await expectStatus(
    await api("POST", "/api/ready-made", { cookie: w.owner.cookie, body: { operationId: stages.get("PACKING").id, materialId: garment.data.id, quantity: 10, unitCost: 5000 } }),
    201, "The allocation is bought in"
  );
  const more = await api("POST", "/api/ready-made", {
    cookie: w.owner.cookie, body: { operationId: stages.get("PACKING").id, materialId: garment.data.id, quantity: 5, unitCost: 5000 },
  });
  assert.equal(more.status, 400, "A purchase cannot inflate a stage beyond its allocation");
  assert.match(String(more.data.error), /can take 0 more/);
});

// ---------------------------------------------------------------------------
// 7. Workers see their exact allocation, not the whole order.
// ---------------------------------------------------------------------------

test("a worker sees the exact garment allocated to them, not the whole order", async () => {
  const w = await world([
    { size: "8", color: "Navy", quantity: 10 },
    { size: "10", color: "Navy", quantity: 6 },
  ]);
  const cutter = await person(w.owner.cookie, "Cutter");
  const size8 = w.variants.find((v) => v.size === "8");
  const batch = await createBatch(w, { quantity: 10, orderVariantId: size8.id, workerId: cutter.id, cuttingRate: 200 });
  await expectStatus(batch, 201, "The cutter gets the size-8 navy variant only");

  const mine = await api("GET", "/api/dashboard?view=my-work", { cookie: cutter.login });
  await expectStatus(mine, 200, "The cutter's own dashboard");
  assert.equal(mine.data.todayJobs.length, 1, "One job, not the whole order");
  const job = mine.data.todayJobs[0];
  assert.equal(job.size, "8", "The exact size");
  assert.equal(job.color, "Navy", "The exact colour");
  assert.equal(job.variant, "Navy • Size 8", "As one readable label");
  assert.equal(job.quantityReceived, 10, "Their exact allocation");
  assert.equal(job.batchQuantity, 10, "of a batch that holds nothing else");
  assert.equal(job.routeLength, 8, "And how long the route they are on is");
  assert.equal(mine.data.journal.length, 1, "The size-10 variant is not theirs to see");
});

test("a worker on a shortened route sees only the stages that route has", async () => {
  const w = await world([{ size: "M", color: "White", quantity: 12 }]);
  const tailor = await person(w.owner.cookie, "Tailor");
  const batch = await createBatch(w, {
    quantity: 12, orderVariantId: w.variants[0].id, tailorId: tailor.id, sewingRate: 450,
    stages: [{ stage: "SEWING" }, { stage: "IRONING" }],
  });
  await expectStatus(batch, 201, "A two-stage route with the tailor on the first");
  const mine = await api("GET", "/api/dashboard?view=my-work", { cookie: tailor.login });
  await expectStatus(mine, 200, "The tailor's dashboard");
  assert.equal(mine.data.journal.length, 1, "One stage");
  assert.equal(mine.data.journal[0].stage, "SEWING");
  assert.equal(mine.data.journal[0].quantityReceived, 12, "Holding exactly the 12 allocated");
  assert.equal(mine.data.journal[0].availableToSubmit, 12, "All 12 can be submitted");
});

// ---------------------------------------------------------------------------
// 8. Task 2's guarantees still hold under routes.
// ---------------------------------------------------------------------------

test("quantities still cannot be typed in on a route-driven batch", async () => {
  const w = await world([{ size: "M", quantity: 10 }]);
  const batch = await createBatch(w, {
    quantity: 10, orderVariantId: w.variants[0].id,
    stages: [{ stage: "SEWING" }, { stage: "IRONING" }],
  });
  await expectStatus(batch, 201, "Short route");
  const stages = await stagesOf(w.owner.cookie, batch.data.id);

  const typed = await api("PUT", "/api/operations", {
    cookie: w.owner.cookie, body: { id: stages.get("IRONING").id, quantityReceived: 900 },
  });
  assert.equal(typed.status, 400, "A route does not reopen the free-text quantity hole");
  assert.equal((await stagesOf(w.owner.cookie, batch.data.id)).get("IRONING").quantityReceived, 0, "Unchanged");

  // 5 is inside the batch's own ceiling of 10, so this reaches the rule that
  // actually matters: ironing may not hold more than sewing approved (which is 0).
  const correction = await api("POST", "/api/production-corrections", {
    cookie: w.owner.cookie,
    body: { operationId: stages.get("IRONING").id, field: "quantityReceived", setTo: 5, reason: "Trying to invent quantity on a short route" },
  });
  assert.equal(correction.status, 400, "Nor can a correction exceed what the previous stage approved");
  assert.match(String(correction.data.error), /only 0 garment/i);

  // And a figure above the batch ceiling is refused for that reason instead.
  const absurd = await api("POST", "/api/production-corrections", {
    cookie: w.owner.cookie,
    body: { operationId: stages.get("IRONING").id, field: "quantityReceived", setTo: 900, reason: "Trying to exceed the batch itself" },
  });
  assert.equal(absurd.status, 400);
  assert.match(String(absurd.data.error), /only holds 10 garment/i);
});

test("a ready-made stage must be where the route starts", async () => {
  const w = await world([{ size: "M", quantity: 10 }]);
  const midRoute = await createBatch(w, {
    quantity: 10, orderVariantId: w.variants[0].id,
    stages: [{ stage: "SEWING" }, { stage: "PACKING", method: "READY_MADE" }],
  });
  assert.equal(midRoute.status, 400, "A bought-in garment cannot appear part-way through making one");
  assert.match(String(midRoute.data.error), /cannot be a ready-made purchase part-way/i);
});

test("nobody submits pieces against a stage produced outside the factory", async () => {
  const o = await outsourcedWorld(10);
  const sewing = o.stages.get("SEWING");
  // The outsourced stage has no worker of its own, but even for one that did, a
  // SUBMISSION beside the EXTERNAL_RETURNED events would count the same garments
  // twice - so the submission path refuses the method, not just the assignment.
  // Attempted by a worker, which is who would otherwise be submitting.
  const intruder = await person(o.owner.cookie, "Tailor");
  const attempt = await api("PUT", "/api/operations", {
    cookie: intruder.login, body: { id: sewing.id, submitQty: 5 },
  });
  assert.equal(attempt.status, 400, "An outsourced stage takes returns, not submissions");
  assert.match(String(attempt.data.error), /External Work/i, "And the refusal says where to go instead");
  assert.equal((await stagesOf(o.owner.cookie, o.batchId)).get("SEWING").quantityCompleted, 0, "No quantity moved");
});

test("a machine stage is Matesther's own work, so its operator submits normally", async () => {
  const w = await world([{ size: "M", quantity: 10 }]);
  const ironer = await person(w.owner.cookie, "Ironer");
  const batch = await createBatch(w, {
    quantity: 10, orderVariantId: w.variants[0].id,
    stages: [{ stage: "IRONING", method: "MACHINE" }],
    assignments: [{ stage: "IRONING", workerId: ironer.id, pieceRate: 120 }],
  });
  await expectStatus(batch, 201, "A single-stage machine route with an operator");
  const stages = await stagesOf(w.owner.cookie, batch.data.id);
  assert.equal(stages.get("IRONING").method, "MACHINE");
  assert.equal(stages.get("IRONING").workerId, ironer.id, "The operator is assigned to it");

  await expectStatus(
    await api("PUT", "/api/operations", { cookie: ironer.login, body: { id: stages.get("IRONING").id, submitQty: 10 } }),
    200, "Machine work is Matesther's own output, so it is submitted like any in-house stage"
  );
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: w.owner.cookie, body: { operationId: stages.get("IRONING").id, quantityApproved: 10 },
    }),
    201, "and inspected and approved the same way"
  );
  const dispatch = await api("POST", "/api/external-work", {
    cookie: w.owner.cookie, body: { operationId: stages.get("IRONING").id, vendorName: "Nobody", quantitySent: 5 },
  });
  assert.equal(dispatch.status, 400, "It is not sent outside, so it has no dispatch");
});

test("nobody submits pieces against a bought-in stage either", async () => {
  const w = await world([{ size: "L", quantity: 10 }]);
  const batch = await createBatch(w, {
    quantity: 10, orderVariantId: w.variants[0].id, stages: [{ stage: "PACKING", method: "READY_MADE" }],
  });
  await expectStatus(batch, 201, "A bought-in route");
  const stages = await stagesOf(w.owner.cookie, batch.data.id);
  const intruder = await person(w.owner.cookie, "Packer");
  const attempt = await api("PUT", "/api/operations", {
    cookie: intruder.login, body: { id: stages.get("PACKING").id, submitQty: 5 },
  });
  assert.equal(attempt.status, 400, "A ready-made stage takes a purchase, not a submission");
  assert.match(String(attempt.data.error), /accept it on arrival/i);
});

test("a worker may not submit on a stage they are not assigned to, whatever the route", async () => {
  const w = await world([{ size: "M", quantity: 10 }]);
  const tailor = await person(w.owner.cookie, "Tailor");
  const ironer = await person(w.owner.cookie, "Ironer");
  const batch = await createBatch(w, {
    quantity: 10, orderVariantId: w.variants[0].id, tailorId: tailor.id, sewingRate: 450,
    stages: [{ stage: "SEWING" }, { stage: "IRONING" }],
  });
  await expectStatus(batch, 201, "Tailor on sewing");
  const stages = await stagesOf(w.owner.cookie, batch.data.id);
  const attack = await api("PUT", "/api/operations", {
    cookie: ironer.login, body: { id: stages.get("SEWING").id, submitQty: 10 },
  });
  assert.equal(attack.status, 403, "The ironer cannot submit the tailor's work");
});

test("a route stage still demands the role that stage needs", async () => {
  const w = await world([{ size: "M", quantity: 10 }]);
  const cutter = await person(w.owner.cookie, "Cutter");
  const batch = await createBatch(w, {
    quantity: 10, orderVariantId: w.variants[0].id, stages: [{ stage: "CUTTING" }, { stage: "IRONING" }],
  });
  await expectStatus(batch, 201, "Cutting then ironing");
  const stages = await stagesOf(w.owner.cookie, batch.data.id);
  const wrongRole = await api("PUT", "/api/operations", {
    cookie: w.owner.cookie, body: { id: stages.get("IRONING").id, workerId: cutter.id, pieceRate: 100, status: "IN_PROGRESS" },
  });
  assert.equal(wrongRole.status, 400, "A cutter is not an ironer");
  assert.match(String(wrongRole.data.error), /needs a Ironer/);
});
