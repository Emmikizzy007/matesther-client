/**
 * Test bootstrap. Loaded before any application module via `--require`.
 *
 * WHAT THIS DOES
 *   1. Creates an empty in-memory PostgreSQL emulation (pg-mem).
 *   2. Applies the repository's real Drizzle migrations, in order.
 *   3. Redirects `require("pg")` to that emulation.
 *
 * WHY
 *   The suite must run with no server, no DATABASE_URL and no seeded demo data.
 *   Every test therefore starts from a completely EMPTY production-shaped
 *   database and builds only the fixtures it needs, through the real API.
 *
 * SAFETY
 *   This never opens a network connection and never touches any real database.
 *   The connection string below is a placeholder that pg-mem ignores.
 *
 * ONE DELIBERATE DEVIATION, DOCUMENTED
 *   pg-mem has no plpgsql interpreter, so it cannot execute `DO $$ ... $$`
 *   guard blocks. Migrations 0003, 0004, 0005 and 0006 each wrap their ADD CONSTRAINT
 *   statements in such a block purely so the migration is re-runnable. Because
 *   this database is always created empty, those guards could never fire, so the
 *   statements inside are executed directly. The resulting schema is identical.
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { newDb } = require("pg-mem");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const mem = newDb({ autoCreateForeignKeyIndices: true });
const adapter = mem.adapters.createPg();
global.__PGMEM__ = mem;
global.__PGMEM_ADAPTER__ = { Pool: adapter.Pool, Client: adapter.Client };

// Capture the real driver BEFORE redirecting it, so the shim can still reuse
// pg's static type table (pg.types.builtins) that Drizzle depends on.
global.__REAL_PG__ = require("pg");

// Redirect `pg` -> pg-mem before any app module is loaded.
const shimPath = require.resolve("./pg-shim.cjs");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "pg") return shimPath;
  return originalResolve.call(this, request, ...args);
};

process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/matesther_test";
// Keeps session cookies working over plain http inside the test process.
process.env.NODE_ENV = "test";

const MIGRATIONS = [
  "0000_remarkable_patriot",
  "0001_magical_black_panther",
  "0002_dusty_vindicator",
  "0003_catchup_live_schema",
  "0004_worker_roles",
  "0005_support_work_and_payroll",
  "0006_production_ledger_and_indexes",
  "0007_variants_routes_and_external_work",
  "0008_production_allocations",
  "0009_support_cost_and_material_detail",
  "0010_actor_audit",
];
const INNER_STATEMENTS = /ALTER TABLE[^;]+;/g;

const applied = [];
for (const name of MIGRATIONS) {
  const file = path.join(REPO_ROOT, "drizzle", `${name}.sql`);
  const sql = fs.readFileSync(file, "utf8");
  let statements = 0;
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const statement = chunk.trim();
    if (!statement) continue;
    if (/^DO\s+\$/i.test(statement)) {
      for (const inner of statement.match(INNER_STATEMENTS) || []) {
        mem.public.none(inner);
        statements += 1;
      }
      continue;
    }
    mem.public.none(statement);
    statements += 1;
  }
  applied.push(`${name} (${statements})`);
}

// Fail loudly rather than silently testing against an incomplete schema.
const REQUIRED_COLUMNS = [
  ["users", "worker_id"],
  ["workers", "archived_at"],
  ["production_operations", "piece_rate"],
  ["stage_inspections", "piece_rate"],
  ["production_batches", "size"],
  ["production_batches", "color"],
  // Fails loudly if migration 0004 was not applied: multi-role support depends
  // on this table existing.
  ["worker_roles", "role"],
  // Same for migration 0005: support work, staff fields and payment detail.
  ["support_assignments", "operation"],
  ["support_inspections", "quantity_approved"],
  ["worker_overtime", "category"],
  ["worker_payments", "idempotency_key"],
  ["workers", "department"],
  // Fails loudly if migration 0006 was not applied: the production movement
  // ledger is the source of truth for every derived quantity counter.
  ["production_movements", "event_type"],
  ["production_movements", "source"],
  ["production_movements", "stage"],
  // Fails loudly if migration 0007 was not applied: variants, routes, the
  // production-method axis and external work all depend on these.
  ["order_item_sizes", "color"],
  ["production_routes", "is_default"],
  ["production_route_stages", "position"],
  ["production_route_stages", "method"],
  ["production_operations", "route_position"],
  ["production_operations", "method"],
  ["production_batches", "order_variant_id"],
  ["production_batches", "route_id"],
  ["external_work_orders", "quantity_short"],
  ["material_purchases", "order_variant_id"],
  // Fails loudly if migration 0008 was not applied: splitting one stage across
  // several workers depends on both of these.
  ["production_allocations", "quantity_allocated"],
  ["production_allocations", "transferred_from_id"],
  ["stage_inspections", "worker_id"],
  // Fails loudly if migration 0009 was not applied: exact support-work inheritance,
  // external-work payment detail and material issue detail all depend on these.
  ["support_assignments", "production_allocation_id"],
  ["support_assignments", "order_variant_id"],
  ["support_assignments", "order_item_id"],
  ["support_assignments", "stage"],
  ["external_work_orders", "expected_return_at"],
  ["external_work_orders", "amount_payable"],
  ["external_work_orders", "amount_paid"],
  ["material_usage", "quantity_issued"],
  ["material_usage", "quantity_returned"],
  ["material_usage", "quantity_wasted"],
  ["material_usage", "worker_id"],
];
for (const [table, column] of REQUIRED_COLUMNS) {
  mem.public.none(`select "${column}" from "${table}" limit 1`);
}

global.__PGMEM_REPORT__ = { applied, requiredColumns: REQUIRED_COLUMNS.length };
