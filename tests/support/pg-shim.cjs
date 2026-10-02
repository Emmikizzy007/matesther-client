/**
 * Redirects `require("pg")` to pg-mem's Postgres adapter.
 *
 * The application's real data layer (src/db/index.ts) builds a pg Pool from
 * DATABASE_URL. This shim swaps the driver only, so every query in the suite is
 * still executed by the real Drizzle client against the real SQL the app emits.
 * Nothing here re-implements application logic.
 *
 * THREE DRIVER-LEVEL COMPATIBILITY PATCHES (pg-mem gaps, not app behaviour)
 *
 * 1. `types.getTypeParser` — pg-mem's adapter has no `pg.types`. Drizzle 0.45
 *    needs `types.builtins` and a `getTypeParser` fallback for its result
 *    mappers, so the real pg type table is carried over unchanged and only
 *    `getTypeParser` becomes an identity parser. That is correct here because
 *    pg-mem returns already-decoded JavaScript values rather than Postgres
 *    wire-format text.
 *
 * 2. Query config `types` — pg-mem's `adaptQuery` throws "getTypeParser is not
 *    supported" whenever a statement has bound values AND a custom type parser
 *    attached. Drizzle always attaches one, so the wrapper strips that single
 *    key before the statement reaches pg-mem. It changes nothing about the SQL,
 *    the bound values, or how Drizzle builds the query.
 *
 * 3. `rowMode: "array"` — pg-mem rejects it, and Drizzle uses it with its custom
 *    result mapper. The wrapper rebuilds positional rows from each row object's
 *    own key order (see toPositionalRows).
 *
 * CONSEQUENCE TO BE HONEST ABOUT
 *   These patch the DRIVER, not the database engine, and not the application.
 *   The suite verifies Matesther's authorisation and business-rule logic; it
 *   does not reproduce PostgreSQL's wire format, type coercion, transaction
 *   isolation or constraint-enforcement behaviour. A run against a real
 *   PostgreSQL is still worth doing before relying on this suite absolutely.
 */
const realPg = global.__REAL_PG__;
const adapter = global.__PGMEM_ADAPTER__;

/**
 * Drizzle's array row mode reads columns positionally. pg-mem returns plain
 * objects and an empty `fields` array, so the array is rebuilt from the row's
 * own key order, which pg-mem populates in select order. Every column in this
 * schema has a name, so no integer-like key can reorder the object.
 */
function toPositionalRows(result) {
  if (!result || !Array.isArray(result.rows)) return result;
  return {
    ...result,
    rows: result.rows.map((row) =>
      Array.isArray(row) ? row : Object.keys(row).map((key) => row[key])
    ),
  };
}

class MemDriver extends adapter.Pool {
  query(...args) {
    const config = args[0];
    let arrayMode = false;
    if (
      config &&
      typeof config === "object" &&
      !Array.isArray(config) &&
      ("types" in config || "rowMode" in config)
    ) {
      const { types, rowMode, ...rest } = config;
      arrayMode = rowMode === "array";
      args[0] = rest;
    }
    if (!arrayMode) return super.query(...args);

    const callbackAt = args.findIndex((arg, index) => index > 0 && typeof arg === "function");
    if (callbackAt !== -1) {
      const original = args[callbackAt];
      args[callbackAt] = (error, result) =>
        original(error, error ? result : toPositionalRows(result));
      return super.query(...args);
    }
    return Promise.resolve(super.query(...args)).then(toPositionalRows);
  }
}

module.exports = {
  ...realPg,
  Pool: MemDriver,
  Client: MemDriver,
  types: {
    ...realPg.types,
    getTypeParser: () => (value) => value,
  },
};
