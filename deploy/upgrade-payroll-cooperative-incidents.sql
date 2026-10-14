-- Hand-run CLIENT database upgrade for Matesther cooperative savings,
-- production incidents and simplified deductions (task release 0014).
-- Back up and confirm the correct Supabase project first; test on staging.
-- Additive and repeatable: four EMPTY tables plus one nullable column, no
-- seeds, no historical updates. SQL first, deploy app AFTER COMMIT and
-- verification. Do NOT run drizzle-kit migrate against a Supabase client:
-- the hand-run script also locks down REST access.
BEGIN;

-- ADDITIVE: four new tables (cooperative withdrawals, cooperative
-- adjustments, production incidents, dashboard card preferences) plus one
-- nullable column on payroll_deductions linking a charge to a reviewed
-- production incident. All new tables start EMPTY; nothing in existing
-- workers, worker_payments, inspections, earnings, orders, expenses or posted
-- payroll is changed. Cooperative savings are NOT re-hosted: posted
-- payroll_statement_lines.cooperative_credit rows remain the contribution
-- ledger, and balances are always computed (credits - paid withdrawals +
-- approved adjustments), never stored. Safe to rerun in PostgreSQL; apply to
-- the CLIENT database after a backup and BEFORE deploying code. The old code
-- can run with these empty extra tables. On Supabase use the hand-run upgrade
-- at deploy/upgrade-payroll-cooperative-incidents.sql, which ALSO enables RLS
-- and revokes direct anon/authenticated access.

CREATE TABLE IF NOT EXISTS "payroll_cooperative_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"worker_id" integer NOT NULL,
	"amount" integer NOT NULL,
	"reason" text NOT NULL,
	"reference" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_by_id" integer,
	"created_by_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"approved_by_id" integer,
	"approved_by_name" text,
	"approved_at" timestamp,
	"decision_reason" text,
	CONSTRAINT "payroll_coop_adjustment_status_check" CHECK ("payroll_cooperative_adjustments"."status" in ('PENDING','APPROVED','REJECTED','CANCELLED')),
	CONSTRAINT "payroll_coop_adjustment_amount_check" CHECK ("payroll_cooperative_adjustments"."amount" <> 0)
);

CREATE TABLE IF NOT EXISTS "payroll_cooperative_withdrawals" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"worker_id" integer NOT NULL,
	"amount" integer NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"requested_by_id" integer,
	"requested_by_name" text NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_by_id" integer,
	"reviewed_by_name" text,
	"reviewed_at" timestamp,
	"review_reason" text,
	"paid_on" date,
	"payment_method" text,
	"payment_reference" text,
	"payment_notes" text,
	"paid_by_id" integer,
	"paid_by_name" text,
	"paid_at" timestamp,
	CONSTRAINT "payroll_coop_withdrawal_status_check" CHECK ("payroll_cooperative_withdrawals"."status" in ('REQUESTED','APPROVED','REJECTED','CANCELLED','PAID')),
	CONSTRAINT "payroll_coop_withdrawal_amount_check" CHECK ("payroll_cooperative_withdrawals"."amount" > 0),
	CONSTRAINT "payroll_coop_withdrawal_paid_fields_check" CHECK (("payroll_cooperative_withdrawals"."status" <> 'PAID') or ("payroll_cooperative_withdrawals"."paid_on" is not null and "payroll_cooperative_withdrawals"."paid_by_id" is not null))
);

CREATE TABLE IF NOT EXISTS "production_incidents" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"worker_id" integer NOT NULL,
	"assignment_source" text NOT NULL,
	"production_operation_id" integer,
	"support_assignment_id" integer,
	"incident_type" text NOT NULL,
	"description" text NOT NULL,
	"assigned_quantity" integer,
	"completed_quantity" integer,
	"incomplete_quantity" integer,
	"damaged_quantity" integer,
	"missing_quantity" integer,
	"proposed_amount" integer,
	"proposed_calculation" text,
	"status" text DEFAULT 'REPORTED' NOT NULL,
	"reported_by_id" integer,
	"reported_by_name" text NOT NULL,
	"reported_at" timestamp DEFAULT now() NOT NULL,
	"reviewed_by_id" integer,
	"reviewed_by_name" text,
	"reviewed_at" timestamp,
	"review_reason" text,
	"approved_amount" integer,
	CONSTRAINT "production_incident_source_check" CHECK (("production_incidents"."assignment_source" = 'STAGE_OPERATION' and "production_incidents"."production_operation_id" is not null and "production_incidents"."support_assignment_id" is null) or ("production_incidents"."assignment_source" = 'SUPPORT_ASSIGNMENT' and "production_incidents"."support_assignment_id" is not null and "production_incidents"."production_operation_id" is null)),
	CONSTRAINT "production_incident_type_check" CHECK ("production_incidents"."incident_type" in ('INCOMPLETE_WORK','DAMAGED_CLOTHES','LOST_CLOTHES','OTHER')),
	CONSTRAINT "production_incident_status_check" CHECK ("production_incidents"."status" in ('REPORTED','CORRECTION_ONLY','APPROVED_FOR_DEDUCTION','REJECTED','CANCELLED')),
	CONSTRAINT "production_incident_quantities_check" CHECK (coalesce("production_incidents"."assigned_quantity", 0) >= 0 and coalesce("production_incidents"."completed_quantity", 0) >= 0 and coalesce("production_incidents"."incomplete_quantity", 0) >= 0 and coalesce("production_incidents"."damaged_quantity", 0) >= 0 and coalesce("production_incidents"."missing_quantity", 0) >= 0),
	CONSTRAINT "production_incident_proposed_amount_check" CHECK ("production_incidents"."proposed_amount" is null or "production_incidents"."proposed_amount" > 0),
	CONSTRAINT "production_incident_approved_amount_check" CHECK ("production_incidents"."approved_amount" is null or ("production_incidents"."approved_amount" > 0 and "production_incidents"."proposed_amount" is not null and "production_incidents"."approved_amount" <= "production_incidents"."proposed_amount"))
);

CREATE TABLE IF NOT EXISTS "user_dashboard_cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"card_key" text NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_dashboard_card_unique" UNIQUE("user_id","card_key")
);

ALTER TABLE "payroll_deductions" ADD COLUMN IF NOT EXISTS "incident_production_id" integer;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_cooperative_adjustments'::regclass AND conname = 'payroll_cooperative_adjustments_organization_id_organizations_id_fk') THEN
    ALTER TABLE "payroll_cooperative_adjustments" ADD CONSTRAINT "payroll_cooperative_adjustments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_cooperative_adjustments'::regclass AND conname = 'payroll_cooperative_adjustments_worker_id_workers_id_fk') THEN
    ALTER TABLE "payroll_cooperative_adjustments" ADD CONSTRAINT "payroll_cooperative_adjustments_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_cooperative_adjustments'::regclass AND conname = 'payroll_cooperative_adjustments_created_by_id_users_id_fk') THEN
    ALTER TABLE "payroll_cooperative_adjustments" ADD CONSTRAINT "payroll_cooperative_adjustments_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_cooperative_adjustments'::regclass AND conname = 'payroll_cooperative_adjustments_approved_by_id_users_id_fk') THEN
    ALTER TABLE "payroll_cooperative_adjustments" ADD CONSTRAINT "payroll_cooperative_adjustments_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_cooperative_withdrawals'::regclass AND conname = 'payroll_cooperative_withdrawals_organization_id_organizations_id_fk') THEN
    ALTER TABLE "payroll_cooperative_withdrawals" ADD CONSTRAINT "payroll_cooperative_withdrawals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_cooperative_withdrawals'::regclass AND conname = 'payroll_cooperative_withdrawals_worker_id_workers_id_fk') THEN
    ALTER TABLE "payroll_cooperative_withdrawals" ADD CONSTRAINT "payroll_cooperative_withdrawals_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_cooperative_withdrawals'::regclass AND conname = 'payroll_cooperative_withdrawals_requested_by_id_users_id_fk') THEN
    ALTER TABLE "payroll_cooperative_withdrawals" ADD CONSTRAINT "payroll_cooperative_withdrawals_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_cooperative_withdrawals'::regclass AND conname = 'payroll_cooperative_withdrawals_reviewed_by_id_users_id_fk') THEN
    ALTER TABLE "payroll_cooperative_withdrawals" ADD CONSTRAINT "payroll_cooperative_withdrawals_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_cooperative_withdrawals'::regclass AND conname = 'payroll_cooperative_withdrawals_paid_by_id_users_id_fk') THEN
    ALTER TABLE "payroll_cooperative_withdrawals" ADD CONSTRAINT "payroll_cooperative_withdrawals_paid_by_id_users_id_fk" FOREIGN KEY ("paid_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_incidents'::regclass AND conname = 'production_incidents_organization_id_organizations_id_fk') THEN
    ALTER TABLE "production_incidents" ADD CONSTRAINT "production_incidents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_incidents'::regclass AND conname = 'production_incidents_worker_id_workers_id_fk') THEN
    ALTER TABLE "production_incidents" ADD CONSTRAINT "production_incidents_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_incidents'::regclass AND conname = 'production_incidents_production_operation_id_production_operations_id_fk') THEN
    ALTER TABLE "production_incidents" ADD CONSTRAINT "production_incidents_production_operation_id_production_operations_id_fk" FOREIGN KEY ("production_operation_id") REFERENCES "public"."production_operations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_incidents'::regclass AND conname = 'production_incidents_support_assignment_id_support_assignments_id_fk') THEN
    ALTER TABLE "production_incidents" ADD CONSTRAINT "production_incidents_support_assignment_id_support_assignments_id_fk" FOREIGN KEY ("support_assignment_id") REFERENCES "public"."support_assignments"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_incidents'::regclass AND conname = 'production_incidents_reported_by_id_users_id_fk') THEN
    ALTER TABLE "production_incidents" ADD CONSTRAINT "production_incidents_reported_by_id_users_id_fk" FOREIGN KEY ("reported_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_incidents'::regclass AND conname = 'production_incidents_reviewed_by_id_users_id_fk') THEN
    ALTER TABLE "production_incidents" ADD CONSTRAINT "production_incidents_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.user_dashboard_cards'::regclass AND conname = 'user_dashboard_cards_user_id_users_id_fk') THEN
    ALTER TABLE "user_dashboard_cards" ADD CONSTRAINT "user_dashboard_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "payroll_coop_adjustment_org_status_idx" ON "payroll_cooperative_adjustments" USING btree ("organization_id","status");

CREATE INDEX IF NOT EXISTS "payroll_coop_adjustment_worker_idx" ON "payroll_cooperative_adjustments" USING btree ("worker_id");

CREATE INDEX IF NOT EXISTS "payroll_coop_withdrawal_org_status_idx" ON "payroll_cooperative_withdrawals" USING btree ("organization_id","status");

CREATE INDEX IF NOT EXISTS "payroll_coop_withdrawal_worker_idx" ON "payroll_cooperative_withdrawals" USING btree ("worker_id");

CREATE UNIQUE INDEX IF NOT EXISTS "payroll_coop_withdrawal_payment_ref_unique" ON "payroll_cooperative_withdrawals" USING btree ("organization_id","payment_reference") WHERE "payroll_cooperative_withdrawals"."status" = 'PAID' and "payroll_cooperative_withdrawals"."payment_reference" is not null;

CREATE INDEX IF NOT EXISTS "production_incident_org_idx" ON "production_incidents" USING btree ("organization_id","status");

CREATE INDEX IF NOT EXISTS "production_incident_worker_idx" ON "production_incidents" USING btree ("worker_id");

CREATE INDEX IF NOT EXISTS "production_incident_stage_idx" ON "production_incidents" USING btree ("production_operation_id");

CREATE INDEX IF NOT EXISTS "production_incident_support_idx" ON "production_incidents" USING btree ("support_assignment_id");

CREATE UNIQUE INDEX IF NOT EXISTS "production_incident_stage_active_unique" ON "production_incidents" USING btree ("organization_id","production_operation_id","incident_type") WHERE "production_incidents"."status" in ('REPORTED','CORRECTION_ONLY','APPROVED_FOR_DEDUCTION') and "production_incidents"."production_operation_id" is not null;

CREATE UNIQUE INDEX IF NOT EXISTS "production_incident_support_active_unique" ON "production_incidents" USING btree ("organization_id","support_assignment_id","incident_type") WHERE "production_incidents"."status" in ('REPORTED','CORRECTION_ONLY','APPROVED_FOR_DEDUCTION') and "production_incidents"."support_assignment_id" is not null;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_deductions'::regclass AND conname = 'payroll_deductions_incident_production_id_production_incidents_id_fk') THEN
    ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_incident_production_id_production_incidents_id_fk" FOREIGN KEY ("incident_production_id") REFERENCES "public"."production_incidents"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "payroll_deduction_incident_production_active_unique" ON "payroll_deductions" USING btree ("incident_production_id") WHERE "payroll_deductions"."status" in ('PENDING','APPROVED') and "payroll_deductions"."incident_production_id" is not null;

-- Sensitive payroll/cooperative/incident records MUST NOT be accessible
-- through Supabase's public REST roles. The server connects as the existing
-- trusted database role and enforces Owner + organisation permissions; no
-- direct anon/authenticated API. Re-running these steps also repairs a
-- drifted permission/RLS configuration.
DO $payroll_security$
DECLARE
  app_table text;
BEGIN
  FOREACH app_table IN ARRAY ARRAY[
    'payroll_cooperative_withdrawals', 'payroll_cooperative_adjustments',
    'production_incidents', 'user_dashboard_cards'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', app_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', app_table);
    EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM PUBLIC', app_table || '_id_seq');
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', app_table);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM anon', app_table || '_id_seq');
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', app_table);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM authenticated', app_table || '_id_seq');
    END IF;
  END LOOP;
END $payroll_security$;

COMMIT;

-- Read-only verification (run after COMMIT): four new tables, all empty on a
-- new installation, with RLS enabled and the incident link column present.
SELECT
  (SELECT count(*) FROM public.payroll_cooperative_withdrawals) AS withdrawal_requests,
  (SELECT count(*) FROM public.payroll_cooperative_adjustments) AS cooperative_adjustments,
  (SELECT count(*) FROM public.production_incidents) AS production_incidents,
  (SELECT count(*) FROM public.user_dashboard_cards) AS dashboard_card_prefs;
SELECT c.relname AS secured_table, c.relrowsecurity AS rls_enabled
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN (
  'payroll_cooperative_withdrawals', 'payroll_cooperative_adjustments',
  'production_incidents', 'user_dashboard_cards')
ORDER BY c.relname;
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'payroll_deductions'
  AND column_name = 'incident_production_id';
SELECT tablename, indexname FROM pg_indexes
WHERE schemaname = 'public' AND tablename IN (
  'payroll_cooperative_withdrawals', 'payroll_cooperative_adjustments',
  'production_incidents', 'user_dashboard_cards', 'payroll_deductions')
ORDER BY tablename, indexname;
