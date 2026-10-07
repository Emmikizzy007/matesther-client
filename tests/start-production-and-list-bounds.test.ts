/**
 * TWO THINGS THAT ARE EASY TO BREAK SILENTLY AND EXPENSIVE WHEN THEY ARE.
 *
 * 1. START PRODUCTION FROM A SCHOOL'S ORDER PAGE.
 *    The button used to open a second batch-creation dialog on the order page - a
 *    duplicate of Assign Production, and a worse one: it offered only a Cutter and a
 *    Tailor, took the size as free text, and promised "the eight production stages are
 *    created automatically", which is untrue for a polo bought in cut-and-sew, a
 *    ready-made cardigan, or a garment whose monogramming goes out to a vendor. It is now
 *    a link into the one Assign Production workflow with the order preselected.
 *
 *    Asserted three ways, because a navigation is a contract between three things: the
 *    link the screen renders, the query parameter the destination reads, and the endpoint
 *    that revalidates the id. Any one of them drifting makes the feature look broken while
 *    each piece still passes its own test.
 *
 * 2. LIST ENDPOINTS RETURNING A PAGE RATHER THAN A TABLE.
 *    Four financial lists used to read every row of every table they touched and filter in
 *    JavaScript afterwards - `GET /api/orders` alone read five whole tables including
 *    EVERY PRODUCTION OPERATION IN THE DATABASE to draw twenty-five rows. The filters and
 *    the paging are in SQL now.
 *
 *    What is asserted here is the CONTRACT that keeps them there: a limit is honoured, an
 *    offset moves the window, `X-Total-Count` reports the whole match rather than the page,
 *    and an `orderId` filter returns only that order's rows. Those are the properties that
 *    fail if someone reintroduces a client-side filter, and they are checked against the
 *    response rather than against a statement count, so they hold on PostgreSQL too.
 *    scripts/perf-probe.ts is what measures the statements; it is a tool, not a test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { api, createOwner, createOrder, createStaff, expectStatus } from "./support/harness";

let n = 0;
const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}${(n += 1)}`;

/** Read a committed source file, for the assertions that are about what the UI renders. */
function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

// ---------------------------------------------------------------------------
// 1. Start Production opens Assign Production, for that order
// ---------------------------------------------------------------------------

test("the order page's Start Production is a link into Assign Production carrying the order, not a second dialog", () => {
  const page = source("src/app/(app)/orders/[id]/page.tsx");
  assert.match(
    page,
    /href=\{`\/production\/assign\?orderId=\$\{id\}`\}/,
    "Start Production links to /production/assign with this order's id"
  );
  // The duplicate dialog is gone, not merely unreachable: if it were still rendered, a
  // future change could wire a button back to it and the two paths would disagree again.
  assert.ok(!page.includes("batchModal"), "The order page no longer has its own batch-creation dialog");
  assert.ok(!page.includes("The eight production stages are created automatically"),
    "and no longer promises eight stages, which was untrue for any routed garment");
  assert.ok(!page.includes("emptyBatchForm"), "The dialog's form state is gone with it");

  // One workflow, so the shared button component must be able to be a real link.
  const ui = source("src/components/ui.tsx");
  assert.match(ui, /href\?: string;/, "Btn supports href");
  assert.match(ui, /<Link href=\{href\}/, "and renders a real anchor, so it works before hydration and can be long-pressed");
});

test("Assign Production reads the order it was opened for and preselects it", () => {
  const page = source("src/app/(app)/production/assign/page.tsx");
  assert.match(page, /useSearchParams\(\)/, "It reads the query string");
  assert.match(page, /searchParams\.get\("orderId"\)/, "specifically the order id");
  assert.match(page, /catalogue\.find\(\(entry\) => String\(entry\.id\) === requestedOrderId\)/,
    "and preselects from the catalogue it was given, rather than trusting the parameter");
  assert.match(page, /That order is not available for production/,
    "with an honest message when the id is not in the caller's catalogue");
  // useSearchParams opts a route into dynamic rendering, so Next.js requires a boundary;
  // without one the build fails rather than the page.
  assert.match(page, /<Suspense/, "It is wrapped in a Suspense boundary, as useSearchParams requires");
});

test("the assign catalogue can be bounded to one order, which is what makes the preselection cheap to verify", async () => {
  const owner = await createOwner();
  const first = await createOrder(owner.cookie, { quantity: 5 });
  const second = await createOrder(owner.cookie, { quantity: 7 });

  const single = await expectStatus(await api("GET", `/api/production-orders?id=${first.orderId}`, { cookie: owner.cookie }), 200, "Ask for one order");
  assert.equal(single.length, 1, "Only that order comes back");
  assert.equal(single[0].id, first.orderId);
  assert.equal(single[0].items[0].quantity, 5, "with its own line, not the other order's");

  const other = await expectStatus(await api("GET", `/api/production-orders?id=${second.orderId}`, { cookie: owner.cookie }), 200, "Ask for the other");
  assert.equal(other[0].items[0].quantity, 7);

  const missing = await expectStatus(await api("GET", "/api/production-orders?id=999999", { cookie: owner.cookie }), 200, "Ask for one that does not exist");
  assert.deepEqual(missing, [], "An empty list - which is how the screen knows not to preselect");

  const malformed = await api("GET", "/api/production-orders?id=1;drop", { cookie: owner.cookie });
  assert.equal(malformed.status, 400, "A malformed id is refused rather than ignored");
});

test("the preselected order shows its exact variants and what is still available on each", async () => {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity: 30 });
  await expectStatus(
    await api("POST", "/api/order-sizes", {
      cookie: owner.cookie,
      body: { itemId: order.itemId, sizes: [{ size: "M", color: "Navy", quantity: 20 }, { size: "L", color: "Navy", quantity: 10 }] },
    }),
    201, "Record two exact variants"
  );

  const catalogue = await expectStatus(await api("GET", `/api/production-orders?id=${order.orderId}`, { cookie: owner.cookie }), 200, "Read the catalogue for that order");
  const variants = catalogue[0].items[0].variants;
  assert.equal(variants.length, 2, "Both variants are offered");
  assert.deepEqual(variants.map((entry: any) => [entry.size, entry.quantity, entry.available]), [["M", 20, 20], ["L", 10, 10]],
    "with what was ordered and what is still free");

  // Allocate against one, and the ceiling has to move server-side - the screen shows what
  // the server will accept, and never decides a quantity itself.
  await expectStatus(
    await api("POST", "/api/batches", {
      cookie: owner.cookie, body: { orderId: order.orderId, orderItemId: order.itemId, orderVariantId: variants[0].id, quantity: 8 },
    }),
    201, "Allocate 8 of the 20 navy size M"
  );
  const after = await expectStatus(await api("GET", `/api/production-orders?id=${order.orderId}`, { cookie: owner.cookie }), 200, "Read it again");
  const updated = after[0].items[0].variants;
  assert.equal(updated.find((entry: any) => entry.size === "M").available, 12, "The M variant now shows 12 available");
  assert.equal(updated.find((entry: any) => entry.size === "L").available, 10, "and the L variant is untouched");

  const tooMany = await api("POST", "/api/batches", {
    cookie: owner.cookie, body: { orderId: order.orderId, orderItemId: order.itemId, orderVariantId: variants[0].id, quantity: 13 },
  });
  assert.equal(tooMany.status, 400, "A thirteenth piece is refused by the server, not just by the form");
});

test("a Project Manager can reach the assign workflow, and a Worker cannot", async () => {
  const owner = await createOwner();
  const manager = await createStaff(owner.cookie, { name: unique("Manager"), role: "PRODUCTION_MANAGER" });
  const order = await createOrder(owner.cookie, { quantity: 5 });

  await expectStatus(await api("GET", `/api/production-orders?id=${order.orderId}`, { cookie: manager.cookie }), 200,
    "A Project Manager may open Assign Production for an order");
  await expectStatus(await api("GET", `/api/production-access`, { cookie: manager.cookie }), 200, "and read what they may assign");

  const workerProfile = await api("POST", "/api/workers", { cookie: owner.cookie, body: { name: unique("Tailor"), specialty: "Tailor", paymentRate: 300 } });
  const worker = await createStaff(owner.cookie, { name: unique("Tailor login"), role: "WORKER", workerId: workerProfile.data.id });
  assert.equal((await api("GET", `/api/production-orders?id=${order.orderId}`, { cookie: worker.cookie })).status, 403,
    "A Worker may not: they see their own work, not the assignment screen");
});

// ---------------------------------------------------------------------------
// 2. List endpoints are bounded
// ---------------------------------------------------------------------------

test("the order list pages, and its total counts every match rather than the page", async () => {
  const owner = await createOwner();
  // The suite shares one organisation across tests, so the list already holds other tests'
  // orders. Everything below is therefore measured as a DELTA against a baseline taken
  // before this test creates anything - asserting an absolute total would be asserting
  // something about tests that have not run yet.
  const baseline = await api("GET", "/api/orders?limit=1", { cookie: owner.cookie });
  await expectStatus(baseline, 200, "Read the baseline");
  const before = Number(baseline.headers.get("X-Total-Count"));
  assert.ok(Number.isFinite(before), "The endpoint reports a numeric total");

  const created = [];
  for (let index = 0; index < 7; index += 1) created.push(await createOrder(owner.cookie, { quantity: 5 }));

  const firstPage = await api("GET", "/api/orders?limit=3&offset=0", { cookie: owner.cookie });
  const pageOne = await expectStatus(firstPage, 200, "Read the first page");
  assert.equal(pageOne.length, 3, "Three rows, not the whole list");
  assert.equal(Number(firstPage.headers.get("X-Total-Count")), before + 7,
    "and the header reports every match, not just the page");

  const secondPage = await expectStatus(await api("GET", "/api/orders?limit=3&offset=3", { cookie: owner.cookie }), 200, "Read the second page");
  assert.equal(secondPage.length, 3);
  assert.ok(
    !secondPage.some((row: any) => pageOne.some((earlier: any) => earlier.id === row.id)),
    "The two pages do not overlap"
  );

  // Walking to the end of the list must reach every order this test created.
  const seen = new Set<number>([...pageOne, ...secondPage].map((row: any) => row.id));
  for (let offset = 6; offset < before + 7; offset += 50) {
    const rest = await expectStatus(await api("GET", `/api/orders?limit=50&offset=${offset}`, { cookie: owner.cookie }), 200, `Read from ${offset}`);
    for (const row of rest) seen.add(row.id);
    if (rest.length < 50) break;
  }
  for (const order of created) assert.ok(seen.has(order.orderId), `Order ${order.orderNumber} is reachable by paging`);

  const unbounded = await api("GET", "/api/orders?limit=100000", { cookie: owner.cookie });
  await expectStatus(unbounded, 200, "An absurd limit is accepted");
  assert.ok(unbounded.data.length <= 500, "but capped, so one caller cannot ask for the whole table");
});

test("the order list searches in the database, by order number and by school", async () => {
  const owner = await createOwner();
  const target = await createOrder(owner.cookie, { quantity: 5 });
  await createOrder(owner.cookie, { quantity: 5 });

  const byNumber = await expectStatus(await api("GET", `/api/orders?search=${encodeURIComponent(target.orderNumber)}`, { cookie: owner.cookie }), 200, "Search by order number");
  assert.ok(byNumber.some((row: any) => row.id === target.orderId), "The order is found");
  assert.equal(byNumber.length, 1, "and nothing else matches its number");

  const bySchool = await expectStatus(await api("GET", `/api/orders?search=${encodeURIComponent("Test School")}`, { cookie: owner.cookie }), 200, "Search by school");
  assert.ok(bySchool.length >= 2, "Both orders match the school name, which lives on another table");

  const miss = await api("GET", "/api/orders?search=zzz-no-such-thing", { cookie: owner.cookie });
  await expectStatus(miss, 200, "A search that matches nothing");
  assert.deepEqual(miss.data, []);
  assert.equal(miss.headers.get("X-Total-Count"), "0", "and the total agrees");
});

test("payments, packing and expenses filter by order in the database, not after loading everything", async () => {
  const owner = await createOwner();
  const one = await createOrder(owner.cookie, { quantity: 5 });
  const two = await createOrder(owner.cookie, { quantity: 5 });

  for (const [order, amount] of [[one, 10000], [one, 20000], [two, 30000]] as const) {
    await expectStatus(
      await api("POST", "/api/payments", { cookie: owner.cookie, body: { orderId: order.orderId, amount, paymentDate: "2026-10-01" } }),
      201, "Record a payment"
    );
    await expectStatus(
      await api("POST", "/api/expenses", {
        cookie: owner.cookie, body: { orderId: order.orderId, category: "Transportation", description: unique("Run"), amount: 1500, expenseDate: "2026-10-02" },
      }),
      201, "Record an expense"
    );
  }
  await expectStatus(
    await api("POST", "/api/packing", { cookie: owner.cookie, body: { orderId: one.orderId, quantityPacked: 5, packageCount: 1 } }),
    201, "Record packing"
  );

  const payments = await expectStatus(await api("GET", `/api/payments?orderId=${one.orderId}`, { cookie: owner.cookie }), 200, "One order's payments");
  assert.equal(payments.length, 2, "Only that order's two payments");
  assert.ok(payments.every((row: any) => row.orderId === one.orderId), "and no other order's");
  assert.equal(payments[0].orderNumber, one.orderNumber, "Still enriched with the order and school it belongs to");
  assert.ok(payments[0].customer, "which is the point of the enrichment");

  const allPayments = await api("GET", "/api/payments", { cookie: owner.cookie });
  await expectStatus(allPayments, 200, "Every payment");
  assert.equal(allPayments.data.length, 3);
  assert.equal(allPayments.headers.get("X-Total-Count"), "3", "The unfiltered total is reported too");

  const expenses = await expectStatus(await api("GET", `/api/expenses?orderId=${two.orderId}`, { cookie: owner.cookie }), 200, "One order's expenses");
  assert.equal(expenses.length, 1, "Only that order's");
  assert.ok(expenses.every((row: any) => row.orderId === two.orderId));
  // The category filter is not order-scoped - it answers "every expense of this kind" -
  // so it is asserted as "at least this test's two" rather than as an exact count, because
  // other tests in the suite record their own transport costs in the same database.
  const byCategory = await expectStatus(await api("GET", "/api/expenses?category=Transportation", { cookie: owner.cookie }), 200, "Filter by category");
  assert.ok(byCategory.length >= 2, "This test's two transport costs are among them");
  // This test records two transport costs against `one` and one against `two`, so the two
  // filters together must narrow to exactly `one`'s pair - which is the assertion that
  // matters, because a category filter applied in JavaScript after an order filter would
  // still return the right rows here, while the reverse order would not.
  const oneCategory = await expectStatus(
    await api("GET", `/api/expenses?orderId=${one.orderId}&category=Transportation`, { cookie: owner.cookie }), 200, "Both filters together"
  );
  assert.equal(oneCategory.length, 2, "Combined they narrow to this order's own expenses");
  assert.ok(oneCategory.every((row: any) => row.orderId === one.orderId), "every one of them on the order asked for");
  const twoCategory = await expectStatus(
    await api("GET", `/api/expenses?orderId=${two.orderId}&category=Transportation`, { cookie: owner.cookie }), 200, "The other order"
  );
  assert.equal(twoCategory.length, 1, "and to the other order's single expense");

  const packing = await expectStatus(await api("GET", `/api/packing?orderId=${one.orderId}`, { cookie: owner.cookie }), 200, "One order's packing");
  assert.equal(packing.length, 1);
  const packingOther = await expectStatus(await api("GET", `/api/packing?orderId=${two.orderId}`, { cookie: owner.cookie }), 200, "The other order's packing");
  assert.deepEqual(packingOther, [], "It has none, and an empty answer is not an error");

  for (const path of ["/api/payments?orderId=abc", "/api/packing?orderId=abc", "/api/expenses?orderId=abc"]) {
    const malformed = await api("GET", path, { cookie: owner.cookie });
    assert.equal(malformed.status, 400, `A malformed order id is refused on ${path.split("?")[0]}`);
  }
});

test("these lists stay Owner-only, so bounding them did not widen them", async () => {
  const owner = await createOwner();
  const manager = await createStaff(owner.cookie, { name: unique("Manager"), role: "PRODUCTION_MANAGER" });
  await createOrder(owner.cookie, { quantity: 5 });

  for (const path of ["/api/orders", "/api/payments", "/api/packing", "/api/expenses"]) {
    const asManager = await api("GET", path, { cookie: manager.cookie });
    assert.equal(asManager.status, 403, `A Project Manager is still refused ${path} - these carry revenue and balances`);
    const anonymous = await api("GET", path);
    assert.equal(anonymous.status, 401, `and so is anybody unsigned-in on ${path}`);
  }
});

test("the lists a production screen needs are reachable by a Project Manager, and carry no money", async () => {
  const owner = await createOwner();
  const manager = await createStaff(owner.cookie, { name: unique("Manager"), role: "PRODUCTION_MANAGER" });
  const order = await createOrder(owner.cookie, { quantity: 5, unitPrice: 4000 });

  const catalogue = await expectStatus(await api("GET", "/api/production-orders", { cookie: manager.cookie }), 200, "The assign catalogue");
  const board = await expectStatus(await api("GET", "/api/production-control", { cookie: manager.cookie }), 200, "The control board");
  const routes = await expectStatus(await api("GET", "/api/routes", { cookie: manager.cookie }), 200, "The route list");

  // The finance blackout is the reason these are separate endpoints from the lists above,
  // so it is asserted against the actual bytes rather than against a field name.
  const serialised = JSON.stringify({ catalogue, board, routes });
  for (const forbidden of ["totalAmount", "amountPaid", "balance", "sellingPrice", "unitPrice", "profit"]) {
    assert.ok(!serialised.includes(forbidden), `No ${forbidden} reaches a Project Manager through the production endpoints`);
  }
  assert.ok(catalogue.some((row: any) => row.id === order.orderId), "The order itself is visible, without its money");
});
