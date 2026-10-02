-- CATCH-UP / BASELINE MIGRATION - reconciles drizzle/ with src/db/schema.ts.
--
-- The six columns and two constraints below already exist in any Matesther
-- database created from deploy/schema-only.sql, or upgraded with
-- deploy/upgrade-current-client.sql. They were added to src/db/schema.ts by hand
-- but never emitted by drizzle-kit, so the drizzle folder lagged behind the
-- schema the application actually reads.
--
-- Every statement here is idempotent, matching the house style used in
-- deploy/upgrade-current-client.sql. Against an up-to-date database this
-- migration is a complete no-op.
--
-- It adds columns only. It drops nothing, truncates nothing, rewrites no
-- existing value, and never touches business rows.
--
-- NOTE: the SQL text below was made idempotent after drizzle-kit generated it,
-- so its hash differs from the pristine generator output. The Matesther
-- production database is upgraded by running the deploy/*.sql files in the SQL
-- Editor, not by `drizzle-kit migrate`; see deploy/UPDATE-INSTRUCTIONS.md.

ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "size" text;--> statement-breakpoint
ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "color" text;--> statement-breakpoint
ALTER TABLE "production_operations" ADD COLUMN IF NOT EXISTS "piece_rate" integer;--> statement-breakpoint
ALTER TABLE "stage_inspections" ADD COLUMN IF NOT EXISTS "piece_rate" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "worker_id" integer;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "archived_at" timestamp;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.users'::regclass
      AND conname = 'users_worker_id_workers_id_fk'
  ) THEN
    ALTER TABLE "public"."users" ADD CONSTRAINT "users_worker_id_workers_id_fk"
      FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id")
      ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.users'::regclass
      AND conname = 'users_worker_id_unique'
  ) THEN
    ALTER TABLE "public"."users" ADD CONSTRAINT "users_worker_id_unique" UNIQUE("worker_id");
  END IF;
END $$;
