-- MATESTHER CLIENT: ONE SAFE, REPEATABLE UPGRADE FOR AN EXISTING DATABASE.
-- Make a backup first. Run this in the Supabase project used by your CLIENT site.
-- It does not reset or delete any existing users, orders, workers or inspection records.
-- Do NOT run deploy/schema-only.sql or deploy/full-setup.sql on a populated project.

BEGIN;

-- Preserve existing branding and letterheaded customer documents.
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS logo_data text;
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS logo_mime text;
CREATE TABLE IF NOT EXISTS public.delivery_lines (
  id serial PRIMARY KEY,
  delivery_id integer NOT NULL REFERENCES public.deliveries(id) ON DELETE CASCADE,
  order_item_id integer REFERENCES public.order_items(id) ON DELETE SET NULL,
  description text NOT NULL,
  size text,
  quantity integer NOT NULL CHECK (quantity > 0)
);
ALTER TABLE public.delivery_lines ENABLE ROW LEVEL SECURITY;
DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.delivery_lines FROM anon;
    REVOKE ALL ON SEQUENCE public.delivery_lines_id_seq FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.delivery_lines FROM authenticated;
    REVOKE ALL ON SEQUENCE public.delivery_lines_id_seq FROM authenticated;
  END IF;
END $permissions$;

-- Keep the optional ID link used by some earlier Worker accounts. New Worker
-- logins do not need a link and find a unique matching record by full name.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS worker_id integer;
DO $worker_link$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.users'::regclass AND conname='users_worker_id_workers_id_fk') THEN
    ALTER TABLE public.users ADD CONSTRAINT users_worker_id_workers_id_fk FOREIGN KEY (worker_id) REFERENCES public.workers(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.users'::regclass AND conname='users_worker_id_unique') THEN
    ALTER TABLE public.users ADD CONSTRAINT users_worker_id_unique UNIQUE (worker_id);
  END IF;
END $worker_link$;

-- One batch per garment size and colour; each production stage gets its own
-- price per approved garment. Snapshots on inspection preserve pay history.
ALTER TABLE public.production_batches ADD COLUMN IF NOT EXISTS size text;
ALTER TABLE public.production_batches ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE public.production_operations ADD COLUMN IF NOT EXISTS piece_rate integer;
ALTER TABLE public.stage_inspections ADD COLUMN IF NOT EXISTS piece_rate integer;
ALTER TABLE public.workers ADD COLUMN IF NOT EXISTS archived_at timestamp;

-- Snapshot old per-piece rates on already-assigned work before the new workflow
-- starts. Existing approved garments keep their original expected earnings.
UPDATE public.production_operations AS job
SET piece_rate = worker.payment_rate
FROM public.workers AS worker
WHERE job.worker_id = worker.id
  AND job.piece_rate IS NULL
  AND worker.payment_type = 'PER_PIECE'
  AND worker.payment_rate > 0;
UPDATE public.stage_inspections AS check_record
SET piece_rate = job.piece_rate
FROM public.production_operations AS job
WHERE check_record.production_operation_id = job.id
  AND check_record.piece_rate IS NULL
  AND job.piece_rate IS NOT NULL;

COMMIT;

-- Verify without revealing passwords:
SELECT (SELECT count(*) FROM public.users) AS staff_accounts,
       (SELECT count(*) FROM public.workers) AS worker_profiles,
       (SELECT count(*) FROM public.orders) AS orders_preserved,
       (SELECT count(*) FROM public.production_operations) AS production_history_preserved;
