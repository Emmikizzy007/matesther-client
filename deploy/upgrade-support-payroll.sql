-- MATESTHER CLIENT: SUPPORT WORK, SALARIED STAFF AND PAYMENT SHEET UPGRADE.
-- Make a backup first. Run this in the SQL Editor of the project used by your
-- CLIENT site. Safe to run more than once.
--
-- WHAT THIS DOES
--   1. Creates public.support_assignments and public.support_inspections, so a
--      tailor can hand weaving/taping/other supporting work to a helper, and
--      the helper's approved work becomes payable.
--   2. Adds public.workers.department and public.workers.job_title, so security,
--      sales, IT, admin and management staff can be recorded without being
--      forced into a production specialty such as Tailor.
--   3. Adds the payment detail a monthly bank payment sheet needs:
--      support and other payment amounts, a bank reference, and a unique
--      idempotency key so the same payment can never be recorded twice.
--   4. Adds public.worker_overtime.category so an approved allowance or bonus
--      can be recorded separately from overtime.
--
-- WHAT THIS NEVER DOES
--   * no DROP, no TRUNCATE, no DELETE, no RENAME,
--   * no change to any existing column's type or meaning,
--   * no insert, update or delete of any existing row.
--
-- Every existing worker keeps working unchanged. New columns default to values
-- that reproduce today's behaviour: overtime stays OVERTIME, the new payment
-- amounts default to 0, and department/job title stay empty until filled in.
--
-- NOTHING NEEDS BACKFILLING. Production piecework is unchanged. Support work
-- simply becomes available, and staff positions become selectable under Workers.
--
-- ORDER OF WORK: back up -> run this file -> run the verification query at the
-- bottom -> deploy the new application code. SQL first, code second.
-- See deploy/UPDATE-INSTRUCTIONS.md.

BEGIN;

-- ---------- Tailor support work ----------
-- The parent tailor's production_operations row is left completely alone; this
-- links to it for traceability and never replaces it.
CREATE TABLE IF NOT EXISTS public.support_assignments (
  id serial PRIMARY KEY,
  organization_id integer REFERENCES public.organizations(id),
  assigned_by_worker_id integer NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
  worker_id integer NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
  production_operation_id integer REFERENCES public.production_operations(id) ON DELETE SET NULL,
  order_id integer REFERENCES public.orders(id) ON DELETE SET NULL,
  operation text NOT NULL,
  piece_rate integer NOT NULL DEFAULT 0,
  quantity_assigned integer NOT NULL DEFAULT 0,
  quantity_submitted integer NOT NULL DEFAULT 0,
  quantity_approved integer NOT NULL DEFAULT 0,
  quantity_rework integer NOT NULL DEFAULT 0,
  quantity_rejected integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ASSIGNED',
  assigned_at timestamp DEFAULT now(),
  submitted_at timestamp,
  inspected_at timestamp,
  approved_by_worker_id integer REFERENCES public.workers(id) ON DELETE SET NULL,
  notes text,
  created_at timestamp DEFAULT now()
);

-- Append-only inspection history: every pass is a new row, so rework and
-- rejection are preserved rather than overwritten.
CREATE TABLE IF NOT EXISTS public.support_inspections (
  id serial PRIMARY KEY,
  support_assignment_id integer NOT NULL REFERENCES public.support_assignments(id) ON DELETE CASCADE,
  inspected_by text NOT NULL,
  piece_rate integer,
  quantity_approved integer NOT NULL DEFAULT 0,
  quantity_rework integer NOT NULL DEFAULT 0,
  quantity_rejected integer NOT NULL DEFAULT 0,
  notes text,
  inspected_at timestamp DEFAULT now()
);

ALTER TABLE public.support_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_inspections ENABLE ROW LEVEL SECURITY;

DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.support_assignments FROM anon;
    REVOKE ALL ON SEQUENCE public.support_assignments_id_seq FROM anon;
    REVOKE ALL ON public.support_inspections FROM anon;
    REVOKE ALL ON SEQUENCE public.support_inspections_id_seq FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.support_assignments FROM authenticated;
    REVOKE ALL ON SEQUENCE public.support_assignments_id_seq FROM authenticated;
    REVOKE ALL ON public.support_inspections FROM authenticated;
    REVOKE ALL ON SEQUENCE public.support_inspections_id_seq FROM authenticated;
  END IF;
END $permissions$;

-- ---------- Staff records and payment detail (all additive) ----------
ALTER TABLE public.workers ADD COLUMN IF NOT EXISTS department text;
ALTER TABLE public.workers ADD COLUMN IF NOT EXISTS job_title text;

ALTER TABLE public.worker_overtime ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'OVERTIME';

ALTER TABLE public.worker_payments ADD COLUMN IF NOT EXISTS support_amount integer NOT NULL DEFAULT 0;
ALTER TABLE public.worker_payments ADD COLUMN IF NOT EXISTS other_amount integer NOT NULL DEFAULT 0;
ALTER TABLE public.worker_payments ADD COLUMN IF NOT EXISTS reference text;
ALTER TABLE public.worker_payments ADD COLUMN IF NOT EXISTS idempotency_key text;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.worker_payments'::regclass AND conname='worker_payments_idempotency_key_unique') THEN
    -- The same payment can never be recorded twice. Rows with no key stay NULL
    -- and never collide, so ordinary part payments are unaffected.
    ALTER TABLE public.worker_payments ADD CONSTRAINT worker_payments_idempotency_key_unique UNIQUE (idempotency_key);
  END IF;
END $constraints$;

COMMIT;

-- Verify: both tables exist, the new columns exist, the unique guard is in
-- place, and nothing was lost.
SELECT
  (SELECT count(*) FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('support_assignments', 'support_inspections'))    AS support_tables,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema = 'public'
       AND ((table_name = 'workers' AND column_name IN ('department', 'job_title'))
         OR (table_name = 'worker_overtime' AND column_name = 'category')
         OR (table_name = 'worker_payments'
             AND column_name IN ('support_amount', 'other_amount', 'reference', 'idempotency_key'))))
                                                                            AS new_columns,
  (SELECT count(*) FROM pg_constraint
     WHERE conrelid = 'public.worker_payments'::regclass
       AND conname = 'worker_payments_idempotency_key_unique')              AS duplicate_payment_guard,
  (SELECT count(*) FROM public.workers)                                     AS worker_profiles,
  (SELECT count(*) FROM public.production_operations)                       AS production_history_preserved,
  (SELECT count(*) FROM public.stage_inspections)                           AS inspection_history_preserved,
  (SELECT count(*) FROM public.worker_payments)                             AS pay_history_preserved,
  (SELECT count(*) FROM public.worker_overtime)                             AS overtime_preserved;

-- Expected: support_tables = 2, new_columns = 7, duplicate_payment_guard = 1,
-- and the last five numbers identical to what they were before you ran this file.
