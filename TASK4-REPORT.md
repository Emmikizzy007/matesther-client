# Task 4 — progress report

Branch `arena/01a10141-matesther-client`, HEAD **`247b6f1`**, pushed. Working tree clean.
Task 4 is **partially complete**. Nothing below was rebuilt; everything evolves the tables and
modules already in production.

---

## Verification numbers (all run against this commit)

| Check | Result |
|---|---|
| `npm test` | **209 / 209 pass**, 0 fail, 0 skipped (was 198/198 at the start of Task 4) |
| `npx tsc --noEmit` | **clean**, 0 errors |
| `DATABASE_URL=… npm run build` | **succeeds**, all routes compiled |
| `npm run lint` | **32 problems (28 errors, 4 warnings)** — identical to the Task 3 end state. Baseline before any of my work was 30. **No file changed in Task 4 contributes a single lint problem**; the two apparent matches are `(app)/orders/[id]/page.tsx` and `(app)/payroll/page.tsx`, UI pages carrying the pre-existing `react-hooks/set-state-in-effect` from Task 2/3, not the API route or `lib/payroll.ts` I edited. |
| Schema drift | **zero**. `drizzle-kit generate` reports *"No schema changes, nothing to migrate"*. Journal has **10** entries, last `0009_support_cost_and_material_detail`. |
| Migration verification | All **10** migrations apply in order on a fresh database — the test bootstrap applies every journal entry before each run, and 209/209 pass. `0009` alone: **25 statements**. |
| `deploy/upgrade-support-cost-material-detail.sql` | **15** `ADD COLUMN IF NOT EXISTS`, **5** `CREATE INDEX IF NOT EXISTS`, **5** guarded `ADD CONSTRAINT`, **0** `CREATE TABLE`, **0** `DROP`/`TRUNCATE`/`DELETE`/`RENAME`, **0** data writes. Verified by scanning for dangerous statement starters — none. |
| Mutation tests | **12 / 12 caught**, every file md5-verified restored afterwards, tree confirmed clean. |

Production data: untouched. No demo or business data seeded. No migration re-run.

---

## Your four decisions, applied

1. **Ready-made stays OUT of stock.** A bought-in finished uniform is a purchase with its own cost,
   linked to the order and its variant, and does not touch `materials.current_stock`. Task 3's
   behaviour stands; no stock accounting was introduced.
2. **Hand-entered "Materials" and "Labour" expenses are excluded from cost and reported
   separately** as `superseded`. They are not deleted and not hidden — they are simply no longer
   added on top of a computed figure for the same thing.
3. **Carry forward.** A deduction is taken only as far as the month's piece-rate earnings allow;
   the remainder is held (`supportDeductionOwed`) and recovered from the first later month that has
   piece-rate earnings. No worker's pay is ever driven negative and no helper pay is written off.
4. **Restate, and show both.** Every order is costed on the full nine-category formula, and the old
   formula's answer is returned beside it as `legacy`, so no historical figure is silently
   overwritten.

## Your clarification on support labour, applied

> Support workers are still paid directly by MATESTHER, but delegated support payment is not an
> additional labour cost on top of the tailor's piece-rate commission.

That is exactly the model now implemented, and it is pinned by a test using your numbers:

```
tailor rate 300 x 100 approved  = 30,000 gross commission   -> costs.internalLabour
18 pieces delegated at 30       =    540 to support worker   -> costs.supportGrossPaid
tailor's commission             = 29,460                    -> payroll due
total internal labour cost      = 30,000   NOT 30,540       -> costs.supportLabour = 0
```

`supportLabour` is the **difference** between the two sides, so the same 18 pieces are never costed
twice. Both sides are reported (`supportGrossPaid`, `supportDeductedFromTailors`, and
`supportAllocation` on the order) so the internal allocation is visible rather than hidden behind a
zero, and payroll shows the helper's payment and the tailor's deduction as separate lines.

**Bug this clarification caught:** payroll's deduction was gated on the *helper's* payment type
only, so it carried a deduction against a monthly-paid tailor who had no commission for it to come
out of. It is now gated on the **tailor** being `PER_PIECE`, matching the costing rule exactly. A
salaried tailor gets no deduction, and the helper's pay then correctly stands alone as a real extra
cost of the order.

---

## Items complete

**Item 1 — exact support-work allocation.** `POST /api/support-work` resolves the exact share
(`productionAllocationId`, or the stage job) and **inherits** order, item, variant and stage from
it. A helper is never handed a school to pick from scratch. Only the holder of the work may hand it
out; an Owner recording it on someone's behalf must name them and it is attributed to the holder, so
inspection authority and the deduction both land on the right person. Quantity is ceilinged per
(share, operation): 40 garments can take 40 weaves **and** 40 tapes, never 41 weaves.

**Item 2 — the deduction.** Implemented, capped, carried forward, gated on the tailor having a piece
rate, and server-side only. Same SQL expression as the helper's own earnings, so the two sides
cannot drift. Applied identically in the monthly accrual, the twelve-month history and the bank
payment sheet — one implementation, three readers.

**Item 3 — inspection.** Existing separation of duty is preserved and now also exercised against the
new allocation link: the tailor who handed the work out may inspect it, the support worker may not
approve their own work whatever their login role, and a supervisor who did the work may not either.
Split-stage inspection keeps the explicit `attributions` mechanism from Task 3 — no invented FIFO or
pro-rata policy.

**Item 4 — the nine cost categories.** `src/lib/order-cost.ts` is the single definition. Ready-made
is never tailor labour; a vendor is never a worker and never appears in payroll; no phantom payroll
is created for outsourced or ready-made work. Proven by test: the cutter is paid 2,000, the vendor's
5,000 sits in `outsourced`, and payroll `totals.due` for that worker is 2,000 with no row for
"Lagos Embroidery".

**Item 5 — external/outsourced work.** Already carried variant, quantity sent, vendor, method, sent
date, actual return, returned/accepted/rejected/short, unit and total cost, and released **only
accepted** quantities downstream. Now also live: `expectedReturnAt`, `amountPayable`, `amountPaid`,
`paymentReference`, `paidAt`, plus derived `paymentStatus` and `amountOutstanding`. Payable cannot
exceed the cost of the work; paid cannot exceed payable; money already sent can be added to but
never quietly reduced — the same protection an accepted quantity already had. Audit history is the
existing movement ledger.

**Item 6 — ready-made as a purchase cost.** Kept separate from monogram/packing/delivery labour by
the `READY_MADE` method and the `Ready-made garment` material category. Out of stock, as decided.

**Item 7 — material detail.** Issued / used / returned / wasted, with worker, exact variant,
timestamp, unit and total cost, and a mandatory written reason for any return or write-off. Same
material system, one stock figure. `quantity_issued` is **nullable on purpose**: NULL means
"issued = used", which is what every pre-existing row means; a zero would claim nothing was handed
out. Used and wasted are costed (both consumed); returned is not, and goes back into stock.
`GET` is now filtered and paged in SQL with only the returned rows enriched — it previously read
every usage row, every material and every order in the database and filtered them in JavaScript.

**Item 8 — profitability.** `revenue − ready-made − materials − internal labour − machine labour −
net support labour − outsourced − packaging − delivery − other`. Six grouped statements cost the
whole order book in one pass. `api/orders/[id]` and `api/reports` both read the same module, so they
can no longer disagree. Nothing is double-counted: `material_purchases` feeds only `readyMade`,
`material_usage` only `materials`, and superseded expense rows are excluded.

---

## Items NOT complete — what remains

**Item 9 — route-aware production control dashboard.** Not started. Needs school/order, due date,
ordered/approved/remaining, current route stage, assigned quantity, awaiting inspection, rework,
rejected, bottleneck and priority, all derived from the ledger, allocations, inspections and route.
The derivation helpers exist (`production-ledger.ts`, `production-route.ts`,
`production-allocation.ts`, `batchApprovedProgress`); what is missing is the endpoint and screen
that assemble them per school/order.

**Item 10 — worker dashboard shows their exact work.** Partially there from Task 3 (variant, method
and route fields, allocation awareness). The new inherited fields on `support_assignments`
(item / variant / stage) are returned by `GET /api/support-work` but are **not yet surfaced on the
helper's own screen**.

**Item 11 — reassignment preservation.** Not changed by any Task 4 work, so the Task 3 guarantees
still hold (only unworked quantity moves; approvals, inspection history and earned pay stay with the
person who earned them). What is missing is a Task-4 test proving a reassignment also preserves an
**earned support deduction**.

**Item 12 — performance.** Done for order costing (6 grouped queries) and material usage (paged,
SQL-filtered). **`api/reports` still loads whole tables** — `production_operations`, `workers`,
`materials`, `material_purchases`, `material_usage`, `expenses`, `stage_inspections` — for its
materials, worker and expense sections. Its profitability section is now grouped, but the rest is
not. This is the largest remaining performance item.

**Item 13 — tests.** 11 new tests and 12 mutations this task, on top of the 198 existing. The 16
named areas are **not all covered**; in particular there are no Task-4 tests yet for the production
control dashboard (item 9) or the worker dashboard (item 10), because those do not exist yet.

**UI.** No screen was changed in Task 4. The APIs expose the nine cost lines, `supportAllocation`,
`legacy`, `superseded`, `notListed`, the vendor payment fields and the material issue/return/waste
fields, but the order page, reports page, payroll page, external-work page and materials page do not
display them yet. The existing screens still work unchanged — `totalCost`, `profit` and `margin`
kept their keys and now carry the correct numbers.

---

## Decisions I made conservatively, flagged for your review

None of these restates a historical figure, and each is a one-line change if you disagree.

1. **What a deduction may come out of: piece-rate earnings only** — production piecework plus any
   support piecework the worker earned themselves. Salary, overtime and other approved payments are
   left alone, because your rule is expressed against the tailor's *piece rate* and carving a
   helper's rate out of a contracted monthly salary would be inventing payroll behaviour.
   Consequence: a pure-salary tailor accumulates no deduction at all (see the clarification above).
2. **Wasted material is costed.** `totalCost = (quantityUsed + quantityWasted) × unitCost`. Both are
   consumed; only returned material comes back. Every pre-existing row has `quantity_wasted = 0`, so
   no historical cost changes.
3. **Returned material goes back into `materials.current_stock`.** This completes the single
   decrement that already existed rather than adding a stock system — but it *is* a stock movement,
   so it is flagged. When no issued figure is given the behaviour is byte-identical to before.
4. **Machine running cost contributes 0.** `machineLabour` is piecework on `MACHINE`-method stages.
   There is no existing record of machine *running* cost (fuel, maintenance per job), so nothing is
   invented; `Repairs` and `Electricity` expenses still land in `other`.
5. **Salaried labour is not attributed to any order.** Order profit is therefore a **direct-cost**
   margin. `unattributableCosts()` reports monthly salaries and business-wide expenses alongside it
   (surfaced as `businessCosts` in `api/reports`) so an order margin is never read as the whole
   business's margin. No spreading rule was invented.
6. **`api/payment-sheet` totals now describe the sheet's own rows**, with a `notListed` block
   reporting what is deliberately off it (workers with nothing due, and the deduction held against
   them). Previously the sheet's total came from the whole payroll while its rows were filtered, so
   the two could disagree — and under the deduction rule they did, by 18,400 across the test corpus.

---

## One process note

The sandbox reset mid-task: `node_modules` was wiped and `HEAD` was moved back to the base commit.
The working tree survived. I recovered with `npm ci`, `git fetch`, `git reset --soft FETCH_HEAD`,
confirmed the delta was exactly my Task 4 files, and checkpoint-committed immediately. Everything
from Task 2 and Task 3 is intact and pushed; the earlier reports under `/home/user` (`TASK1-AUDIT.md`,
`TASK2-REPORT.md`, `TASK3-REPORT.md`) were outside the repository and were lost to an earlier reset.
This file is inside the repository, so it will survive.
