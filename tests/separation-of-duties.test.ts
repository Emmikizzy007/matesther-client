/**
 * Separation of duties: the cutter-supervisor restriction and the ban on
 * inspecting your own submitted work.
 *
 * These are the controls that stop one person assigning, completing and
 * approving the same garments. They must hold server-side, regardless of what
 * the UI shows.
 *
 * Runs against an empty database. Every fixture is created here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
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

/**
 * Standard cast for these tests:
 *  - an Owner
 *  - a Cutter who is ALSO a Project Manager (the risky combination)
 *  - a second, unrelated Cutter
 *  - a Project Manager who does not cut (the legitimate inspector)
 *  - a Tailor
 *  - an order with one garment line
 */
async function world() {
  const owner = await createOwner();
  const cutterName = unique("Cutter Supervisor");
  const otherCutterName = unique("Other Cutter");
  const tailorName = unique("Tailor");

  const cutter = await createWorker(owner.cookie, { name: cutterName, specialty: "Cutter", isInspector: true });
  const otherCutter = await createWorker(owner.cookie, { name: otherCutterName, specialty: "Cutter" });
  const tailor = await createWorker(owner.cookie, { name: tailorName, specialty: "Tailor" });

  const cutterManager = await createStaff(owner.cookie, {
    name: cutterName,
    role: "PRODUCTION_MANAGER",
    workerId: cutter.id,
  });
  const inspectorManager = await createStaff(owner.cookie, {
    name: unique("Inspector Supervisor"),
    role: "PRODUCTION_MANAGER",
  });

  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 4500 });
  return { owner, cutter, otherCutter, tailor, cutterManager, inspectorManager, order };
}

/** Create a batch (as Owner) and return its per-stage operations. */
async function batchWithStages(ownerCookie: string, orderId: number, itemId: number, quantity: number) {
  const created = await api("POST", "/api/batches", {
    cookie: ownerCookie,
    body: { orderId, orderItemId: itemId, quantity },
  });
  await expectStatus(created, 201, "Create unassigned batch");
  const jobs = await api("GET", "/api/operations", { cookie: ownerCookie });
  await expectStatus(jobs, 200, "Load operations");
  const stages = new Map<string, any>(
    jobs.data.filter((job: any) => job.productionBatchId === created.data.id).map((job: any) => [job.stage, job])
  );
  return { batchId: created.data.id, stages };
}

test("cutting-assignment rights: Owner yes, cutter-supervisor no, other manager yes", async () => {
  const { owner, cutterManager, inspectorManager, cutter } = await world();

  const ownerRights = await api("GET", "/api/production-access", { cookie: owner.cookie });
  await expectStatus(ownerRights, 200, "Owner production access");
  assert.equal(ownerRights.data.canAssignCutting, true);

  const cutterRights = await api("GET", "/api/production-access", { cookie: cutterManager.cookie });
  await expectStatus(cutterRights, 200, "Cutter-supervisor production access");
  assert.equal(cutterRights.data.canAssignCutting, false, "A cutter-supervisor must not assign cutting work");
  assert.equal(cutterRights.data.cutterSupervisor, true);
  assert.equal(cutterRights.data.workerId, cutter.id, "The supervisor is linked to their own cutter profile");

  const otherRights = await api("GET", "/api/production-access", { cookie: inspectorManager.cookie });
  await expectStatus(otherRights, 200, "Non-cutting manager production access");
  assert.equal(otherRights.data.canAssignCutting, true, "A manager who does not cut may assign cutting work");
});

test("a cutter-supervisor cannot assign cutting work to themselves", async () => {
  const { cutterManager, cutter, tailor, order } = await world();
  const result = await api("POST", "/api/batches", {
    cookie: cutterManager.cookie,
    body: {
      orderId: order.orderId,
      orderItemId: order.itemId,
      quantity: 5,
      workerId: cutter.id,
      cuttingRate: 200,
      tailorId: tailor.id,
      sewingRate: 450,
    },
  });
  assert.equal(result.status, 403, "Self-assignment of cutting must be refused server-side");
});

test("a cutter-supervisor cannot assign cutting work to another cutter", async () => {
  const { cutterManager, otherCutter, order } = await world();
  const result = await api("POST", "/api/batches", {
    cookie: cutterManager.cookie,
    body: {
      orderId: order.orderId,
      orderItemId: order.itemId,
      quantity: 5,
      workerId: otherCutter.id,
      cuttingRate: 200,
    },
  });
  assert.equal(result.status, 403, "Assigning another cutter must also be refused");
});

test("a cutter-supervisor may still create a batch that leaves cutting unassigned", async () => {
  const { cutterManager, order } = await world();
  const result = await api("POST", "/api/batches", {
    cookie: cutterManager.cookie,
    body: { orderId: order.orderId, orderItemId: order.itemId, quantity: 5 },
  });
  await expectStatus(result, 201, "Cutter-supervisor creates a batch without assigning a cutter");

  const jobs = await api("GET", "/api/operations", { cookie: cutterManager.cookie });
  const cutting = jobs.data.find((job: any) => job.productionBatchId === result.data.id && job.stage === "CUTTING");
  assert.ok(cutting, "A cutting stage should exist");
  assert.equal(cutting.workerId, null, "Cutting must be left for the Owner or a non-cutting supervisor");
});

test("a cutter-supervisor cannot edit or reassign the cutting stage", async () => {
  const { owner, cutterManager, otherCutter, order } = await world();
  const { stages } = await batchWithStages(owner.cookie, order.orderId, order.itemId, 10);
  const cutting = stages.get("CUTTING");

  const selfEdit = await api("PUT", "/api/operations", {
    cookie: cutterManager.cookie,
    body: { id: cutting.id, workerId: null, pieceRate: 200, status: "IN_PROGRESS" },
  });
  assert.equal(selfEdit.status, 403, "A cutter-supervisor must not manage the cutting stage");

  const reassign = await api("PUT", "/api/operations", {
    cookie: cutterManager.cookie,
    body: { id: cutting.id, workerId: otherCutter.id, pieceRate: 200, status: "IN_PROGRESS" },
  });
  assert.equal(reassign.status, 403, "Nor hand cutting to another cutter");
});

test("the Owner may assign the cutter, and the cutter-supervisor may submit their own work", async () => {
  const { owner, cutterManager, cutter, order } = await world();
  const { stages } = await batchWithStages(owner.cookie, order.orderId, order.itemId, 10);
  const cutting = stages.get("CUTTING");

  const assigned = await api("PUT", "/api/operations", {
    cookie: owner.cookie,
    body: { id: cutting.id, workerId: cutter.id, pieceRate: 200, status: "IN_PROGRESS" },
  });
  await expectStatus(assigned, 200, "Owner assigns the cutter");
  assert.equal(assigned.data.workerId, cutter.id);

  const submitted = await api("PUT", "/api/operations", {
    cookie: cutterManager.cookie,
    body: { id: cutting.id, submitQty: 3 },
  });
  await expectStatus(submitted, 200, "Cutter-supervisor submits their own 3 pieces");
  assert.equal(submitted.data.quantityCompleted, 3);
  assert.equal(submitted.data.status, "SUBMITTED");
});

test("a cutter-supervisor cannot inspect or approve their own submitted work", async () => {
  const { owner, cutterManager, cutter, order } = await world();
  const { stages } = await batchWithStages(owner.cookie, order.orderId, order.itemId, 10);
  const cutting = stages.get("CUTTING");

  await expectStatus(
    await api("PUT", "/api/operations", {
      cookie: owner.cookie,
      body: { id: cutting.id, workerId: cutter.id, pieceRate: 200, status: "IN_PROGRESS" },
    }),
    200,
    "Owner assigns the cutter"
  );
  await expectStatus(
    await api("PUT", "/api/operations", { cookie: cutterManager.cookie, body: { id: cutting.id, submitQty: 3 } }),
    200,
    "Cutter-supervisor submits their own work"
  );

  const selfInspect = await api("POST", "/api/inspections", {
    cookie: cutterManager.cookie,
    body: { operationId: cutting.id, quantityApproved: 3, quantityRework: 0, quantityRejected: 0 },
  });
  assert.equal(selfInspect.status, 403, "Self-inspection must be refused server-side");
});

test("the recorded inspector is the signed-in user, never the value sent by the client", async () => {
  const { owner, cutterManager, cutter, inspectorManager, order } = await world();
  const { stages } = await batchWithStages(owner.cookie, order.orderId, order.itemId, 10);
  const cutting = stages.get("CUTTING");

  await api("PUT", "/api/operations", {
    cookie: owner.cookie,
    body: { id: cutting.id, workerId: cutter.id, pieceRate: 200, status: "IN_PROGRESS" },
  });
  await api("PUT", "/api/operations", { cookie: cutterManager.cookie, body: { id: cutting.id, submitQty: 3 } });

  const inspected = await api("POST", "/api/inspections", {
    cookie: inspectorManager.cookie,
    body: {
      operationId: cutting.id,
      quantityApproved: 3,
      quantityRework: 0,
      quantityRejected: 0,
      inspectedBy: "Somebody Impersonated",
    },
  });
  await expectStatus(inspected, 201, "A different supervisor inspects the work");
  assert.notEqual(inspected.data.inspector, "Somebody Impersonated", "The forged inspector name must be ignored");

  const me = await api("GET", "/api/auth/me", { cookie: inspectorManager.cookie });
  assert.equal(inspected.data.inspector, me.data.name, "The inspector recorded must be the signed-in supervisor");
});

test("the Owner may also inspect, and may not inspect more pieces than are pending", async () => {
  const { owner, cutterManager, cutter, order } = await world();
  const { stages } = await batchWithStages(owner.cookie, order.orderId, order.itemId, 10);
  const cutting = stages.get("CUTTING");

  await api("PUT", "/api/operations", {
    cookie: owner.cookie,
    body: { id: cutting.id, workerId: cutter.id, pieceRate: 200, status: "IN_PROGRESS" },
  });
  await api("PUT", "/api/operations", { cookie: cutterManager.cookie, body: { id: cutting.id, submitQty: 3 } });

  const tooMany = await api("POST", "/api/inspections", {
    cookie: owner.cookie,
    body: { operationId: cutting.id, quantityApproved: 9, quantityRework: 0, quantityRejected: 0 },
  });
  assert.equal(tooMany.status, 400, "Cannot inspect more pieces than were submitted");

  const approved = await api("POST", "/api/inspections", {
    cookie: owner.cookie,
    body: { operationId: cutting.id, quantityApproved: 3, quantityRework: 0, quantityRejected: 0 },
  });
  await expectStatus(approved, 201, "Owner approves the 3 submitted pieces");
  assert.equal(approved.data.quantityApproved, 3);

  const again = await api("POST", "/api/inspections", {
    cookie: owner.cookie,
    body: { operationId: cutting.id, quantityApproved: 1, quantityRework: 0, quantityRejected: 0 },
  });
  assert.equal(again.status, 400, "Nothing is left awaiting inspection");
});

test("a rejection or rework requires a written reason", async () => {
  const { owner, cutterManager, cutter, order } = await world();
  const { stages } = await batchWithStages(owner.cookie, order.orderId, order.itemId, 10);
  const cutting = stages.get("CUTTING");

  await api("PUT", "/api/operations", {
    cookie: owner.cookie,
    body: { id: cutting.id, workerId: cutter.id, pieceRate: 200, status: "IN_PROGRESS" },
  });
  await api("PUT", "/api/operations", { cookie: cutterManager.cookie, body: { id: cutting.id, submitQty: 3 } });

  const noReason = await api("POST", "/api/inspections", {
    cookie: owner.cookie,
    body: { operationId: cutting.id, quantityApproved: 2, quantityRework: 1, quantityRejected: 0 },
  });
  assert.equal(noReason.status, 400, "Rework must be explained");

  const withReason = await api("POST", "/api/inspections", {
    cookie: owner.cookie,
    body: {
      operationId: cutting.id,
      quantityApproved: 2,
      quantityRework: 1,
      quantityRejected: 0,
      notes: "One piece cut off-grain",
    },
  });
  await expectStatus(withReason, 201, "Rework recorded with a reason");
});

test("only approved pieces flow into the next production stage", async () => {
  const { owner, cutterManager, cutter, tailor, order } = await world();
  const { stages } = await batchWithStages(owner.cookie, order.orderId, order.itemId, 10);
  const cutting = stages.get("CUTTING");
  const sewing = stages.get("SEWING");
  assert.equal(sewing.quantityReceived, 0, "Sewing starts with nothing until cutting is approved");

  await api("PUT", "/api/operations", {
    cookie: owner.cookie,
    body: { id: cutting.id, workerId: cutter.id, pieceRate: 200, status: "IN_PROGRESS" },
  });
  await api("PUT", "/api/operations", { cookie: cutterManager.cookie, body: { id: cutting.id, submitQty: 10 } });

  const inspected = await api("POST", "/api/inspections", {
    cookie: owner.cookie,
    body: {
      operationId: cutting.id,
      quantityApproved: 7,
      quantityRework: 2,
      quantityRejected: 1,
      notes: "Two need recutting, one ruined",
    },
  });
  await expectStatus(inspected, 201, "Split inspection 7 approved / 2 rework / 1 rejected");

  const jobs = await api("GET", "/api/operations", { cookie: owner.cookie });
  const sewingAfter = jobs.data.find((job: any) => job.id === sewing.id);
  assert.equal(sewingAfter.quantityReceived, 7, "Only the 7 approved pieces may reach sewing");
  assert.equal(tailor.specialty, "Tailor");
});

test("earnings are paid on approved pieces only, at the rate agreed for that job", async () => {
  const { owner, cutterManager, cutter, order } = await world();
  const { stages } = await batchWithStages(owner.cookie, order.orderId, order.itemId, 10);
  const cutting = stages.get("CUTTING");

  const before = await api("GET", "/api/dashboard?view=my-work", { cookie: cutterManager.cookie });
  await expectStatus(before, 200, "Earnings before inspection");
  assert.equal(before.data.earnings.total, 0, "Nothing is payable before inspection");

  await api("PUT", "/api/operations", {
    cookie: owner.cookie,
    body: { id: cutting.id, workerId: cutter.id, pieceRate: 200, status: "IN_PROGRESS" },
  });
  await api("PUT", "/api/operations", { cookie: cutterManager.cookie, body: { id: cutting.id, submitQty: 10 } });

  // 10 submitted, but only 6 approved: 4 must not become payable.
  const inspected = await api("POST", "/api/inspections", {
    cookie: owner.cookie,
    body: {
      operationId: cutting.id,
      quantityApproved: 6,
      quantityRework: 3,
      quantityRejected: 1,
      notes: "Three to rework, one rejected",
    },
  });
  await expectStatus(inspected, 201, "Partial approval");

  const after = await api("GET", "/api/dashboard?view=my-work", { cookie: cutterManager.cookie });
  await expectStatus(after, 200, "Earnings after inspection");
  assert.equal(after.data.earnings.total, 6 * 200, "Only the 6 approved pieces at the agreed ₦200 are payable");
});

test("inspection history is preserved as an audit trail, never overwritten", async () => {
  const { owner, cutterManager, cutter, order } = await world();
  const { stages } = await batchWithStages(owner.cookie, order.orderId, order.itemId, 10);
  const cutting = stages.get("CUTTING");

  await api("PUT", "/api/operations", {
    cookie: owner.cookie,
    body: { id: cutting.id, workerId: cutter.id, pieceRate: 200, status: "IN_PROGRESS" },
  });
  await api("PUT", "/api/operations", { cookie: cutterManager.cookie, body: { id: cutting.id, submitQty: 4 } });
  await api("POST", "/api/inspections", {
    cookie: owner.cookie,
    body: { operationId: cutting.id, quantityApproved: 2, quantityRework: 2, quantityRejected: 0, notes: "First pass" },
  });
  await api("PUT", "/api/operations", { cookie: cutterManager.cookie, body: { id: cutting.id, submitQty: 2 } });
  await api("POST", "/api/inspections", {
    cookie: owner.cookie,
    body: { operationId: cutting.id, quantityApproved: 2, quantityRework: 0, quantityRejected: 0 },
  });

  const history = await api("GET", `/api/inspections?operationId=${cutting.id}`, { cookie: owner.cookie });
  await expectStatus(history, 200, "Inspection audit trail");
  assert.equal(history.data.length, 2, "Both inspections must remain as separate rows");
  assert.equal(
    history.data.reduce((sum: number, row: any) => sum + row.quantityApproved, 0),
    4,
    "All 4 pieces were eventually approved across the two inspections"
  );
});

test("a batch with submitted or approved work cannot be deleted", async () => {
  const { owner, cutterManager, cutter, order } = await world();
  const { batchId, stages } = await batchWithStages(owner.cookie, order.orderId, order.itemId, 10);
  const cutting = stages.get("CUTTING");

  await api("PUT", "/api/operations", {
    cookie: owner.cookie,
    body: { id: cutting.id, workerId: cutter.id, pieceRate: 200, status: "IN_PROGRESS" },
  });
  await api("PUT", "/api/operations", { cookie: cutterManager.cookie, body: { id: cutting.id, submitQty: 2 } });

  const removal = await api("DELETE", `/api/batches?id=${batchId}`, { cookie: owner.cookie });
  assert.equal(removal.status, 400, "Production history must not be deletable once work exists");
});
