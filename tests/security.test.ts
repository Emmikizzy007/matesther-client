/**
 * Authentication, session and cross-site request security.
 *
 * Runs against an empty database. Every fixture is created here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sessions } from "@/db/schema";
import {
  api,
  expectStatus,
  createOwner,
  sessionCookie,
  signIn,
  testEmail,
  ORIGIN,
} from "./support/harness";

test("health endpoint is public and reports a live database", async () => {
  const result = await api("GET", "/api/health");
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
});

test("every protected route rejects an unauthenticated request with 401", async () => {
  const protectedReads = [
    "/api/payroll",
    "/api/reports",
    "/api/workers",
    "/api/users",
    "/api/orders",
    "/api/customers",
    "/api/products",
    "/api/materials",
    "/api/expenses",
    "/api/payments",
    "/api/deliveries",
    "/api/receipts?paymentId=1",
    "/api/operations",
    "/api/inspections",
    "/api/dashboard",
    "/api/production-access",
    "/api/production-orders",
    "/api/batches",
  ];
  for (const path of protectedReads) {
    const result = await api("GET", path);
    assert.equal(result.status, 401, `GET ${path} should require a session`);
  }
});

test("protected writes also reject an unauthenticated request with 401", async () => {
  const writes: [string, string, unknown][] = [
    ["POST", "/api/orders", { customerId: 1, items: [{ productId: 1, quantity: 1, unitPrice: 1 }] }],
    ["POST", "/api/workers", { name: "Nobody" }],
    ["POST", "/api/users", { name: "Nobody", email: "n@x.invalid", password: "abcdef", role: "WORKER" }],
    ["POST", "/api/inspections", { operationId: 1, quantityApproved: 1 }],
    ["POST", "/api/batches", { orderId: 1, quantity: 1 }],
    ["PUT", "/api/operations", { id: 1, status: "COMPLETED" }],
    ["POST", "/api/payroll", { workerId: 1, amount: 100 }],
    ["POST", "/api/payments", { orderId: 1, amount: 100 }],
  ];
  for (const [method, path, body] of writes) {
    const result = await api(method, path, { body });
    assert.equal(result.status, 401, `${method} ${path} should require a session`);
  }
});

test("sign-in refuses a wrong password and an unknown account", async () => {
  const owner = await createOwner();
  const wrongPassword = await api("POST", "/api/auth/login", {
    body: { email: owner.email, password: "not-the-password" },
  });
  assert.equal(wrongPassword.status, 401);

  const unknown = await api("POST", "/api/auth/login", {
    body: { email: testEmail("ghost"), password: "whatever123" },
  });
  assert.equal(unknown.status, 401);
});

test("sign-in refuses an empty email or password", async () => {
  const result = await api("POST", "/api/auth/login", { body: { email: "", password: "" } });
  assert.equal(result.status, 400);
});

test("sign-in issues a session cookie and /api/auth/me reflects the role", async () => {
  const owner = await createOwner();
  const me = await api("GET", "/api/auth/me", { cookie: owner.cookie });
  await expectStatus(me, 200, "Owner /api/auth/me");
  assert.equal(me.data.role, "OWNER");
  assert.equal(me.data.email, owner.email);
});

test("/api/auth/me is 401 without a session", async () => {
  const result = await api("GET", "/api/auth/me");
  assert.equal(result.status, 401);
});

test("a forged or unknown session token is rejected", async () => {
  const result = await api("GET", "/api/payroll", {
    cookie: sessionCookie("0".repeat(64)),
  });
  assert.equal(result.status, 401);
});

test("an expired session is rejected and cleaned up", async () => {
  const owner = await createOwner();
  const token = owner.cookie.replace("matesther_session=", "");
  const { hashSessionToken } = await import("@/lib/session");
  await db
    .update(sessions)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(sessions.token, hashSessionToken(token)));

  const result = await api("GET", "/api/payroll", { cookie: owner.cookie });
  assert.equal(result.status, 401, "Expired session must not grant access");

  const [row] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.token, hashSessionToken(token)));
  assert.equal(row, undefined, "Expired session row should be deleted on use");
});

test("logout destroys the server-side session", async () => {
  const owner = await createOwner();
  const before = await api("GET", "/api/payroll", { cookie: owner.cookie });
  assert.equal(before.status, 200, "Owner should reach payroll before logout");

  const logout = await api("POST", "/api/auth/logout", { cookie: owner.cookie });
  assert.equal(logout.status, 200);

  const after = await api("GET", "/api/payroll", { cookie: owner.cookie });
  assert.equal(after.status, 401, "Session must be dead after logout");
});

test("a cross-origin write is blocked by the Origin check", async () => {
  const owner = await createOwner();
  const result = await api("POST", "/api/customers", {
    cookie: owner.cookie,
    body: { name: "Cross Site School" },
    headers: { origin: "https://malicious.example" },
  });
  assert.equal(result.status, 403);
});

test("a cross-site fetch-metadata write is blocked even without an Origin header", async () => {
  const owner = await createOwner();
  const result = await api("POST", "/api/customers", {
    cookie: owner.cookie,
    body: { name: "Fetch Metadata School" },
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(result.status, 403);
});

test("a same-origin write is allowed (control for the two tests above)", async () => {
  const owner = await createOwner();
  const result = await api("POST", "/api/customers", {
    cookie: owner.cookie,
    body: { name: "Same Origin School" },
    headers: { origin: ORIGIN },
  });
  assert.equal(result.status, 201, `expected 201, got ${result.status} ${JSON.stringify(result.data)}`);
});

test("a deactivated account cannot sign in", async () => {
  const owner = await createOwner();
  const email = testEmail("deactivated");
  const password = "StaffTest!2345";
  const created = await api("POST", "/api/users", {
    cookie: owner.cookie,
    body: { name: "Deactivated Person", email, password, role: "WORKER" },
  });
  await expectStatus(created, 201, "Create staff to deactivate");
  const deactivated = await api("PUT", "/api/users", {
    cookie: owner.cookie,
    body: { id: created.data.id, status: "INACTIVE" },
  });
  assert.equal(deactivated.status, 200);

  const attempt = await api("POST", "/api/auth/login", { body: { email, password } });
  assert.equal(attempt.status, 403, "Inactive account must be refused");
});

test("auth/status reports whether first-time setup is still needed", async () => {
  const result = await api("GET", "/api/auth/status");
  assert.equal(result.status, 200);
  assert.equal(result.data.hasUsers, true, "An Owner already exists in this database");
  // MATESTHER_SETUP_KEY is deliberately unset in tests, so bootstrap stays off.
  assert.equal(result.data.setupReady, false);
});

test("a second successful sign-in for the same person still works after re-login", async () => {
  const owner = await createOwner();
  const again = await signIn(owner.email, owner.password);
  const me = await api("GET", "/api/auth/me", { cookie: again });
  assert.equal(me.status, 200);
});
