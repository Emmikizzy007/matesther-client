-- MATESTHER CLIENT: MULTI-ROLE WORKERS UPGRADE FOR AN EXISTING DATABASE.
-- Make a backup first. Run this in the SQL Editor of the project used by your
-- CLIENT site. Safe to run more than once.
--
-- WHAT THIS DOES
--   Creates ONE new table, public.worker_roles, that lets a single person hold
--   several production roles (for example Cutter AND Tailor) instead of forcing
--   a duplicate person record per role.
--
-- WHAT THIS NEVER DOES
--   * no DROP, no TRUNCATE, no DELETE,
--   * no change to any existing column, including public.workers.specialty,
--   * no insert, update or delete of any existing row.
--
-- NOTHING NEEDS BACKFILLING. The application treats workers.specialty as a role
-- the person already holds, so every existing worker keeps working the moment
-- the new code deploys, even with public.worker_roles empty.
--
-- ORDER OF WORK: back up -> run this file -> run the verification query at the
-- bottom -> deploy the new application code. SQL first, code second.
-- See deploy/UPDATE-INSTRUCTIONS.md.

BEGIN;

-- One row per person per role. is_primary marks the role shown first in lists.
CREATE TABLE IF NOT EXISTS public.worker_roles (
  id serial PRIMARY KEY,
  worker_id integer NOT NULL REFERENCES public.workers(id) ON DELETE CASCADE,
  role text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamp DEFAULT now()
);

ALTER TABLE public.worker_roles ENABLE ROW LEVEL SECURITY;

DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.worker_roles FROM anon;
    REVOKE ALL ON SEQUENCE public.worker_roles_id_seq FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.worker_roles FROM authenticated;
    REVOKE ALL ON SEQUENCE public.worker_roles_id_seq FROM authenticated;
  END IF;
END $permissions$;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.worker_roles'::regclass AND conname='worker_roles_worker_id_role_unique') THEN
    -- Duplicate role assignments for the same person are rejected here, not only
    -- in the application, so the same role can never be stored twice.
    ALTER TABLE public.worker_roles ADD CONSTRAINT worker_roles_worker_id_role_unique UNIQUE (worker_id, role);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.worker_roles'::regclass AND conname='worker_roles_worker_id_workers_id_fk') THEN
    ALTER TABLE public.worker_roles ADD CONSTRAINT worker_roles_worker_id_workers_id_fk
      FOREIGN KEY (worker_id) REFERENCES public.workers(id) ON DELETE CASCADE;
  END IF;
END $constraints$;

COMMIT;

-- OPTIONAL AND OFF BY DEFAULT. Not needed: specialty already counts as a role.
-- Only run it if you want reports that read public.worker_roles alone. It adds
-- rows to the new table and changes nothing that already exists. Re-running it
-- is a no-op.
-- INSERT INTO public.worker_roles (worker_id, role, is_primary)
-- SELECT id, specialty, true FROM public.workers
-- WHERE specialty IS NOT NULL AND trim(specialty) <> ''
-- ON CONFLICT (worker_id, role) DO NOTHING;

-- Verify: the table exists with both constraints, and nothing was lost.
SELECT
  (SELECT count(*) FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'worker_roles')          AS worker_roles_table,
  (SELECT count(*) FROM pg_constraint
     WHERE conrelid = 'public.worker_roles'::regclass
       AND conname IN ('worker_roles_worker_id_role_unique',
                       'worker_roles_worker_id_workers_id_fk'))             AS worker_roles_constraints,
  (SELECT count(*) FROM public.workers)                                     AS worker_profiles,
  (SELECT count(*) FROM public.production_operations)                       AS production_history_preserved,
  (SELECT count(*) FROM public.stage_inspections)                           AS inspection_history_preserved,
  (SELECT count(*) FROM public.worker_payments)                             AS pay_history_preserved;

-- Expected: worker_roles_table = 1, worker_roles_constraints = 2, and the last
-- four numbers identical to what they were before you ran this file.
