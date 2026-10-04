-- ADDITIVE MIGRATION: production allocations - one exact stage split across
-- several workers - and per-worker attribution on the inspection audit trail.
--
-- WHAT THIS DOES
--   1. Creates public.production_allocations: one row per worker per stage, so a
--      single exact garment at a single stage (100 navy size-10 polos at SEWING)
--      can be split 40 / 35 / 25 across three tailors. Each row carries its own
--      agreed rate, its own submitted / approved / rework / rejected figures, and
--      the trail of who assigned it and, when work moved, which allocation it came
--      from and why.
--   2. Adds a NULLABLE public.stage_inspections.worker_id, so an inspection of a
--      split stage can attribute approved pieces to the person who actually made
--      them - and so pay follows the right person.
--
-- WHAT THIS NEVER DOES
--   * no DROP, no TRUNCATE, no DELETE, no RENAME,
--   * no change to any existing column's type, default or meaning,
--   * no update to any existing row in any existing table.
--     IT WRITES NO DATA AT ALL. There is no backfill, and none is needed:
--       - a stage with no allocation rows behaves exactly as it did before this
--         table existed, which is every historical stage;
--       - stage_inspections.worker_id stays NULL on every historical inspection,
--         and payroll resolves coalesce(worker_id, production_operations.worker_id),
--         so pay for historical work is attributed exactly as it always was.
--
-- WHY A SUB-TABLE RATHER THAN SEVERAL production_operations ROWS
--   Migration 0006 added uniqueIndex(production_operations(production_batch_id,
--   stage)) because "the next stage" used to be found by taking the FIRST row
--   matching a stage name - a duplicate would silently starve one of the two.
--   Migration 0007 added uniqueIndex(production_batch_id, route_position) for the
--   same reason against the frozen route. BOTH ARE KEPT. They are what makes a
--   batch's route unambiguous, and dropping either would reintroduce a defect to
--   fix a limitation that was never really theirs: the thing that blocked several
--   workers on one stage was the single production_operations.worker_id column, and
--   that is what this table evolves. One stage row, several allocations against it
--   - the same shape support_assignments already uses against its parent operation.
--
-- Every statement is idempotent, matching drizzle/0005, 0006 and 0007. Against an
-- up-to-date database this migration is a complete no-op.
--
-- PRODUCTION NOTE: upgrade the client database by running
-- deploy/upgrade-production-allocations.sql in the SQL Editor, not by
-- `drizzle-kit migrate`. See deploy/UPDATE-INSTRUCTIONS.md. SQL first, code second.
--
-- NOTE: the SQL below was made idempotent after drizzle-kit generated it, so its
-- hash differs from the pristine generator output. drizzle/meta/0008_snapshot.json
-- is the untouched generator snapshot and is what stops a future
-- `drizzle-kit generate` from re-emitting these objects.

CREATE TABLE IF NOT EXISTS "production_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"production_operation_id" integer NOT NULL,
	"production_batch_id" integer NOT NULL,
	"stage" text NOT NULL,
	"worker_id" integer NOT NULL,
	"piece_rate" integer,
	"quantity_allocated" integer DEFAULT 0 NOT NULL,
	"quantity_submitted" integer DEFAULT 0 NOT NULL,
	"quantity_approved" integer DEFAULT 0 NOT NULL,
	"quantity_rework" integer DEFAULT 0 NOT NULL,
	"quantity_rejected" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ASSIGNED' NOT NULL,
	"assigned_at" timestamp DEFAULT now(),
	"assigned_by_user_id" integer,
	"assigned_by_name" text,
	"transferred_from_id" integer,
	"reason" text,
	"notes" text,
	"created_at" timestamp DEFAULT now()
);--> statement-breakpoint
-- NULLABLE, AND NULL MEANS SOMETHING: an inspection recorded before split
-- allocation was never attributed per worker, so pay for it is still attributed
-- through production_operations.worker_id. That is why no backfill is needed.
ALTER TABLE "stage_inspections" ADD COLUMN IF NOT EXISTS "worker_id" integer;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_allocations_operation_id_idx" ON "production_allocations" ("production_operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_allocations_batch_id_idx" ON "production_allocations" ("production_batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_allocations_worker_id_idx" ON "production_allocations" ("worker_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_allocations_status_idx" ON "production_allocations" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stage_inspections_worker_id_idx" ON "stage_inspections" ("worker_id");--> statement-breakpoint
-- One LIVE allocation per worker per stage. A reassignment closes the old row
-- (status TRANSFERRED or CANCELLED) and opens a new one, so this partial index is
-- what stops the same person holding the same stage twice and double-counting
-- their share - while still allowing the closed rows that form the audit trail.
CREATE UNIQUE INDEX IF NOT EXISTS "production_allocations_live_one_per_worker_unique" ON "production_allocations" ("production_operation_id","worker_id") WHERE "production_allocations"."status" in ('ASSIGNED', 'ACTIVE');--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_allocations'::regclass AND conname = 'production_allocations_organization_id_organizations_id_fk') THEN
    ALTER TABLE "public"."production_allocations" ADD CONSTRAINT "production_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_allocations'::regclass AND conname = 'production_allocations_production_operation_id_production_operations_id_fk') THEN
    ALTER TABLE "public"."production_allocations" ADD CONSTRAINT "production_allocations_production_operation_id_production_operations_id_fk" FOREIGN KEY ("production_operation_id") REFERENCES "public"."production_operations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_allocations'::regclass AND conname = 'production_allocations_production_batch_id_production_batches_id_fk') THEN
    ALTER TABLE "public"."production_allocations" ADD CONSTRAINT "production_allocations_production_batch_id_production_batches_id_fk" FOREIGN KEY ("production_batch_id") REFERENCES "public"."production_batches"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_allocations'::regclass AND conname = 'production_allocations_worker_id_workers_id_fk') THEN
    ALTER TABLE "public"."production_allocations" ADD CONSTRAINT "production_allocations_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_allocations'::regclass AND conname = 'production_allocations_assigned_by_user_id_users_id_fk') THEN
    ALTER TABLE "public"."production_allocations" ADD CONSTRAINT "production_allocations_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.stage_inspections'::regclass AND conname = 'stage_inspections_worker_id_workers_id_fk') THEN
    ALTER TABLE "public"."stage_inspections" ADD CONSTRAINT "stage_inspections_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
