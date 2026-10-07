/**
 * MIGRATION SAFETY: the two migrations this release adds must be additive, must write
 * no data, and must be re-runnable - because they are applied by hand, in a SQL editor,
 * against a live database that already holds real orders and real payroll.
 *
 * WHY THIS FILE EXISTS
 *   `deploy/UPDATE-INSTRUCTIONS.md` tells whoever is deploying to paste a file into the
 *   client Supabase project and run it, and every one of those files promises the same
 *   three things: additive, repeatable, no data written. Until now nothing in the
 *   repository CHECKED that promise for a new script - it was a claim in a comment, and
 *   a comment cannot fail a build. The two scripts added by this release are the first to
 *   be held to it mechanically, so the next person has a pattern to copy rather than a
 *   convention to trust.
 *
 * WHAT IT CANNOT PROVE, STATED PLAINLY
 *   These tests run against pg-mem, not PostgreSQL, and pg-mem emulates a subset:
 *
 *     * it has no `pg_indexes`, no `pg_tables` and no `pg_constraint`, so index counts
 *       and foreign-key counts cannot be asserted here. `information_schema.tables` IS
 *       emulated, so table presence can be.
 *     * it does not honour `CREATE TABLE IF NOT EXISTS` for a table that already exists
 *       (it fails with an unread-AST error rather than skipping), so that particular
 *       guard cannot be exercised against the migrated database. It is instead proven
 *       against a genuinely fresh in-memory database in the last test below, where
 *       `IF NOT EXISTS` is the thing under test rather than an obstacle.
 *     * it has no plpgsql interpreter, so a `DO $$ ... $$` guard block cannot be executed.
 *       The ALTER TABLE statements inside one are run directly, which is exactly the
 *       documented deviation tests/support/preload.cjs already relies on.
 *
 *   Real transactional atomicity is likewise not demonstrable in pg-mem, which does not
 *   roll back - see the note at the top of tests/test-data-cleanup.test.ts. Nothing here
 *   claims otherwise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { newDb } from "pg-mem";
import { api, createOrder, createOwner, expectStatus } from "./support/harness";

const REPO_ROOT = path.resolve(__dirname, "..");
const read = (relative: string) => fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");

/** The two migrations this release adds, and the hand-run script for each. */
const RELEASES = [
  {
    name: "0011 support lifecycle",
    migration: "drizzle/0011_support_lifecycle.sql",
    upgrade: "deploy/upgrade-support-lifecycle.sql",
    tables: ["support_status_events"],
  },
  {
    name: "0012 deletion and purge audit",
    migration: "drizzle/0012_deletion_and_purge_audit.sql",
    upgrade: "deploy/upgrade-test-data-cleanup.sql",
    tables: ["order_deletions", "test_data_purges"],
  },
];

/**
 * The executable content of a SQL file: comment lines removed, guard blocks unwrapped.
 *
 * Comment lines are removed FIRST, because these scripts explain themselves at length
 * and the prose legitimately contains the words DROP and DELETE - "There is no DROP, no
 * TRUNCATE" would otherwise fail a test whose whole purpose is to prove there is none.
 */
function executableStatements(file: string): string[] {
  const body = read(file)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  // Pull the ALTER TABLE statements out of every DO $$ ... END $$; guard block and drop
  // the block itself, which pg-mem cannot interpret.
  const unwrapped = body.replace(/DO\s+\$\$[\s\S]*?END\s+\$\$;/gi, (block) =>
    (block.match(/ALTER TABLE[^;]+;/gi) ?? []).join("\n")
  );

  /*
   * `--> statement-breakpoint` is drizzle-kit's own separator between statements inside
   * drizzle/*.sql, so it belongs there and is removed before chunking. It must NOT appear
   * in a deploy script, where there is no drizzle to read it and `-->` begins a real
   * PostgreSQL operator - that is asserted separately, per file, below.
   */
  const separated = unwrapped.replace(/-->\s*statement-breakpoint/g, "\n");

  return separated
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Everything the scripts assert about themselves, checked instead of trusted. */
const FORBIDDEN = [
  { label: "DROP", pattern: /\bDROP\b/i },
  { label: "TRUNCATE", pattern: /\bTRUNCATE\b/i },
  { label: "RENAME", pattern: /\bRENAME\b/i },
  // `ON DELETE cascade` inside a foreign key is legitimate and must survive; what is
  // forbidden is a DELETE used as a statement, which can only appear at a statement
  // start. Both new scripts are DDL, so neither has any reason to contain one.
  { label: "DELETE statement", pattern: /(?:^|;)\s*DELETE\b/i },
  { label: "UPDATE statement", pattern: /(?:^|;)\s*UPDATE\b/i },
  { label: "INSERT statement", pattern: /(?:^|;)\s*INSERT\b/i },
];

for (const release of RELEASES) {
  test(`${release.name}: both SQL files forbid every destructive verb`, () => {
    for (const file of [release.migration, release.upgrade]) {
      const statements = executableStatements(file);
      assert.ok(statements.length > 0, `${file} produced no executable statements`);
      const joined = statements.join("\n;\n");
      for (const { label, pattern } of FORBIDDEN) {
        assert.ok(
          !pattern.test(joined),
          `${file} contains ${label}, which an additive hand-run script must never do:\n` +
            joined.split("\n").filter((line) => pattern.test(line)).join("\n")
        );
      }
    }
  });

  test(`${release.name}: every statement is a guarded DDL form`, () => {
    for (const file of [release.migration, release.upgrade]) {
      for (const statement of executableStatements(file)) {
        // A CREATE TABLE spans many lines, so the test is on how the statement BEGINS
        // and, for the two one-line ALTER forms, on what it contains. Nothing else is
        // DDL that an additive script has any business running.
        const allowed =
          /^CREATE TABLE IF NOT EXISTS\s+(?:"?\w+"?\.)?"?\w+"?\s*\(/i.test(statement) ||
          /^CREATE INDEX IF NOT EXISTS\b/i.test(statement) ||
          /^ALTER TABLE\b[\s\S]*\bADD COLUMN IF NOT EXISTS\b/i.test(statement) ||
          /^ALTER TABLE\b[\s\S]*\bADD CONSTRAINT\b/i.test(statement) ||
          /^SELECT\b/i.test(statement);
        assert.ok(
          allowed,
          `${file} contains a statement that is neither guarded DDL nor a read-only verification query:\n${statement}`
        );
      }
    }
  });

  test(`${release.name}: the upgrade script carries a runnable verification query`, () => {
    // The house rule in deploy/UPDATE-INSTRUCTIONS.md is "run the verification query at
    // the bottom of that file and compare the counts". A script with no such query sends
    // the person deploying it looking for one that does not exist.
    const statements = executableStatements(release.upgrade);
    const verification = statements.filter((statement) => /^SELECT/i.test(statement));
    assert.ok(
      verification.length >= 1,
      `${release.upgrade} has no runnable verification SELECT - the deploy steps depend on one`
    );
    // And it must actually ask about the tables this release creates, or it verifies
    // something else entirely.
    const asked = verification.join("\n").toLowerCase();
    for (const table of release.tables)
      assert.ok(asked.includes(table), `${release.upgrade}'s verification query never mentions ${table}`);
  });

  test(`${release.name}: no drizzle statement-breakpoint marker leaked into the deploy script`, () => {
    // `--> statement-breakpoint` is drizzle-kit's own separator. Pasted into the SQL
    // Editor it is not a comment - `-->` is the PostgreSQL operator syntax beginning - so
    // it is a hard syntax error that stops the upgrade half-applied.
    assert.ok(
      !read(release.upgrade).includes("statement-breakpoint"),
      `${release.upgrade} still contains drizzle statement-breakpoint markers`
    );
  });
}

test("the cleanup deploy script still carries its atomicity probe", () => {
  /*
   * pg-mem cannot prove a transaction rolls back - it does not roll back - so the suite
   * cannot test the atomicity of order removal or of the cleanup. The probe in section 4
   * of the deploy script is the substitute: run once against the real PostgreSQL, it
   * inserts a row inside a transaction it then aborts and asks whether the row survived.
   *
   * This file lost that probe once, when the script was regenerated from the drizzle
   * migration (which correctly contains no probe, because a migration is not the place for
   * one). Nothing caught it. So its presence is asserted here: it must insert, it must
   * abort deliberately, and it must ask for the surviving count under a name a human can
   * read in the SQL Editor output.
   */
  const script = read("deploy/upgrade-test-data-cleanup.sql");
  const probe = script.slice(script.indexOf("ATOMICITY PROBE"));
  assert.ok(probe.length > 0, "the ATOMICITY PROBE section is gone from the deploy script");
  assert.match(probe, /INSERT INTO\s+(public\.)?"?order_deletions"?/i,
    "the probe no longer inserts into the audit table it is testing");
  assert.match(probe, /RAISE EXCEPTION/i,
    "the probe no longer aborts its own transaction, so it would prove nothing");
  assert.match(probe, /rolled_back_insert/i,
    "the probe no longer reports rolled_back_insert, the figure the deploy steps check");
  // And the row it inserts must be recognisable as the probe's, so a human who finds it
  // in the table knows what it is rather than wondering who deleted order zero.
  assert.match(probe, /PROBE-ROLLED-BACK/,
    "the probe's row is no longer labelled, so a surviving row could not be identified");
});

test("both new migrations are registered, in order, with a snapshot each", () => {
  const journal = JSON.parse(read("drizzle/meta/_journal.json")) as {
    entries: { idx: number; tag: string }[];
  };
  const tags = journal.entries.map((entry) => entry.tag);
  for (const release of RELEASES) {
    const tag = path.basename(release.migration, ".sql");
    assert.ok(tags.includes(tag), `${tag} is missing from drizzle/meta/_journal.json`);
    const snapshot = path.join("drizzle/meta", `${tag.split("_")[0]}_snapshot.json`);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, snapshot)), `${snapshot} does not exist for ${tag}`);
  }
  // Ordering matters: each snapshot's prevId chains to the one before it, and a file
  // applied out of order would build a table whose foreign key target is not there yet.
  assert.deepEqual(tags.slice(-2), ["0011_support_lifecycle", "0012_deletion_and_purge_audit"]);
  assert.deepEqual(
    journal.entries.map((entry) => entry.idx),
    journal.entries.map((_entry, index) => index),
    "journal idx values must be contiguous from 0"
  );
});

test("the new tables exist, are empty, and existing rows survive re-applying both scripts", async () => {
  // A real order, created through the real API, standing in for the client's live data.
  // If either script touched anything it should not, this is what disappears.
  const owner = await createOwner();
  const order = await createOrder(owner.cookie, { quantity: 20, unitPrice: 4500 });
  const before = await api("GET", `/api/orders/${order.orderId}`, { cookie: owner.cookie });
  await expectStatus(before, 200, "Order exists before the scripts are applied");

  const mem = (globalThis as unknown as { __PGMEM__: { public: { none: (sql: string) => Promise<unknown>; many: (sql: string) => Promise<Record<string, unknown>[]> } } }).__PGMEM__;

  const tablesBefore = await mem.public.many(
    `select table_name from information_schema.tables where table_schema = 'public'`
  );

  /*
   * Statements that pg-mem cannot run, and which are therefore not run here. This is a
   * limit of the emulator, not a defect in the scripts - all four forms are ordinary
   * PostgreSQL and are what the verification step at the bottom of each deploy script is
   * for:
   *
   *   CREATE TABLE IF NOT EXISTS  pg-mem honours the guard for indexes but not for a
   *                               table that already exists; it errors instead of
   *                               skipping. Proven separately on a fresh database below.
   *   pg_indexes / pg_constraint / pg_tables / ::regclass
   *                               not emulated at all. These appear only inside the
   *                               read-only verification SELECT, which a person runs in
   *                               the SQL Editor after the upgrade, not as part of it.
   *
   * Everything else - the guarded ALTERs, the guarded index creation and the DDL that
   * migration already applied - is executed, twice.
   */
  const unrunnable = /^CREATE TABLE IF NOT EXISTS/i;
  const notEmulated = /\b(pg_indexes|pg_constraint|pg_tables)\b|::regclass/i;

  // Applied TWICE. The first pass proves the objects are there against a database that
  // migration already built; the second is the actual claim on the tin - "safe to run
  // more than once" - exercised rather than asserted.
  let applied = 0;
  for (const _pass of [1, 2]) {
    for (const release of RELEASES) {
      for (const statement of executableStatements(release.upgrade)) {
        if (unrunnable.test(statement) || notEmulated.test(statement)) continue;
        await mem.public.none(statement);
        applied += 1;
      }
    }
  }
  // If this ever reaches zero the test has quietly stopped testing anything.
  assert.ok(applied >= 10, `only ${applied} statements were actually executed - the filter is too wide`);

  const tablesAfter = await mem.public.many(
    `select table_name from information_schema.tables where table_schema = 'public'`
  );
  assert.deepEqual(
    tablesAfter.map((row) => row.table_name).sort(),
    tablesBefore.map((row) => row.table_name).sort(),
    "re-applying both upgrade scripts must not create or remove a single table"
  );

  // The new tables were created empty by the migration and are STILL empty: nothing in
  // either script writes a row, so there is nothing to have backfilled.
  for (const table of ["support_status_events", "order_deletions", "test_data_purges"]) {
    const [row] = await mem.public.many(`select count(*) as total from ${table}`);
    assert.equal(Number(row.total), 0, `${table} was written to by an upgrade script`);
  }

  // And the live order is untouched, still readable through the API it was made with.
  const after = await api("GET", `/api/orders/${order.orderId}`, { cookie: owner.cookie });
  await expectStatus(after, 200, "Order still exists after both scripts ran twice");
  assert.equal(after.data.id, before.data.id);
  assert.equal(after.data.totalAmount, before.data.totalAmount);
  assert.equal(after.data.orderNumber, before.data.orderNumber);
});

test("the lifecycle columns exist, are nullable, and nothing was backfilled into them", async () => {
  const mem = (globalThis as unknown as { __PGMEM__: { public: { many: (sql: string) => Promise<Record<string, unknown>[]> } } }).__PGMEM__;
  // Selecting each column proves it exists; a missing one is an error, not an empty set.
  await mem.public.many(
    `select started_at, paused_at, pause_reason, submitted_by_name from support_assignments limit 1`
  );
  // 0011 deliberately does not invent a start time for work recorded before it existed:
  // a fabricated timestamp would sit behind a payroll figure. There are no support
  // assignments in this database yet, so what is asserted is that the script wrote none.
  const [row] = await mem.public.many(
    `select count(*) as total from support_assignments where started_at is not null or paused_at is not null`
  );
  assert.equal(Number(row.total), 0, "a lifecycle timestamp appeared without a lifecycle event");
});

test("CREATE TABLE IF NOT EXISTS is a genuine no-op on the second run", async () => {
  // Proven on a FRESH database, because that is the only place pg-mem can run the guarded
  // form at all: against the migrated one it errors instead of skipping. A fresh database
  // is also the honest case for this assertion - it is what "repeatable" means for a
  // statement whose entire job is to be skipped when the table is already there.
  const fresh = newDb();
  // The plainest table pg-mem can parse: it rejects inline column constraints outright,
  // which is a limit of the emulator and not a property of the guard being tested. The
  // guard is what is under test here - that a second run is skipped, not repeated.
  const ddl = `CREATE TABLE IF NOT EXISTS "probe_guard" ("id" serial)`;
  await fresh.public.none(ddl);
  await fresh.public.none(ddl);
  await fresh.public.none(ddl);
  const [row] = await fresh.public.many(`select count(*) as total from probe_guard`);
  assert.equal(Number(row.total), 0, "the guard created a second table, or wrote a row");
  // And it really is one table, not two silently stacked under the same name.
  const [tables] = await fresh.public.many(
    `select count(*) as total from information_schema.tables where table_schema = 'public' and table_name = 'probe_guard'`
  );
  assert.equal(Number(tables.total), 1);
});
