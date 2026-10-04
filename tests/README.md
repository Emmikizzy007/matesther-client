# Matesther ERP — authorization & business-rule regression suite

```
npm test
```

Runs 198 tests in about 80 seconds. No server, no `DATABASE_URL`, no network,
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
| `cost-and-material-detail.test.ts` | Outsourced work as an external production cost with its own money: payable, paid, bank reference, payment date and promised return date, payable never exceeding the cost of the work, paid never exceeding payable, money already sent never quietly reduced, and the vendor never reaching payroll or being mistaken for tailor labour. Material as issued / used / returned / wasted against one stock figure: the invariant that they must not exceed what was issued, a mandatory written reason for a return or write-off, a record written the old way still meaning and costing exactly what it did, returns and write-offs recorded after the issue and never un-recorded, and usage paged and filtered in the database rather than loaded whole |
| `support-payroll.test.ts` | Tailor support work paid on approved pieces only, the ban on approving your own support work (including a supervisor who also does the work), assignment and inspection history preserved, salaried non-production staff, the payroll breakdown and payment status, Owner-only payroll and payment sheet, and duplicate-payment prevention |

## How it works

`tests/support/preload.cjs` builds an empty in-memory PostgreSQL emulation
(`pg-mem`), applies the repository's real Drizzle migrations in order, and
redirects `require("pg")` to it. `tests/support/harness.ts` then calls the
**real** route handlers exported from `src/app/api/**`.

Nothing in the suite re-implements, copies or fakes application logic. A test
that calls `api("POST", "/api/inspections", ...)` executes the actual
inspection route against the actual data layer.

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
