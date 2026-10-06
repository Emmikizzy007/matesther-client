-- MATESTHER CLIENT: PRODUCTION ALLOCATIONS - SPLIT ONE EXACT STAGE ACROSS WORKERS.
-- Make a backup first. Run this in the SQL Editor of the project used by your
-- CLIENT site. Safe to run more than once.
--
-- WHAT THIS DOES
--   1. Creates public.production_allocations: one row per worker per production
--      stage, so 100 navy size-10 polos at SEWING can be split 40 / 35 / 25 across
--      three tailors without fragmenting the variant, the route or the order's
--      allocation ceiling into three separate batches.
--   2. Adds a NULLABLE public.stage_inspections.worker_id so an inspection of a
--      split stage attributes approved pieces - and therefore pay - to the person
--      who actually made them.
--
-- WHAT THIS NEVER DOES
--   * no DROP, no TRUNCATE, no DELETE, no RENAME,
--   * no change to any existing column's type, default or meaning,
--   * no update to any existing row in any existing table.
--     IT WRITES NO DATA AT ALL. No backfill is needed, because:
--       - a stage with no allocation rows behaves exactly as it did before this
--         table existed, which is every stage currently in the database;
--       - stage_inspections.worker_id stays NULL on every historical inspection and
--         payroll resolves coalesce(worker_id, production_operations.worker_id), so
--         pay for historical work is attributed exactly as it always was.
--
-- NOTHING NEEDS RESTATING AND NOTHING NEEDS RE-ENTERING. Existing production,
-- existing inspections and existing payroll are untouched. Split allocation simply
-- becomes available, stage by stage, as supervisors use it.
--
-- THE TWO UNIQUENESS INDEXES ON production_operations ARE DELIBERATELY KEPT
--   (production_batch_id, stage) from the ledger upgrade and
--   (production_batch_id, route_position) from the routes upgrade.
-- They are what make a batch's route unambiguous: "the next applicable stage" is
-- found by position, and a duplicate stage row would let one of the two be starved.
-- The limitation they were blamed for was never theirs - the thing that blocked
-- several workers on one stage was the single production_operations.worker_id
-- column, and this table evolves that. One stage row, several allocations against
-- it, which is the same shape public.support_assignments already uses.
--
-- ORDER OF WORK: back up -> run this file -> run the verification queries at the
-- bottom -> deploy the new application code. SQL first, code second.
-- See deploy/UPDATE-INSTRUCTIONS.md.
--
-- The new code writes to production_allocations and reads
-- stage_inspections.worker_id, so deploying it before this file would fail.

BEGIN;

CREATE TABLE IF NOT EXISTS public.production_allocations (
  id serial PRIMARY KEY,
  organization_id integer REFERENCES public.organizations(id),
  production_operation_id integer NOT NULL REFERENCES public.production_operations(id) ON DELETE CASCADE,
  -- Denormalised so a batch's or a variant's whole allocation picture is one
  -- indexed lookup rather than a join per stage.
  production_batch_id integer NOT NULL REFERENCES public.production_batches(id) ON DELETE CASCADE,
  -- Stage identity carried as data, like every production_movements row.
  stage text NOT NULL,
  worker_id integer NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
  -- The rate agreed with THIS worker for THIS stage, snapshotted at allocation
  -- time. Workers on one stage may legitimately agree different rates, and a
  -- later change to anyone's profile rate must not restate what was agreed.
  piece_rate integer,
  quantity_allocated integer NOT NULL DEFAULT 0,
  quantity_submitted integer NOT NULL DEFAULT 0,
  quantity_approved integer NOT NULL DEFAULT 0,
  quantity_rework integer NOT NULL DEFAULT 0,
  quantity_rejected integer NOT NULL DEFAULT 0,
  -- ASSIGNED / ACTIVE / COMPLETED / TRANSFERRED / CANCELLED
  status text NOT NULL DEFAULT 'ASSIGNED',
  assigned_at timestamp DEFAULT now(),
  assigned_by_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
  assigned_by_name text,
  -- The allocation this one inherited unworked quantity from. Reassignment is a
  -- new row pointing back at the old one rather than an edit of it, so the trail
  -- shows who had the work first, how much they did, and why it moved.
  transferred_from_id integer,
  reason text,
  notes text,
  created_at timestamp DEFAULT now()
);

ALTER TABLE public.stage_inspections ADD COLUMN IF NOT EXISTS worker_id integer;

CREATE INDEX IF NOT EXISTS production_allocations_operation_id_idx ON public.production_allocations (production_operation_id);
CREATE INDEX IF NOT EXISTS production_allocations_batch_id_idx     ON public.production_allocations (production_batch_id);
CREATE INDEX IF NOT EXISTS production_allocations_worker_id_idx    ON public.production_allocations (worker_id);
CREATE INDEX IF NOT EXISTS production_allocations_status_idx       ON public.production_allocations (status);
CREATE INDEX IF NOT EXISTS stage_inspections_worker_id_idx         ON public.stage_inspections (worker_id);

-- One LIVE allocation per worker per stage. A reassignment closes the old row
-- (TRANSFERRED or CANCELLED) and opens a new one, so this partial index stops the
-- same person holding the same stage twice and double-counting their share, while
-- still allowing the closed rows that form the audit trail.
CREATE UNIQUE INDEX IF NOT EXISTS production_allocations_live_one_per_worker_unique
  ON public.production_allocations (production_operation_id, worker_id)
  WHERE status IN ('ASSIGNED', 'ACTIVE');

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

COMMIT;

-- ===========================================================================
-- VERIFICATION. Run these after the upgrade. None of them changes anything.
-- ===========================================================================

-- V1. Both should be 0: this upgrade writes no data, so nothing is allocated until
--     a supervisor splits a stage.
-- SELECT (SELECT count(*) FROM public.production_allocations) AS allocations,
--        (SELECT count(*) FROM public.stage_inspections WHERE worker_id IS NOT NULL) AS attributed_inspections;

-- V2. Every historical inspection is still unattributed, which is what makes
--     coalesce(worker_id, production_operations.worker_id) reproduce the old pay
--     attribution exactly. Expected: one row, with attributed = 0.
-- SELECT count(*) AS inspections, count(worker_id) AS attributed FROM public.stage_inspections;

-- V3. The two production_operations uniqueness guarantees from earlier upgrades are
--     still in place. Both rows must be present.
-- SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
--   AND indexname IN ('production_operations_batch_stage_unique',
--                     'production_operations_batch_position_unique',
--                     'production_allocations_live_one_per_worker_unique')
-- ORDER BY indexname;

-- V4. Payroll attribution is unchanged for historical work. Both columns must be
--     equal, because every inspection still resolves through its operation's worker.
-- SELECT
--   (SELECT coalesce(sum(si.quantity_approved), 0) FROM public.stage_inspections si) AS approved_total,
--   (SELECT coalesce(sum(si.quantity_approved), 0) FROM public.stage_inspections si
--      INNER JOIN public.production_operations po ON po.id = si.production_operation_id
--      INNER JOIN public.workers w ON w.id = coalesce(si.worker_id, po.worker_id)) AS approved_attributable;

-- V5. New table and its indexes.
-- SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
--   AND tablename = 'production_allocations' ORDER BY indexname;
