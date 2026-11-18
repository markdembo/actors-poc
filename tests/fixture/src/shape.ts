import { actor, type Migration } from "actors-poc";

// Simulates deploying different code versions against the same stored data.
// tests/e2e.mjs restarts the dev server with `--define FIXTURE_SHAPE:<n>`, so this file
// defines the first n migrations below (n = 3 includes a migration that throws).
declare const FIXTURE_SHAPE: number | undefined;
const shape = typeof FIXTURE_SHAPE === "number" ? FIXTURE_SHAPE : 2;

const migrations: Migration[] = [
  // 1: rename count → total, add currency
  ({ count, ...s }: { count: number }) => ({ ...s, total: count, currency: "USD" }),
  // 2: add tags, and record it in a table of our own (same transaction)
  (s, { sql }) => {
    sql.exec("CREATE TABLE IF NOT EXISTS shape_audit (note TEXT)");
    sql.exec("INSERT INTO shape_audit VALUES ('migration 2')");
    return { ...s, tags: [] };
  },
  // 3: broken: writes to the table, then throws (both must be rolled back)
  (_s, { sql }) => {
    sql.exec("INSERT INTO shape_audit VALUES ('migration 3')");
    throw new Error("migration 3 is broken");
  },
];

const initial = [{ count: 0 }, { total: 0, currency: "USD" }, { total: 0, currency: "USD", tags: [] }][Math.min(shape, 2)];

// biome-ignore lint: the state shape depends on the simulated version.
type Loose = Record<string, any>;

export const Shape = actor({
  state: initial as Loose,
  migrations: migrations.slice(0, shape),
  actions: {
    add: ({ state }, n: number) => {
      if ("count" in state) state.count += n;
      else state.total += n;
      return state;
    },
    get: ({ state }) => state,
    audit: ({ sql }) => {
      const exists = sql.exec("SELECT name FROM sqlite_master WHERE name = 'shape_audit'").toArray().length > 0;
      return exists ? sql.exec("SELECT note FROM shape_audit").toArray().map((r) => r.note) : [];
    },
  },
});
