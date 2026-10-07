-- ADDITIVE MIGRATION: an audit trail for the two destructive administrative acts in
-- Matesther - removing an order, and purging a test order before the business goes live.
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
--
-- WHY THESE TABLES EXIST
--   Deleting an order was previously one unguarded statement - `delete from orders
--   where id = ?` - which cascaded away the order's items, variants, batches, stages,
--   movement ledger, allocations, inspections, quality checks, rework, receipts,
--   packing records and deliveries, leaving no trace that any of it had existed. After
--   it ran there was nothing to read: no record of who did it, why, or what was lost.
--   The protection against deleting an order that has real work behind it now exists in
--   the API, and this is the record of the cases it allows.
--
--   The test-data purge is the same problem with higher stakes: it is deliberately able
--   to remove an order that HAS approved production and settled money, because that is
--   what clearing test records before the November go-live requires. An act that strong
--   has to leave a permanent, specific account of itself - the counts it promised in
--   preview, the counts it achieved, the school and order number it was pointed at, the
--   sentence the Owner typed to confirm, and whether payroll or inventory needed
--   attention afterwards. Without that, "the test order was removed" is indistinguishable
--   from "a real order was removed".
--
-- WHY NOT REUSE production_movements
--   That ledger records quantity events on a production stage, and requires a
--   production_operations row to hang from. The rows it would describe here are the
--   ones being deleted, so the events would cascade away with them and the trail would
--   delete itself. A removal has to be recorded somewhere that survives the removal.
--
-- WHAT THIS NEVER DOES
--   * no DROP, no TRUNCATE, no DELETE, no RENAME,
--   * no change to any existing column's type, default or meaning,
--   * no update to any existing row in any existing table.
--     IT WRITES NO DATA AT ALL. Both tables are created empty, because nothing has been
--     deleted yet that could honestly be recorded.
--
-- Every statement is idempotent, matching drizzle/0005 through 0011. Against an
-- up-to-date database this migration is a complete no-op.
--
-- NOTE ON THE GUARD BLOCK
--   pg-mem has no plpgsql interpreter, so tests/support/preload.cjs unwraps the ALTER
--   TABLE statements inside the DO block and runs them directly against a database that
--   is always created empty, where the guard could never fire. The resulting schema is
--   identical. This is the arrangement migrations 0003 through 0011 rely on.

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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_deletions_organization_id_idx" ON "order_deletions" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_deletions_order_id_idx" ON "order_deletions" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_deletions_deleted_by_id_idx" ON "order_deletions" ("deleted_by_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_deletions_deleted_at_idx" ON "order_deletions" ("deleted_at");--> statement-breakpoint

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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_data_purges_organization_id_idx" ON "test_data_purges" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_data_purges_order_id_idx" ON "test_data_purges" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_data_purges_ran_by_id_idx" ON "test_data_purges" ("ran_by_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "test_data_purges_ran_at_idx" ON "test_data_purges" ("ran_at");--> statement-breakpoint

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

-- ---------- VERIFICATION (run these after applying; they change nothing) ----------
-- EXPECT: both tables present, 4 indexes each, 2 foreign keys each, both empty.
--   SELECT tablename FROM pg_tables
--    WHERE schemaname = 'public' AND tablename IN ('order_deletions','test_data_purges');
--   SELECT tablename, count(*) AS indexes FROM pg_indexes
--    WHERE schemaname = 'public' AND tablename IN ('order_deletions','test_data_purges')
--    GROUP BY tablename;
--   SELECT conrelid::regclass AS table_name, count(*) AS fks FROM pg_constraint
--    WHERE conrelid IN ('public.order_deletions'::regclass,'public.test_data_purges'::regclass)
--      AND contype = 'f'
--    GROUP BY conrelid;
--   SELECT (SELECT count(*) FROM public.order_deletions) AS deletions,
--          (SELECT count(*) FROM public.test_data_purges) AS purges;
-- Nothing existing was touched:
--   SELECT (SELECT count(*) FROM public.orders) AS orders,
--          (SELECT count(*) FROM public.payments) AS payments,
--          (SELECT count(*) FROM public.production_batches) AS batches;
