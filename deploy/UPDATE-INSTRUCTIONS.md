# Update the existing Matesther client site without losing any records

Keep the current prototype Netlify site and its Supabase database untouched. Apply this only to the Supabase project used by your **client** Netlify site. There is **one safe SQL file**, not a replacement schema. Netlify deploys code, but it does not automatically update Supabase tables.

1. In Supabase, confirm the project name/reference belongs to the client Netlify `DATABASE_URL`. Make a database backup or confirm your restore plan before changing tables.
2. Open that project's **SQL Editor**, paste all of `deploy/upgrade-current-client.sql`, and Run. This upgrade is additive and repeatable. It creates any missing document/branding tables and adds nullable size, colour, archive date and per-job pay fields. It preserves existing users, workers, production history, receipts, orders and payments. It snapshots older piecework rates.
3. Check the verification query at the bottom of the SQL output. Compare staff, worker, order and production counts with what you expect. There should be no TRUNCATE or DROP.
4. Download this updated application code from Arena and push it to the **client** GitHub repository, not the prototype repository. Do not upload `.env`, `node_modules` or `.next`. Netlify rebuilds automatically from that repository.
5. In the client Netlify site's Deploys tab, wait until the new deploy says Published. Reload the client app. On your Owner dashboard, click Inspection Queue; you can inspect and approve exactly as the Project Manager can. The PM still cannot see company finances.
6. On an order, click **Start Production**. Pick garment, one size, colour, batch quantity, a Cutter and their agreed per-piece price, and optionally a Tailor and their separate per-piece price. Make another batch for another size or colour. For later stages use Active Production to assign a worker and agreed rate.
7. On **Users**, you can create a Worker login without first adding the production record. When ready, create that person under **Workers** with the same full name. Their jobs and earnings will appear. Existing Worker logins do not need to be deleted. A unique exact name match is required; the app never shows somebody else's jobs.
8. On **Workers**, unused people can be deleted. Anyone with a job or payment history is archived instead. Click **Show archived** to review or restore them. History is never deleted just to clean the active list.
9. The letterheaded payment receipts and delivery sheets remain available under Orders > Payments and Packing & Delivery. If the original Matesther logo is not yet uploaded, the Owner can upload it in Settings > Original company logo.

## One login for a cutter who also supervises production

Use **one existing email and password**. An inspector who also cuts uniforms needs one Project Manager account linked to their existing Cutter record, not a second Worker login.

1. As Owner, open **Workers** and confirm the person has an active Cutter profile. Optionally tick **Also inspects production work**.
2. Open **Users > Manage** on their current account. If they already sign in as Worker, change its role to **Project Manager**, select their Cutter profile under **Also works in the factory**, and save. If they already sign in as Project Manager, just select their Cutter profile and save. Their current email/password and cutter work history remain.
3. After signing back in, their sidebar has Production Dashboard, Assign Production, Inspection Queue, My Jobs, My Journal, My Earnings and My Profile. Their personal earnings show **only their own work**; company revenue, expenses, balances and reports stay Owner-only.
4. On **Assign Production**, select a school order, garment, size and colour, then agree the Cutter and Tailor rates for that batch. Use **Active Production** to assign a worker and rate to later stages. An Owner may do all of these tasks too.
5. In **Inspection Queue**, jobs are separated by school/order. Open one school and one job to record Approved, Rework and Rejected quantities. The signed-in inspector is recorded automatically. Add a reason for rework or rejection.

This particular release adds no new database fields beyond those already described in `deploy/upgrade-current-client.sql`. If that file has already been applied to the **client** Supabase project, push the updated code to the client GitHub repository and wait for Netlify to publish. If it has **not** been applied, make a backup and run it in the correct client Supabase project **before** deploying this code. It is designed to be repeatable and preserves business records.

## Release: a real lifecycle for tailor support work

This release adds **four nullable columns** to `support_assignments` and **one new append-only table**, `support_status_events`. Both are additive.

1. **Back up the client database first.**
2. In the client project's **SQL Editor**, paste all of `deploy/upgrade-support-lifecycle.sql` and Run. It is additive and repeatable: 4 `ADD COLUMN IF NOT EXISTS`, 4 `CREATE INDEX IF NOT EXISTS`, one `CREATE TABLE IF NOT EXISTS` and 4 guarded `ADD CONSTRAINT`. There is no `DROP`, no `TRUNCATE`, no `DELETE`, no `RENAME`, no change to any existing column's type, default or meaning, and **it writes no data at all** - no backfill, no restatement, and no event invented for work already recorded.
3. Run the verification query at the bottom of the file. Expect `new_columns = 4`, `support_events_table = 1`, `support_event_indexes = 3`, `support_status_index = 1`, `support_event_fks = 4`, and the `support_assignments` and `support_inspections` counts **unchanged** from before you ran it. `backfilled_events` must be **0**: this file never writes a row.
4. Only then deploy the new application code. **SQL first, code second.** The new code writes these columns and this table, so deploying it first would fail. Existing code ignores columns and tables it does not know about, so running the SQL first is harmless.

### What changes for the people using the system

- Support work now moves **ASSIGNED → STARTED → SUBMITTED → APPROVED** (or **REWORK**), and may be **PAUSED** and resumed from work in hand. The helper starts their own work under **Production → Support Work**; a supervisor cannot put somebody else's pieces in motion for them.
- **A helper can no longer submit work they never started.** This is the point of the change, and it is the one behaviour that differs for work not yet submitted. A pause requires a written reason, which is stored and shown.
- **Production → Control now shows support work.** A stage carrying delegated pieces says how many are out, how many are accepted and how many are still owed - and a **paused or rework support operation is reported as blocking**, so the board no longer shows a stage as ordinary work in progress while the support that stage depends on is standing still.
- Every transition is recorded in `support_status_events` with **the person who made it**, taken from the session. An actor named in a request body is ignored.

### What it deliberately does not do

Nothing already recorded is rewritten. Every existing `support_assignment` keeps `NULL` for all four new columns and gets no events, because that is the truth about it: the system did not record when that helper began. Inventing a start time would put a fabricated timestamp behind a payroll figure. Existing assignments also keep their existing status - `ASSIGNED`, `SUBMITTED`, `APPROVED`, `REWORK` and `CANCELLED` are all still legal states in the new lifecycle, so nothing becomes invalid or unreadable.

The same change is recorded for the ORM as `drizzle/0011_support_lifecycle.sql`. Do **not** run `drizzle-kit migrate` against production; the SQL Editor route above is the supported path.

## Release: an audited administrative cleanup for test records

This release adds **two new tables**, `order_deletions` and `test_data_purges`. Nothing existing is altered.

1. **Back up the client database first.** This release adds a screen that can remove an order, so the backup is not a formality.
2. In the client project's **SQL Editor**, paste all of `deploy/upgrade-test-data-cleanup.sql` and Run. It is additive and repeatable: 2 `CREATE TABLE IF NOT EXISTS`, 8 `CREATE INDEX IF NOT EXISTS` and 4 guarded `ADD CONSTRAINT`. There is no `DROP`, no `TRUNCATE`, no `DELETE`, no `RENAME`, no `ALTER` of any existing table, and **it writes no data at all**. Both tables are created empty, because nothing has been deleted yet that could honestly be recorded.
3. Run the verification query at the bottom of the file. Expect `audit_tables = 2`, `deletion_indexes = 4`, `purge_indexes = 4`, `deletion_fks = 2`, `purge_fks = 2`, and `deletions_recorded = 0` with `purges_recorded = 0`. The `orders`, `payments`, `batches` and `support_assignments` counts must be **unchanged**.
4. Only then deploy the new application code. **SQL first, code second.** The new code writes to both tables, so deploying it first would fail.

### What changes for the people using the system

- **Settings → Test data** is a new **Owner-only** screen for clearing the test order (Glorious Hope School, 50 garments, ₦150,000) before go-live. A Project Manager, a Worker and any other role are refused by the API before anything is read, so the screen is not merely hidden from them.
- It works in **two steps that cannot be collapsed**. First a **dry-run preview** that writes nothing and shows every record that would go, the inventory that would be restored and the payroll that would be affected. Then, and only then, an execution that requires the **exact school name and the exact order number typed out**, a written reason of at least ten characters, and an acknowledgement.
- The preview carries a **fingerprint** of the record ids it counted, recomputed inside the transaction. If anything changed in between, the purge is refused with a 409 and must be previewed again. The same fingerprint makes a **replayed** confirmation refuse, so one authorisation removes one order once.
- An order belonging to **another organisation** answers 404, indistinguishable from an order that does not exist. Nothing about it is disclosed.
- **Inventory is restored rather than lost.** Material issued to the order goes back into `materials.current_stock` using the material system's own formula, and a ready-made garment stays a purchase - it is never turned into raw stock. If reversing a purchase would drive a stock figure negative, the purge **refuses** instead of guessing.
- **Settled payroll is reported and never rewritten.** Worker payments already made for a month the order contributed to are listed for the Owner to see. Payroll has no order column - accrual derives from inspections - so removing the inspections removes the accrual; a payment already banked is a fact and is left alone.
- **Shared master data is never touched**: customers, products, workers, routes, materials and organisations all survive. Only the order and what belongs to it are removed.
- Every purge is recorded permanently in `test_data_purges`, and every ordinary order removal in `order_deletions`, each naming the person who did it and the reason they gave.
- Removing an order the ordinary way now **requires a written reason**, and the orders screen asks for one and shows the server's answer if it refuses.

### What it does NOT do

**It does not weaken the protection you already have.** An order with real approved production and settled payments still cannot be deleted through the ordinary route, and no foreign key was disabled anywhere to make this possible. This is a controlled administrative exception with a typed confirmation, a fingerprint, an audit row and an Owner-only guard - not a general-purpose delete, and not a bypass. It exists to clear one known test order before go-live, and every use of it is recorded.

The same change is recorded for the ORM as `drizzle/0012_deletion_and_purge_audit.sql`. Do **not** run `drizzle-kit migrate` against production; the SQL Editor route above is the supported path.

## Multi-role workers: one person, several roles

This release adds **one new table**, `public.worker_roles`, so a person who cuts and sews is recorded once with two roles instead of twice as two people.

1. Make a database backup, or confirm your restore plan.
2. In the client project's **SQL Editor**, paste all of `deploy/upgrade-multi-role.sql` and Run. It is additive and repeatable: it creates the table and its two constraints, and nothing else. There is no `DROP`, no `TRUNCATE`, no `DELETE`, and no change to any existing column — including `workers.specialty`.
3. Run the verification query at the bottom of that file. Expect `worker_roles_table = 1` and `worker_roles_constraints = 2`, and the worker, production, inspection and payment counts **unchanged** from before you ran it.
4. Only then push the new code. **SQL first, code second.**

Nothing has to be backfilled. The application counts `workers.specialty` as a role the person already holds, so every existing worker keeps working immediately even while `public.worker_roles` is still empty.

After deploying, open **Workers > Edit** on anyone who does more than one job and tick every role they do. Removing a role later never deletes the person or their production and pay history.

The same change is recorded for the ORM as `drizzle/0004_worker_roles.sql`. Do **not** run `drizzle-kit migrate` against production; the SQL Editor route above is the supported path.

## Support work, salaried staff and the monthly bank payment sheet

This release adds **two new tables** and **seven new columns**, all additive.

1. Make a database backup, or confirm your restore plan.
2. In the client project's **SQL Editor**, paste all of `deploy/upgrade-support-payroll.sql` and Run. It is additive and repeatable. There is no `DROP`, no `TRUNCATE`, no `DELETE`, no `RENAME`, and no change to any existing column's type or meaning.
3. Run the verification query at the bottom of that file. Expect `support_tables = 2`, `new_columns = 7`, `duplicate_payment_guard = 1`, and the worker, production, inspection, payment and overtime counts **unchanged**.
4. Only then push the new code. **SQL first, code second.**

After deploying:

- **Workers > Edit** now has Job title and Department, and the role picker includes non-production positions (Security, Sales, IT, Administration, Management, Director, Office Staff) and **Support Worker**. Record a security guard or sales girl once, with their real position - do not give them a Tailor specialty and do not create a second record.
- **Production > Support Work** is where a tailor hands weaving, taping or other supporting work to a helper. The helper submits completed pieces; the tailor who handed it out inspects and approves. **A helper can never approve their own work** - if that person is also a supervisor, the Owner or another supervisor must inspect it. Only approved pieces are paid.
- **Worker Payments** now shows production piecework, support piecework, salary, overtime and other payments separately, with a payment status. Use **Overtime / Other** to record an approved allowance or bonus.
- **Worker Payments > Bank Payment Sheet** opens the Owner-only printable monthly sheet for the bank. Project Managers and Workers cannot open it, and the API behind it refuses them.

The same change is recorded for the ORM as `drizzle/0005_support_work_and_payroll.sql`. Do **not** run `drizzle-kit migrate` against production; the SQL Editor route above is the supported path.

## Release: support-work cost detail, vendor payment detail and material detail

1. **Back up the client database first.**
2. In the client project's **SQL Editor**, paste all of `deploy/upgrade-support-cost-material-detail.sql` and Run. It is additive and repeatable: 15 `ADD COLUMN IF NOT EXISTS`, 5 `CREATE INDEX IF NOT EXISTS`, 5 guarded `ADD CONSTRAINT`. There is no `CREATE TABLE`, no `DROP`, no `TRUNCATE`, no `DELETE`, no `RENAME`, no change to any existing column's type, default or meaning, and **it writes no data at all** - no backfill and nothing to restate.
3. Run verification queries **V1** to **V5** at the bottom of the file. **V2 is the important one**: it proves no material row was touched, that nothing has a returned or wasted quantity yet, and that `total_cost` is still `quantity_used x unit_cost` on every pre-existing row. **V3** proves every support assignment still names a real tailor, so its deduction still lands on the right person.
4. Only then deploy the new application code. **SQL first, code second.** The new code writes to the columns this file adds, so deploying it first would fail.

### What changes in the numbers, and why that is not a restatement

This script alters no row. Two rules change in the **application**, and both are reported rather than hidden:

- **Order profit is now costed in nine categories** - ready-made garments, raw materials, internal labour, machine labour, support labour, outsourced/vendor work, packaging, delivery and other expenses - instead of two. Every line is computed server-side from records the system already keeps; none of it can be typed in by hand. The old formula's answer is still returned beside the new one as `legacy`, so a profit figure reported earlier is never silently overwritten.
- **Support pay is deducted, not added.** A tailor's full piece rate belongs to the garment. If they sew it themselves they keep all of it; if they hand a piece to a helper at an agreed rate, that rate comes **out of** the tailor's commission for the same approved piece. At 300 a shirt with a helper agreed at 30, the helper is paid 30 and the tailor keeps 270 - and the order's labour cost is 300, not 330. Only **approved** pieces move money on either side, at the rate snapshotted when the work was judged.

### The two rules that protect the money

- **A deduction can never make anybody's pay negative.** It comes out of piece-rate earnings - production piecework plus any support piecework the worker earned themselves. Salary, overtime and other approved payments are left alone, because the rule is expressed against the tailor's *piece rate* and carving a helper's rate out of a contracted monthly salary would be inventing a payroll rule Matesther does not have. What a month cannot absorb is **held and reported** (`supportDeductionOwed`) and recovered from the first later month that has piece-rate earnings. It is never written off.
- **A tailor paid a flat monthly salary has no commission to deduct from**, so no deduction arises for them. The helper is still paid by Matesther, and that payment then stands alone as a real extra cost of the order - it does not vanish.

### What changes for the people using the system

- A helper is handed **the exact share of a stage**, not a school to pick from scratch. The order, item, size, colour and stage come with it by inheritance, and the tailor can only hand out work they hold themselves.
- The quantity handed out can never exceed the share. Forty garments can take forty weaves **and** forty tapes, but never forty-one weaves.
- A vendor dispatch now carries **what was promised back, what is owed, what has been paid and the bank reference** it can be matched against. Money already paid can be added to but never quietly reduced - the same protection an accepted quantity already had. A vendor is not a worker: none of this reaches payroll, and ready-made buying is a purchase, never tailor labour.
- Material is tracked as **issued / used / returned / wasted**, against a worker, an exact variant, a timestamp and a written reason. This is the same material system - `materials`, `material_purchases`, `material_usage` - and `materials.current_stock` is still the one and only stock figure. Used and wasted material is costed because both are consumed; returned material is not, and it goes back into stock.
- **Ready-made garments stay out of stock.** A bought-in finished uniform is a purchase with its own cost, linked to the order and its variant. It does not touch `materials.current_stock`, because a finished uniform is not a raw material.

The same change is recorded for the ORM as `drizzle/0009_support_cost_and_material_detail.sql`. Do **not** run `drizzle-kit migrate` against production; the SQL Editor route above is the supported path.

## Release: production allocations - splitting one stage across several workers

1. **Back up the client database first.**
2. In the client project's **SQL Editor**, paste all of `deploy/upgrade-production-allocations.sql` and Run. It is additive and repeatable. There is no `DROP`, no `TRUNCATE`, no `DELETE`, no `RENAME`, no change to any existing column's type or meaning, and **it writes no data at all** - no backfill and nothing to restate.
3. Run verification queries **V1** to **V5** at the bottom of the file. V1 and V2 confirm nothing was written and that every historical inspection is still unattributed, which is what makes pay for existing work resolve exactly as it always has. V3 confirms the two `production_operations` uniqueness guarantees from the earlier upgrades are still in place - they are **kept deliberately**, see below.
4. Only then deploy the new application code. **SQL first, code second.** The new code writes to `production_allocations` and reads `stage_inspections.worker_id`, so deploying it before this file would fail.

### Why nothing had to be dropped

`uniqueIndex(production_operations(production_batch_id, stage))` and `uniqueIndex(production_batch_id, route_position)` are both **kept**. They are what makes a batch's route unambiguous: "the next applicable stage" is found by position, and a duplicate stage row would let one of the two be starved. The limitation they were sometimes blamed for was never theirs - what blocked several workers on one stage was the single `production_operations.worker_id` column, and this release evolves that with a sub-table, the same shape `public.support_assignments` already uses against its parent operation. One stage row, several allocations against it. No competing production system.

### What changes for the people using the system

- A stage can be **split between workers**. 100 navy size-10 polos at SEWING can be 40 to one tailor, 35 to another, 25 to a third - one batch, one variant, one route, three shares. Do it from a production card under Active Production.
- The shares can never add up to more than the stage holds, and what a stage holds comes from what the previous stage approved, not from anything typed in.
- Each worker sees **their own share** on their own screen, not the whole stage, and can only submit against it.
- Work can be **handed over** to another worker. Only work not yet submitted moves: what someone already submitted stays theirs, along with every approval it earns and the pay for it. The closed share is kept with the reason beside the new one.
- Inspecting a split stage asks **whose work was judged**. That is deliberate: deciding which tailor's pieces were the good ones is a fact only the person at the inspection table knows, so it is asked for rather than guessed. A stage with one worker is inspected exactly as before, with no extra step.
- Pay follows the person who made each approved garment, at the rate agreed with that person. Rates may differ between workers on the same stage.
- If a stage is already being worked by one person when it is split, the work they have already submitted is carried into a share of their own first, so it stays attributed to them and counts against the ceiling.

The same change is recorded for the ORM as `drizzle/0008_production_allocations.sql`. Do **not** run `drizzle-kit migrate` against production; the SQL Editor route above is the supported path.

## Release: exact garment variants, production routes, methods and external work

1. **Back up the client database first.**
2. In the client project's **SQL Editor**, paste all of `deploy/upgrade-variants-routes-external.sql` and Run. It is additive and repeatable. There is no `TRUNCATE`, no `DELETE`, no `RENAME`, no change to any existing column's type or meaning, and **it writes no data at all** - no default route row and no backfill. `route_position` stays `NULL` on historical operations and the application falls back to the eight-stage order for them, so no existing batch changes behaviour.
3. **Read the NOTICE / WARNING output.** The one `DROP INDEX` in the file is called out in its header: it removes `order_item_sizes_item_size_unique`, whose rule (one row per item + size) is now *wrong* because it would reject "size M navy" and "size M black" as duplicates. It is replaced inside a pre-flighted block, so if any duplicate variants somehow exist the new index is skipped and the rows are reported instead of anything being deleted. Dropping an index destroys no data.
4. Run verification queries **V1** to **V6** at the bottom of the file. V2 and V4 confirm historical operations defaulted to `INTERNAL` with no route position and that existing batches still have the stage counts they had before. V6 confirms nothing was written.
5. Only then deploy the new application code. **SQL first, code second.** The new code writes to `production_routes`, `production_route_stages` and `external_work_orders` and reads `production_operations.route_position`, so deploying it before this file would fail.

### What changes for the people using the system

- **An order line now records exact garments**: size, colour and quantity. "10 navy blazers in size 8" and "6 black blazers in size 8" are two lines, and production is allocated against them. A line may have a colour and no size, which previously could not be recorded at all. The order page's *Sizes* tab is now *Variants*.
- **Allocation is capped per exact garment**, server-side. Two batches can no longer each stay inside the item and size limits and still over-commit one specific size and colour.
- **A garment follows a ROUTE**, which may be all eight stages, fewer, in a different order, starting later or ending earlier. Routes are defined under **Production → Production Routes**. A batch freezes the route it was created with, so editing or retiring a route changes only batches created afterwards. A garment is therefore never reported as stuck at a stage its own route does not have.
- **Each stage has a production method**: in-house, machine, outsourced, ready-made purchase, or external processing.
- **Assign Production is now generic**: it lists the stages of the chosen route and offers a worker for each one whose role that stage needs, instead of two fixed "Cutting" and "Sewing" boxes.
- **New page: Production → External & Ready-made.** Work that leaves the factory is tracked as sent / returned / accepted / rejected-damaged / short - four separate facts, because 100 sent and 96 back and 94 good is a normal outcome. Only what Matesther **accepts** moves on to the next stage. A bought-in finished garment is recorded as a purchase with its own cost and is never counted as tailor labour or as outsourced production.
- **A stage that has just been given approved work becomes In Progress automatically.** It no longer has to be opened and flipped by hand before the assigned worker can submit.
- Machine stages are Matesther's own equipment: an operator is assigned and submits as usual. Only the cost is treated differently. If a machine is really a service bought in from someone else, set that stage's method to External processing.

The same change is recorded for the ORM as `drizzle/0007_variants_routes_and_external_work.sql`. Do **not** run `drizzle-kit migrate` against production; the SQL Editor route above is the supported path.

## Release: production movement ledger, indexes and quantity integrity

1. **Back up the client database first.**
2. In the client project's **SQL Editor**, paste all of `deploy/upgrade-production-ledger.sql` and Run. It is additive and repeatable. There is no `DROP`, no `TRUNCATE`, no `DELETE`, no `RENAME`, and no change to any existing column's type or meaning. The only writes are `INSERT`s into the brand-new `production_movements` table, and each is guarded so a second run inserts nothing.
3. **Read the NOTICE and WARNING output.** The two new unique indexes are pre-flighted for existing duplicates. If a duplicate exists the index is *skipped* and the offending ids are reported — nothing is deleted to make it fit. Run verification queries **V1** and **V2** at the bottom of the file, decide with the business which row is real, then re-run the file.
4. **Run verification query V3 (the drift check) before deploying the code.** Any row it returns is a quantity counter that disagrees with the ledger behind it — that is, a figure that was changed in the past without an event. V3 changes nothing; it only reports.
5. Only then deploy the new application code. **SQL first, code second.** The new code refuses free-text quantity edits on `PUT /api/operations` and writes to `production_movements`, so deploying it before this file would fail.

### What changes for the people using the system

- The **Qty received / Qty submitted / Qty rejected** boxes are gone from the production job modal and the order page. Those figures are now shown, not typed, because each is the sum of the events that produced it.
- A stage receives **only** what the previous stage approved. That was already the intent; it can no longer be bypassed by typing a larger number.
- A real mis-count is still correctable, through a recorded correction that stores who made it, when, and the written reason. Approved quantity is **never** correctable — it only moves through an inspection by someone other than the person who did the work.
- The Production board now pages 200 jobs at a time with a "Load more" control, and its stage filter is applied by the database.

The same change is recorded for the ORM as `drizzle/0006_production_ledger_and_indexes.sql`. Do **not** run `drizzle-kit migrate` against production; the SQL Editor route above is the supported path. Note that the `deploy/` file additionally pre-flights the unique indexes, which the `drizzle/` file does not.

**Never run `deploy/full-setup.sql` or `deploy/schema-only.sql` on an existing client project.** Those files are for brand-new empty databases; `full-setup.sql` contains a destructive demo-data reset.

### A brand-new client database needs the whole chain, not just `schema-only.sql`

`deploy/schema-only.sql` is the BASE schema only. It has not been regenerated since roughly
migration 0003, so on its own it does not create `worker_roles`, `support_assignments`,
`support_inspections`, `production_movements`, `production_routes`, `production_route_stages`,
`external_work_orders`, `production_allocations`, `support_status_events`, `order_deletions` or
`test_data_purges`. A new site built from that file alone will not run.

After `schema-only.sql`, run every `deploy/upgrade-*.sql` in release order - the sections above are
in that order, newest first, so read them bottom-up - ending with
`upgrade-support-lifecycle.sql` and `upgrade-test-data-cleanup.sql`. Each is additive and
repeatable, and each says at the bottom which `drizzle/` migration it corresponds to.

**Do not "fix" `schema-only.sql` by regenerating it from the Drizzle migrations.** It contains ten
`ENABLE ROW LEVEL SECURITY` / `REVOKE ALL` statements that protect the base tables from
Supabase's `anon` and `authenticated` API roles, and **no `drizzle/` migration contains any RLS or
grant statement at all**. Regenerating it from the migrations would produce a complete schema with
no RLS, which is worse than an incomplete schema with it. Bringing that file current means
regenerating the tables AND re-applying the RLS block, and deciding whether the tables added since
(`production_movements`, `production_allocations` and the rest) also need RLS - several of the later
upgrade scripts add RLS for their own tables and several do not. That is a piece of work in its own
right, not a side effect of a feature release.
