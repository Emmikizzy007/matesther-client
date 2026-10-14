-- ONLY for an installation on which none of the new tables has data and the
-- new payroll_deductions column is unused. This deliberately REFUSES to erase
-- a withdrawal request, cooperative adjustment, production incident or
-- dashboard preference. Reverting application code while leaving populated
-- tables intact is safer than deleting financial history.
-- Verify you are connected to the correct CLIENT database and have a backup.
BEGIN;
DO $$
DECLARE
  table_name text;
  rows_present boolean;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'payroll_cooperative_withdrawals', 'payroll_cooperative_adjustments',
    'production_incidents', 'user_dashboard_cards'
  ] LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', table_name) INTO rows_present;
      IF rows_present THEN
        RAISE EXCEPTION 'Cannot remove %: cooperative/incident history exists. Revert code only and retain tables.', table_name;
      END IF;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM public.payroll_deductions
    WHERE incident_production_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Cannot drop payroll_deductions.incident_production_id: linked deductions exist. Revert code only.';
  END IF;
END $$;
ALTER TABLE public.payroll_deductions DROP COLUMN IF EXISTS incident_production_id;
DROP TABLE IF EXISTS public.user_dashboard_cards, public.production_incidents,
  public.payroll_cooperative_adjustments, public.payroll_cooperative_withdrawals;
COMMIT;
