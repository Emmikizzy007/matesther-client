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

// ---------------------------------------------------------------------------
// 3. RETURNED MATERIAL: the seven rules, each asserted on its own.
//
// A material issued to production and genuinely returned unused goes back into available
// stock. Everything below is what that sentence has to mean in this system, rule by rule,
// so that no future change can satisfy one of them by breaking another.
// ---------------------------------------------------------------------------

/** Issue material through the real endpoint and read back both the record and the shelf. */
async function issue(
  w: { owner: { cookie: string }; order: { orderId: number }; fabric: { id: number } },
  body: Record<string, unknown>
) {
  const record = await expectStatus(
    await api("POST", "/api/material-usage", {
      cookie: w.owner.cookie,
      body: { materialId: w.fabric.id, orderId: w.order.orderId, ...body },
    }),
    201, "Issue the material"
  );
  return record;
}

test("rule 1 and 2: issued reduces available stock, returned unused increases it again", async () => {
  const w = await materialWorld(100, 250);
  const before = await stockOf(w.owner.cookie, w.fabric.id);

  // Twelve yards leave the store; three come back uncut.
  await issue(w, { quantityIssued: 12, quantityUsed: 9, quantityReturned: 3, notes: "Three yards came back uncut" });
  const after = await stockOf(w.owner.cookie, w.fabric.id);

  assert.equal(after, before - 12 + 3, "The shelf loses what was issued and gains back what was returned");
  assert.equal(after, before - 9, "so it ends up down by the nine yards that actually stayed out");
  assert.notEqual(after, before - 12, "and it is NOT down by the full issued figure");
});

test("rule 3: returned material stops being a cost of the job, the moment it comes back", async () => {
  const w = await materialWorld(100, 250);

  // Everything issued is used, so the whole issue is charged to the order.
  const record = await issue(w, { quantityIssued: 12, quantityUsed: 12 });
  assert.equal(record.totalCost, 12 * 250, "Twelve yards consumed costs twelve yards");

  // Two turn out to be reusable and go back on the shelf.
  const returned = await expectStatus(
    await api("PUT", "/api/material-usage", {
      cookie: w.owner.cookie,
      body: { id: record.id, quantityUsed: 10, quantityReturned: 2, notes: "Two yards came back uncut" },
    }),
    200, "Return two yards"
  );
  assert.equal(returned.totalCost, 10 * 250, "The returned yards are no longer a cost of the job");
  assert.notEqual(returned.totalCost, 12 * 250, "and the order is not still charged for them");
  assert.equal(returned.quantityReturned, 2);
  assert.equal(returned.quantityUsed, 10);
});

test("rule 4: wastage stays consumed and never goes back on the shelf", async () => {
  const w = await materialWorld(100, 250);
  const before = await stockOf(w.owner.cookie, w.fabric.id);

  // Ten issued: six into garments, four ruined. Nothing came back.
  const record = await issue(w, {
    quantityIssued: 10, quantityUsed: 6, quantityWasted: 4, unitCost: 250,
    notes: "Four yards cut off-grain",
  });
  assert.equal(record.totalCost, 10 * 250, "Used and wasted are BOTH consumed, so both are charged");
  assert.equal(record.wastedCost, 4 * 250, "with the write-off visible on its own");
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), before - 10, "All ten left the store for good");

  // A later write-off is already out of stock: recording it must not move the shelf at all.
  const writtenOff = await expectStatus(
    await api("PUT", "/api/material-usage", {
      cookie: w.owner.cookie,
      body: { id: record.id, quantityUsed: 4, quantityWasted: 6, notes: "Two more yards torn on the machine" },
    }),
    200, "Write off two more yards"
  );
  assert.equal(writtenOff.quantityWasted, 6);
  assert.equal(writtenOff.totalCost, 10 * 250, "Wasted material is still charged to the job");
  assert.equal(
    await stockOf(w.owner.cookie, w.fabric.id), before - 10,
    "Writing off more moved NO stock: wastage is lost, not returned"
  );
});

test("rule 5: the same quantity can never be returned twice", async () => {
  const w = await materialWorld(100, 250);
  const before = await stockOf(w.owner.cookie, w.fabric.id);

  const record = await issue(w, { quantityIssued: 20, quantityUsed: 20 });
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), before - 20);

  // Two come back, then three more, on separate occasions.
  await expectStatus(
    await api("PUT", "/api/material-usage", {
      cookie: w.owner.cookie, body: { id: record.id, quantityUsed: 18, quantityReturned: 2, notes: "Two uncut" },
    }),
    200, "Return two yards"
  );
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), before - 18, "Two back on the shelf");

  await expectStatus(
    await api("PUT", "/api/material-usage", {
      cookie: w.owner.cookie, body: { id: record.id, quantityUsed: 15, quantityReturned: 5, notes: "Three more found uncut" },
    }),
    200, "Return three more, taking the total to five"
  );
  assert.equal(
    await stockOf(w.owner.cookie, w.fabric.id), before - 15,
    "Only the THREE new yards came back - not five again, which would double-count the first two"
  );

  // A return can never be taken back, so the shelf can never be credited twice for one yard.
  const unReturned = await api("PUT", "/api/material-usage", {
    cookie: w.owner.cookie, body: { id: record.id, quantityReturned: 3, notes: "Miscounted" },
  });
  assert.equal(unReturned.status, 400, "Five yards went back to the store; that cannot be un-recorded");
  assert.match(String(unReturned.data.error), /cannot be un-returned/i);
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), before - 15, "and the shelf did not move");

  // Nor can returns exceed what was ever issued.
  const tooMany = await api("PUT", "/api/material-usage", {
    cookie: w.owner.cookie, body: { id: record.id, quantityUsed: 0, quantityReturned: 21, notes: "All of it came back" },
  });
  assert.equal(tooMany.status, 400, "Twenty-one returned against twenty issued is impossible");
  assert.match(String(tooMany.data.error), /more than the 20 issued/i);
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), before - 15, "so no stock was created out of nothing");
});

test("rule 6: a return is auditable with who, when and why - and needs a reason of its own", async () => {
  const w = await materialWorld(100, 250);

  // The issue carries its own reason.
  const record = await issue(w, {
    quantityIssued: 12, quantityUsed: 12, notes: "Cutting the navy blazers",
  });
  assert.match(String(record.notes), /navy blazers/, "The reason the material was issued for is on the record");

  // A return recorded later cannot borrow that reason: it is a reason for a different event.
  const noReason = await api("PUT", "/api/material-usage", {
    cookie: w.owner.cookie, body: { id: record.id, quantityUsed: 10, quantityReturned: 2 },
  });
  assert.equal(noReason.status, 400, "A return with no reason of its own is refused");
  assert.match(String(noReason.data.error), /written reason/i);

  const returned = await expectStatus(
    await api("PUT", "/api/material-usage", {
      cookie: w.owner.cookie,
      body: { id: record.id, quantityUsed: 10, quantityReturned: 2, notes: "Two yards came back uncut" },
    }),
    200, "Return two yards, with the reason for the RETURN"
  );

  // Who, when and why, and the original reason still beside them.
  const trail = String(returned.notes);
  assert.match(trail, /Two yards came back uncut/, "why: the return's own reason");
  assert.match(trail, /2 returned to store/, "what: how much went back on the shelf");
  assert.match(trail, /\[\d{4}-\d{2}-\d{2}\]/, "when: the date the return was recorded, not the date it was issued");
  assert.match(trail, /by .+/, "who: the person who recorded it");
  assert.match(trail, /navy blazers/, "and the reason the material was issued for is NOT destroyed by the return");

  // A second return appends rather than replacing, so the whole history survives.
  const again = await expectStatus(
    await api("PUT", "/api/material-usage", {
      cookie: w.owner.cookie,
      body: { id: record.id, quantityUsed: 9, quantityReturned: 3, notes: "One more yard found" },
    }),
    200, "Return one more yard"
  );
  const longer = String(again.notes);
  assert.match(longer, /navy blazers/, "The issue reason is still there");
  assert.match(longer, /Two yards came back uncut/, "so is the first return");
  assert.match(longer, /One more yard found/, "and the second");
  assert.match(longer, /1 returned to store/, "each with its own quantity, so neither can be mistaken for the other");
});

test("rule 7: order profitability reflects material CONSUMED, not merely issued", async () => {
  const w = await materialWorld(100, 250);

  // Twenty issued against this order: fifteen into garments, three back on the shelf,
  // two ruined. Only the eighteen that were consumed may reach the order's cost.
  await issue(w, {
    quantityIssued: 20, quantityUsed: 15, quantityReturned: 3, quantityWasted: 2, unitCost: 250,
    notes: "Three yards came back, two ruined",
  });

  const order = await api("GET", `/api/orders/${w.order.orderId}`, { cookie: w.owner.cookie });
  const costs = (await expectStatus(order, 200, "Owner opens the order")).costs;
  const materialsLine = costs.lines.find((line: any) => line.key === "materials");
  assert.equal(materialsLine.amount, 17 * 250, "Fifteen used plus two wasted, at N250 - the three returned are absent");
  assert.equal(costs.materials, 17 * 250, "and the flat key agrees");
  assert.notEqual(costs.materials, 20 * 250, "NOT the twenty that were issued");
  assert.notEqual(costs.materials, 15 * 250, "and not the fifteen used, which would let the write-off go free");

  // Returning more afterwards must reduce the order's cost, not merely the shelf.
  const [record] = await expectStatus(
    await api("GET", `/api/material-usage?orderId=${w.order.orderId}`, { cookie: w.owner.cookie }),
    200, "Read the usage back"
  );
  await expectStatus(
    await api("PUT", "/api/material-usage", {
      cookie: w.owner.cookie,
      body: { id: record.id, quantityUsed: 13, quantityReturned: 5, notes: "Two more yards came back uncut" },
    }),
    200, "Return two more yards"
  );
  const after = await api("GET", `/api/orders/${w.order.orderId}`, { cookie: w.owner.cookie });
  const afterCosts = (await expectStatus(after, 200, "Owner reopens the order")).costs;
  assert.equal(afterCosts.materials, 15 * 250, "Thirteen used plus two wasted - the order is charged only for what it consumed");
  assert.equal(afterCosts.totalCost, afterCosts.materials, "No other cost line moved, so the restatement is entirely the return");
  assert.equal(afterCosts.profit, afterCosts.revenue - afterCosts.totalCost, "and profit still follows from the restated cost");
});

test("an entry made the old way is normalised, so returns against it are still bounded", async () => {
  const w = await materialWorld(100, 250);
  const before = await stockOf(w.owner.cookie, w.fabric.id);

  // No issued figure at all: the shape every record had before issue tracking existed.
  const legacy = await issue(w, { quantityUsed: 8 });
  assert.equal(
    legacy.quantityIssued, 8,
    "Issued is normalised to what was used, because nothing was reported as returned"
  );
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), before - 8, "Stock fell exactly as it always did");
  assert.equal(legacy.totalCost, 8 * 250, "and the cost is unchanged from the old formula");

  // Two of those yards turn out to be reusable. Used has to fall for the record to still
  // account for the eight that went out: returned material leaves the job's cost, not its history.
  const returned = await expectStatus(
    await api("PUT", "/api/material-usage", {
      cookie: w.owner.cookie, body: { id: legacy.id, quantityUsed: 6, quantityReturned: 2, notes: "Two yards came back uncut" },
    }),
    200, "Return two yards against a legacy record"
  );
  assert.equal(returned.totalCost, 6 * 250, "The order stops paying for what came back");
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), before - 6, "and the two yards are back on the shelf");

  // A second genuine return is still allowed: eight went out, only two have come back, so the
  // ceiling must not have shrunk to the six that are still recorded as used.
  const second = await expectStatus(
    await api("PUT", "/api/material-usage", {
      cookie: w.owner.cookie, body: { id: legacy.id, quantityUsed: 5, quantityReturned: 3, notes: "One more yard found uncut" },
    }),
    200, "Return a third yard against the same legacy record"
  );
  assert.equal(second.totalCost, 5 * 250, "Charged only for the five that stayed out");
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), before - 5, "Three of the eight are back on the shelf");

  // And the ceiling still stops an old-style record from returning more than it took.
  const impossible = await api("PUT", "/api/material-usage", {
    cookie: w.owner.cookie, body: { id: legacy.id, quantityReturned: 9, notes: "Trying to return more than was issued" },
  });
  assert.equal(impossible.status, 400, "Eight were issued, so nine cannot have come back");
  assert.match(String(impossible.data.error), /more than the 8 issued/i, "Eight went out, so nine cannot have come back");
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), before - 5, "and no stock was invented by the refused return");
});

// ---------------------------------------------------------------------------
// 4. STOCK INTEGRITY: ready-made never enters raw-material inventory, and the
//    shelf can never be drawn below zero.
// ---------------------------------------------------------------------------

/** A finished garment in the catalogue - the category that marks it as bought, not stored. */
async function readyMadeWorld(unitCost = 5000) {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 9000 });
  const garment = await expectStatus(
    await api("POST", "/api/materials", {
      cookie: owner.cookie,
      body: { name: unique("Ready-made polo"), category: "Ready-made garment", unit: "pcs", unitCost, reorderLevel: 0, currentStock: 0 },
    }),
    201, "Catalogue the finished garment"
  );
  return { owner, order, garment, unitCost };
}

test("a ready-made purchase through the general screen is a cost, and never raw-material stock", async () => {
  const w = await readyMadeWorld(5000);
  const before = await stockOf(w.owner.cookie, w.garment.id);

  // Bought through the general purchases screen, not the dedicated ready-made flow.
  const purchase = await expectStatus(
    await api("POST", "/api/material-purchases", {
      cookie: w.owner.cookie,
      body: { materialId: w.garment.id, quantity: 6, unitCost: 5000, supplier: "Lagos Uniforms Ltd", orderId: w.order.orderId },
    }),
    201, "Buy six finished polos"
  );
  assert.equal(purchase.totalCost, 30000, "The purchase is still recorded, with its own cost");

  assert.equal(
    await stockOf(w.owner.cookie, w.garment.id), before,
    "Six finished garments did NOT enter raw-material inventory - the shelf is exactly where it was"
  );

  // And the cost lands where ready-made cost belongs, not in fabric.
  const order = await api("GET", `/api/orders/${w.order.orderId}`, { cookie: w.owner.cookie });
  const costs = (await expectStatus(order, 200, "Owner opens the order")).costs;
  assert.equal(costs.readyMade, 30000, "Counted as a ready-made purchase");
  assert.equal(costs.materials, 0, "and not as a raw material consumed on the job");
  assert.equal(costs.internalLabour, 0, "and never as tailor labour: buying a garment pays no worker");
});

test("a legitimate raw-material purchase still lands on the shelf", async () => {
  const w = await materialWorld(20, 250);
  const before = await stockOf(w.owner.cookie, w.fabric.id);

  await expectStatus(
    await api("POST", "/api/material-purchases", {
      cookie: w.owner.cookie,
      body: { materialId: w.fabric.id, quantity: 30, unitCost: 260, supplier: "Kano Textiles" },
    }),
    201, "Buy thirty more yards of fabric"
  );
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), before + 30, "Raw material still enters stock exactly as before");

  const listed = await api("GET", "/api/materials", { cookie: w.owner.cookie });
  const rows = Array.isArray(listed.data) ? listed.data : listed.data.data ?? [];
  assert.equal(rows.find((m: any) => m.id === w.fabric.id).unitCost, 260, "and the catalogue price still follows the purchase");
});

test("a purchase against a material that does not exist is refused, not written as an orphan", async () => {
  const w = await readyMadeWorld();
  const missing = await api("POST", "/api/material-purchases", {
    cookie: w.owner.cookie, body: { materialId: 999999, quantity: 5, unitCost: 100 },
  });
  assert.equal(missing.status, 404, "There is nothing to buy against");
  const listed = await api("GET", "/api/material-purchases", { cookie: w.owner.cookie });
  const rows = Array.isArray(listed.data) ? listed.data : listed.data.data ?? [];
  assert.equal(rows.some((r: any) => r.materialId === 999999), false, "and no purchase row was left behind");
});

test("material cannot be issued beyond what the store actually holds", async () => {
  const w = await materialWorld(12, 250);
  const before = await stockOf(w.owner.cookie, w.fabric.id);
  assert.equal(before, 12);

  // Twenty yards asked for against twelve on the shelf.
  const tooMuch = await api("POST", "/api/material-usage", {
    cookie: w.owner.cookie,
    body: { materialId: w.fabric.id, orderId: w.order.orderId, quantityIssued: 20, quantityUsed: 20, notes: "Cutting the whole order at once" },
  });
  assert.equal(tooMuch.status, 400, "The store does not have it, so it cannot be issued");
  assert.match(String(tooMuch.data.error), /only 12/i, "The message says what IS there");
  assert.match(String(tooMuch.data.error), /not enough to issue 20/i, "and what was asked for");
  assert.match(String(tooMuch.data.error), /cannot go negative/i, "and why");

  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), before, "Stock did not move");

  const after = await api("GET", `/api/material-usage?orderId=${w.order.orderId}`, { cookie: w.owner.cookie });
  const rows = await expectStatus(after, 200, "Read the usage back");
  assert.equal(
    rows.filter((r: any) => r.materialId === w.fabric.id).length, 0,
    "Nothing was partially issued: the refused request left no record behind"
  );

  // Twelve is exactly what is there, so it must still be allowed.
  await expectStatus(
    await api("POST", "/api/material-usage", {
      cookie: w.owner.cookie,
      body: { materialId: w.fabric.id, orderId: w.order.orderId, quantityIssued: 12, quantityUsed: 12, notes: "Cutting the whole order at once" },
    }),
    201, "Issue exactly what the store holds"
  );
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), 0, "The shelf is empty, and exactly empty - not negative");
});

test("a return at issue time is counted against the store, so what stays out is what must be there", async () => {
  const w = await materialWorld(8, 250);

  // Ten issued and two come straight back, so only eight ever leave the shelf.
  await expectStatus(
    await api("POST", "/api/material-usage", {
      cookie: w.owner.cookie,
      body: { materialId: w.fabric.id, orderId: w.order.orderId, quantityIssued: 10, quantityUsed: 8, quantityReturned: 2, notes: "Two yards came back uncut" },
    }),
    201, "Issue ten, of which two return immediately"
  );
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), 0, "Eight left, two came back: the shelf is empty but never negative");

  // Nine would genuinely stay out, and the store does not have nine.
  const refused = await api("POST", "/api/material-usage", {
    cookie: w.owner.cookie,
    body: { materialId: w.fabric.id, orderId: w.order.orderId, quantityIssued: 10, quantityUsed: 9, quantityReturned: 1, notes: "One yard came back uncut" },
  });
  assert.equal(refused.status, 400, "Nine yards staying out against eight on the shelf is refused");
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), 0, "and the refused issue changed nothing");
});

test("an edit can put material back on the shelf but can never draw the shelf down", async () => {
  const w = await materialWorld(20, 250);

  const record = await expectStatus(
    await api("POST", "/api/material-usage", {
      cookie: w.owner.cookie,
      body: { materialId: w.fabric.id, orderId: w.order.orderId, quantityIssued: 20, quantityUsed: 20, notes: "Cutting the navy blazers" },
    }),
    201, "Issue twenty yards"
  );
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), 0, "All twenty left the store");

  // Four come back: the shelf rises, and stays honest.
  await expectStatus(
    await api("PUT", "/api/material-usage", {
      cookie: w.owner.cookie, body: { id: record.id, quantityUsed: 16, quantityReturned: 4, notes: "Four yards came back uncut" },
    }),
    200, "Return four yards"
  );
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), 4, "Four are back on the shelf");

  // Every way of trying to take MORE out through an edit is refused before stock moves.
  const unReturn = await api("PUT", "/api/material-usage", {
    cookie: w.owner.cookie, body: { id: record.id, quantityUsed: 20, quantityReturned: 0, notes: "They were not usable after all" },
  });
  assert.equal(unReturn.status, 400, "A recorded return cannot be un-recorded");
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), 4, "so the shelf did not fall");

  const overIssue = await api("PUT", "/api/material-usage", {
    cookie: w.owner.cookie, body: { id: record.id, quantityUsed: 24, notes: "Actually more was used" },
  });
  assert.equal(overIssue.status, 400, "An edit cannot claim more than the record was issued");
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), 4, "and the shelf still did not fall");

  // A genuine further return is still allowed, and still needs its own reason.
  await expectStatus(
    await api("PUT", "/api/material-usage", {
      cookie: w.owner.cookie, body: { id: record.id, quantityUsed: 14, quantityReturned: 6, notes: "Two more yards found uncut" },
    }),
    200, "Return two more yards"
  );
  assert.equal(await stockOf(w.owner.cookie, w.fabric.id), 6, "Six back in total - only ever the delta each time");
});

test("issuing a ready-made garment leaves raw-material stock alone in both directions", async () => {
  const w = await readyMadeWorld(5000);
  const before = await stockOf(w.owner.cookie, w.garment.id);

  // A finished garment is bought, not drawn from a fabric shelf, so issuing one against a job
  // has no shelf to empty - and the guard must not turn that into a refusal either.
  const record = await expectStatus(
    await api("POST", "/api/material-usage", {
      cookie: w.owner.cookie,
      body: { materialId: w.garment.id, orderId: w.order.orderId, quantityIssued: 4, quantityUsed: 4, notes: "Four bought-in polos monogrammed for this order" },
    }),
    201, "Charge four bought-in garments to the order"
  );
  assert.equal(record.totalCost, 4 * 5000, "The cost of the finished garments is charged to the job");
  assert.equal(await stockOf(w.owner.cookie, w.garment.id), before, "No raw-material stock was drawn down");

  // And returning one must not conjure finished goods onto a shelf that never held them.
  await expectStatus(
    await api("PUT", "/api/material-usage", {
      cookie: w.owner.cookie, body: { id: record.id, quantityUsed: 3, quantityReturned: 1, notes: "One polo was the wrong size and went back" },
    }),
    200, "Send one back"
  );
  assert.equal(await stockOf(w.owner.cookie, w.garment.id), before, "Returning one did not create raw-material stock out of nothing");

  const order = await api("GET", `/api/orders/${w.order.orderId}`, { cookie: w.owner.cookie });
  const costs = (await expectStatus(order, 200, "Owner opens the order")).costs;
  assert.equal(costs.readyMade, 3 * 5000, "Still classified as ready-made, and only for what was consumed");
  assert.equal(costs.materials, 0, "never as a raw material");
});
