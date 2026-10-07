import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  date,
  varchar,
  unique,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------- Organizations ----------
export const organizations = pgTable("organizations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
  // Store the original uploaded image bytes (base64), not a redraw or URL that can expire.
  logoData: text("logo_data"),
  logoMime: text("logo_mime"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------- Users (staff logins) ----------
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").references(() => organizations.id),
  // One login is linked to one production profile. Keep payroll and job history
  // on workers, so changing the account name does not disconnect its records.
  workerId: integer("worker_id").references(() => workers.id, { onDelete: "set null" }).unique(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("OWNER"),
  phone: text("phone"),
  status: text("status").notNull().default("ACTIVE"),
  createdAt: timestamp("created_at").defaultNow(),
},
  (table) => [
    index("users_organization_id_idx").on(table.organizationId)
  ]
);

// ---------- Sessions (signed-in staff) ----------
export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
},
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt)
  ]
);

// ---------- Customers (Schools / Companies) ----------
export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").references(() => organizations.id),
  name: text("name").notNull(),
  type: text("type").notNull().default("SCHOOL"),
  contactPerson: text("contact_person"),
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------- Products (Uniform items) ----------
export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").references(() => organizations.id),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category"),
  sellingPrice: integer("selling_price").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------- Orders ----------
export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").references(() => organizations.id),
  customerId: integer("customer_id").references(() => customers.id),
  orderNumber: varchar("order_number", { length: 50 }).notNull().unique(),
  orderDate: date("order_date").notNull(),
  dueDate: date("due_date"),
  status: text("status").notNull().default("PENDING"),
  totalAmount: integer("total_amount").notNull().default(0),
  amountPaid: integer("amount_paid").notNull().default(0),
  balance: integer("balance").notNull().default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
},
  (table) => [
    index("orders_customer_id_idx").on(table.customerId),
    index("orders_status_idx").on(table.status),
    index("orders_due_date_idx").on(table.dueDate),
    index("orders_created_at_idx").on(table.createdAt)
  ]
);

// ---------- Order items ----------
export const orderItems = pgTable("order_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id")
    .references(() => orders.id, { onDelete: "cascade" })
    .notNull(),
  productId: integer("product_id").references(() => products.id),
  quantity: integer("quantity").notNull().default(0),
  unitPrice: integer("unit_price").notNull().default(0),
  totalPrice: integer("total_price").notNull().default(0),
  notes: text("notes"),
},
  (table) => [
    index("order_items_order_id_idx").on(table.orderId)
  ]
);

// ---------- Workers ----------
export const workers = pgTable("workers", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").references(() => organizations.id),
  name: text("name").notNull(),
  phone: text("phone"),
  // A person is NOT forced into a production specialty: `specialty` may hold a
  // staff position such as "Security" or "Sales" for non-production employees,
  // and `roles` in worker_roles carries the full set either way.
  specialty: text("specialty").notNull().default("Tailor"),
  // Staff-record detail for salaried / non-production employees.
  department: text("department"),
  jobTitle: text("job_title"),
  paymentType: text("payment_type").notNull().default("PER_PIECE"),
  paymentRate: integer("payment_rate").notNull().default(0),
  isInspector: boolean("is_inspector").notNull().default(false),
  status: text("status").notNull().default("ACTIVE"),
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow(),
},
  (table) => [
    index("workers_organization_id_idx").on(table.organizationId),
    index("workers_status_idx").on(table.status)
  ]
);

// ---------- Worker roles (one person, many production roles) ----------
// A single person may legitimately be a Cutter AND a Tailor AND an Inspection
// Officer. That is one workers row with several role rows here - never a
// duplicate person. workers.specialty is kept as the legacy single-role value
// and still counts as an assigned role, so people recorded before this table
// existed keep working with no data backfill.
export const workerRoles = pgTable(
  "worker_roles",
  {
    id: serial("id").primaryKey(),
    workerId: integer("worker_id")
      .references(() => workers.id, { onDelete: "cascade" })
      .notNull(),
    role: text("role").notNull(),
    // The role shown first in lists and used as the default label.
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [unique("worker_roles_worker_id_role_unique").on(table.workerId, table.role)]
);

/**
 * ---------- The exact garment VARIANTS on an order line ----------
 *
 * This table began life as an order-item SIZE breakdown. It is now the order's
 * VARIANT table: one row per exact garment the school actually ordered,
 * identified by item + size + colour + quantity.
 *
 * The table name is unchanged on purpose. Renaming it would be a destructive
 * migration against a live database for no functional gain, and everything that
 * already reads it - the order Sizes tab, POST /api/batches and the assign screen
 * - keeps working. What changed is that a variant may now have:
 *   - a colour as well as a size (`color`, new and nullable);
 *   - neither (`size` is no longer NOT NULL), so both "10 navy blazers, no size
 *     run" and "6 house-red polos in M" are expressible.
 *
 * Both are widenings: every existing row keeps its meaning, and a row written
 * before this change is simply a variant with no colour.
 *
 * `completed` is retained but is no longer the figure to trust - it is derived
 * from the production ledger now (see lib/production-route.ts). It stays so
 * historical rows and anything already reading it keep working.
 */
export const orderItemSizes = pgTable("order_item_sizes", {
  id: serial("id").primaryKey(),
  orderItemId: integer("order_item_id")
    .references(() => orderItems.id, { onDelete: "cascade" })
    .notNull(),
  size: text("size"),
  color: text("color"),
  quantity: integer("quantity").notNull().default(0),
  completed: integer("completed").notNull().default(0),
},
  (table) => [
    index("order_item_sizes_order_item_id_idx").on(table.orderItemId),
    index("order_item_sizes_color_idx").on(table.color),
    /**
     * One row per exact variant.
     *
     * This REPLACES the old unique `(order_item_id, size)` index, which is now
     * wrong rather than merely incomplete: it would reject "size M navy" and
     * "size M black" as duplicates of each other. Dropping an index destroys no
     * data - it is the one DROP in migration 0007, and variants cannot exist
     * without it.
     *
     * The `coalesce(..., '')` form is deliberate. Postgres treats NULLs as
     * distinct in a unique index, so a plain `(item, size, colour)` index would
     * allow unlimited rows for a variant with neither. The expression form makes
     * NULL compare equal to NULL, works on every Postgres version (unlike
     * `NULLS NOT DISTINCT`, which needs 15+), and the test database enforces it
     * identically.
     */
    uniqueIndex("order_item_sizes_variant_unique").on(
      table.orderItemId,
      sql`coalesce(${table.size}, '')`,
      sql`coalesce(${table.color}, '')`
    )
  ]
);

// ---------- Production routes ----------
/**
 * A route is the ordered list of stages ONE garment actually passes through.
 *
 * WHY THIS EXISTS
 *   The eight-stage list was hardcoded in five independent places and every batch
 *   was forced through all eight, up front, whether the garment needed them or
 *   not. A polo that is bought in cut-and-sew form has no CUTTING stage. A
 *   ready-made cardigan has no SEWING stage. Forcing them into the pipeline
 *   created rows that could never be worked - and worse, the progress and
 *   bottleneck views then reported those garments as "stuck at CUTTING" or
 *   "waiting for SEWING" when no such stage existed for them.
 *
 *   A route is therefore a SUBSET of the existing stages, in an order that suits
 *   the garment. It may include all eight, skip stages, start later or end
 *   earlier. It never invents a stage: `stage` values still come from
 *   lib/format.ts, so roles, labels, inspection and payroll all keep working.
 *
 * `product_id` NULL means the organization's generic default route. A product may
 * have its own; `is_default` picks which one a new batch starts from. The route
 * can still be overridden per batch, and once a batch is created its own route is
 * frozen as its production_operations rows - see production_operations.route_position.
 */
export const productionRoutes = pgTable("production_routes", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").references(() => organizations.id),
  productId: integer("product_id").references(() => products.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
},
  (table) => [
    index("production_routes_product_id_idx").on(table.productId),
    index("production_routes_organization_id_idx").on(table.organizationId)
  ]
);

/**
 * The stages of one route, in order.
 *
 * `method` is where the production-method axis lives: a route can say that this
 * garment's MONOGRAMMING is outsourced while its SEWING is internal, without any
 * other stage knowing about it.
 *
 * `role_required` is optional and overrides the generic STAGE_ROLES mapping when
 * set, so a route can demand a specific role at a stage the default map does not
 * cover (notably DELIVERY, which the default map only gained in Task 2).
 */
export const productionRouteStages = pgTable("production_route_stages", {
  id: serial("id").primaryKey(),
  routeId: integer("route_id")
    .references(() => productionRoutes.id, { onDelete: "cascade" })
    .notNull(),
  position: integer("position").notNull(),
  stage: text("stage").notNull(),
  method: text("method").notNull().default("INTERNAL"),
  roleRequired: text("role_required"),
  notes: text("notes"),
},
  (table) => [
    index("production_route_stages_route_id_idx").on(table.routeId),
    uniqueIndex("production_route_stages_route_position_unique").on(table.routeId, table.position),
    // A route may not list the same stage twice: that would create two rows
    // competing to be "the" monogramming stage for one batch.
    uniqueIndex("production_route_stages_route_stage_unique").on(table.routeId, table.stage)
  ]
);

// ---------- Production batches ----------
export const productionBatches = pgTable("production_batches", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id")
    .references(() => orders.id, { onDelete: "cascade" })
    .notNull(),
  orderItemId: integer("order_item_id").references(() => orderItems.id),
  batchNumber: text("batch_number").notNull(),
  quantity: integer("quantity").notNull().default(0),
  size: text("size"),
  color: text("color"),
  /**
   * The exact variant this batch produces, when it was allocated from one.
   *
   * `size` and `color` above stay as the batch's own snapshot - they are what
   * every existing screen, delivery line and printed document already reads, and
   * a snapshot must survive later edits to the order. This id is the authoritative
   * link used for variant-level allocation ceilings.
   */
  orderVariantId: integer("order_variant_id").references(() => orderItemSizes.id, { onDelete: "set null" }),
  /**
   * The route this batch was built from - reference only. The batch's OWN frozen
   * route is its set of production_operations rows in route_position order, so
   * editing a product's route later can never rewrite history.
   */
  routeId: integer("route_id").references(() => productionRoutes.id, { onDelete: "set null" }),
  status: text("status").notNull().default("PENDING"),
  createdAt: timestamp("created_at").defaultNow(),
},
  (table) => [
    index("production_batches_order_id_idx").on(table.orderId),
    index("production_batches_order_item_id_idx").on(table.orderItemId),
    index("production_batches_order_variant_id_idx").on(table.orderVariantId),
    index("production_batches_route_id_idx").on(table.routeId)
  ]
);

// ---------- Production operations (one row per stage per batch) ----------
export const productionOperations = pgTable("production_operations", {
  id: serial("id").primaryKey(),
  productionBatchId: integer("production_batch_id")
    .references(() => productionBatches.id, { onDelete: "cascade" })
    .notNull(),
  stage: text("stage").notNull(),
  /**
   * Where this stage sits in THIS BATCH's route - the frozen route.
   *
   * "The next applicable stage" is the operation with the next higher position in
   * the same batch, not `STAGES[STAGES.indexOf(stage) + 1]`, which assumed every
   * garment walks the same eight stages in the same order. A polo whose route
   * skips CUTTING, or a ready-made cardigan whose route starts at PACKING, is
   * expressed purely by which rows exist and what their positions are.
   *
   * NULL on rows created before routes existed; those batches fall back to the
   * eight-stage order, so no historical batch changes behaviour.
   */
  routePosition: integer("route_position"),
  /** The route stage definition this row came from. Reference only. */
  routeStageId: integer("route_stage_id").references(() => productionRouteStages.id, { onDelete: "set null" }),
  /**
   * How this stage is produced: INTERNAL, MACHINE, OUTSOURCED, READY_MADE or
   * VENDOR_PROCESSING. A second axis, orthogonal to `stage`. Defaults to
   * INTERNAL, which is exactly what every existing row is, so no historical job
   * changes meaning.
   */
  method: text("method").notNull().default("INTERNAL"),
  workerId: integer("worker_id").references(() => workers.id),
  // Agreed price for THIS job/stage, not the worker's general profile.
  // Null on historical records falls back to their legacy rate.
  pieceRate: integer("piece_rate"),
  quantityReceived: integer("quantity_received").notNull().default(0),
  quantityCompleted: integer("quantity_completed").notNull().default(0),
  quantityRejected: integer("quantity_rejected").notNull().default(0),
  quantityRemaining: integer("quantity_remaining").notNull().default(0),
  quantityInspected: integer("quantity_inspected").notNull().default(0),
  quantityApproved: integer("quantity_approved").notNull().default(0),
  quantityRework: integer("quantity_rework").notNull().default(0),
  inspector: text("inspector"),
  status: text("status").notNull().default("PENDING"),
  assignedAt: timestamp("assigned_at").defaultNow(),
  submittedAt: timestamp("submitted_at"),
  expectedCompletionDate: date("expected_completion_date"),
  inspectedAt: timestamp("inspected_at"),
  completedAt: timestamp("completed_at"),
  notes: text("notes"),
},
  (table) => [
    index("production_operations_batch_id_idx").on(table.productionBatchId),
    index("production_operations_worker_id_idx").on(table.workerId),
    index("production_operations_stage_idx").on(table.stage),
    index("production_operations_status_idx").on(table.status),
    index("production_operations_method_idx").on(table.method),
    index("production_operations_route_stage_id_idx").on(table.routeStageId),
    // The frozen route is read as "this batch's operations in position order",
    // so two rows may never claim the same position. NULL positions (pre-route
    // batches) do not collide: Postgres treats NULLs as distinct here, which is
    // exactly what legacy rows need.
    uniqueIndex("production_operations_batch_position_unique").on(table.productionBatchId, table.routePosition),
    // One row per stage per batch. Nothing enforced this before, and the,
    // "next stage" lookup in POST /api/inspections takes the first match, so,
    // a duplicate row would silently starve one of the two.
    uniqueIndex("production_operations_batch_stage_unique").on(table.productionBatchId, table.stage)
  ]
);

// ---------- Stage inspections (audit trail - never overwritten) ----------
export const stageInspections = pgTable("stage_inspections", {
  id: serial("id").primaryKey(),
  productionOperationId: integer("production_operation_id")
    .references(() => productionOperations.id, { onDelete: "cascade" })
    .notNull(),
  /**
   * Which worker these approved pieces belong to.
   *
   * NULLABLE ON PURPOSE, AND NULL MEANS SOMETHING. A stage worked by one person
   * was never attributed per worker, so every inspection recorded before split
   * allocation has NULL here, and pay for it is still attributed through
   * `production_operations.worker_id` exactly as before - payroll resolves
   * `coalesce(stage_inspections.worker_id, production_operations.worker_id)`.
   * That is why this column needs NO backfill: the fallback reproduces the old
   * behaviour for every historical row.
   *
   * When a stage is split across several workers, one inspection writes ONE ROW
   * PER WORKER, each carrying that worker's own attributed quantity and their own
   * agreed rate snapshot. The stage's counters are still the sum of its ledger
   * events, so the stage total and the per-worker split can never disagree.
   */
  workerId: integer("worker_id").references(() => workers.id, { onDelete: "set null" }),
  inspectedBy: text("inspected_by").notNull(),
  // Snapshot agreed pay per approved piece at inspection time.
  pieceRate: integer("piece_rate"),
  quantityApproved: integer("quantity_approved").notNull().default(0),
  quantityRework: integer("quantity_rework").notNull().default(0),
  quantityRejected: integer("quantity_rejected").notNull().default(0),
  notes: text("notes"),
  inspectedAt: timestamp("inspected_at").defaultNow(),
},
  (table) => [
    index("stage_inspections_operation_id_idx").on(table.productionOperationId),
    index("stage_inspections_inspected_at_idx").on(table.inspectedAt),
    index("stage_inspections_worker_id_idx").on(table.workerId)
  ]
);
// ---------- External production work ----------
/**
 * One dispatch of work OUT of the factory and back again.
 *
 * A stage whose `method` is OUTSOURCED, VENDOR_PROCESSING or MACHINE is still an
 * ordinary `production_operations` row - it has the same counters, the same
 * inspection/acceptance gate and the same place in the route. This table records
 * the shipments behind it, because one stage can be sent out more than once and
 * each dispatch has its own outcome.
 *
 * THE QUANTITY RULE THIS EXISTS TO ENFORCE
 *   Quantity sent is NOT quantity returned, and quantity returned is NOT quantity
 *   accepted. 100 sent / 96 returned / 2 rejected-damaged / 2 short is a normal
 *   outcome and all four figures are kept separately. Only the ACCEPTED figure
 *   becomes available to the next route stage, and it does so through the
 *   production movement ledger - never by editing a counter.
 *
 * `vendor_name` is free text, matching the existing `material_purchases.supplier`
 * convention. Vendors are deliberately NOT `workers` rows: payroll iterates every
 * worker, so a vendor placed there would accrue phantom piecework. Whether the
 * business wants a vendor master with payment terms is an open decision flagged
 * for Task 4; this table does not pre-empt it, and adding a `vendor_id` later is
 * additive.
 *
 * `unit_cost` / `total_cost` are recorded but not yet classified into the
 * profitability cost categories - that is Task 4. They are nullable so a dispatch
 * can be tracked before anyone knows the price.
 */
export const externalWorkOrders = pgTable("external_work_orders", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").references(() => organizations.id),
  productionOperationId: integer("production_operation_id")
    .references(() => productionOperations.id, { onDelete: "cascade" })
    .notNull(),
  productionBatchId: integer("production_batch_id")
    .references(() => productionBatches.id, { onDelete: "cascade" })
    .notNull(),
  /** Stage identity carried as data, like every production_movements row. */
  stage: text("stage").notNull(),
  method: text("method").notNull(),
  vendorName: text("vendor_name").notNull(),
  quantitySent: integer("quantity_sent").notNull().default(0),
  quantityReturned: integer("quantity_returned").notNull().default(0),
  quantityAccepted: integer("quantity_accepted").notNull().default(0),
  /** Rejected or damaged on return. */
  quantityRejected: integer("quantity_rejected").notNull().default(0),
  /** Never came back. Distinct from rejected: nothing arrived to judge. */
  quantityShort: integer("quantity_short").notNull().default(0),
  unitCost: integer("unit_cost"),
  totalCost: integer("total_cost"),
  /** When the work was due back. Overdue dispatches are what a control view needs. */
  expectedReturnAt: timestamp("expected_return_at"),
  /**
   * What Matesther owes for this dispatch, what has been paid, and the reference.
   *
   * Recorded ON the dispatch rather than in a new payments system: `payments` is
   * money received from a school and `worker_payments` is payroll, and a vendor is
   * deliberately neither. Whether vendors later get a full payment lifecycle of
   * their own is an open decision; until then this is where the state of THIS
   * dispatch lives, and it is additive.
   */
  amountPayable: integer("amount_payable"),
  amountPaid: integer("amount_paid").notNull().default(0),
  paymentReference: text("payment_reference"),
  paidAt: timestamp("paid_at"),
  status: text("status").notNull().default("SENT"),
  sentAt: timestamp("sent_at").defaultNow(),
  returnedAt: timestamp("returned_at"),
  closedAt: timestamp("closed_at"),
  sentBy: text("sent_by"),
  acceptedBy: text("accepted_by"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
},
  (table) => [
    index("external_work_orders_operation_id_idx").on(table.productionOperationId),
    index("external_work_orders_batch_id_idx").on(table.productionBatchId),
    index("external_work_orders_status_idx").on(table.status),
    index("external_work_orders_method_idx").on(table.method)
  ]
);


// ---------- Tailor support work (weaving, taping, other supporting work) ----
// A tailor hands part of their garment work to a support worker. The parent
// production_operations row stays the tailor's responsibility; this table links
// to it for traceability and never replaces it.
export const supportAssignments = pgTable("support_assignments", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").references(() => organizations.id),
  // The tailor who handed the work out. They are the one who may approve it.
  assignedByWorkerId: integer("assigned_by_worker_id")
    .references(() => workers.id, { onDelete: "cascade" })
    .notNull(),
  // The support worker performing it.
  workerId: integer("worker_id")
    .references(() => workers.id, { onDelete: "cascade" })
    .notNull(),
  // Optional link back to the parent tailor's stage job.
  productionOperationId: integer("production_operation_id").references(
    () => productionOperations.id,
    { onDelete: "set null" }
  ),
  /**
   * The exact SHARE of that stage the helper is supporting.
   *
   * `productionOperationId` alone says "the sewing stage of this batch", which on a
   * stage split three ways does not say whose 40 pieces the helper is taping. This
   * does - and it is what makes the deduction land on the right tailor, because an
   * allocation names the worker it belongs to.
   *
   * Nullable: support work recorded before split allocation existed has no share to
   * point at, and its deduction still resolves through `assignedByWorkerId`.
   */
  productionAllocationId: integer("production_allocation_id").references(
    () => productionAllocations.id,
    { onDelete: "set null" }
  ),
  orderId: integer("order_id").references(() => orders.id, { onDelete: "set null" }),
  /**
   * The exact garment the support work is on, inherited from the allocation or the
   * stage's batch - never chosen from scratch. A helper cannot be handed "some
   * school's order"; they are handed this item, this size, this colour, from this
   * stage, in this quantity.
   */
  orderItemId: integer("order_item_id").references(() => orderItems.id, { onDelete: "set null" }),
  orderVariantId: integer("order_variant_id").references(() => orderItemSizes.id, { onDelete: "set null" }),
  /** The production stage inherited from the parent job, e.g. "SEWING". */
  stage: text("stage"),
  // The supporting operation itself, e.g. "Weaving" or "Taping".
  operation: text("operation").notNull(),
  pieceRate: integer("piece_rate").notNull().default(0),
  quantityAssigned: integer("quantity_assigned").notNull().default(0),
  quantitySubmitted: integer("quantity_submitted").notNull().default(0),
  quantityApproved: integer("quantity_approved").notNull().default(0),
  quantityRework: integer("quantity_rework").notNull().default(0),
  quantityRejected: integer("quantity_rejected").notNull().default(0),
  status: text("status").notNull().default("ASSIGNED"),
  /**
   * WHEN THE HELPER ACTUALLY BEGAN, and when they stopped.
   *
   * `status` says where the work is now. These say how it got there, which is what
   * Production Control needs in order to report that a tailor's stage is waiting on
   * support that has been paused since a particular moment - and what makes "the
   * helper has not started" distinguishable from "the helper is halfway through".
   *
   * NULLABLE WITH NO DEFAULT AND NOTHING BACKFILLED. An assignment recorded before
   * this existed has no start time, and that is the truth about it: inventing one
   * would put a fabricated timestamp behind a payroll figure. `paused_at` is
   * cleared on resume, because the trail of every pause is in
   * `support_status_events` - this column answers only "is it paused right now,
   * and since when".
   */
  startedAt: timestamp("started_at"),
  pausedAt: timestamp("paused_at"),
  /** Required by the API when pausing: a pause with no reason is not actionable. */
  pauseReason: text("pause_reason"),
  /**
   * Who submitted the work, by name.
   *
   * The submitter is always the support worker - `PUT /api/support-work` refuses
   * anyone else - but recording it here makes a submission attributable without
   * walking the event trail, which is what an inspector looks at first.
   */
  submittedByName: text("submitted_by_name"),
  assignedAt: timestamp("assigned_at").defaultNow(),
  submittedAt: timestamp("submitted_at"),
  inspectedAt: timestamp("inspected_at"),
  approvedByWorkerId: integer("approved_by_worker_id").references(() => workers.id, {
    onDelete: "set null",
  }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
},
  (table) => [
    index("support_assignments_worker_id_idx").on(table.workerId),
    index("support_assignments_assigned_by_idx").on(table.assignedByWorkerId),
    index("support_assignments_operation_id_idx").on(table.productionOperationId),
    index("support_assignments_order_id_idx").on(table.orderId),
    index("support_assignments_allocation_id_idx").on(table.productionAllocationId),
    index("support_assignments_order_variant_id_idx").on(table.orderVariantId),
    index("support_assignments_order_item_id_idx").on(table.orderItemId),
    // "Which support work is still open, and which of it is paused?" is asked on
    // every load of the production control board, so it must not scan the table.
    index("support_assignments_status_idx").on(table.status)
  ]
);

/**
 * ---------- The support-work lifecycle trail ----------
 *
 * APPEND-ONLY, AND THE SAME PATTERN THE CODEBASE ALREADY USES TWICE:
 * `production_movements` is the trail behind a stage's derived quantity counters,
 * and `stage_inspections` is the trail behind a stage's approved figure. Support
 * work was the one production area with no trail of its own - `status` could say
 * where the work is NOW but never how it got there, so a pause was invisible the
 * moment the helper resumed, and last month's question was unanswerable.
 *
 * One row per transition, carrying who made it and, where a reason is required
 * (a pause, a cancellation), what that reason was. Rows are never updated and
 * never deleted; the assignment's own `status`, `started_at` and `paused_at` are
 * the current-state cache of this trail, exactly as `production_operations`'
 * counters are of the movement ledger.
 *
 * `event_type` is DATA rather than a closed enum, for the reason
 * `production_movements.event_type` is: a new lifecycle state becomes a code
 * change plus a row, never a migration to alter a type.
 */
export const supportStatusEvents = pgTable("support_status_events", {
  id: serial("id").primaryKey(),
  supportAssignmentId: integer("support_assignment_id")
    .references(() => supportAssignments.id, { onDelete: "cascade" })
    .notNull(),
  organizationId: integer("organization_id").references(() => organizations.id),
  /** CREATED, STARTED, PAUSED, RESUMED, SUBMITTED, INSPECTED, CANCELLED. */
  eventType: text("event_type").notNull(),
  /** Null on the first event: there was no state before it. */
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  /**
   * WHO moved it. Both halves, exactly as `production_movements` does: the id
   * survives a rename and the name survives a deleted user. `actor_worker_id` is
   * the factory profile where the actor has one, so "which of the two people on
   * this assignment acted" is answerable without joining by name.
   */
  actorUserId: integer("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  actorWorkerId: integer("actor_worker_id").references(() => workers.id, { onDelete: "set null" }),
  actorName: text("actor_name").notNull(),
  /** Required for a pause and a cancellation; null for a routine transition. */
  reason: text("reason"),
  notes: text("notes"),
  occurredAt: timestamp("occurred_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
},
  (table) => [
    index("support_status_events_assignment_id_idx").on(table.supportAssignmentId),
    index("support_status_events_occurred_at_idx").on(table.occurredAt),
    index("support_status_events_event_type_idx").on(table.eventType)
  ]
);

// ---------- Support-work inspections (append-only audit trail) ----------
// Mirrors stage_inspections: every pass is a new row, so rework and rejection
// history is preserved rather than overwritten.
export const supportInspections = pgTable("support_inspections", {
  id: serial("id").primaryKey(),
  supportAssignmentId: integer("support_assignment_id")
    .references(() => supportAssignments.id, { onDelete: "cascade" })
    .notNull(),
  inspectedBy: text("inspected_by").notNull(),
  // Snapshot of the agreed rate, so pay history survives a later rate change.
  pieceRate: integer("piece_rate"),
  quantityApproved: integer("quantity_approved").notNull().default(0),
  quantityRework: integer("quantity_rework").notNull().default(0),
  quantityRejected: integer("quantity_rejected").notNull().default(0),
  notes: text("notes"),
  inspectedAt: timestamp("inspected_at").defaultNow(),
},
  (table) => [
    index("support_inspections_assignment_id_idx").on(table.supportAssignmentId),
    index("support_inspections_inspected_at_idx").on(table.inspectedAt)
  ]
);

// ---------- Materials ----------
export const materials = pgTable("materials", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").references(() => organizations.id),
  name: text("name").notNull(),
  category: text("category"),
  unit: text("unit").notNull().default("pcs"),
  currentStock: integer("current_stock").notNull().default(0),
  reorderLevel: integer("reorder_level").notNull().default(0),
  unitCost: integer("unit_cost").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------- Material purchases ----------
export const materialPurchases = pgTable("material_purchases", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").references(() => organizations.id),
  materialId: integer("material_id")
    .references(() => materials.id)
    .notNull(),
  supplier: text("supplier"),
  quantity: integer("quantity").notNull().default(0),
  unitCost: integer("unit_cost").notNull().default(0),
  totalCost: integer("total_cost").notNull().default(0),
  purchaseDate: date("purchase_date").notNull(),
  orderId: integer("order_id").references(() => orders.id),
  /**
   * READY-MADE linkage.
   *
   * Buying a finished garment is a PURCHASE, not labour: it stays in this table
   * with its own cost and is never recorded as tailor piecework. These two links
   * tie a purchased finished good to the exact variant and to the route stage it
   * satisfies, so accepting it can release quantity downstream.
   *
   * `material_id` is NOT NULL, so a ready-made garment is a `materials` row - use
   * `materials.category` = 'Ready-made garment'. That needs no new table and no
   * change to stock keeping, and it is what keeps a ready-made purchase visibly
   * distinct from outsourced production (which lives in external_work_orders).
   */
  productionOperationId: integer("production_operation_id").references(() => productionOperations.id, { onDelete: "set null" }),
  orderVariantId: integer("order_variant_id").references(() => orderItemSizes.id, { onDelete: "set null" }),
  notes: text("notes"),
},
  (table) => [
    index("material_purchases_material_id_idx").on(table.materialId),
    index("material_purchases_order_id_idx").on(table.orderId),
    index("material_purchases_operation_id_idx").on(table.productionOperationId),
    index("material_purchases_order_variant_id_idx").on(table.orderVariantId)
  ]
);

// ---------- Material usage ----------
export const materialUsage = pgTable("material_usage", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").references(() => orders.id),
  productionOperationId: integer("production_operation_id").references(
    () => productionOperations.id
  ),
  materialId: integer("material_id")
    .references(() => materials.id)
    .notNull(),
  quantityUsed: integer("quantity_used").notNull().default(0),
  /**
   * Issued / returned / wasted, around the `quantity_used` figure that has always
   * been there.
   *
   * `quantityIssued` is NULLABLE on purpose: NULL means "this record predates issue
   * tracking, or nobody separated the two", which reads as issued = used. A zero would
   * claim nothing at all was handed out, which is a different statement. Returned and
   * wasted default to 0, so every row written before these columns existed keeps the
   * meaning it already had and no historical figure is restated.
   *
   * New records are checked so that used + returned + wasted never exceeds issued.
   * Nothing here is a second inventory system: `materials.current_stock` is still the
   * one stock figure, adjusted by what leaves the store and what comes back to it.
   */
  quantityIssued: integer("quantity_issued"),
  quantityReturned: integer("quantity_returned").notNull().default(0),
  quantityWasted: integer("quantity_wasted").notNull().default(0),
  /** Who the material was issued to, or which process consumed it. */
  workerId: integer("worker_id").references(() => workers.id, { onDelete: "set null" }),
  /** The exact variant the material was consumed on, where it is known. */
  orderVariantId: integer("order_variant_id").references(() => orderItemSizes.id, { onDelete: "set null" }),
  notes: text("notes"),
  unitCost: integer("unit_cost").notNull().default(0),
  totalCost: integer("total_cost").notNull().default(0),
  usedAt: timestamp("used_at").defaultNow(),
},
  (table) => [
    index("material_usage_order_id_idx").on(table.orderId),
    index("material_usage_material_id_idx").on(table.materialId),
    index("material_usage_operation_id_idx").on(table.productionOperationId),
    index("material_usage_worker_id_idx").on(table.workerId),
    index("material_usage_order_variant_id_idx").on(table.orderVariantId)
  ]
);

// ---------- Expenses ----------
export const expenses = pgTable("expenses", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").references(() => organizations.id),
  orderId: integer("order_id").references(() => orders.id),
  category: text("category").notNull().default("Other"),
  description: text("description").notNull(),
  amount: integer("amount").notNull().default(0),
  expenseDate: date("expense_date").notNull(),
  notes: text("notes"),
},
  (table) => [
    index("expenses_order_id_idx").on(table.orderId)
  ]
);

// ---------- Payments ----------
export const payments = pgTable("payments", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id")
    .references(() => orders.id, { onDelete: "cascade" })
    .notNull(),
  amount: integer("amount").notNull().default(0),
  paymentDate: date("payment_date").notNull(),
  paymentMethod: text("payment_method").notNull().default("Bank Transfer"),
  reference: text("reference"),
  notes: text("notes"),
  /**
   * WHO recorded this, derived from the authenticated session - never from the request body.
   *
   * Same actor pattern as `production_movements.actor_user_id` / `actor_name`, and the same
   * server-side derivation as `worker_payments.paid_by` and `stage_inspections.inspected_by`,
   * so this is the existing audit mechanism reaching three tables that had none - not a second
   * system. Both columns are nullable and NOTHING is backfilled: a row recorded before this
   * existed has no actor, which is the truth, rather than an invented one. The id is `set null`
   * if the user is ever deleted, so the name still reads as the record of who it was.
   */
  recordedById: integer("recorded_by_id").references(() => users.id, { onDelete: "set null" }),
  recordedByName: text("recorded_by_name"),
},
  (table) => [
    index("payments_order_id_idx").on(table.orderId)
  ]
);

// ---------- Quality checks ----------
export const qualityChecks = pgTable("quality_checks", {
  id: serial("id").primaryKey(),
  productionOperationId: integer("production_operation_id")
    .references(() => productionOperations.id, { onDelete: "cascade" })
    .notNull(),
  quantityChecked: integer("quantity_checked").notNull().default(0),
  quantityPassed: integer("quantity_passed").notNull().default(0),
  quantityFailed: integer("quantity_failed").notNull().default(0),
  notes: text("notes"),
  checkedAt: timestamp("checked_at").defaultNow(),
},
  (table) => [
    index("quality_checks_operation_id_idx").on(table.productionOperationId)
  ]
);

// ---------- Rework records ----------
export const reworkRecords = pgTable("rework_records", {
  id: serial("id").primaryKey(),
  productionOperationId: integer("production_operation_id")
    .references(() => productionOperations.id, { onDelete: "cascade" })
    .notNull(),
  quantity: integer("quantity").notNull().default(0),
  reason: text("reason"),
  status: text("status").notNull().default("PENDING"),
  createdAt: timestamp("created_at").defaultNow(),
},
  (table) => [
    index("rework_records_operation_id_idx").on(table.productionOperationId)
  ]
);

// ---------- Packing records ----------
export const packingRecords = pgTable("packing_records", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id")
    .references(() => orders.id, { onDelete: "cascade" })
    .notNull(),
  quantityPacked: integer("quantity_packed").notNull().default(0),
  packageCount: integer("package_count").notNull().default(0),
  packedAt: timestamp("packed_at").defaultNow(),
  notes: text("notes"),
  /**
   * WHO recorded this, derived from the authenticated session - never from the request body.
   *
   * Same actor pattern as `production_movements.actor_user_id` / `actor_name`, and the same
   * server-side derivation as `worker_payments.paid_by` and `stage_inspections.inspected_by`,
   * so this is the existing audit mechanism reaching three tables that had none - not a second
   * system. Both columns are nullable and NOTHING is backfilled: a row recorded before this
   * existed has no actor, which is the truth, rather than an invented one. The id is `set null`
   * if the user is ever deleted, so the name still reads as the record of who it was.
   */
  recordedById: integer("recorded_by_id").references(() => users.id, { onDelete: "set null" }),
  recordedByName: text("recorded_by_name"),
},
  (table) => [
    index("packing_records_order_id_idx").on(table.orderId)
  ]
);

// ---------- Worker payments (payroll records) ----------
export const workerPayments = pgTable(
  "worker_payments",
  {
    id: serial("id").primaryKey(),
    workerId: integer("worker_id")
      .references(() => workers.id, { onDelete: "cascade" })
      .notNull(),
    paymentDate: date("payment_date").notNull(),
    periodMonth: text("period_month").notNull(),
    pieceworkAmount: integer("piecework_amount").notNull().default(0),
    // Piecework earned on tailor support work, kept separate from stage work.
    supportAmount: integer("support_amount").notNull().default(0),
    salaryAmount: integer("salary_amount").notNull().default(0),
    overtimeAmount: integer("overtime_amount").notNull().default(0),
    // Any other approved payment (allowance, advance settlement, bonus).
    otherAmount: integer("other_amount").notNull().default(0),
    amount: integer("amount").notNull().default(0),
    method: text("method"),
    paidBy: text("paid_by"),
    // Bank or transfer reference, shown on the monthly payment sheet.
    reference: text("reference"),
    // Optional caller-supplied key. A unique index on it makes the same payment
    // impossible to record twice, while still allowing legitimate part payments
    // (a different key). Rows with no key stay NULL and never collide.
    idempotencyKey: text("idempotency_key"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    unique("worker_payments_idempotency_key_unique").on(table.idempotencyKey),
    index("worker_payments_worker_id_idx").on(table.workerId),
    index("worker_payments_period_month_idx").on(table.periodMonth),
  ]
);

// ---------- Worker overtime ----------
export const workerOvertime = pgTable("worker_overtime", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id")
    .references(() => workers.id, { onDelete: "cascade" })
    .notNull(),
  workedOn: date("worked_on").notNull(),
  hours: integer("hours").notNull().default(0),
  amount: integer("amount").notNull().default(0),
  // "OVERTIME" or "OTHER" - lets the Owner record an approved allowance or
  // bonus on the same path without a second table. Existing rows are overtime.
  category: text("category").notNull().default("OVERTIME"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
},
  (table) => [
    index("worker_overtime_worker_id_idx").on(table.workerId),
    index("worker_overtime_worked_on_idx").on(table.workedOn)
  ]
);

// ---------- Deliveries ----------
export const deliveries = pgTable("deliveries", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id")
    .references(() => orders.id, { onDelete: "cascade" })
    .notNull(),
  deliveryDate: date("delivery_date").notNull(),
  deliveredQuantity: integer("delivered_quantity").notNull().default(0),
  recipient: text("recipient"),
  deliveryAddress: text("delivery_address"),
  status: text("status").notNull().default("PENDING"),
  notes: text("notes"),
  /**
   * WHO recorded this, derived from the authenticated session - never from the request body.
   *
   * Same actor pattern as `production_movements.actor_user_id` / `actor_name`, and the same
   * server-side derivation as `worker_payments.paid_by` and `stage_inspections.inspected_by`,
   * so this is the existing audit mechanism reaching three tables that had none - not a second
   * system. Both columns are nullable and NOTHING is backfilled: a row recorded before this
   * existed has no actor, which is the truth, rather than an invented one. The id is `set null`
   * if the user is ever deleted, so the name still reads as the record of who it was.
   */
  recordedById: integer("recorded_by_id").references(() => users.id, { onDelete: "set null" }),
  recordedByName: text("recorded_by_name"),
},
  (table) => [
    index("deliveries_order_id_idx").on(table.orderId)
  ]
);

// Snapshot the exact garment and size contents of each shipment. Keeping the
// description here means a historical delivery sheet survives product edits.
export const deliveryLines = pgTable("delivery_lines", {
  id: serial("id").primaryKey(),
  deliveryId: integer("delivery_id").references(() => deliveries.id, { onDelete: "cascade" }).notNull(),
  orderItemId: integer("order_item_id").references(() => orderItems.id, { onDelete: "set null" }),
  description: text("description").notNull(),
  size: text("size"),
  quantity: integer("quantity").notNull(),
},
  (table) => [
    index("delivery_lines_delivery_id_idx").on(table.deliveryId),
    index("delivery_lines_order_item_id_idx").on(table.orderItemId)
  ]
);

/**
 * ---------- Production allocations: one exact stage split across workers ----------
 *
 * WHY THIS TABLE EXISTS
 *   `production_operations` holds ONE `worker_id`, so a stage could only ever
 *   belong to one person. A real order line - 100 navy size-10 polos at SEWING -
 *   is often split: 40 to one tailor, 35 to another, 25 to a third. The only way
 *   to express that before was several batches, which fragments the variant, the
 *   route and the order's own allocation ceiling.
 *
 * WHY A SUB-TABLE AND NOT MORE `production_operations` ROWS
 *   Task 2 added `uniqueIndex(production_operations(production_batch_id, stage))`
 *   because "the next stage" was found by taking the FIRST row matching a stage
 *   name - a duplicate would silently starve one of the two. Route progression now
 *   reads `route_position`, and `uniqueIndex(production_batch_id, route_position)`
 *   protects it the same way. Both indexes STAY: they are what makes a batch's
 *   route unambiguous. The constraint that actually blocked several workers was
 *   the single `worker_id` column, and that is what this table evolves - one stage
 *   row, several allocations against it.
 *
 *   This is also the shape `support_assignments` already uses against its parent
 *   operation, so it is not a new idea in this codebase.
 *
 * INVARIANTS, ALL ENFORCED SERVER-SIDE
 *   - the allocations on one stage may never sum to more than the stage holds, and
 *     what a stage holds comes from the movement ledger, not from a typed figure;
 *   - an allocation may never be reduced below what that worker already submitted;
 *   - approved quantity stays attributable to the person who earned it, so a
 *     reassignment moves only the UNWORKED remainder and can never move pay;
 *   - a stage with no allocation rows behaves exactly as it did before this table
 *     existed, which is why no historical row needs backfilling.
 */
export const productionAllocations = pgTable("production_allocations", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").references(() => organizations.id),
  productionOperationId: integer("production_operation_id")
    .references(() => productionOperations.id, { onDelete: "cascade" })
    .notNull(),
  // Denormalised so a batch's or a variant's whole allocation picture is one
  // indexed lookup.
  productionBatchId: integer("production_batch_id")
    .references(() => productionBatches.id, { onDelete: "cascade" })
    .notNull(),
  /** Stage identity carried as data, like every production_movements row. */
  stage: text("stage").notNull(),
  workerId: integer("worker_id")
    .references(() => workers.id, { onDelete: "cascade" })
    .notNull(),
  /**
   * The rate agreed with THIS worker for THIS stage, snapshotted when the
   * allocation was made. Workers on the same stage may legitimately agree
   * different rates, and a later change to anyone's profile rate must not
   * restate what was already agreed.
   */
  pieceRate: integer("piece_rate"),
  quantityAllocated: integer("quantity_allocated").notNull().default(0),
  quantitySubmitted: integer("quantity_submitted").notNull().default(0),
  quantityApproved: integer("quantity_approved").notNull().default(0),
  quantityRework: integer("quantity_rework").notNull().default(0),
  quantityRejected: integer("quantity_rejected").notNull().default(0),
  status: text("status").notNull().default("ASSIGNED"),
  assignedAt: timestamp("assigned_at").defaultNow(),
  assignedByUserId: integer("assigned_by_user_id").references(() => users.id, { onDelete: "set null" }),
  assignedByName: text("assigned_by_name"),
  /**
   * The allocation this one inherited unworked quantity from. Reassignment is a
   * new row pointing back at the old one rather than an edit of it, so the trail
   * shows who had the work first, how much they did, and why it moved.
   */
  transferredFromId: integer("transferred_from_id"),
  reason: text("reason"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
},
  (table) => [
    index("production_allocations_operation_id_idx").on(table.productionOperationId),
    index("production_allocations_batch_id_idx").on(table.productionBatchId),
    index("production_allocations_worker_id_idx").on(table.workerId),
    index("production_allocations_status_idx").on(table.status),
    // A worker holds ONE live allocation per stage. A transfer closes the old row
    // (status TRANSFERRED or CANCELLED) and opens a new one, so this partial
    // uniqueness is what stops the same person being allocated the same stage
    // twice and double-counting their share.
    uniqueIndex("production_allocations_live_one_per_worker_unique")
      .on(table.productionOperationId, table.workerId)
      .where(sql`${table.status} in ('ASSIGNED', 'ACTIVE')`),
  ]
);

// ---------- Production movement ledger ----------
/**
 * Append-only record of every event that changes a production quantity.
 *
 * WHY THIS EXISTS
 *   `production_operations` stores seven counters that two different routes used
 *   to be able to write directly, so a counter could be moved without any record
 *   of who moved it, when, or why - and could even be moved below the figure its
 *   own inspection history proves. The counters are now a derived cache of this
 *   ledger (see src/lib/production-ledger.ts): every quantity is the sum of the
 *   events that produced it, and a correction is itself an event with a reason.
 *
 * TWO DELIBERATE DESIGN CHOICES FOR TASK 3
 *   1. `event_type` is DATA, not a closed enum in code. Task 3 adds
 *      SENT_EXTERNAL / RETURNED_EXTERNAL / ACCEPTED_RETURN / RECEIVED_READYMADE /
 *      MATERIAL_ISSUED to the same table instead of building a second ledger.
 *   2. `stage` is stored on every row. Stage identity therefore never depends on
 *      a row's position in a global eight-element array, which is what lets a
 *      route position replace that array index when garments stop following the
 *      same eight stages.
 *
 * Rows are never updated and never deleted. `source` distinguishes events
 * recorded as they happened ('LIVE') from rows reconstructed by the 0006
 * backfill for production that predates the ledger ('INFERRED').
 */
export const productionMovements = pgTable("production_movements", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").references(() => organizations.id),
  productionOperationId: integer("production_operation_id")
    .references(() => productionOperations.id, { onDelete: "cascade" })
    .notNull(),
  // Denormalised so a whole batch's history is one indexed lookup.
  productionBatchId: integer("production_batch_id")
    .references(() => productionBatches.id, { onDelete: "cascade" })
    .notNull(),
  stage: text("stage").notNull(),
  eventType: text("event_type").notNull(),
  /** Signed where a correction can reduce a quantity; never null. */
  quantity: integer("quantity").notNull().default(0),
  workerId: integer("worker_id").references(() => workers.id, { onDelete: "set null" }),
  actorUserId: integer("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  actorName: text("actor_name").notNull(),
  source: text("source").notNull().default("LIVE"),
  /** The row that caused this event, e.g. referenceType 'STAGE_INSPECTION'. */
  referenceType: text("reference_type"),
  referenceId: integer("reference_id"),
  /** Required for corrections and reassignments: the human reason. */
  reason: text("reason"),
  notes: text("notes"),
  occurredAt: timestamp("occurred_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
},
  (table) => [
    index("production_movements_operation_id_idx").on(table.productionOperationId),
    index("production_movements_batch_id_idx").on(table.productionBatchId),
    index("production_movements_event_type_idx").on(table.eventType),
    index("production_movements_occurred_at_idx").on(table.occurredAt),
  ]
);

// ---------- Audit: order removals ----------
/**
 * One row per order removed, kept AFTER the order is gone.
 *
 * WHY THIS EXISTS
 *   Deleting an order used to be a single unguarded statement that cascaded away the
 *   order's items, variants, batches, stages, movement ledger, allocations,
 *   inspections, quality checks, rework, receipts, packing records and deliveries -
 *   and left nothing behind that said it had happened. `production_movements` cannot
 *   serve as this record, because it hangs from `production_operations`: the events
 *   would cascade away with the very rows they describe and the trail would delete
 *   itself. A removal has to be recorded somewhere that survives the removal.
 *
 * WHAT IT RECORDS
 *   Who, why (mandatory - the API refuses without it), which school and order number,
 *   and what the order held at the moment it went: its money and the size of the
 *   production behind it. Those figures are what makes "we deleted the test order"
 *   checkable against "we deleted a live order".
 *
 *   `order_id` is a plain integer, deliberately NOT a foreign key: the order it names
 *   no longer exists by the time this row is read, and a reference would either block
 *   the deletion or cascade this record away with it.
 *
 *   `deleted_by_id` IS a foreign key with `set null`, because the user may still exist
 *   and may later be deleted; the name column beside it survives them either way. Same
 *   actor pattern as `payments.recorded_by_*` and `production_movements.actor_*`.
 */
export const orderDeletions = pgTable("order_deletions", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").references(() => organizations.id),
  orderId: integer("order_id").notNull(),
  orderNumber: text("order_number").notNull(),
  customerName: text("customer_name"),
  deletedById: integer("deleted_by_id").references(() => users.id, { onDelete: "set null" }),
  deletedByName: text("deleted_by_name").notNull(),
  reason: text("reason").notNull(),
  totalAmount: integer("total_amount"),
  amountPaid: integer("amount_paid"),
  batchCount: integer("batch_count"),
  operationCount: integer("operation_count"),
  paymentCount: integer("payment_count"),
  deletedAt: timestamp("deleted_at").defaultNow(),
},
  (table) => [
    index("order_deletions_organization_id_idx").on(table.organizationId),
    index("order_deletions_order_id_idx").on(table.orderId),
    index("order_deletions_deleted_by_id_idx").on(table.deletedById),
    index("order_deletions_deleted_at_idx").on(table.deletedAt)
  ]
);

// ---------- Audit: administrative test-data purges ----------
/**
 * One row per administrative test-data cleanup.
 *
 * A purge is the ONE act in Matesther that may remove an order which has approved
 * production and settled money behind it, because clearing test records before the
 * business goes live requires exactly that. An act that strong has to leave a permanent,
 * specific account of itself - otherwise "the test order was removed" and "a real order
 * was removed" are the same sentence.
 *
 * WHAT IT RECORDS
 *   who ran it; the school and order number it was pointed at; the confirmation sentence
 *   they typed (stored, because the control IS that a person wrote the school's name
 *   rather than clicked past a dialog); their reason; the counts and fingerprint the
 *   PREVIEW promised; the counts actually removed; and what could not be safely undone -
 *   payroll already settled for a month this order contributed to, and any inventory
 *   movement that could not be reversed without risking a wrong stock figure.
 *
 *   Storing the preview beside the result is the point: a purge that touched something
 *   its preview did not show is then visible after the fact, not only at the moment the
 *   fingerprint check refused it.
 *
 *   The count columns are text rather than a second normalised table, because they are a
 *   snapshot of a shape that varies with what the order happened to touch, and their only
 *   reader is a person auditing one event. Indexing a per-table count nobody queries
 *   would be structure for its own sake.
 */
export const testDataPurges = pgTable("test_data_purges", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").references(() => organizations.id),
  orderId: integer("order_id").notNull(),
  orderNumber: text("order_number").notNull(),
  customerName: text("customer_name"),
  confirmedCustomerName: text("confirmed_customer_name").notNull(),
  reason: text("reason").notNull(),
  ranById: integer("ran_by_id").references(() => users.id, { onDelete: "set null" }),
  ranByName: text("ran_by_name").notNull(),
  previewCounts: text("preview_counts"),
  previewFingerprint: text("preview_fingerprint").notNull(),
  resultCounts: text("result_counts"),
  payrollReport: text("payroll_report"),
  inventoryReport: text("inventory_report"),
  ranAt: timestamp("ran_at").defaultNow(),
},
  (table) => [
    index("test_data_purges_organization_id_idx").on(table.organizationId),
    index("test_data_purges_order_id_idx").on(table.orderId),
    index("test_data_purges_ran_by_id_idx").on(table.ranById),
    index("test_data_purges_ran_at_idx").on(table.ranAt)
  ]
);
