-- ADDITIVE MIGRATION: exact support-work inheritance, external-work payment
-- detail, and material issue/return/waste detail.
--
-- WHAT THIS DOES
--   1. support_assignments gains the exact context a helper's work inherits:
--      production_allocation_id (WHOSE share of the stage), order_item_id,
--      order_variant_id (which exact garment) and stage. A helper is handed this
--      item, this size, this colour, from this stage, in this quantity - never a
--      school picked from scratch.
--   2. external_work_orders gains expected_return_at and what Matesther owes on the
--      dispatch: amount_payable, amount_paid, payment_reference, paid_at.
--   3. material_usage gains quantity_issued / quantity_returned / quantity_wasted,
--      worker_id, order_variant_id and notes, around the quantity_used figure that
--      has always driven cost.
--
-- WHAT THIS NEVER DOES
--   * no CREATE TABLE, no DROP, no TRUNCATE, no DELETE, no RENAME,
--   * no change to any existing column's type, default or meaning,
--   * no update to any existing row in any existing table. IT WRITES NO DATA.
--
-- Every new column is nullable or has a default that reproduces today's behaviour,
-- so no existing record changes meaning:
--   * a support assignment recorded before this migration simply has no allocation
--     or variant link, and its deduction still resolves through the tailor who
--     handed it out;
--   * a dispatch recorded before it has no payment detail, which reads as "nothing
--     recorded as paid yet";
--   * a material issue recorded before it reads as issued 0, returned 0, wasted 0,
--     used N - and quantity_used is still the figure cost is calculated from.
--
-- NO SECOND INVENTORY SYSTEM. `materials.current_stock` is still adjusted exactly
-- as it always was; these columns describe one issue of one material to one order,
-- variant or worker, which is what material_usage has always been for.
--
-- Every statement is idempotent, matching drizzle/0005 to 0008. Against an
-- up-to-date database this migration is a complete no-op.
--
-- PRODUCTION NOTE: upgrade the client database by running
-- deploy/upgrade-support-cost-material-detail.sql in the SQL Editor, not by
-- `drizzle-kit migrate`. SQL first, code second. See deploy/UPDATE-INSTRUCTIONS.md.
--
-- NOTE: the SQL below was made idempotent after drizzle-kit generated it, so its
-- hash differs from the pristine generator output. drizzle/meta/0009_snapshot.json
-- is the untouched generator snapshot.

ALTER TABLE "external_work_orders" ADD COLUMN IF NOT EXISTS "expected_return_at" timestamp;--> statement-breakpoint
ALTER TABLE "external_work_orders" ADD COLUMN IF NOT EXISTS "amount_payable" integer;--> statement-breakpoint
ALTER TABLE "external_work_orders" ADD COLUMN IF NOT EXISTS "amount_paid" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "external_work_orders" ADD COLUMN IF NOT EXISTS "payment_reference" text;--> statement-breakpoint
ALTER TABLE "external_work_orders" ADD COLUMN IF NOT EXISTS "paid_at" timestamp;--> statement-breakpoint
ALTER TABLE "material_usage" ADD COLUMN IF NOT EXISTS "quantity_issued" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "material_usage" ADD COLUMN IF NOT EXISTS "quantity_returned" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "material_usage" ADD COLUMN IF NOT EXISTS "quantity_wasted" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "material_usage" ADD COLUMN IF NOT EXISTS "worker_id" integer;--> statement-breakpoint
ALTER TABLE "material_usage" ADD COLUMN IF NOT EXISTS "order_variant_id" integer;--> statement-breakpoint
ALTER TABLE "material_usage" ADD COLUMN IF NOT EXISTS "notes" text;--> statement-breakpoint
ALTER TABLE "support_assignments" ADD COLUMN IF NOT EXISTS "production_allocation_id" integer;--> statement-breakpoint
ALTER TABLE "support_assignments" ADD COLUMN IF NOT EXISTS "order_item_id" integer;--> statement-breakpoint
ALTER TABLE "support_assignments" ADD COLUMN IF NOT EXISTS "order_variant_id" integer;--> statement-breakpoint
ALTER TABLE "support_assignments" ADD COLUMN IF NOT EXISTS "stage" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_usage_worker_id_idx" ON "material_usage" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_usage_order_variant_id_idx" ON "material_usage" USING btree ("order_variant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_assignments_allocation_id_idx" ON "support_assignments" USING btree ("production_allocation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_assignments_order_variant_id_idx" ON "support_assignments" USING btree ("order_variant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_assignments_order_item_id_idx" ON "support_assignments" USING btree ("order_item_id");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.material_usage'::regclass AND conname = 'material_usage_worker_id_workers_id_fk') THEN
    ALTER TABLE "public"."material_usage" ADD CONSTRAINT "material_usage_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.material_usage'::regclass AND conname = 'material_usage_order_variant_id_order_item_sizes_id_fk') THEN
    ALTER TABLE "public"."material_usage" ADD CONSTRAINT "material_usage_order_variant_id_order_item_sizes_id_fk" FOREIGN KEY ("order_variant_id") REFERENCES "public"."order_item_sizes"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.support_assignments'::regclass AND conname = 'support_assignments_production_allocation_id_production_allocations_id_fk') THEN
    ALTER TABLE "public"."support_assignments" ADD CONSTRAINT "support_assignments_production_allocation_id_production_allocations_id_fk" FOREIGN KEY ("production_allocation_id") REFERENCES "public"."production_allocations"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.support_assignments'::regclass AND conname = 'support_assignments_order_item_id_order_items_id_fk') THEN
    ALTER TABLE "public"."support_assignments" ADD CONSTRAINT "support_assignments_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.support_assignments'::regclass AND conname = 'support_assignments_order_variant_id_order_item_sizes_id_fk') THEN
    ALTER TABLE "public"."support_assignments" ADD CONSTRAINT "support_assignments_order_variant_id_order_item_sizes_id_fk" FOREIGN KEY ("order_variant_id") REFERENCES "public"."order_item_sizes"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
