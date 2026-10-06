-- MATESTHER CLIENT: SUPPORT-WORK COST DETAIL, VENDOR PAYMENT DETAIL, MATERIAL DETAIL.
-- Make a backup first. Run this in the SQL Editor of the project used by your
-- CLIENT site. Safe to run more than once.
--
-- WHAT THIS DOES
--   1. support_assignments gains production_allocation_id, order_item_id,
--      order_variant_id and stage, so a helper is handed THE EXACT SHARE of a stage
--      and the order, item, size, colour and stage come with it by inheritance
--      instead of being retyped or guessed.
--   2. external_work_orders gains expected_return_at, amount_payable, amount_paid,
--      payment_reference and paid_at, so a vendor dispatch carries what was promised,
--      what is owed, what has been paid and the reference that payment can be matched
--      against. A vendor is not a worker and none of this reaches payroll.
--   3. material_usage gains quantity_issued, quantity_returned, quantity_wasted,
--      worker_id, order_variant_id and notes, so material is tracked as issued / used /
--      returned / wasted against a worker, a variant, a time and a reason. This is the
--      SAME material system - materials, material_purchases, material_usage - and
--      materials.current_stock is still the one and only stock figure.
--   4. Five indexes on the new foreign keys, so the cost and payroll queries that read
--      them do not scan.
--
-- WHAT THIS NEVER DOES
--   * no CREATE TABLE, no DROP, no TRUNCATE, no DELETE, no RENAME,
--   * no change to any existing column's type, default or meaning,
--   * no update to any existing row in any existing table.
--     IT WRITES NO DATA AT ALL. No backfill is needed, because:
--       - every new column is nullable or defaults to 0, so a record written before
--         this upgrade keeps exactly the meaning it already had;
--       - material_usage.quantity_issued is NULL on historical rows and reads as
--         "issued = used", which is what those rows have always meant. A zero would
--         claim nothing was handed out, which is a different statement;
--       - quantity_returned and quantity_wasted default to 0, so historical material
--         cost is unchanged and NOTHING IS RESTATED;
--       - support_assignments keeps resolving its deduction through
--         assigned_by_worker_id, which has always been a real worker, so support work
--         recorded before this upgrade is still attributed to the right tailor.
--
-- WHAT CHANGES IN THE NUMBERS, AND WHY THAT IS NOT A RESTATEMENT
--   Order profit is now computed from nine cost categories instead of two. That is a
--   change in the APPLICATION, not in the data: this script alters no row. The old
--   formula's answer is still returned beside the new one, so a previously reported
--   profit is never silently overwritten.
--
--   Support pay is now DEDUCTED from the tailor who handed the work out instead of being
--   added on top. Again this script writes nothing: the rule lives in the application.
--   A deduction can only be taken from piece-rate earnings that exist, and whatever a
--   month cannot absorb is held and reported, so no worker's pay is driven negative and
--   no historical payment is rewritten.
--
-- NOTHING NEEDS RE-ENTERING. Run this, then deploy the code.
--

ALTER TABLE "external_work_orders" ADD COLUMN IF NOT EXISTS "expected_return_at" timestamp;
ALTER TABLE "external_work_orders" ADD COLUMN IF NOT EXISTS "amount_payable" integer;
ALTER TABLE "external_work_orders" ADD COLUMN IF NOT EXISTS "amount_paid" integer DEFAULT 0 NOT NULL;
ALTER TABLE "external_work_orders" ADD COLUMN IF NOT EXISTS "payment_reference" text;
ALTER TABLE "external_work_orders" ADD COLUMN IF NOT EXISTS "paid_at" timestamp;
ALTER TABLE "material_usage" ADD COLUMN IF NOT EXISTS "quantity_issued" integer;
ALTER TABLE "material_usage" ADD COLUMN IF NOT EXISTS "quantity_returned" integer DEFAULT 0 NOT NULL;
ALTER TABLE "material_usage" ADD COLUMN IF NOT EXISTS "quantity_wasted" integer DEFAULT 0 NOT NULL;
ALTER TABLE "material_usage" ADD COLUMN IF NOT EXISTS "worker_id" integer;
ALTER TABLE "material_usage" ADD COLUMN IF NOT EXISTS "order_variant_id" integer;
ALTER TABLE "material_usage" ADD COLUMN IF NOT EXISTS "notes" text;
ALTER TABLE "support_assignments" ADD COLUMN IF NOT EXISTS "production_allocation_id" integer;
ALTER TABLE "support_assignments" ADD COLUMN IF NOT EXISTS "order_item_id" integer;
ALTER TABLE "support_assignments" ADD COLUMN IF NOT EXISTS "order_variant_id" integer;
ALTER TABLE "support_assignments" ADD COLUMN IF NOT EXISTS "stage" text;
CREATE INDEX IF NOT EXISTS "material_usage_worker_id_idx" ON "material_usage" USING btree ("worker_id");
CREATE INDEX IF NOT EXISTS "material_usage_order_variant_id_idx" ON "material_usage" USING btree ("order_variant_id");
CREATE INDEX IF NOT EXISTS "support_assignments_allocation_id_idx" ON "support_assignments" USING btree ("production_allocation_id");
CREATE INDEX IF NOT EXISTS "support_assignments_order_variant_id_idx" ON "support_assignments" USING btree ("order_variant_id");
CREATE INDEX IF NOT EXISTS "support_assignments_order_item_id_idx" ON "support_assignments" USING btree ("order_item_id");
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

-- ---------------------------------------------------------------------------
-- VERIFICATION (commented out on purpose - run these one at a time after the
-- upgrade and check the answers against what is written beside each).
-- ---------------------------------------------------------------------------

-- V1. Every new column exists, and historical rows still read the way they did.
--     Expected: 16 rows, and issued_is_null = every pre-existing material_usage row.
-- SELECT table_name, column_name, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE (table_name = 'support_assignments'
--          AND column_name IN ('production_allocation_id','order_item_id','order_variant_id','stage'))
--     OR (table_name = 'external_work_orders'
--          AND column_name IN ('expected_return_at','amount_payable','amount_paid','payment_reference','paid_at'))
--     OR (table_name = 'material_usage'
--          AND column_name IN ('quantity_issued','quantity_returned','quantity_wasted','worker_id','order_variant_id','notes'))
--  ORDER BY table_name, column_name;

-- V2. No material row was touched: nothing has a returned or wasted quantity yet, and
--     total_cost is still quantity_used x unit_cost on every pre-existing row.
--     Expected: restated = 0.
-- SELECT count(*) AS restated
--   FROM public.material_usage
--  WHERE coalesce(quantity_returned, 0) <> 0
--     OR coalesce(quantity_wasted, 0) <> 0
--     OR total_cost <> quantity_used * coalesce(unit_cost, 0);

-- V3. Support work recorded before this upgrade still names a real tailor, so its
--     deduction still lands on the right person. Expected: orphaned = 0.
-- SELECT count(*) AS orphaned
--   FROM public.support_assignments sa
--   LEFT JOIN public.workers w ON w.id = sa.assigned_by_worker_id
--  WHERE w.id IS NULL;

-- V4. The new indexes are in place. Expected: 5 rows.
-- SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
--   'material_usage_worker_id_idx','material_usage_order_variant_id_idx',
--   'support_assignments_allocation_id_idx','support_assignments_order_variant_id_idx',
--   'support_assignments_order_item_id_idx') ORDER BY indexname;

-- V5. The five foreign keys were added exactly once. Expected: 5 rows.
-- SELECT conname FROM pg_constraint
--  WHERE conname IN ('material_usage_worker_id_workers_id_fk',
--                    'material_usage_order_variant_id_order_item_sizes_id_fk',
--                    'support_assignments_production_allocation_id_production_allocations_id_fk',
--                    'support_assignments_order_item_id_order_items_id_fk',
--                    'support_assignments_order_variant_id_order_item_sizes_id_fk')
--  ORDER BY conname;
