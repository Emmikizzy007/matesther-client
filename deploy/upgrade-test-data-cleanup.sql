-- MATESTHER CLIENT: THE AUDIT TRAIL BEHIND ORDER REMOVAL AND TEST-DATA CLEANUP.
-- Make a backup first (pg_dump, or your host's snapshot). Run this in the SQL Editor
-- of the project used by your CLIENT site. Safe to run more than once.
--
-- HOW TO RUN IT
--   Paste this WHOLE file into the SQL Editor and press Run, once. It applies the
--   upgrade, commits it, and then prints the verification figures, so a single paste
--   both does the work and tells you whether the work is right. Nothing in this file
--   is designed to fail, and nothing in it raises an error on purpose.
--
--   One warning is normal and can be ignored: if your editor already wraps a pasted
--   script in a transaction of its own, the explicit BEGIN below reports
--   `WARNING: there is already a transaction in progress`. That is the editor's
--   transaction and this file's transaction being the same one. It is not an error
--   and it changes nothing.
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
--   4. Adds the four foreign keys, guarded so a second run skips them.
--   5. Adds nothing to any existing table. No column, no index, no constraint on a
--      table that already exists.
--
-- WHY THIS FILE OPEN ITS OWN TRANSACTION
--   It used not to, and that was a real defect. Without an explicit BEGIN and COMMIT
--   the transactional behaviour of a pasted script is decided by the client rather than
--   by the file: PostgreSQL runs the statements of one multi-statement query in a single
--   implicit transaction block, so whether the objects survived depended on how the
--   editor chose to submit them.
--
--   That ambiguity cost a production run. This file previously ended with an atomicity
--   probe - a deliberate `RAISE EXCEPTION` meant to prove that an aborted transaction
--   undoes its own writes. Pasted as part of the whole file, and with no COMMIT before
--   it, the probe aborted the ONE transaction everything else was in and rolled the
--   entire upgrade back with it. The database was left unchanged and unharmed, which was
--   the safe outcome, but the person deploying saw an error and had no way to tell from
--   the script alone whether the tables had been created.
--
--   Both halves of that are now fixed. The schema changes are wrapped in an explicit
--   BEGIN and COMMIT, so they are applied and committed the same way in every client,
--   and no statement in this file can fail on purpose. The probe still exists, because
--   the property it tests is still worth testing, but it lives in its own file -
--   deploy/verify-atomicity-probe.sql - which is optional, is run separately, is run
--   AFTER this upgrade, and produces its verdict without raising an error.
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
--   existing row. Nothing is written to any table that already exists, and both new
--   tables are created empty, because nothing has been deleted yet that could honestly
--   be recorded. Against an already-upgraded database this whole file is a no-op that
--   reports the same figures again.
--
--   `order_deletions.order_id` deliberately has NO foreign key. The trail has to
--   survive the row it describes, and a foreign key would either block the removal or
--   cascade the record away with it.
--
-- ORDER OF WORK (as always): run this SQL FIRST, then deploy the new code. The new
-- code writes to both tables, so deploying it first would fail. Existing code ignores
-- tables it does not know about, so running this first is harmless.
--
-- The same change is recorded for the ORM as drizzle/0012_deletion_and_purge_audit.sql.
-- Do NOT run `drizzle-kit migrate` against production; the SQL Editor route above is
-- the supported path. That migration carries no BEGIN or COMMIT of its own, because
-- drizzle-kit owns the transaction when it applies a migration - which is also why this
-- file, which a person applies by hand, has to own it itself.
--
-- If you manage the database with drizzle-kit, run `drizzle-kit migrate` instead of
-- sections 1 and 2, then still run section 3 (verification).

-- ---------------------------------------------------------------------------
-- THE UPGRADE. One transaction: either every object below is created, or none
-- of them is. COMMIT follows the last foreign key, before any verification, so
-- the queries in section 3 read committed objects even in an editor that
-- submits a pasted script as a single statement batch.
-- ---------------------------------------------------------------------------
BEGIN;

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

COMMIT;

-- ---------------------------------------------------------------------------
-- 3. VERIFICATION - this runs after the COMMIT above, so it reads committed
--    objects. It changes nothing. Paste the whole file and these figures are
--    printed for you; you do not have to run this section separately.
--
-- EXPECT:
--   audit_tables       = 2
--   deletions_indexes  = 5
--   purges_indexes     = 5
--   deletions_fks      = 2
--   purges_fks         = 2
--   deletions_columns  = 14
--   purges_columns     = 15
--
-- WHY THE INDEX FIGURES ARE 5 AND NOT 4
--   An earlier revision of this file said 4, and that was wrong in a way that would
--   have made a correct upgrade look like a broken one. Each table declares
--   `"id" serial PRIMARY KEY`, and PostgreSQL backs a primary key with its own index -
--   `order_deletions_pkey` and `test_data_purges_pkey`. `pg_indexes` lists those too,
--   so the honest count is the four indexes created below plus the primary key: 5.
--   Getting 5 means the upgrade worked.
--
-- These queries read the catalogues by name rather than casting to `::regclass` or
-- selecting from the new tables, so they return zeros instead of raising
-- `relation ... does not exist` if the upgrade somehow did not apply. A verification
-- step that can fail with a second, unrelated error is no use to the person reading it.
-- ---------------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname IN ('order_deletions','test_data_purges'))                     AS audit_tables,
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'order_deletions')                 AS deletions_indexes,
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'test_data_purges')                AS purges_indexes,
  (SELECT count(*) FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'order_deletions'
      AND con.contype = 'f')                                                       AS deletions_fks,
  (SELECT count(*) FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'test_data_purges'
      AND con.contype = 'f')                                                       AS purges_fks,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'order_deletions')              AS deletions_columns,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'test_data_purges')             AS purges_columns;

-- Run this second query ONLY once the one above reports audit_tables = 2, because it
-- reads the new tables directly and would raise if they were not there.
--
-- EXPECT:
--   deletions_rows = 0 and purges_rows = 0   (this file writes no data at all)
--   orders / payments / production_batches   = UNCHANGED from before you ran this file
SELECT
  (SELECT count(*) FROM public.order_deletions)                                    AS deletions_rows,
  (SELECT count(*) FROM public.test_data_purges)                                   AS purges_rows,
  (SELECT count(*) FROM public.orders)                                             AS orders,
  (SELECT count(*) FROM public.payments)                                           AS payments,
  (SELECT count(*) FROM public.production_batches)                                 AS production_batches;

-- The foreign keys, spelled out rather than counted. EXPECT two rows per table:
-- `organization_id` ON DELETE NO ACTION, and the actor reference ON DELETE SET NULL,
-- so a person leaving does not erase the record of what they removed. There is
-- deliberately NO foreign key on either `order_id`.
SELECT c.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS definition
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('order_deletions','test_data_purges')
   AND con.contype = 'f'
 ORDER BY c.relname, con.conname;

-- Both tables must be empty and every new column present, with the NOT NULLs the API
-- relies on (an audit row without a reason or an actor name is not an audit row).
-- EXPECT 14 rows for order_deletions and 15 for test_data_purges; NOT NULL on
-- id, order_id, order_number, deleted_by_name and reason in the first, and on
-- id, order_id, order_number, confirmed_customer_name, reason, ran_by_name and
-- preview_fingerprint in the second; a default only on each `id` and each timestamp.
SELECT table_name, ordinal_position, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name IN ('order_deletions','test_data_purges')
 ORDER BY table_name, ordinal_position;

-- ---------------------------------------------------------------------------
-- 4. OPTIONAL, SEPARATE, AND NOT PART OF THIS UPGRADE
--
-- deploy/verify-atomicity-probe.sql proves that this server really does undo the
-- writes of a transaction it rolls back - the property both destructive acts in the
-- application depend on, and the one the automated suite cannot test because it runs
-- on pg-mem, which does not roll back.
--
-- It is a SEPARATE file on purpose. Run it only after this upgrade has been applied
-- and verified, and run it on its own. It is safe and it leaves nothing behind, but it
-- is a test, not a schema change, and mixing a test into a migration is what made the
-- previous revision of this file roll itself back.
-- ---------------------------------------------------------------------------

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
