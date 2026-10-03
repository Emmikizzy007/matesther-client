-- ADDITIVE MIGRATION: exact garment variants, flexible production routes, the
-- production-method axis, and external (outsourced / machine / vendor) work.
--
-- WHAT THIS DOES
--   1. Turns `order_item_sizes` into the order's VARIANT table: item + optional
--      size + optional colour + required quantity. Adds a nullable `color`,
--      relaxes `size` to nullable, and replaces the uniqueness guarantee so two
--      variants may share a size and differ by colour.
--   2. Creates `production_routes` and `production_route_stages`: the ordered list
--      of stages ONE garment actually passes through. A route may include all
--      eight stages, skip stages, start later or end earlier. It never invents a
--      stage - stage values still come from lib/format.ts.
--   3. Adds the production-method axis: `production_operations.method`
--      (INTERNAL / MACHINE / OUTSOURCED / READY_MADE / VENDOR_PROCESSING),
--      defaulting to INTERNAL, which is what every existing row already is.
--   4. Freezes a route onto each batch via `production_operations.route_position`,
--      so "the next applicable stage" is the next position in THIS batch rather
--      than the next element of a global eight-item array.
--   5. Creates `external_work_orders`: one dispatch out of the factory and back,
--      keeping sent / returned / accepted / rejected-damaged / short as five
--      separate figures.
--   6. Links `material_purchases` to a route stage and a variant, so a READY-MADE
--      purchase stays a purchase (with its own cost) and is never mistaken for
--      tailor labour or for outsourced production.
--
-- WHAT THIS NEVER DOES
--   * no TRUNCATE, no DELETE, no RENAME, and no change to any existing column's
--     type or meaning,
--   * no update to any existing row in any existing table - it writes NO data at
--     all. There is no default route row and no backfill: `route_position` stays
--     NULL on historical operations and the application falls back to the
--     eight-stage order for them, so no existing batch changes behaviour,
--   * ONE `DROP INDEX`, called out below, which removes a constraint that has
--     become wrong. It destroys no data.
--
-- Every other statement is idempotent, matching drizzle/0005 and 0006. Against an
-- up-to-date database this migration is a complete no-op.
--
-- PRODUCTION NOTE: upgrade the client database by running
-- deploy/upgrade-variants-routes-external.sql in the SQL Editor, not by
-- `drizzle-kit migrate`. That file is the operator copy of this one and
-- additionally pre-flights the replaced unique index. See
-- deploy/UPDATE-INSTRUCTIONS.md. SQL first, code second.
--
-- NOTE: the SQL below was made idempotent after drizzle-kit generated it, so its
-- hash differs from the pristine generator output. drizzle/meta/0007_snapshot.json
-- is the untouched generator snapshot and is what stops a future
-- `drizzle-kit generate` from re-emitting these objects.

CREATE TABLE IF NOT EXISTS "production_routes" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"product_id" integer,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now()
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "production_route_stages" (
	"id" serial PRIMARY KEY NOT NULL,
	"route_id" integer NOT NULL,
	"position" integer NOT NULL,
	"stage" text NOT NULL,
	"method" text DEFAULT 'INTERNAL' NOT NULL,
	"role_required" text,
	"notes" text
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_work_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"production_operation_id" integer NOT NULL,
	"production_batch_id" integer NOT NULL,
	"stage" text NOT NULL,
	"method" text NOT NULL,
	"vendor_name" text NOT NULL,
	"quantity_sent" integer DEFAULT 0 NOT NULL,
	"quantity_returned" integer DEFAULT 0 NOT NULL,
	"quantity_accepted" integer DEFAULT 0 NOT NULL,
	"quantity_rejected" integer DEFAULT 0 NOT NULL,
	"quantity_short" integer DEFAULT 0 NOT NULL,
	"unit_cost" integer,
	"total_cost" integer,
	"status" text DEFAULT 'SENT' NOT NULL,
	"sent_at" timestamp DEFAULT now(),
	"returned_at" timestamp,
	"closed_at" timestamp,
	"sent_by" text,
	"accepted_by" text,
	"notes" text,
	"created_at" timestamp DEFAULT now()
);--> statement-breakpoint
-- VARIANTS. `color` is new and nullable; `size` stops being NOT NULL. Both are
-- widenings: an existing row is simply a variant with no colour.
ALTER TABLE "order_item_sizes" ADD COLUMN IF NOT EXISTS "color" text;--> statement-breakpoint
ALTER TABLE "order_item_sizes" ALTER COLUMN "size" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "order_variant_id" integer;--> statement-breakpoint
ALTER TABLE "production_batches" ADD COLUMN IF NOT EXISTS "route_id" integer;--> statement-breakpoint
ALTER TABLE "production_operations" ADD COLUMN IF NOT EXISTS "route_position" integer;--> statement-breakpoint
ALTER TABLE "production_operations" ADD COLUMN IF NOT EXISTS "route_stage_id" integer;--> statement-breakpoint
-- Defaults to INTERNAL, which is exactly what every existing row is. Postgres
-- backfills the default into existing rows as part of ADD COLUMN.
ALTER TABLE "production_operations" ADD COLUMN IF NOT EXISTS "method" text DEFAULT 'INTERNAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "material_purchases" ADD COLUMN IF NOT EXISTS "production_operation_id" integer;--> statement-breakpoint
ALTER TABLE "material_purchases" ADD COLUMN IF NOT EXISTS "order_variant_id" integer;--> statement-breakpoint
-- THE ONE DROP IN THIS MIGRATION, and it is required.
--
-- `order_item_sizes_item_size_unique` enforced one row per (item, size). That rule
-- is now WRONG rather than merely incomplete: it would reject "size M navy" and
-- "size M black" as duplicates of each other, which makes variants impossible.
-- Dropping an index removes a constraint, not data - no row is touched, and the
-- replacement below is strictly tighter once colour is included.
--
-- The replacement is safe on existing data by construction: every current row has
-- color IS NULL, so coalesce(color,'') is '' for all of them, making the new key
-- (item, size, '') unique wherever (item, size) already was. No pre-existing row
-- can violate it.
DROP INDEX IF EXISTS "order_item_sizes_item_size_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_item_sizes_variant_unique" ON "order_item_sizes" ("order_item_id", coalesce("size", ''), coalesce("color", ''));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_item_sizes_color_idx" ON "order_item_sizes" ("color");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_routes_product_id_idx" ON "production_routes" ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_routes_organization_id_idx" ON "production_routes" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_route_stages_route_id_idx" ON "production_route_stages" ("route_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "production_route_stages_route_position_unique" ON "production_route_stages" ("route_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "production_route_stages_route_stage_unique" ON "production_route_stages" ("route_id","stage");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_batches_order_variant_id_idx" ON "production_batches" ("order_variant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_batches_route_id_idx" ON "production_batches" ("route_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_operations_method_idx" ON "production_operations" ("method");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "production_operations_route_stage_id_idx" ON "production_operations" ("route_stage_id");--> statement-breakpoint
-- A batch's frozen route is read as "its operations in position order", so two
-- rows may never claim the same position. Legacy rows have route_position NULL and
-- Postgres treats NULLs as distinct in a unique index, which is exactly what they
-- need: no historical batch can violate this.
CREATE UNIQUE INDEX IF NOT EXISTS "production_operations_batch_position_unique" ON "production_operations" ("production_batch_id","route_position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_work_orders_operation_id_idx" ON "external_work_orders" ("production_operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_work_orders_batch_id_idx" ON "external_work_orders" ("production_batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_work_orders_status_idx" ON "external_work_orders" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_work_orders_method_idx" ON "external_work_orders" ("method");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_purchases_operation_id_idx" ON "material_purchases" ("production_operation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_purchases_order_variant_id_idx" ON "material_purchases" ("order_variant_id");--> statement-breakpoint
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
