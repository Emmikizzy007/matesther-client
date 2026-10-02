-- ADDITIVE MIGRATION: worker_roles - one person, many production roles.
--
-- A person at Matesther may be a Cutter and a Tailor, or a Tailor who also acts
-- as an Inspection Officer. Until now workers.specialty held exactly one role,
-- so a person with two skills had to be recorded twice - duplicate people, split
-- production history, and payroll counted per half-person.
--
-- This migration creates ONE new table. It:
--   * adds no column to workers,
--   * does not drop, rename or rewrite workers.specialty,
--   * does not insert, update or delete a row in any existing table,
--   * does not truncate anything.
--
-- workers.specialty is deliberately kept and still counts as an assigned role,
-- so every worker recorded before this migration keeps working immediately with
-- no data backfill. Copying each specialty into worker_roles is optional and can
-- be done later, at any time, without downtime.
--
-- Every statement is idempotent, matching the house style of
-- drizzle/0003_catchup_live_schema.sql and deploy/upgrade-current-client.sql.
-- Against an up-to-date database this migration is a complete no-op.
--
-- NOTE: the SQL text below was made idempotent after drizzle-kit generated it,
-- so its hash differs from the pristine generator output. The Matesther
-- production database is upgraded by running the deploy/*.sql files in the SQL
-- Editor, not by `drizzle-kit migrate`; see deploy/UPDATE-INSTRUCTIONS.md.

CREATE TABLE IF NOT EXISTS "worker_roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"worker_id" integer NOT NULL,
	"role" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now()
);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.worker_roles'::regclass
      AND conname = 'worker_roles_worker_id_role_unique'
  ) THEN
    -- One row per person per role. This is what makes a duplicate role
    -- assignment impossible at the database level, not just in the API.
    ALTER TABLE "public"."worker_roles" ADD CONSTRAINT "worker_roles_worker_id_role_unique"
      UNIQUE("worker_id","role");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.worker_roles'::regclass
      AND conname = 'worker_roles_worker_id_workers_id_fk'
  ) THEN
    ALTER TABLE "public"."worker_roles" ADD CONSTRAINT "worker_roles_worker_id_workers_id_fk"
      FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
