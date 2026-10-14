/**
 * MIGRATION SAFETY for release 0014 (cooperative withdrawals/adjustments,
 * production incidents, dashboard card preferences, and the incident link on
 * payroll_deductions).
 *
 * The same three promises as every hand-run release: ADDITIVE (no DROP, no
 * UPDATE/DELETE/INSERT), REPEATABLE (guarded DDL only), and NO DATA WRITTEN —
 * because the script is pasted into a live client database holding real payroll.
 * The Drizzle migration and the hand-run Supabase upgrade must contain
 * identical DDL, the upgrade owns its transaction, and rollback refuses to
 * erase populated history.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("drizzle/0014_payroll-cooperative-incidents.sql");
const upgrade = read("deploy/upgrade-payroll-cooperative-incidents.sql");
const rollback = read("deploy/rollback-payroll-cooperative-incidents.sql");
const TABLES = ["payroll_cooperative_adjustments", "payroll_cooperative_withdrawals",
  "production_incidents", "user_dashboard_cards"];

function ddl(text: string) {
  return text.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n")
    .replace(/DO\s+\$\$[\s\S]*?END\s+\$\$;/gi, (block) => (block.match(/ALTER TABLE[^;]+;/gi) ?? []).join("\n"))
    .replace(/-->\s*statement-breakpoint/g, "\n")
    .split(";").map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => /^(CREATE TABLE|CREATE (?:UNIQUE )?INDEX|ALTER TABLE)/i.test(part)).sort();
}

test("0014 and the hand-run upgrade contain identical guarded DDL for exactly four new empty tables", () => {
  assert.deepEqual(ddl(upgrade), ddl(migration), "The SQL Editor upgrade must never drift from the checked-in migration");
  const tables = [...migration.matchAll(/CREATE TABLE IF NOT EXISTS "(\w+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(tables, TABLES.slice().sort());
  assert.doesNotMatch(migration.replace(/^\s*--.*$/gm, ""), /\b(DROP|TRUNCATE|\bDELETE\s+FROM|\bUPDATE\s+\w+\s+SET|\bINSERT\s+INTO)\b/i);
  assert.match(migration, /^ALTER TABLE "payroll_deductions" ADD COLUMN IF NOT EXISTS "incident_production_id" integer;/m);
  assert.match(migration, /ADD CONSTRAINT "payroll_deductions_incident_production_id_production_incidents_id_fk"/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "payroll_deduction_incident_production_active_unique"/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "payroll_coop_withdrawal_payment_ref_unique"/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "production_incident_stage_active_unique"/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "production_incident_support_active_unique"/);
  assert.match(upgrade, /^BEGIN;$/m);
  assert.match(upgrade, /^COMMIT;$/m);
  assert.ok(upgrade.indexOf("COMMIT;") > upgrade.indexOf("CREATE TABLE"));
  assert.ok(upgrade.indexOf("-- Read-only verification") > upgrade.indexOf("COMMIT;"));
  assert.doesNotMatch(upgrade, /statement-breakpoint/, "The hand-run script must not contain Drizzle's invalid SQL marker");
  for (const table of TABLES) {
    assert.ok(upgrade.includes(`public.${table}`), `The verification query must mention ${table}`);
    assert.ok(upgrade.includes(`'${table}'`), `Security loop must cover ${table}`);
  }
  assert.match(upgrade, /DO \$payroll_security\$[\s\S]+ENABLE ROW LEVEL SECURITY[\s\S]+REVOKE ALL ON TABLE[\s\S]+REVOKE ALL ON SEQUENCE[\s\S]+END \$payroll_security\$;/,
    "Supabase roles must not access cooperative/incident tables or sequences directly");
  assert.match(upgrade, /FROM anon/);
  assert.match(upgrade, /FROM authenticated/);
  assert.match(upgrade, /FROM PUBLIC/);
  assert.match(upgrade, /c\.relrowsecurity AS rls_enabled/);
  assert.match(upgrade, /'incident_production_id'/);
});

test("0014 is journaled after 0013 and its snapshot chains to the previous schema", () => {
  const journal = JSON.parse(read("drizzle/meta/_journal.json"));
  const tags = journal.entries.map((entry: { tag: string }) => entry.tag);
  assert.equal(tags.at(-1), "0015_worker-bank-account", "0015 (bank account numbers) is the newest migration");
  assert.equal(tags.at(-2), "0014_payroll-cooperative-incidents", "0014 stays journaled in place");
  const before = JSON.parse(read("drizzle/meta/0013_snapshot.json"));
  const after = JSON.parse(read("drizzle/meta/0014_snapshot.json"));
  assert.equal(after.prevId, before.id);
  for (const table of TABLES) assert.ok(after.tables[`public.${table}`], `${table} must be in the 0014 snapshot`);
  const deductions = after.tables["public.payroll_deductions"];
  assert.ok(deductions.columns.incident_production_id);
  assert.ok(deductions.foreignKeys.payroll_deductions_incident_production_id_production_incidents_id_fk);
  assert.ok(deductions.indexes.payroll_deduction_incident_production_active_unique);
});

test("the four tables start empty in pg-mem, and rollback refuses to destroy populated history", async () => {
  const mem = (globalThis as unknown as { __PGMEM__: { public: { many: (sql: string) => Promise<Record<string, unknown>[]> } } }).__PGMEM__;
  for (const table of TABLES) {
    const rows = await mem.public.many(`select count(*) as total from ${table}`);
    assert.equal(Number(rows[0].total), 0, `${table} must NOT be seeded with business or financial records`);
    assert.match(rollback, new RegExp(`'${table}'`));
  }
  assert.match(rollback, /IF rows_present THEN\s+RAISE EXCEPTION/i,
    "Rollback must fail rather than delete any cooperative or incident history");
  assert.match(rollback, /incident_production_id: linked deductions exist/i,
    "Rollback must refuse to drop the incident link while any deduction uses it");
  assert.match(rollback, /^BEGIN;$/m);
  assert.match(rollback, /^COMMIT;$/m);
  assert.doesNotMatch(rollback, /\bCASCADE\b/i, "Rollback must fail on outside dependencies rather than cascade");
});

test("the release documents how to apply the migration safely", () => {
  const instructions = read("deploy/UPDATE-INSTRUCTIONS.md");
  assert.ok(instructions.includes("upgrade-payroll-cooperative-incidents.sql"),
    "The deploy guide must point at the new hand-run upgrade script");
  assert.match(migration, /ADDITIVE/, "The migration states plainly that it is additive");
});
