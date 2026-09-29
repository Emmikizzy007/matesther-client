-- ============================================================
-- MATESTHER ERP - FULL DATABASE SETUP (fresh database)
-- Run this ONE file in your new Postgres (Supabase/Neon SQL editor)
-- Creates all tables, then loads all Matesther sample data.
-- (For the REAL business database use deploy/schema-only.sql instead.)
-- ============================================================

CREATE TABLE "customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"name" text NOT NULL,
	"type" text DEFAULT 'SCHOOL' NOT NULL,
	"contact_person" text,
	"phone" text,
	"email" text,
	"address" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"delivery_date" date NOT NULL,
	"delivered_quantity" integer DEFAULT 0 NOT NULL,
	"recipient" text,
	"delivery_address" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"order_id" integer,
	"category" text DEFAULT 'Other' NOT NULL,
	"description" text NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	"expense_date" date NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "material_purchases" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"material_id" integer NOT NULL,
	"supplier" text,
	"quantity" integer DEFAULT 0 NOT NULL,
	"unit_cost" integer DEFAULT 0 NOT NULL,
	"total_cost" integer DEFAULT 0 NOT NULL,
	"purchase_date" date NOT NULL,
	"order_id" integer,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "material_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer,
	"production_operation_id" integer,
	"material_id" integer NOT NULL,
	"quantity_used" integer DEFAULT 0 NOT NULL,
	"unit_cost" integer DEFAULT 0 NOT NULL,
	"total_cost" integer DEFAULT 0 NOT NULL,
	"used_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "materials" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"name" text NOT NULL,
	"category" text,
	"unit" text DEFAULT 'pcs' NOT NULL,
	"current_stock" integer DEFAULT 0 NOT NULL,
	"reorder_level" integer DEFAULT 0 NOT NULL,
	"unit_cost" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "order_item_sizes" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_item_id" integer NOT NULL,
	"size" text NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"completed" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"product_id" integer,
	"quantity" integer DEFAULT 0 NOT NULL,
	"unit_price" integer DEFAULT 0 NOT NULL,
	"total_price" integer DEFAULT 0 NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"customer_id" integer,
	"order_number" varchar(50) NOT NULL,
	"order_date" date NOT NULL,
	"due_date" date,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"total_amount" integer DEFAULT 0 NOT NULL,
	"amount_paid" integer DEFAULT 0 NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "orders_order_number_unique" UNIQUE("order_number")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"address" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "packing_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"quantity_packed" integer DEFAULT 0 NOT NULL,
	"package_count" integer DEFAULT 0 NOT NULL,
	"packed_at" timestamp DEFAULT now(),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	"payment_date" date NOT NULL,
	"payment_method" text DEFAULT 'Bank Transfer' NOT NULL,
	"reference" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "production_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"order_item_id" integer,
	"batch_number" text NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "production_operations" (
	"id" serial PRIMARY KEY NOT NULL,
	"production_batch_id" integer NOT NULL,
	"stage" text NOT NULL,
	"worker_id" integer,
	"quantity_received" integer DEFAULT 0 NOT NULL,
	"quantity_completed" integer DEFAULT 0 NOT NULL,
	"quantity_rejected" integer DEFAULT 0 NOT NULL,
	"quantity_remaining" integer DEFAULT 0 NOT NULL,
	"quantity_inspected" integer DEFAULT 0 NOT NULL,
	"quantity_approved" integer DEFAULT 0 NOT NULL,
	"quantity_rework" integer DEFAULT 0 NOT NULL,
	"inspector" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"assigned_at" timestamp DEFAULT now(),
	"submitted_at" timestamp,
	"expected_completion_date" date,
	"inspected_at" timestamp,
	"completed_at" timestamp,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"selling_price" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "quality_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"production_operation_id" integer NOT NULL,
	"quantity_checked" integer DEFAULT 0 NOT NULL,
	"quantity_passed" integer DEFAULT 0 NOT NULL,
	"quantity_failed" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"checked_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "rework_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"production_operation_id" integer NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token" text PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_inspections" (
	"id" serial PRIMARY KEY NOT NULL,
	"production_operation_id" integer NOT NULL,
	"inspected_by" text NOT NULL,
	"quantity_approved" integer DEFAULT 0 NOT NULL,
	"quantity_rework" integer DEFAULT 0 NOT NULL,
	"quantity_rejected" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"inspected_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"role" text DEFAULT 'OWNER' NOT NULL,
	"phone" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "worker_overtime" (
	"id" serial PRIMARY KEY NOT NULL,
	"worker_id" integer NOT NULL,
	"worked_on" date NOT NULL,
	"hours" integer DEFAULT 0 NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "worker_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"worker_id" integer NOT NULL,
	"payment_date" date NOT NULL,
	"period_month" text NOT NULL,
	"piecework_amount" integer DEFAULT 0 NOT NULL,
	"salary_amount" integer DEFAULT 0 NOT NULL,
	"overtime_amount" integer DEFAULT 0 NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	"method" text,
	"paid_by" text,
	"notes" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"name" text NOT NULL,
	"phone" text,
	"specialty" text DEFAULT 'Tailor' NOT NULL,
	"payment_type" text DEFAULT 'PER_PIECE' NOT NULL,
	"payment_rate" integer DEFAULT 0 NOT NULL,
	"is_inspector" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_purchases" ADD CONSTRAINT "material_purchases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_purchases" ADD CONSTRAINT "material_purchases_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_purchases" ADD CONSTRAINT "material_purchases_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_usage" ADD CONSTRAINT "material_usage_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_usage" ADD CONSTRAINT "material_usage_production_operation_id_production_operations_id_fk" FOREIGN KEY ("production_operation_id") REFERENCES "public"."production_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_usage" ADD CONSTRAINT "material_usage_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "materials" ADD CONSTRAINT "materials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_sizes" ADD CONSTRAINT "order_item_sizes_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_records" ADD CONSTRAINT "packing_records_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_batches" ADD CONSTRAINT "production_batches_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_operations" ADD CONSTRAINT "production_operations_production_batch_id_production_batches_id_fk" FOREIGN KEY ("production_batch_id") REFERENCES "public"."production_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_operations" ADD CONSTRAINT "production_operations_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_checks" ADD CONSTRAINT "quality_checks_production_operation_id_production_operations_id_fk" FOREIGN KEY ("production_operation_id") REFERENCES "public"."production_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rework_records" ADD CONSTRAINT "rework_records_production_operation_id_production_operations_id_fk" FOREIGN KEY ("production_operation_id") REFERENCES "public"."production_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_inspections" ADD CONSTRAINT "stage_inspections_production_operation_id_production_operations_id_fk" FOREIGN KEY ("production_operation_id") REFERENCES "public"."production_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_overtime" ADD CONSTRAINT "worker_overtime_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_payments" ADD CONSTRAINT "worker_payments_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
-- Original company logo, stored separately in each Supabase project.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo_data text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo_mime text;

-- Demo databases should also keep Supabase's public REST roles away from ERP tables.
DO $matesther_security$
DECLARE app_table text;
BEGIN
  FOREACH app_table IN ARRAY ARRAY[
    'organizations','users','sessions','customers','products','orders',
    'order_items','order_item_sizes','workers','production_batches',
    'production_operations','stage_inspections','materials',
    'material_purchases','material_usage','expenses','payments',
    'quality_checks','rework_records','packing_records','deliveries',
    'worker_payments','worker_overtime'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', app_table);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', app_table);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', app_table);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated';
  END IF;
END
$matesther_security$;

CREATE TABLE public.delivery_lines (
  id serial PRIMARY KEY,
  delivery_id integer NOT NULL REFERENCES public.deliveries(id) ON DELETE CASCADE,
  order_item_id integer REFERENCES public.order_items(id) ON DELETE SET NULL,
  description text NOT NULL,
  size text,
  quantity integer NOT NULL CHECK (quantity > 0)
);
ALTER TABLE public.delivery_lines ENABLE ROW LEVEL SECURITY;
DO $matesther_documents$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.delivery_lines FROM anon;
    REVOKE ALL ON SEQUENCE public.delivery_lines_id_seq FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.delivery_lines FROM authenticated;
    REVOKE ALL ON SEQUENCE public.delivery_lines_id_seq FROM authenticated;
  END IF;
END $matesther_documents$;

-- ----------------- SAMPLE DATA -----------------
-- MATESTHER seed data (clean dev database)
TRUNCATE sessions, rework_records, quality_checks, deliveries, packing_records, payments, expenses, material_usage, material_purchases, production_operations, production_batches, order_items, orders, workers, materials, products, customers, users, organizations RESTART IDENTITY CASCADE;

-- Organization
INSERT INTO organizations (name, phone, email, address) VALUES
('Matesther', '08072611499', 'hello@matesther.ng', 'Zone 7 behind Capital Hotel, Osogbo, Osun, Nigeria');

-- Users (staff logins - default passwords: owner123 / manager123 / worker123)
INSERT INTO users (organization_id, name, email, password_hash, role, phone, status) VALUES
(1, 'Esther Adejugba', 'estheradejugba@gmail.com', 'c7fdd513608f38062148d0a13b0a178b:9a3674264c5554518fbf057fb356fe10f3bfe04355da97856813e934db535813', 'OWNER', '08072611499', 'ACTIVE'),
(1, 'Itesh Justina', 'iteshjustina@gmail.com', 'e365ec8c84eb2d8165c27f7a5e09ca08:9ad8e644e7fb8faf72847585a7b610ffcaef941739eb60c158fbe087e7086fbf', 'PRODUCTION_MANAGER', '+234 805 555 0117', 'ACTIVE'),
(1, 'Oyeku Omolayo', 'oyeku.omolayo@gmail.com', 'ad0f1b2be102c6914d4de6362f88b105:709fd4f1c59486c4d14946f8317be16b5c81cf4bc83a5cf177d33942671b0669', 'WORKER', '+234 807 555 0193', 'ACTIVE');

-- Customers (schools & organisations)
INSERT INTO customers (organization_id, name, type, contact_person, phone, email, address) VALUES
(1, 'Osun Model College', 'SCHOOL', 'Mr. Ogunleye (Procurement Officer)', '+234 803 211 4455', 'procurement@osunmodel.sch.ng', 'Ring Road, Osogbo, Osun State'),
(1, 'Victory International School', 'SCHOOL', 'Mrs. Alabi (Bursar)', '+234 805 322 7788', 'bursar@victoryint.sch.ng', 'GRA, Ede, Osun State'),
(1, 'Christ Comprehensive College', 'SCHOOL', 'Mrs. Adeyemi (Vice Principal)', '+234 807 433 9911', 'admin@christcomp.sch.ng', 'Ede Road, Ede, Osun State'),
(1, 'Redeemer''s High School', 'SCHOOL', 'Pastor Femi Ajayi (Admin)', '+234 809 544 2211', 'admin@redeemershigh.sch.ng', 'Ifako, Ilesa, Osun State'),
(1, 'Hope Academy Nursery & Primary', 'SCHOOL', 'Miss Tola Sanni (Head Teacher)', '+234 802 655 3322', 'hopeacademy@gmail.com', 'Ogo-Oluwa, Osogbo'),
(1, 'St. Mary''s Convent', 'SCHOOL', 'Rev. Sr. Agnes', '+234 806 766 4433', 'stmarys.convent@gmail.com', 'Oke-Fia, Osogbo');

-- Products (uniform items)
INSERT INTO products (organization_id, name, description, category, selling_price) VALUES
(1, 'Primary School Shirt', 'White short-sleeve shirt with school monogram', 'Shirts', 4500),
(1, 'Secondary School Shirt', 'White long/short-sleeve shirt with monogram', 'Shirts', 5000),
(1, 'School Trousers', 'Navy poly-cotton trousers with elastic + zip', 'Trousers', 5000),
(1, 'School Skirt', 'Navy pleated skirt with waistband', 'Skirts', 5000),
(1, 'School Shorts', 'Navy shorts for primary pupils', 'Shorts', 4000),
(1, 'School Blazer', 'Navy blazer with embroidered crest', 'Blazers', 12000),
(1, 'PE Uniform', 'House-colour PE top and shorts set', 'Sportswear', 6000);

-- Materials
INSERT INTO materials (organization_id, name, category, unit, current_stock, reorder_level, unit_cost) VALUES
(1, 'Uniform Fabric - White Cotton', 'Fabric', 'yards', 850, 200, 1800),
(1, 'Uniform Fabric - Navy Poly-Cotton', 'Fabric', 'yards', 620, 200, 2000),
(1, 'Uniform Fabric - Grey Check', 'Fabric', 'yards', 120, 150, 2200),
(1, 'Thread - White', 'Thread', 'cones', 140, 40, 850),
(1, 'Thread - Navy', 'Thread', 'cones', 22, 40, 850),
(1, 'Elastic Band 1 inch', 'Elastic', 'rolls', 60, 25, 1200),
(1, 'Buttons - White', 'Buttons', 'packs', 45, 30, 1500),
(1, 'Buttons - Navy', 'Buttons', 'packs', 12, 30, 1600),
(1, 'Zippers 6 inch', 'Notions', 'pcs', 300, 100, 250),
(1, 'Woven School Name Labels', 'Labels', 'pcs', 2500, 1000, 80),
(1, 'Packaging Bags', 'Packaging', 'pcs', 1800, 1000, 120),
(1, 'Monogram / Embroidery Thread', 'Thread', 'spools', 90, 30, 950);

-- Workers
INSERT INTO workers (organization_id, name, phone, specialty, payment_type, payment_rate, status) VALUES
(1, 'Alhaji Musa Ibrahim', '+234 803 111 2233', 'Cutter', 'PER_PIECE', 150, 'ACTIVE'),
(1, 'Mrs. Funke Adeleke', '+234 805 222 3344', 'Cutter', 'PER_PIECE', 150, 'ACTIVE'),
(1, 'Oyeku Omolayo', '+234 807 555 0193', 'Tailor', 'PER_PIECE', 450, 'ACTIVE'),
(1, 'Mrs. Aisha Bello', '+234 809 333 4455', 'Tailor', 'PER_PIECE', 450, 'ACTIVE'),
(1, 'Mr. Tunde Bakare', '+234 802 444 5566', 'Tailor', 'PER_PIECE', 450, 'ACTIVE'),
(1, 'Miss Grace Eze', '+234 806 555 6677', 'Buttonhole', 'PER_PIECE', 60, 'ACTIVE'),
(1, 'Mr. Seun Ajayi', '+234 803 666 7788', 'Button Tacking', 'PER_PIECE', 50, 'ACTIVE'),
(1, 'Mrs. Blessing Nwosu', '+234 805 777 8899', 'Ironer', 'PER_PIECE', 80, 'ACTIVE'),
(1, 'Mr. Ibrahim Lawal', '+234 807 888 9900', 'Packer', 'MONTHLY', 60000, 'ACTIVE'),
(1, 'Mrs. Helen Ogun', '+234 808 999 1122', 'Monogrammer', 'PER_PIECE', 120, 'ACTIVE');

-- Orders
INSERT INTO orders (organization_id, customer_id, order_number, order_date, due_date, status, total_amount, amount_paid, balance, notes) VALUES
(1, 1, 'ORD-2026-001', '2026-06-15', '2026-09-20', 'IN_PROGRESS', 2500000, 1500000, 1000000, 'JSS1 & JSS2 full uniform sets. White shirts with embroidered school monogram on chest pocket. Navy trousers.'),
(1, 2, 'ORD-2026-002', '2026-07-01', '2026-09-14', 'IN_PROGRESS', 1800000, 900000, 900000, 'New session uniforms: primary shirts, shorts and PE sets in house colours (red, blue, green, yellow).'),
(1, 3, 'ORD-2026-003', '2026-05-02', '2026-07-30', 'COMPLETED', 950000, 950000, 0, 'SS3 graduation blazers with crest + shirts. Delivered before valedictory service.'),
(1, 4, 'ORD-2026-004', '2026-08-01', '2026-09-12', 'IN_PROGRESS', 2100000, 500000, 1600000, 'Full school resumption order - shirts and skirts. Customer requested phased delivery by class.'),
(1, 5, 'ORD-2026-005', '2026-08-20', '2026-10-15', 'PENDING', 780000, 0, 780000, 'Nursery & primary resumption order. Measurements to be confirmed with head teacher.');

-- Order items
INSERT INTO order_items (order_id, product_id, quantity, unit_price, total_price, notes) VALUES
(1, 2, 250, 5000, 1250000, 'Secondary shirts - sizes S–XL, monogram required'),
(1, 3, 250, 5000, 1250000, 'Navy trousers - with zip + elastic sides'),
(2, 1, 200, 4500, 900000, 'Primary shirts with monogram'),
(2, 5, 120, 4000, 480000, 'Navy shorts'),
(2, 7, 70, 6000, 420000, 'PE sets in 4 house colours'),
(3, 6, 50, 12000, 600000, 'Blazers with embroidered crest'),
(3, 2, 70, 5000, 350000, 'Shirts for graduating class'),
(4, 2, 200, 5000, 1000000, 'Shirts with monogram'),
(4, 4, 220, 5000, 1100000, 'Pleated skirts'),
(5, 1, 100, 4500, 450000, 'Primary shirts'),
(5, 5, 60, 4000, 240000, 'Shorts'),
(5, 7, 15, 6000, 90000, 'PE sets - sizes 4–8');

-- Production batches
INSERT INTO production_batches (order_id, order_item_id, batch_number, quantity, status) VALUES
(1, 1, 'B-001-A', 250, 'IN_PROGRESS'),
(1, 2, 'B-001-B', 250, 'IN_PROGRESS'),
(2, 3, 'B-002-A', 200, 'IN_PROGRESS'),
(2, 4, 'B-002-B', 190, 'IN_PROGRESS'),
(3, 6, 'B-003-A', 120, 'COMPLETED'),
(4, 8, 'B-004-A', 420, 'IN_PROGRESS');

-- Production operations: batch 1 (B-001-A, 250 shirts)
INSERT INTO production_operations (production_batch_id, stage, worker_id, quantity_received, quantity_completed, quantity_rejected, quantity_remaining, status, assigned_at, expected_completion_date, completed_at, notes) VALUES
(1, 'CUTTING', 1, 250, 250, 0, 0, 'COMPLETED', '2026-06-18 08:30', '2026-06-25', '2026-06-24 16:00', 'White cotton cut into shirt panels. Markers checked.'),
(1, 'SEWING', 3, 250, 165, 4, 81, 'IN_PROGRESS', '2026-06-26 09:00', '2026-09-10', NULL, 'Assembling shirts. 4 pcs failed seam check - sent for rework.'),
(1, 'BUTTONHOLE', 6, 0, 0, 0, 0, 'PENDING', '2026-06-26 09:00', '2026-09-14', NULL, 'Awaiting sewn shirts from tailoring.'),
(1, 'BUTTON_TACKING', 7, 0, 0, 0, 0, 'PENDING', '2026-06-26 09:00', '2026-09-15', NULL, NULL),
(1, 'IRONING', 8, 0, 0, 0, 0, 'PENDING', '2026-06-26 09:00', '2026-09-16', NULL, NULL),
(1, 'PACKING', 9, 0, 0, 0, 0, 'PENDING', '2026-06-26 09:00', '2026-09-18', NULL, 'Pack 10 per bundle, label by class.'),
(1, 'DELIVERY', 9, 0, 0, 0, 0, 'PENDING', '2026-06-26 09:00', '2026-09-20', NULL, 'Deliver to Osun Model College store.');

-- Batch 2 (B-001-B, 250 trousers)
INSERT INTO production_operations (production_batch_id, stage, worker_id, quantity_received, quantity_completed, quantity_rejected, quantity_remaining, status, assigned_at, expected_completion_date, completed_at, notes) VALUES
(2, 'CUTTING', 2, 250, 250, 0, 0, 'COMPLETED', '2026-06-19 08:30', '2026-06-26', '2026-06-25 15:30', 'Navy poly-cotton cut. Elastic lengths pre-cut.'),
(2, 'SEWING', 4, 250, 120, 2, 128, 'IN_PROGRESS', '2026-06-27 09:00', '2026-09-11', NULL, 'Trouser assembly ongoing. Zips being fixed.'),
(2, 'BUTTONHOLE', 6, 0, 0, 0, 0, 'PENDING', '2026-06-27 09:00', '2026-09-14', NULL, 'Waist buttonholes.'),
(2, 'BUTTON_TACKING', 7, 0, 0, 0, 0, 'PENDING', '2026-06-27 09:00', '2026-09-15', NULL, NULL),
(2, 'IRONING', 8, 0, 0, 0, 0, 'PENDING', '2026-06-27 09:00', '2026-09-16', NULL, NULL),
(2, 'PACKING', 9, 0, 0, 0, 0, 'PENDING', '2026-06-27 09:00', '2026-09-18', NULL, NULL),
(2, 'DELIVERY', 9, 0, 0, 0, 0, 'PENDING', '2026-06-27 09:00', '2026-09-20', NULL, NULL);

-- Batch 3 (B-002-A, 200 primary shirts)
INSERT INTO production_operations (production_batch_id, stage, worker_id, quantity_received, quantity_completed, quantity_rejected, quantity_remaining, status, assigned_at, expected_completion_date, completed_at, notes) VALUES
(3, 'CUTTING', 1, 200, 140, 1, 59, 'IN_PROGRESS', '2026-07-12 08:30', '2026-09-09', NULL, 'Cutting ongoing. 1 panel miscut - fabric reserved for replacement.'),
(3, 'SEWING', 5, 0, 0, 0, 0, 'PENDING', '2026-07-12 08:30', '2026-09-12', NULL, NULL),
(3, 'BUTTONHOLE', 6, 0, 0, 0, 0, 'PENDING', '2026-07-12 08:30', '2026-09-13', NULL, NULL),
(3, 'BUTTON_TACKING', 7, 0, 0, 0, 0, 'PENDING', '2026-07-12 08:30', '2026-09-13', NULL, NULL),
(3, 'IRONING', 8, 0, 0, 0, 0, 'PENDING', '2026-07-12 08:30', '2026-09-14', NULL, NULL),
(3, 'PACKING', 9, 0, 0, 0, 0, 'PENDING', '2026-07-12 08:30', '2026-09-14', NULL, NULL),
(3, 'DELIVERY', 9, 0, 0, 0, 0, 'PENDING', '2026-07-12 08:30', '2026-09-14', NULL, NULL);

-- Batch 4 (B-002-B, 190 shorts/PE)
INSERT INTO production_operations (production_batch_id, stage, worker_id, quantity_received, quantity_completed, quantity_rejected, quantity_remaining, status, assigned_at, expected_completion_date, completed_at, notes) VALUES
(4, 'CUTTING', 2, 190, 60, 0, 130, 'IN_PROGRESS', '2026-07-14 08:30', '2026-09-10', NULL, 'Shorts panels first, then PE sets.'),
(4, 'SEWING', 5, 0, 0, 0, 0, 'PENDING', '2026-07-14 08:30', '2026-09-12', NULL, NULL),
(4, 'BUTTONHOLE', 6, 0, 0, 0, 0, 'PENDING', '2026-07-14 08:30', '2026-09-13', NULL, NULL),
(4, 'BUTTON_TACKING', 7, 0, 0, 0, 0, 'PENDING', '2026-07-14 08:30', '2026-09-13', NULL, NULL),
(4, 'IRONING', 8, 0, 0, 0, 0, 'PENDING', '2026-07-14 08:30', '2026-09-14', NULL, NULL),
(4, 'PACKING', 9, 0, 0, 0, 0, 'PENDING', '2026-07-14 08:30', '2026-09-14', NULL, NULL),
(4, 'DELIVERY', 9, 0, 0, 0, 0, 'PENDING', '2026-07-14 08:30', '2026-09-14', NULL, NULL);

-- Batch 5 (B-003-A, completed 120)
INSERT INTO production_operations (production_batch_id, stage, worker_id, quantity_received, quantity_completed, quantity_rejected, quantity_remaining, status, assigned_at, expected_completion_date, completed_at, notes) VALUES
(5, 'CUTTING', 1, 120, 120, 0, 0, 'COMPLETED', '2026-05-05 08:30', '2026-05-12', '2026-05-11 16:00', 'Blazer + shirt panels cut.'),
(5, 'SEWING', 3, 120, 120, 0, 0, 'COMPLETED', '2026-05-13 09:00', '2026-06-20', '2026-06-18 17:00', '2 pcs needed rework on armholes - fixed.'),
(5, 'BUTTONHOLE', 6, 120, 120, 0, 0, 'COMPLETED', '2026-06-19 09:00', '2026-07-01', '2026-06-30 14:00', NULL),
(5, 'BUTTON_TACKING', 7, 120, 120, 0, 0, 'COMPLETED', '2026-07-01 09:00', '2026-07-05', '2026-07-04 13:00', NULL),
(5, 'IRONING', 8, 120, 120, 0, 0, 'COMPLETED', '2026-07-05 09:00', '2026-07-08', '2026-07-08 16:00', NULL),
(5, 'PACKING', 9, 120, 120, 0, 0, 'COMPLETED', '2026-07-08 09:00', '2026-07-25', '2026-07-25 12:00', '12 bundles of 10.'),
(5, 'DELIVERY', 9, 120, 120, 0, 0, 'COMPLETED', '2026-07-25 09:00', '2026-07-30', '2026-07-29 11:00', 'Delivered to school store.');

-- Batch 6 (B-004-A, 420)
INSERT INTO production_operations (production_batch_id, stage, worker_id, quantity_received, quantity_completed, quantity_rejected, quantity_remaining, status, assigned_at, expected_completion_date, completed_at, notes) VALUES
(6, 'CUTTING', 1, 420, 200, 3, 217, 'IN_PROGRESS', '2026-08-05 08:30', '2026-09-09', NULL, 'Large batch - cutting in sections. 3 panels miscut.'),
(6, 'SEWING', 4, 0, 0, 0, 0, 'PENDING', '2026-08-05 08:30', '2026-09-11', NULL, NULL),
(6, 'BUTTONHOLE', 6, 0, 0, 0, 0, 'PENDING', '2026-08-05 08:30', '2026-09-12', NULL, NULL),
(6, 'BUTTON_TACKING', 7, 0, 0, 0, 0, 'PENDING', '2026-08-05 08:30', '2026-09-12', NULL, NULL),
(6, 'IRONING', 8, 0, 0, 0, 0, 'PENDING', '2026-08-05 08:30', '2026-09-13', NULL, NULL),
(6, 'PACKING', 9, 0, 0, 0, 0, 'PENDING', '2026-08-05 08:30', '2026-09-13', NULL, NULL),
(6, 'DELIVERY', 9, 0, 0, 0, 0, 'PENDING', '2026-08-05 08:30', '2026-09-12', NULL, NULL);

-- Material purchases
INSERT INTO material_purchases (organization_id, material_id, supplier, quantity, unit_cost, total_cost, purchase_date, order_id, notes) VALUES
(1, 1, 'Ariaria Fabric Depot, Osogbo', 400, 1800, 720000, '2026-06-16', 1, 'White cotton for 250 shirts'),
(1, 2, 'Ariaria Fabric Depot, Osogbo', 300, 2000, 600000, '2026-06-16', 1, 'Navy poly-cotton for 250 trousers'),
(1, 4, 'Oja-Oba Notions Store', 40, 850, 34000, '2026-06-17', 1, 'Sewing thread'),
(1, 7, 'Oja-Oba Notions Store', 20, 1500, 30000, '2026-06-17', 1, 'Shirt buttons'),
(1, 6, 'Oja-Oba Notions Store', 15, 1200, 18000, '2026-06-17', 1, 'Waist elastic for trousers'),
(1, 11, 'Oja-Oba Notions Store', 600, 120, 72000, '2026-06-18', 1, 'Packaging bags'),
(1, 1, 'Ariaria Fabric Depot, Osogbo', 60, 1850, 111000, '2026-07-22', 1, 'ADDITIONAL purchase - fabric ran short during cutting'),
(1, 2, 'Alaba Textile Market', 250, 2000, 500000, '2026-07-02', 2, 'Navy fabric for shorts + skirts'),
(1, 3, 'Alaba Textile Market', 100, 2200, 220000, '2026-07-02', 2, 'Grey check fabric'),
(1, 5, 'Oja-Oba Notions Store', 30, 850, 25500, '2026-07-03', 2, 'Navy thread'),
(1, 12, 'Embroidery World, Ibadan', 40, 950, 38000, '2026-07-03', 2, 'Embroidery thread for school monogram'),
(1, 2, 'Ariaria Fabric Depot, Osogbo', 60, 2000, 120000, '2026-05-03', 3, 'Blazer fabric'),
(1, 4, 'Oja-Oba Notions Store', 20, 850, 17000, '2026-05-03', 3, 'Thread'),
(1, 8, 'Oja-Oba Notions Store', 15, 1600, 24000, '2026-08-02', 4, 'Navy buttons'),
(1, 2, 'Alaba Textile Market', 300, 2050, 615000, '2026-08-02', 4, 'Navy fabric - bulk buy'),
(1, 10, 'Label Print Nigeria Ltd', 2000, 80, 160000, '2026-08-03', 4, 'Woven name labels'),
(1, 5, 'Oja-Oba Notions Store', 50, 850, 42500, '2026-08-05', NULL, 'General stock top-up'),
(1, 9, 'Oja-Oba Notions Store', 300, 250, 75000, '2026-08-06', NULL, 'General stock - zippers');

-- Material usage (operation ids: b1=1..7, b2=8..14, b3=15..21, b4=22..28, b5=29..35, b6=36..42)
INSERT INTO material_usage (order_id, production_operation_id, material_id, quantity_used, unit_cost, total_cost, used_at) VALUES
(1, 1, 1, 210, 1800, 378000, '2026-06-20 10:00'),
(1, 8, 2, 230, 2000, 460000, '2026-06-21 10:00'),
(1, 2, 4, 18, 850, 15300, '2026-07-05 09:00'),
(1, 9, 4, 15, 850, 12750, '2026-07-06 09:00'),
(1, 9, 6, 8, 1200, 9600, '2026-07-06 09:00'),
(2, 15, 1, 150, 1800, 270000, '2026-07-15 10:00'),
(2, 22, 3, 55, 2200, 121000, '2026-07-16 10:00'),
(3, 29, 2, 60, 2000, 120000, '2026-05-06 10:00'),
(3, 30, 4, 12, 850, 10200, '2026-05-20 09:00'),
(4, 36, 2, 180, 2050, 369000, '2026-08-08 10:00');

-- Expenses
INSERT INTO expenses (organization_id, order_id, category, description, amount, expense_date, notes) VALUES
(1, 1, 'Labour', 'Cutting labour - Batch B-001-A (250 pcs)', 37500, '2026-06-24', 'Alhaji Musa Ibrahim'),
(1, 1, 'Labour', 'Cutting labour - Batch B-001-B (250 pcs)', 37500, '2026-06-25', 'Mrs. Funke Adeleke'),
(1, 1, 'Labour', 'Sewing advance - Chinedu Okafor', 60000, '2026-07-01', 'Part payment'),
(1, 1, 'Labour', 'Monogram / embroidery - school logo (250 shirts)', 75000, '2026-07-18', 'External embroidery vendor'),
(1, 1, 'Transportation', 'Fabric haulage Ariaria market to workshop', 25000, '2026-06-16', NULL),
(1, 1, 'Electricity', 'June power - PHCN + generator fuel', 18000, '2026-06-30', NULL),
(1, 1, 'Materials', 'Extra thread & needles (market run)', 12000, '2026-07-10', NULL),
(1, 2, 'Labour', 'Cutting advance - Victory order', 20000, '2026-07-15', NULL),
(1, 2, 'Transportation', 'Fabric haulage Alaba to Osogbo', 15000, '2026-07-02', NULL),
(1, 3, 'Labour', 'Sewing labour - 120 pcs blazers/shirts', 54000, '2026-06-20', 'Chinedu Okafor'),
(1, 3, 'Labour', 'Buttonhole + button tacking', 13200, '2026-07-01', 'Grace Eze / Seun Ajayi'),
(1, 3, 'Labour', 'Ironing & packing', 15000, '2026-07-10', NULL),
(1, 3, 'Transportation', 'Delivery to Christ Comprehensive College', 30000, '2026-07-28', 'Hired van'),
(1, 3, 'Packaging', 'Packaging bags & labels', 25000, '2026-07-10', NULL),
(1, 3, 'Electricity', 'July power share', 15000, '2026-07-15', NULL),
(1, 4, 'Transportation', 'Fabric haulage Alaba to Osogbo', 28000, '2026-08-02', NULL),
(1, 4, 'Labour', 'Cutting advance', 30000, '2026-08-10', NULL),
(1, NULL, 'Repairs', 'Industrial sewing machine servicing', 35000, '2026-08-01', 'Technician from Ibadan'),
(1, NULL, 'Electricity', 'August PHCN bill', 22000, '2026-08-15', 'Workshop meter');

-- Payments
INSERT INTO payments (order_id, amount, payment_date, payment_method, reference, notes) VALUES
(1, 1000000, '2026-06-20', 'Bank Transfer', 'MTH-REC-001', 'First deposit 40%'),
(1, 500000, '2026-08-05', 'Cash', 'MTH-REC-007', 'Second instalment'),
(2, 900000, '2026-07-10', 'Bank Transfer', 'MTH-REC-003', '50% deposit'),
(3, 500000, '2026-05-10', 'Bank Transfer', 'MTH-REC-002', 'Deposit'),
(3, 450000, '2026-07-29', 'Bank Transfer', 'MTH-REC-006', 'Balance on delivery'),
(4, 500000, '2026-08-03', 'POS', 'MTH-REC-008', 'Mobilisation fee');

-- Quality checks
INSERT INTO quality_checks (production_operation_id, quantity_checked, quantity_passed, quantity_failed, notes, checked_at) VALUES
(2, 165, 161, 4, '4 shirts failed seam check - returned for rework', '2026-08-28 15:00'),
(9, 120, 118, 2, '2 trousers with faulty zips', '2026-08-29 11:00'),
(30, 120, 118, 2, 'Armhole puckering on 2 blazers', '2026-06-18 14:00');

-- Rework
INSERT INTO rework_records (production_operation_id, quantity, reason, status) VALUES
(2, 4, 'Loose side seams - returned to tailor', 'IN_PROGRESS'),
(30, 2, 'Armhole puckering - fixed and re-ironed', 'FIXED');

-- Packing
INSERT INTO packing_records (order_id, quantity_packed, package_count, packed_at, notes) VALUES
(3, 120, 12, '2026-07-25 12:00', '12 bundles of 10, labelled by class');

-- Deliveries
INSERT INTO deliveries (order_id, delivery_date, delivered_quantity, recipient, delivery_address, status, notes) VALUES
(3, '2026-07-29', 120, 'Mrs. Adeyemi (Vice Principal)', 'Christ Comprehensive College, Ede', 'DELIVERED', 'Waybill WB-2026-118. Received in good condition.');

-- ---------- v2: MONOGRAMMING stage + inspection system (fresh-DB sync) ----------
INSERT INTO production_operations (production_batch_id, stage, worker_id, quantity_received, quantity_completed, quantity_rejected, quantity_remaining, quantity_inspected, quantity_approved, quantity_rework, inspector, status, assigned_at, expected_completion_date, completed_at, submitted_at, inspected_at, notes) VALUES
(1, 'MONOGRAMMING', (SELECT id FROM workers WHERE name = 'Mrs. Helen Ogun'), 155, 0, 0, 155, 0, 0, 0, NULL, 'PENDING', '2026-08-20 09:00', '2026-09-12', NULL, NULL, NULL, 'School monogram on chest pocket - approved shirts from sewing (155)'),
(2, 'MONOGRAMMING', (SELECT id FROM workers WHERE name = 'Mrs. Helen Ogun'), 95, 0, 0, 95, 0, 0, 0, NULL, 'PENDING', '2026-08-05 09:00', '2026-09-11', NULL, NULL, NULL, 'Monogram on trousers - approved from sewing (95)'),
(3, 'MONOGRAMMING', (SELECT id FROM workers WHERE name = 'Mrs. Helen Ogun'), 0, 0, 0, 0, 0, 0, 0, NULL, 'PENDING', '2026-07-12 08:30', '2026-09-12', NULL, NULL, NULL, 'Awaiting sewn shirts'),
(4, 'MONOGRAMMING', (SELECT id FROM workers WHERE name = 'Mrs. Helen Ogun'), 0, 0, 0, 0, 0, 0, 0, NULL, 'PENDING', '2026-07-14 08:30', '2026-09-13', NULL, NULL, NULL, 'Awaiting sewn garments'),
(5, 'MONOGRAMMING', (SELECT id FROM workers WHERE name = 'Mrs. Helen Ogun'), 120, 120, 0, 0, 120, 120, 0, 'Esther Adejugba', 'COMPLETED', '2026-06-19 09:00', '2026-06-24', '2026-06-22 15:00', '2026-06-22 10:00', '2026-06-22 15:00', 'Crest embroidered on left chest - all 120 blazers approved'),
(6, 'MONOGRAMMING', (SELECT id FROM workers WHERE name = 'Mrs. Helen Ogun'), 0, 0, 0, 0, 0, 0, 0, NULL, 'PENDING', '2026-08-05 08:30', '2026-09-10', NULL, NULL, NULL, 'Awaiting sewn garments');

UPDATE production_operations SET quantity_inspected = 250, quantity_approved = 250, inspector = 'Esther Adejugba', submitted_at = '2026-06-24 16:00', inspected_at = '2026-06-24 17:00' WHERE id = 1;
UPDATE production_operations SET quantity_inspected = 160, quantity_approved = 155, quantity_rework = 5, inspector = 'Esther Adejugba', submitted_at = '2026-08-25 16:00', inspected_at = '2026-09-05 14:00', status = 'SUBMITTED' WHERE id = 2;
UPDATE production_operations SET quantity_inspected = 250, quantity_approved = 250, inspector = 'Esther Adejugba', submitted_at = '2026-06-25 15:30', inspected_at = '2026-06-25 16:00' WHERE id = 8;
UPDATE production_operations SET quantity_inspected = 100, quantity_approved = 95, quantity_rework = 5, inspector = 'Esther Adejugba', submitted_at = '2026-08-27 16:00', inspected_at = '2026-08-29 11:30', status = 'SUBMITTED' WHERE id = 9;
UPDATE production_operations SET quantity_inspected = 120, quantity_approved = 120, inspector = 'Esther Adejugba', submitted_at = completed_at - interval '2 days', inspected_at = completed_at WHERE id BETWEEN 29 AND 35;
UPDATE production_operations SET quantity_remaining = GREATEST(0, quantity_received - quantity_approved - quantity_rejected);

INSERT INTO stage_inspections (production_operation_id, inspected_by, quantity_approved, quantity_rework, quantity_rejected, notes, inspected_at) VALUES
(1, 'Esther Adejugba', 250, 0, 0, 'All 250 shirt panels cut to spec.', '2026-06-24 17:00'),
(2, 'Esther Adejugba', 145, 5, 0, '150 inspected: 145 approved, 5 sent back for loose side seams.', '2026-08-28 15:30'),
(2, 'Esther Adejugba', 10, 0, 0, 'Rework batch + 5 more submitted - all approved.', '2026-09-05 14:00'),
(8, 'Esther Adejugba', 250, 0, 0, 'Trouser panels + elastic lengths approved.', '2026-06-25 16:00'),
(9, 'Esther Adejugba', 95, 5, 0, '100 inspected: 95 approved, 5 sent back for faulty zips.', '2026-08-29 11:30'),
(29, 'Esther Adejugba', 120, 0, 0, 'Blazer + shirt panels approved.', '2026-05-11 16:00'),
(30, 'Esther Adejugba', 120, 0, 0, '2 armhole reworks fixed and approved.', '2026-06-18 17:00'),
(31, 'Esther Adejugba', 120, 0, 0, 'Buttonholes checked - approved.', '2026-06-30 14:00'),
(32, 'Esther Adejugba', 120, 0, 0, 'Buttons secure - approved.', '2026-07-04 13:00'),
(33, 'Esther Adejugba', 120, 0, 0, 'Ironing approved.', '2026-07-08 16:00'),
(34, 'Esther Adejugba', 120, 0, 0, '12 bundles checked and approved.', '2026-07-25 12:00'),
(35, 'Esther Adejugba', 120, 0, 0, 'Delivered - school store signed the waybill.', '2026-07-29 11:00');
UPDATE workers SET is_inspector = true WHERE name IN ('Alhaji Musa Ibrahim', 'Mrs. Funke Adeleke');
INSERT INTO order_item_sizes (order_item_id, size, quantity, completed) VALUES (1,'S',40,40),(1,'M',70,45),(1,'L',70,50),(1,'XL',60,15),(1,'XXL',10,5);
