import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  date,
  varchar,
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
});

// ---------- Sessions (signed-in staff) ----------
export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id, { onDelete: "cascade" })
    .notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
});

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
});

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
});

// ---------- Workers ----------
export const workers = pgTable("workers", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").references(() => organizations.id),
  name: text("name").notNull(),
  phone: text("phone"),
  specialty: text("specialty").notNull().default("Tailor"),
  paymentType: text("payment_type").notNull().default("PER_PIECE"),
  paymentRate: integer("payment_rate").notNull().default(0),
  isInspector: boolean("is_inspector").notNull().default(false),
  status: text("status").notNull().default("ACTIVE"),
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------- Size breakdown per order item ----------
export const orderItemSizes = pgTable("order_item_sizes", {
  id: serial("id").primaryKey(),
  orderItemId: integer("order_item_id")
    .references(() => orderItems.id, { onDelete: "cascade" })
    .notNull(),
  size: text("size").notNull(),
  quantity: integer("quantity").notNull().default(0),
  completed: integer("completed").notNull().default(0),
});

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
});

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
});

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
});

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
});

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
});

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
});

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
});

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
});

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
});

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
});

// ---------- Worker payments (payroll records) ----------
export const workerPayments = pgTable("worker_payments", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id")
    .references(() => workers.id, { onDelete: "cascade" })
    .notNull(),
  paymentDate: date("payment_date").notNull(),
  periodMonth: text("period_month").notNull(),
  pieceworkAmount: integer("piecework_amount").notNull().default(0),
  salaryAmount: integer("salary_amount").notNull().default(0),
  overtimeAmount: integer("overtime_amount").notNull().default(0),
  amount: integer("amount").notNull().default(0),
  method: text("method"),
  paidBy: text("paid_by"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ---------- Worker overtime ----------
export const workerOvertime = pgTable("worker_overtime", {
  id: serial("id").primaryKey(),
  workerId: integer("worker_id")
    .references(() => workers.id, { onDelete: "cascade" })
    .notNull(),
  workedOn: date("worked_on").notNull(),
  hours: integer("hours").notNull().default(0),
  amount: integer("amount").notNull().default(0),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

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
});

// Snapshot the exact garment and size contents of each shipment. Keeping the
// description here means a historical delivery sheet survives product edits.
export const deliveryLines = pgTable("delivery_lines", {
  id: serial("id").primaryKey(),
  deliveryId: integer("delivery_id").references(() => deliveries.id, { onDelete: "cascade" }).notNull(),
  orderItemId: integer("order_item_id").references(() => orderItems.id, { onDelete: "set null" }),
  description: text("description").notNull(),
  size: text("size"),
  quantity: integer("quantity").notNull(),
});
