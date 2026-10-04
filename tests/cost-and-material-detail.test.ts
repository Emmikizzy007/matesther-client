/**
 * OUTSOURCED PAYMENT DETAIL, AND MATERIAL ISSUED / RETURNED / WASTED.
 *
 * Two requirements, both about recording the truth of a transaction rather than a single
 * number that hides the rest of it.
 *
 * OUTSOURCED WORK is an external production cost with its own vendor, its own promised
 * return date, and its own money: what the work costs, what Matesther owes, what has been
 * paid, and the reference that payment can be matched against. A vendor is not a worker,
 * so none of it may reach payroll - and paying a vendor is not the same event as accepting
 * the garments back, because work can be accepted and still unpaid.
 *
 * MATERIAL is the same material system Matesther already runs. What is added is the rest of
 * the truth about a job's material: what left the store, what went into the garments, what
 * came back, what was ruined, who took it, which exact variant it was for, and why. There
 * is still ONE stock figure, `materials.current_stock`.
 *
 * Runs against an empty database. Every fixture is created here through the real API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, expectStatus, createOwner, createStaff, createWorker, createOrder } from "./support/harness";
import { currentMonth } from "@/lib/payroll";

let n = 0;
const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}${(n += 1)}`;

async function stagesOf(cookie: string, batchId: number) {
  const jobs = await api("GET", `/api/operations?batchId=${batchId}`, { cookie });
  await expectStatus(jobs, 200, "Load the batch's stages");
  return new Map<string, any>(jobs.data.map((job: any) => [job.stage, job]));
}

/**
 * Ten navy size-M polos: CUTTING in house at 200 a piece, SEWING outsourced, then PACKING.
 * The cutting is approved so the outsourced stage genuinely holds the ten garments.
 */
async function outsourcedWorld(unitCost = 500) {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 9000 });
  await expectStatus(
    await api("POST", "/api/order-sizes", {
      cookie: owner.cookie,
      body: { itemId: order.itemId, sizes: [{ size: "M", color: "Navy", quantity: 10 }] },
    }),
    201, "Record the exact variant"
  );
  const listed = await api("GET", `/api/order-sizes?itemId=${order.itemId}`, { cookie: owner.cookie });
  const variant = listed.data.sizes[0];

  const cutterName = unique("Cutter");
  const cutter = await createWorker(owner.cookie, { name: cutterName, specialty: "Cutter", roles: ["Cutter"], paymentType: "PER_PIECE" });
  const cutterLogin = (await createStaff(owner.cookie, { name: cutterName, role: "WORKER" })).cookie;

  const batch = await api("POST", "/api/batches", {
    cookie: owner.cookie,
    body: {
      orderId: order.orderId, orderItemId: order.itemId, quantity: 10, orderVariantId: variant.id,
      workerId: cutter.id, cuttingRate: 200,
      stages: [{ stage: "CUTTING" }, { stage: "SEWING", method: "OUTSOURCED" }, { stage: "PACKING" }],
    },
  });
  await expectStatus(batch, 201, "Cutting in house, sewing outsourced, then packing");
  let stages = await stagesOf(owner.cookie, batch.data.id);
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: cutterLogin, body: { id: stages.get("CUTTING").id, submitQty: 10 } }),
    200, "The cutter submits the 10 pieces"
  );
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: owner.cookie,
      body: { operationId: stages.get("CUTTING").id, quantityApproved: 10 },
    }),
    201, "All 10 approved at cutting and released to the outsourced stage"
  );
  stages = await stagesOf(owner.cookie, batch.data.id);

  const dispatch = await expectStatus(
    await api("POST", "/api/external-work", {
      cookie: owner.cookie,
      body: {
        operationId: stages.get("SEWING").id, vendorName: "Lagos Embroidery", quantitySent: 10,
        unitCost, expectedReturnAt: "2026-11-20",
      },
    }),
    201, "Send all 10 out to the vendor"
  );
  return { owner, order, variant, cutter, batchId: batch.data.id, stages, dispatch, unitCost };
}

// ---------------------------------------------------------------------------
// 1. The vendor's money, recorded properly.
// ---------------------------------------------------------------------------

test("a dispatch carries what is owed, what is paid, and the reference it can be matched against", async () => {
  const w = await outsourcedWorld(500);
  assert.equal(w.dispatch.totalCost, 5000, "10 garments at 500");
  assert.equal(w.dispatch.amountPayable, 5000, "What is owed defaults to the cost of the work");
  assert.equal(w.dispatch.amountPaid, 0, "Nothing has been paid yet");
  assert.equal(w.dispatch.expectedReturnAt !== null, true, "The promised return date is recorded at dispatch");
  assert.equal(w.dispatch.paymentReference, null);

  // Cannot owe more than the work costs.
  const overOwed = await api("PUT", "/api/external-work", {
    cookie: w.owner.cookie, body: { id: w.dispatch.id, amountPayable: 6000 },
  });
  assert.equal(overOwed.status, 400, "A vendor cannot be owed more than the work costs");

  // Cannot pay more than is owed.
  const overPaid = await api("PUT", "/api/external-work", {
    cookie: w.owner.cookie, body: { id: w.dispatch.id, amountPaid: 5001 },
  });
  assert.equal(overPaid.status, 400, "Nor paid more than is owed");

  // A part payment, with the reference the bank transfer can be matched against.
  const part = await expectStatus(
    await api("PUT", "/api/external-work", {
      cookie: w.owner.cookie,
      body: { id: w.dispatch.id, amountPaid: 2000, paymentReference: "GTB/2026/00441" },
    }),
    200, "Record a part payment"
  );
  assert.equal(part.amountPaid, 2000);
  assert.equal(part.paymentReference, "GTB/2026/00441");
  assert.equal(part.paidAt !== null, true, "The payment is dated when it is recorded");
  assert.equal(part.paymentStatus, "PART_PAID");
  assert.equal(part.amountOutstanding, 3000);

  // Money already sent is a fact: it can be added to, never quietly reduced.
  const reduced = await api("PUT", "/api/external-work", {
    cookie: w.owner.cookie, body: { id: w.dispatch.id, amountPaid: 500 },
  });
  assert.equal(reduced.status, 400, "Already-paid money cannot be un-paid");
  assert.match(String(reduced.data.error), /cannot be un-paid/i);

  // Settle it, and accept the garments back in the same visit.
  const settled = await expectStatus(
    await api("PUT", "/api/external-work", {
      cookie: w.owner.cookie,
      body: {
        id: w.dispatch.id, amountPaid: 5000, quantityReturned: 10, quantityAccepted: 10,
        quantityRejected: 0, quantityShort: 0,
      },
    }),
    200, "Pay the balance and accept all 10 back"
  );
  assert.equal(settled.paymentStatus, "SETTLED");
  assert.equal(settled.amountOutstanding, 0);
  assert.equal(settled.status, "CLOSED", "The garments are fully accounted for");
});

test("vendor cost is an external production cost, never tailor labour and never payroll", async () => {
  const w = await outsourcedWorld(500);
  await expectStatus(
    await api("PUT", "/api/external-work", {
      cookie: w.owner.cookie,
      body: { id: w.dispatch.id, quantityReturned: 10, quantityAccepted: 10, quantityRejected: 0, quantityShort: 0 },
    }),
    200, "Accept all 10 back from the vendor"
  );

  const order = await api("GET", `/api/orders/${w.order.orderId}`, { cookie: w.owner.cookie });
  await expectStatus(order, 200, "Open the order");
  const costs = order.data.costs;
  assert.equal(costs.outsourced, 5000, "The vendor's work is its own cost category");
  assert.equal(costs.internalLabour, 2000, "The cutter's 10 approved pieces at 200");
  assert.equal(costs.machineLabour, 0);
  assert.equal(costs.supportLabour, 0, "No support work was involved");
  assert.equal(costs.totalCost, 7000, "Cost is the vendor plus the labour, once each");
  assert.equal(costs.profit, 10 * 9000 - 7000);

  // The vendor is not a worker and appears nowhere in payroll. The payroll screen covers
  // every worker in the database, so this asserts on the cutter's own row rather than on
  // a total that other tests in this file also contribute to.
  const payroll = await api("GET", `/api/payroll?month=${currentMonth()}`, { cookie: w.owner.cookie });
  await expectStatus(payroll, 200, "Owner payroll");
  assert.equal(
    payroll.data.workers.some((row: any) => String(row.name).includes("Lagos Embroidery")),
    false, "A vendor never appears as a worker"
  );
  const cutterRow = payroll.data.workers.find((row: any) => row.workerId === w.cutter.id);
  assert.ok(cutterRow, "The cutter is on the payroll sheet");
  assert.equal(cutterRow.piecework, 2000, "The cutter is paid for the 10 pieces they cut");
  assert.equal(cutterRow.due, 2000, "and the vendor's 5,000 creates no phantom payroll for anyone");
});

// ---------------------------------------------------------------------------
// 2. Material issued, used, returned and wasted.
// ---------------------------------------------------------------------------

async function materialWorld(stock = 100, unitCost = 250) {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 9000 });
  const fabric = await expectStatus(
    await api("POST", "/api/materials", {
      cookie: owner.cookie,
      body: { name: unique("Cotton drill"), category: "Fabric", unit: "yards", unitCost, reorderLevel: 0, currentStock: stock },
    }),
    201, "Catalogue the fabric"
  );
  return { owner, order, fabric, unitCost, stock };
}

async function stockOf(cookie: string, materialId: number) {
  const listed = await api("GET", "/api/materials", { cookie });
  await expectStatus(listed, 200, "Read the catalogue");
  const rows = Array.isArray(listed.data) ? listed.data : listed.data.data ?? [];
  const row = rows.find((entry: any) => entry.id === materialId);
  assert.ok(row, "The material is still listed");
  return row.currentStock;
}

test("material issued is accounted for: used, returned and wasted must not exceed it", async () => {
  const w = await materialWorld(100, 250);
  const before = await stockOf(w.owner.cookie, w.fabric.id);

  const recorded = await expectStatus(
    await api("POST", "/api/material-usage", {
      cookie: w.owner.cookie,
      body: {
        materialId: w.fabric.id, orderId: w.order.orderId,
        quantityIssued: 10, quantityUsed: 7, quantityReturned: 2, quantityWasted: 1,
        unitCost: 250, notes: "One yard cut off-grain, two came back unused",
      },
    }),
    201, "Issue 10 yards: 7 used, 2 returned, 1 wasted"
  );
  assert.equal(recorded.quantityIssued, 10);
  assert.equal(recorded.quantityUsed, 7);
  assert.equal(recorded.quantityReturned, 2);
  assert.equal(recorded.quantityWasted, 1);
  assert.equal(recorded.outstanding, 0, "Every yard issued is accounted for");
  assert.equal(recorded.totalCost, 8 * 250, "Used and wasted are both consumed, so both are costed");
  assert.equal(recorded.wastedCost, 250, "and the write-off is visible on its own");

  // Eight left the store for good; two came back.
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), before - 8, "Stock falls by what was consumed");

  // The invariant, enforced server-side rather than in the form.
  const impossible = await api("POST", "/api/material-usage", {
    cookie: w.owner.cookie,
    body: { materialId: w.fabric.id, orderId: w.order.orderId, quantityIssued: 5, quantityUsed: 4, quantityReturned: 2, quantityWasted: 1 },
  });
  assert.equal(impossible.status, 400, "4 used + 2 returned + 1 wasted is more than the 5 issued");
  assert.match(String(impossible.data.error), /more than the 5 issued/i);

  const unexplained = await api("POST", "/api/material-usage", {
    cookie: w.owner.cookie,
    body: { materialId: w.fabric.id, orderId: w.order.orderId, quantityIssued: 4, quantityUsed: 2, quantityWasted: 2 },
  });
  assert.equal(unexplained.status, 400, "A write-off needs a written reason");
  assert.match(String(unexplained.data.error), /written reason/i);
});

test("a record written the old way still means the same thing", async () => {
  const w = await materialWorld(100, 250);
  const before = await stockOf(w.owner.cookie, w.fabric.id);
  const recorded = await expectStatus(
    await api("POST", "/api/material-usage", {
      cookie: w.owner.cookie,
      body: { materialId: w.fabric.id, orderId: w.order.orderId, quantityUsed: 6, unitCost: 250 },
    }),
    201, "A usage record with no issue tracking at all"
  );
  assert.equal(recorded.totalCost, 6 * 250, "Cost is unchanged from the original rule");
  assert.equal(recorded.quantityReturned, 0);
  assert.equal(recorded.quantityWasted, 0);
  assert.equal(recorded.quantityIssued, 6, "Issued reads as what was used, not as nothing");
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), before - 6, "Stock falls exactly as it always did");
});

test("material can be returned or written off after the issue, and never un-returned", async () => {
  const w = await materialWorld(100, 250);
  const before = await stockOf(w.owner.cookie, w.fabric.id);
  const issued = await expectStatus(
    await api("POST", "/api/material-usage", {
      cookie: w.owner.cookie,
      body: { materialId: w.fabric.id, orderId: w.order.orderId, quantityIssued: 12, quantityUsed: 12 },
    }),
    201, "Issue 12 yards, all of it used"
  );
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), before - 12);

  // Two yards turn out to be reusable and come back to the store.
  const returned = await expectStatus(
    await api("PUT", "/api/material-usage", {
      cookie: w.owner.cookie,
      body: { id: issued.id, quantityUsed: 10, quantityReturned: 2, notes: "Two yards came back uncut" },
    }),
    200, "Return two yards to the store"
  );
  assert.equal(returned.quantityReturned, 2);
  assert.equal(returned.totalCost, 10 * 250, "Returned material is not a cost of the job");
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), before - 10, "Stock rises by what came back");

  // A return already recorded is a fact about the store, so it cannot be taken back.
  const unReturned = await api("PUT", "/api/material-usage", {
    cookie: w.owner.cookie, body: { id: issued.id, quantityReturned: 1, notes: "Miscounted" },
  });
  assert.equal(unReturned.status, 400, "Two yards went back to the store; that cannot be un-recorded");
  assert.match(String(unReturned.data.error), /cannot be un-returned/i);

  // And a write-off still has to fit inside what was issued.
  const tooMuch = await api("PUT", "/api/material-usage", {
    cookie: w.owner.cookie, body: { id: issued.id, quantityWasted: 5, notes: "Ruined" },
  });
  assert.equal(tooMuch.status, 400, "10 used + 2 returned + 5 wasted is more than the 12 issued");
});

test("material usage is paged and filtered in the database, not loaded whole", async () => {
  const w = await materialWorld(500, 100);
  for (let i = 0; i < 5; i++) {
    await expectStatus(
      await api("POST", "/api/material-usage", {
        cookie: w.owner.cookie,
        body: { materialId: w.fabric.id, orderId: w.order.orderId, quantityIssued: 4, quantityUsed: 4, unitCost: 100 },
      }),
      201, `Record usage ${i + 1}`
    );
  }
  const paged = await api("GET", "/api/material-usage?limit=2&offset=0", { cookie: w.owner.cookie });
  await expectStatus(paged, 200, "Read the first page");
  assert.equal(paged.data.length, 2, "Only the page asked for comes back");
  assert.equal(Number(paged.headers.get("X-Total-Count")) >= 5, true, "and the total is reported in a header");

  const filtered = await api("GET", `/api/material-usage?orderId=${w.order.orderId}`, { cookie: w.owner.cookie });
  await expectStatus(filtered, 200, "Filter to one order");
  assert.ok(filtered.data.length >= 5);
  assert.ok(filtered.data.every((row: any) => row.orderId === w.order.orderId), "Nothing from another order leaks in");
});
