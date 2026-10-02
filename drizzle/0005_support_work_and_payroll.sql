-- ADDITIVE MIGRATION: tailor support work, staff records and payment detail.
--
-- Three things Matesther could not previously represent:
--   1. Tailor support work (weaving, taping and other supporting garment work)
--      handed from a tailor to a helper, inspected and approved by the tailor.
--   2. Non-production / salaried staff, who were forced into a production
--      specialty such as Tailor just to exist in the system.
--   3. The detail a monthly bank payment sheet needs: support piecework and
--      other approved earnings kept separate, a bank reference, and a guard
--      against recording the same payment twice.
--
-- This migration creates two tables and adds nullable or defaulted columns. It:
--   * drops nothing, truncates nothing, renames nothing,
--   * does not insert, update or delete a row in any existing table,
--   * does not change any existing column's type or meaning.
--
-- Every existing worker keeps working unchanged: `specialty` and `payment_type`
-- are untouched, new columns default to values that reproduce today's behaviour
-- (overtime category defaults to OVERTIME, new payment amounts default to 0).
--
-- Every statement is idempotent, matching the house style of
-- drizzle/0003_catchup_live_schema.sql and deploy/upgrade-current-client.sql.
-- Against an up-to-date database this migration is a complete no-op.
--
-- NOTE: the SQL text below was made idempotent after drizzle-kit generated it,
-- so its hash differs from the pristine generator output. The Matesther
-- production database is upgraded by running the deploy/*.sql files in the SQL
-- Editor, not by `drizzle-kit migrate`; see deploy/UPDATE-INSTRUCTIONS.md.

CREATE TABLE IF NOT EXISTS "support_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"assigned_by_worker_id" integer NOT NULL,
	"worker_id" integer NOT NULL,
	"production_operation_id" integer,
	"order_id" integer,
	"operation" text NOT NULL,
	"piece_rate" integer DEFAULT 0 NOT NULL,
	"quantity_assigned" integer DEFAULT 0 NOT NULL,
	"quantity_submitted" integer DEFAULT 0 NOT NULL,
	"quantity_approved" integer DEFAULT 0 NOT NULL,
	"quantity_rework" integer DEFAULT 0 NOT NULL,
	"quantity_rejected" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ASSIGNED' NOT NULL,
	"assigned_at" timestamp DEFAULT now(),
	"submitted_at" timestamp,
	"inspected_at" timestamp,
	"approved_by_worker_id" integer,
	"notes" text,
	"created_at" timestamp DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_inspections" (
	"id" serial PRIMARY KEY NOT NULL,
	"support_assignment_id" integer NOT NULL,
	"inspected_by" text NOT NULL,
	"piece_rate" integer,
	"quantity_approved" integer DEFAULT 0 NOT NULL,
	"quantity_rework" integer DEFAULT 0 NOT NULL,
	"quantity_rejected" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"inspected_at" timestamp DEFAULT now()
);--> statement-breakpoint
ALTER TABLE "worker_overtime" ADD COLUMN IF NOT EXISTS "category" text DEFAULT 'OVERTIME' NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_payments" ADD COLUMN IF NOT EXISTS "support_amount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_payments" ADD COLUMN IF NOT EXISTS "other_amount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_payments" ADD COLUMN IF NOT EXISTS "reference" text;--> statement-breakpoint
ALTER TABLE "worker_payments" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "department" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "job_title" text;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.support_assignments'::regclass AND conname = 'support_assignments_organization_id_organizations_id_fk') THEN
    ALTER TABLE "public"."support_assignments" ADD CONSTRAINT "support_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.support_assignments'::regclass AND conname = 'support_assignments_assigned_by_worker_id_workers_id_fk') THEN
    ALTER TABLE "public"."support_assignments" ADD CONSTRAINT "support_assignments_assigned_by_worker_id_workers_id_fk" FOREIGN KEY ("assigned_by_worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.support_assignments'::regclass AND conname = 'support_assignments_worker_id_workers_id_fk') THEN
    ALTER TABLE "public"."support_assignments" ADD CONSTRAINT "support_assignments_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.support_assignments'::regclass AND conname = 'support_assignments_production_operation_id_production_operations_id_fk') THEN
    ALTER TABLE "public"."support_assignments" ADD CONSTRAINT "support_assignments_production_operation_id_production_operations_id_fk" FOREIGN KEY ("production_operation_id") REFERENCES "public"."production_operations"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.support_assignments'::regclass AND conname = 'support_assignments_order_id_orders_id_fk') THEN
    ALTER TABLE "public"."support_assignments" ADD CONSTRAINT "support_assignments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.support_assignments'::regclass AND conname = 'support_assignments_approved_by_worker_id_workers_id_fk') THEN
    ALTER TABLE "public"."support_assignments" ADD CONSTRAINT "support_assignments_approved_by_worker_id_workers_id_fk" FOREIGN KEY ("approved_by_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.support_inspections'::regclass AND conname = 'support_inspections_support_assignment_id_support_assignments_id_fk') THEN
    ALTER TABLE "public"."support_inspections" ADD CONSTRAINT "support_inspections_support_assignment_id_support_assignments_id_fk" FOREIGN KEY ("support_assignment_id") REFERENCES "public"."support_assignments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.worker_payments'::regclass AND conname = 'worker_payments_idempotency_key_unique') THEN
    -- The same payment can never be recorded twice. Rows with no key stay NULL
    -- and never collide, so ordinary part payments are unaffected.
    ALTER TABLE "public"."worker_payments" ADD CONSTRAINT "worker_payments_idempotency_key_unique" UNIQUE("idempotency_key");
  END IF;
END $$;
