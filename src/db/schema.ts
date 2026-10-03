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

// ---------- Size breakdown per order item ----------
export const orderItemSizes = pgTable("order_item_sizes", {
  id: serial("id").primaryKey(),
  orderItemId: integer("order_item_id")
    .references(() => orderItems.id, { onDelete: "cascade" })
    .notNull(),
  size: text("size").notNull(),
  quantity: integer("quantity").notNull().default(0),
  completed: integer("completed").notNull().default(0),
},
  (table) => [
    index("order_item_sizes_order_item_id_idx").on(table.orderItemId),
    // One size row per item: POST /api/order-sizes replaces the whole set,
    // so a duplicate (item, size) pair could only come from a bug.,
    uniqueIndex("order_item_sizes_item_size_unique").on(table.orderItemId, table.size)
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
  status: text("status").notNull().default("PENDING"),
  createdAt: timestamp("created_at").defaultNow(),
},
  (table) => [
    index("production_batches_order_id_idx").on(table.orderId),
    index("production_batches_order_item_id_idx").on(table.orderItemId)
  ]
);

// ---------- Production operations (one row per stage per batch) ----------
export const productionOperations = pgTable("production_operations", {
  id: serial("id").primaryKey(),
  productionBatchId: integer("production_batch_id")
    .references(() => productionBatches.id, { onDelete: "cascade" })
    .notNull(),
  stage: text("stage").notNull(),
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
    // One row per stage per batch. Nothing enforced this before, and the,
    // "next stage" lookup in POST /api/inspections takes the first match, so,
    // a duplicate row would silently starve one of the two.,
    uniqueIndex("production_operations_batch_stage_unique").on(table.productionBatchId, table.stage)
  ]
);

// ---------- Stage inspections (audit trail - never overwritten) ----------
export const stageInspections = pgTable("stage_inspections", {
  id: serial("id").primaryKey(),
  productionOperationId: integer("production_operation_id")
    .references(() => productionOperations.id, { onDelete: "cascade" })
    .notNull(),
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
    index("stage_inspections_inspected_at_idx").on(table.inspectedAt)
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
  orderId: integer("order_id").references(() => orders.id, { onDelete: "set null" }),
  // The supporting operation itself, e.g. "Weaving" or "Taping".
  operation: text("operation").notNull(),
  pieceRate: integer("piece_rate").notNull().default(0),
  quantityAssigned: integer("quantity_assigned").notNull().default(0),
  quantitySubmitted: integer("quantity_submitted").notNull().default(0),
  quantityApproved: integer("quantity_approved").notNull().default(0),
  quantityRework: integer("quantity_rework").notNull().default(0),
  quantityRejected: integer("quantity_rejected").notNull().default(0),
  status: text("status").notNull().default("ASSIGNED"),
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
    index("support_assignments_order_id_idx").on(table.orderId)
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
  notes: text("notes"),
},
  (table) => [
    index("material_purchases_material_id_idx").on(table.materialId),
    index("material_purchases_order_id_idx").on(table.orderId)
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
  unitCost: integer("unit_cost").notNull().default(0),
  totalCost: integer("total_cost").notNull().default(0),
  usedAt: timestamp("used_at").defaultNow(),
},
  (table) => [
    index("material_usage_order_id_idx").on(table.orderId),
    index("material_usage_material_id_idx").on(table.materialId),
    index("material_usage_operation_id_idx").on(table.productionOperationId)
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
