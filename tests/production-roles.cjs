/*
 * Run against the local Matesther preview after build_and_start:
 *   node tests/production-roles.cjs
 * Uses temporary records and removes them afterward. Never point this at a real site.
 */
const assert = require("node:assert/strict");
const base = "http://127.0.0.1:3000";
const stamp = Date.now();

async function api(path, method = "GET", body, cookie) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
    session: response.headers.get("set-cookie")?.match(/matesther_session=([^;]+)/)?.[1],
  };
}
function expected(result, code, purpose) {
  assert.equal(result.status, code, `${purpose}: ${JSON.stringify(result.body)}`);
  return result.body;
}

(async () => {
  const ownerLogin = await api("/api/auth/login", "POST", { email: "estheradejugba@gmail.com", password: "owner123" });
  expected(ownerLogin, 200, "Owner login");
  const owner = `matesther_session=${ownerLogin.session}`;
  let managerId, promotedId, customerId, orderId;
  try {
    const account = expected(await api("/api/users", "POST", {
      name: "Alhaji Musa Ibrahim", email: `cutter-manager-${stamp}@test.example`, password: "StrongTest123",
      role: "PRODUCTION_MANAGER", workerId: 1,
    }, owner), 201, "Create one cutter/manager login");
    managerId = account.id;
    assert.equal(account.workerId, 1);
    const login = await api("/api/auth/login", "POST", { email: account.email, password: "StrongTest123" });
    expected(login, 200, "Cutter/manager login");
    const manager = `matesther_session=${login.session}`;
    const personal = expected(await api("/api/dashboard?view=my-work", "GET", undefined, manager), 200, "Personal dashboard");
    assert.equal(personal.view, "worker");
    assert.equal(personal.linked, true);
    assert.equal(personal.profile.id, 1);
    assert.equal(personal.revenue, undefined);
    const supervision = expected(await api("/api/dashboard", "GET", undefined, manager), 200, "Production dashboard");
    assert.equal(supervision.view, "pm");
    assert.equal(supervision.personal.linked, true);
    assert.equal(supervision.payroll, undefined);
    expected(await api("/api/payroll", "GET", undefined, manager), 403, "Company payroll forbidden");
    expected(await api("/api/reports", "GET", undefined, manager), 403, "Financial reports forbidden");
    console.log("Dual-role sign in: production dashboard and own earnings work without company financials.");

    const school = expected(await api("/api/customers", "POST", { name: `School ${stamp}`, type: "SCHOOL" }, owner), 201, "Test school");
    customerId = school.id;
    const order = expected(await api("/api/orders", "POST", {
      orderNumber: `ORD-TEST-${stamp}`, customerId, orderDate: "2026-09-24", dueDate: "2026-10-24",
      items: [{ productId: 1, quantity: 10, unitPrice: 4500 }],
    }, owner), 201, "Test order");
    orderId = order.id;
    const productionOrders = expected(await api("/api/production-orders", "GET", undefined, manager), 200, "Safe assignment catalogue");
    const item = productionOrders.find((entry) => entry.id === orderId)?.items[0];
    assert.ok(item);
    assert.equal(item.unitPrice, undefined);
    const batch = expected(await api("/api/batches", "POST", {
      orderId, orderItemId: item.id, quantity: 5, size: "M", color: "Navy", workerId: 1, cuttingRate: 175,
      tailorId: 3, sewingRate: 450, expectedCompletionDate: "2026-10-20",
    }, manager), 201, "Manager assigns size/colour batch");
    assert.equal(batch.size, "M");
    const jobs = expected(await api(`/api/operations?orderId=${orderId}`, "GET", undefined, manager), 200, "Batch operations");
    const cutting = jobs.find((job) => job.stage === "CUTTING" && job.productionBatchId === batch.id);
    const sewing = jobs.find((job) => job.stage === "SEWING" && job.productionBatchId === batch.id);
    assert.equal(cutting.workerId, 1);
    assert.equal(cutting.pieceRate, 175);
    assert.equal(sewing.workerId, 3);
    assert.equal(sewing.pieceRate, 450);
    expected(await api("/api/operations", "PUT", { id: cutting.id, submitQty: 3 }, manager), 200, "Manager submits own cutting work");
    const queueForManager = expected(await api("/api/dashboard?view=pm", "GET", undefined, manager), 200, "Manager queue");
    const queueForOwner = expected(await api("/api/dashboard?view=pm", "GET", undefined, owner), 200, "Owner queue");
    assert.ok(queueForManager.inspection.awaiting.some((job) => job.id === cutting.id && job.customer === school.name));
    assert.ok(queueForOwner.inspection.awaiting.some((job) => job.id === cutting.id));
    console.log("Both Owner and manager can find submitted garments grouped under the test school.");
    const approvedByManager = expected(await api("/api/inspections", "POST", {
      operationId: cutting.id, quantityApproved: 2, quantityRework: 1, quantityRejected: 0,
      notes: "One garment needs rework", inspectedBy: "Not the signed in person",
    }, manager), 201, "Manager inspects");
    assert.equal(approvedByManager.inspector, account.name);
    expected(await api("/api/operations", "PUT", { id: cutting.id, submitQty: 1 }, manager), 200, "Manager submits next garment");
    const approvedByOwner = expected(await api("/api/inspections", "POST", {
      operationId: cutting.id, quantityApproved: 1, quantityRework: 0, quantityRejected: 0,
    }, owner), 201, "Owner inspects");
    assert.equal(approvedByOwner.inspector, "Esther Adejugba");
    const updatedPersonal = expected(await api("/api/dashboard?view=my-work", "GET", undefined, manager), 200, "Updated own earnings");
    assert.equal(updatedPersonal.earnings.total, personal.earnings.total + 3 * 175);
    console.log("Partial approval, Owner approval and job-specific personal earnings are correct.");

    // The SAME Worker email may be promoted to Project Manager without a second login.
    const workerAccount = expected(await api("/api/users", "POST", {
      name: "Mrs. Funke Adeleke", email: `promoted-cutter-${stamp}@test.example`, password: "StrongTest123", role: "WORKER",
    }, owner), 201, "Create Worker login for promotion");
    promotedId = workerAccount.id;
    const promoted = expected(await api("/api/users", "PUT", {
      id: promotedId, name: workerAccount.name, role: "PRODUCTION_MANAGER", status: "ACTIVE", workerId: 2,
    }, owner), 200, "Promote existing login");
    assert.equal(promoted.email, workerAccount.email);
    assert.equal(promoted.workerId, 2);
    const promotedLogin = await api("/api/auth/login", "POST", { email: workerAccount.email, password: "StrongTest123" });
    expected(promotedLogin, 200, "Promoted login keeps its password");
    const promotedPersonal = expected(await api("/api/dashboard?view=my-work", "GET", undefined, `matesther_session=${promotedLogin.session}`), 200, "Promoted own profile");
    assert.equal(promotedPersonal.profile.id, 2);
    console.log("Existing Worker login promoted to Manager with same email and password.");
  } finally {
    if (orderId) console.log("Cleaned up order:", (await api(`/api/orders/${orderId}`, "DELETE", undefined, owner)).status);
    if (customerId) console.log("Cleaned up school:", (await api(`/api/customers/${customerId}`, "DELETE", undefined, owner)).status);
    if (managerId) console.log("Cleaned up manager login:", (await api(`/api/users?id=${managerId}`, "DELETE", undefined, owner)).status);
    if (promotedId) console.log("Cleaned up promoted login:", (await api(`/api/users?id=${promotedId}`, "DELETE", undefined, owner)).status);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
