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
];
for (const [table, column] of REQUIRED_COLUMNS) {
  mem.public.none(`select "${column}" from "${table}" limit 1`);
}

global.__PGMEM_REPORT__ = { applied, requiredColumns: REQUIRED_COLUMNS.length };
