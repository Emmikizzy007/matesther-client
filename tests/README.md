# Matesther ERP — authorization & business-rule regression suite

```
npm test
```

Runs 115 tests in about 40 seconds. No server, no `DATABASE_URL`, no network,
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
  it cannot run `DO $$ ... $$` guard blocks. Migrations `0003`, `0004` and `0005` each
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

## Safety

The suite never connects to a real database and never writes outside the test
process. It reads nothing from production. Fixtures are synthetic and are
discarded when the process exits.
