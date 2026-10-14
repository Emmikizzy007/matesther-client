-- ONLY for an installation on which none of the new payroll tables has data.
-- This deliberately REFUSES to erase a proposal, audit event, attendance record,
-- posted statement, cooperative credit or reversal. Reverting application code
-- while leaving populated tables intact is safer than deleting financial history.
-- Verify you are connected to the correct CLIENT database and have a backup.
BEGIN;
DO $$
DECLARE
  table_name text;
  rows_present boolean;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'payroll_deduction_categories', 'payroll_attendance', 'payroll_deductions',
    'payroll_deduction_audit', 'payroll_statements', 'payroll_statement_lines',
    'payroll_reversals'
  ] LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', table_name) INTO rows_present;
      IF rows_present THEN
        RAISE EXCEPTION 'Cannot remove %: payroll history exists. Revert code only and retain tables.', table_name;
      END IF;
    END IF;
  END LOOP;
END $$;
DROP TABLE IF EXISTS public.payroll_reversals, public.payroll_statement_lines,
  public.payroll_statements, public.payroll_deductions, public.payroll_attendance,
  public.payroll_deduction_categories, public.payroll_deduction_audit;
COMMIT;
