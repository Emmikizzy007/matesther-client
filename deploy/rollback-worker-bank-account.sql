-- Rollback for migration 0015 (worker bank account numbers).
-- ONLY for an installation where the column has not yet been populated and
-- the bank schedule has not been issued from it. Dropping the column ERASES
-- any account numbers the Owner has recorded - this rollback deliberately
-- refuses to run when data is present. Verify you are connected to the
-- correct CLIENT database and have a backup.
BEGIN;
DO $$
DECLARE
  rows_present boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM workers WHERE bank_account_number IS NOT NULL
  ) INTO rows_present;
  IF rows_present THEN
    RAISE EXCEPTION 'REFUSING rollback: workers.bank_account_number is populated. Keep the column or export and clear it deliberately first.';
  END IF;
  ALTER TABLE workers DROP COLUMN IF EXISTS bank_account_number;
END $$;
COMMIT;
