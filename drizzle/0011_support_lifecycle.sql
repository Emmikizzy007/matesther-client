-- ADDITIVE MIGRATION: a real lifecycle for tailor support work, and the audit
-- trail behind it.
--
-- WHAT THIS DOES
--   1. Adds four NULLABLE columns to public.support_assignments - started_at,
--      paused_at, pause_reason and submitted_by_name - so "the helper has begun",
--      "the helper is paused, and here is why" and "who actually submitted this" are
--      recorded facts rather than something a reader has to infer from a status word.
--   2. Creates public.support_status_events: an append-only trail of every lifecycle
--      transition on a support assignment, carrying the actor and, where one is
--      required, the reason.
--   3. Adds the indexes the new reads need: which assignments are still open (asked
--      on every load of the production control board), and every event on one
--      assignment in time order.
--
-- WHY A TRAIL AND NOT JUST A STATUS COLUMN
--   support_assignments.status already existed and could only ever say where the
--   work is NOW. Production Control has to say WHY a tailor's stage is not moving -
--   "support paused since Tuesday, machine down" - and a payroll or quality question
--   about last month has to be answerable after the status has moved on.
--
--   This is the same shape the codebase already uses twice: production_movements is
--   the append-only ledger behind production_operations' derived counters, and
--   stage_inspections is the append-only trail behind a stage's approved figure. It
--   is not a second history system; it is the existing pattern reaching support work,
--   which was the one production area with no trail of its own.
--
-- WHY NOTHING IS BACKFILLED
--   Every support assignment already in the database keeps NULL for started_at,
--   paused_at, pause_reason and submitted_by_name, and gets no events. That is the
--   truth about it: the system did not record when the helper began, and inventing a
--   start time for somebody's past work would put a fabricated timestamp behind a
--   payroll figure.
--
--   Consequence, stated plainly: an assignment created BEFORE this migration is still
--   in one of ASSIGNED / SUBMITTED / APPROVED / REWORK / CANCELLED, and every one of
--   those remains a legal state in the new lifecycle, so no historical assignment
--   becomes invalid or unreadable. A legacy row that has not yet been submitted does
--   now have to be started before it can be submitted, because that rule is the point
--   of the change; no historical row is rewritten to make it apply retroactively.
--
-- WHAT THIS NEVER DOES
--   * no DROP, no TRUNCATE, no DELETE, no RENAME,
--   * no change to any existing column's type, default or meaning,
--   * no NOT NULL and no default on any new column,
--   * no update to any existing row in any existing table.
--     IT WRITES NO DATA AT ALL.
--
-- Every statement is idempotent, matching drizzle/0005 through 0010. Against an
-- up-to-date database this migration is a complete no-op.
--
-- NOTE ON THE GUARD BLOCK
--   pg-mem, which the regression suite runs on, has no plpgsql interpreter and so
--   cannot execute `DO $$ ... $$`. tests/support/preload.cjs unwraps the ALTER TABLE
--   statements inside the block and runs them directly against a database that is
--   always created empty, where the guard could never fire anyway. The resulting
--   schema is identical. This is the arrangement migrations 0003 through 0008 already
--   rely on, and the column additions above use `ADD COLUMN IF NOT EXISTS` directly
--   exactly as 0008 does.

-- ---------- 1. the lifecycle columns on support_assignments ----------
ALTER TABLE "support_assignments" ADD COLUMN IF NOT EXISTS "started_at" timestamp;--> statement-breakpoint
ALTER TABLE "support_assignments" ADD COLUMN IF NOT EXISTS "paused_at" timestamp;--> statement-breakpoint
ALTER TABLE "support_assignments" ADD COLUMN IF NOT EXISTS "pause_reason" text;--> statement-breakpoint
ALTER TABLE "support_assignments" ADD COLUMN IF NOT EXISTS "submitted_by_name" text;--> statement-breakpoint

-- ---------- 2. which assignments are still open ----------
-- "Which support work is still open?" and "which of it is paused?" are asked on every
-- load of the control board, so they must not scan the whole table.
CREATE INDEX IF NOT EXISTS "support_assignments_status_idx" ON "support_assignments" ("status");--> statement-breakpoint

-- ---------- 3. the append-only lifecycle trail ----------
CREATE TABLE IF NOT EXISTS "support_status_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"support_assignment_id" integer NOT NULL,
	"organization_id" integer,
	"event_type" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_user_id" integer,
	"actor_worker_id" integer,
	"actor_name" text NOT NULL,
	"reason" text,
	"notes" text,
	"occurred_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_status_events_assignment_id_idx" ON "support_status_events" ("support_assignment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_status_events_occurred_at_idx" ON "support_status_events" ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_status_events_event_type_idx" ON "support_status_events" ("event_type");--> statement-breakpoint

-- Foreign keys are guarded so the whole file can be re-run against an already-upgraded
-- database, which is the house rule for every migration since 0003.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.support_status_events'::regclass AND conname = 'support_status_events_support_assignment_id_support_assignments_id_fk') THEN
    ALTER TABLE "public"."support_status_events" ADD CONSTRAINT "support_status_events_support_assignment_id_support_assignments_id_fk" FOREIGN KEY ("support_assignment_id") REFERENCES "public"."support_assignments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.support_status_events'::regclass AND conname = 'support_status_events_organization_id_organizations_id_fk') THEN
    ALTER TABLE "public"."support_status_events" ADD CONSTRAINT "support_status_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.support_status_events'::regclass AND conname = 'support_status_events_actor_user_id_users_id_fk') THEN
    ALTER TABLE "public"."support_status_events" ADD CONSTRAINT "support_status_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.support_status_events'::regclass AND conname = 'support_status_events_actor_worker_id_workers_id_fk') THEN
    ALTER TABLE "public"."support_status_events" ADD CONSTRAINT "support_status_events_actor_worker_id_workers_id_fk" FOREIGN KEY ("actor_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

-- ---------- VERIFICATION (run these after applying; they change nothing) ----------
-- The four new columns exist, are nullable and have no default:
--   SELECT column_name, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'support_assignments'
--      AND column_name IN ('started_at','paused_at','pause_reason','submitted_by_name');
-- The trail exists with its three indexes:
--   SELECT indexname FROM pg_indexes
--    WHERE schemaname = 'public' AND tablename = 'support_status_events';
-- No existing row was touched - this must equal the count taken before the migration:
--   SELECT count(*) FROM public.support_assignments;
-- And the new table is empty, because nothing was backfilled:
--   SELECT count(*) FROM public.support_status_events;
