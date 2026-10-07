-- MATESTHER CLIENT: A PERMANENT RECORD OF THE TWO DESTRUCTIVE ADMINISTRATIVE ACTS.
-- Make a backup first. Run this in the SQL Editor of the project used by your
-- CLIENT site. Safe to run more than once.
--
-- WHAT THIS DOES
--   1. Creates public.order_deletions: one row per order removed, carrying who removed
--      it, why, the school and order number it was, and the money and production
--      figures it held at the moment it went.
--   2. Creates public.test_data_purges: one row per administrative test-data cleanup,
--      carrying who ran it, the confirmation sentence they typed, the exact record
--      counts the preview promised, and what the purge actually removed.
--   3. Indexes both by order, by actor and by date, so "what happened to this order"
--      and "what has this person removed" are both direct lookups rather than scans.
--
-- WHY
--   Removing an order was previously one unguarded statement - `delete from orders
--   where id = ?` - which cascaded away that order's items, variants, batches, stages,
--   movement ledger, allocations, inspections, quality checks, rework, receipts,
--   packing records and deliveries, and left no trace that any of it had existed.
--   Afterwards there was nothing to read: no record of who did it, why, or what was lost.
--
--   This release adds a controlled administrative cleanup for test records, under
--   Settings > Test data. It is deliberately able to remove an order that HAS approved
--   production and settled money, because clearing the test order before go-live
--   requires exactly that. An act that strong has to leave a permanent, specific account
--   of itself: the counts promised in preview beside the counts achieved, the school and
--   order number it was pointed at, the sentence the Owner typed to confirm it, and
--   whether payroll or inventory needed attention afterwards. Without that record,
--   "the test order was removed" is indistinguishable from "a real order was removed".
--
-- WHY NOT REUSE production_movements
--   That ledger records quantity events on a production stage and requires a
--   production_operations row to hang from. The rows it would describe here are the ones
--   being deleted, so the events would cascade away with them and the trail would delete
--   itself. A removal has to be recorded somewhere that survives the removal.
--
-- WHY IT IS SAFE
--   Every statement is CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS or a
--   guarded ADD CONSTRAINT. There is no DROP, no TRUNCATE, no DELETE, no RENAME, no
--   ALTER of any existing table, no NOT NULL and no default added to anything that
--   already exists, and NO DATA WRITE OF ANY KIND - no backfill, nothing to restate.
--   Both tables are created empty, because nothing has been deleted yet that could
--   honestly be recorded. Against an up-to-date database this file is a complete no-op.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   It does not weaken anything. No existing constraint, trigger or column is altered,
--   and no existing table gains a cascade. The protection that stops an order with real
--   approved production and settled payments from being deleted lives in the
--   application and is untouched by this file - what this file adds is the record of
--   the cases that protection allows.
--
-- ORDER OF WORK (as always): run this SQL FIRST, then deploy the new code. The new code
-- writes to these two tables, so deploying the code before they exist would fail.
-- Existing code ignores tables it does not know about, so running this first is harmless.
--
-- The same change is recorded for the ORM as drizzle/0012_deletion_and_purge_audit.sql.
-- Do NOT run drizzle-kit migrate against production; the SQL Editor route above is the
-- supported path.

-- ---------------------------------------------------------------------------
-- 1. ORDER REMOVALS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "order_deletions" (
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
CREATE INDEX IF NOT EXISTS "order_deletions_organization_id_idx" ON "order_deletions" ("organization_id");
CREATE INDEX IF NOT EXISTS "order_deletions_order_id_idx" ON "order_deletions" ("order_id");
CREATE INDEX IF NOT EXISTS "order_deletions_deleted_by_id_idx" ON "order_deletions" ("deleted_by_id");
CREATE INDEX IF NOT EXISTS "order_deletions_deleted_at_idx" ON "order_deletions" ("deleted_at");

-- ---------------------------------------------------------------------------
-- 2. ADMINISTRATIVE TEST-DATA PURGES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "test_data_purges" (
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
	-- The counts the PREVIEW promised. Stored beside what actually happened, so a
	-- purge that removed something the preview did not show is visible after the fact
	-- and not only at the moment it was refused.
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
CREATE INDEX IF NOT EXISTS "test_data_purges_organization_id_idx" ON "test_data_purges" ("organization_id");
CREATE INDEX IF NOT EXISTS "test_data_purges_order_id_idx" ON "test_data_purges" ("order_id");
CREATE INDEX IF NOT EXISTS "test_data_purges_ran_by_id_idx" ON "test_data_purges" ("ran_by_id");
CREATE INDEX IF NOT EXISTS "test_data_purges_ran_at_idx" ON "test_data_purges" ("ran_at");

-- Foreign keys are guarded so the whole file can be re-run against an already-upgraded
-- database, which is the house rule for every migration since 0003. The actor
-- references are `set null`: a person leaving must not erase the record of what they
-- removed, and the name columns survive them.
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
-- VERIFICATION - run these after the upgrade. They change nothing.
--
-- EXPECT:
--   audit_tables        = 2
--   deletion_indexes    = 4
--   purge_indexes       = 4
--   deletion_fks        = 2
--   purge_fks           = 2
--   deletions_recorded  = 0   (nothing has been removed yet)
--   purges_recorded     = 0   (this file writes no data)
--   orders / payments / batches / support_assignments = UNCHANGED from the counts
--                                                       you saw before running it
-- ---------------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('order_deletions','test_data_purges'))             AS audit_tables,
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'order_deletions')          AS deletion_indexes,
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'test_data_purges')         AS purge_indexes,
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'public.order_deletions'::regclass AND contype = 'f')  AS deletion_fks,
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'public.test_data_purges'::regclass AND contype = 'f') AS purge_fks,
  (SELECT count(*) FROM public.order_deletions)                             AS deletions_recorded,
  (SELECT count(*) FROM public.test_data_purges)                            AS purges_recorded,
  (SELECT count(*) FROM public.orders)                                      AS orders,
  (SELECT count(*) FROM public.payments)                                    AS payments,
  (SELECT count(*) FROM public.production_batches)                          AS batches,
  (SELECT count(*) FROM public.support_assignments)                         AS support_assignments;

-- AFTER DEPLOYING THE CODE, this is the trail working. Remove any order the API allows
-- to be removed, and expect one row here naming the person who did it and why:
--   SELECT order_number, customer_name, deleted_by_name, reason,
--          total_amount, amount_paid, batch_count, operation_count, payment_count, deleted_at
--     FROM public.order_deletions
--    ORDER BY id DESC;
--
-- And after an Owner runs a test-data cleanup under Settings > Test data, expect one row
-- here carrying the sentence they typed, and the counts the preview promised beside the
-- counts actually removed:
--   SELECT order_number, customer_name, confirmed_customer_name, ran_by_name, reason,
--          preview_counts, result_counts, payroll_report, inventory_report, ran_at
--     FROM public.test_data_purges
--    ORDER BY id DESC;
