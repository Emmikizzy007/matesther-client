# Matesther ERP — authorization & business-rule regression suite

```
npm test
```

Runs 378 tests in about 4 minutes. No server, no `DATABASE_URL`, no network,
and **no seeded demo data** are required.

## Why this suite exists

`tests/production-roles.cjs` is the original security check. It is a good test,
but it cannot run on a clean database: it signs in with hard-coded demo
credentials and references hard-coded record ids (`workerId: 1`, `productId: 1`,
`tailorId: 3`). Matesther's production database has no such records, and must
not be given any.

This suite replaces that dependency. It starts from an **empty** database and
builds every record it needs through the real public API, under unmistakable
test identities (`@test.matesther.invalid`). `production-roles.cjs` is left in
place and untouched.

## What it covers

| File | Focus |
| --- | --- |
| `security.test.ts` | Session lifecycle, 401 on every protected route, forged/expired/deactivated sessions, cross-site request blocking |
| `authorization.test.ts` | Role boundaries: Project Manager finance blackout, Worker own-data-only, price and pay-rate redaction |
| `separation-of-duties.test.ts` | Cutter-supervisor restriction, self-inspection ban, inspector identity, approved-only stage flow, history preservation |
| `payroll-rules.test.ts` | Payroll accrual (piecework / salary / overtime), plus the pure pay and progress helpers |
| `multi-role.test.ts` | One person with several roles: no duplicate people, no duplicate roles, role removal keeps the person, legacy single-role workers unchanged, and the cutter-supervisor and self-inspection controls still holding when the role is one of several |
| `pwa-branding.test.ts` | Installability contract, and the official-logo endpoint: Owner-only upload, the committed official mark served byte-for-byte when none is uploaded, SVG and undersized uploads refused, the stored logo returned **byte-for-byte**, square OS icons, the install button never faked, and the mobile safe-area / tap-target / iOS-zoom fixes |
| `whatsapp-sharing.test.ts` | WhatsApp deep links: correct `wa.me` number normalisation, refusal to guess an unusable number, no application URL in a shared message, confidentiality handling on the Owner-only payment sheet, and the Owner-only guard still holding on the documents behind the share buttons |
| `split-allocation.test.ts` | One exact garment at one stage split across several workers (100 navy size-10 polos at SEWING → 40 / 35 / 25): partial shares and per-person remaining figures, over-allocation refused against the ledger's own figure, resizing bounded both ways, reassignment moving only unworked quantity so earned work and its pay stay put, submissions bounded by each worker's own share, per-worker inspection attribution asked for rather than invented, pay following the person who made each approved garment at the rate agreed with them, separation of duties extended to a supervisor who holds a share, carry-over of work submitted before a stage was split, and unsplit stages behaving exactly as before |
| `route-driven-production.test.ts` | Exact garment variants (item + optional size + optional colour), variant-level allocation ceilings and partial allocation, routes that shorten / start late / end early / skip stages / run in their own order, the route being frozen on the batch, per-stage production methods, the five methods staying distinct, external work keeping sent / returned / accepted / rejected / short as separate figures with only the accepted figure moving on, ready-made purchases staying purchases, and worker dashboards showing the exact garment allocated |
| `production-integrity.test.ts` | Quantity integrity: every counter derived from the production movement ledger, the four measured free-text quantity attacks refused, audited corrections with a mandatory reason, the upstream-approved ceiling that stops downstream over-allocation, approved quantity never correctable, the ledger append-only, an unmapped event type inert, the delivery stage role gate, the grouped payroll SQL agreeing with the pure pay rule, and order edits committing atomically |
| `support-cost-allocation.test.ts` | Support labour as an INTERNAL ALLOCATION of one cost rather than a second cost, in the business's own numbers (300 x 100 approved = 30,000 gross commission; 18 pieces delegated at 30 pays the helper 540 and leaves the tailor 29,460; the order's labour cost stays 30,000, **not** 30,540). Also: support work inheriting the exact share it was handed out from so a helper is never pointed at a school chosen from scratch, payment and deduction on approved pieces only, a monthly-paid tailor having no commission to deduct from so the helper's pay stands alone as a real cost, a deduction never driving pay negative with the remainder held rather than written off, and a tailor being unable to hand out another tailor's share or more of their own than exists per supporting operation |
| `cost-and-material-detail.test.ts` | Outsourced work as an external production cost with its own money: payable, paid, bank reference, payment date and promised return date, payable never exceeding the cost of the work, paid never exceeding payable, money already sent never quietly reduced, and the vendor never reaching payroll or being mistaken for tailor labour. Material as issued / used / returned / wasted against one stock figure: the invariant that they must not exceed what was issued, a mandatory written reason for a return or write-off, a record written the old way still meaning and costing exactly what it did, returns and write-offs recorded after the issue and never un-recorded, and usage paged and filtered in the database rather than loaded whole. Then **the seven returned-material rules each on their own**, so no future change can satisfy one by breaking another: issued reduces available stock and a genuine return puts it back (down by what stayed out, *not* by the full issue), returned material stops being a cost of the job the moment it comes back, wastage stays consumed and never returns to the shelf even when more is written off later, one quantity can never be returned twice (two returns of 2 and 3 credit 3, not 5 again; a return cannot be un-recorded; returns cannot exceed what was issued), a return is auditable with who / when / why **and needs a reason of its own** rather than borrowing the reason the material was issued for, order profitability follows material *consumed* and restates when more comes back, and a record written the old way is normalised so returns against it stay bounded — including the second genuine return that a shrinking ceiling used to refuse |
| `production-control.test.ts` | The route-aware production control board, and the fact that nothing on it is typed. The derivation rules as pure functions (days until due with a malformed date refused rather than parsed as NaN, current position as the earliest stage with work left, bottleneck as the stage holding the most with ties to the earliest, the blocking flags, the six-rank priority with overdue outranking blocked and COMPLETE short-circuiting everything). Then the board itself: ordered / finished / remaining, "finished" meaning approved at the LAST stage of **that batch's own frozen route** so a route that skips a stage reports its own positions, only approved quantity moving downstream, rejected work written off at the stage while the order-level remaining stays honest about the shortfall, awaiting-inspection and rework as blocks, an outsourced stage waiting on a vendor flagged as waiting and **not** as unassigned with the vendor never counted as a worker, assigned as the sum of live shares with the holders named, staff-only, read-only (no POST/PUT/PATCH/DELETE exists to write a quantity through), **no money key at any depth** with a cutting rate and a piece rate planted behind it so a leak would have something to leak, derived filters naming themselves in `appliedAfterDerivation` while pushed-down ones do not, two exact variants staying two rows and rolling up to one order whose priority is its most urgent batch, and bounded pagination where the total counts every match and the header agrees with the body |
| `reassignment-and-report-figures.test.ts` | Three things that could each break silently and each touch money. **Reassignment:** a tailor who earned a commission and delegated support work keeps both after their unworked remainder is transferred (gross unchanged, deduction unchanged, due unchanged) while the transferee inherits neither, the helper is still paid exactly once, the order still carries one labour cost rather than that cost plus the helper's pay, the inspection record survives byte-for-byte with the same credited worker, the ledger keeps a REASSIGNMENT event that moves zero quantity, and a fully submitted share cannot be transferred at all. **The helper's exact garment:** school, order, item, size, colour, variant, stage, rate and the share it came from, with the quantity they are answerable for asserted *not* to be the variant's or the order's, their earnings journal naming the real order and school instead of a generic support line, and the allocations endpoint refusing to be widened past their own shares by omitting the parameter, by naming somebody else, or by using the operation path that returns every share by design. **The report's figures:** nine categories in documented order, materials costing used plus wasted and not returned, labour as gross commission, the legacy answer beside the restated one and visibly different, superseded hand-entered Materials and Labour set aside but named while a genuine Transportation expense is counted, materials read back from the material system rather than recomputed, piecework credited to the worker an inspection names and asserted equal to what payroll pays that same worker, all eight stages present with untouched ones reporting zeros, and every total asserted to be the sum of the rows above it |
| `support-payroll.test.ts` | Tailor support work paid on approved pieces only, the ban on approving your own support work (including a supervisor who also does the work), assignment and inspection history preserved, salaried non-production staff, the payroll breakdown and payment status, Owner-only payroll and payment sheet, and duplicate-payment prevention |
| `order-lifecycle-and-attention.test.ts` | One order end to end, derived and never typed. `orderFulfilment` reports ordered / released / approved / remaining / packed / delivered / ready-for-delivery / complete from the ledger and the packing and delivery records, with `complete` derived and returned BESIDE `statusSaysComplete` so a status set by hand without the production to back it is visible rather than trusted - a test marks a 100-piece order COMPLETED with 40 unmade and asserts the two are reported as disagreeing, not reconciled silently. Packing and delivery are bounded by APPROVED PRODUCTION: packing used to accept any positive number against any order id (and not check the order existed), and delivery was bounded only by what was ordered, so a hundred garments could ship with sixty made. The ceiling follows the ledger as more is approved, an order that never entered production keeps the ordered ceiling it always had, and a packing record against an order that does not exist is a 404 with nothing written. Then the attention list (shape, severity ordering, staff-only, rework and shortage and status-mismatch alerts), purchase pagination and filtering, a forged `paidBy` ignored on a payment, and one authoritative profit: dashboard and reports agree for the same book, the card reconciles against its own revenue, the dashboard's gap between the two formulas equals the sum of the per-order gaps the reports screen shows, and on an order with no expenses that gap is exactly the labour the legacy formula omitted |
| `variant-completion-and-actor.test.ts` | Two things nobody may simply assert. **A variant's completed count:** approved production at the LAST stage of each batch's own frozen route decides wherever the variant has any live batch - including when the ledger says zero, which is the regression that mattered, because the old rule (`derived > 0 ? derived : recorded`) let a number somebody typed survive whenever production had approved nothing, so twenty pieces awaiting inspection or every piece rejected still showed as finished. Submitted, uninspected, rework and rejected quantities complete nothing; a middle stage completes nothing while a batch routed CUTTING -> IRONING contributes its IRONING approvals; two batches of one variant add up once each; different sizes and different colours never mix; several workers sharing one stage do not double-count, judged through the existing attribution mechanism; partial production reports exactly what was approved; and a variant with no production at all keeps the recorded figure rather than being quietly zeroed. **The actor:** a receipt, a packing record and a delivery each name the signed-in user, a forged actor in the request body is ignored on all three, a Worker and a Project Manager are refused on all three whatever actor they claim, and the migration itself is asserted nullable, default-free and free of any data statement |
| `product-route-resolution.test.ts` | Which route a new batch actually follows, from the direction that exposed the defect. A route saved against a garment is returned by `GET /api/routes` and used by production — the two server-side causes of "the history appears to show organization-default routes" were `listRoutes(productId ?? null)` turning "no filter" into "routes whose product IS NULL", so every product route was silently dropped, and `resolveRoute` requiring `is_default = true` on a product route, so an assigned-but-unflagged route was invisible and the organisation default won. Also: an organisation default never overriding an explicitly assigned product route, `PUT /api/routes` honouring a `productId` so a route can be moved onto a garment after creation, the explicit-`routeId` path checking ownership, `GET /api/production-orders` reporting a `defaultRouteId` the resolver would actually pick (active, owned, and the generic route as a named fallback rather than `null`), cross-organisation routes and products refused, and a batch's route staying frozen so a later edit to the route cannot rewrite history already produced against it |
| `support-lifecycle.test.ts` | Support work as a lifecycle rather than a quantity. ASSIGNED → STARTED → SUBMITTED → APPROVED / REWORK, with PAUSED reachable from work in hand and RESUMED back out of it, every move server-enforced: no submitting before anybody started (409), no submitting or being inspected while paused, no self-approval, no over-delegation past what the stage holds, no handing out another tailor's work, and a pause requiring a written reason. `supportStatusAfterInspection` compares against the quantity ASSIGNED rather than the quantity submitted, so ten pieces delegated, four handed back and four judged is partial work and not an approval. Every transition appends to `support_status_events` with the actor who made it, a forged actor in the body ignored in favour of the session, and a Production Control board that reports a paused support operation as blocking rather than showing the stage as ordinary work in progress |
| `test-data-cleanup.test.ts` | The administrative test-data purge, and everything that stops it being a general-purpose delete. Owner-only with the guard before any read, a foreign organisation's order indistinguishable from a nonexistent one (404 either way), the exact school name and order number typed to confirm, a reason of at least ten characters, a dry-run preview that writes nothing, a SHA-256 fingerprint over the sorted per-table id sets recomputed inside the transaction so a stale preview and a replayed one are both 409. Inventory is restored with the material routes' own formula and refuses rather than guessing when reversing a purchase would drive stock negative, ready-made garments stay purchases and never become raw stock, settled payroll is reported and never rewritten, and shared master data — customers, products, workers, routes, materials, organisations — is never touched. The ordinary protection against deleting an order with approved production and payments is asserted to still hold |
| `start-production-and-list-bounds.test.ts` | Two things that are easy to get subtly wrong. **Start Production** on an order opens the existing Assign Production workflow with that order preselected — one assignment interface, not a second one — and the assignment is revalidated server-side, so an `orderId` belonging to another organisation or to no order at all preselects nothing. **List bounds:** the orders, payments, packing and expenses lists filter, search and page in SQL rather than reading whole tables into the process and filtering in JavaScript, `X-Total-Count` carrying the unpaginated total so a client can page without a second request, and a search term never widening the result past the signed-in organisation |
| `migration-safety.test.ts` | The two migrations this release adds, held mechanically to the promise every file in `deploy/` makes in prose: additive, repeatable, and writing no data. No `DROP`, `TRUNCATE`, `RENAME`, `DELETE`, `UPDATE` or `INSERT` outside a comment; every statement a guarded DDL form or a read-only verification query; a runnable verification `SELECT` present in each deploy script and actually naming the tables it created; no drizzle `--> statement-breakpoint` marker leaked into a file meant to be pasted into the SQL Editor; both migrations registered in the journal in order with a snapshot each; both upgrade scripts applied TWICE against the migrated database with the table set unchanged, the new tables still empty and a real order created through the API still intact afterwards; and `CREATE TABLE IF NOT EXISTS` proven a genuine no-op on a fresh in-memory database, which is the only place pg-mem can run the guarded form at all |

## How it works

`tests/support/preload.cjs` builds an empty in-memory PostgreSQL emulation
(`pg-mem`), applies the repository's real Drizzle migrations in order, and
redirects `require("pg")` to it. `tests/support/harness.ts` then calls the
**real** route handlers exported from `src/app/api/**`.

Nothing in the suite re-implements, copies or fakes application logic. A test
that calls `api("POST", "/api/inspections", ...)` executes the actual
inspection route against the actual data layer.

### pg-mem traps worth knowing before you write a query

**`IS NOT NULL` combined with `IN (...)` on a nullable column returns no rows.** Not an error —
silently empty. `and(isNotNull(t.orderId), inArray(t.orderId, ids))` is also redundant SQL,
because `col IN (1,2,3)` can never be true for a NULL `col`, so write
`scope ? inArray(col, scope) : isNotNull(col)` instead: identical in PostgreSQL, and it works
here. This hid four of the nine cost categories for a whole task, because the one bucket that
*was* covered filtered on `production_batches.order_id`, which is NOT NULL and therefore
immune. **If a computed figure comes back as zero in a test, suspect the query shape before
you suspect the arithmetic.**

**State persists across every test in one file.** Whole-book aggregates — `payroll.totals`,
`reports.totals`, `reports.production` — therefore accumulate. Assert on the specific row
(`workers.find(w => w.workerId === id).piecework`) rather than on a global total, or on an
invariant that holds for any set of rows (`remaining === received - approved - rejected`).

**Transactions do not roll back.** An `insert` followed by a `throw` inside
`db.transaction(async (tx) => ...)` leaves BOTH the row and every other write the
transaction made. This was verified directly rather than assumed. Any test that claims
"the transaction rolled back" is therefore claiming something pg-mem cannot demonstrate
in either direction, so this suite does not: `tests/test-data-cleanup.test.ts` says so at
the top instead of faking a rollback assertion, and asserts the ordering and the guards
that a rollback would have backed up.

**No `pg_indexes`, no `pg_tables`, no `pg_constraint`, and `::regclass` will not cast.**
Index counts and foreign-key counts cannot be asserted here at all. `information_schema.tables`
IS emulated, so table presence can be. A deploy script whose verification `SELECT` reads
those catalogues is still correct PostgreSQL — it just cannot be *run* by a test, so
`tests/migration-safety.test.ts` skips those statements explicitly and says why, rather
than silently skipping everything.

**`CREATE TABLE IF NOT EXISTS` is not honoured for a table that already exists** — it
errors with an unread-AST complaint instead of skipping. `CREATE INDEX IF NOT EXISTS` and
`ADD COLUMN IF NOT EXISTS` ARE both honoured, which is why migration 0006 can re-declare
every index in the schema. Do not "fix" this by stripping `IF NOT EXISTS` from index
creation: that was tried and it breaks 0006. To test the table guard, use a genuinely
fresh `newDb()` — see the last test in `tests/migration-safety.test.ts`.

**Inline column constraints are not parsed.** `CREATE TABLE t ("id" serial PRIMARY KEY NOT NULL)`
fails on the `PRIMARY KEY` and `NOT NULL` column constraints. pg-mem also cannot resolve a
correlated `EXISTS` that references a column of the outer query, which is why order search
joins `customers` and uses two `ilike` predicates rather than an `EXISTS` subquery.

**`sql` templates interpolate numbers as identifiers, not bound values.** Building a
subquery by string interpolation silently counts zero rows instead of failing. Use real
Drizzle joins and `inArray`, and read a `count(*)` result as `rows[0]?.total` — destructuring
`const [a, b] = await Promise.all([selectA, selectB])` binds whole ARRAYS, so `a?.total` is
`undefined` and every guard built on it reads zero. That single mistake once made an order
with approved production deletable, and it was typecheck that caught it.

**A btree index cannot enumerate `NOT IN (...)` on an indexed column.** Two `ne()`
predicates express the same thing and work.

## Important caveats

- **`pg-mem` is an emulation, not PostgreSQL.** `tests/support/pg-shim.cjs`
  documents three driver-level patches needed to run Drizzle 0.45 against it.
  Those patch the driver only. Constraint enforcement is partly emulated — the
  suite confirms that the `worker_roles` unique `(worker_id, role)` constraint
  rejects a duplicate, that its `ON DELETE CASCADE` fires, and that the unique
  `worker_payments.idempotency_key` index blocks a double payment — but
  PostgreSQL's wire format, type coercion and transaction isolation are not
  reproduced. The suite verifies Matesther's own authorization and business
  rules. The `deploy/upgrade-*.sql` operator files are **not** executed by the
  suite; their schema is kept identical to the matching `drizzle/` migration,
  which is.
- **One deliberate migration deviation.** pg-mem has no plpgsql interpreter, so
  it cannot run `DO $$ ... $$` guard blocks. Migrations `0003` to `0009` each
  wrap their `ADD CONSTRAINT` statements in one purely so the migration is
  re-runnable; because this database is always created empty those guards could
  never fire, so the statements inside run directly. The resulting schema is
  identical.
- **The suite is verified to fail when the controls break.** Each of these
  mutations was applied, run, and reverted byte-for-byte (md5 checked):

  | Mutation | Tests that failed | Everything else |
  | --- | --- | --- |
  | Remove the self-inspection guard in `api/inspections` | `separation-of-duties` 7 **and** `multi-role` 10 | passed |
  | Widen `GET /api/payroll` from `OWNER` to `STAFF` | `authorization` 2 | passed |
  | Remove the support-work self-approval guard | `support-payroll` 3 only | all 84 others passed |
  | Pay support work on submitted instead of approved pieces | `support-payroll` 1, 5 and 11 only | all 67 pre-Task-3 tests passed |
  | Widen `GET /api/payment-sheet` from `OWNER` to `STAFF` | `support-payroll` 13 only | all 84 others passed |
  | Remove the duplicate-payment idempotency guard | `support-payroll` 15 only | all 84 others passed |
  | Let the payment sheet embed a customer phone number (`sensitive` no longer suppresses it) | `whatsapp-sharing` 11 only | all 99 others passed |
  | Make `whatsappNumber` guess on numbers it cannot resolve | `whatsapp-sharing` 2 and 10 only | all 98 others passed |
  | Drop `noreferrer` from the WhatsApp anchor | `whatsapp-sharing` 8 only | all 99 others passed |
  | Widen `GET /api/receipts` from `OWNER` to `STAFF` | `whatsapp-sharing` 14 only | all 99 others passed |
  | Widen `POST /api/branding/logo` from `OWNER` to `STAFF` | `pwa-branding` 5 only | all 114 others passed |
  | Serve a generated blank instead of the bundled official mark | `pwa-branding` 3 only | all 114 others passed |
  | Re-encode the logo bytes on the way out | `pwa-branding` 3 and 9 | all 113 others passed |
  | Accept an SVG as the company logo | `pwa-branding` 6 only | all 114 others passed |
  | Shrink the mobile menu toggle back to a ~32px tap target | `pwa-branding` 13 only | all 114 others passed |
  | Put the login inputs back to `text-sm` (iOS focus-zoom) | `pwa-branding` 14 only | all 114 others passed |
  | Render the install button even with no browser prompt | `pwa-branding` 11 only | all 114 others passed |
  | Point a manifest icon at a baked-in file | `pwa-branding` 2 only | all 114 others passed |
  | Restore `cutterSupervisor` to the old `specialty === "cutter"` check | `multi-role` 7, 8 and 9 only | all 53 original tests passed |
  | Restore the stage gate to single-specialty equality | `multi-role` 5, 9 and 11 only | all 53 original tests passed |
  | Re-allow typed `quantityReceived` / `quantityCompleted` / `quantityRejected` on `PUT /api/operations` | `production-integrity` C1, C2, C3 and C4 **and** `authorization` 11 | all 129 others passed |
  | Remove the upstream-approved ceiling on a quantity correction | `production-integrity` 8 only | all 133 others passed |
  | Remove the self-dealing guard on a quantity correction | `production-integrity` 14 only | all 133 others passed |
  | Map an unmapped ledger event type into the received bucket | `production-integrity` 16 only | all 133 others passed |
  | Ungate the `DELIVERY` stage again (drop it from `STAGE_ROLES`) | `production-integrity` 17 only | all 133 others passed |
  | Count rework instead of approved pieces in the grouped payroll SQL | `payroll-rules` 29 only | all 133 others passed |
  | Restore the empty-set 500 on `PUT /api/orders/[id]` | `production-integrity` 19 only | all 133 others passed |
  | Remove the ceiling that stops an order line being cut below its committed production | `production-integrity` 20 only | all 134 others passed |
  | Read stage order from the global eight-stage array instead of the batch's frozen route | `route-driven-production` 15 only | all 173 others passed |
  | Drop the variant-level allocation ceiling | `route-driven-production` 7 only | all 173 others passed |
  | Count a dispatch as production (`EXTERNAL_SENT` into the submitted bucket) | `route-driven-production` 25 and 26 | all 172 others passed |
  | Release what came BACK downstream instead of what was ACCEPTED | `route-driven-production` 27 only | all 173 others passed |
  | Let a ready-made purchase inflate what the stage holds | `route-driven-production` 33 only | all 173 others passed |
  | Allow a ready-made stage part-way through a route | `route-driven-production` 37 only | all 173 others passed |
  | Let a supervisor accept back the work they themselves sent out | `route-driven-production` 30 only | all 173 others passed |
  | Let a ready-made receipt be judged twice | `route-driven-production` 32 only | all 173 others passed |
  | Let an accepted external figure be un-accepted | `route-driven-production` 29 only | all 173 others passed |
  | Let a dispatch send out more garments than the stage holds | `route-driven-production` 23 and 24 | all 172 others passed |
  | Let a worker submit pieces against an outsourced or bought-in stage | `route-driven-production` 38 and 40 | all 175 others passed |
  | Treat `MACHINE` as work that leaves the factory | `route-driven-production` 39 only | all 176 others passed |
  | Let the shares of a stage exceed what the stage holds | `split-allocation` 4, 5 and 6 | all 194 others passed |
  | Let a transfer move work the original worker already submitted | `split-allocation` 8 and 9 | all 195 others passed |
  | Let a share be reduced below work already submitted | `split-allocation` 7 only | all 196 others passed |
  | Inspect a split stage without saying whose work was judged | `split-allocation` 11, 12, 13 and 14 | all 193 others passed |
  | Show a worker every share of a stage, not just their own | `split-allocation` 13 only | all 196 others passed |
  | Pay the stage's nominal worker instead of whoever made the pieces | `split-allocation` 13 only | all 196 others passed |
  | Drop the carry-over of work submitted before a stage was split | `split-allocation` 17 only | all 196 others passed |
  | Let a supervisor inspect a stage they hold a share of | `split-allocation` 14 only | all 196 others passed |
  | Count a split stage twice on the Workers page | `split-allocation` 13 only | all 196 others passed |
  | Show the stage's nominal worker on every inspection row instead of the one credited | `split-allocation` 20 only | all 197 others passed |
  | Let a worker see every worker's inspection rows on a shared stage | `split-allocation` 20 only | all 197 others passed |

  **Task 4: support cost allocation, vendor payment detail and material detail.** Each
  of these twelve was applied, run, and reverted byte-for-byte (md5 checked), and the
  working tree was confirmed clean afterwards. Every one was caught - **12 / 12**. Unlike
  the tables above, each mutation was run against the single file that covers the rule
  rather than the whole suite, so the count given is the number of tests in that file
  which failed, not a whole-suite figure:

  | Mutation | Caught by | Tests failed |
  | --- | --- | --- |
  | Deduct from a tailor who has no piece rate (drop the `PER_PIECE` gate on the tailor) | `support-cost-allocation` 3 | 1 |
  | Make support pay ADDITIVE again instead of deducted | `support-cost-allocation` 1 | 1 |
  | Remove the cap, so a deduction drives pay negative instead of being carried | `support-cost-allocation` 4 | 1 |
  | Double-count delegated support labour in the order's cost | `support-cost-allocation` 1 and 2 | 2 |
  | Deduct from a salaried tailor in the cost model too | `support-cost-allocation` 3 | 1 |
  | Let the support quantity ceiling ignore what was already handed out | `support-cost-allocation` 5 | 1 |
  | Let any tailor hand out another tailor's share | `support-cost-allocation` 5 | 1 |
  | Stop returned material going back into stock | `cost-and-material-detail` 3 | 1 |
  | Drop the issued = used + returned + wasted invariant | `cost-and-material-detail` 3 | 1 |
  | Let a vendor be paid more than is owed | `cost-and-material-detail` 1 | 1 |
  | Let money already sent to a vendor be quietly reduced | `cost-and-material-detail` 1 | 1 |
  | Stop wasted material being costed | `cost-and-material-detail` 3 | 1 |

  **One defect these caught in the implementation before it shipped**, and it was silent:
  payroll's deduction was gated on the *helper's* payment type only, so it carried a
  deduction against a monthly-paid tailor who had no commission for it to come out of -
  540 held forever against somebody who could never repay it. The cost model already
  gated on the tailor correctly, so the two sides of the same rule disagreed. Caught by
  "a monthly-paid tailor has nothing to deduct from, so the helper's pay stands alone".

  **Three defects the split-allocation tests caught in the implementation before it
  shipped.** Worth recording because all three were silent - every test suite was
  green while they were present:

  1. A worker sharing a stage was shown earnings for *every* share of it, because the
     worker dashboard fetched inspections by operation and a split stage has one
     inspection row per worker. Caught by "pay follows the worker who made each
     approved garment".
  2. A worker whose share became fully judged *disappeared* from their own dashboard,
     because visibility used the same live-only filter as authority. Their earnings
     history and completed-jobs list vanished at the exact moment they finished.
     Caught by the same test.
  3. The Workers page counted a split stage twice for its first worker - once through
     the stage row and again through their allocation. Caught by the same test.
  4. The inspection trail named the stage's nominal worker on *every* row of a split
     stage, and a worker reading that trail saw their colleagues' approved pieces and
     rates. Caught by "the inspection trail names the worker credited".

  **A mutation this suite initially SURVIVED, and the fix.** The first version of
  "an unknown ledger event type cannot move a quantity counter" passed even with
  `SENT_EXTERNAL` mapped into the received bucket, because it only read the
  *stored* counter — which nothing had recomputed since the row was inserted. The
  test now forces a re-derivation by submitting real work first, and the mutation
  is caught. Reading a cached value is not the same as exercising the code that
  produces it.

  The role-aware mutations are the important ones for multi-role: the new tests
  fail when the role-aware logic is put back to the old single-specialty logic,
  while every pre-existing test still passes — so the new coverage is genuinely
  about multi-role behaviour and is not duplicating the old tests.

  Mutation testing also caught a **false-positive test written during Task 3**.
  The first version of "a support worker cannot approve their own work" passed
  even with the self-approval guard removed, because an earlier role check
  already rejects a plain Worker. The guard is only reachable when the person
  who did the support work is *also* a supervisor or the assigning tailor, so a
  test had to be written for exactly that combination before the guard was
  genuinely covered. This is why every control here is mutation-tested rather
  than assumed covered by a green run.

### pg-mem gaps that shaped the code

Worth recording, because each one is a place where the obvious SQL had to be
replaced by something that runs in both engines:

- `date_trunc` and `to_char` are **not implemented**. Monthly payroll filtering
  therefore uses a half-open UTC timestamp range (`>= first instant`, `< first
  instant of next month`), which selects exactly the rows `monthKey()` buckets and
  is what the new `inspected_at` indexes can use. `monthKey()` remains the
  definition; the range is asserted equivalent by test.
- `HAVING count(*) > 1` is **not supported**, so the duplicate pre-flight for the
  two new unique indexes lives only in `deploy/upgrade-production-ledger.sql`
  (real PostgreSQL), never in the `drizzle/` migration the suite applies.
- `generate_series` is **not implemented** — measurement scripts must insert rows
  in a loop.
- `NULLS NOT DISTINCT` (Postgres 15+) **fails to parse**, which is why the variant
  uniqueness uses a `coalesce(size,'')` / `coalesce(color,'')` expression index
  instead: it works on every Postgres version *and* is enforced identically here.
  Verified both ways in the emulator - "size 8 navy" and "size 8 black" coexist,
  a second "size 8 navy" is refused, and so is a second size-less colour-less row.
- `CREATE TABLE IF NOT EXISTS` against a table that already exists reports an
  unconsumed-AST error. That is an emulator quirk, not invalid SQL: the same three
  statements run cleanly on an empty database. It only affects scripts that
  re-run the `deploy/` files against an already-upgraded emulator to prove they
  are no-ops.
- A correlated `NOT EXISTS` with a table alias fails to resolve the column. The
  ledger backfill uses `NOT IN (SELECT ...)` instead, which is also what makes it
  re-runnable.

## Safety

The suite never connects to a real database and never writes outside the test
process. It reads nothing from production. Fixtures are synthetic and are
discarded when the process exits.
