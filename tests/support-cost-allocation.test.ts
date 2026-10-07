/**
 * SUPPORT LABOUR IS AN INTERNAL ALLOCATION OF ONE COST, NOT A SECOND COST.
 *
 * The case this file exists to pin down, in the business's own numbers:
 *
 *     Tailor rate 300 x 100 approved pieces = 30,000 gross commission.
 *     18 of those pieces were delegated to a support worker at 30.
 *     Matesther pays the support worker            540.
 *     The tailor's commission after deduction  = 29,460.
 *     Total internal labour cost of the order  = 30,000  -  NOT 30,540.
 *
 * The support worker is genuinely paid by Matesther, and payroll must show both sides:
 * the 540 going to the helper and the 540 coming back out of the tailor. But the ORDER
 * must not be costed twice for the same labour, because the 18 delegated pieces are
 * already inside the tailor's 100 approved pieces at the full 300 rate.
 *
 * Also asserted here:
 *   - support work inherits the exact share it was handed out from, and a helper cannot
 *     be pointed at a school chosen from scratch;
 *   - a tailor can only hand out work they hold themselves;
 *   - the quantity handed out cannot exceed the share, per supporting operation;
 *   - a tailor paid a flat monthly salary has no piece rate to deduct from, so the
 *     helper's pay stands alone as a real extra cost rather than vanishing;
 *   - and a deduction can never drive anybody's pay negative - what the month cannot
 *     absorb is held and reported, not written off.
 *
 * Runs against an empty database. Every fixture is created here through the real API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, expectStatus, createOwner, createStaff, createWorker, createOrder, startSupport, pauseSupport, resumeSupport, } from "./support/harness";
import { currentMonth } from "@/lib/payroll";
import { SUPPORT_ROLE } from "@/lib/format";

let n = 0;
const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}${(n += 1)}`;

/** A tailor who earns per piece and can sign in as a Worker. */
async function pieceTailor(ownerCookie: string, label: string, rate = 0) {
  const name = unique(label);
  const profile = await createWorker(ownerCookie, {
    name, specialty: "Tailor", roles: ["Tailor"], paymentType: "PER_PIECE", paymentRate: rate,
  });
  const login = await createStaff(ownerCookie, { name, role: "WORKER" });
  return { ...profile, login: login.cookie, name };
}

/** A support worker, per piece, who can sign in. */
async function helper(ownerCookie: string, label: string) {
  const name = unique(label);
  const profile = await createWorker(ownerCookie, {
    name, specialty: SUPPORT_ROLE, roles: [SUPPORT_ROLE], paymentType: "PER_PIECE",
  });
  const login = await createStaff(ownerCookie, { name, role: "WORKER" });
  return { ...profile, login: login.cookie, name };
}

/** 100 navy size-10 polos entering SEWING, on a SEWING -> IRONING route. */
async function hundredPolosAtSewing(unitPrice = 4500) {
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity: 100, unitPrice });
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
  return { owner, order, variant, batchId: batch.data.id, sewing: stages.get("SEWING") };
}

/** Give one tailor the whole 100 at SEWING, at an agreed piece rate. */
async function allocateAll(w: Awaited<ReturnType<typeof hundredPolosAtSewing>>, workerId: number, pieceRate: number) {
  const made = await api("POST", "/api/allocations", {
    cookie: w.owner.cookie,
    body: { operationId: w.sewing.id, workerId, quantity: 100, pieceRate },
  });
  await expectStatus(made, 201, "Allocate all 100 pieces to the tailor at the agreed rate");
  const rows = await api("GET", `/api/allocations?operationId=${w.sewing.id}`, { cookie: w.owner.cookie });
  const mine = (rows.data as any[]).find((row) => row.workerId === workerId);
  assert.ok(mine, "The tailor's share is listed on the stage");
  return mine;
}

/** The tailor submits all 100 and the Owner approves all 100 at the tailor's rate. */
async function approveHundred(w: Awaited<ReturnType<typeof hundredPolosAtSewing>>, allocation: any) {
  const tailorLogin = allocation.__login as string;
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: tailorLogin, body: { id: w.sewing.id, submitQty: 100 } }),
    200, "The tailor submits the 100 pieces they hold"
  );
  await expectStatus(
    await api("POST", "/api/inspections", {
      cookie: w.owner.cookie,
      body: {
        operationId: w.sewing.id, quantityApproved: 100, quantityRework: 0, quantityRejected: 0,
        attributions: [{ allocationId: allocation.id, quantityApproved: 100, quantityRework: 0, quantityRejected: 0 }],
      },
    }),
    201, "The Owner approves all 100 against that tailor"
  );
}

/** Hand `quantity` pieces of a supporting operation to a helper, off a named share. */
async function delegate(
  tailorLogin: string,
  helperId: number,
  allocationId: number,
  quantity: number,
  rate: number,
  operation = "Weaving"
) {
  return api("POST", "/api/support-work", {
    cookie: tailorLogin,
    body: { workerId: helperId, operation, quantityAssigned: quantity, pieceRate: rate, productionAllocationId: allocationId },
  });
}

async function payrollRow(ownerCookie: string, workerId: number) {
  const payroll = await api("GET", `/api/payroll?month=${currentMonth()}`, { cookie: ownerCookie });
  await expectStatus(payroll, 200, "Owner payroll");
  const row = payroll.data.workers.find((entry: any) => entry.workerId === workerId);
  assert.ok(row, "The worker must appear on the payroll sheet");
  return { row, payroll };
}

async function orderCostsOf(ownerCookie: string, orderId: number) {
  const response = await api("GET", `/api/orders/${orderId}`, { cookie: ownerCookie });
  await expectStatus(response, 200, "Owner opens the order");
  return response.data.costs;
}

// ---------------------------------------------------------------------------
// 1. The business's own numbers, end to end.
// ---------------------------------------------------------------------------

test("100 approved at 300 with 18 delegated at 30 costs the order 30,000 of labour, not 30,540", async () => {
  const w = await hundredPolosAtSewing();
  const tailorA = await pieceTailor(w.owner.cookie, "Tailor A");
  const weaver = await helper(w.owner.cookie, "Support Weaver");

  const allocation = await allocateAll(w, tailorA.id, 300);
  allocation.__login = tailorA.login;
  await approveHundred(w, allocation);

  // The tailor hands 18 of their own pieces to the helper, at the rate agreed with
  // the helper. They are handing out work they hold, off a named share.
  const handed = await delegate(tailorA.login, weaver.id, allocation.id, 18, 30);
  const assignment = await expectStatus(handed, 201, "The tailor delegates 18 pieces of weaving");

  /* ---- the hand-over inherited everything; nothing was chosen from scratch ---- */
  assert.equal(assignment.productionAllocationId, allocation.id, "It names the exact share");
  assert.equal(assignment.productionOperationId, w.sewing.id, "and the stage that share belongs to");
  assert.equal(assignment.orderId, w.order.orderId, "and the order");
  assert.equal(assignment.orderItemId, w.order.itemId, "and the item");
  assert.equal(assignment.orderVariantId, w.variant.id, "and the exact variant: Navy, size 10");
  assert.equal(assignment.stage, "SEWING", "and the stage, inherited not retyped");
  assert.equal(assignment.assignedByWorkerId, tailorA.id, "The tailor who holds it is who handed it out");
  assert.equal(assignment.pieceRate, 30, "The helper's rate is snapshotted on the assignment");

  // The lifecycle requires work to have begun before it is handed back.
  await startSupport(weaver.login, assignment.id);
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: weaver.login, body: { id: assignment.id, submitQty: 18 } }),
    200, "The helper submits the 18 woven pieces"
  );
  const inspected = await api("PUT", "/api/support-work", {
    cookie: tailorA.login,
    body: { id: assignment.id, quantityApproved: 18, quantityRework: 0, quantityRejected: 0 },
  });
  const check = await expectStatus(inspected, 201, "The tailor who handed it out inspects it");
  assert.equal(check.payable, 18 * 30, "The helper is paid 540 for 18 approved pieces");
  assert.equal(check.deductedFromTailor, 18 * 30, "and exactly 540 comes back out of the tailor");
  assert.equal(check.deductedFromWorkerId, tailorA.id, "from the tailor who handed it out");

  /* ---- payroll shows BOTH sides ---- */
  const helperPay = await payrollRow(w.owner.cookie, weaver.id);
  assert.equal(helperPay.row.supportPieces, 18);
  assert.equal(helperPay.row.supportPiecework, 540, "The support worker is paid directly by Matesther");
  assert.equal(helperPay.row.supportDeduction, 0, "Nothing is deducted from somebody who only received work");

  const tailorPay = await payrollRow(w.owner.cookie, tailorA.id);
  assert.equal(tailorPay.row.piecework, 30000, "The tailor's GROSS commission is 100 x 300");
  assert.equal(tailorPay.row.supportPiecesDelegated, 18, "18 pieces were handed out");
  assert.equal(tailorPay.row.supportDeductionArising, 540, "The deduction those approvals caused");
  assert.equal(tailorPay.row.supportDeduction, 540, "absorbed in full, because the month had the commission to absorb it");
  assert.equal(tailorPay.row.supportDeductionOwed, 0, "so nothing is carried forward");
  assert.equal(tailorPay.row.due, 29460, "The tailor retains 29,460");

  /* ---- the order counts that labour ONCE ---- */
  const costs = await orderCostsOf(w.owner.cookie, w.order.orderId);
  assert.equal(costs.internalLabour, 30000, "Internal labour is the tailor's gross commission");
  assert.equal(costs.supportGrossPaid, 540, "The cash paid to the support worker is reported");
  assert.equal(costs.supportDeductedFromTailors, 540, "and so is what it took back out of the tailor");
  assert.equal(costs.supportLabour, 0, "so support work ADDS nothing to the order's labour cost");
  assert.equal(costs.machineLabour, 0);
  assert.equal(
    costs.internalLabour + costs.machineLabour + costs.supportLabour,
    30000,
    "Total labour cost is 30,000 - the same 18 pieces are never costed twice"
  );
  assert.equal(costs.revenue, 100 * 4500);
  assert.equal(costs.profit, 100 * 4500 - 30000, "Profit is revenue less the labour actually costed once");
});

// ---------------------------------------------------------------------------
// 2. Only approved pieces move money, on either side.
// ---------------------------------------------------------------------------

test("unapproved delegated pieces pay the helper nothing and deduct nothing from the tailor", async () => {
  const w = await hundredPolosAtSewing();
  const tailorA = await pieceTailor(w.owner.cookie, "Tailor A");
  const weaver = await helper(w.owner.cookie, "Support Weaver");
  const allocation = await allocateAll(w, tailorA.id, 300);
  allocation.__login = tailorA.login;
  await approveHundred(w, allocation);

  const assignment = await expectStatus(
    await delegate(tailorA.login, weaver.id, allocation.id, 20, 30), 201, "Delegate 20 pieces"
  );
  // The lifecycle requires work to have begun before it is handed back.
  await startSupport(weaver.login, assignment.id);
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: weaver.login, body: { id: assignment.id, submitQty: 20 } }),
    200, "The helper submits 20"
  );
  // Ten approved, six to redo, four ruined: only the ten move money.
  const check = await expectStatus(
    await api("PUT", "/api/support-work", {
      cookie: tailorA.login,
      body: { id: assignment.id, quantityApproved: 10, quantityRework: 6, quantityRejected: 4, notes: "Six loose, four torn" },
    }),
    201, "Judge the 20 submitted pieces"
  );
  assert.equal(check.payable, 300, "Only the 10 approved pieces pay");
  assert.equal(check.deductedFromTailor, 300, "and only those 10 are deducted from the tailor");

  const costs = await orderCostsOf(w.owner.cookie, w.order.orderId);
  assert.equal(costs.supportGrossPaid, 300);
  assert.equal(costs.supportDeductedFromTailors, 300);
  assert.equal(costs.supportLabour, 0);
  assert.equal(costs.internalLabour, 30000, "The tailor's gross commission is untouched by the split");
});

// ---------------------------------------------------------------------------
// 3. A tailor with no piece rate: the helper's pay is a real extra cost.
// ---------------------------------------------------------------------------

test("a monthly-paid tailor has nothing to deduct from, so the helper's pay stands alone", async () => {
  const w = await hundredPolosAtSewing();
  const name = unique("Salaried Tailor");
  const salaried = await createWorker(w.owner.cookie, {
    name, specialty: "Tailor", roles: ["Tailor"], paymentType: "MONTHLY", paymentRate: 50000,
  });
  const salariedLogin = (await createStaff(w.owner.cookie, { name, role: "WORKER" })).cookie;
  const weaver = await helper(w.owner.cookie, "Support Weaver");

  const allocation = await allocateAll(w, salaried.id, 300);
  allocation.__login = salariedLogin;
  await approveHundred(w, allocation);

  const assignment = await expectStatus(
    await delegate(salariedLogin, weaver.id, allocation.id, 18, 30), 201, "Delegate 18 pieces"
  );
  // The lifecycle requires work to have begun before it is handed back.
  await startSupport(weaver.login, assignment.id);
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: weaver.login, body: { id: assignment.id, submitQty: 18 } }),
    200, "The helper submits"
  );
  const check = await expectStatus(
    await api("PUT", "/api/support-work", {
      cookie: salariedLogin,
      body: { id: assignment.id, quantityApproved: 18, quantityRework: 0, quantityRejected: 0 },
    }),
    201, "The salaried tailor inspects the delegated work"
  );
  assert.equal(check.payable, 540, "The helper is still paid by Matesther");
  assert.equal(check.deductedFromTailor, 540, "The rule reports what it would take");

  const tailorPay = await payrollRow(w.owner.cookie, salaried.id);
  assert.equal(tailorPay.row.piecework, 0, "A monthly-paid tailor earns no piecework");
  assert.equal(tailorPay.row.salary, 50000);
  assert.equal(tailorPay.row.supportDeduction, 0, "so there is no commission to deduct from");
  assert.equal(tailorPay.row.supportDeductionOwed, 0, "and nothing is held against them either");
  assert.equal(tailorPay.row.due, 50000, "Their salary is untouched");

  // The order, though, really did spend 540 on labour that no commission covers.
  const costs = await orderCostsOf(w.owner.cookie, w.order.orderId);
  assert.equal(costs.internalLabour, 0, "No piece-rate commission was earned on this order");
  assert.equal(costs.supportGrossPaid, 540);
  assert.equal(costs.supportDeductedFromTailors, 0, "Nothing could be deducted");
  assert.equal(costs.supportLabour, 540, "so the helper's pay is a genuine extra labour cost");
});

// ---------------------------------------------------------------------------
// 4. A deduction can never make pay negative; what the month cannot absorb is held.
// ---------------------------------------------------------------------------

test("a deduction with no commission to come out of is held, never made negative", async () => {
  const owner = await createOwner();
  const tailorName = unique("Delegating Tailor");
  const tailorA = await createWorker(owner.cookie, { name: tailorName, specialty: "Tailor", roles: ["Tailor"], paymentType: "PER_PIECE" });
  const tailorLogin = (await createStaff(owner.cookie, { name: tailorName, role: "WORKER" })).cookie;
  const weaver = await helper(owner.cookie, "Support Weaver");

  // Support work with no production share behind it: nothing has been approved for this
  // tailor at all, so there is no commission for the helper's rate to come out of.
  const assignment = await expectStatus(
    await api("POST", "/api/support-work", {
      cookie: tailorLogin,
      body: { workerId: weaver.id, operation: "Taping", quantityAssigned: 10, pieceRate: 300 },
    }),
    201, "The tailor records 10 pieces of taping handed to the helper"
  );
  // The lifecycle requires work to have begun before it is handed back.
  await startSupport(weaver.login, assignment.id);
  await expectStatus(
    await api("PUT", "/api/support-work", { cookie: weaver.login, body: { id: assignment.id, submitQty: 10 } }),
    200, "The helper submits"
  );
  await expectStatus(
    await api("PUT", "/api/support-work", {
      cookie: tailorLogin,
      body: { id: assignment.id, quantityApproved: 10, quantityRework: 0, quantityRejected: 0 },
    }),
    201, "The tailor approves all 10"
  );

  const helperPay = await payrollRow(owner.cookie, weaver.id);
  assert.equal(helperPay.row.supportPiecework, 3000, "The helper is paid in full");

  const tailorPay = await payrollRow(owner.cookie, tailorA.id);
  assert.equal(tailorPay.row.piecework, 0, "They approved no pieces of their own");
  assert.equal(tailorPay.row.supportDeductionArising, 3000, "3,000 of deduction arose");
  assert.equal(tailorPay.row.supportDeduction, 0, "and none of it could be taken this month");
  assert.equal(tailorPay.row.supportDeductionOwed, 3000, "so all of it is held for later months");
  assert.equal(tailorPay.row.due, 0, "Their pay is never driven negative by a deduction");
  assert.ok(tailorPay.row.due >= 0, "No worker's due is ever negative");

  // A bank sheet lists people to pay, and says what it deliberately left off.
  const sheet = await api("GET", `/api/payment-sheet?month=${currentMonth()}`, { cookie: owner.cookie });
  await expectStatus(sheet, 200, "Owner builds the payment sheet");
  assert.equal(
    sheet.data.totals.due,
    sheet.data.rows.reduce((sum: number, row: any) => sum + row.due, 0),
    "The sheet's totals describe the sheet's own rows"
  );
  assert.equal(sheet.data.notListed.supportDeductionOwed >= 3000, true, "What is held back is reported, not hidden");
});

// ---------------------------------------------------------------------------
// 5. Only the holder of the work may hand it out, and only what they hold.
// ---------------------------------------------------------------------------

test("a tailor cannot hand out another tailor's share, nor more of their own than exists", async () => {
  const w = await hundredPolosAtSewing();
  const tailorA = await pieceTailor(w.owner.cookie, "Tailor A");
  const tailorB = await pieceTailor(w.owner.cookie, "Tailor B");
  const weaver = await helper(w.owner.cookie, "Support Weaver");

  const made = await api("POST", "/api/allocations", {
    cookie: w.owner.cookie,
    body: { operationId: w.sewing.id, workerId: tailorA.id, quantity: 40, pieceRate: 300 },
  });
  await expectStatus(made, 201, "Tailor A holds 40 of the 100");
  const rows = await api("GET", `/api/allocations?operationId=${w.sewing.id}`, { cookie: w.owner.cookie });
  const shareA = (rows.data as any[]).find((row) => row.workerId === tailorA.id);

  // Tailor B reaching into Tailor A's share.
  const stolen = await delegate(tailorB.login, weaver.id, shareA.id, 5, 30);
  assert.equal(stolen.status, 403, "A tailor may only hand out work they hold themselves");
  assert.match(String(stolen.data.error), /hold yourself/i);

  // The Owner recording it on Tailor A's behalf attributes it to Tailor A, not to the Owner.
  const onBehalf = await api("POST", "/api/support-work", {
    cookie: w.owner.cookie,
    // An Owner has no worker record of their own, so they must name the tailor the
    // hand-over belongs to - and it must be the one holding the share.
    body: {
      workerId: weaver.id, assignedByWorkerId: tailorA.id, operation: "Weaving",
      quantityAssigned: 5, pieceRate: 30, productionAllocationId: shareA.id,
    },
  });
  const recorded = await expectStatus(onBehalf, 201, "The Owner may record it for the holder");
  assert.equal(recorded.assignedByWorkerId, tailorA.id, "It belongs to the tailor holding the share");

  // 40 garments can take 40 weaves AND 40 tapes, but never 41 weaves.
  await expectStatus(
    await delegate(tailorA.login, weaver.id, shareA.id, 35, 30, "Weaving"),
    201, "35 more weaves on the same share is within the 40 held"
  );
  const tooMany = await delegate(tailorA.login, weaver.id, shareA.id, 1, 30, "Weaving");
  assert.equal(tooMany.status, 400, "That would be 41 weaves on 40 garments");
  assert.match(String(tooMany.data.error), /left to hand out|already been handed out/i);
  await expectStatus(
    await delegate(tailorA.login, weaver.id, shareA.id, 40, 30, "Taping"),
    201, "A different supporting operation on the same garments is not double-counted"
  );
});
