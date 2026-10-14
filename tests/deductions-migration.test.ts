import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("drizzle/0013_payroll-deductions.sql");
const upgrade = read("deploy/upgrade-payroll-deductions.sql");
const rollback = read("deploy/rollback-payroll-deductions.sql");
const TABLES = ["payroll_attendance", "payroll_deduction_audit", "payroll_deduction_categories",
  "payroll_deductions", "payroll_reversals", "payroll_statement_lines", "payroll_statements"];

function ddl(text: string) {
  return text.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n")
    .replace(/DO\s+\$\$[\s\S]*?END\s+\$\$;/gi, (block) => (block.match(/ALTER TABLE[^;]+;/gi) ?? []).join("\n"))
    .replace(/-->\s*statement-breakpoint/g, "\n")
    .split(";").map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => /^(CREATE TABLE|CREATE (?:UNIQUE )?INDEX|ALTER TABLE)/i.test(part)).sort();
}

test("0013 and hand-run upgrade contain identical guarded DDL for only seven new empty tables", () => {
  assert.deepEqual(ddl(upgrade), ddl(migration), "The SQL Editor upgrade must never drift from the checked-in migration");
  const tables = [...migration.matchAll(/CREATE TABLE IF NOT EXISTS "(\w+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(tables, TABLES.slice().sort());
  assert.doesNotMatch(migration.replace(/^\s*--.*$/gm, ""), /\b(DROP|TRUNCATE|\bDELETE\s+FROM|\bUPDATE\s+\w+\s+SET|\bINSERT\s+INTO)\b/i);
  assert.doesNotMatch(migration, /ALTER TABLE "(?!payroll_)\w+"/);
  assert.match(upgrade, /^BEGIN;$/m);
  assert.match(upgrade, /^COMMIT;$/m);
  assert.ok(upgrade.indexOf("COMMIT;") > upgrade.indexOf("CREATE TABLE"));
  assert.ok(upgrade.indexOf("-- Read-only verification") > upgrade.indexOf("COMMIT;"));
  assert.doesNotMatch(upgrade, /statement-breakpoint/, "The hand-run script must not contain Drizzle's invalid SQL marker");
  for (const table of TABLES) {
    assert.ok(upgrade.includes(`public.${table}`), `The verification query must mention ${table}`);
    assert.ok(upgrade.includes(`'${table}'`), `Security loop must cover ${table}`);
  }
  assert.match(migration, /"incident_support_inspection_id" integer/);
  assert.match(migration, /ADD CONSTRAINT "payroll_deductions_incident_support_inspection_id_support_inspections_id_fk"/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "payroll_deduction_support_incident_active_unique"/);
  assert.match(upgrade, /DO \$payroll_security\$[\s\S]+ENABLE ROW LEVEL SECURITY[\s\S]+REVOKE ALL ON TABLE[\s\S]+REVOKE ALL ON SEQUENCE[\s\S]+END \$payroll_security\$;/,
    "Supabase roles must not access sensitive payroll tables/sequences directly");
  assert.match(upgrade, /FROM anon/);
  assert.match(upgrade, /FROM authenticated/);
  assert.match(upgrade, /FROM PUBLIC/);
  assert.match(upgrade, /c\.relrowsecurity AS rls_enabled/);
  assert.match(upgrade, /'incident_inspection_id', 'incident_support_inspection_id'/);
});

test("new migration is journaled after 0012 and its snapshot chains to the previous schema", () => {
  const journal = JSON.parse(read("drizzle/meta/_journal.json"));
  const entry = journal.entries.find((e: { tag: string }) => e.tag === "0013_payroll-deductions");
  assert.ok(entry, "0013 must stay in the drizzle journal");
  assert.equal(journal.entries[entry.idx + 1]?.tag, "0014_payroll-cooperative-incidents",
    "0014 must be journaled directly after 0013");
  const before = JSON.parse(read("drizzle/meta/0012_snapshot.json"));
  const after = JSON.parse(read("drizzle/meta/0013_snapshot.json"));
  assert.equal(after.prevId, before.id);
  assert.ok(after.tables["public.payroll_statements"]);
  assert.ok(after.tables["public.payroll_statement_lines"]);
  const deductions = after.tables["public.payroll_deductions"];
  assert.ok(deductions);
  assert.ok(deductions.columns.incident_support_inspection_id);
  assert.ok(deductions.foreignKeys.payroll_deductions_incident_support_inspection_id_support_inspections_id_fk);
  assert.ok(deductions.indexes.payroll_deduction_support_incident_active_unique);
});

test("seven tables start empty in pg-mem, and rollback refuses to destroy populated payroll history", async () => {
  const mem = (globalThis as unknown as { __PGMEM__: { public: { many: (sql: string) => Promise<Record<string, unknown>[]> } } }).__PGMEM__;
  for (const table of TABLES) {
    const rows = await mem.public.many(`select count(*) as total from ${table}`);
    assert.equal(Number(rows[0].total), 0, `${table} must NOT be seeded with business or financial records`);
    assert.match(rollback, new RegExp(`'${table}'`));
  }
  assert.match(rollback, /IF rows_present THEN\s+RAISE EXCEPTION/i,
    "Rollback must fail rather than delete any financial history");
  assert.match(rollback, /^BEGIN;$/m);
  assert.match(rollback, /^COMMIT;$/m);
  assert.doesNotMatch(rollback, /\bCASCADE\b/i, "Rollback must fail on outside dependencies rather than cascade");
});
