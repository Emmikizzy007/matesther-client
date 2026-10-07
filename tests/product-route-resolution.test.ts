/**
 * PRODUCT-SPECIFIC PRODUCTION ROUTES: which route a new batch actually follows.
 *
 * THE DEFECT THIS FILE EXISTS FOR
 *   An Owner could save a route against a garment and production would ignore it. Two
 *   independent causes, both server-side, and neither visible from the screen that was
 *   blamed for it:
 *
 *     1. `listRoutes(productId?: number | null)` decided "no filter" by testing
 *        `productId === undefined`, and every caller passed `productId ?? null`. So `null`
 *        - meant as "every route" - became the filter "routes whose product IS NULL", and
 *        `GET /api/routes` returned ONLY organization-level routes. Every product route was
 *        silently dropped from the Production Routes screen and from the assign screen's
 *        dropdown. That is precisely the reported symptom: "the history appears to show
 *        organization-default routes".
 *
 *     2. `resolveRoute` looked for a product route with `is_default = true`. A route saved
 *        against a garment WITHOUT that flag was invisible to it, so the organisation
 *        default was used instead - an organisation default silently overriding an
 *        explicitly assigned product route.
 *
 *   Alongside them: `PUT /api/routes` accepted a `productId` and dropped it, so a route
 *   could never be moved onto a garment after creation; `resolveRoute`'s explicit-`routeId`
 *   path did not check ownership at all; and `GET /api/production-orders` reported
 *   `defaultRouteId` as "the first route whose product matches", which could be a retired
 *   route, an unflagged one the resolver would never pick, or another organisation's.
 *
 *   Each of those is asserted here from the direction that exposed it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/db";
import {
  customers,
  orders,
  organizations,
  productionBatches,
  productionOperations,
  productionRouteStages,
  productionRoutes,
  products,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { api, createOwner, createOrder, createStaff, expectStatus } from "./support/harness";
import { isAutomaticRoute } from "@/lib/production-route";

let n = 0;
const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}${(n += 1)}`;

/**
 * Retire every organisation-level default route that already exists.
 *
 * WHY A TEST HAS TO DO THIS
 *   The suite shares one in-memory database, and `createOwner()` deliberately reuses the
 *   one organisation rather than inventing a company per test. So an organisation-wide
 *   default saved by an earlier test in this file is still active when a later one runs,
 *   and a test whose whole question is "what happens when there is NO organisation
 *   default" would otherwise be answering a question about somebody else's fixture.
 *
 *   Retiring is the mechanism the product itself offers - `isActive: false` - and it is
 *   what makes a route stop being a candidate without deleting a definition another test
 *   may still be asserting about.
 */
async function clearOrganisationDefaults(ownerCookie: string) {
  const listed = await api("GET", "/api/routes", { cookie: ownerCookie });
  if (listed.status !== 200) return;
  for (const route of Array.isArray(listed.data) ? listed.data : []) {
    if (route.productId === null && route.isActive && route.isDefault)
      await api("PUT", "/api/routes", { cookie: ownerCookie, body: { id: route.id, isActive: false } });
  }
}

/** A garment, and a route saved against it. */
async function routedProduct(ownerCookie: string, stageNames: string[], options: { isDefault?: boolean; name?: string } = {}) {
  const product = await api("POST", "/api/products", {
    cookie: ownerCookie, body: { name: options.name ?? unique("Garment"), category: "Shirts", sellingPrice: 4000 },
  });
  await expectStatus(product, 201, "Create the garment");
  const route = await api("POST", "/api/routes", {
    cookie: ownerCookie,
    body: {
      name: unique("Route for"), productId: product.data.id,
      isDefault: options.isDefault ?? false,
      stages: stageNames.map((stage) => ({ stage, method: "INTERNAL" })),
    },
  });
  await expectStatus(route, 201, "Save a route against that garment");
  return { productId: product.data.id as number, productName: product.data.name as string, routeId: route.data.id as number, route: route.data };
}

/**
 * A second organisation, created once however many tests need one.
 *
 * The suite shares one in-memory database and `createOwner()` reuses organisation 1, so a
 * hard-coded `id: 2` insert fails on the second test that tries it. Looking it up first is
 * also the honest shape: this is a fixture another test may already have built, not state
 * this test owns.
 */
async function secondOrganisation(name: string) {
  const existing = await db.select().from(organizations).where(eq(organizations.id, 2));
  if (existing.length) return existing[0];
  const [created] = await db.insert(organizations).values({ id: 2, name }).returning();
  return created;
}

/** The stages a batch actually got, in route order - the frozen route, not the definition. */
async function stagesOf(ownerCookie: string, batchId: number): Promise<string[]> {
  const response = await api("GET", `/api/operations?batchId=${batchId}`, { cookie: ownerCookie });
  const rows = await expectStatus(response, 200, "Read the batch's own frozen route");
  return rows
    .slice()
    .sort((a: any, b: any) => (a.routePosition ?? 0) - (b.routePosition ?? 0))
    .map((row: any) => row.stage);
}

/** Start a batch on an order line and return its id. */
async function startBatch(ownerCookie: string, order: { orderId: number; itemId: number }, quantity = 5) {
  const created = await api("POST", "/api/batches", {
    cookie: ownerCookie, body: { orderId: order.orderId, orderItemId: order.itemId, quantity },
  });
  await expectStatus(created, 201, "Start production");
  return created.data.id as number;
}

// ---------------------------------------------------------------------------
// 1. The list: a product route must be returned at all
// ---------------------------------------------------------------------------

test("GET /api/routes returns a product's own route, which is what it failed to do", async () => {
  const owner = await createOwner();
  const { productId, routeId } = await routedProduct(owner.cookie, ["SEWING", "IRONING"]);

  const listed = await expectStatus(await api("GET", "/api/routes", { cookie: owner.cookie }), 200, "List the routes");
  assert.ok(listed.some((route: any) => route.id === routeId), "The product route is in the list");
  const found = listed.find((route: any) => route.id === routeId);
  assert.equal(found.productId, productId, "and it is still attached to its garment");
  assert.deepEqual(found.applicableStages, ["SEWING", "IRONING"], "with the stages that were saved");

  // Both filter shapes have to work, because the difference between them is the bug.
  const forProduct = await expectStatus(await api("GET", `/api/routes?productId=${productId}`, { cookie: owner.cookie }), 200, "Filter to one garment");
  assert.equal(forProduct.length, 1, "The garment's own route");
  assert.equal(forProduct[0].id, routeId);

  const generic = await expectStatus(await api("GET", "/api/routes?productId=", { cookie: owner.cookie }), 200, "Ask for organisation-level routes");
  assert.deepEqual(generic, [], "This garment's route is NOT organisation-level, so it is not returned here");
});

test("both a product route and an organisation default are listed together, and each says what it applies to", async () => {
  const owner = await createOwner();
  const { routeId } = await routedProduct(owner.cookie, ["SEWING", "PACKING"]);
  const generic = await api("POST", "/api/routes", {
    cookie: owner.cookie,
    body: { name: unique("House default"), isDefault: true, stages: [{ stage: "CUTTING" }, { stage: "SEWING" }, { stage: "IRONING" }] },
  });
  await expectStatus(generic, 201, "Save an organisation-wide default");

  const listed = await expectStatus(await api("GET", "/api/routes", { cookie: owner.cookie }), 200, "List every route");
  const product = listed.find((route: any) => route.id === routeId);
  const organisation = listed.find((route: any) => route.id === generic.data.id);
  // Asserted by identity rather than by count: other tests in this file save routes against
  // the same organisation, and a global count would measure them.
  assert.ok(product, "The product route is listed");
  assert.ok(organisation, "and so is the organisation default");
  assert.ok(product.productId, "One names its garment");
  assert.equal(organisation.productId, null, "the other applies to any garment");
  assert.ok(product.productName, "and the product route carries the garment's name, so the screen can group by it");
  assert.equal(organisation.productName, null);
});

test("`usedForNewBatches` is the resolver's own answer, so the screen cannot claim a route is used when it is not", async () => {
  const owner = await createOwner();
  const { productId, routeId } = await routedProduct(owner.cookie, ["SEWING"], { isDefault: true });
  const competitor = await api("POST", "/api/routes", {
    cookie: owner.cookie,
    body: { name: unique("Second route"), productId, isDefault: false, stages: [{ stage: "IRONING" }] },
  });
  await expectStatus(competitor, 201, "Save a second route against the same garment");

  const listed = await expectStatus(await api("GET", "/api/routes", { cookie: owner.cookie }), 200, "List them");
  const flagged = listed.find((route: any) => route.id === routeId);
  const unflagged = listed.find((route: any) => route.id === competitor.data.id);
  assert.equal(flagged.usedForNewBatches, true, "The flagged default is the one in use");
  assert.equal(unflagged.usedForNewBatches, false, "and the other is honestly reported as not in use");

  // Retiring the one in use must not quietly promote the other: two active routes with none
  // flagged is a configuration the Owner has to settle, not one to resolve by row order.
  await expectStatus(await api("PUT", "/api/routes", { cookie: owner.cookie, body: { id: routeId, isActive: false } }), 200, "Retire the default");
  const after = await expectStatus(await api("GET", "/api/routes", { cookie: owner.cookie }), 200, "List them again");
  const retired = after.find((route: any) => route.id === routeId);
  const survivor = after.find((route: any) => route.id === competitor.data.id);
  assert.equal(retired.usedForNewBatches, false, "A retired route is never automatic");
  assert.equal(survivor.usedForNewBatches, true, "and with the flagged one retired, the single remaining active route is used");
});

test("isAutomaticRoute is one rule, and it agrees with what a batch actually gets", async () => {
  // The pure rule, checked directly, because the screen and the resolver both read it and
  // a disagreement between them is invisible to a user until production is wrong.
  const flagged = { id: 1, productId: 7, isDefault: true, isActive: true };
  const unflagged = { id: 2, productId: 7, isDefault: false, isActive: true };
  assert.equal(isAutomaticRoute(flagged, [flagged, unflagged]), true, "A flagged default wins");
  assert.equal(isAutomaticRoute(unflagged, [flagged, unflagged]), false, "over its unflagged sibling");
  assert.equal(isAutomaticRoute(unflagged, [unflagged]), true, "A single active route is used even unflagged");
  const second = { id: 3, productId: 7, isDefault: false, isActive: true };
  assert.equal(isAutomaticRoute(unflagged, [unflagged, second]), false, "Two unflagged siblings: neither can be chosen");
  assert.equal(isAutomaticRoute(second, [unflagged, second]), false);
  const retired = { id: 4, productId: 7, isDefault: true, isActive: false };
  assert.equal(isAutomaticRoute(retired, [retired]), false, "A retired route is never automatic");
  assert.equal(isAutomaticRoute({ id: 5, productId: null, isDefault: true, isActive: true }, []), true, "An organisation default is automatic when flagged");
  assert.equal(isAutomaticRoute({ id: 6, productId: null, isDefault: false, isActive: true }, []), false, "and not when it is not");
});

// ---------------------------------------------------------------------------
// 2. Resolution: a product route must WIN over the organisation default
// ---------------------------------------------------------------------------

test("a garment's own route is used for a new batch even when it was never flagged as default", async () => {
  const owner = await createOwner();
  // The organisation default is the FULL eight-stage-ish route; the garment's own is short.
  // If the default wins, the batch gets cutting; if the garment wins, it does not.
  const generic = await api("POST", "/api/routes", {
    cookie: owner.cookie,
    body: { name: unique("House default"), isDefault: true, stages: [{ stage: "CUTTING" }, { stage: "SEWING" }, { stage: "IRONING" }, { stage: "PACKING" }] },
  });
  await expectStatus(generic, 201, "Save an organisation-wide default");
  const { productId } = await routedProduct(owner.cookie, ["SEWING", "PACKING"], { isDefault: false, name: unique("Polo - bought in cut and sew") });

  const order = await createOrderWith(owner.cookie, productId, 5);
  const batchId = await startBatch(owner.cookie, order);
  assert.deepEqual(await stagesOf(owner.cookie, batchId), ["SEWING", "PACKING"],
    "The garment's own route was used - the organisation default did NOT override it");

  const [batch] = await db.select().from(productionBatches).where(eq(productionBatches.id, batchId));
  assert.ok(batch, "The batch exists");
  // The frozen stages are the authority on what the batch follows, and they are the
  // garment's own two rather than the organisation default's four.
  const ops = await db.select().from(productionOperations).where(eq(productionOperations.productionBatchId, batchId));
  assert.equal(ops.length, 2, "Two stages, not the default's four");
});

/** An order for one garment, so a batch can be started against it. */
async function createOrderWith(ownerCookie: string, productId: number, quantity: number) {
  const customer = await api("POST", "/api/customers", { cookie: ownerCookie, body: { name: unique("School"), type: "SCHOOL" } });
  await expectStatus(customer, 201, "Create the school");
  const order = await api("POST", "/api/orders", {
    cookie: ownerCookie,
    body: { customerId: customer.data.id, orderDate: "2026-10-01", dueDate: "2026-11-01", items: [{ productId, quantity, unitPrice: 4000 }] },
  });
  await expectStatus(order, 201, "Create the order");
  const detail = await api("GET", `/api/orders/${order.data.id}`, { cookie: ownerCookie });
  const items = (await expectStatus(detail, 200, "Load the order")).items;
  return { orderId: order.data.id as number, itemId: items[0].id as number };
}

test("a garment with no route of its own falls back to the organisation default", async () => {
  const owner = await createOwner();
  const generic = await api("POST", "/api/routes", {
    cookie: owner.cookie,
    body: { name: unique("House default"), isDefault: true, stages: [{ stage: "CUTTING" }, { stage: "SEWING" }, { stage: "PACKING" }] },
  });
  await expectStatus(generic, 201, "Save an organisation-wide default");
  const plain = await api("POST", "/api/products", { cookie: owner.cookie, body: { name: unique("Garment with no route"), sellingPrice: 4000 } });
  await expectStatus(plain, 201, "Create a garment with no route");

  const order = await createOrderWith(owner.cookie, plain.data.id, 5);
  const batchId = await startBatch(owner.cookie, order);
  assert.deepEqual(await stagesOf(owner.cookie, batchId), ["CUTTING", "SEWING", "PACKING"], "It follows the organisation default");
  const [batch] = await db.select().from(productionBatches).where(eq(productionBatches.id, batchId));
  assert.equal(batch.routeId, generic.data.id, "and the batch names the route it was built from");
});

test("a garment with no route and no organisation default gets the eight stages Matesther has always run", async () => {
  const owner = await createOwner();
  await clearOrganisationDefaults(owner.cookie);
  const order = await createOrder(owner.cookie, { quantity: 5 });
  const batchId = await startBatch(owner.cookie, order);
  const stages = await stagesOf(owner.cookie, batchId);
  assert.equal(stages.length, 8, "All eight stages");
  assert.deepEqual(stages, ["CUTTING", "SEWING", "MONOGRAMMING", "BUTTONHOLE", "BUTTON_TACKING", "IRONING", "PACKING", "DELIVERY"]);
});

test("two garments with different routes each follow their own, on the same order", async () => {
  const owner = await createOwner();
  const polo = await routedProduct(owner.cookie, ["SEWING", "IRONING"], { isDefault: true });
  const blazer = await routedProduct(owner.cookie, ["CUTTING", "SEWING", "MONOGRAMMING", "PACKING"], { isDefault: true });

  const customer = await api("POST", "/api/customers", { cookie: owner.cookie, body: { name: unique("School"), type: "SCHOOL" } });
  const order = await api("POST", "/api/orders", {
    cookie: owner.cookie,
    body: {
      customerId: customer.data.id, orderDate: "2026-10-01", dueDate: "2026-11-01",
      items: [
        { productId: polo.productId, quantity: 5, unitPrice: 4000 },
        { productId: blazer.productId, quantity: 5, unitPrice: 9000 },
      ],
    },
  });
  await expectStatus(order, 201, "One order, two garments");
  const detail = await api("GET", `/api/orders/${order.data.id}`, { cookie: owner.cookie });
  const items = (await expectStatus(detail, 200, "Load the order")).items;
  const poloItem = items.find((row: any) => row.productId === polo.productId);
  const blazerItem = items.find((row: any) => row.productId === blazer.productId);

  const poloBatch = await startBatch(owner.cookie, { orderId: order.data.id, itemId: poloItem.id });
  const blazerBatch = await startBatch(owner.cookie, { orderId: order.data.id, itemId: blazerItem.id });
  assert.deepEqual(await stagesOf(owner.cookie, poloBatch), ["SEWING", "IRONING"], "The polo follows the polo's route");
  assert.deepEqual(await stagesOf(owner.cookie, blazerBatch), ["CUTTING", "SEWING", "MONOGRAMMING", "PACKING"], "and the blazer follows the blazer's");
});

test("an explicitly named route still wins over the garment's own", async () => {
  const owner = await createOwner();
  const { productId } = await routedProduct(owner.cookie, ["SEWING", "IRONING"], { isDefault: true });
  const oneOff = await api("POST", "/api/routes", {
    cookie: owner.cookie, body: { name: unique("One-off"), stages: [{ stage: "PACKING" }] },
  });
  await expectStatus(oneOff, 201, "Save an unattached route");

  const order = await createOrderWith(owner.cookie, productId, 5);
  const batch = await api("POST", "/api/batches", {
    cookie: owner.cookie, body: { orderId: order.orderId, orderItemId: order.itemId, quantity: 5, routeId: oneOff.data.id },
  });
  await expectStatus(batch, 201, "Name the route explicitly");
  assert.deepEqual(await stagesOf(owner.cookie, batch.data.id), ["PACKING"], "The named route is the one used");
});

// ---------------------------------------------------------------------------
// 3. Organisation ownership
// ---------------------------------------------------------------------------

test("a route belonging to another organisation can never be resolved, named or listed", async () => {
  const owner = await createOwner();
  const { productId } = await routedProduct(owner.cookie, ["SEWING", "IRONING"], { isDefault: true });

  // A second organisation, with a route of its own written directly: the point is what
  // happens when the FIRST organisation's Owner names that route's id.
  await secondOrganisation(unique("Another Company"));
  const [foreignRoute] = await db.insert(productionRoutes).values({
    organizationId: 2, productId: null, name: "Foreign house route", isDefault: true, isActive: true,
  }).returning();
  await db.insert(productionRouteStages).values({ routeId: foreignRoute.id, position: 1, stage: "DELIVERY", method: "INTERNAL" });

  const order = await createOrderWith(owner.cookie, productId, 5);
  const named = await api("POST", "/api/batches", {
    cookie: owner.cookie, body: { orderId: order.orderId, orderItemId: order.itemId, quantity: 5, routeId: foreignRoute.id },
  });
  assert.equal(named.status, 400, "Naming another organisation's route is refused");
  assert.match(String(named.data.error), /no longer exists or is inactive/i,
    "with the same answer as a route that does not exist, so an id cannot be probed for");
  const [batch] = await db.select().from(productionBatches).where(eq(productionBatches.orderId, order.orderId));
  assert.ok(!batch, "and no batch was created");

  const listed = await expectStatus(await api("GET", "/api/routes", { cookie: owner.cookie }), 200, "List the routes");
  assert.ok(!listed.some((route: any) => route.id === foreignRoute.id), "It is not in the list either");

  // Editing and retiring are scoped the same way.
  const edit = await api("PUT", "/api/routes", { cookie: owner.cookie, body: { id: foreignRoute.id, name: "Taken over" } });
  assert.equal(edit.status, 404, "Another organisation's route is not found to edit");
  const remove = await api("DELETE", `/api/routes?id=${foreignRoute.id}`, { cookie: owner.cookie });
  assert.equal(remove.status, 404, "nor to delete");
  const [untouched] = await db.select().from(productionRoutes).where(eq(productionRoutes.id, foreignRoute.id));
  assert.equal(untouched.name, "Foreign house route", "It is unchanged");
});

test("another organisation's product route cannot be picked up as this organisation's default", async () => {
  const owner = await createOwner();
  const product = await api("POST", "/api/products", { cookie: owner.cookie, body: { name: unique("Garment"), sellingPrice: 4000 } });
  await expectStatus(product, 201, "Create the garment");

  await secondOrganisation(unique("Another Company"));
  const [foreign] = await db.insert(productionRoutes).values({
    organizationId: 2, productId: product.data.id, name: "Foreign product route", isDefault: true, isActive: true,
  }).returning();
  await db.insert(productionRouteStages).values({ routeId: foreign.id, position: 1, stage: "DELIVERY", method: "INTERNAL" });

  await clearOrganisationDefaults(owner.cookie);
  const order = await createOrderWith(owner.cookie, product.data.id, 5);
  const batchId = await startBatch(owner.cookie, order);
  const stages = await stagesOf(owner.cookie, batchId);
  // The assertion that matters: the foreign route's single DELIVERY stage was not used.
  // What replaces it is this organisation's own fallback, so the exact list is not the
  // point - and pinning it would make this test fail whenever the fallback legitimately
  // changes.
  assert.deepEqual(stages, ["CUTTING", "SEWING", "MONOGRAMMING", "BUTTONHOLE", "BUTTON_TACKING", "IRONING", "PACKING", "DELIVERY"],
    "With no route of its own organisation, the garment falls back to the built-in eight stages");
  assert.notDeepEqual(stages, ["DELIVERY"], "and specifically not the foreign route");
  const [batch] = await db.select().from(productionBatches).where(eq(productionBatches.id, batchId));
  assert.notEqual(batch.routeId, foreign.id, "The batch does not name another organisation's route");
});

// ---------------------------------------------------------------------------
// 4. Assigning, moving and retiring
// ---------------------------------------------------------------------------

test("a route can be ASSIGNED to a garment after it was created, which PUT used to silently ignore", async () => {
  const owner = await createOwner();
  const product = await api("POST", "/api/products", { cookie: owner.cookie, body: { name: unique("Garment"), sellingPrice: 4000 } });
  await expectStatus(product, 201, "Create the garment");
  const created = await api("POST", "/api/routes", {
    cookie: owner.cookie, body: { name: unique("House route"), stages: [{ stage: "SEWING" }, { stage: "PACKING" }] },
  });
  await expectStatus(created, 201, "Save it against no garment");
  assert.equal(created.data.productId, null);

  const moved = await api("PUT", "/api/routes", {
    cookie: owner.cookie, body: { id: created.data.id, productId: product.data.id, isDefault: true },
  });
  await expectStatus(moved, 200, "Assign it to the garment");
  assert.equal(moved.data.productId, product.data.id, "The assignment was actually written");
  assert.equal(moved.data.isDefault, true);

  // And production now follows it, which is the only assertion that really matters.
  const order = await createOrderWith(owner.cookie, product.data.id, 5);
  const batchId = await startBatch(owner.cookie, order);
  assert.deepEqual(await stagesOf(owner.cookie, batchId), ["SEWING", "PACKING"], "A new batch follows the newly assigned route");
});

test("a route can be detached back to organisation level, and moved between garments", async () => {
  const owner = await createOwner();
  const first = await api("POST", "/api/products", { cookie: owner.cookie, body: { name: unique("Garment A"), sellingPrice: 4000 } });
  const second = await api("POST", "/api/products", { cookie: owner.cookie, body: { name: unique("Garment B"), sellingPrice: 4000 } });
  const created = await api("POST", "/api/routes", {
    cookie: owner.cookie, body: { name: unique("Route"), productId: first.data.id, isDefault: true, stages: [{ stage: "IRONING" }] },
  });
  await expectStatus(created, 201, "Save it against garment A");

  const moved = await expectStatus(
    await api("PUT", "/api/routes", { cookie: owner.cookie, body: { id: created.data.id, productId: second.data.id, isDefault: true } }),
    200, "Move it to garment B"
  );
  assert.equal(moved.productId, second.data.id);

  const detached = await expectStatus(
    await api("PUT", "/api/routes", { cookie: owner.cookie, body: { id: created.data.id, productId: null, isDefault: true } }),
    200, "Detach it to organisation level"
  );
  assert.equal(detached.productId, null, "An explicit null detaches; an absent field leaves it alone");

  const untouched = await expectStatus(
    await api("PUT", "/api/routes", { cookie: owner.cookie, body: { id: created.data.id, name: unique("Renamed") } }),
    200, "Rename it without mentioning the product"
  );
  assert.equal(untouched.productId, null, "Omitting productId keeps what is stored rather than clearing it");

  const foreign = await api("PUT", "/api/routes", { cookie: owner.cookie, body: { id: created.data.id, productId: 999999 } });
  assert.equal(foreign.status, 400, "A garment that does not exist is refused");
});

test("editing or retiring a route never rewrites production already following it", async () => {
  const owner = await createOwner();
  const { productId, routeId } = await routedProduct(owner.cookie, ["SEWING", "IRONING"], { isDefault: true });
  const order = await createOrderWith(owner.cookie, productId, 10);
  const firstBatch = await startBatch(owner.cookie, order, 5);
  assert.deepEqual(await stagesOf(owner.cookie, firstBatch), ["SEWING", "IRONING"]);

  await expectStatus(
    await api("PUT", "/api/routes", {
      cookie: owner.cookie,
      body: { id: routeId, stages: [{ stage: "CUTTING" }, { stage: "SEWING" }, { stage: "MONOGRAMMING" }, { stage: "PACKING" }] },
    }),
    200, "The route is lengthened"
  );
  assert.deepEqual(await stagesOf(owner.cookie, firstBatch), ["SEWING", "IRONING"],
    "The batch in production kept the route it was created with");
  const [existing] = await db.select().from(productionOperations).where(eq(productionOperations.productionBatchId, firstBatch));
  assert.ok(existing, "and its stages were neither rewritten nor removed");

  // A NEW batch follows the edited route, which is the point of freezing rather than
  // pinning: the definition is editable, the history is not.
  const secondBatch = await startBatch(owner.cookie, order, 5);
  assert.deepEqual(await stagesOf(owner.cookie, secondBatch), ["CUTTING", "SEWING", "MONOGRAMMING", "PACKING"]);

  await expectStatus(await api("PUT", "/api/routes", { cookie: owner.cookie, body: { id: routeId, isActive: false } }), 200, "Retire the route");
  assert.deepEqual(await stagesOf(owner.cookie, firstBatch), ["SEWING", "IRONING"], "Retiring changes neither batch");
  assert.deepEqual(await stagesOf(owner.cookie, secondBatch), ["CUTTING", "SEWING", "MONOGRAMMING", "PACKING"]);
});

// ---------------------------------------------------------------------------
// 5. What the assign screen is told
// ---------------------------------------------------------------------------

test("the assign screen's catalogue names the route a new batch would follow, and says whether it is the garment's own", async () => {
  const owner = await createOwner();
  await clearOrganisationDefaults(owner.cookie);
  const routed = await routedProduct(owner.cookie, ["SEWING", "PACKING"], { isDefault: true, name: unique("Polo route") });
  const plain = await api("POST", "/api/products", { cookie: owner.cookie, body: { name: unique("Garment with no route"), sellingPrice: 4000 } });
  await expectStatus(plain, 201, "Create an unrouted garment");
  const generic = await api("POST", "/api/routes", {
    cookie: owner.cookie, body: { name: unique("House default"), isDefault: true, stages: [{ stage: "CUTTING" }, { stage: "SEWING" }] },
  });
  await expectStatus(generic, 201, "Save an organisation-wide default");

  const customer = await api("POST", "/api/customers", { cookie: owner.cookie, body: { name: unique("School"), type: "SCHOOL" } });
  const order = await api("POST", "/api/orders", {
    cookie: owner.cookie,
    body: {
      customerId: customer.data.id, orderDate: "2026-10-01", dueDate: "2026-11-01",
      items: [
        { productId: routed.productId, quantity: 5, unitPrice: 4000 },
        { productId: plain.data.id, quantity: 5, unitPrice: 4000 },
      ],
    },
  });
  await expectStatus(order, 201, "One order carrying both garments");

  const catalogue = await expectStatus(await api("GET", "/api/production-orders", { cookie: owner.cookie }), 200, "Read the assign screen's catalogue");
  const entry = catalogue.find((row: any) => row.id === order.data.id);
  const routedItem = entry.items.find((row: any) => row.productId === routed.productId);
  const plainItem = entry.items.find((row: any) => row.productId === plain.data.id);

  assert.equal(routedItem.defaultRouteId, routed.routeId, "The routed garment is told its own route");
  assert.equal(routedItem.defaultRouteName, routed.route.name, "by name, so the screen can say which one it is");
  assert.equal(routedItem.defaultRouteIsGeneric, false, "and flagged as the garment's own, not the fallback");
  assert.equal(plainItem.defaultRouteId, generic.data.id, "The unrouted garment is told the organisation default");
  assert.equal(plainItem.defaultRouteIsGeneric, true, "and flagged as the fallback, so the screen can say so");
});

test("the catalogue does not offer a retired route as the one a new batch would follow", async () => {
  const owner = await createOwner();
  // Isolated, because the fallback this test is about to exercise is the organisation
  // default - and other tests in this file leave one behind in the shared database.
  await clearOrganisationDefaults(owner.cookie);
  const { productId, routeId } = await routedProduct(owner.cookie, ["SEWING"], { isDefault: true });
  const order = await createOrderWith(owner.cookie, productId, 5);

  const before = await expectStatus(await api("GET", "/api/production-orders", { cookie: owner.cookie }), 200, "Read the catalogue");
  assert.equal(before.find((row: any) => row.id === order.orderId).items[0].defaultRouteId, routeId, "The garment's route is offered");

  await expectStatus(await api("PUT", "/api/routes", { cookie: owner.cookie, body: { id: routeId, isActive: false } }), 200, "Retire it");
  const after = await expectStatus(await api("GET", "/api/production-orders", { cookie: owner.cookie }), 200, "Read it again");
  assert.equal(after.find((row: any) => row.id === order.orderId).items[0].defaultRouteId, null,
    "A retired route is no longer offered, rather than being offered and then ignored");
});

test("retiring a garment's route falls back to the organisation default rather than to nothing", async () => {
  const owner = await createOwner();
  await clearOrganisationDefaults(owner.cookie);
  const { productId, routeId } = await routedProduct(owner.cookie, ["SEWING"], { isDefault: true });
  const generic = await api("POST", "/api/routes", {
    cookie: owner.cookie, body: { name: unique("House default"), isDefault: true, stages: [{ stage: "CUTTING" }, { stage: "PACKING" }] },
  });
  await expectStatus(generic, 201, "Save an organisation-wide default");
  const order = await createOrderWith(owner.cookie, productId, 5);

  await expectStatus(await api("PUT", "/api/routes", { cookie: owner.cookie, body: { id: routeId, isActive: false } }), 200, "Retire the garment's route");
  const after = await expectStatus(await api("GET", "/api/production-orders", { cookie: owner.cookie }), 200, "Read the catalogue");
  const item = after.find((row: any) => row.id === order.orderId).items[0];
  assert.equal(item.defaultRouteId, generic.data.id, "The organisation default takes over");
  assert.equal(item.defaultRouteIsGeneric, true, "and the screen is told it is the fallback, not the garment's own");

  // And production agrees with what the screen was told.
  const batchId = await startBatch(owner.cookie, order);
  assert.deepEqual(await stagesOf(owner.cookie, batchId), ["CUTTING", "PACKING"], "A new batch follows the organisation default");
});

test("the catalogue can be bounded to one order, and the id is revalidated rather than trusted", async () => {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity: 5 });
  const other = await createOrder(owner.cookie, { quantity: 5 });

  const single = await expectStatus(await api("GET", `/api/production-orders?id=${order.orderId}`, { cookie: owner.cookie }), 200, "Ask for one order");
  assert.equal(single.length, 1, "Only that order is returned");
  assert.equal(single[0].id, order.orderId);

  const missing = await expectStatus(await api("GET", "/api/production-orders?id=999999", { cookie: owner.cookie }), 200, "Ask for one that does not exist");
  assert.deepEqual(missing, [], "An empty list, not an error and not every order");

  const malformed = await api("GET", "/api/production-orders?id=abc", { cookie: owner.cookie });
  assert.equal(malformed.status, 400, "A malformed id is refused rather than quietly widened to every order");

  // Another organisation's order is not returned to this Owner, and the answer is the same
  // empty list as for one that does not exist.
  await secondOrganisation(unique("Another Company"));
  const [foreignCustomer] = await db.insert(customers).values({ organizationId: 2, name: "Foreign school" }).returning();
  const [foreignProduct] = await db.insert(products).values({ organizationId: 2, name: "Foreign uniform", sellingPrice: 100 }).returning();
  const [foreignOrder] = await db.insert(orders).values({
    organizationId: 2, customerId: foreignCustomer.id, orderNumber: unique("FOREIGN-"), orderDate: "2026-10-01",
    status: "PENDING", totalAmount: 1000, amountPaid: 0, balance: 1000,
  }).returning();
  const foreign = await expectStatus(await api("GET", `/api/production-orders?id=${foreignOrder.id}`, { cookie: owner.cookie }), 200, "Ask for another organisation's order");
  assert.deepEqual(foreign, [], "It is not returned");

  const all = await expectStatus(await api("GET", "/api/production-orders", { cookie: owner.cookie }), 200, "Ask for everything");
  // By identity, not by count: the suite shares one organisation, so other tests' orders
  // are legitimately in this list too.
  assert.ok(all.some((row: any) => row.id === order.orderId), "This test's first order is listed");
  assert.ok(all.some((row: any) => row.id === other.orderId), "and its second");
  assert.ok(!all.some((row: any) => row.id === foreignOrder.id), "but never another organisation's");
});

test("a Project Manager sees the same resolved routes, and a Worker sees none of it", async () => {
  const owner = await createOwner();
  const manager = await createStaff(owner.cookie, { name: unique("Manager"), role: "PRODUCTION_MANAGER" });
  const { productId, routeId } = await routedProduct(owner.cookie, ["SEWING", "IRONING"], { isDefault: true });

  const asManager = await expectStatus(await api("GET", "/api/routes", { cookie: manager.cookie }), 200, "A Project Manager may read routes");
  assert.ok(asManager.some((route: any) => route.id === routeId), "and sees the product route, not only the defaults");

  const catalogue = await expectStatus(await api("GET", "/api/production-orders", { cookie: manager.cookie }), 200, "and the assign catalogue");
  assert.ok(Array.isArray(catalogue));

  // The routes screen is a staff tool; a Worker has no business defining production.
  const workerProfile = await api("POST", "/api/workers", { cookie: owner.cookie, body: { name: unique("Tailor"), specialty: "Tailor", paymentRate: 300 } });
  const worker = await createStaff(owner.cookie, { name: unique("Tailor login"), role: "WORKER", workerId: workerProfile.data.id });
  const asWorker = await api("GET", "/api/routes", { cookie: worker.cookie });
  assert.equal(asWorker.status, 403, "A Worker may not read or define routes");
  assert.equal((await api("GET", "/api/production-orders", { cookie: worker.cookie })).status, 403, "nor the assign catalogue");
  void productId;
});
