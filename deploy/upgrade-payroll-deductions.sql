-- Hand-run CLIENT database upgrade for Matesther payroll deductions.
-- Back up and confirm the correct Supabase project first; test on staging.
-- Additive and repeatable: seven EMPTY tables, no seeds, no historical updates.
-- SQL first, deploy app AFTER COMMIT and verification. Do NOT run drizzle-kit
-- migrate against a Supabase client: the hand-run script also locks down REST.
BEGIN;
-- ADDITIVE: seven new payroll tables, all initially EMPTY. Nothing in existing
-- workers, worker_payments, inspections, earnings, orders or expenses is changed.
-- Safe to rerun in PostgreSQL; apply to the CLIENT database after a backup and
-- BEFORE deploying code. The old code can run with these empty extra tables.
-- Rollback refuses to drop tables containing payroll history.
-- On Supabase use the hand-run upgrade, which ALSO enables RLS and revokes
-- direct anon/authenticated access (not part of this Drizzle schema snapshot).


CREATE TABLE IF NOT EXISTS "payroll_attendance" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"worker_id" integer NOT NULL,
	"day" date NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_ref" text,
	"recorded_by_id" integer,
	"recorded_by_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_attendance_worker_day_unique" UNIQUE("worker_id","day"),
	CONSTRAINT "payroll_attendance_status_check" CHECK ("payroll_attendance"."status" in ('PRESENT','UNAUTHORIZED_ABSENCE','UNPAID_LEAVE','APPROVED_LEAVE','PAID_LEAVE','OTHER'))
);


CREATE TABLE IF NOT EXISTS "payroll_deduction_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" integer NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"before" text,
	"after" text,
	"actor_id" integer,
	"actor_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);


CREATE TABLE IF NOT EXISTS "payroll_deduction_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_id" integer,
	"created_by_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_category_org_slug_unique" UNIQUE("organization_id","slug")
);


CREATE TABLE IF NOT EXISTS "payroll_deductions" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"worker_id" integer NOT NULL,
	"category_code" text NOT NULL,
	"custom_category_id" integer,
	"category_name" text NOT NULL,
	"description" text NOT NULL,
	"method" text NOT NULL,
	"basis" text DEFAULT 'AFTER_SUPPORT' NOT NULL,
	"amount" integer,
	"rate_bps" integer,
	"frequency_months" integer DEFAULT 0 NOT NULL,
	"start_month" text NOT NULL,
	"end_month" text,
	"reference" text,
	"consent_ref" text,
	"consent_on" date,
	"authority_ref" text,
	"evidence_ref" text,
	"incident_inspection_id" integer,
	"incident_support_inspection_id" integer,
	"incident_quantity" integer,
	"incident_loss_amount" integer,
	"incident_findings" text,
	"incident_loss_basis" text,
	"attendance_id" integer,
	"working_days" integer,
	"annual_gross" integer,
	"annual_pension" integer,
	"annual_nhf" integer,
	"annual_nhis" integer,
	"annual_rent_paid" integer,
	"annual_other_relief" integer,
	"other_relief_basis" text,
	"minimum_wage_exempt" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_by_id" integer,
	"created_by_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"approved_by_id" integer,
	"approved_by_name" text,
	"approved_at" timestamp,
	"cancelled_by_id" integer,
	"cancelled_by_name" text,
	"cancelled_at" timestamp,
	"decision_reason" text,
	CONSTRAINT "payroll_deduction_worker_reference_unique" UNIQUE("organization_id","worker_id","reference"),
	CONSTRAINT "payroll_deduction_status_check" CHECK ("payroll_deductions"."status" in ('PENDING','APPROVED','CANCELLED','REJECTED')),
	CONSTRAINT "payroll_deduction_frequency_check" CHECK ("payroll_deductions"."frequency_months" between 0 and 12),
	CONSTRAINT "payroll_deduction_amount_check" CHECK ("payroll_deductions"."amount" is null or "payroll_deductions"."amount" > 0),
	CONSTRAINT "payroll_deduction_rate_check" CHECK ("payroll_deductions"."rate_bps" is null or "payroll_deductions"."rate_bps" between 1 and 10000),
	CONSTRAINT "payroll_deduction_days_check" CHECK ("payroll_deductions"."working_days" is null or "payroll_deductions"."working_days" between 1 and 31)
);


CREATE TABLE IF NOT EXISTS "payroll_reversals" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"worker_id" integer NOT NULL,
	"source_line_id" integer NOT NULL,
	"target_month" text NOT NULL,
	"amount" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"reason" text NOT NULL,
	"created_by_id" integer,
	"created_by_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"approved_by_id" integer,
	"approved_by_name" text,
	"approved_at" timestamp,
	"cancelled_by_id" integer,
	"cancelled_by_name" text,
	"cancelled_at" timestamp,
	CONSTRAINT "payroll_reversal_source_unique" UNIQUE("source_line_id"),
	CONSTRAINT "payroll_reversal_amount_check" CHECK ("payroll_reversals"."amount" > 0),
	CONSTRAINT "payroll_reversal_status_check" CHECK ("payroll_reversals"."status" in ('PENDING','APPROVED','CANCELLED','REJECTED'))
);


CREATE TABLE IF NOT EXISTS "payroll_statement_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"statement_id" integer NOT NULL,
	"deduction_id" integer,
	"reversal_id" integer,
	"category_code" text NOT NULL,
	"category_name" text NOT NULL,
	"method" text NOT NULL,
	"description" text NOT NULL,
	"basis_amount" integer NOT NULL,
	"amount" integer NOT NULL,
	"cooperative_credit" integer DEFAULT 0 NOT NULL,
	"calculation" text NOT NULL,
	CONSTRAINT "payroll_line_statement_deduction_unique" UNIQUE("statement_id","deduction_id"),
	CONSTRAINT "payroll_line_reversal_unique" UNIQUE("reversal_id"),
	CONSTRAINT "payroll_line_cooperative_check" CHECK (("payroll_statement_lines"."category_code" = 'COOPERATIVE' and "payroll_statement_lines"."cooperative_credit" = "payroll_statement_lines"."amount") or ("payroll_statement_lines"."category_code" <> 'COOPERATIVE' and "payroll_statement_lines"."cooperative_credit" = 0))
);


CREATE TABLE IF NOT EXISTS "payroll_statements" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"worker_id" integer NOT NULL,
	"worker_name" text NOT NULL,
	"department" text,
	"period_month" text NOT NULL,
	"payment_type" text NOT NULL,
	"rate" integer NOT NULL,
	"pieces" integer NOT NULL,
	"support_pieces" integer NOT NULL,
	"support_pieces_delegated" integer NOT NULL,
	"support_deduction_owed" integer NOT NULL,
	"piecework" integer NOT NULL,
	"support_piecework" integer NOT NULL,
	"salary" integer NOT NULL,
	"overtime" integer NOT NULL,
	"other" integer NOT NULL,
	"gross" integer NOT NULL,
	"support_deduction" integer NOT NULL,
	"tax_deduction" integer NOT NULL,
	"company_deductions" integer NOT NULL,
	"net" integer NOT NULL,
	"posted_by_id" integer,
	"posted_by_name" text NOT NULL,
	"posted_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_statement_worker_month_unique" UNIQUE("worker_id","period_month")
);


DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_attendance'::regclass AND conname = 'payroll_attendance_organization_id_organizations_id_fk') THEN
    ALTER TABLE "payroll_attendance" ADD CONSTRAINT "payroll_attendance_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_attendance'::regclass AND conname = 'payroll_attendance_worker_id_workers_id_fk') THEN
    ALTER TABLE "payroll_attendance" ADD CONSTRAINT "payroll_attendance_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_attendance'::regclass AND conname = 'payroll_attendance_recorded_by_id_users_id_fk') THEN
    ALTER TABLE "payroll_attendance" ADD CONSTRAINT "payroll_attendance_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_deduction_audit'::regclass AND conname = 'payroll_deduction_audit_organization_id_organizations_id_fk') THEN
    ALTER TABLE "payroll_deduction_audit" ADD CONSTRAINT "payroll_deduction_audit_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_deduction_audit'::regclass AND conname = 'payroll_deduction_audit_actor_id_users_id_fk') THEN
    ALTER TABLE "payroll_deduction_audit" ADD CONSTRAINT "payroll_deduction_audit_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_deduction_categories'::regclass AND conname = 'payroll_deduction_categories_organization_id_organizations_id_fk') THEN
    ALTER TABLE "payroll_deduction_categories" ADD CONSTRAINT "payroll_deduction_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_deduction_categories'::regclass AND conname = 'payroll_deduction_categories_created_by_id_users_id_fk') THEN
    ALTER TABLE "payroll_deduction_categories" ADD CONSTRAINT "payroll_deduction_categories_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_deductions'::regclass AND conname = 'payroll_deductions_organization_id_organizations_id_fk') THEN
    ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_deductions'::regclass AND conname = 'payroll_deductions_worker_id_workers_id_fk') THEN
    ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_deductions'::regclass AND conname = 'payroll_deductions_custom_category_id_payroll_deduction_categories_id_fk') THEN
    ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_custom_category_id_payroll_deduction_categories_id_fk" FOREIGN KEY ("custom_category_id") REFERENCES "public"."payroll_deduction_categories"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_deductions'::regclass AND conname = 'payroll_deductions_incident_inspection_id_stage_inspections_id_fk') THEN
    ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_incident_inspection_id_stage_inspections_id_fk" FOREIGN KEY ("incident_inspection_id") REFERENCES "public"."stage_inspections"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_deductions'::regclass AND conname = 'payroll_deductions_incident_support_inspection_id_support_inspections_id_fk') THEN
    ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_incident_support_inspection_id_support_inspections_id_fk" FOREIGN KEY ("incident_support_inspection_id") REFERENCES "public"."support_inspections"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_deductions'::regclass AND conname = 'payroll_deductions_attendance_id_payroll_attendance_id_fk') THEN
    ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_attendance_id_payroll_attendance_id_fk" FOREIGN KEY ("attendance_id") REFERENCES "public"."payroll_attendance"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_deductions'::regclass AND conname = 'payroll_deductions_created_by_id_users_id_fk') THEN
    ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_deductions'::regclass AND conname = 'payroll_deductions_approved_by_id_users_id_fk') THEN
    ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_deductions'::regclass AND conname = 'payroll_deductions_cancelled_by_id_users_id_fk') THEN
    ALTER TABLE "payroll_deductions" ADD CONSTRAINT "payroll_deductions_cancelled_by_id_users_id_fk" FOREIGN KEY ("cancelled_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_reversals'::regclass AND conname = 'payroll_reversals_organization_id_organizations_id_fk') THEN
    ALTER TABLE "payroll_reversals" ADD CONSTRAINT "payroll_reversals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_reversals'::regclass AND conname = 'payroll_reversals_worker_id_workers_id_fk') THEN
    ALTER TABLE "payroll_reversals" ADD CONSTRAINT "payroll_reversals_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_reversals'::regclass AND conname = 'payroll_reversals_source_line_id_payroll_statement_lines_id_fk') THEN
    ALTER TABLE "payroll_reversals" ADD CONSTRAINT "payroll_reversals_source_line_id_payroll_statement_lines_id_fk" FOREIGN KEY ("source_line_id") REFERENCES "public"."payroll_statement_lines"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_reversals'::regclass AND conname = 'payroll_reversals_created_by_id_users_id_fk') THEN
    ALTER TABLE "payroll_reversals" ADD CONSTRAINT "payroll_reversals_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_reversals'::regclass AND conname = 'payroll_reversals_approved_by_id_users_id_fk') THEN
    ALTER TABLE "payroll_reversals" ADD CONSTRAINT "payroll_reversals_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_reversals'::regclass AND conname = 'payroll_reversals_cancelled_by_id_users_id_fk') THEN
    ALTER TABLE "payroll_reversals" ADD CONSTRAINT "payroll_reversals_cancelled_by_id_users_id_fk" FOREIGN KEY ("cancelled_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_statement_lines'::regclass AND conname = 'payroll_statement_lines_statement_id_payroll_statements_id_fk') THEN
    ALTER TABLE "payroll_statement_lines" ADD CONSTRAINT "payroll_statement_lines_statement_id_payroll_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."payroll_statements"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_statement_lines'::regclass AND conname = 'payroll_statement_lines_deduction_id_payroll_deductions_id_fk') THEN
    ALTER TABLE "payroll_statement_lines" ADD CONSTRAINT "payroll_statement_lines_deduction_id_payroll_deductions_id_fk" FOREIGN KEY ("deduction_id") REFERENCES "public"."payroll_deductions"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_statement_lines'::regclass AND conname = 'payroll_statement_lines_reversal_id_payroll_reversals_id_fk') THEN
    ALTER TABLE "payroll_statement_lines" ADD CONSTRAINT "payroll_statement_lines_reversal_id_payroll_reversals_id_fk" FOREIGN KEY ("reversal_id") REFERENCES "public"."payroll_reversals"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_statements'::regclass AND conname = 'payroll_statements_organization_id_organizations_id_fk') THEN
    ALTER TABLE "payroll_statements" ADD CONSTRAINT "payroll_statements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_statements'::regclass AND conname = 'payroll_statements_worker_id_workers_id_fk') THEN
    ALTER TABLE "payroll_statements" ADD CONSTRAINT "payroll_statements_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payroll_statements'::regclass AND conname = 'payroll_statements_posted_by_id_users_id_fk') THEN
    ALTER TABLE "payroll_statements" ADD CONSTRAINT "payroll_statements_posted_by_id_users_id_fk" FOREIGN KEY ("posted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "payroll_attendance_org_day_idx" ON "payroll_attendance" USING btree ("organization_id","day");

CREATE INDEX IF NOT EXISTS "payroll_audit_entity_idx" ON "payroll_deduction_audit" USING btree ("organization_id","entity_type","entity_id");

CREATE INDEX IF NOT EXISTS "payroll_audit_created_idx" ON "payroll_deduction_audit" USING btree ("organization_id","created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "payroll_deduction_incident_worker_active_unique" ON "payroll_deductions" USING btree ("incident_inspection_id","worker_id") WHERE "payroll_deductions"."status" in ('PENDING','APPROVED');

CREATE UNIQUE INDEX IF NOT EXISTS "payroll_deduction_support_incident_active_unique" ON "payroll_deductions" USING btree ("incident_support_inspection_id","worker_id") WHERE "payroll_deductions"."status" in ('PENDING','APPROVED');

CREATE UNIQUE INDEX IF NOT EXISTS "payroll_deduction_attendance_active_unique" ON "payroll_deductions" USING btree ("attendance_id") WHERE "payroll_deductions"."status" in ('PENDING','APPROVED');

CREATE INDEX IF NOT EXISTS "payroll_deduction_period_idx" ON "payroll_deductions" USING btree ("organization_id","status","start_month","end_month");

CREATE INDEX IF NOT EXISTS "payroll_deduction_worker_idx" ON "payroll_deductions" USING btree ("worker_id");

CREATE INDEX IF NOT EXISTS "payroll_reversal_month_idx" ON "payroll_reversals" USING btree ("organization_id","target_month","status");

CREATE INDEX IF NOT EXISTS "payroll_line_category_idx" ON "payroll_statement_lines" USING btree ("category_code");

CREATE INDEX IF NOT EXISTS "payroll_statement_org_month_idx" ON "payroll_statements" USING btree ("organization_id","period_month");
-- Sensitive payroll records MUST NOT be accessible through Supabase's public
-- REST roles. The server connects as the existing trusted database role and
-- enforces Owner + organisation permissions; no direct anon/authenticated API.
-- Re-running these steps also repairs a drifted permission/RLS configuration.
DO $payroll_security$
DECLARE
  app_table text;
BEGIN
  FOREACH app_table IN ARRAY ARRAY[
    'payroll_attendance', 'payroll_deduction_audit', 'payroll_deduction_categories',
    'payroll_deductions', 'payroll_reversals', 'payroll_statement_lines',
    'payroll_statements'
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

-- Read-only verification (run after COMMIT): seven tables, all empty
-- on a new installation, with RLS enabled and BOTH inspection links present.
SELECT
  (SELECT count(*) FROM public.payroll_deduction_categories) AS custom_categories,
  (SELECT count(*) FROM public.payroll_attendance) AS attendance_days,
  (SELECT count(*) FROM public.payroll_deductions) AS deduction_proposals,
  (SELECT count(*) FROM public.payroll_deduction_audit) AS audit_events,
  (SELECT count(*) FROM public.payroll_statements) AS posted_statements,
  (SELECT count(*) FROM public.payroll_statement_lines) AS posted_lines,
  (SELECT count(*) FROM public.payroll_reversals) AS refund_requests;
SELECT c.relname AS payroll_table, c.relrowsecurity AS rls_enabled
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'payroll_%'
ORDER BY c.relname;
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'payroll_deductions'
  AND column_name IN ('incident_inspection_id', 'incident_support_inspection_id')
ORDER BY column_name;
SELECT tablename, indexname FROM pg_indexes
WHERE schemaname = 'public' AND tablename LIKE 'payroll_%'
ORDER BY tablename, indexname;
