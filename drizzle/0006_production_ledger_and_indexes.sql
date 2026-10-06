-- ADDITIVE MIGRATION: production movement ledger, missing indexes, and the two
-- uniqueness guarantees the production model has always assumed but never had.
--
-- WHAT THIS DOES
--   1. Creates public.production_movements: an append-only ledger of every event
--      that changes a production quantity (allocation, stage receipt, submission,
--      inspection outcome, reassignment, audited correction). The seven counters
--      on production_operations become a derived cache of this table.
--   2. Creates the indexes this database has never had. Before this migration the
--      only indexes were primary keys and five unique constraints, so every
--      foreign-key lookup was a sequential scan.
--   3. Adds two unique indexes that the application logic already assumes:
--        production_operations (production_batch_id, stage) - one row per stage
--          per batch. POST /api/inspections finds the next stage with
--          `siblings.find(...)` and takes the FIRST match, so a duplicate row
--          would silently starve one of the two.
--        order_item_sizes (order_item_id, size) - POST /api/order-sizes replaces
--          the whole set, so a duplicate pair could only come from a bug.
--   4. Backfills INFERRED ledger rows for production that predates the ledger, so
--      derivation has a basis for historical batches too.
--
-- WHAT THIS NEVER DOES
--   * no DROP, no TRUNCATE, no DELETE, no RENAME,
--   * no change to any existing column's type, default or meaning,
--   * no update to any existing row in any existing table.
--     The only writes are INSERTs into the brand-new production_movements table.
--
-- Every statement is idempotent, matching the house style of
-- drizzle/0003_catchup_live_schema.sql and drizzle/0005_support_work_and_payroll.sql.
-- Against an up-to-date database this migration is a complete no-op.
--
-- PRODUCTION NOTE: the Matesther production database is upgraded by running the
-- deploy/*.sql files in the Supabase SQL Editor, not by `drizzle-kit migrate`;
-- see deploy/UPDATE-INSTRUCTIONS.md. deploy/upgrade-production-ledger.sql is the
-- operator copy of this file and additionally PRE-FLIGHTS the two unique indexes
-- for existing duplicates and reports rather than fails. Run that one, not this.--
-- NOTE: the SQL text below was made idempotent after drizzle-kit generated it,
-- and the five backfill INSERTs were added by hand, so its hash differs from the
-- pristine generator output. drizzle/meta/0006_snapshot.json is the untouched
-- generator snapshot and is what keeps a future `drizzle-kit generate` from
-- re-emitting these objects. The Matesther production database is upgraded by
-- running the deploy/*.sql files in the SQL Editor, not by `drizzle-kit migrate`;
-- see deploy/UPDATE-INSTRUCTIONS.md.

CREATE TABLE IF NOT EXISTS "production_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"production_operation_id" integer NOT NULL,
	"production_batch_id" integer NOT NULL,
	"stage" text NOT NULL,
	"event_type" text NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"worker_id" integer,
	"actor_user_id" integer,
	"actor_name" text NOT NULL,
	"source" text DEFAULT 'LIVE' NOT NULL,
	"reference_type" text,
	"reference_id" integer,
	"reason" text,
	"notes" text,
	"occurred_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_movements_operation_id_idx" ON "production_movements" ("production_operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_movements_batch_id_idx" ON "production_movements" ("production_batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_movements_event_type_idx" ON "production_movements" ("event_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_movements_occurred_at_idx" ON "production_movements" ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_organization_id_idx" ON "users" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_expires_at_idx" ON "sessions" ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_customer_id_idx" ON "orders" ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_status_idx" ON "orders" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_due_date_idx" ON "orders" ("due_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_created_at_idx" ON "orders" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_order_id_idx" ON "order_items" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workers_organization_id_idx" ON "workers" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workers_status_idx" ON "workers" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_item_sizes_order_item_id_idx" ON "order_item_sizes" ("order_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_batches_order_id_idx" ON "production_batches" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_batches_order_item_id_idx" ON "production_batches" ("order_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_operations_batch_id_idx" ON "production_operations" ("production_batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_operations_worker_id_idx" ON "production_operations" ("worker_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_operations_stage_idx" ON "production_operations" ("stage");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_operations_status_idx" ON "production_operations" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stage_inspections_operation_id_idx" ON "stage_inspections" ("production_operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stage_inspections_inspected_at_idx" ON "stage_inspections" ("inspected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_assignments_worker_id_idx" ON "support_assignments" ("worker_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_assignments_assigned_by_idx" ON "support_assignments" ("assigned_by_worker_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_assignments_operation_id_idx" ON "support_assignments" ("production_operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_assignments_order_id_idx" ON "support_assignments" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_inspections_assignment_id_idx" ON "support_inspections" ("support_assignment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_inspections_inspected_at_idx" ON "support_inspections" ("inspected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_purchases_material_id_idx" ON "material_purchases" ("material_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_purchases_order_id_idx" ON "material_purchases" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_usage_order_id_idx" ON "material_usage" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_usage_material_id_idx" ON "material_usage" ("material_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_usage_operation_id_idx" ON "material_usage" ("production_operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expenses_order_id_idx" ON "expenses" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_order_id_idx" ON "payments" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_checks_operation_id_idx" ON "quality_checks" ("production_operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rework_records_operation_id_idx" ON "rework_records" ("production_operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "packing_records_order_id_idx" ON "packing_records" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_payments_worker_id_idx" ON "worker_payments" ("worker_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_payments_period_month_idx" ON "worker_payments" ("period_month");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_overtime_worker_id_idx" ON "worker_overtime" ("worker_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_overtime_worked_on_idx" ON "worker_overtime" ("worked_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deliveries_order_id_idx" ON "deliveries" ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_lines_delivery_id_idx" ON "delivery_lines" ("delivery_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_lines_order_item_id_idx" ON "delivery_lines" ("order_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "production_operations_batch_stage_unique" ON "production_operations" ("production_batch_id","stage");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_item_sizes_item_size_unique" ON "order_item_sizes" ("order_item_id","size");--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_movements'::regclass AND conname = 'production_movements_organization_id_organizations_id_fk') THEN
    ALTER TABLE "public"."production_movements" ADD CONSTRAINT "production_movements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_movements'::regclass AND conname = 'production_movements_production_operation_id_production_operations_id_fk') THEN
    ALTER TABLE "public"."production_movements" ADD CONSTRAINT "production_movements_production_operation_id_production_operations_id_fk" FOREIGN KEY ("production_operation_id") REFERENCES "public"."production_operations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_movements'::regclass AND conname = 'production_movements_production_batch_id_production_batches_id_fk') THEN
    ALTER TABLE "public"."production_movements" ADD CONSTRAINT "production_movements_production_batch_id_production_batches_id_fk" FOREIGN KEY ("production_batch_id") REFERENCES "public"."production_batches"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_movements'::regclass AND conname = 'production_movements_worker_id_workers_id_fk') THEN
    ALTER TABLE "public"."production_movements" ADD CONSTRAINT "production_movements_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_movements'::regclass AND conname = 'production_movements_actor_user_id_users_id_fk') THEN
    ALTER TABLE "public"."production_movements" ADD CONSTRAINT "production_movements_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
-- BACKFILL: reconstruct the ledger for production that predates it.
--
-- Every row is marked source='INFERRED' and carries an honest reason, because
-- submission and allocation EVENTS were never recorded - only their cumulative
-- results. Nothing here overwrites an existing quantity, and each statement is
-- guarded by NOT IN so re-running the migration inserts nothing a second time.
INSERT INTO "production_movements" ("production_operation_id","production_batch_id","stage","event_type","quantity","worker_id","actor_name","source","reason","occurred_at")
SELECT "po"."id", "po"."production_batch_id", "po"."stage", 'ALLOCATION', "po"."quantity_received", "po"."worker_id", 'System backfill', 'INFERRED', 'Inferred from the quantity_received counter that predates the production ledger', COALESCE("po"."assigned_at", now())
FROM "production_operations" "po"
WHERE "po"."quantity_received" > 0 AND "po"."id" NOT IN (SELECT "production_operation_id" FROM "production_movements");--> statement-breakpoint
INSERT INTO "production_movements" ("production_operation_id","production_batch_id","stage","event_type","quantity","worker_id","actor_name","source","reason","occurred_at")
SELECT "po"."id", "po"."production_batch_id", "po"."stage", 'SUBMISSION', "po"."quantity_completed", "po"."worker_id", 'System backfill', 'INFERRED', 'Inferred from the quantity_completed counter that predates the production ledger', COALESCE("po"."submitted_at", now())
FROM "production_operations" "po"
WHERE "po"."quantity_completed" > 0 AND "po"."id" NOT IN (SELECT "production_operation_id" FROM "production_movements" WHERE "event_type" = 'SUBMISSION');--> statement-breakpoint
-- Inspection outcomes are reconstructed from stage_inspections, which IS a real
-- append-only audit trail, so these rows are faithful rather than inferred.
INSERT INTO "production_movements" ("production_operation_id","production_batch_id","stage","event_type","quantity","worker_id","actor_name","source","reference_type","reference_id","reason","notes","occurred_at")
SELECT "po"."id", "po"."production_batch_id", "po"."stage", 'INSPECTION_APPROVED', "si"."quantity_approved", "po"."worker_id", "si"."inspected_by", 'LIVE', 'STAGE_INSPECTION', "si"."id", 'Reconstructed from the stage_inspections audit trail', "si"."notes", "si"."inspected_at"
FROM "stage_inspections" "si" INNER JOIN "production_operations" "po" ON "po"."id" = "si"."production_operation_id"
WHERE "si"."quantity_approved" > 0 AND "si"."id" NOT IN (SELECT COALESCE("reference_id", -1) FROM "production_movements" WHERE "reference_type" = 'STAGE_INSPECTION' AND "event_type" = 'INSPECTION_APPROVED');--> statement-breakpoint
INSERT INTO "production_movements" ("production_operation_id","production_batch_id","stage","event_type","quantity","worker_id","actor_name","source","reference_type","reference_id","reason","notes","occurred_at")
SELECT "po"."id", "po"."production_batch_id", "po"."stage", 'INSPECTION_REWORK', "si"."quantity_rework", "po"."worker_id", "si"."inspected_by", 'LIVE', 'STAGE_INSPECTION', "si"."id", 'Reconstructed from the stage_inspections audit trail', "si"."notes", "si"."inspected_at"
FROM "stage_inspections" "si" INNER JOIN "production_operations" "po" ON "po"."id" = "si"."production_operation_id"
WHERE "si"."quantity_rework" > 0 AND "si"."id" NOT IN (SELECT COALESCE("reference_id", -1) FROM "production_movements" WHERE "reference_type" = 'STAGE_INSPECTION' AND "event_type" = 'INSPECTION_REWORK');--> statement-breakpoint
INSERT INTO "production_movements" ("production_operation_id","production_batch_id","stage","event_type","quantity","worker_id","actor_name","source","reference_type","reference_id","reason","notes","occurred_at")
SELECT "po"."id", "po"."production_batch_id", "po"."stage", 'INSPECTION_REJECTED', "si"."quantity_rejected", "po"."worker_id", "si"."inspected_by", 'LIVE', 'STAGE_INSPECTION', "si"."id", 'Reconstructed from the stage_inspections audit trail', "si"."notes", "si"."inspected_at"
FROM "stage_inspections" "si" INNER JOIN "production_operations" "po" ON "po"."id" = "si"."production_operation_id"
WHERE "si"."quantity_rejected" > 0 AND "si"."id" NOT IN (SELECT COALESCE("reference_id", -1) FROM "production_movements" WHERE "reference_type" = 'STAGE_INSPECTION' AND "event_type" = 'INSPECTION_REJECTED');
