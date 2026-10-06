-- MATESTHER CLIENT: EXACT GARMENT VARIANTS, PRODUCTION ROUTES, PRODUCTION
-- METHODS AND EXTERNAL WORK.
-- Make a backup first. Run this in the SQL Editor of the project used by your
-- CLIENT site. Safe to run more than once.
--
-- WHAT THIS DOES
--   1. Turns public.order_item_sizes into the order's VARIANT table: one row per
--      exact garment, item + optional size + optional colour + quantity. Adds a
--      nullable `color` and relaxes `size` to nullable.
--   2. Creates public.production_routes and public.production_route_stages: the
--      ordered list of stages ONE garment actually follows. A route may include all
--      eight stages, skip stages, start later or end earlier. It never invents a
--      stage.
--   3. Adds the production-method axis: public.production_operations.method
--      (INTERNAL / MACHINE / OUTSOURCED / READY_MADE / VENDOR_PROCESSING),
--      defaulting to INTERNAL - which is what every existing row already is.
--   4. Freezes a route onto each batch via production_operations.route_position, so
--      "the next applicable stage" is the next position in THIS batch rather than
--      the next element of a global eight-item array.
--   5. Creates public.external_work_orders: one dispatch out of the factory and
--      back, keeping sent / returned / accepted / rejected-damaged / short as five
--      separate figures.
--   6. Links public.material_purchases to a route stage and a variant, so a
--      READY-MADE purchase stays a purchase with its own cost and is never mistaken
--      for tailor labour or for outsourced production.
--
-- WHAT THIS NEVER DOES
--   * no TRUNCATE, no DELETE, no RENAME,
--   * no change to any existing column's type or meaning,
--   * no update to any existing row in any existing table.
--     IT WRITES NO DATA AT ALL. There is no default route row and no backfill:
--     route_position stays NULL on historical operations and the application falls
--     back to the eight-stage order for them, so no existing batch changes
--     behaviour and nothing needs restating.
--   * ONE `DROP INDEX`, called out below. It removes a constraint that has become
--     WRONG. It destroys no data.
--
-- THE ONE DROP, EXPLAINED
--   `order_item_sizes_item_size_unique` enforced one row per (order_item_id, size).
--   That rule is now wrong rather than merely incomplete: it would reject "size M
--   navy" and "size M black" as duplicates of each other, which makes variants
--   impossible. It is replaced by a unique index on (item, size, colour) that is
--   strictly tighter once colour is included.
--
--   The replacement is safe on existing data BY CONSTRUCTION: every current row has
--   color IS NULL, so coalesce(color,'') is '' for all of them, making the new key
--   (item, size, '') unique wherever (item, size) already was. No existing row can
--   violate it. The pre-flight below verifies that rather than assuming it.
--
-- ORDER OF WORK: back up -> run this file -> read the NOTICE/WARNING output -> run
-- the verification queries at the bottom -> deploy the new application code.
-- SQL first, code second. See deploy/UPDATE-INSTRUCTIONS.md.
--
-- The new code writes to production_routes, production_route_stages and
-- external_work_orders and reads production_operations.route_position, so
-- deploying it before this file would fail.

BEGIN;

-- ---------- 1. Exact garment variants ----------
ALTER TABLE public.order_item_sizes ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE public.order_item_sizes ALTER COLUMN size DROP NOT NULL;

-- ---------- 2. Production routes ----------
CREATE TABLE IF NOT EXISTS public.production_routes (
  id serial PRIMARY KEY,
  organization_id integer REFERENCES public.organizations(id),
  -- NULL means the organization's generic default route.
  product_id integer REFERENCES public.products(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.production_route_stages (
  id serial PRIMARY KEY,
  route_id integer NOT NULL REFERENCES public.production_routes(id) ON DELETE CASCADE,
  position integer NOT NULL,
  -- Still one of Matesther's real stages. A route selects and orders them; it
  -- never invents one, so roles, labels, inspection and payroll keep working.
  stage text NOT NULL,
  -- INTERNAL / MACHINE / OUTSOURCED / READY_MADE / VENDOR_PROCESSING.
  method text NOT NULL DEFAULT 'INTERNAL',
  -- Optional override of the generic stage -> role mapping.
  role_required text,
  notes text
);

-- ---------- 3. External production work ----------
CREATE TABLE IF NOT EXISTS public.external_work_orders (
  id serial PRIMARY KEY,
  organization_id integer REFERENCES public.organizations(id),
  production_operation_id integer NOT NULL REFERENCES public.production_operations(id) ON DELETE CASCADE,
  production_batch_id integer NOT NULL REFERENCES public.production_batches(id) ON DELETE CASCADE,
  -- Stage identity travels with the row, like every production_movements row.
  stage text NOT NULL,
  method text NOT NULL,
  -- Free text, matching the existing material_purchases.supplier convention.
  -- Vendors are deliberately NOT public.workers rows: payroll iterates every
  -- worker to build accruals, so a vendor placed there would accrue phantom
  -- piecework forever.
  vendor_name text NOT NULL,
  quantity_sent integer NOT NULL DEFAULT 0,
  quantity_returned integer NOT NULL DEFAULT 0,
  quantity_accepted integer NOT NULL DEFAULT 0,
  quantity_rejected integer NOT NULL DEFAULT 0,
  -- Never came back. Distinct from rejected: nothing arrived to judge.
  quantity_short integer NOT NULL DEFAULT 0,
  -- Recorded now, classified into the profitability cost categories in Task 4.
  unit_cost integer,
  total_cost integer,
  status text NOT NULL DEFAULT 'SENT',
  sent_at timestamp DEFAULT now(),
  returned_at timestamp,
  closed_at timestamp,
  sent_by text,
  accepted_by text,
  notes text,
  created_at timestamp DEFAULT now()
);

-- ---------- 4. Route and method on the batch and its stages ----------
ALTER TABLE public.production_batches ADD COLUMN IF NOT EXISTS order_variant_id integer;
ALTER TABLE public.production_batches ADD COLUMN IF NOT EXISTS route_id integer;
ALTER TABLE public.production_operations ADD COLUMN IF NOT EXISTS route_position integer;
ALTER TABLE public.production_operations ADD COLUMN IF NOT EXISTS route_stage_id integer;
-- Defaults to INTERNAL, which is exactly what every existing row is. Postgres
-- writes the default into existing rows as part of ADD COLUMN.
ALTER TABLE public.production_operations ADD COLUMN IF NOT EXISTS method text DEFAULT 'INTERNAL' NOT NULL;

-- ---------- 5. Ready-made linkage on the existing purchase table ----------
ALTER TABLE public.material_purchases ADD COLUMN IF NOT EXISTS production_operation_id integer;
ALTER TABLE public.material_purchases ADD COLUMN IF NOT EXISTS order_variant_id integer;

-- ---------- 6. Indexes ----------
CREATE INDEX IF NOT EXISTS order_item_sizes_color_idx                ON public.order_item_sizes (color);
CREATE INDEX IF NOT EXISTS production_routes_product_id_idx          ON public.production_routes (product_id);
CREATE INDEX IF NOT EXISTS production_routes_organization_id_idx     ON public.production_routes (organization_id);
CREATE INDEX IF NOT EXISTS production_route_stages_route_id_idx      ON public.production_route_stages (route_id);
CREATE INDEX IF NOT EXISTS production_batches_order_variant_id_idx   ON public.production_batches (order_variant_id);
CREATE INDEX IF NOT EXISTS production_batches_route_id_idx           ON public.production_batches (route_id);
CREATE INDEX IF NOT EXISTS production_operations_method_idx          ON public.production_operations (method);
CREATE INDEX IF NOT EXISTS production_operations_route_stage_id_idx  ON public.production_operations (route_stage_id);
CREATE INDEX IF NOT EXISTS external_work_orders_operation_id_idx     ON public.external_work_orders (production_operation_id);
CREATE INDEX IF NOT EXISTS external_work_orders_batch_id_idx         ON public.external_work_orders (production_batch_id);
CREATE INDEX IF NOT EXISTS external_work_orders_status_idx           ON public.external_work_orders (status);
CREATE INDEX IF NOT EXISTS external_work_orders_method_idx           ON public.external_work_orders (method);
CREATE INDEX IF NOT EXISTS material_purchases_operation_id_idx       ON public.material_purchases (production_operation_id);
CREATE INDEX IF NOT EXISTS material_purchases_order_variant_id_idx   ON public.material_purchases (order_variant_id);

CREATE UNIQUE INDEX IF NOT EXISTS production_route_stages_route_position_unique ON public.production_route_stages (route_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS production_route_stages_route_stage_unique    ON public.production_route_stages (route_id, stage);

-- A batch's frozen route is read as "its operations in position order", so two rows
-- may never claim the same position. Legacy rows have route_position NULL and
-- Postgres treats NULLs as distinct in a unique index, which is exactly what they
-- need: no historical batch can violate this.
CREATE UNIQUE INDEX IF NOT EXISTS production_operations_batch_position_unique   ON public.production_operations (production_batch_id, route_position);

-- ---------- 7. The replaced variant uniqueness, pre-flighted ----------
DO $$
DECLARE
  duplicate_variants integer;
BEGIN
  SELECT count(*) INTO duplicate_variants FROM (
    SELECT order_item_id, coalesce(size, ''), coalesce(color, '')
    FROM public.order_item_sizes
    GROUP BY order_item_id, coalesce(size, ''), coalesce(color, '')
    HAVING count(*) > 1
  ) duplicated;

  IF duplicate_variants = 0 THEN
    -- Safe to drop the superseded constraint and put the variant one in its place.
    DROP INDEX IF EXISTS public.order_item_sizes_item_size_unique;
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'order_item_sizes_variant_unique'
    ) THEN
      CREATE UNIQUE INDEX order_item_sizes_variant_unique
        ON public.order_item_sizes (order_item_id, coalesce(size, ''), coalesce(color, ''));
      RAISE NOTICE 'Replaced order_item_sizes_item_size_unique with order_item_sizes_variant_unique: one row per exact garment (item + size + colour).';
    ELSE
      RAISE NOTICE 'order_item_sizes_variant_unique already exists - skipped.';
    END IF;
  ELSE
    -- Should be impossible, because `color` was NULL on every row until this file
    -- ran. Reported rather than forced: nothing is deleted to make an index fit.
    RAISE WARNING 'NOT CREATED: order_item_sizes_variant_unique. % item/size/colour group(s) already hold more than one row. Run verification query V1 below and resolve them with the business, then re-run this file. The old index was left in place.', duplicate_variants;
  END IF;
END $$;

-- ---------- 8. Foreign keys ----------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_routes'::regclass AND conname = 'production_routes_organization_id_organizations_id_fk') THEN
    ALTER TABLE "public"."production_routes" ADD CONSTRAINT "production_routes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_routes'::regclass AND conname = 'production_routes_product_id_products_id_fk') THEN
    ALTER TABLE "public"."production_routes" ADD CONSTRAINT "production_routes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_route_stages'::regclass AND conname = 'production_route_stages_route_id_production_routes_id_fk') THEN
    ALTER TABLE "public"."production_route_stages" ADD CONSTRAINT "production_route_stages_route_id_production_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."production_routes"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_batches'::regclass AND conname = 'production_batches_order_variant_id_order_item_sizes_id_fk') THEN
    ALTER TABLE "public"."production_batches" ADD CONSTRAINT "production_batches_order_variant_id_order_item_sizes_id_fk" FOREIGN KEY ("order_variant_id") REFERENCES "public"."order_item_sizes"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_batches'::regclass AND conname = 'production_batches_route_id_production_routes_id_fk') THEN
    ALTER TABLE "public"."production_batches" ADD CONSTRAINT "production_batches_route_id_production_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."production_routes"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.production_operations'::regclass AND conname = 'production_operations_route_stage_id_production_route_stages_id_fk') THEN
    ALTER TABLE "public"."production_operations" ADD CONSTRAINT "production_operations_route_stage_id_production_route_stages_id_fk" FOREIGN KEY ("route_stage_id") REFERENCES "public"."production_route_stages"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.external_work_orders'::regclass AND conname = 'external_work_orders_organization_id_organizations_id_fk') THEN
    ALTER TABLE "public"."external_work_orders" ADD CONSTRAINT "external_work_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.external_work_orders'::regclass AND conname = 'external_work_orders_production_operation_id_production_operations_id_fk') THEN
    ALTER TABLE "public"."external_work_orders" ADD CONSTRAINT "external_work_orders_production_operation_id_production_operations_id_fk" FOREIGN KEY ("production_operation_id") REFERENCES "public"."production_operations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.external_work_orders'::regclass AND conname = 'external_work_orders_production_batch_id_production_batches_id_fk') THEN
    ALTER TABLE "public"."external_work_orders" ADD CONSTRAINT "external_work_orders_production_batch_id_production_batches_id_fk" FOREIGN KEY ("production_batch_id") REFERENCES "public"."production_batches"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.material_purchases'::regclass AND conname = 'material_purchases_production_operation_id_production_operations_id_fk') THEN
    ALTER TABLE "public"."material_purchases" ADD CONSTRAINT "material_purchases_production_operation_id_production_operations_id_fk" FOREIGN KEY ("production_operation_id") REFERENCES "public"."production_operations"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.material_purchases'::regclass AND conname = 'material_purchases_order_variant_id_order_item_sizes_id_fk') THEN
    ALTER TABLE "public"."material_purchases" ADD CONSTRAINT "material_purchases_order_variant_id_order_item_sizes_id_fk" FOREIGN KEY ("order_variant_id") REFERENCES "public"."order_item_sizes"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

COMMIT;

-- ===========================================================================
-- VERIFICATION. Run these after the upgrade. None of them changes anything.
-- ===========================================================================

-- V1. Duplicate variants, if the unique index was NOT created. Expected to return
--     zero rows: colour was NULL on every row before this file ran.
-- SELECT order_item_id, coalesce(size,'(no size)') AS size, coalesce(color,'(no colour)') AS color,
--        count(*) AS rows, array_agg(id ORDER BY id) AS variant_ids, array_agg(quantity ORDER BY id) AS quantities
-- FROM public.order_item_sizes
-- GROUP BY order_item_id, coalesce(size,''), coalesce(color,'')
-- HAVING count(*) > 1 ORDER BY order_item_id;

-- V2. Every existing operation defaulted to INTERNAL with no route position, which
--     is what makes historical batches keep following the eight-stage order.
-- SELECT method, count(*) AS operations, count(route_position) AS with_a_position
-- FROM public.production_operations GROUP BY method ORDER BY method;

-- V3. Any batch whose operations claim the same route position twice would break
--     "the next applicable stage". Expected: zero rows.
-- SELECT production_batch_id, route_position, count(*) AS rows
-- FROM public.production_operations WHERE route_position IS NOT NULL
-- GROUP BY production_batch_id, route_position HAVING count(*) > 1;

-- V4. Existing batches must still total the same number of stages they had before
--     this upgrade (eight each, unless a batch was created some other way).
-- SELECT count(*) AS stages_per_batch, count(*) AS batches FROM (
--   SELECT production_batch_id, count(*) FROM public.production_operations
--   GROUP BY production_batch_id
-- ) per_batch GROUP BY per_batch.count ORDER BY per_batch.count;

-- V5. New tables and indexes present.
-- SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public'
--   AND tablename IN ('order_item_sizes','production_routes','production_route_stages',
--                     'production_operations','production_batches','external_work_orders',
--                     'material_purchases')
-- ORDER BY tablename, indexname;

-- V6. Nothing was written by this upgrade: both should return 0 until the new code
--     is deployed and someone actually defines a route or sends work out.
-- SELECT (SELECT count(*) FROM public.production_routes) AS routes,
--        (SELECT count(*) FROM public.production_route_stages) AS route_stages,
--        (SELECT count(*) FROM public.external_work_orders) AS dispatches;
