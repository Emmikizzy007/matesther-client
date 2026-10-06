-- MATESTHER CLIENT: WHO RECORDED A RECEIPT, A PACKING RECORD AND A DELIVERY.
-- Make a backup first. Run this in the SQL Editor of the project used by your
-- CLIENT site. Safe to run more than once.
--
-- WHAT THIS DOES
--   payments, packing_records and deliveries each gain recorded_by_id and
--   recorded_by_name, both nullable. Until now these three were the only
--   money-and-goods mutations in the system that could answer WHAT happened and
--   WHEN, but not WHO entered it. From this upgrade the application writes the
--   signed-in user into both columns on every new receipt, packing record and
--   delivery, derived from the session - never from anything the browser sends.
--
-- WHY IT IS SAFE
--   Every statement is ADD COLUMN IF NOT EXISTS or a guarded ADD CONSTRAINT.
--   Nothing is NOT NULL, nothing has a default, and there is no DELETE, no
--   TRUNCATE, no DROP, no RENAME and no data write of any kind.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   It does NOT backfill an actor onto existing rows. Every receipt, packing
--   record and delivery already in your database keeps a NULL actor, because that
--   is the truth about it: the system did not record who entered it. Writing a
--   guessed name onto a historical financial document would be worse than leaving
--   the question open, and the columns are nullable precisely so those rows stay
--   valid. On the receipt, packing and delivery screens an older record therefore
--   shows no "recorded by", and a new one shows who entered it.
--
-- ORDER OF WORK (as always): run this SQL FIRST, then deploy the new code. The
-- new code writes these columns, so deploying code before the columns exist would
-- fail. Existing code ignores columns it does not know about, so running this
-- first is harmless.

-- ---------------------------------------------------------------------------
-- 1. THE COLUMNS
-- ---------------------------------------------------------------------------
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "recorded_by_id" integer;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "recorded_by_name" text;
ALTER TABLE "packing_records" ADD COLUMN IF NOT EXISTS "recorded_by_id" integer;
ALTER TABLE "packing_records" ADD COLUMN IF NOT EXISTS "recorded_by_name" text;
ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "recorded_by_id" integer;
ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "recorded_by_name" text;

-- ---------------------------------------------------------------------------
-- 2. THE FOREIGN KEYS, each added only if it is not already there.
--    ON DELETE set null: if a user is ever deleted, the name still reads as the
--    record of who it was, and the row is not dragged out with them.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payments'::regclass AND conname = 'payments_recorded_by_id_users_id_fk') THEN
    ALTER TABLE "public"."payments" ADD CONSTRAINT "payments_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.packing_records'::regclass AND conname = 'packing_records_recorded_by_id_users_id_fk') THEN
    ALTER TABLE "public"."packing_records" ADD CONSTRAINT "packing_records_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.deliveries'::regclass AND conname = 'deliveries_recorded_by_id_users_id_fk') THEN
    ALTER TABLE "public"."deliveries" ADD CONSTRAINT "deliveries_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- VERIFICATION (commented out on purpose - run these one at a time after the
-- upgrade and check the answers against what is written beside each).
-- ---------------------------------------------------------------------------

-- V1. All six columns exist. Expected: 6 rows.
-- SELECT table_name, column_name, is_nullable FROM information_schema.columns
--  WHERE column_name IN ('recorded_by_id','recorded_by_name')
--    AND table_name IN ('payments','packing_records','deliveries')
--  ORDER BY table_name, column_name;

-- V2. Every one of them is nullable, so historical rows are still valid.
--     Expected: 0 rows.
-- SELECT table_name, column_name FROM information_schema.columns
--  WHERE column_name IN ('recorded_by_id','recorded_by_name')
--    AND table_name IN ('payments','packing_records','deliveries')
--    AND is_nullable <> 'YES';

-- V3. The three foreign keys were added exactly once. Expected: 3 rows.
-- SELECT conname FROM pg_constraint
--  WHERE conname IN ('payments_recorded_by_id_users_id_fk',
--                    'packing_records_recorded_by_id_users_id_fk',
--                    'deliveries_recorded_by_id_users_id_fk')
--  ORDER BY conname;

-- V4. Nothing was backfilled: every existing row still has no actor, and the row
--     counts are exactly what they were before the upgrade. Expected: all zeros
--     beside unchanged counts.
-- SELECT (SELECT count(*) FROM payments)          AS receipts,
--        (SELECT count(*) FROM payments WHERE recorded_by_id IS NOT NULL)          AS receipts_with_actor,
--        (SELECT count(*) FROM packing_records)    AS packing,
--        (SELECT count(*) FROM packing_records WHERE recorded_by_id IS NOT NULL)   AS packing_with_actor,
--        (SELECT count(*) FROM deliveries)         AS deliveries,
--        (SELECT count(*) FROM deliveries WHERE recorded_by_id IS NOT NULL)        AS deliveries_with_actor;
