-- ADDITIVE MIGRATION: who recorded a customer receipt, a packing record and a delivery.
--
-- WHAT THIS DOES
--   payments, packing_records and deliveries each gain recorded_by_id (a nullable reference
--   to users, ON DELETE set null) and recorded_by_name (nullable text). These three were the
--   only money-and-goods mutations in the system that could not answer WHO recorded them:
--   they had what and when, and no actor at all.
--
-- WHY THESE TWO COLUMNS AND NOT SOMETHING NEW
--   It is the actor pattern production_movements already uses (actor_user_id + actor_name),
--   and the same server-side derivation as worker_payments.paid_by and
--   stage_inspections.inspected_by. The id survives a rename, the name survives a deleted
--   user, and neither invents an audit system that has to be kept in step with the ledger.
--
-- WHAT THIS DOES NOT DO
--   No column is NOT NULL, no default is written, and NO EXISTING ROW IS BACKFILLED. Every
--   receipt, packing record and delivery already in the database keeps a NULL actor, because
--   that is the truth about it: the system did not record who entered it. Guessing an actor
--   for historical rows would put a fabricated name on a financial document. There is no
--   DELETE, no TRUNCATE, no DROP, no data write of any kind in this file.
ALTER TABLE "deliveries" ADD COLUMN "recorded_by_id" integer;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "recorded_by_name" text;--> statement-breakpoint
ALTER TABLE "packing_records" ADD COLUMN "recorded_by_id" integer;--> statement-breakpoint
ALTER TABLE "packing_records" ADD COLUMN "recorded_by_name" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "recorded_by_id" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "recorded_by_name" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_records" ADD CONSTRAINT "packing_records_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;