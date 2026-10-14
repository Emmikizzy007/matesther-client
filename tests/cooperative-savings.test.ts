/**
 * WORKERS' COOPERATIVE SAVINGS.
 *
 * Contributions come from posted payroll lines (the existing ledger), paid
 * withdrawals and authorised adjustments are the other two append-only sides of
 * the same fund, and the balance is always computed — so the company-wide total
 * reconciles with the sum of individual balances by construction.
 *
 * Withdrawal workflow: request → review → approve/reject → record the actual
 * payment. A request or approval moves no money; only the recorded payment
 * reduces the fund. Insufficient balances, duplicate payments, concurrent
 * requests and self-approval are all refused on the backend.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { db } from "@/db";
import { sessions, workers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { api, createOwner, createStaff, createWorker, expectStatus } from "./support/harness";
import { currentMonth, shiftMonth } from "@/lib/payroll";

const suffix = () => `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
const previous = () => shiftMonth(currentMonth(), -1);

async function salary(owner: string, amount = 90_000) {
  const worker = await createWorker(owner, { name: `Coop Member ${suffix()}`, specialty: "Office Staff", paymentType: "MONTHLY", paymentRate: amount, department: "Operations" });
  await db.update(workers).set({ createdAt: new Date(`${previous()}-01T00:00:00Z`) }).where(eq(workers.id, worker.id));
  return worker;
}

async function contribute(owner: string, workerId: number, amount: number, options: { frequencyMonths?: number; startMonth?: string } = {}) {
  const startMonth = options.startMonth ?? previous();
  const created = await api("POST", "/api/payroll-deductions", { cookie: owner, body: {
    workerId, categoryCode: "COOPERATIVE", amount, startMonth,
    frequencyMonths: options.frequencyMonths ?? 0,
    ...(startMonth < currentMonth() ? { lateReason: "Agreed before closing last month's payroll" } : {}),
  } });
  const [row] = (await expectStatus(created, 201, "Cooperative contribution")).created;
  await expectStatus(await api("PUT", "/api/payroll-deductions", { cookie: owner,
    body: { id: row.id, action: "APPROVE", reason: "Reviewed voluntary savings arrangement" } }), 200, "Approve");
  return row;
}

async function postMonth(owner: string, workerId: number, month: string) {
  return expectStatus(await api("POST", "/api/payroll-deductions/post", { cookie: owner,
    body: { workerId, month } }), 201, `Post ${month}`);
}

test("contributions for different workers build separate balances that reconcile company-wide", async () => {
  const owner = await createOwner();
  const w1 = await salary(owner.cookie, 90_000);
  const w2 = await salary(owner.cookie, 60_000);
  await contribute(owner.cookie, w1.id, 10_000);
  await contribute(owner.cookie, w2.id, 4_000);
  await postMonth(owner.cookie, w1.id, previous());
  await postMonth(owner.cookie, w2.id, previous());
  const m1 = await api("GET", `/api/payroll-deductions/cooperative?workerId=${w1.id}`, { cookie: owner.cookie });
  await expectStatus(m1, 200, "Member ledger");
  assert.equal(m1.data.balance, 10_000);
  assert.equal(m1.data.contributions, 10_000);
  assert.equal(m1.data.transactions.length, 1);
  assert.equal(m1.data.transactions[0].line.cooperativeCredit, 10_000);
  assert.equal(m1.data.transactions[0].balanceAfter, 10_000, "Each transaction shows the remaining balance");
  const members = await api("GET", "/api/payroll-deductions/cooperative?view=members", { cookie: owner.cookie });
  await expectStatus(members, 200, "Members view");
  assert.equal(members.data.participating, 2);
  assert.equal(members.data.totalHeld, 14_000, "Company total is the sum of the balances, not a guess");
  const sum = members.data.rows.reduce((t: number, r: any) => t + r.balance, 0);
  assert.equal(sum, members.data.totalHeld, "Company-wide total reconciles with individual balances");
  const mine = members.data.rows.find((r: any) => r.workerId === w2.id);
  assert.equal(mine.contributions, 4_000);
  assert.equal(mine.withdrawals, 0);
  assert.equal(mine.balance, 4_000);
  // Company total reconciles with the sum of the two member balances it shows
  // (this file's first test owns the whole members list at this point).
  assert.equal(members.data.rows.reduce((t: number, r: any) => t + r.balance, 0), members.data.totalHeld);
  // Search by name and by ID.
  const byName = await api("GET", `/api/payroll-deductions/cooperative?view=members&search=${encodeURIComponent(w1.name.slice(0, 12))}`, { cookie: owner.cookie });
  assert.equal(byName.data.rows.some((r: any) => r.workerId === w1.id), true);
  const byId = await api("GET", `/api/payroll-deductions/cooperative?view=members&search=${w2.id}`, { cookie: owner.cookie });
  assert.equal(byId.data.rows.some((r: any) => r.workerId === w2.id), true, "Search by worker ID finds the member");
});

test("recurring monthly contributions and refunds stay a single consistent ledger", async () => {
  const owner = await createOwner();
  const reviewer = await createStaff(owner.cookie, { name: `Coop Refund Reviewer ${suffix()}`, role: "OWNER" });
  const worker = await salary(owner.cookie, 90_000);
  await contribute(owner.cookie, worker.id, 3_000, { frequencyMonths: 1 });
  await postMonth(owner.cookie, worker.id, previous());
  let member = await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker.id}`, { cookie: owner.cookie });
  assert.equal(member.data.balance, 3_000);
  // The recurring contribution applies again next month — exactly once.
  const next = await api("GET", `/api/payroll?month=${currentMonth()}&workerId=${worker.id}`, { cookie: owner.cookie });
  const entry = next.data.history.find((h: any) => h.month === currentMonth());
  assert.equal(entry.deductionItems.length, 1);
  assert.equal(entry.deductionItems[0].amount, 3_000);
  // Close the open month on the isolated test clock only, then post it: two
  // months must produce exactly two credits. Session validity is explicitly
  // extended in pg-mem; never touches production or inserts fake financial data.
  const closingMonth = currentMonth();
  await db.update(sessions).set({ expiresAt: new Date(`${shiftMonth(closingMonth, 3)}-01T00:00:00Z`) });
  mock.timers.enable({ apis: ["Date"], now: new Date(`${shiftMonth(closingMonth, 1)}-01T00:00:00Z`) });
  try {
    await postMonth(owner.cookie, worker.id, closingMonth);
  } finally { mock.timers.reset(); }
  member = await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker.id}`, { cookie: owner.cookie });
  assert.equal(member.data.balance, 6_000, "Two closed months, two credits — never three");
  assert.equal(member.data.transactions.length, 2);
  // An independently approved refund is a negative ledger entry, not a rewrite.
  const line = member.data.transactions.find((t: any) => t.periodMonth === previous()).line;
  const refund = await api("POST", "/api/payroll-deductions/reversals", { cookie: owner.cookie, body: {
    sourceLineId: line.id, targetMonth: shiftMonth(currentMonth(), 1), reason: "Worker withdrew consent for the earlier contribution",
  } });
  await expectStatus(refund, 201, "Refund request");
  await expectStatus(await api("PUT", "/api/payroll-deductions/reversals", { cookie: reviewer.cookie, body: {
    id: refund.data.id, action: "APPROVE", reason: "Independently verified the signed withdrawal of consent",
  } }), 200, "Independent approval");
  assert.equal((await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker.id}`, { cookie: owner.cookie })).data.balance, 6_000,
    "A pending refund is not yet money returned");
});

test("withdrawals walk request → review → payment and only a recorded payment reduces the fund", async () => {
  const owner = await createOwner();
  const reviewer = await createStaff(owner.cookie, { name: `Withdrawal Reviewer ${suffix()}`, role: "OWNER" });
  const worker = await salary(owner.cookie, 90_000);
  await contribute(owner.cookie, worker.id, 10_000);
  await postMonth(owner.cookie, worker.id, previous());

  const request = await api("POST", "/api/payroll-deductions/cooperative/withdrawals", { cookie: owner.cookie, body: {
    workerId: worker.id, amount: 4_000, reason: "Urgent family medical need",
  } });
  const asked = await expectStatus(request, 201, "Withdrawal request");
  assert.equal(asked.status, "REQUESTED");
  let member = await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker.id}`, { cookie: owner.cookie });
  assert.equal(member.data.balance, 10_000, "A request must not reduce the savings balance");
  assert.equal(member.data.pending, 4_000);

  // Separation of duties: the requester cannot approve their own request.
  assert.equal((await api("PUT", "/api/payroll-deductions/cooperative/withdrawals", { cookie: owner.cookie, body: {
    id: asked.id, action: "APPROVE", reason: "Self approval attempt on my own request",
  } })).status, 403);
  await expectStatus(await api("PUT", "/api/payroll-deductions/cooperative/withdrawals", { cookie: reviewer.cookie, body: {
    id: asked.id, action: "APPROVE", reason: "Verified the member's request against the fund",
  } }), 200, "Approve");
  member = await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker.id}`, { cookie: owner.cookie });
  assert.equal(member.data.balance, 10_000, "Approval still moves no money");
  assert.equal(member.data.reserved, 4_000);

  const paid = await api("PUT", "/api/payroll-deductions/cooperative/withdrawals", { cookie: reviewer.cookie, body: {
    id: asked.id, action: "RECORD_PAYMENT", paymentMethod: "Bank Transfer",
    paymentReference: `BNK-${suffix()}`, paymentNotes: "Paid at the branch",
  } });
  await expectStatus(paid, 200, "Record the completed payment");
  assert.equal(paid.data.status, "PAID");
  assert.ok(paid.data.paidOn);
  member = await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker.id}`, { cookie: owner.cookie });
  assert.equal(member.data.balance, 6_000, "Only the completed payment reduced the fund");
  assert.equal(member.data.withdrawals, 4_000);
  const movement = member.data.transactions.find((t: any) => t.kind === "WITHDRAWAL");
  assert.equal(movement.amount, -4_000);
  assert.equal(movement.balanceAfter, 6_000);
  assert.equal(movement.line.cooperativeCredit, -4_000, "History carries the signed movement");
  // Duplicate payment attempts are refused.
  assert.equal((await api("PUT", "/api/payroll-deductions/cooperative/withdrawals", { cookie: reviewer.cookie, body: {
    id: asked.id, action: "RECORD_PAYMENT", paymentMethod: "Bank Transfer",
  } })).status, 409, "A withdrawal is paid once and only once");
  assert.equal((await api("PUT", "/api/payroll-deductions/cooperative/withdrawals", { cookie: reviewer.cookie, body: {
    id: asked.id + 999_999, action: "RECORD_PAYMENT",
  } })).status, 404);
});

test("a rejected or cancelled request is never money paid and never reduces the balance", async () => {
  const owner = await createOwner();
  const reviewer = await createStaff(owner.cookie, { name: `Rejecting Reviewer ${suffix()}`, role: "OWNER" });
  const worker = await salary(owner.cookie, 90_000);
  await contribute(owner.cookie, worker.id, 5_000);
  await postMonth(owner.cookie, worker.id, previous());
  const asked = await expectStatus(await api("POST", "/api/payroll-deductions/cooperative/withdrawals", { cookie: owner.cookie, body: {
    workerId: worker.id, amount: 2_000, reason: "Request that will be rejected after review",
  } }), 201, "Request");
  await expectStatus(await api("PUT", "/api/payroll-deductions/cooperative/withdrawals", { cookie: reviewer.cookie, body: {
    id: asked.id, action: "REJECT", reason: "Fund policy does not cover this purpose",
  } }), 200, "Reject");
  const rejected = await api("PUT", "/api/payroll-deductions/cooperative/withdrawals", { cookie: reviewer.cookie, body: {
    id: asked.id, action: "RECORD_PAYMENT", paymentMethod: "Cash",
  } });
  assert.equal(rejected.status, 409, "A rejected request must never be recorded as money paid");
  const member = await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker.id}`, { cookie: owner.cookie });
  assert.equal(member.data.balance, 5_000);
  assert.equal(member.data.withdrawals, 0);
  // A cancelled request likewise leaves the fund untouched.
  const asked2 = await expectStatus(await api("POST", "/api/payroll-deductions/cooperative/withdrawals", { cookie: owner.cookie, body: {
    workerId: worker.id, amount: 1_000, reason: "Request the member later cancels",
  } }), 201, "Second request");
  await expectStatus(await api("PUT", "/api/payroll-deductions/cooperative/withdrawals", { cookie: owner.cookie, body: {
    id: asked2.id, action: "CANCEL", reason: "Member withdrew the request",
  } }), 200, "Cancel");
  assert.equal((await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker.id}`, { cookie: owner.cookie })).data.balance, 5_000);
});

test("withdrawals cannot exceed the available balance, and concurrent requests cannot overdraw the fund", async () => {
  const owner = await createOwner();
  const reviewer = await createStaff(owner.cookie, { name: `Balance Reviewer ${suffix()}`, role: "OWNER" });
  const worker = await salary(owner.cookie, 90_000);
  await contribute(owner.cookie, worker.id, 5_000);
  await postMonth(owner.cookie, worker.id, previous());
  assert.equal((await api("POST", "/api/payroll-deductions/cooperative/withdrawals", { cookie: owner.cookie, body: {
    workerId: worker.id, amount: 5_001, reason: "Trying to withdraw more than saved",
  } })).status, 409, "Over-balance requests are refused");
  assert.equal((await api("POST", "/api/payroll-deductions/cooperative/withdrawals", { cookie: owner.cookie, body: {
    workerId: worker.id, amount: 3_000, reason: "First half of the fund",
  } })).status, 201);
  assert.equal((await api("POST", "/api/payroll-deductions/cooperative/withdrawals", { cookie: owner.cookie, body: {
    workerId: worker.id, amount: 2_001, reason: "More than the remainder",
  } })).status, 409, "A second request can only claim what remains available");
  // Two concurrent full-remainder requests. pg-mem cannot PROVE PostgreSQL's
  // row-lock serialisation (documented suite limitation), so creation may race;
  // what must hold under ANY interleaving is that the fund is never overdrawn:
  // while two requests reserve the same naira, NEITHER can be approved or paid.
  const worker2 = await salary(owner.cookie, 90_000);
  await contribute(owner.cookie, worker2.id, 5_000);
  await postMonth(owner.cookie, worker2.id, previous());
  const [first, second] = await Promise.all([
    api("POST", "/api/payroll-deductions/cooperative/withdrawals", { cookie: owner.cookie, body: {
      workerId: worker2.id, amount: 5_000, reason: `Concurrent request A ${suffix()}` } }),
    api("POST", "/api/payroll-deductions/cooperative/withdrawals", { cookie: owner.cookie, body: {
      workerId: worker2.id, amount: 5_000, reason: `Concurrent request B ${suffix()}` } }),
  ]);
  assert.ok([first.status, second.status].includes(201), "At least one request is created");
  const outstanding = await api("GET", `/api/payroll-deductions/cooperative/withdrawals?workerId=${worker2.id}`, { cookie: owner.cookie });
  const open = outstanding.data.rows.filter((r: any) => ["REQUESTED", "APPROVED"].includes(r.withdrawal.status));
  assert.ok(open.length >= 1 && open.length <= 2, "The race leaves at most the two requests it created");
  for (const request of open) {
    // Whichever the race produced, approval while the sibling reserves the same
    // money must fail; only ONE of them can ever be approved and paid.
    const decision = await api("PUT", "/api/payroll-deductions/cooperative/withdrawals", { cookie: reviewer.cookie, body: {
      id: request.withdrawal.id, action: "APPROVE", reason: "Attempting to approve the concurrent request",
    } });
    assert.ok([200, 409].includes(decision.status), "Approval is either granted or refused on available funds");
  }
  const approved = await api("GET", `/api/payroll-deductions/cooperative/withdrawals?workerId=${worker2.id}&status=APPROVED`, { cookie: owner.cookie });
  assert.ok(approved.data.rows.length <= 1, "Never two approved draws on the same ₦5,000");
  // Keep exactly one claim, cancel any duplicate still open, then the survivor
  // is payable exactly once — the fund can never be pushed below zero.
  const requestList = await api("GET", `/api/payroll-deductions/cooperative/withdrawals?workerId=${worker2.id}`, { cookie: owner.cookie });
  const stillOpen = requestList.data.rows.filter((r: any) => ["REQUESTED", "APPROVED"].includes(r.withdrawal.status));
  const survivor = stillOpen.find((r: any) => r.withdrawal.status === "APPROVED") ?? stillOpen[0];
  for (const request of stillOpen) {
    if (request.withdrawal.id !== (survivor && survivor.withdrawal.id))
      await api("PUT", "/api/payroll-deductions/cooperative/withdrawals", { cookie: reviewer.cookie, body: {
        id: request.withdrawal.id, action: "CANCEL", reason: "Cancelling the duplicate concurrent request",
      } });
  }
  if (survivor) {
    if (survivor.withdrawal.status === "REQUESTED")
      await expectStatus(await api("PUT", "/api/payroll-deductions/cooperative/withdrawals", { cookie: reviewer.cookie, body: {
        id: survivor.withdrawal.id, action: "APPROVE", reason: "Verified against the available fund",
      } }), 200, "Approve the surviving request");
    await expectStatus(await api("PUT", "/api/payroll-deductions/cooperative/withdrawals", { cookie: reviewer.cookie, body: {
      id: survivor.withdrawal.id, action: "RECORD_PAYMENT", paymentMethod: "Cash",
    } }), 200, "Pay the surviving request");
    assert.equal((await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker2.id}`, { cookie: owner.cookie })).data.balance, 0);
    assert.equal((await api("POST", "/api/payroll-deductions/cooperative/withdrawals", { cookie: owner.cookie, body: {
      workerId: worker2.id, amount: 1, reason: "Nothing left in the fund",
    } })).status, 409, "No further withdrawal on an empty fund");
  }
  // And the sequential reservation rule still holds on the first worker: an
  // approved but unpaid request reserves its share of the balance.
  const list1 = await api("GET", `/api/payroll-deductions/cooperative/withdrawals?workerId=${worker.id}&status=REQUESTED`, { cookie: owner.cookie });
  const pending1 = list1.data.rows[0].withdrawal;
  await expectStatus(await api("PUT", "/api/payroll-deductions/cooperative/withdrawals", { cookie: reviewer.cookie, body: {
    id: pending1.id, action: "APPROVE", reason: "Verified against the available fund",
  } }), 200, "Approve");
  assert.equal((await api("POST", "/api/payroll-deductions/cooperative/withdrawals", { cookie: owner.cookie, body: {
    workerId: worker.id, amount: 2_001, reason: "More than the unreserved remainder",
  } })).status, 409, "An approved but unpaid request reserves the balance");
});

test("authorised adjustments change the fund only after independent approval, and stay auditable", async () => {
  const owner = await createOwner();
  const reviewer = await createStaff(owner.cookie, { name: `Adjustment Reviewer ${suffix()}`, role: "OWNER" });
  const worker = await salary(owner.cookie, 90_000);
  await contribute(owner.cookie, worker.id, 5_000);
  await postMonth(owner.cookie, worker.id, previous());
  const adjustment = await api("POST", "/api/payroll-deductions/cooperative/adjustments", { cookie: owner.cookie, body: {
    workerId: worker.id, amount: -250, reason: "Bank charges on the fund account",
    reference: `CHG-${suffix()}`,
  } });
  const row = await expectStatus(adjustment, 201, "Adjustment proposal");
  assert.equal((await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker.id}`, { cookie: owner.cookie })).data.balance, 5_000,
    "A pending adjustment changes nothing");
  assert.equal((await api("PUT", "/api/payroll-deductions/cooperative/adjustments", { cookie: owner.cookie, body: {
    id: row.id, action: "APPROVE", reason: "Self approval attempt",
  } })).status, 403, "The creator cannot approve their own adjustment");
  await expectStatus(await api("PUT", "/api/payroll-deductions/cooperative/adjustments", { cookie: reviewer.cookie, body: {
    id: row.id, action: "APPROVE", reason: "Checked the bank statement and the fund rules",
  } }), 200, "Independent approval");
  const member = await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker.id}`, { cookie: owner.cookie });
  assert.equal(member.data.balance, 4_750);
  assert.equal(member.data.adjustments, -250);
  const trail = await api("GET", `/api/payroll-deductions?view=audit&entityType=COOP_ADJUSTMENT&entityId=${row.id}`, { cookie: owner.cookie });
  assert.deepEqual(trail.data.rows.map((r: any) => r.action), ["APPROVE", "CREATE"], "Full decision trail is preserved");
});

test("the Worker Payments dashboard lets each authorised user choose cards, including Cooperative Savings", async () => {
  const owner = await createOwner();
  const other = await createStaff(owner.cookie, { name: `Other Dashboard User ${suffix()}`, role: "OWNER" });
  const manager = await createStaff(owner.cookie, { name: `No Cards ${suffix()}`, role: "PRODUCTION_MANAGER" });
  const defaults = await api("GET", "/api/dashboard-cards", { cookie: owner.cookie });
  await expectStatus(defaults, 200, "Card preferences");
  const coopCard = defaults.data.cards.find((c: any) => c.key === "cooperative-savings");
  assert.ok(coopCard, "A selectable Cooperative Savings card exists");
  assert.equal(coopCard.label, "Cooperative Savings");
  assert.equal(coopCard.visible, true, "Shown by default and individually hideable");
  // Hide two cards for THIS user only.
  const saved = await api("PUT", "/api/dashboard-cards", { cookie: owner.cookie, body: {
    cards: [
      { key: "piecework-share", visible: false },
      { key: "cooperative-savings", visible: true },
    ],
  } });
  await expectStatus(saved, 200, "Save card selection");
  assert.equal(saved.data.cards.find((c: any) => c.key === "piecework-share").visible, false);
  assert.equal(saved.data.cards.find((c: any) => c.key === "cooperative-savings").visible, true);
  const mine = await api("GET", "/api/dashboard-cards", { cookie: owner.cookie });
  assert.equal(mine.data.cards.find((c: any) => c.key === "piecework-share").visible, false, "Selection is remembered");
  const theirs = await api("GET", "/api/dashboard-cards", { cookie: other.cookie });
  assert.equal(theirs.data.cards.find((c: any) => c.key === "piecework-share").visible, true,
    "Another user keeps their own selection");
  assert.equal((await api("PUT", "/api/dashboard-cards", { cookie: owner.cookie, body: {
    cards: [{ key: "made-up-card", visible: false }],
  } })).status, 400, "Unknown card keys are refused");
  assert.equal((await api("GET", "/api/dashboard-cards", { cookie: manager.cookie })).status, 403,
    "Financial dashboard preferences are Owner-only");
  assert.equal((await api("GET", "/api/dashboard-cards")).status, 401);
});

test("cooperative reads and writes are Owner-only and scoped to the organisation", async () => {
  const owner = await createOwner();
  const manager = await createStaff(owner.cookie, { name: `Coop Guard ${suffix()}`, role: "PRODUCTION_MANAGER" });
  const worker = await salary(owner.cookie);
  const login = await createStaff(owner.cookie, { name: worker.name, role: "WORKER" });
  const paths = [
    "/api/payroll-deductions/cooperative?workerId=1",
    "/api/payroll-deductions/cooperative?view=members",
    "/api/payroll-deductions/cooperative/withdrawals",
    "/api/payroll-deductions/cooperative/adjustments",
  ];
  for (const path of paths) {
    assert.equal((await api("GET", path)).status, 401, `No session: ${path}`);
    assert.equal((await api("GET", path, { cookie: manager.cookie })).status, 403, `No manager: ${path}`);
    assert.equal((await api("GET", path, { cookie: login.cookie })).status, 403, `No worker: ${path}`);
  }
  assert.equal((await api("POST", "/api/payroll-deductions/cooperative/withdrawals", { cookie: manager.cookie, body: {
    workerId: worker.id, amount: 100, reason: "Forge privilege",
  } })).status, 403);
  assert.equal((await api("POST", "/api/payroll-deductions/cooperative/adjustments", { cookie: login.cookie, body: {
    workerId: worker.id, amount: 100, reason: "Forge privilege",
  } })).status, 403);
  // Org scoping: another company's worker is never visible here.
  assert.equal((await api("GET", `/api/payroll-deductions/cooperative?workerId=${999_999}`, { cookie: owner.cookie })).status, 404);
  assert.equal((await api("POST", "/api/payroll-deductions/cooperative/withdrawals", { cookie: owner.cookie, body: {
    workerId: 999_999, amount: 100, reason: "Foreign worker probe",
  } })).status, 404);
});

test("two paid withdrawals survive a payroll month close without corrupting the ledger", async () => {
  const owner = await createOwner();
  const reviewer = await createStaff(owner.cookie, { name: `Ledger Reviewer ${suffix()}`, role: "OWNER" });
  const worker = await salary(owner.cookie, 90_000);
  await contribute(owner.cookie, worker.id, 10_000);
  await postMonth(owner.cookie, worker.id, previous());
  for (const [index, amount] of [2_000, 1_500].entries()) {
    const asked = await expectStatus(await api("POST", "/api/payroll-deductions/cooperative/withdrawals", { cookie: owner.cookie, body: {
      workerId: worker.id, amount, reason: `Urgent personal need number ${index + 1}`,
    } }), 201, "Request");
    await expectStatus(await api("PUT", "/api/payroll-deductions/cooperative/withdrawals", { cookie: reviewer.cookie, body: {
      id: asked.id, action: "APPROVE", reason: "Verified against the fund rules",
    } }), 200, "Approve");
    await expectStatus(await api("PUT", "/api/payroll-deductions/cooperative/withdrawals", { cookie: reviewer.cookie, body: {
      id: asked.id, action: "RECORD_PAYMENT", paymentMethod: "Cash", paymentReference: `CASH-${index}-${suffix()}`,
    } }), 200, "Record payment");
  }
  const member = await api("GET", `/api/payroll-deductions/cooperative?workerId=${worker.id}`, { cookie: owner.cookie });
  assert.equal(member.data.balance, 6_500, "10,000 saved − 3,500 paid out");
  assert.equal(member.data.withdrawals, 3_500);
  assert.equal(member.data.contributions, 10_000);
  assert.equal(member.data.balance, member.data.contributions - member.data.withdrawals + member.data.adjustments,
    "Balance is derived from the ledger sides, never stored");
  assert.equal(member.data.transactions.length, 3);
  // The members view agrees with the individual ledger.
  const members = await api("GET", "/api/payroll-deductions/cooperative?view=members", { cookie: owner.cookie });
  const row = members.data.rows.find((r: any) => r.workerId === worker.id);
  assert.equal(row.balance, 6_500);
  // All tests in this file share the harness's single organisation, so the
  // company-wide total holds every member created so far; the invariant is that
  // it reconciles with the same ledger sides and with the full member list.
  assert.equal(members.data.totalHeld,
    members.data.totalContributions - members.data.totalWithdrawals + members.data.totalAdjustments,
    "The company total is derived from the same ledger sides as every member balance");
  const full = await api("GET", "/api/payroll-deductions/cooperative?view=members&limit=100", { cookie: owner.cookie });
  if (full.data.rows.length === full.data.total) {
    assert.equal(full.data.totalHeld, full.data.rows.reduce((t: number, r: any) => t + r.balance, 0),
      "Company total reconciles with the sum of member balances");
  }
  const list = await api("GET", `/api/payroll-deductions/cooperative/withdrawals?workerId=${worker.id}`, { cookie: owner.cookie });
  assert.equal(list.data.total, 2);
  assert.equal(list.data.rows.every((r: any) => r.withdrawal.status === "PAID"), true);
  assert.equal(list.data.totals.balance, 6_500);
});
