-- MATESTHER CLIENT: THE AUDIT TRAIL BEHIND ORDER REMOVAL AND TEST-DATA CLEANUP.
-- Make a backup first (pg_dump, or your host's snapshot). Run this in the SQL Editor
-- of the project used by your CLIENT site. Safe to run more than once.
--
-- WHAT THIS DOES
--   1. Creates public.order_deletions: one row per order removed, carrying who removed
--      it, why, the school and order number it was, and the money and production
--      figures it held at the moment it went.
--   2. Creates public.test_data_purges: one row per administrative test-data cleanup,
--      carrying who ran it, the confirmation they typed, the exact record counts the
--      preview promised, and what the purge actually removed.
--   3. Indexes both by order and by actor, so "what happened to this order" and "what
--      has this person removed" are both direct lookups.
--   4. Adds nothing to any existing table. No column, no index, no constraint on a
--      table that already exists.
--
-- WHY
--   Removing an order was previously one unguarded statement - `delete from orders
--   where id = ?` - which cascaded away the order's items, variants, batches, stages,
--   movement ledger, allocations, inspections, quality checks, rework, receipts,
--   packing records and deliveries, leaving no trace that any of it had existed. After
--   it ran there was nothing to read: no record of who did it, why, or what was lost.
--   The refusal itself - an order with approved production, settled payments or a
--   delivery cannot be removed this way - now lives in the API. This file is the record
--   of the cases the API allows.
--
--   The test-data purge is the same problem with higher stakes: it is deliberately able
--   to remove an order that HAS approved production and settled money, because that is
--   what clearing test records before go-live requires. An act that strong has to leave
--   a permanent, specific account of itself - the counts it promised in preview, the
--   counts it achieved, the school and order number it was pointed at, the sentence the
--   Owner typed to confirm, and whether payroll or inventory needed attention
--   afterwards. Without that, "the test order was removed" is indistinguishable from
--   "a real order was removed".
--
-- WHY NOT REUSE production_movements
--   That ledger records quantity events on a production stage and requires a
--   production_operations row to hang from. The rows it would describe here are the
--   ones being deleted, so the events would cascade away with them and the trail would
--   delete itself. A removal has to be recorded somewhere that survives the removal.
--
-- WHY IT IS SAFE
--   Every statement is CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS or a
--   guarded ADD CONSTRAINT. There is no DROP, no TRUNCATE, no DELETE, no RENAME, no
--   change to any existing column's type, default or meaning, and no update to any
--   existing row. IT WRITES NO DATA AT ALL: both tables are created empty, because
--   nothing has been deleted yet that could honestly be recorded.
--
--   Section 4 at the bottom is a self-contained atomicity PROBE. It attempts one insert
--   inside a transaction that is deliberately aborted, which proves on your actual
--   server that a failed cleanup leaves the database untouched. It leaves no residue.
--
-- ORDER OF WORK
--   Run this file BEFORE deploying the code that writes to these tables. The code
--   inserts an audit row inside the same transaction as the removal, so if the tables
--   are missing the removal fails and rolls back - which is the safe direction, but it
--   means order removal is unavailable until this file has run.
--
-- This file is the deploy-script twin of drizzle/0012_deletion_and_purge_audit.sql.
-- If you manage the database with drizzle-kit, run `drizzle-kit migrate` instead of
-- sections 1 and 2, then still run section 3 (verification) and section 4 (the
-- atomicity probe), which the migration does not perform.

-- ---------------------------------------------------------------------------
-- 1. ORDER REMOVALS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "public"."order_deletions" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer,
  -- What was removed, kept as text as well as by id: after the order is gone the id
  -- means nothing on its own, and the number and school are what a person recognises.
  "order_id" integer NOT NULL,
  "order_number" text NOT NULL,
  "customer_name" text,
  "deleted_by_id" integer,
  "deleted_by_name" text NOT NULL,
  -- Required by the API. A deletion with no reason is a deletion nobody can defend.
  "reason" text NOT NULL,
  -- What the order held when it went, so the loss is quantified rather than guessed.
  "total_amount" integer,
  "amount_paid" integer,
  "batch_count" integer,
  "operation_count" integer,
  "payment_count" integer,
  "deleted_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "order_deletions_organization_id_idx" ON "public"."order_deletions" ("organization_id");
CREATE INDEX IF NOT EXISTS "order_deletions_order_id_idx"        ON "public"."order_deletions" ("order_id");
CREATE INDEX IF NOT EXISTS "order_deletions_deleted_by_id_idx"   ON "public"."order_deletions" ("deleted_by_id");
CREATE INDEX IF NOT EXISTS "order_deletions_deleted_at_idx"      ON "public"."order_deletions" ("deleted_at");

-- ---------------------------------------------------------------------------
-- 2. ADMINISTRATIVE TEST-DATA PURGES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "public"."test_data_purges" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer,
  "order_id" integer NOT NULL,
  "order_number" text NOT NULL,
  "customer_name" text,
  -- The confirmation the Owner typed. Stored because the whole control is that a
  -- person wrote the school's name rather than clicked past a dialog.
  "confirmed_customer_name" text NOT NULL,
  "reason" text NOT NULL,
  "ran_by_id" integer,
  "ran_by_name" text NOT NULL,
  -- The counts the PREVIEW promised. Stored beside what actually happened, so a purge
  -- that removed something the preview did not show is visible after the fact and not
  -- only at the moment it was refused.
  "preview_counts" text,
  "preview_fingerprint" text NOT NULL,
  "result_counts" text,
  -- What the purge could not safely undo, reported rather than silently absorbed:
  -- payroll already settled for a month this order contributed to, and any inventory
  -- movement that could not be reversed without risking a wrong stock figure.
  "payroll_report" text,
  "inventory_report" text,
  "ran_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "test_data_purges_organization_id_idx" ON "public"."test_data_purges" ("organization_id");
CREATE INDEX IF NOT EXISTS "test_data_purges_order_id_idx"        ON "public"."test_data_purges" ("order_id");
CREATE INDEX IF NOT EXISTS "test_data_purges_ran_by_id_idx"       ON "public"."test_data_purges" ("ran_by_id");
CREATE INDEX IF NOT EXISTS "test_data_purges_ran_at_idx"          ON "public"."test_data_purges" ("ran_at");

-- Foreign keys are guarded so this whole file can be re-run against an already-upgraded
-- database, which is the house rule for every migration since 0003. The actor references
-- are `set null`: a person leaving must not erase the record of what they removed, and
-- the name columns survive them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.order_deletions'::regclass AND conname = 'order_deletions_organization_id_organizations_id_fk') THEN
    ALTER TABLE "public"."order_deletions" ADD CONSTRAINT "order_deletions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.order_deletions'::regclass AND conname = 'order_deletions_deleted_by_id_users_id_fk') THEN
    ALTER TABLE "public"."order_deletions" ADD CONSTRAINT "order_deletions_deleted_by_id_users_id_fk" FOREIGN KEY ("deleted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.test_data_purges'::regclass AND conname = 'test_data_purges_organization_id_organizations_id_fk') THEN
    ALTER TABLE "public"."test_data_purges" ADD CONSTRAINT "test_data_purges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.test_data_purges'::regclass AND conname = 'test_data_purges_ran_by_id_users_id_fk') THEN
    ALTER TABLE "public"."test_data_purges" ADD CONSTRAINT "test_data_purges_ran_by_id_users_id_fk" FOREIGN KEY ("ran_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. VERIFICATION - run this after the upgrade. It changes nothing.
--
-- EXPECT:
--   audit_tables          = 2
--   deletions_indexes     = 4
--   purges_indexes        = 4
--   deletions_fks         = 2
--   purges_fks            = 2
--   deletions_rows        = 0    (nothing is written by this file)
--   purges_rows           = 0
--   orders / payments / production_batches = UNCHANGED from before you ran this file
-- ---------------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('order_deletions','test_data_purges'))                  AS audit_tables,
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'order_deletions')                AS deletions_indexes,
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'test_data_purges')               AS purges_indexes,
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'public.order_deletions'::regclass AND contype = 'f')        AS deletions_fks,
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'public.test_data_purges'::regclass AND contype = 'f')       AS purges_fks,
  (SELECT count(*) FROM public.order_deletions)                                   AS deletions_rows,
  (SELECT count(*) FROM public.test_data_purges)                                  AS purges_rows,
  (SELECT count(*) FROM public.orders)                                            AS orders,
  (SELECT count(*) FROM public.payments)                                          AS payments,
  (SELECT count(*) FROM public.production_batches)                                AS production_batches;

-- Both tables must be empty and every new column present, with the NOT NULLs the API
-- relies on (an audit row without a reason or an actor name is not an audit row):
--   SELECT column_name, is_nullable, column_default FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name IN ('order_deletions','test_data_purges')
--    ORDER BY table_name, ordinal_position;

-- ---------------------------------------------------------------------------
-- 4. ATOMICITY PROBE - run this ONCE, before relying on the cleanup.
--
-- WHY THIS IS HERE
--   Both destructive acts run as a single database transaction, so on PostgreSQL a
--   failure part-way through must leave the database exactly as it was. The automated
--   suite cannot demonstrate that: it runs on pg-mem, whose adapter does NOT roll back
--   (verified directly, by throwing inside a transaction after an insert and watching
--   the insert survive). The suite therefore asserts the two properties that ARE
--   observable and that the rollback depends on - every refusal happens before any
--   write, and stock is restored from the records being removed inside the same
--   transaction, before they are deleted. This probe covers the remaining half on a
--   real server.
--
-- WHAT IT TOUCHES
--   Nothing. It attempts one INSERT into public.order_deletions inside a transaction
--   that is then deliberately aborted, so the row must never land - and proving that it
--   does not land IS the test. A rolled-back insert needs no cleanup, so the probe
--   leaves no residue and cannot orphan a row. No application data is read, updated or
--   deleted, and no temporary object is created.
--
--   (An earlier draft of this probe used a TEMP table with ON COMMIT DROP. That was
--   wrong: the abort that proves rollback also drops the table, so the query meant to
--   count the surviving rows would fail on a relation that no longer exists. Writing to
--   the real audit table instead is both simpler and a truer test - it is the same table
--   the cleanup writes to.)
--
-- EXPECT, in order:
--   a. the DO block raises:            probe: deliberate abort
--   b. rolled_back_insert  = 0         the aborted transaction undid its own insert
--   c. purge_rows          = 0         nothing else was written anywhere
--
-- If (b) is anything other than 0, STOP: transactions are not rolling back on this
-- server, and neither order removal nor the test-data cleanup may be used until that is
-- understood - both would be able to leave the database half-changed.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- Every NOT NULL column without a default is supplied, so this INSERT is valid and
  -- the only reason it can fail to appear is the rollback under test.
  INSERT INTO public.order_deletions
    (order_id, order_number, deleted_by_name, reason)
  VALUES
    (0, 'PROBE-ROLLED-BACK', 'atomicity probe',
     'This row was inserted inside a transaction that was then deliberately aborted. If you can read it, rollback is not working.');
  RAISE EXCEPTION 'probe: deliberate abort';
END $$;
-- Some SQL editors stop at the first error. If yours did, that error IS step (a): it is
-- the probe behaving correctly, not a failure of the upgrade. Re-run from the SELECT
-- below rather than re-running the whole file.

SELECT
  (SELECT count(*) FROM public.order_deletions
    WHERE order_number = 'PROBE-ROLLED-BACK') AS rolled_back_insert,
  (SELECT count(*) FROM public.order_deletions) AS deletion_rows,
  (SELECT count(*) FROM public.test_data_purges) AS purge_rows;

-- ---------------------------------------------------------------------------
-- 5. AFTER DEPLOYING THE CODE - the trail working end to end.
--
-- Remove a test order through the UI (Settings > Test data cleanup, which previews
-- first and requires the school's name typed back), then read what was recorded:
--   SELECT order_number, customer_name, ran_by_name, reason,
--          preview_counts, result_counts, payroll_report, inventory_report, ran_at
--     FROM public.test_data_purges
--    ORDER BY ran_at DESC, id DESC
--    LIMIT 20;
--
-- The ordinary order-removal path (an order with no approved production, no payments
-- and no delivery) records here instead:
--   SELECT order_number, customer_name, deleted_by_name, reason,
--          total_amount, amount_paid, batch_count, deleted_at
--     FROM public.order_deletions
--    ORDER BY deleted_at DESC, id DESC
--    LIMIT 20;
--
-- CHECK: preview_counts and result_counts should agree. If result_counts shows MORE
-- removed than the preview promised, the fingerprint guard failed to notice a change
-- between preview and execution - treat that as a bug and report it, because the whole
-- point of storing both is to make that visible after the fact.
-- ---------------------------------------------------------------------------
