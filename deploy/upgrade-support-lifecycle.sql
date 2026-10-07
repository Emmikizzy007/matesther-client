-- MATESTHER CLIENT: A REAL LIFECYCLE FOR TAILOR SUPPORT WORK, AND ITS TRAIL.
-- Make a backup first. Run this in the SQL Editor of the project used by your
-- CLIENT site. Safe to run more than once.
--
-- WHAT THIS DOES
--   1. support_assignments gains four nullable columns: started_at, paused_at,
--      pause_reason and submitted_by_name.
--   2. A new append-only table, support_status_events, records every lifecycle
--      transition on a support assignment with the person who made it and, where a
--      reason is required, that reason.
--   3. Indexes for the two questions Production Control now asks on every load:
--      which support work is still open, and every event on one assignment.
--
-- WHY
--   Until now support_assignments.status could say where the work is NOW but never
--   how it got there. A helper could submit work they had never begun, nothing could
--   express "the helper has stopped", and Production Control therefore showed a
--   tailor's stage as ordinary in-progress work while the support that stage depends
--   on was standing still. From this upgrade a support assignment moves
--   ASSIGNED -> STARTED -> SUBMITTED -> APPROVED (or REWORK), may be PAUSED and
--   resumed, and every move is recorded with its actor.
--
--   This is the same pattern the schema already uses twice: production_movements is
--   the trail behind a stage's quantity counters, and stage_inspections is the trail
--   behind a stage's approved figure. Support work was the one production area with
--   no trail of its own. Nothing here is a second history system.
--
-- WHY IT IS SAFE
--   Every statement is ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS,
--   CREATE INDEX IF NOT EXISTS or a guarded ADD CONSTRAINT. Nothing is NOT NULL,
--   nothing has a default, and there is no DELETE, no TRUNCATE, no DROP, no RENAME,
--   no change to any existing column's type or meaning, and no data write of any kind.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   It does NOT backfill a start time, a pause or an event onto existing support
--   assignments. Every assignment already in your database keeps NULL for all four
--   new columns and gets no events, because that is the truth about it: the system
--   did not record when the helper began. Inventing a start time would put a
--   fabricated timestamp behind a payroll figure.
--
--   Existing assignments also keep their existing status. ASSIGNED, SUBMITTED,
--   APPROVED, REWORK and CANCELLED are all still legal states in the new lifecycle,
--   so nothing already recorded becomes invalid or unreadable. One behaviour does
--   change for work not yet submitted: it must now be STARTED before it can be
--   SUBMITTED, which is the point of the change. Nothing historical is rewritten to
--   make that apply retroactively.
--
-- ORDER OF WORK (as always): run this SQL FIRST, then deploy the new code. The new
-- code writes these columns and this table, so deploying code before they exist
-- would fail. Existing code ignores columns and tables it does not know about, so
-- running this first is harmless.
--
-- The same change is recorded for the ORM as drizzle/0011_support_lifecycle.sql.
-- Do NOT run drizzle-kit migrate against production; the SQL Editor route above is
-- the supported path.

-- ---------------------------------------------------------------------------
-- THE UPGRADE. One transaction: either every change below is applied, or none
-- of them is. COMMIT follows the last foreign key, before any verification, so
-- the queries in the VERIFICATION section read committed objects even in an
-- editor that submits a pasted script as a single statement batch.
--
-- Without an explicit BEGIN and COMMIT the transactional behaviour of a pasted
-- script is decided by the client rather than by this file, which is how the
-- companion script deploy/upgrade-test-data-cleanup.sql once rolled itself back.
-- If your editor already wraps a pasted script in a transaction of its own, the
-- BEGIN below reports `WARNING: there is already a transaction in progress`.
-- That is normal, is not an error, and changes nothing.
-- ---------------------------------------------------------------------------
BEGIN;

-- ---------------------------------------------------------------------------
-- 1. THE LIFECYCLE COLUMNS ON support_assignments
-- ---------------------------------------------------------------------------
ALTER TABLE "support_assignments" ADD COLUMN IF NOT EXISTS "started_at" timestamp;
ALTER TABLE "support_assignments" ADD COLUMN IF NOT EXISTS "paused_at" timestamp;
ALTER TABLE "support_assignments" ADD COLUMN IF NOT EXISTS "pause_reason" text;
ALTER TABLE "support_assignments" ADD COLUMN IF NOT EXISTS "submitted_by_name" text;

-- ---------------------------------------------------------------------------
-- 2. WHICH ASSIGNMENTS ARE STILL OPEN
--    Asked on every load of the production control board, so it must not scan.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "support_assignments_status_idx"
  ON "support_assignments" ("status");

-- ---------------------------------------------------------------------------
-- 3. THE APPEND-ONLY LIFECYCLE TRAIL
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "support_status_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "support_assignment_id" integer NOT NULL,
  "organization_id" integer,
  -- CREATED, STARTED, PAUSED, RESUMED, SUBMITTED, INSPECTED, CANCELLED.
  -- Text rather than a closed enum, exactly as production_movements.event_type is,
  -- so a new lifecycle state is a code change plus a row and never a type migration.
  "event_type" text NOT NULL,
  -- NULL on the first event: there was no state before it.
  "from_status" text,
  "to_status" text NOT NULL,
  -- WHO moved it. Both halves, as production_movements does: the id survives a
  -- rename and the name survives a deleted user.
  "actor_user_id" integer,
  "actor_worker_id" integer,
  "actor_name" text NOT NULL,
  -- Required for a pause and a cancellation; NULL for a routine transition.
  "reason" text,
  "notes" text,
  "occurred_at" timestamp DEFAULT now(),
  "created_at" timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "support_status_events_assignment_id_idx"
  ON "support_status_events" ("support_assignment_id");
CREATE INDEX IF NOT EXISTS "support_status_events_occurred_at_idx"
  ON "support_status_events" ("occurred_at");
CREATE INDEX IF NOT EXISTS "support_status_events_event_type_idx"
  ON "support_status_events" ("event_type");

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

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFICATION - these run after the COMMIT above, so they read committed
-- objects. They change nothing. Paste the whole file and these figures are
-- printed for you; you do not have to run this section separately.
--
-- EXPECT:
--   new_columns            = 4
--   support_events_table   = 1
--   support_event_indexes  = 4
--   support_status_index   = 1
--   support_event_fks      = 4
--   support_assignments    = UNCHANGED from before you ran this file
--   support_inspections    = UNCHANGED
--   backfilled_events      = 0   (nothing is ever written by this file)
--
-- WHY support_event_indexes IS 4 AND NOT 3
--   support_status_events declares `"id" serial PRIMARY KEY`, and PostgreSQL backs a
--   primary key with its own index, `support_status_events_pkey`. `pg_indexes` lists
--   that as well as the three indexes created below, so the honest count is 4. An
--   earlier revision of this comment said 3, which would have made a correct upgrade
--   look like a broken one. Getting 4 means the upgrade worked.
--
-- The final three counts read real tables, so if this section is somehow run before
-- the upgrade they will raise `relation ... does not exist` rather than report zeros.
-- ---------------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'support_assignments'
      AND column_name IN ('started_at','paused_at','pause_reason','submitted_by_name')) AS new_columns,
  (SELECT count(*) FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'support_status_events') AS support_events_table,
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'support_status_events') AS support_event_indexes,
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'support_assignments_status_idx') AS support_status_index,
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'public.support_status_events'::regclass AND contype = 'f') AS support_event_fks,
  (SELECT count(*) FROM public.support_assignments) AS support_assignments,
  (SELECT count(*) FROM public.support_inspections) AS support_inspections,
  (SELECT count(*) FROM public.support_status_events) AS backfilled_events;

-- Every new column must be nullable with no default, so existing rows stay valid:
--   SELECT column_name, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'support_assignments'
--      AND column_name IN ('started_at','paused_at','pause_reason','submitted_by_name');

-- AFTER DEPLOYING THE CODE, this is the trail working. Hand out a support
-- assignment, have the helper start it, then pause it with a reason, and expect
-- three rows - CREATED, STARTED, PAUSED - each naming the person who made it:
--   SELECT e.event_type, e.from_status, e.to_status, e.actor_name, e.reason, e.occurred_at
--     FROM public.support_status_events e
--    ORDER BY e.support_assignment_id, e.occurred_at, e.id;
