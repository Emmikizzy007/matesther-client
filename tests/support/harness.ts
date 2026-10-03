/**
 * Shared test harness.
 *
 * Drives the REAL Next.js route handlers exported from src/app/api/**. Nothing
 * in this file re-implements, copies or fakes application behaviour: a test
 * calls `api("POST", "/api/inspections", ...)` and the actual route module runs
 * against the real Drizzle data layer.
 *
 * FIXTURES ARE NOT DEMO DATA
 *   The suite starts from an empty database and creates the handful of records
 *   each test needs through the public API, under unmistakable test identities
 *   (`@test.matesther.invalid`). It never reads seed.sql, never references a
 *   hard-coded record id, and never touches a real database.
 */
import { db } from "@/db";
import { organizations, users } from "@/db/schema";
import { hashPassword } from "@/lib/password";

import * as authLogin from "@/app/api/auth/login/route";
import * as authLogout from "@/app/api/auth/logout/route";
import * as authMe from "@/app/api/auth/me/route";
import * as authStatus from "@/app/api/auth/status/route";
import * as usersRoute from "@/app/api/users/route";
import * as workersRoute from "@/app/api/workers/route";
import * as customersRoute from "@/app/api/customers/route";
import * as customerByIdRoute from "@/app/api/customers/[id]/route";
import * as productsRoute from "@/app/api/products/route";
import * as ordersRoute from "@/app/api/orders/route";
import * as orderByIdRoute from "@/app/api/orders/[id]/route";
import * as batchesRoute from "@/app/api/batches/route";
import * as operationsRoute from "@/app/api/operations/route";
import * as inspectionsRoute from "@/app/api/inspections/route";
import * as payrollRoute from "@/app/api/payroll/route";
import * as supportWorkRoute from "@/app/api/support-work/route";
import * as supportInspectionsRoute from "@/app/api/support-work/inspections/route";
import * as paymentSheetRoute from "@/app/api/payment-sheet/route";
import * as reportsRoute from "@/app/api/reports/route";
import * as dashboardRoute from "@/app/api/dashboard/route";
import * as productionAccessRoute from "@/app/api/production-access/route";
import * as productionOrdersRoute from "@/app/api/production-orders/route";
import * as paymentsRoute from "@/app/api/payments/route";
import * as receiptsRoute from "@/app/api/receipts/route";
import * as deliveriesRoute from "@/app/api/deliveries/route";
import * as expensesRoute from "@/app/api/expenses/route";
import * as materialsRoute from "@/app/api/materials/route";
import * as healthRoute from "@/app/api/health/route";
import * as productionCorrectionsRoute from "@/app/api/production-corrections/route";
import * as routesRoute from "@/app/api/routes/route";
import * as externalWorkRoute from "@/app/api/external-work/route";
import * as readyMadeRoute from "@/app/api/ready-made/route";
import * as orderSizesRoute from "@/app/api/order-sizes/route";
import * as materialPurchasesRoute from "@/app/api/material-purchases/route";
import * as materialUsageRoute from "@/app/api/material-usage/route";

export const HOST = "matesther.test";
export const ORIGIN = `http://${HOST}`;

type RouteContext = { params: Promise<{ id: string }> };
type Handler = (req: Request) => Promise<Response>;
type ParamHandler = (req: Request, ctx: RouteContext) => Promise<Response>;

/** Exact-match routes: "METHOD /path" -> handler. */
const ROUTES: Record<string, Handler> = {
  "POST /api/auth/login": authLogin.POST,
  "POST /api/auth/logout": authLogout.POST,
  "GET /api/auth/me": authMe.GET,
  "GET /api/auth/status": authStatus.GET,
  "GET /api/users": usersRoute.GET,
  "POST /api/users": usersRoute.POST,
  "PUT /api/users": usersRoute.PUT,
  "DELETE /api/users": usersRoute.DELETE,
  "GET /api/workers": workersRoute.GET,
  "POST /api/workers": workersRoute.POST,
  "PUT /api/workers": workersRoute.PUT,
  "DELETE /api/workers": workersRoute.DELETE,
  "GET /api/customers": customersRoute.GET,
  "POST /api/customers": customersRoute.POST,
  "GET /api/products": productsRoute.GET,
  "POST /api/products": productsRoute.POST,
  "GET /api/orders": ordersRoute.GET,
  "POST /api/orders": ordersRoute.POST,
  "GET /api/batches": batchesRoute.GET,
  "POST /api/batches": batchesRoute.POST,
  "DELETE /api/batches": batchesRoute.DELETE,
  "GET /api/operations": operationsRoute.GET,
  "PUT /api/operations": operationsRoute.PUT,
  "GET /api/inspections": inspectionsRoute.GET,
  "POST /api/inspections": inspectionsRoute.POST,
  "GET /api/payroll": payrollRoute.GET,
  "POST /api/payroll": payrollRoute.POST,
  "GET /api/support-work": supportWorkRoute.GET,
  "POST /api/support-work": supportWorkRoute.POST,
  "PUT /api/support-work": supportWorkRoute.PUT,
  "GET /api/support-work/inspections": supportInspectionsRoute.GET,
  "GET /api/payment-sheet": paymentSheetRoute.GET,
  "GET /api/reports": reportsRoute.GET,
  "GET /api/dashboard": dashboardRoute.GET,
  "GET /api/production-access": productionAccessRoute.GET,
  "GET /api/production-orders": productionOrdersRoute.GET,
  "GET /api/payments": paymentsRoute.GET,
  "POST /api/payments": paymentsRoute.POST,
  "GET /api/receipts": receiptsRoute.GET,
  "GET /api/deliveries": deliveriesRoute.GET,
  "POST /api/deliveries": deliveriesRoute.POST,
  "GET /api/expenses": expensesRoute.GET,
  "GET /api/materials": materialsRoute.GET,
  "POST /api/materials": materialsRoute.POST,
  "PUT /api/materials": materialsRoute.PUT,
  "GET /api/health": healthRoute.GET,
  "GET /api/production-corrections": productionCorrectionsRoute.GET,
  "POST /api/production-corrections": productionCorrectionsRoute.POST,
  "GET /api/routes": routesRoute.GET,
  "POST /api/routes": routesRoute.POST,
  "PUT /api/routes": routesRoute.PUT,
  "DELETE /api/routes": routesRoute.DELETE,
  "GET /api/external-work": externalWorkRoute.GET,
  "POST /api/external-work": externalWorkRoute.POST,
  "PUT /api/external-work": externalWorkRoute.PUT,
  "GET /api/ready-made": readyMadeRoute.GET,
  // Registered so a test can build an order's exact variants. There is no PUT:
  // the dormant unaudited single-row quantity write was closed in Task 2.
  "GET /api/order-sizes": orderSizesRoute.GET,
  "POST /api/order-sizes": orderSizesRoute.POST,
  "GET /api/material-purchases": materialPurchasesRoute.GET,
  "POST /api/material-purchases": materialPurchasesRoute.POST,
  "GET /api/material-usage": materialUsageRoute.GET,
  "POST /api/material-usage": materialUsageRoute.POST,
  "POST /api/ready-made": readyMadeRoute.POST,
  "PUT /api/ready-made": readyMadeRoute.PUT,
};

/** Parameterised routes, matched in order. */
const PARAM_ROUTES: { method: string; match: RegExp; handler: ParamHandler }[] = [
  { method: "GET", match: /^\/api\/orders\/(\d+)$/, handler: orderByIdRoute.GET },
  { method: "PUT", match: /^\/api\/orders\/(\d+)$/, handler: orderByIdRoute.PUT },
  { method: "DELETE", match: /^\/api\/orders\/(\d+)$/, handler: orderByIdRoute.DELETE },
  { method: "PUT", match: /^\/api\/customers\/(\d+)$/, handler: customerByIdRoute.PUT },
  { method: "DELETE", match: /^\/api\/customers\/(\d+)$/, handler: customerByIdRoute.DELETE },
];

export type ApiResponse = {
  status: number;
  data: any;
  cookie: string | null;
};

export type ApiOptions = {
  cookie?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
};

/** Perform a request against the real route handler for `method` + `path`. */
export async function api(
  method: string,
  path: string,
  options: ApiOptions = {}
): Promise<ApiResponse> {
  const [pathname, search = ""] = path.split("?");
  const headers: Record<string, string> = {
    host: HOST,
    ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    ...(options.cookie ? { cookie: options.cookie } : {}),
    ...(options.headers ?? {}),
  };

  const request = new Request(`${ORIGIN}${pathname}${search ? `?${search}` : ""}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  let invoke: (() => Promise<Response>) | undefined;
  const plain = ROUTES[`${method} ${pathname}`];
  if (plain) {
    invoke = () => plain(request);
  } else {
    for (const route of PARAM_ROUTES) {
      if (route.method !== method) continue;
      const found = pathname.match(route.match);
      if (found) {
        invoke = () => route.handler(request, { params: Promise.resolve({ id: found[1] }) });
        break;
      }
    }
  }
  if (!invoke) throw new Error(`Test harness has no route for ${method} ${pathname}`);

  const response = await invoke();
  const data = await response.json().catch(() => ({}));
  const setCookie = response.headers.get("set-cookie");
  return {
    status: response.status,
    data,
    cookie: setCookie?.match(/matesther_session=([^;]+)/)?.[1] ?? null,
  };
}

/** Assert a status and return the body, with a readable failure message. */
export async function expectStatus(
  result: ApiResponse,
  status: number,
  label: string
): Promise<any> {
  if (result.status !== status) {
    throw new Error(
      `${label}: expected HTTP ${status}, got ${result.status} — ${JSON.stringify(result.data)}`
    );
  }
  return result.data;
}

/** Session cookie string for use in the `cookie` option. */
export function sessionCookie(token: string | null): string | null {
  return token ? `matesther_session=${token}` : null;
}

let sequence = 0;
/** Unique, obviously-synthetic email so no test can collide or look real. */
export function testEmail(prefix: string): string {
  sequence += 1;
  return `${prefix}-${Date.now()}-${sequence}@test.matesther.invalid`;
}

/**
 * Creates the organisation and first Owner directly.
 *
 * This mirrors what POST /api/auth/setup does in production; it is done here
 * because that route is gated behind MATESTHER_SETUP_KEY and refuses to run
 * twice, which would make repeated test runs impossible.
 */
export async function createOwner(): Promise<{ cookie: string; email: string; password: string }> {
  const [existing] = await db.select({ id: organizations.id }).from(organizations).limit(1);
  if (!existing) {
    await db.insert(organizations).values({
      id: 1,
      name: "Matesther",
      phone: "00000000000",
      email: "test@matesther.invalid",
      address: "Test address",
    });
  }
  const email = testEmail("owner");
  const password = "OwnerTest!2345";
  await db.insert(users).values({
    organizationId: 1,
    name: "Test Owner",
    email,
    passwordHash: hashPassword(password),
    role: "OWNER",
    status: "ACTIVE",
  });
  const login = await api("POST", "/api/auth/login", { body: { email, password } });
  await expectStatus(login, 200, "Owner sign-in");
  const cookie = sessionCookie(login.cookie);
  if (!cookie) throw new Error("Owner sign-in did not return a session cookie");
  return { cookie, email, password };
}

/** Sign in an existing account and return its session cookie. */
export async function signIn(email: string, password: string): Promise<string> {
  const result = await api("POST", "/api/auth/login", { body: { email, password } });
  await expectStatus(result, 200, `Sign-in for ${email}`);
  const cookie = sessionCookie(result.cookie);
  if (!cookie) throw new Error(`Sign-in for ${email} returned no session cookie`);
  return cookie;
}

export type StaffAccount = { id: number; email: string; password: string; cookie: string };

/** Create a staff login through the real /api/users route. */
export async function createStaff(
  owner: string,
  fields: { name: string; role: string; workerId?: number | null }
): Promise<StaffAccount> {
  const email = testEmail(fields.role.toLowerCase());
  const password = "StaffTest!2345";
  const created = await api("POST", "/api/users", {
    cookie: owner,
    body: { name: fields.name, email, password, role: fields.role, workerId: fields.workerId ?? null },
  });
  await expectStatus(created, 201, `Create ${fields.role} ${fields.name}`);
  const cookie = await signIn(email, password);
  return { id: created.data.id, email, password, cookie };
}

export type WorkerProfile = { id: number; name: string; specialty: string; roles: string[] };

/**
 * Create a factory worker profile through the real /api/workers route.
 *
 * `roles` is optional on purpose: leaving it out reproduces the legacy
 * single-specialty call, which is how every worker recorded before multi-role
 * support was created.
 */
export async function createWorker(
  owner: string,
  fields: {
    name: string;
    specialty: string;
    roles?: string[];
    paymentType?: string;
    paymentRate?: number;
    isInspector?: boolean;
    department?: string;
    jobTitle?: string;
  }
): Promise<WorkerProfile> {
  const created = await api("POST", "/api/workers", {
    cookie: owner,
    body: {
      name: fields.name,
      specialty: fields.specialty,
      ...(fields.roles ? { roles: fields.roles } : {}),
      ...(fields.department ? { department: fields.department } : {}),
      ...(fields.jobTitle ? { jobTitle: fields.jobTitle } : {}),
      paymentType: fields.paymentType ?? "PER_PIECE",
      paymentRate: fields.paymentRate ?? 0,
      isInspector: fields.isInspector ?? false,
    },
  });
  await expectStatus(created, 201, `Create worker ${fields.name}`);
  return {
    id: created.data.id,
    name: fields.name,
    specialty: created.data.specialty,
    roles: Array.isArray(created.data.roles) ? created.data.roles : [created.data.specialty],
  };
}

export type TestOrder = {
  orderId: number;
  orderNumber: string;
  itemId: number;
  customerId: number;
  productId: number;
};

/** Create a school, a garment and an order through the real API routes. */
export async function createOrder(
  owner: string,
  fields: { quantity?: number; unitPrice?: number } = {}
): Promise<TestOrder> {
  const customer = await api("POST", "/api/customers", {
    cookie: owner,
    body: { name: `Test School ${Date.now()}-${Math.floor(Math.random() * 1000)}`, type: "SCHOOL" },
  });
  await expectStatus(customer, 201, "Create test school");
  const product = await api("POST", "/api/products", {
    cookie: owner,
    body: { name: "Test Uniform Shirt", category: "Shirts", sellingPrice: 4500 },
  });
  await expectStatus(product, 201, "Create test garment");
  const quantity = fields.quantity ?? 10;
  const unitPrice = fields.unitPrice ?? 4500;
  const order = await api("POST", "/api/orders", {
    cookie: owner,
    body: {
      customerId: customer.data.id,
      orderDate: "2026-09-01",
      dueDate: "2026-10-01",
      items: [{ productId: product.data.id, quantity, unitPrice }],
    },
  });
  await expectStatus(order, 201, "Create test order");
  const detail = await api("GET", `/api/orders/${order.data.id}`, { cookie: owner });
  await expectStatus(detail, 200, "Load test order detail");
  const item = detail.data.items[0];
  if (!item) throw new Error("Test order was created without an item");
  return {
    orderId: order.data.id,
    orderNumber: order.data.orderNumber,
    itemId: item.id,
    customerId: customer.data.id,
    productId: product.data.id,
  };
}
