#!/usr/bin/env node
// Type-aware compatibility checks (`actors check`), without a running server.
// tests/fixture/compat/v1/cart.ts is the shipped version; v2/cart.ts changes each action in one way.
//
//   node tests/compat.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareAction, readTypes } from "../packages/actors/bin/types.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(repo, "tests/fixture");
const cli = join(repo, "packages/actors/bin/actors.mjs");

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m\n    ${String(err.stack ?? err).split("\n").slice(0, 8).join("\n    ")}`);
  }
}

const read = (v) => {
  const r = readTypes(root, [{ name: "Cart", file: `compat/${v}/cart.ts` }]);
  assert.ok(r.types, r.skipped);
  return r.types.Cart;
};
const v1 = read("v1");
const v2 = read("v2");
const problems = (action) => compareAction(`Cart.${action}()`, v1[action], v2[action]);

console.log("type-aware compatibility");

test("compatible changes pass: optional argument added, argument widened, extra returned field, async, aliases", () => {
  for (const action of ["add", "remove", "list", "tag", "since", "find"]) assert.deepEqual(problems(action), [], action);
});

test("an argument whose type changed is breaking", () => {
  const [p] = problems("setQty");
  assert.match(p, /argument 2 changed from number to string \(number is not string\)/);
});

test("an optional property that became required is breaking", () => {
  assert.match(problems("checkout")[0], /property "coupon" became required/);
});

test("a new required property in an argument is breaking", () => {
  assert.match(problems("ship")[0], /property "zip" is missing/);
});

test("an optional argument that became required is breaking", () => {
  assert.match(problems("limit")[0], /argument 1 became required/);
});

test("a return type that can now be null is breaking", () => {
  assert.match(problems("total")[0], /return type changed from number to null \| number \(null is not number\)/);
});

test("a return type with a new literal is breaking", () => {
  assert.match(problems("status")[0], /"shipped" is not allowed by "open" \| "paid"/);
});

test("types record structure, not names", () => {
  assert.deepEqual(v1.list.returns, { k: "array", of: { k: "object", props: { qty: { t: { k: "number" }, opt: false }, sku: { t: { k: "string" }, opt: false } } } });
});

test("actors check uses types from the lock file and reports every breaking change", () => {
  // A throwaway project inside the fixture (so `actors-poc` resolves): v2 as the source, v1 as the lock.
  const dir = mkdtempSync(join(root, "compat/.tmp-"));
  try {
    mkdirSync(join(dir, "src"));
    cpSync(join(root, "compat/v2/cart.ts"), join(dir, "src/cart.ts"));
    writeFileSync(join(dir, "package.json"), '{ "name": "compat-tmp", "private": true }');
    const lock = { actors: { Cart: { actions: {}, migrations: [] } }, classMigrations: ["actors-v1"] };
    for (const [name, t] of Object.entries(v1)) lock.actors.Cart.actions[name] = { params: t.args.map((_, i) => `a${i}`), ...t };
    writeFileSync(join(dir, "actors.lock.json"), JSON.stringify(lock));
    const r = spawnSync(process.execPath, [cli, "check"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    for (const action of ["setQty", "checkout", "ship", "total", "status", "limit", "gone"]) {
      assert.match(r.stderr, new RegExp(`Cart\\.${action}\\(\\)`), action);
    }
    for (const action of ["add", "remove", "list", "tag", "since", "find"]) {
      assert.doesNotMatch(r.stderr, new RegExp(`Cart\\.${action}\\(\\)`), action);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
