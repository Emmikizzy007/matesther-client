-- MATESTHER CLIENT: PRODUCTION MOVEMENT LEDGER, INDEXES AND UNIQUENESS UPGRADE.
-- Make a backup first. Run this in the SQL Editor of the project used by your
-- CLIENT site. Safe to run more than once.
--
-- WHAT THIS DOES
--   1. Creates public.production_movements: an append-only ledger of every event
--      that changes a production quantity. The seven quantity counters on
--      public.production_operations become a derived cache of this table, so a
--      quantity can only move by appending an event that records who, when and
--      why.
--   2. Creates the indexes this database has never had. Until now the only
--      indexes were primary keys and five unique constraints, so every
--      foreign-key lookup in the application was a sequential scan.
--   3. Adds two unique indexes the application has always assumed but never had:
--        production_operations (production_batch_id, stage)
--        order_item_sizes (order_item_id, size)
--      Both are PRE-FLIGHTED for existing duplicates first. If duplicates exist
--      the index is SKIPPED and the offending ids are reported as NOTICEs, so the
--      rest of the upgrade still applies and nothing is deleted to make it fit.
--   4. Backfills INFERRED ledger rows for production that predates the ledger, so
--      derivation has a basis for historical batches too.
--
-- WHAT THIS NEVER DOES
--   * no DROP, no TRUNCATE, no DELETE, no RENAME,
--   * no change to any existing column's type, default or meaning,
--   * no update to any existing row in any existing table.
--     The only writes are INSERTs into the brand-new production_movements table,
--     and every one of them is guarded so re-running inserts nothing twice.
--
-- NOTHING IS LOST AND NOTHING IS RESTATED. Existing quantities are untouched; the
-- backfill only records where they came from. Rows it creates are marked
-- source='INFERRED' with an honest reason, because submission and allocation
-- EVENTS were never recorded before - only their cumulative results. Rows
-- reconstructed from public.stage_inspections are marked source='LIVE', because
-- that table IS a real audit trail.
--
-- ORDER OF WORK: back up -> run this file -> read the NOTICEs and run the
-- verification queries at the bottom -> deploy the new application code.
-- SQL first, code second. See deploy/UPDATE-INSTRUCTIONS.md.
--
-- The new code REFUSES free-text quantity edits on PUT /api/operations and routes
-- genuine mistakes through POST /api/production-corrections, which writes a signed
-- ledger row. Deploying the code before this file would fail, because the ledger
-- table would not exist.

BEGIN;

-- ---------- 1. The production movement ledger ----------
CREATE TABLE IF NOT EXISTS public.production_movements (
  id serial PRIMARY KEY,
  organization_id integer REFERENCES public.organizations(id),
  production_operation_id integer NOT NULL REFERENCES public.production_operations(id) ON DELETE CASCADE,
  -- Denormalised so a whole batch's history is one indexed lookup.
  production_batch_id integer NOT NULL REFERENCES public.production_batches(id) ON DELETE CASCADE,
  -- Stage identity travels WITH the row. It never depends on the row's position
  -- in a global eight-element array, which is what lets a garment follow its own
  -- shorter route later without this table changing.
  stage text NOT NULL,
  -- A vocabulary, not a constraint. New kinds of movement are added as data, so
  -- no future migration has to widen an enum or build a second ledger.
  event_type text NOT NULL,
  -- Signed: a correction can reduce a quantity, visibly and with its author.
  quantity integer NOT NULL DEFAULT 0,
  worker_id integer REFERENCES public.workers(id) ON DELETE SET NULL,
  actor_user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
  actor_name text NOT NULL,
  -- 'LIVE' = recorded as it happened. 'INFERRED' = reconstructed by this file
  -- from counters that predate the ledger.
  source text NOT NULL DEFAULT 'LIVE',
  reference_type text,
  reference_id integer,
  reason text,
  notes text,
  occurred_at timestamp DEFAULT now(),
  created_at timestamp DEFAULT now()
);

CREATE INDEX IF NOT EXISTS production_movements_operation_id_idx ON public.production_movements (production_operation_id);
CREATE INDEX IF NOT EXISTS production_movements_batch_id_idx     ON public.production_movements (production_batch_id);
CREATE INDEX IF NOT EXISTS production_movements_event_type_idx   ON public.production_movements (event_type);
CREATE INDEX IF NOT EXISTS production_movements_occurred_at_idx  ON public.production_movements (occurred_at);

-- ---------- 2. The indexes the schema has always needed ----------
CREATE INDEX IF NOT EXISTS users_organization_id_idx              ON public.users (organization_id);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx                   ON public.sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx                ON public.sessions (expires_at);
CREATE INDEX IF NOT EXISTS orders_customer_id_idx                 ON public.orders (customer_id);
CREATE INDEX IF NOT EXISTS orders_status_idx                      ON public.orders (status);
CREATE INDEX IF NOT EXISTS orders_due_date_idx                    ON public.orders (due_date);
CREATE INDEX IF NOT EXISTS orders_created_at_idx                  ON public.orders (created_at);
CREATE INDEX IF NOT EXISTS order_items_order_id_idx               ON public.order_items (order_id);
CREATE INDEX IF NOT EXISTS workers_organization_id_idx            ON public.workers (organization_id);
CREATE INDEX IF NOT EXISTS workers_status_idx                     ON public.workers (status);
CREATE INDEX IF NOT EXISTS order_item_sizes_order_item_id_idx     ON public.order_item_sizes (order_item_id);
CREATE INDEX IF NOT EXISTS production_batches_order_id_idx        ON public.production_batches (order_id);
CREATE INDEX IF NOT EXISTS production_batches_order_item_id_idx   ON public.production_batches (order_item_id);
CREATE INDEX IF NOT EXISTS production_operations_batch_id_idx     ON public.production_operations (production_batch_id);
CREATE INDEX IF NOT EXISTS production_operations_worker_id_idx    ON public.production_operations (worker_id);
CREATE INDEX IF NOT EXISTS production_operations_stage_idx        ON public.production_operations (stage);
CREATE INDEX IF NOT EXISTS production_operations_status_idx       ON public.production_operations (status);
CREATE INDEX IF NOT EXISTS stage_inspections_operation_id_idx     ON public.stage_inspections (production_operation_id);
CREATE INDEX IF NOT EXISTS stage_inspections_inspected_at_idx     ON public.stage_inspections (inspected_at);
CREATE INDEX IF NOT EXISTS support_assignments_worker_id_idx      ON public.support_assignments (worker_id);
CREATE INDEX IF NOT EXISTS support_assignments_assigned_by_idx    ON public.support_assignments (assigned_by_worker_id);
CREATE INDEX IF NOT EXISTS support_assignments_operation_id_idx   ON public.support_assignments (production_operation_id);
CREATE INDEX IF NOT EXISTS support_assignments_order_id_idx       ON public.support_assignments (order_id);
CREATE INDEX IF NOT EXISTS support_inspections_assignment_id_idx  ON public.support_inspections (support_assignment_id);
CREATE INDEX IF NOT EXISTS support_inspections_inspected_at_idx   ON public.support_inspections (inspected_at);
CREATE INDEX IF NOT EXISTS material_purchases_material_id_idx     ON public.material_purchases (material_id);
CREATE INDEX IF NOT EXISTS material_purchases_order_id_idx        ON public.material_purchases (order_id);
CREATE INDEX IF NOT EXISTS material_usage_order_id_idx            ON public.material_usage (order_id);
CREATE INDEX IF NOT EXISTS material_usage_material_id_idx         ON public.material_usage (material_id);
CREATE INDEX IF NOT EXISTS material_usage_operation_id_idx        ON public.material_usage (production_operation_id);
CREATE INDEX IF NOT EXISTS expenses_order_id_idx                  ON public.expenses (order_id);
CREATE INDEX IF NOT EXISTS payments_order_id_idx                  ON public.payments (order_id);
CREATE INDEX IF NOT EXISTS quality_checks_operation_id_idx        ON public.quality_checks (production_operation_id);
CREATE INDEX IF NOT EXISTS rework_records_operation_id_idx        ON public.rework_records (production_operation_id);
CREATE INDEX IF NOT EXISTS packing_records_order_id_idx           ON public.packing_records (order_id);
CREATE INDEX IF NOT EXISTS worker_payments_worker_id_idx          ON public.worker_payments (worker_id);
CREATE INDEX IF NOT EXISTS worker_payments_period_month_idx       ON public.worker_payments (period_month);
CREATE INDEX IF NOT EXISTS worker_overtime_worker_id_idx          ON public.worker_overtime (worker_id);
CREATE INDEX IF NOT EXISTS worker_overtime_worked_on_idx          ON public.worker_overtime (worked_on);
CREATE INDEX IF NOT EXISTS deliveries_order_id_idx                ON public.deliveries (order_id);
CREATE INDEX IF NOT EXISTS delivery_lines_delivery_id_idx         ON public.delivery_lines (delivery_id);
CREATE INDEX IF NOT EXISTS delivery_lines_order_item_id_idx       ON public.delivery_lines (order_item_id);

-- ---------- 3. The two uniqueness guarantees, pre-flighted ----------
-- Neither index is created blindly. If duplicates already exist the index is
-- SKIPPED and the offending rows are reported, because forcing it would mean
-- deleting production history - which this upgrade never does.
DO $$
DECLARE
  duplicate_stage_count integer;
  duplicate_size_count integer;
BEGIN
  SELECT count(*) INTO duplicate_stage_count FROM (
    SELECT production_batch_id, stage FROM public.production_operations
    GROUP BY production_batch_id, stage HAVING count(*) > 1
  ) duplicated_stages;

  IF duplicate_stage_count = 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'production_operations_batch_stage_unique'
    ) THEN
      CREATE UNIQUE INDEX production_operations_batch_stage_unique
        ON public.production_operations (production_batch_id, stage);
      RAISE NOTICE 'Created production_operations_batch_stage_unique: one row per stage per batch.';
    ELSE
      RAISE NOTICE 'production_operations_batch_stage_unique already exists - skipped.';
    END IF;
  ELSE
    RAISE WARNING 'NOT CREATED: production_operations_batch_stage_unique. % batch/stage pair(s) are duplicated. Run verification query V1 below, decide which row is real with the business, and re-run this file afterwards. Nothing was deleted.', duplicate_stage_count;
  END IF;

  SELECT count(*) INTO duplicate_size_count FROM (
    SELECT order_item_id, size FROM public.order_item_sizes
    GROUP BY order_item_id, size HAVING count(*) > 1
  ) duplicated_sizes;

  IF duplicate_size_count = 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'order_item_sizes_item_size_unique'
    ) THEN
      CREATE UNIQUE INDEX order_item_sizes_item_size_unique
        ON public.order_item_sizes (order_item_id, size);
      RAISE NOTICE 'Created order_item_sizes_item_size_unique: one row per size per garment line.';
    ELSE
      RAISE NOTICE 'order_item_sizes_item_size_unique already exists - skipped.';
    END IF;
  ELSE
    RAISE WARNING 'NOT CREATED: order_item_sizes_item_size_unique. % item/size pair(s) are duplicated. Run verification query V2 below. Nothing was deleted.', duplicate_size_count;
  END IF;
END $$;

-- ---------- 4. Backfill the ledger for production that predates it ----------
-- Each statement is guarded so re-running this file inserts nothing twice, and
-- none of them touches an existing row in an existing table.

-- 4a. The quantity that was placed in front of each stage.
INSERT INTO public.production_movements
  (production_operation_id, production_batch_id, stage, event_type, quantity,
   worker_id, actor_name, source, reason, occurred_at)
SELECT po.id, po.production_batch_id, po.stage, 'ALLOCATION', po.quantity_received,
       po.worker_id, 'System backfill', 'INFERRED',
       'Inferred from the quantity_received counter that predates the production ledger',
       COALESCE(po.assigned_at, now())
FROM public.production_operations po
WHERE po.quantity_received > 0
  AND po.id NOT IN (SELECT production_operation_id FROM public.production_movements);

-- 4b. The quantity each worker submitted.
INSERT INTO public.production_movements
  (production_operation_id, production_batch_id, stage, event_type, quantity,
   worker_id, actor_name, source, reason, occurred_at)
SELECT po.id, po.production_batch_id, po.stage, 'SUBMISSION', po.quantity_completed,
       po.worker_id, 'System backfill', 'INFERRED',
       'Inferred from the quantity_completed counter that predates the production ledger',
       COALESCE(po.submitted_at, now())
FROM public.production_operations po
WHERE po.quantity_completed > 0
  AND po.id NOT IN (
    SELECT production_operation_id FROM public.production_movements WHERE event_type = 'SUBMISSION'
  );

-- 4c. Inspection outcomes, reconstructed from stage_inspections. That table is a
--     real append-only audit trail, so these rows are faithful rather than
--     inferred and carry the inspector's own name, timestamp and notes.
INSERT INTO public.production_movements
  (production_operation_id, production_batch_id, stage, event_type, quantity,
   worker_id, actor_name, source, reference_type, reference_id, reason, notes, occurred_at)
SELECT po.id, po.production_batch_id, po.stage, 'INSPECTION_APPROVED', si.quantity_approved,
       po.worker_id, si.inspected_by, 'LIVE', 'STAGE_INSPECTION', si.id,
       'Reconstructed from the stage_inspections audit trail', si.notes, si.inspected_at
FROM public.stage_inspections si
INNER JOIN public.production_operations po ON po.id = si.production_operation_id
WHERE si.quantity_approved > 0
  AND si.id NOT IN (
    SELECT COALESCE(reference_id, -1) FROM public.production_movements
    WHERE reference_type = 'STAGE_INSPECTION' AND event_type = 'INSPECTION_APPROVED'
  );

INSERT INTO public.production_movements
  (production_operation_id, production_batch_id, stage, event_type, quantity,
   worker_id, actor_name, source, reference_type, reference_id, reason, notes, occurred_at)
SELECT po.id, po.production_batch_id, po.stage, 'INSPECTION_REWORK', si.quantity_rework,
       po.worker_id, si.inspected_by, 'LIVE', 'STAGE_INSPECTION', si.id,
       'Reconstructed from the stage_inspections audit trail', si.notes, si.inspected_at
FROM public.stage_inspections si
INNER JOIN public.production_operations po ON po.id = si.production_operation_id
WHERE si.quantity_rework > 0
  AND si.id NOT IN (
    SELECT COALESCE(reference_id, -1) FROM public.production_movements
    WHERE reference_type = 'STAGE_INSPECTION' AND event_type = 'INSPECTION_REWORK'
  );

INSERT INTO public.production_movements
  (production_operation_id, production_batch_id, stage, event_type, quantity,
   worker_id, actor_name, source, reference_type, reference_id, reason, notes, occurred_at)
SELECT po.id, po.production_batch_id, po.stage, 'INSPECTION_REJECTED', si.quantity_rejected,
       po.worker_id, si.inspected_by, 'LIVE', 'STAGE_INSPECTION', si.id,
       'Reconstructed from the stage_inspections audit trail', si.notes, si.inspected_at
FROM public.stage_inspections si
INNER JOIN public.production_operations po ON po.id = si.production_operation_id
WHERE si.quantity_rejected > 0
  AND si.id NOT IN (
    SELECT COALESCE(reference_id, -1) FROM public.production_movements
    WHERE reference_type = 'STAGE_INSPECTION' AND event_type = 'INSPECTION_REJECTED'
  );

COMMIT;

-- ===========================================================================
-- VERIFICATION. Run these after the upgrade. None of them changes anything.
-- ===========================================================================

-- V0. The ledger exists and was backfilled.
-- SELECT source, event_type, count(*) AS rows, sum(quantity) AS total_quantity
-- FROM public.production_movements GROUP BY source, event_type ORDER BY source, event_type;

-- V1. Duplicate stage rows, if the unique index was NOT created. Each of these is
--     a batch that has two rows for the same stage; decide with the business
--     which one holds the real history before re-running this file.
-- SELECT production_batch_id, stage, count(*) AS rows,
--        array_agg(id ORDER BY id) AS operation_ids,
--        array_agg(quantity_received ORDER BY id) AS received,
--        array_agg(quantity_approved ORDER BY id) AS approved
-- FROM public.production_operations
-- GROUP BY production_batch_id, stage HAVING count(*) > 1
-- ORDER BY production_batch_id, stage;

-- V2. Duplicate size rows, if that unique index was NOT created.
-- SELECT order_item_id, size, count(*) AS rows, array_agg(id ORDER BY id) AS size_row_ids,
--        array_agg(quantity ORDER BY id) AS quantities
-- FROM public.order_item_sizes
-- GROUP BY order_item_id, size HAVING count(*) > 1 ORDER BY order_item_id, size;

-- V3. DRIFT CHECK - the important one. Any row returned here is a counter that
--     disagrees with the ledger behind it, i.e. a quantity that was changed
--     without an event. Read it before deploying the new code: it tells you
--     whether the free-text quantity fields were used to move a figure in the
--     past. It changes nothing.
-- SELECT po.id AS operation_id, pb.batch_number, po.stage,
--        po.quantity_received AS stored_received,
--        COALESCE(SUM(CASE WHEN pm.event_type IN ('ALLOCATION','STAGE_RECEIPT','RECEIVED_CORRECTION') THEN pm.quantity ELSE 0 END), 0) AS ledger_received,
--        po.quantity_completed AS stored_completed,
--        COALESCE(SUM(CASE WHEN pm.event_type IN ('SUBMISSION','SUBMITTED_CORRECTION') THEN pm.quantity ELSE 0 END), 0) AS ledger_completed,
--        po.quantity_approved AS stored_approved,
--        COALESCE(SUM(CASE WHEN pm.event_type = 'INSPECTION_APPROVED' THEN pm.quantity ELSE 0 END), 0) AS ledger_approved,
--        po.quantity_rejected AS stored_rejected,
--        COALESCE(SUM(CASE WHEN pm.event_type IN ('INSPECTION_REJECTED','REJECTED_CORRECTION') THEN pm.quantity ELSE 0 END), 0) AS ledger_rejected
-- FROM public.production_operations po
-- INNER JOIN public.production_batches pb ON pb.id = po.production_batch_id
-- LEFT JOIN public.production_movements pm ON pm.production_operation_id = po.id
-- GROUP BY po.id, pb.batch_number, po.stage, po.quantity_received, po.quantity_completed,
--          po.quantity_approved, po.quantity_rejected
-- HAVING po.quantity_received <> COALESCE(SUM(CASE WHEN pm.event_type IN ('ALLOCATION','STAGE_RECEIPT','RECEIVED_CORRECTION') THEN pm.quantity ELSE 0 END), 0)
--     OR po.quantity_completed <> COALESCE(SUM(CASE WHEN pm.event_type IN ('SUBMISSION','SUBMITTED_CORRECTION') THEN pm.quantity ELSE 0 END), 0)
--     OR po.quantity_approved  <> COALESCE(SUM(CASE WHEN pm.event_type = 'INSPECTION_APPROVED' THEN pm.quantity ELSE 0 END), 0)
--     OR po.quantity_rejected  <> COALESCE(SUM(CASE WHEN pm.event_type IN ('INSPECTION_REJECTED','REJECTED_CORRECTION') THEN pm.quantity ELSE 0 END), 0)
-- ORDER BY pb.batch_number, po.stage;

-- V4. Indexes actually present.
-- SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public'
-- ORDER BY tablename, indexname;
