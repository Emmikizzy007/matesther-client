/**
 * Print-document validation: bank payment schedule, delivery sheet, invoice.
 *
 * These tests generate the documents at small and large record counts (2, 60
 * and 100+ bank rows; 3 and 70 delivery lines; 1 and 70 invoice line items)
 * through the real route handlers and assert the figures that matter:
 *
 * - Amount Payable equals the authoritative final net for the worker-month
 *   after every approved deduction, with any recorded payment subtracted
 *   exactly once (no double-deduction, no double-payment);
 * - the grand total reconciles against the authoritative payroll and payment
 *   batches, and a genuine discrepancy is REPORTED, not hidden;
 * - missing / invalid bank account numbers are flagged and never invented;
 * - non-payable workers are excluded from the bank table;
 * - pagination is automatic at 60 and 100+ rows with no row loss or splitting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkRows, DOC_ROWS_FIRST_PAGE, DOC_ROWS_PER_PAGE } from "@/lib/paginate";
import { accountFlag, buildBankSchedule, type SheetPayRow } from "@/lib/bank-schedule";
import { db } from "@/db";
import { deliveries, deliveryLines, orderItemSizes, orderItems, orders } from "@/db/schema";
import { eq } from "drizzle-orm";
import { api, expectStatus, createOwner, createStaff, createWorker, createOrder } from "./support/harness";

const MONTH = new Date().toISOString().slice(0, 7);

let n = 0;
const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}-${(n += 1)}`;

/* ------------------------------------------------------------------ unit */

test("print pagination: 60 and 100+ rows paginate automatically without losing or splitting rows", () => {
  assert.deepEqual(chunkRows([], DOC_ROWS_FIRST_PAGE, DOC_ROWS_PER_PAGE), []);
  const two = chunkRows([1, 2], DOC_ROWS_FIRST_PAGE, DOC_ROWS_PER_PAGE);
  assert.equal(two.length, 1, "two rows fit on one sheet");

  for (const count of [60, 100, 101, 250]) {
    const rows = Array.from({ length: count }, (_, i) => i);
    const pages = chunkRows(rows, DOC_ROWS_FIRST_PAGE, DOC_ROWS_PER_PAGE);
    const flattened = pages.flat();
    assert.equal(flattened.length, count, `${count}: no row lost`);
    assert.deepEqual(flattened, rows, `${count}: rows keep their order`);
    assert.ok(pages[0].length <= DOC_ROWS_FIRST_PAGE, `${count}: first sheet holds the letterhead`);
    for (const page of pages.slice(1)) assert.ok(page.length <= DOC_ROWS_PER_PAGE);
    if (count > DOC_ROWS_FIRST_PAGE)
      assert.ok(pages.length >= 2, `${count}: more than one printed sheet`);
    // A row belongs to exactly one sheet - nothing is split across pages.
    const seen = new Set(flattened);
    assert.equal(seen.size, count, `${count}: every row on exactly one sheet`);
  }
});

test("bank schedule: account numbers are flagged, never invented", () => {
  assert.equal(accountFlag(null), "MISSING");
  assert.equal(accountFlag(""), "MISSING");
  assert.equal(accountFlag("0123456789"), "OK", "standard 10-digit NUBAN");
  assert.equal(accountFlag("0123-456-789"), "OK", "separators are ignored");
  assert.equal(accountFlag("12345"), "CHECK", "too short to be a NUBAN");
  assert.equal(accountFlag("012345678901234567"), "CHECK", "too long to be a NUBAN");
});

test("bank schedule: net amounts, no double-count, non-payable excluded, discrepancies reported", () => {
  const rows: SheetPayRow[] = [
    // Multi-deduction worker whose net (due) is authoritative; nothing paid yet.
    { workerId: 1, name: "Ada", due: 42_500, paid: 0, balance: 42_500, paymentStatus: "UNPAID", bankAccountNumber: "0123456789" },
    // Part-paid: the bank must be told to transfer the remainder once. The
    // stored account is malformed and must be flagged, not trusted.
    { workerId: 2, name: "Bola", due: 60_000, paid: 20_000, balance: 40_000, paymentStatus: "PARTIAL", bankAccountNumber: "12345" },
    // Nothing paid, no account on file: flagged for follow-up.
    { workerId: 5, name: "Eve", due: 1_000, paid: 0, balance: 1_000, paymentStatus: "UNPAID", bankAccountNumber: null },
    // Already settled in full: not payable, excluded and counted.
    { workerId: 3, name: "Chidi", due: 30_000, paid: 30_000, balance: 0, paymentStatus: "PAID", bankAccountNumber: "99999999999" },
    // Overpaid: cannot be transferred, excluded, and REPORTED below.
    { workerId: 4, name: "Dora", due: 10_000, paid: 15_000, balance: -5_000, paymentStatus: "PAID", bankAccountNumber: "1234567890" },
  ];
  const totals = { due: 143_500, paid: 65_000, balance: 78_500 };
  const schedule = buildBankSchedule(rows, totals);

  assert.equal(schedule.entries.length, 3, "only people with something to pay appear");
  assert.deepEqual(schedule.entries.map((e) => e.workerId), [1, 2, 5]);
  assert.equal(schedule.entries[0].amountPayable, 42_500, "net after all approved deductions, nothing paid");
  assert.equal(schedule.entries[1].amountPayable, 40_000, "already-paid amount subtracted exactly once");
  assert.equal(schedule.grandTotal, 83_500);
  assert.equal(schedule.accountFlags.missing, 1);
  assert.equal(schedule.accountFlags.invalid, 1, "5 digits is not a NUBAN");
  assert.equal(schedule.settledExcluded, 2);
  assert.equal(schedule.nonPayableBalance, -5_000, "the overpayment is reported, not hidden");

  // 83,500 on the schedule + 20,000 already paid + 30,000 settled - 5,000
  // overpaid = 128,500 moved or due to move, against 143,500 of net payroll.
  // The schedule explains every naira of the difference.
  assert.equal(schedule.reconciliation.netPayrollDue, 143_500);
  assert.equal(schedule.reconciliation.paymentBatchPaid, 65_000);
  assert.equal(schedule.reconciliation.expectedRemaining, 78_500);
  assert.equal(schedule.reconciliation.discrepancy, 5_000);
  assert.equal(schedule.reconciliation.reconciled, false);

  // The ordinary case - every remaining balance positive - reconciles exactly.
  const clean = buildBankSchedule(
    [rows[0], rows[1], rows[2]],
    { due: 103_500, paid: 20_000, balance: 83_500 }
  );
  assert.equal(clean.reconciliation.reconciled, true);
  assert.equal(clean.reconciliation.discrepancy, 0);
});

/* ---------------------------------------------------------- integration */

async function makeMonthlyStaff(owner: string, count: number, rate = 50_000) {
  const workers = [];
  for (let i = 0; i < count; i += 1) {
    workers.push(await createWorker(owner, {
      name: unique(`Staff ${i}`),
      specialty: "Tailor",
      paymentType: "MONTHLY",
      paymentRate: rate,
    }));
  }
  return workers;
}

test("bank schedule: 2, 60 and 100+ workers - net amounts and grand-total reconciliation", async () => {
  const owner = await createOwner();

  let totalStaff = 0;
  for (const count of [2, 60, 101]) {
    await makeMonthlyStaff(owner.cookie, count);
    totalStaff += count;
    const payroll = await api("GET", `/api/payroll?month=${MONTH}`, { cookie: owner.cookie });
    await expectStatus(payroll, 200, "load authoritative payroll");
    const byName = new Map<string, any>(payroll.data.workers.map((row: any) => [row.name, row]));

    const sheet = await api("GET", `/api/payment-sheet?month=${MONTH}`, { cookie: owner.cookie });
    await expectStatus(sheet, 200, "load bank payment schedule");
    const schedule = sheet.data.bankSchedule;

    assert.equal(schedule.entries.length, totalStaff, `${count}: every unpaid staff member listed (${totalStaff} so far)`);
    let expected = 0;
    for (const entry of schedule.entries) {
      const authoritative = byName.get(entry.name);
      assert.ok(authoritative, `${count}: ${entry.name} exists in the payroll records`);
      assert.equal(entry.amountPayable, authoritative.due,
        `${count}: ${entry.name} amount payable is the final net after approved deductions`);
      assert.equal(entry.accountFlag, "MISSING", `${count}: absent account numbers are flagged`);
      assert.equal(entry.accountNumber, null, `${count}: no account number is invented`);
      expected += authoritative.due;
    }
    assert.equal(schedule.grandTotal, expected, `${count}: grand total is the sum of the rows`);
    assert.equal(schedule.reconciliation.reconciled, true,
      `${count}: grand total reconciles against the authoritative payroll and payment batches`);
    assert.equal(schedule.reconciliation.scheduleTotal, payroll.data.totals.balance,
      `${count}: schedule total equals the authoritative remaining`);

    // Pagination invariants at the page's actual capacities.
    const pages = chunkRows(schedule.entries, 22, 32);
    assert.equal(pages.flat().length, totalStaff);
    if (totalStaff > 22) assert.ok(pages.length >= 2, `${count}: 60/100+ rows paginate automatically`);
  }
});

test("bank schedule: account numbers validated and RBAC-protected; payments subtracted once; settled excluded", async () => {
  const owner = await createOwner();
  const [w1, w2, w3] = await makeMonthlyStaff(owner.cookie, 3);

  // Account numbers: one valid, one malformed, one left blank.
  await expectStatus(await api("PUT", "/api/workers", {
    cookie: owner.cookie,
    body: { id: w1.id, name: w1.name, specialty: "Tailor", paymentType: "MONTHLY", paymentRate: 50_000, bankAccountNumber: "0123456789" },
  }), 200, "record a real account number");
  await expectStatus(await api("PUT", "/api/workers", {
    cookie: owner.cookie,
    body: { id: w2.id, name: w2.name, specialty: "Tailor", paymentType: "MONTHLY", paymentRate: 50_000, bankAccountNumber: "1234567890123" },
  }), 200, "record a malformed account number");

  const payroll = await api("GET", `/api/payroll?month=${MONTH}`, { cookie: owner.cookie });
  await expectStatus(payroll, 200, "payroll");
  const rowOf = (name: string) => payroll.data.workers.find((row: any) => row.name === name);

  // Part-pay w1: the schedule must subtract the payment exactly once.
  const due1 = rowOf(w1.name).due;
  assert.ok(due1 > 20_000, "monthly net is large enough to part-pay");
  await expectStatus(await api("POST", "/api/payroll", {
    cookie: owner.cookie,
    body: { workerId: w1.id, amount: 20_000, periodMonth: MONTH, kind: "payment" },
  }), 201, "record part payment");
  // Settle w3 in full.
  const due3 = rowOf(w3.name).due;
  await expectStatus(await api("POST", "/api/payroll", {
    cookie: owner.cookie,
    body: { workerId: w3.id, amount: due3, periodMonth: MONTH, kind: "payment" },
  }), 201, "record full payment");

  const sheet = await api("GET", `/api/payment-sheet?month=${MONTH}`, { cookie: owner.cookie });
  await expectStatus(sheet, 200, "schedule after payments");
  const schedule = sheet.data.bankSchedule;
  const entryOf = (name: string) => schedule.entries.find((entry: any) => entry.name === name);

  const e1 = entryOf(w1.name);
  assert.equal(e1.amountPayable, due1 - 20_000, "net less the payment already made - subtracted once");
  assert.equal(e1.accountFlag, "OK");
  assert.equal(e1.accountNumber, "0123456789");
  const e2 = entryOf(w2.name);
  assert.equal(e2.accountFlag, "CHECK", "a 13-digit number is flagged, not trusted");
  const e3 = entryOf(w3.name);
  assert.equal(e3, undefined, "fully settled staff are non-payable and excluded");
  assert.equal(schedule.settledExcluded, 1);
  assert.equal(schedule.accountFlags.invalid, 1);
  assert.equal(schedule.reconciliation.reconciled, true,
    "payments and exclusions still reconcile against the authoritative batches");

  // RBAC: the account number travels only into Owner-only answers.
  const pm = await createStaff(owner.cookie, { name: unique("PM"), role: "PRODUCTION_MANAGER" });
  const denied = await api("GET", `/api/payment-sheet?month=${MONTH}`, { cookie: pm.cookie });
  await expectStatus(denied, 403, "a Production Manager never reaches the bank schedule");
  const pmWorkers = await api("GET", "/api/workers", { cookie: pm.cookie });
  await expectStatus(pmWorkers, 200, "PM worker list");
  for (const person of pmWorkers.data as any[])
    assert.equal("bankAccountNumber" in person, false, "bank account numbers stay out of PM responses");
});

test("delivery sheet: small and 70-line deliveries, colour resolution and totals per product", async () => {
  const owner = await createOwner();

  // Small: a real API-recorded delivery.
  const small = await createOrder(owner.cookie, { quantity: 10 });
  const created = await api("POST", "/api/deliveries", {
    cookie: owner.cookie,
    body: {
      orderId: small.orderId,
      deliveryDate: "2026-10-01",
      lines: [
        { orderItemId: small.itemId, quantity: 3, size: "M" },
        { orderItemId: small.itemId, quantity: 2, size: "L" },
      ],
    },
  });
  await expectStatus(created, 201, "record small delivery");
  const smallDoc = await api("GET", `/api/deliveries?deliveryId=${created.data.id}`, { cookie: owner.cookie });
  await expectStatus(smallDoc, 200, "load small delivery sheet");
  assert.equal(smallDoc.data.lines.length, 2);
  assert.equal(smallDoc.data.delivery.deliveryNumber, `MTH-DLV-${String(created.data.id).padStart(4, "0")}`);
  assert.equal(smallDoc.data.lines.every((line: any) => "colour" in line), true, "lines expose colour when known");

  // Large: 70 recorded garment lines on one delivery (as a busy consignment
  // or a historical import would carry), with a matching colour variant.
  const large = await createOrder(owner.cookie, { quantity: 100 });
  const [delivery] = await db.insert(deliveries).values({
    orderId: large.orderId,
    deliveryDate: "2026-10-02",
    deliveredQuantity: 70,
    status: "PARTIAL",
  }).returning();
  await db.insert(orderItemSizes).values({ orderItemId: large.itemId, size: "M", color: "Navy", quantity: 70 });
  const lines = Array.from({ length: 70 }, (_, i) => ({
    deliveryId: delivery.id,
    orderItemId: large.itemId,
    description: `Uniform variant ${i + 1}`,
    size: i % 3 === 0 ? "M" : "L",
    quantity: 1,
  }));
  for (const line of lines) await db.insert(deliveryLines).values(line);
  const largeDoc = await api("GET", `/api/deliveries?deliveryId=${delivery.id}`, { cookie: owner.cookie });
  await expectStatus(largeDoc, 200, "load 70-line delivery sheet");
  assert.equal(largeDoc.data.lines.length, 70, "every line reaches the document");
  assert.equal(largeDoc.data.lines[0].colour, "Navy", "unambiguous (item, size) variants resolve to their colour");
  assert.equal(largeDoc.data.lines[1].colour, null, "ambiguous variants show no invented colour");
  // 70 lines paginate at the document's capacities: 18 first sheet + 28 each.
  const pages = chunkRows(largeDoc.data.lines, 18, 28);
  assert.equal(pages.flat().length, 70);
  assert.ok(pages.length >= 3, "70 rows span multiple printed sheets with repeated headers");
});

test("invoice: small and 70-line invoices with correct totals, payments and outstanding balance", async () => {
  const owner = await createOwner();

  // Small: one line, part-paid.
  const small = await createOrder(owner.cookie, { quantity: 10, unitPrice: 1000 }); // total 10,000
  const pay = await api("POST", "/api/payments", {
    cookie: owner.cookie,
    body: { orderId: small.orderId, amount: 4000, paymentDate: "2026-10-03", paymentMethod: "Bank Transfer", reference: "REF-1" },
  });
  await expectStatus(pay, 201, "record payment");
  const invoice = await api("GET", `/api/invoices?orderId=${small.orderId}`, { cookie: owner.cookie });
  await expectStatus(invoice, 200, "load small invoice");
  assert.equal(invoice.data.invoiceNo, `MTH-INV-${small.orderNumber}`);
  assert.equal(invoice.data.items.length, 1);
  assert.equal(invoice.data.order.itemsTotal, 10_000);
  assert.equal(invoice.data.order.adjustment, 0);
  assert.equal(invoice.data.order.totalAmount, 10_000);
  assert.equal(invoice.data.order.paidTotal, 4000);
  assert.equal(invoice.data.order.outstanding, 6000, "outstanding follows the existing order rules");

  // Large: 70 line items, two payments, and a recorded order adjustment.
  const large = await createOrder(owner.cookie, { quantity: 1, unitPrice: 500 });
  for (let i = 0; i < 70; i += 1)
    await db.insert(orderItems).values({ orderId: large.orderId, productId: large.productId, quantity: 1, unitPrice: 100, totalPrice: 100 });
  await expectStatus(await api("POST", "/api/payments", {
    cookie: owner.cookie,
    body: { orderId: large.orderId, amount: 2000, paymentDate: "2026-10-03", paymentMethod: "Cash" },
  }), 201, "payment 1");
  await expectStatus(await api("POST", "/api/payments", {
    cookie: owner.cookie,
    body: { orderId: large.orderId, amount: 3000, paymentDate: "2026-10-04", paymentMethod: "Bank Transfer" },
  }), 201, "payment 2");
  // The order total is recorded with a 500 discount against the 7,500 of lines.
  await db.update(orders).set({ totalAmount: 7500 - 500 }).where(eq(orders.id, large.orderId));

  const big = await api("GET", `/api/invoices?orderId=${large.orderId}`, { cookie: owner.cookie });
  await expectStatus(big, 200, "load 70-line invoice");
  assert.equal(big.data.items.length, 71, "every line item reaches the document (the created line plus 70)");
  assert.equal(big.data.order.itemsTotal, 500 + 70 * 100, "60+ line items total correctly (the created line plus 70)");
  assert.equal(big.data.order.totalAmount, 7000, "the recorded order total stays authoritative");
  assert.equal(big.data.order.adjustment, -500, "a recorded order adjustment is shown, not hidden");
  assert.equal(big.data.order.paidTotal, 5000);
  assert.equal(big.data.order.outstanding, 2000, "outstanding = order total less payments");
  assert.equal(big.data.payments.length, 2, "amounts paid carry their payment history");
  const pages = chunkRows(big.data.items, 18, 28);
  assert.ok(pages.length >= 3, "70 line items span multiple printed sheets with repeated headers");

  // Same permissions as the receipts it sits beside: Owner only.
  const pm = await createStaff(owner.cookie, { name: unique("PM"), role: "PRODUCTION_MANAGER" });
  await expectStatus(await api("GET", `/api/invoices?orderId=${small.orderId}`, { cookie: pm.cookie }), 403,
    "a Production Manager cannot open invoices");
  await expectStatus(await api("GET", `/api/invoices?orderId=${small.orderId}`), 401,
    "anonymous visitors cannot open invoices");
});
