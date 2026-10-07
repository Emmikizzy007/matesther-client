-- MATESTHER CLIENT: OPTIONAL ATOMICITY PROBE.
--
-- THIS IS NOT A MIGRATION. It creates nothing, alters nothing and is not part of any
-- upgrade. Do not paste it into a migration run, and do not paste a migration into it.
--
-- WHAT IT IS FOR
--   Both destructive acts in this application - removing an order, and the
--   administrative test-data purge - run as a single database transaction, so on
--   PostgreSQL a failure part-way through must leave the database exactly as it was.
--   The automated suite cannot demonstrate that: it runs on pg-mem, whose adapter does
--   NOT roll back (verified directly, by throwing inside a transaction after an insert
--   and watching the insert survive). The suite therefore asserts the two properties
--   that ARE observable and that the rollback depends on - every refusal happens before
--   any write, and stock is restored from the records being removed inside the same
--   transaction, before they are deleted. This file covers the remaining half, on a
--   real server.
--
-- WHEN TO RUN IT
--   After deploy/upgrade-test-data-cleanup.sql has been applied AND verified, because
--   the probes write into public.order_deletions and then undo it - the table has to
--   exist first. Once is enough. It is safe to run more than once.
--
-- WHY IT IS A SEPARATE FILE
--   An earlier revision of the upgrade script ended with a probe that deliberately
--   raised `probe: deliberate abort`. Pasted as part of the whole file, and with no
--   COMMIT before it, that RAISE aborted the one implicit transaction the entire
--   upgrade was running in and rolled the whole upgrade back. The database was left
--   unchanged and unharmed, but the person deploying saw an error and could not tell
--   from the script whether the tables had been created.
--
--   A test that is designed to fail must never share a submission with a migration that
--   is designed to succeed. So it lives here, on its own, and both probes below now
--   report their verdict as a ROW rather than as an error - there is nothing in this
--   file that is expected to raise.
--
-- WHAT IT TOUCHES
--   Nothing that survives. Each probe inserts one clearly-labelled row into
--   public.order_deletions and then undoes it, so a healthy server ends with the same
--   row count it started with. No application data is read, updated or deleted, no
--   temporary object is created, and no schema change is made.
--
--   (An earlier draft wrote to a TEMP table with ON COMMIT DROP. That was wrong: the
--   rollback that proves the point also drops the table, so the query meant to count
--   the surviving rows fails on a relation that no longer exists. Writing to the real
--   audit table is both simpler and a truer test - it is the same table the cleanup
--   writes to.)
--
-- IF A PROBE REPORTS RESIDUE, STOP. Transactions are not rolling back on this server,
-- and neither order removal nor the test-data cleanup may be used until that is
-- understood - both would be able to leave the database half-changed. The row left
-- behind is identifiable by its order_number, which begins `PROBE-`.

-- ---------------------------------------------------------------------------
-- 0. PRECONDITION - run this first. It changes nothing and cannot raise.
--
-- EXPECT: both columns non-NULL. If either is NULL, that table does not exist yet and
-- you must apply and verify deploy/upgrade-test-data-cleanup.sql before going further.
-- `to_regclass` returns NULL for a missing relation instead of raising, which is why
-- this uses it rather than a `::regclass` cast.
-- ---------------------------------------------------------------------------
SELECT to_regclass('public.order_deletions')  AS order_deletions,
       to_regclass('public.test_data_purges') AS test_data_purges;

-- ---------------------------------------------------------------------------
-- PROBE A - does an explicit ROLLBACK undo a write?  (the primary probe)
--
-- This is the mechanism the application actually relies on: Drizzle opens a
-- transaction, and on any failure issues ROLLBACK. So this tests the real path, at the
-- top level of a transaction, rather than an error handler's approximation of it.
--
-- Paste this whole block and Run it once. EXPECT: no error, one result row,
-- rolled_back_insert = 0. If your editor reports
-- `WARNING: there is already a transaction in progress`, that is your editor's own
-- transaction and this one being the same thing; ignore it.
-- ---------------------------------------------------------------------------
BEGIN;

INSERT INTO public.order_deletions
  (order_id, order_number, deleted_by_name, reason)
VALUES
  (0, 'PROBE-ROLLED-BACK', 'atomicity probe',
   'This row was inserted inside a transaction that was then rolled back. If you can read it, rollback is not working.');

ROLLBACK;

-- EXPECT: rolled_back_insert = 0, and both row counts the same as before you ran
-- Probe A. A rolled-back insert needs no cleanup, so this probe leaves no residue.
SELECT
  (SELECT count(*) FROM public.order_deletions
    WHERE order_number = 'PROBE-ROLLED-BACK')          AS rolled_back_insert,
  (SELECT count(*) FROM public.order_deletions)        AS deletion_rows,
  (SELECT count(*) FROM public.test_data_purges)       AS purge_rows;

-- ---------------------------------------------------------------------------
-- PROBE B - does an ERROR inside a block also undo its write?  (supplementary)
--
-- Probe A tests ROLLBACK. This tests the other half of the same guarantee: that a
-- raised error rolls back the work of the block it happened in, which is what turns an
-- application exception into a rollback rather than a half-applied change.
--
-- The exception is caught here on purpose. An uncaught one would halt the editor at
-- this statement, which is exactly the failure that made the previous revision of this
-- probe unreadable - so the block finishes cleanly and reports its verdict as a row.
-- The rollback under test is the one PostgreSQL performs for the inner block when the
-- exception is raised, which happens whether or not anything catches it afterwards.
--
-- EXPECT: no error, and Probe B's verdict row below reporting residue = 0. If the
-- server fails to roll back, the block raises `ATOMICITY FAILURE` instead - that error
-- is a genuine result, not a malfunction of the probe.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  survivors integer;
BEGIN
  BEGIN
    INSERT INTO public.order_deletions
      (order_id, order_number, deleted_by_name, reason)
    VALUES
      (0, 'PROBE-ERROR-ROLLED-BACK', 'atomicity probe',
       'This row was inserted by a block that then raised on purpose. If you can read it, an aborted block is not rolling back.');
    RAISE EXCEPTION 'probe: deliberate abort, caught by the handler below';
  EXCEPTION WHEN OTHERS THEN
    -- Reaching here means the block aborted. PostgreSQL has already rolled it back to
    -- the savepoint it opened for this handler; the count below is what proves it.
    NULL;
  END;

  SELECT count(*) INTO survivors
    FROM public.order_deletions
   WHERE order_number = 'PROBE-ERROR-ROLLED-BACK';

  IF survivors <> 0 THEN
    RAISE EXCEPTION
      'ATOMICITY FAILURE: % probe row(s) survived a deliberate abort. Do not use order removal or the test-data cleanup on this server until this is understood.',
      survivors;
  END IF;

  RAISE NOTICE 'ATOMICITY OK: an aborted block undid its own insert.';
END $$;

-- ---------------------------------------------------------------------------
-- VERDICT - the residue sweep. Run this last. It changes nothing.
--
-- EXPECT: probe_residue = 0 and a verdict of PASS. If probe_residue is anything other
-- than 0, the rows are printed beneath it so you can see exactly which probe left them.
-- ---------------------------------------------------------------------------
SELECT
  (SELECT count(*) FROM public.order_deletions
    WHERE order_number LIKE 'PROBE-%')                 AS probe_residue,
  CASE WHEN (SELECT count(*) FROM public.order_deletions
              WHERE order_number LIKE 'PROBE-%') = 0
       THEN 'PASS - this server rolls back'
       ELSE 'FAIL - STOP, do not use order removal or the test-data cleanup'
  END                                                  AS verdict,
  (SELECT count(*) FROM public.order_deletions)        AS deletion_rows,
  (SELECT count(*) FROM public.test_data_purges)       AS purge_rows;

SELECT id, order_id, order_number, deleted_by_name, reason, deleted_at
  FROM public.order_deletions
 WHERE order_number LIKE 'PROBE-%'
 ORDER BY id;
