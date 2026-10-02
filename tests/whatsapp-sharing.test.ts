/**
 * WhatsApp sharing: deep-link construction, the shared document action bar, and
 * the authorization that must not have moved.
 *
 * The sharing feature adds NO API endpoint and NO new data, so the security
 * question is narrow and is tested directly here: the documents behind the
 * share buttons are still Owner-only, and the share buttons never pre-select a
 * recipient for a confidential payroll sheet.
 *
 * Component assertions render the real DocumentActions component with
 * react-dom/server, so the markup that ships is what is being checked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentActions } from "@/components/documents/DocumentActions";
import {
  NIGERIA_COUNTRY_CODE,
  WHATSAPP_MESSAGE_LIMIT,
  hasWhatsappNumber,
  whatsappHref,
  whatsappMessage,
  whatsappNumber,
} from "@/lib/whatsapp";
import { api, expectStatus, createOwner, createStaff, createOrder } from "./support/harness";

let n = 0;
const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}${(n += 1)}`;

/** Pull the wa.me href out of rendered markup. */
function renderedWhatsappHref(html: string): string | null {
  return html.match(/href="(https:\/\/wa\.me\/[^"]*)"/)?.[1] ?? null;
}

function renderActions(props: {
  customerPhone?: string | null;
  customerEmail?: string | null;
  sensitive?: boolean;
  message?: string;
}): string {
  return renderToStaticMarkup(
    createElement(DocumentActions, {
      title: "Matesther document",
      filename: "receipt",
      message: props.message ?? "Order ORD-2026-001 paid in full.",
      customerPhone: props.customerPhone ?? null,
      customerEmail: props.customerEmail ?? null,
      sensitive: props.sensitive ?? false,
    })
  );
}

/* ------------------------------------------------------------------ */
/* Phone normalisation                                                 */
/* ------------------------------------------------------------------ */

test("Nigerian phone numbers are normalised to the digits wa.me expects", () => {
  assert.equal(whatsappNumber("0803 123 4567"), "2348031234567");
  assert.equal(whatsappNumber("08031234567"), "2348031234567");
  assert.equal(whatsappNumber("8031234567"), "2348031234567", "Local without the trunk zero");
  assert.equal(whatsappNumber("+234 803 123 4567"), "2348031234567");
  assert.equal(whatsappNumber("234-803-123-4567"), "2348031234567");
  assert.equal(whatsappNumber("0703 123 4567"), "2347031234567");
  assert.equal(NIGERIA_COUNTRY_CODE, "234");
});

test("a phone number that cannot be resolved is never guessed", () => {
  // Guessing would open a chat with the WRONG person, which is worse than
  // making the sender choose a contact.
  assert.equal(whatsappNumber(null), null);
  assert.equal(whatsappNumber(undefined), null);
  assert.equal(whatsappNumber(""), null);
  assert.equal(whatsappNumber("   "), null);
  assert.equal(whatsappNumber("call the office"), null);
  assert.equal(whatsappNumber("12345"), null, "Far too short to be a mobile number");
  assert.equal(whatsappNumber("0123"), null);
  assert.equal(
    whatsappNumber("447911123456"),
    null,
    "A foreign number must not be mis-prefixed with the Nigerian country code"
  );
  assert.equal(hasWhatsappNumber("0803 123 4567"), true);
  assert.equal(hasWhatsappNumber("12345"), false);
});

/* ------------------------------------------------------------------ */
/* Deep-link construction                                              */
/* ------------------------------------------------------------------ */

test("the deep link opens the school's chat when a number is known", () => {
  const href = whatsappHref("Order ORD-2026-001 receipt", "0803 123 4567");
  assert.equal(href, "https://wa.me/2348031234567?text=Order%20ORD-2026-001%20receipt");
});

test("without a usable number the link lets the sender choose a contact", () => {
  assert.equal(
    whatsappHref("Order ORD-2026-001 receipt", null),
    "https://wa.me/?text=Order%20ORD-2026-001%20receipt"
  );
  assert.equal(
    whatsappHref("Order ORD-2026-001 receipt", "not a number"),
    "https://wa.me/?text=Order%20ORD-2026-001%20receipt",
    "An unusable number falls back rather than producing a broken chat link"
  );
});

test("message text is URL-encoded so it cannot break out of the link", () => {
  const href = whatsappHref("Balance 50% & due? See #1 <script>", "08031234567");
  const text = decodeURIComponent(href.split("?text=")[1]);
  assert.equal(text, "Balance 50% & due? See #1 <script>", "The original text survives a round trip");
  assert.equal(href.includes(" "), false, "No raw spaces in a URL");
  assert.equal(href.includes("<script>"), false, "Markup is encoded, not injected");
  // Everything after ?text= must be a single encoded value.
  assert.equal(href.split("?").length, 2, "No extra query parameters can be smuggled in");
});

test("a long document summary is trimmed instead of producing a broken link", () => {
  const long = "x".repeat(WHATSAPP_MESSAGE_LIMIT + 500);
  const trimmed = whatsappMessage(long);
  assert.equal(trimmed.length, WHATSAPP_MESSAGE_LIMIT + 1, "Trimmed to the limit plus the ellipsis");
  assert.equal(trimmed.endsWith("…"), true);
  assert.equal(whatsappMessage("short note"), "short note", "Short messages are untouched");
  const href = whatsappHref(long, "08031234567");
  assert.ok(href.length < 2000, "The resulting link stays a usable length");
});

test("the shared message never contains an application link", () => {
  // Matesther's document pages require an Owner session, so a URL in a WhatsApp
  // message would be useless to the recipient and could only confuse them.
  for (const phone of ["08031234567", null]) {
    const href = whatsappHref("Receipt MTH-REC-0001 for St Mary's. Total ₦450,000.", phone);
    assert.equal(href.startsWith("https://wa.me/"), true);
    assert.equal(href.includes("matesther"), false, "No app origin is leaked into the link");
    assert.equal(href.includes("/receipt/"), false);
  }
});

/* ------------------------------------------------------------------ */
/* The shared document action bar                                      */
/* ------------------------------------------------------------------ */

test("every document gets a WhatsApp action that works without JavaScript", () => {
  const html = renderActions({ customerPhone: "0803 123 4567" });
  const href = renderedWhatsappHref(html);
  assert.ok(href, "A WhatsApp link is rendered");
  assert.equal(href, "https://wa.me/2348031234567?text=Order%20ORD-2026-001%20paid%20in%20full.");
  // An <a href>, not a JS handler: it survives JavaScript being disabled and
  // hands over to the WhatsApp app on a phone.
  assert.match(html, /<a[^>]*href="https:\/\/wa\.me\//);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="[^"]*noreferrer/, "The app origin is not sent to WhatsApp as a referrer");
  assert.match(html, /WhatsApp school/, "With a known number the button says who it will open");
});

test("with no customer number the button still works and does not claim a recipient", () => {
  const html = renderActions({ customerPhone: null });
  const href = renderedWhatsappHref(html);
  assert.equal(href, "https://wa.me/?text=Order%20ORD-2026-001%20paid%20in%20full.");
  assert.equal(html.includes("WhatsApp school"), false, "It must not promise a specific chat");
  assert.match(html, /\sWhatsApp<\/a>/, "The button is still offered as the fallback");
});

test("an unusable customer number degrades to choose-a-contact, not a wrong chat", () => {
  const html = renderActions({ customerPhone: "12345" });
  assert.equal(renderedWhatsappHref(html), "https://wa.me/?text=Order%20ORD-2026-001%20paid%20in%20full.");
  assert.equal(html.includes("WhatsApp school"), false);
});

test("a confidential payroll sheet never pre-selects a recipient and says so", () => {
  // Even if a phone number were somehow supplied, a sensitive document must open
  // WhatsApp with no recipient so the Owner consciously chooses who receives
  // salary figures.
  const html = renderActions({ customerPhone: "0803 123 4567", sensitive: true });
  const href = renderedWhatsappHref(html);
  assert.ok(href, "The Owner can still share their own sheet");
  assert.equal(
    href.startsWith("https://wa.me/?text="),
    true,
    "No phone number is embedded for a confidential document"
  );
  assert.equal(href.includes("2348031234567"), false);
  assert.match(html, /confidential salary information/i, "The Owner is warned before sending");
  assert.match(html, /no recipient chosen/i);
});

test("WhatsApp is offered even when the customer has no email address", () => {
  const withoutEmail = renderActions({ customerEmail: null, customerPhone: "08031234567" });
  assert.ok(renderedWhatsappHref(withoutEmail), "WhatsApp does not depend on an email address");
  assert.equal(withoutEmail.includes("mailto:"), false);

  const withEmail = renderActions({ customerEmail: "bursar@school.invalid", customerPhone: "08031234567" });
  assert.ok(renderedWhatsappHref(withEmail));
  assert.match(withEmail, /mailto:/, "The existing email action is preserved");
});

test("the existing share and print actions are still present", () => {
  const html = renderActions({});
  assert.match(html, /Share details/, "The Web Share / clipboard fallback remains");
  assert.match(html, /Print \/ Save as PDF/, "Printing remains");
});

/* ------------------------------------------------------------------ */
/* Authorization must not have moved                                   */
/* ------------------------------------------------------------------ */

test("the documents behind the share buttons remain Owner-only", async () => {
  const owner = await createOwner();
  const manager = await createStaff(owner.cookie, { name: unique("Supervisor"), role: "PRODUCTION_MANAGER" });
  const workerName = unique("Pieceworker");
  const order = await createOrder(owner.cookie, { quantity: 10, unitPrice: 5000 });
  const worker = await createStaff(owner.cookie, { name: workerName, role: "WORKER" });

  const payment = await api("POST", "/api/payments", {
    cookie: owner.cookie,
    body: { orderId: order.orderId, amount: 100000, paymentMethod: "Bank Transfer" },
  });
  await expectStatus(payment, 201, "Owner records a customer payment");

  const endpoints = [
    `/api/receipts?paymentId=${payment.data.id}`,
    `/api/deliveries?deliveryId=1`,
    `/api/payment-sheet?month=${new Date().toISOString().slice(0, 7)}`,
  ];

  for (const path of endpoints) {
    for (const [label, cookie] of [["Project Manager", manager.cookie], ["Worker", worker.cookie]] as const) {
      const denied = await api("GET", path, { cookie });
      assert.equal(denied.status, 403, `${label} must be refused ${path}`);
      assert.equal(
        JSON.stringify(denied.data).includes("amount"),
        false,
        `${label} must receive no document figures from ${path}`
      );
    }
    const anonymous = await api("GET", path);
    assert.equal(anonymous.status, 401, `An unauthenticated request must be refused ${path}`);
  }

  const ownerReceipt = await api("GET", `/api/receipts?paymentId=${payment.data.id}`, { cookie: owner.cookie });
  await expectStatus(ownerReceipt, 200, "The Owner can still open the receipt");
  assert.equal(ownerReceipt.data.payment.amount, 100000);
});

test("the receipt carries the school phone that the WhatsApp button uses", async () => {
  const owner = await createOwner();
  const customer = await api("POST", "/api/customers", {
    cookie: owner.cookie,
    body: { name: unique("St Mary's"), type: "SCHOOL", phone: "0803 123 4567", email: "bursar@school.invalid" },
  });
  await expectStatus(customer, 201, "Create a school with a phone number");
  const product = await api("POST", "/api/products", {
    cookie: owner.cookie,
    body: { name: "Test Uniform Shirt", category: "Shirts", sellingPrice: 4500 },
  });
  await expectStatus(product, 201, "Create a garment");
  const order = await api("POST", "/api/orders", {
    cookie: owner.cookie,
    body: {
      customerId: customer.data.id,
      orderDate: "2026-09-01",
      dueDate: "2026-10-01",
      items: [{ productId: product.data.id, quantity: 10, unitPrice: 4500 }],
    },
  });
  await expectStatus(order, 201, "Create the order");
  const payment = await api("POST", "/api/payments", {
    cookie: owner.cookie,
    body: { orderId: order.data.id, amount: 45000, paymentMethod: "Bank Transfer" },
  });
  await expectStatus(payment, 201, "Record the payment");

  const receipt = await api("GET", `/api/receipts?paymentId=${payment.data.id}`, { cookie: owner.cookie });
  const document = await expectStatus(receipt, 200, "Load the receipt");
  assert.equal(document.customer.phone, "0803 123 4567", "The phone reaches the document");
  assert.equal(whatsappNumber(document.customer.phone), "2348031234567", "and resolves to a WhatsApp chat");

  // The rendered receipt action bar opens that school's chat.
  const html = renderActions({ customerPhone: document.customer.phone, customerEmail: document.customer.email });
  assert.equal(
    renderedWhatsappHref(html),
    "https://wa.me/2348031234567?text=Order%20ORD-2026-001%20paid%20in%20full."
  );
});
