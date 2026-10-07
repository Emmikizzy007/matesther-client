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
      /*
       * Transaction control belongs in the hand-run deploy script and nowhere else.
       * A person pastes that file into a SQL editor, so if it does not open and close
       * its own transaction the editor decides whether the upgrade is atomic - and that
       * ambiguity is what let the atomicity probe roll the whole upgrade back once.
       * The drizzle migration must NOT carry it, because drizzle-kit owns the
       * transaction when it applies a migration; asserted separately below.
       */
      const transactionControlAllowed = file === release.upgrade;
      for (const statement of executableStatements(file)) {
        // A CREATE TABLE spans many lines, so the test is on how the statement BEGINS
        // and, for the two one-line ALTER forms, on what it contains. Nothing else is
        // DDL that an additive script has any business running.
        const allowed =
          /^CREATE TABLE IF NOT EXISTS\s+(?:"?\w+"?\.)?"?\w+"?\s*\(/i.test(statement) ||
          /^CREATE INDEX IF NOT EXISTS\b/i.test(statement) ||
          /^ALTER TABLE\b[\s\S]*\bADD COLUMN IF NOT EXISTS\b/i.test(statement) ||
          /^ALTER TABLE\b[\s\S]*\bADD CONSTRAINT\b/i.test(statement) ||
          /^SELECT\b/i.test(statement) ||
          (transactionControlAllowed && /^(BEGIN|COMMIT)$/i.test(statement));
        assert.ok(
          allowed,
          `${file} contains a statement that is neither guarded DDL, transaction control ` +
            `nor a read-only verification query:\n${statement}`
        );
      }
    }
  });

  test(`${release.name}: neither file contains a statement designed to fail`, () => {
    /*
     * A migration is applied by hand against a live database holding real orders and
     * real payroll. Nothing in it may abort on purpose. The atomicity probe used to
     * live at the end of the cleanup deploy script and did exactly that: pasted as one
     * submission with no COMMIT before it, its `RAISE EXCEPTION` aborted the single
     * implicit transaction the whole upgrade was running in and rolled the upgrade back.
     * The probe now lives in deploy/verify-atomicity-probe.sql, tested below.
     */
    for (const file of [release.migration, release.upgrade]) {
      const statements = executableStatements(file).join("\n;\n");
      assert.ok(
        !/\bRAISE\s+EXCEPTION\b/i.test(statements),
        `${file} contains RAISE EXCEPTION. A migration must never fail on purpose - ` +
          `move the test into deploy/verify-atomicity-probe.sql`
      );
      assert.ok(
        !/\bRAISE\b/i.test(read(file).replace(/^\s*--.*$/gm, "")),
        `${file} contains a RAISE outside its comments`
      );
    }
  });

  test(`${release.name}: the deploy script owns its transaction, the migration does not`, () => {
    const upgrade = read(release.upgrade);
    const migration = read(release.migration);

    // Exactly one BEGIN and one COMMIT, so the DDL is a single atomic unit.
    assert.equal(
      (upgrade.match(/^\s*BEGIN\s*;\s*$/gim) ?? []).length, 1,
      `${release.upgrade} must open exactly one explicit transaction`
    );
    assert.equal(
      (upgrade.match(/^\s*COMMIT\s*;\s*$/gim) ?? []).length, 1,
      `${release.upgrade} must close exactly one explicit transaction`
    );
    assert.ok(
      upgrade.indexOf("BEGIN;") < upgrade.indexOf("COMMIT;"),
      `${release.upgrade} closes its transaction before opening it`
    );

    /*
     * Every schema-changing statement must sit INSIDE the transaction, and every
     * verification query must sit AFTER the COMMIT. Verification before the commit
     * reads objects that are not yet durable in an editor that batches statements,
     * which is how a correct upgrade came to look like a failed one.
     */
    const beginAt = upgrade.search(/^\s*BEGIN\s*;\s*$/im);
    const commitAt = upgrade.search(/^\s*COMMIT\s*;\s*$/im);
    const ddl = [...upgrade.matchAll(/^\s*(CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS|ALTER TABLE|DO \$\$)/gim)];
    assert.ok(ddl.length >= 5, `${release.upgrade} has unexpectedly little DDL to bound`);
    for (const match of ddl) {
      const at = match.index ?? 0;
      assert.ok(
        at > beginAt && at < commitAt,
        `${release.upgrade} has DDL outside its transaction at offset ${at}: ${match[0].trim()}`
      );
    }
    const firstSelect = upgrade.search(/^\s*SELECT\b/im);
    assert.ok(firstSelect > commitAt,
      `${release.upgrade} runs a verification query before its COMMIT`);

    // And the migration leaves the transaction to drizzle-kit.
    assert.ok(
      !/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*;\s*$/im.test(migration),
      `${release.migration} contains transaction control, which drizzle-kit owns`
    );
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

/**
 * The atomicity probe lives in its own file, and these tests are why it stays there.
 *
 * pg-mem cannot prove a transaction rolls back - it does not roll back - so the suite
 * cannot test the atomicity of order removal or of the cleanup. The probe is the
 * substitute: run once against the real PostgreSQL, it inserts a row inside a
 * transaction it then undoes and asks whether the row survived.
 *
 * The probe was originally the last section of deploy/upgrade-test-data-cleanup.sql, and
 * that placement was a live defect. It aborts on purpose; the migration must not abort;
 * pasted as one submission with no COMMIT before it, the probe's `RAISE EXCEPTION`
 * aborted the single implicit transaction the whole upgrade was running in and rolled
 * the upgrade back with it. A production run had to be inspected by hand to establish
 * that no objects had been created. So the invariant now pinned here is not merely
 * "a probe exists" but "a probe exists AND it is not in a migration".
 */
const PROBE_FILE = "deploy/verify-atomicity-probe.sql";

test("the atomicity probe exists, separately, and the migration points at it", () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, PROBE_FILE)), `${PROBE_FILE} is missing`);
  const probe = read(PROBE_FILE);

  // It has to say what it is, or the next person pastes it into a migration run.
  assert.match(probe, /NOT A MIGRATION/i,
    `${PROBE_FILE} does not state plainly that it is not a migration`);
  assert.match(probe, /OPTIONAL/i,
    `${PROBE_FILE} does not say that running it is optional`);

  // And the migration has to point at it, or the probe is orphaned and quietly stops
  // being run - which is how it was lost once before, when the deploy script was
  // regenerated from the drizzle migration.
  for (const file of ["deploy/upgrade-test-data-cleanup.sql", "drizzle/0012_deletion_and_purge_audit.sql"])
    assert.ok(read(file).includes("verify-atomicity-probe.sql"),
      `${file} no longer points at the probe file, so the probe can be lost again`);
});

test("the probe undoes its own insert and can never commit it", () => {
  const probe = read(PROBE_FILE);

  // It must insert into the real audit table: that is the table the cleanup writes to,
  // so it is the honest thing to test against.
  assert.match(probe, /INSERT INTO\s+(public\.)?"?order_deletions"?/i,
    "the probe no longer inserts into the audit table it is testing");
  // A rolled-back insert is only identifiable if it is labelled, so a person who does
  // find one knows what it is rather than wondering who deleted order zero.
  assert.match(probe, /PROBE-/,
    "the probe's row is no longer labelled, so a surviving row could not be identified");
  // It must report a figure a human can read in the SQL Editor output.
  assert.match(probe, /rolled_back_insert/i,
    "the probe no longer reports rolled_back_insert");
  assert.match(probe, /\bverdict\b/i,
    "the probe no longer reports a readable verdict");

  /*
   * The primary probe must be an explicit ROLLBACK, which is the mechanism the
   * application actually relies on - Drizzle opens a transaction and issues ROLLBACK on
   * failure. And there must be no COMMIT anywhere in this file: a commit would make the
   * probe's row permanent, turning a test into data.
   */
  assert.match(probe, /^\s*ROLLBACK\s*;\s*$/im,
    "the probe no longer rolls its insert back explicitly");
  assert.ok(!/^\s*COMMIT\s*;\s*$/im.test(probe),
    `${PROBE_FILE} contains a COMMIT, which would make the probe's row permanent`);
  const insertAt = probe.search(/INSERT INTO\s+(public\.)?"?order_deletions"?/i);
  const rollbackAt = probe.search(/^\s*ROLLBACK\s*;\s*$/im);
  assert.ok(insertAt > -1 && rollbackAt > insertAt,
    "the probe's ROLLBACK does not follow its INSERT, so nothing is being undone");
});

test("the probe changes no schema and halts no editor", () => {
  const probe = read(PROBE_FILE);

  // It is a test. It must not create, alter or drop anything, or it becomes a second,
  // undocumented migration hiding in a file nobody reviews as one.
  assert.ok(
    !/^\s*(CREATE|ALTER|DROP|TRUNCATE|RENAME)\b/im.test(probe),
    `${PROBE_FILE} contains DDL - a probe must not change the schema`
  );
  // Nor may it write to any table other than the one it undoes.
  assert.ok(
    !/INSERT INTO\s+(?!(public\.)?"?order_deletions)/i.test(probe),
    `${PROBE_FILE} inserts into something other than the audit table`
  );

  /*
   * The deliberate abort must be caught. An uncaught `RAISE EXCEPTION` halts a SQL
   * editor at that statement, which is precisely the behaviour that made the original
   * probe unreadable: the person deploying saw an error and no verdict. Caught, the
   * block finishes and reports its result as a row.
   */
  const blockStart = probe.lastIndexOf("DO $$");
  assert.ok(blockStart > -1, `${PROBE_FILE} no longer tests the error path in a DO block`);
  const block = probe.slice(blockStart);
  const abortAt = block.search(/RAISE EXCEPTION[^\n]*deliberate abort/i);
  const handlerAt = block.search(/EXCEPTION\s+WHEN\s+OTHERS\s+THEN/i);
  assert.ok(abortAt > -1, "the probe no longer raises deliberately, so it proves nothing");
  assert.ok(handlerAt > abortAt,
    "the probe's deliberate abort is not followed by an EXCEPTION handler, so it would halt the editor");

  // A real rollback failure must still be loud rather than silently passing.
  assert.match(probe, /ATOMICITY FAILURE/i,
    "the probe no longer raises on a genuine rollback failure, so it could pass silently");
});

test("both new releases document index counts that include the primary key", () => {
  /*
   * `pg_indexes` lists the index PostgreSQL creates for a PRIMARY KEY as well as the
   * ones a script creates explicitly. Both new tables declare `"id" serial PRIMARY KEY`,
   * so the honest figures are 5 and 5 for the cleanup tables and 4 for
   * support_status_events. Both files originally documented one fewer than the truth in
   * each case, which would have made a correct upgrade look like a broken one to the
   * person comparing the numbers - the exact confusion this release is cleaning up.
   */
  const cleanup = read("deploy/upgrade-test-data-cleanup.sql");
  assert.match(cleanup, /deletions_indexes\s*=\s*5/, "the cleanup script does not expect 5 order_deletions indexes");
  assert.match(cleanup, /purges_indexes\s*=\s*5/, "the cleanup script does not expect 5 test_data_purges indexes");
  assert.match(cleanup, /deletions_columns\s*=\s*14/, "the cleanup script does not expect 14 order_deletions columns");
  assert.match(cleanup, /purges_columns\s*=\s*15/, "the cleanup script does not expect 15 test_data_purges columns");
  assert.match(read("drizzle/0012_deletion_and_purge_audit.sql"), /5 indexes each/,
    "drizzle/0012 does not document 5 indexes each");
  assert.match(read("deploy/upgrade-support-lifecycle.sql"), /support_event_indexes\s*=\s*4/,
    "the lifecycle script does not expect 4 support_status_events indexes");
});


test("each deploy script and its drizzle migration describe exactly the same objects", () => {
  /*
   * The two files are applied by different tools - drizzle-kit for the migration, a
   * person in a SQL editor for the deploy script - so nothing but this test stops them
   * drifting apart. They have drifted before: the cleanup deploy script was once
   * regenerated from the migration and silently lost three of its five sections.
   *
   * Normalisation, and why each step is needed:
   *   comments removed first    the prose legitimately contains DROP and DELETE
   *   DO $$ ... END $$; unwrapped to the ALTER TABLE statements inside it
   *                             a naive split on ';' truncates the block at its FIRST
   *                             inner semicolon and quietly drops three of the four
   *                             foreign keys from the comparison. That mistake was made
   *                             once while writing this test and produced a confident
   *                             "identical" verdict over a comparison that had never
   *                             looked at most of the constraints.
   *   statement-breakpoint      drizzle-kit's own separator, absent from deploy scripts
   *   "public". removed         the deploy script schema-qualifies, the migration does not
   *   whitespace collapsed      formatting must not be able to masquerade as a difference
   */
  const normalise = (file: string) =>
    read(file)
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .replace(/DO\s+\$\$[\s\S]*?END\s+\$\$;/gi, (block) =>
        (block.match(/ALTER TABLE[^;]+;/gi) ?? []).join("\n"))
      .replace(/-->\s*statement-breakpoint/g, "\n")
      .split(";")
      .map((statement) => statement.replace(/"public"\./g, "").replace(/\s+/g, " ").trim())
      .filter((statement) => statement.length > 0)
      .filter((statement) => /^(CREATE TABLE|CREATE INDEX|ALTER TABLE)/i.test(statement))
      .sort();

  for (const release of RELEASES) {
    const migration = normalise(release.migration);
    const upgrade = normalise(release.upgrade);

    // Every statement, character for character, both directions.
    assert.deepEqual(
      upgrade,
      migration,
      `${release.upgrade} and ${release.migration} do not contain the same DDL`
    );

    // And the object inventory, so a difference reports as "which object" rather than
    // as a wall of SQL. Foreign-key TARGETS and ON DELETE behaviour are compared too:
    // a key pointing at the wrong table, or cascading where it should set null, is the
    // kind of drift that looks identical in a statement count.
    const joined = migration.join("\n");
    const pick = (pattern: RegExp) => [...joined.matchAll(pattern)].map((match) => match[1]).sort();
    const inventory = {
      tables: pick(/CREATE TABLE IF NOT EXISTS "?(\w+)"?/gi),
      indexes: pick(/CREATE INDEX IF NOT EXISTS "?(\w+)"?/gi),
      columns: pick(/ADD COLUMN IF NOT EXISTS "?(\w+)"?/gi),
      constraints: pick(/ADD CONSTRAINT "?(\w+)"?/gi),
      fkTargets: pick(/REFERENCES "?(\w+)"?\s*\(/gi),
      onDelete: pick(/ON DELETE (\w+(?: \w+)?)/gi).map((verb) => verb.toLowerCase()),
    };

    // Guards against the comparison quietly degenerating into nothing, which is exactly
    // how the truncated-DO-block version passed while checking a third of the schema.
    assert.ok(inventory.tables.length >= 1, `${release.name}: no tables were compared`);
    assert.ok(inventory.indexes.length >= 4, `${release.name}: too few indexes were compared`);
    if (release.name.startsWith("0012")) {
      assert.equal(inventory.constraints.length, 4,
        "the cleanup release has 4 foreign keys; if this is fewer, the DO block was truncated again");
      assert.deepEqual(inventory.onDelete, ["no action", "no action", "set null", "set null"],
        "the actor references must be SET NULL and the organisation references NO ACTION");
    }
  }
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
   * Statements that pg-mem cannot run, or must not run here, and which are therefore
   * skipped. For the first two this is a limit of the emulator, not a defect in the
   * scripts:
   *
   *   CREATE TABLE IF NOT EXISTS  pg-mem honours the guard for indexes but not for a
   *                               table that already exists; it errors instead of
   *                               skipping. Proven separately on a fresh database below.
   *   pg_indexes / pg_constraint / pg_tables / ::regclass / pg_class
   *                               not emulated. These appear only inside the read-only
   *                               verification queries.
   *
   * The next two are skipped on purpose:
   *
   *   BEGIN / COMMIT              the deploy scripts open one explicit transaction so a
   *                               person pasting them gets atomic behaviour. This test
   *                               runs a FILTERED SUBSET of each script's statements, so
   *                               it would open a transaction it could not close in the
   *                               right place and leave pg-mem in that state for every
   *                               later test. Transaction ownership is asserted
   *                               textually above instead, which is the honest way to
   *                               test a property pg-mem does not implement anyway.
   *   SELECT                      the verification queries are for the operator to read
   *                               in the SQL Editor after the upgrade. They are not part
   *                               of the schema change, they return rows (and `none`
   *                               accepts none), and several read catalogues pg-mem has
   *                               no equivalent of. Their content is asserted above.
   *
   * Everything else - the guarded ALTERs and the guarded index creation - is executed,
   * twice.
   */
  const unrunnable = /^CREATE TABLE IF NOT EXISTS/i;
  const notEmulated = /\b(pg_indexes|pg_constraint|pg_tables|pg_class|pg_namespace)\b|::regclass|pg_get_constraintdef/i;
  const operatorOnly = /^(SELECT|BEGIN|COMMIT)$/i;

  // Applied TWICE. The first pass proves the objects are there against a database that
  // migration already built; the second is the actual claim on the tin - "safe to run
  // more than once" - exercised rather than asserted.
  let applied = 0;
  for (const _pass of [1, 2]) {
    for (const release of RELEASES) {
      for (const statement of executableStatements(release.upgrade)) {
        if (unrunnable.test(statement) || notEmulated.test(statement)) continue;
        if (operatorOnly.test(statement) || /^SELECT\b/i.test(statement)) continue;
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
