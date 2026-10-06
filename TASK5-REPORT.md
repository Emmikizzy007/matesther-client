# Task 5 — ERP operational completion, integration and control

Task 5 was an audit-first task: read what exists, do not duplicate it, and close the gaps that
stop the ERP being operated reliably day to day. Everything below was verified against the code
before it was changed. Nothing was rebuilt, no system was replaced, and no new competing
concept was introduced.

---

## Verification numbers

| Gate | Command | Result |
| --- | --- | --- |
| Tests | `npm test` | **278 pass, 0 fail, 0 skipped** (252 at the start of this run: +7 returned-material, +7 stock integrity, +8 lifecycle/attention/profit, +11 final hardening) |
| Types | `npx tsc --noEmit --incremental false` | **clean**, no output |
| Build | `DATABASE_URL=… npm run build` | **succeeds**; `/api/attention` in the route manifest |
| Lint | `npm run lint` | **33 problems (29 errors, 4 warnings)** — unchanged from the Task 4 baseline, so **zero new lint problems**. All pre-existing; 11 are `react-hooks/set-state-in-effect`, the repository's existing pattern on working pages |
| Schema drift | `npx drizzle-kit generate --name drift_probe` | **"No schema changes, nothing to migrate"** — zero drift, no file created |
| Migrations | journal + `drizzle/*.sql` | **11 entries**, 11 `.sql`, 11 snapshots, last `0010_actor_audit`. All 11 apply in order on a fresh database — the test preload runs them and fails loudly if a column is missing, so 278 passing tests is that verification |
| Deploy SQL | `deploy/upgrade-actor-audit.sql` | 6 `ADD COLUMN IF NOT EXISTS`, 3 guarded `ADD CONSTRAINT`; **0** destructive statements, **0** data writes, **0** backfill |
| Deploy SQL | `deploy/*.sql` | unchanged; **0** destructive statements added |

**One additive migration was created, in the final hardening pass**: `0010_actor_audit`, six
nullable columns and three foreign keys, with no `NOT NULL`, no default, no data write and no
backfill. Everything before that pass was schema-free. **No production data was touched, nothing
was seeded, no applied migration was re-run, and no destructive SQL exists anywhere in this run.**

---

## Part A — the two Task 4 decisions, implemented

Both were reported at the end of Task 4 as pre-existing and left for a decision. Both are now
enforced server-side, with seven regression tests.

### A1. Ready-made never enters raw-material stock

`POST /api/material-purchases` did `current_stock += quantity` unconditionally, so a garment
catalogued as *Ready-made garment* and bought through the general screen entered raw-material
inventory — where it could be issued to a job as though it were cloth, making the same garment
both stock and a finished purchase.

**The fix reuses the existing classification rather than inventing one.** `isReadyMadeMaterial()`
now sits in `src/lib/format.ts` beside the `READY_MADE_CATEGORY` constant it tests, and is
compared *exactly*, because that is how the costing SQL compares it — a looser match would
exempt an item from stock while costing still treated it as a raw material.

Three things made this a clear-cut fix rather than a judgement call:

- `POST /api/ready-made` — the designated flow — writes its purchases into **this same table**
  and has **never** touched `current_stock`. The general screen was the one path that did, so
  the fix makes the two agree.
- `order-cost.ts` already classifies `material_purchases` in that category as `readyMade`, so
  **refusing** these purchases would have deleted a cost line the profitability formula
  expects. The purchase is still recorded with its own cost; only the stock write and the
  catalogue unit-cost write are skipped, exactly matching the dedicated flow.
- The exemption holds in **both** directions: issuing a ready-made garment through
  `/api/material-usage` moves no stock, and returning one does not conjure finished goods onto
  a shelf that never held them.

Also fixed on the same path: the material is now read **before** the purchase is written. A
purchase against a material that did not exist used to be inserted as an orphan row (the lookup
happened afterwards and `if (mat)` simply skipped the stock update). It is now a 404 with
nothing written.

### A2. Raw-material stock cannot go negative

`POST /api/material-usage` never compared what was asked for against what was on the shelf
(neither did the base commit `b5c6ce8`). The net-out figure is now computed **before** the
insert and checked against the shelf, so an issue that cannot be met is **refused whole** — no
partial issue, no silent clamping to what happens to be left. A short shelf means either a
purchase not yet recorded or a stock figure that is wrong, and quietly issuing less would hide
which one — and would understate the job's cost, since the record is what the order is charged
from.

`PUT /api/material-usage` can only ever put material **back** (a recorded return cannot be
un-recorded, and that route never rewrites the issued figure), so it cannot draw the shelf down.
That is now **asserted rather than assumed**: an edit whose net-out would grow is refused and the
material has to be issued properly, through `POST`, where the shelf is counted. This is what
makes "stock cannot go negative" true of both routes rather than of one.

All returned-material behaviour from Task 4 is unchanged and still tested: returned unused
increases stock, wasted stays consumed and never returns to the shelf, returned material is not
charged as consumed cost, a return cannot be un-recorded, a return needs its own reason and
leaves a dated, attributed trail, and records written before issue tracking still mean and cost
exactly what they did.

**One existing fixture was corrected, not the guard.** The nine-cost-categories test catalogued
fabric with `currentStock: 0` and then issued ten yards, which could only ever pass by drawing
down an empty shelf. It now stocks ten and asserts the same costs.

---

## Part B — Task 5

### 5.1 / 5.3 — One derived order lifecycle, and delivery control

**`orderFulfilment(orderId)`** (`src/lib/production-control.ts`) answers, for one order and from
the ledger alone: ordered, released to production, in production, approved, remaining, assigned,
awaiting inspection, rework, rejected, packed, delivered, ready for delivery, undelivered, and
whether the order is genuinely complete.

`approved` is the same figure the control board shows, summed by the same `rollUpByOrder`, so the
order page, the board and the two guards below **cannot disagree** about how much of an order
actually exists. Nothing in it can be typed in by hand. Exposed as `fulfilment` on
`GET /api/orders/[id]`.

**`complete` is derived, and it is returned beside `statusSaysComplete`** — plus
`statusMatchesProduction` — so an order whose status was set by hand without the production to
back it is *visible* rather than trusted. `PUT /api/orders/[id]` does accept a free `status`, so
this is not hypothetical: a test marks a 100-piece order COMPLETED with 40 pieces unmade and
asserts the two figures are reported as disagreeing, not reconciled silently.

**Packing and delivery were the real integration gap.**

- `POST /api/packing` accepted **any positive number against any order id** — an order of ten
  could be packed as five hundred, and it did not even check the order existed.
- `POST /api/deliveries` was bounded only by what was **ordered**, which is a ceiling on the
  contract, not on the factory: a hundred garments could be delivered in full with sixty
  approved and forty that never existed.

Both now take their ceiling from the same `orderFulfilment`, so neither can run ahead of approved
production. **An order that has never entered production keeps the ordered ceiling it has always
had**, so a historical order, or one satisfied entirely off the floor, does not suddenly become
impossible to pack or deliver; nothing already recorded is touched. That conditional is the one
conservative judgement call in this section and is stated here rather than buried.

Verified working, not just guarded: partial production (60 of 100 approved), a stage submitted
and left unjudged, rework, multiple stages on a frozen route, and an exact size/colour variant
staying distinct — all already covered by `production-control.test.ts`,
`route-driven-production.test.ts` and `split-allocation.test.ts`, which all still pass unchanged.

### 5.2 — Management production control

Audited against the required list and **already complete from Task 4**: school/customer, order,
garment, exact variant, ordered, approved, remaining, current stage, assigned workers (named),
submitted, awaiting inspection, rework, rejected, bottleneck, overdue/due status and a six-rank
priority — all derived, all server-side, all paginated with `X-Total-Count`, no money key at any
depth, and no POST/PUT/PATCH/DELETE on the route so no quantity can be written through it.
Nothing was duplicated and nothing needed replacing. The only addition is that the board is now
also where the sidebar's attention badge links to.

### 5.4 — Inventory and material control

Covered by Part A (stock cannot go negative, ready-made stays out, returns are auditable and
bounded, wastage stays consumed). Management visibility already existed: the reports screen's
materials section reports purchased, used, stock and stock value per material, and is tested to
read the material system's own figure rather than recomputing it. Order costing reads
`material_usage.total_cost`, so material cost is based on actual consumed quantity and cannot
double-count, and `GET /api/material-purchases` is now paged (below).

### 5.5 — Payroll and commission integrity

The deduction model was established in Task 4 and is asserted by existing tests to agree across
payroll, order profitability and the reports screen. One gap was closed: **`/api/payment-sheet`
has returned `notListed` since Task 4 and nothing rendered it**, so a printed sheet could total
less than the payroll screen with no explanation on the page. The sheet now states how many
workers it leaves out and the support deduction carried forward against their later piece-rate
earnings — which *is* the difference between the two figures.

### 5.6 — Profitability consistency: the home screen was computing its own

**This was the most serious financial defect found in Task 5.** `GET /api/dashboard` calculated
profit as `revenue − (expenses + material usage)` — the pre-Task-4 formula, still living in one
route after Task 4 had established the authoritative one everywhere else. It counted **no labour
at all**: no tailor commission, no support pay, no machine work, no vendor bill, no ready-made
purchase. On the home screen — the most-read money figure in the business — it reported as
profit most of what the company actually pays out, and it mixed costs belonging to an order with
costs belonging to the business, so it could not be reconciled against either the order page or
the reports screen.

It now calls `src/lib/order-cost.ts`, the single implementation, and reports unattributable
business costs **beside** order profit rather than merged into it — the same separation the
reports screen keeps, so an order's margin is never read as the whole business's margin. The old
figure is returned as `legacy` and rendered on the card as "previously reported", the convention
Task 4 established, so the restatement is visible rather than silent. The card is no longer
labelled "Est. Profit" and turns red when profit is negative. The costing runs **below** the
Project Manager early-return: a PM never sees company financials, so a PM request must not pay
for them either (asserted by the two existing PM tests, which pass unchanged).

A new test pins the requirement that one business rule must not have different implementations
on different screens: dashboard profit and cost **equal** the reports screen's totals for the
same book, the card reconciles against its own revenue, the dashboard's gap between the two
formulas equals the sum of the per-order gaps the reports screen shows, and on an order with no
expenses that gap is exactly the labour and external cost the legacy formula omitted.

### 5.7 — Authorization and security audit

Every route was inventoried: 43 route files, their exported methods and their guard level.
Findings:

- **`POST /api/payroll` took `paidBy` from the request body** — the only actor in the entire API
  not derived from the session. The payroll screen sent `user?.name`, so an honest client wrote
  the truth and any other caller could write anyone, or nobody, into the payroll history: a
  forgeable audit trail on the one record where "who paid this person" *is* the whole audit, and
  a security-sensitive value decided in the frontend. `inspections.inspectedBy`, support
  approvals and `production-corrections` all already derive their actor server-side; payroll now
  matches them. The column and the honest client's value are unchanged. **A test sends a forged
  `paidBy` and asserts it is not believed.**
- `POST /api/packing` did not verify the order existed (now a 404, nothing written).
- **Verified sound, not changed:** `auth/setup` requires a private setup key *and* refuses once
  any user exists, so the first owner account cannot be claimed later; `GET /api/allocations`
  scopes a Worker to their own shares and cannot be widened by omitting `workerId`, by naming
  somebody else, or by using the `operationId` path (the Task 4 leak, still closed);
  `PUT /api/operations` refuses a submitter who is not the stage's own worker and refuses
  `submitQty: 0`; `POST /api/inspections` refuses self-inspection including on split stages, and
  refuses to approve more than is awaiting inspection; `PUT /api/support-work` refuses a support
  worker approving their own work; `POST /api/production-corrections` refuses a worker correcting
  their own job; `PUT /api/allocations` (transfer) is STAFF-only; `/api/attention` is STAFF-only
  and returns 403 to a Worker and 401 to nobody. No authorization was weakened anywhere, and no
  route's guard level was lowered.

### 5.8 — Audit trail

Audited against the listed actions. **Already sufficient, and reused rather than duplicated:**
production assignment and reassignment (`production_movements` ALLOCATION / REASSIGNMENT events,
the latter moving zero quantity), submission (`submittedAt` plus the ledger, with the submitter
enforced as the stage's own worker), inspection / approval / rejection / rework
(`stage_inspections.inspectedBy`, not null), support assignment
(`support_assignments.assignedByWorkerId`), support approval (`inspectedBy` from the session),
corrections (`production_corrections`, with who / when / why and the before-and-after values),
material return and wastage (the dated, attributed trail added at the end of Task 4), and order
lines cut below what is already committed to production (refused, with the batch's quantity as
the ceiling).

**Closed in this run:** payment creation, whose actor was forgeable (5.7 above).

**Closed in the final hardening pass:** `payments` (customer receipts), `packing_records` and
`deliveries` could answer *what* and *when* but not *who*. All three now carry the actor taken
from the session — see "Final hardening" below.

### 5.9 — Performance

- **`GET /api/orders/[id]` was downloading the factory.** It selected every production
  operation, every quality check and every rework record in the book and filtered them in
  JavaScript, and selected the whole customer table to find one customer. All three
  transactional tables grow with every stage of every batch ever made, while the rows this page
  needs grow only with the one order. They are now scoped with `inArray` (guarded — an empty
  list is not valid SQL, and an order with no batches has no operations), and the customer read
  is one row by id.
- **`GET /api/material-purchases` was worse.** Every purchase, every material and every order,
  filtered in JavaScript, with no pagination at all. Now filtered and paged in SQL in the same
  shape as `GET /api/material-usage` (`limit` ≤ 1000 default 500, `offset`, `orderId`,
  `materialId`, `X-Total-Count`), still a **bare array** so nothing that reads it had to change,
  with name lookups fetching only what the returned page mentions.
- The Project Manager dashboard no longer runs the costing queries at all (5.6).
- **Measured and deliberately left alone:** `GET /api/dashboard` still reads `productionOperations`
  whole. It is the last unbounded read on that route, but the dashboard genuinely summarises
  every stage (per-stage counts, inspection queue, per-worker load), so the *rows* cannot be
  reduced without changing what the screen means. Narrowing the *columns* was checked
  concretely: of 23 columns, only 5 are not read by any of the three consumers — 6 of the 11
  candidates (`method`, `pieceRate`, `quantityRemaining`, `inspectedAt`, `completedAt`, `notes`)
  are used. That would buy roughly a fifth of the payload width in exchange for a change to a
  working contract on the most-visited screen, so it is reported rather than done.
- `/api/attention` reuses one `productionControl` derivation for five of its alerts instead of
  querying per alert, and the sidebar pulls it **once per page load, never on a timer** — a
  background poll would repeat an expensive derivation on every open tab for a figure that only
  has to be right when somebody looks.

### 5.10 — Mobile and worker usability: audited, no genuine defect found

Checked against the daily operations rather than assumed, and cross-checked against
`PROJECT_CONTEXT.md` section 38, which documents an earlier mobile/PWA pass. Both agree:

- The shared `inputCls` — used by 269 call sites — is already `min-h-11` (a 44px tap target) and
  `text-base sm:text-sm`, so iOS does not zoom on focus. `Btn` is `min-h-11` too.
- The sidebar is already a drawer that scrolls independently, closes on Escape and locks body
  scroll while open.
- The worker's job list is card-based; the tables that do exist (`WorkerPages`, the control
  board) are wrapped in `overflow-x-auto` with an inner `min-w-[…]`, so they scroll rather than
  crush.
- Modals are already bottom sheets on phones with `overscroll-contain`, and print styles are
  already set for A4 with repeating table headers.

**Nothing was redesigned and no styling was churned.** The only UI additions in this run are the
attention badge in the sidebar and the `notListed` line on the printed payment sheet, both of
which follow the existing patterns and preserve the branding and the official logo untouched.

### 5.11 — Status visibility, without a notification system

The repository has **no notification mechanism of any kind** — no table, no queue, no push, no
email — so there was nothing existing to improve. `GET /api/attention` answers "what needs me
today" in one read-only call: overdue production, work submitted and awaiting inspection, rework
outstanding, outsourced stages not back, stages nobody is assigned to, support work submitted and
unjudged, approved garments not yet delivered, material at or below its reorder level, and orders
marked COMPLETED while batches are still open.

It is deliberately a **pull, not a push** — a count, a severity, a sentence and a link to the
screen that already deals with it. No new table, no infrastructure, and every signal derived from
somewhere the business already trusts: the production flags come from `productionControl`, the
same derivation the board renders, so an alert cannot disagree with the screen it links to.
Staff-only, because a worker's own view is the worker dashboard, which already scopes to their
allocations.

It reads completed-status orders too (`openOnly: false`). The board's default hides them, but a
status is typed by a person, and an order marked complete by hand with six pieces sitting in
rework is exactly what management must be told about — excluding it would let the status column
switch off the alarms about the work behind it. Genuinely finished batches raise nothing anyway:
COMPLETE short-circuits every other flag, so this widens the view without inventing noise.

### 5.12 — Test coverage

**278 tests, 0 failures**, all through the real route handlers against the existing harness — no
hard-coded production ids, no fixture that exists only to make an assertion pass. Added in this
run:

| File | New | Covers |
| --- | --- | --- |
| `cost-and-material-detail.test.ts` | 7 | The seven returned-material rules, each on its own |
| `cost-and-material-detail.test.ts` | 7 | Ready-made is a cost and never stock (and still costs `readyMade`, never `materials`, never labour); raw-material purchases still land on the shelf and still update the catalogue price; orphan purchases refused; insufficient stock refused with the shelf untouched and **nothing partially issued**; a return at issue time counted against the store; an edit can put material back but never draw the shelf down; ready-made issuance moves no stock in either direction |
| `order-lifecycle-and-attention.test.ts` | 8 | The derived lifecycle end to end including a hand-set COMPLETED status the production does not support; packing and delivery bounded by approved production, and the ceiling following the ledger as more is approved; an order that never entered production behaving exactly as before; the attention list's shape, ordering and staff-only guard; rework, shortage and status-mismatch alerts; purchase pagination and filtering; the session-derived payment actor with a forged `paidBy` rejected; and one authoritative profit across dashboard, reports and order page |

Mutation testing: the existing mutation set (31 in Task 3, 12 in Task 4, all caught) still passes
against these routes; the new guards are each asserted by a test that fails if the guard is
removed — insufficient stock, packing ceiling, delivery ceiling, orphan purchase, forged
`paidBy`, worker reading `/api/attention`, un-returning material, and the ready-made stock
exemption.

---

## Final hardening — the two items resolved

Both items reported as open at the end of the first Task 5 pass are now implemented, in one
commit (`960cfcd`) so that no commit contains a test for code the same commit does not have.

### 1. Actor audit on receipts, packing and deliveries — migration `0010_actor_audit`

`payments`, `packing_records` and `deliveries` each gain `recorded_by_id` (nullable reference to
`users`, `ON DELETE set null`) and `recorded_by_name` (nullable text). That is the actor pattern
`production_movements` already uses (`actor_user_id` + `actor_name`), and the same server-side
derivation as `worker_payments.paid_by` and `stage_inspections.inspected_by` — the existing audit
mechanism reaching three tables that had none, **not a second system**. The id survives a rename,
the name survives a deleted user, and neither has to be kept in step with the ledger.

- The actor comes from `getSessionUser(req)`. **Nothing is read from the request body**: a caller
  cannot put somebody else's name on a receipt, a packing list or a delivery note.
- Stamped once at creation and **never rewritten by an edit**, so it means *who recorded this*,
  not *who last touched it*. Edits are already OWNER-only on all three routes, and moving the
  column would change the meaning of rows already on somebody's filing cabinet.
- **No existing row is backfilled.** A receipt recorded before this upgrade keeps a NULL actor,
  because that is the truth about it. Inventing a name on a historical financial document would
  be worse than leaving the question open — which is why both columns are nullable with no
  default, and why a test asserts the migration contains no `NOT NULL`, no `DEFAULT` and no data
  statement at all.
- `drizzle/0010_actor_audit.sql` is six `ADD COLUMN`s and three `ADD CONSTRAINT`s and nothing
  else. `deploy/upgrade-actor-audit.sql` is the same statements, idempotent and guarded, with
  commented verification queries, and states the house rule: **SQL first, then code.**

### 2. A variant's `completed` count comes from approved production

The derivation already existed — `completedForVariant()`, the quantity approved at the **last
stage of each batch's own frozen route** — but it only won when it was *greater than zero*:

```ts
completed: derived > 0 ? Math.min(derived, quantity) : recorded
```

so a number somebody typed survived whenever production had approved nothing yet. **Twenty pieces
submitted and awaiting inspection, or every piece rejected, still showed the typed figure as
finished** — precisely the arbitrary manual entry this field must not be. The rule is now:

- the variant has any live batch ⇒ **the ledger decides, including when it says zero**;
- the variant has no production at all ⇒ the recorded figure stands rather than being quietly
  zeroed, because there is no ledger to consult. This is the same historical-compatibility line
  the packing and delivery ceiling takes.

`produced` is returned alongside so a screen can tell the two cases apart, and `completedRecorded`
still reports what was typed. The order page had re-implemented the same `> 0` fallback in JSX, so
it now uses the API's authoritative figure — one rule, one place.

`completedForVariant` also ran **three queries per variant**, and the endpoint called it once per
row inside a `Promise.all`: an order with twelve size/colour combinations ran thirty-six queries
to draw one table. The arithmetic is unchanged and now lives in `completedForVariants()`, which
answers for any number of variants in **two queries**; the single-variant function is a wrapper on
it, so its existing contract is untouched.

Covered: no production keeps the recorded figure; submitted-but-unapproved completes nothing and
replaces the typed figure; rework and rejects are never completed; a middle stage completes
nothing while each batch's own last stage decides; two batches of one variant add up **once each**;
sizes and colours never mix; several workers sharing a stage do not double-count, judged through
the existing attribution mechanism; partial production reports exactly what was approved; unknown
and empty variant lists are nothing rather than an error.

### 3. The batch payroll query: there isn't one

`src/lib/payroll.ts` has **no reference to `production_batches` at all**. Payroll is derived from
approved inspections and attributed allocations, which is batch-independent by design, so the
query referenced in the secondhand section-33 note does not exist in this codebase and there was
nothing to complete or fix. The per-worker `completed` figure on the workers screen is a different
concept — operation-level work plus submitted shares, shown beside a separate `approved` field —
and was inspected and left alone rather than silently redefined.

---

## Important business rules — unchanged, and now enforced in more places

Ready-made products are not raw materials (**now enforced on the general purchases screen, not
only the dedicated flow**). Approved upstream output is the only quantity available to the next
stage (**now also the ceiling on packing and delivery**). No manual quantity bypasses the ledger
(**`fulfilment` and `/api/attention` are both read-only and fully derived**). Partial production
is valid, multiple workers can share a stage, exact variants stay distinct, workers cannot
approve their own work, support workers cannot approve their own support work, support payment is
carved out of the tailor's gross commission and never added on top, deductions apply to piece-rate
earnings only, and all production, payroll and profitability calculation is server-side. No
existing data was backfilled and no historical business meaning was changed silently — the one
restated figure, the dashboard's profit, keeps its old value on screen beside the new one.

---

## Decisions deliberately left for you

1. ~~**`recorded_by` on customer receipts, packing and delivery.**~~ **RESOLVED** in the final
   hardening pass: migration `0010_actor_audit`, actor from the session, no backfill.
2. **Dashboard column narrowing.** 5 of 23 columns on the whole-table `productionOperations` read
   are provably unused; narrowing them changes a working API contract on the most-visited screen
   for about a fifth of the payload width. Reported, not done.
3. **The packing/delivery ceiling for an order that never entered production** falls back to what
   was ordered, so historical and off-floor orders keep working. If you would rather every order
   without approved production be impossible to pack or deliver, that is a one-line change — but
   it would block deliveries that succeed today.
4. ~~Section 33's outstanding item — deriving a size's `completed` count from approved
   production, and the batch payroll query.~~ **RESOLVED** in the final hardening pass: the ledger
   now decides wherever production exists, including when it says zero, and there is no batch
   payroll query in this codebase to fix (`payroll.ts` never references `production_batches`).

---

## Known limitations

- `/api/attention` derives up to 500 batches per call, the same window the control board uses,
  and reports `window.capped` when there is more. It is pulled once per page load, never polled.
- `recorded_by_*` records who **created** a receipt, packing record or delivery, not who last
  edited it. An edit history for those three would need either an `updated_by` pair or a document
  ledger — a second mechanism, and therefore a decision rather than a default. Edits are
  OWNER-only, and `payments` also keeps `reference` and `notes`.
- `GET /api/dashboard` still reads `productionOperations`, `materials`, `workers` and `products`
  whole (see 5.9 for why the largest of those was left alone).
- The eleven `react-hooks/set-state-in-effect` lint errors are the repository's existing pattern
  across eleven working pages; cleaning them up is a cross-cutting change nobody asked for.
- pg-mem's `IS NOT NULL` combined with `IN (...)` on a nullable column silently returns no rows.
  Documented in `tests/README.md`; every scoped query in this run uses the guarded form.
