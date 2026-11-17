#!/usr/bin/env node
// End-to-end tests against the real local Workers runtime (wrangler dev / workerd).
// Covers the P0 acceptance criteria: persistence across restart, rollback, serialized
// concurrency, typed errors, scheduling, validation, dev tooling and production builds.
//
//   node tests/e2e.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(repo, "tests/fixture");
const cli = join(repo, "packages/actors/bin/actors.mjs");
const wrangler = join(repo, "node_modules/.bin/wrangler");
const PORT = 8799;
const base = `http://localhost:${PORT}`;
const persist = mkdtempSync(join(tmpdir(), "actors-e2e-"));

let server;
let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m\n    ${String(err.stack ?? err).split("\n").slice(0, 6).join("\n    ")}`);
  }
}

function start(cmd, args) {
  const proc = spawn(cmd, args, { cwd: fixture, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  proc.log = () => log;
  return proc;
}

async function waitReady(proc) {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(base);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`server did not start:\n${proc.log()}`);
}

async function stop(proc) {
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((r) => proc.once("exit", r));
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {}
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {}
  await new Promise((r) => setTimeout(r, 300));
}

const call = async (key, method, args = [], query = "") =>
  (await fetch(`${base}/call/${encodeURIComponent(key)}/${method}${query}`, { method: "POST", body: JSON.stringify(args) })).json();
const api = async (path, init) => (await fetch(`${base}/__actors/api${path}`, init)).json();
const localObjects = async () => {
  const le = `${base}/cdn-cgi/local/explorer/api/workers/durable_objects/namespaces`;
  const ns = (await (await fetch(le)).json()).result.find((n) => n.class === "ActorHost").id;
  return (await (await fetch(`${le}/${ns}/objects`)).json()).result.map((o) => o.name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = Date.now().toString(36); // unique keys per run

async function main() {
  console.log("actors generate");
  const gen = spawnSync(process.execPath, [cli, "generate"], { cwd: fixture, encoding: "utf8" });
  assert.equal(gen.status, 0, gen.stderr);

  console.log("actors dev (dev entry)");
  server = start(process.execPath, [cli, "dev", "--port", String(PORT), "--persist-to", persist]);
  await waitReady(server);
  const k = `k-${run}`;

  await test("FR3: new instance gets initial state from factory + onCreate, mutation commits", async () => {
    assert.deepEqual(await call(k, "add", [5]), { ok: true, value: 5 });
    const s = (await call(k, "get")).value;
    assert.equal(s.key, k);
    assert.equal(s.created, true);
    assert.equal(s.n, 5);
  });

  await test("FR3: a throwing action leaves no partial state; error code propagates (FR4)", async () => {
    const r = await call(k, "addThenThrow");
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, "action");
    assert.equal(r.error.code, "BOOM");
    assert.equal(r.error.remoteName, "Error");
    assert.equal((await call(k, "get")).value.n, 5);
  });

  await test("FR3: non-JSON state (Date) is rejected with an actionable message and rolled back", async () => {
    const r = await call(k, "storeDate");
    assert.equal(r.error.kind, "validation");
    assert.match(r.error.message, /state\.when is a Date/);
    assert.equal((await call(k, "get")).value.when, null);
  });

  await test("FR4: non-serializable return value is rejected before commit", async () => {
    const r = await call(k, "returnFn");
    assert.equal(r.error.kind, "validation");
  });

  await test("FR3: reassigning ctx.state commits the new object", async () => {
    await call(k, "replace");
    assert.equal((await call(k, "get")).value.n, -1);
    await call(k, "add", [6]); // back to 5
  });

  await test("§8.4: actions on one instance run one at a time, in arrival order", async () => {
    const key = `order-${run}`;
    const slow = call(key, "slow", [300]);
    await sleep(50);
    const fast = call(key, "fast");
    await Promise.all([slow, fast]);
    assert.deepEqual((await call(key, "get")).value.items, ["slow", "fast"]);
  });

  await test("§8.4: 100 concurrent increments → exactly 100 (no lost updates)", async () => {
    const key = `conc-${run}`;
    await Promise.all(Array.from({ length: 100 }, () => call(key, "add", [1])));
    assert.equal((await call(key, "get")).value.n, 100);
  });

  await test("FR4: timeoutMs rejects with kind=timeout; the action still completes", async () => {
    const key = `timeout-${run}`;
    const r = await call(key, "slow", [400], "?timeoutMs=50");
    assert.equal(r.error.kind, "timeout");
    await sleep(600);
    assert.deepEqual((await call(key, "get")).value.items, ["slow"]);
  });

  await test("FR4: unknown action fails with a config error listing available actions", async () => {
    const r = await call(k, "nope");
    assert.equal(r.error.kind, "config");
    assert.match(r.error.message, /has no action "nope"\. Available: add, /);
  });

  await test("FR8: scheduled action runs via alarm; schedule inside a failed action is discarded", async () => {
    const key = `sched-${run}`;
    await call(key, "add", [0]);
    assert.equal((await call(key, "scheduleThenThrow")).ok, false);
    let d = await api(`/actors/Probe/${key}`);
    assert.equal(d.schedules.length, 0, "rolled-back action must not leave a schedule");
    await call(key, "scheduleAdd", [1, 7]);
    d = await api(`/actors/Probe/${key}`);
    assert.equal(d.schedules.length, 1);
    for (let i = 0; i < 40 && (await call(key, "get")).value.n !== 7; i++) await sleep(150);
    assert.equal((await call(key, "get")).value.n, 7);
    d = await api(`/actors/Probe/${key}`);
    assert.equal(d.schedules.length, 0);
    assert.ok(d.invocations.some((i) => i.source === "schedule" && i.method === "add" && i.ok));
  });

  await test("FR6: explorer lists types/instances, inspects state, invokes, redacts", async () => {
    const types = await api("/types");
    assert.deepEqual(types.map((t) => t.name), ["Probe", "Room"]);
    assert.ok(types[0].actions.find((a) => a.name === "add").params[0].startsWith("by"));
    const inst = await api("/instances");
    assert.ok(inst.some((i) => i.actor === "Probe" && i.key === k && i.errors >= 1));
    const inv = await api(`/actors/Probe/${k}/invoke`, { method: "POST", body: JSON.stringify({ method: "add", args: [10] }) });
    assert.equal(inv.value, 15);
    await api(`/actors/Probe/${k}/invoke`, { method: "POST", body: JSON.stringify({ method: "setSecret", args: ["tok_live_123"] }) });
    const d = await api(`/actors/Probe/${k}`);
    assert.equal(d.state.n, 15);
    assert.equal(d.state.secret, "[redacted]");
    assert.ok(!JSON.stringify(d).includes("tok_live_123"), "secret leaked into inspect output");
    assert.ok(d.invocations.some((i) => !i.ok && i.error.code === "BOOM" && i.error.stack));
    assert.equal(d.invocations[0].source, "explorer");
  });

  await test("FR6: instance list comes from Wrangler's Local Explorer; no index object exists", async () => {
    const names = await localObjects();
    assert.ok(names.includes(`Probe:${k}`));
    assert.ok(!names.some((n) => n.startsWith("__")), `unexpected internal objects: ${names}`);
    const inst = await api("/instances");
    assert.deepEqual(
      inst.map((i) => `${i.actor}:${i.key}`).sort(),
      names.filter((n) => n.startsWith("Probe:")).sort(),
    );
  });

  await test("FR6: inspecting a key that was never used does not create it", async () => {
    const ghost = `ghost-${run}`;
    const d = await api(`/actors/Probe/${ghost}`);
    assert.equal(d.exists, false);
    assert.equal(d.lifecycle, null);
    assert.ok(!(await localObjects()).includes(`Probe:${ghost}`));
  });

  await test("FR6: inspect answers while an action is running, and shows it", async () => {
    const key = `busy-${run}`;
    await call(key, "add", [1]);
    const running = call(key, "slow", [1500]);
    await sleep(300);
    const t0 = Date.now();
    const d = await api(`/actors/Probe/${key}`);
    assert.ok(Date.now() - t0 < 1000, "inspect waited for the action");
    assert.equal(d.lifecycle.activeAction?.method, "slow");
    assert.equal(d.state.n, 1);
    await running;
  });

  await test("FR6: deleting an instance from the explorer removes it from the list", async () => {
    const key = `wipe-${run}`;
    await call(key, "add", [3]);
    const r = await fetch(`${base}/__actors/api/actors/Probe/${key}`, { method: "DELETE" });
    assert.equal(r.status, 200);
    assert.ok(!(await api("/instances")).some((i) => i.key === key));
    assert.equal((await call(key, "get")).value.n, 0, "a fresh instance starts from initial state");
  });

  await test("FR8: a raw Durable Object class is wired up with zero config and called via durable()", async () => {
    const cfg = readFileSync(join(fixture, "wrangler.jsonc"), "utf8");
    assert.match(cfg, /"name": "LEDGER",\s*"class_name": "Ledger"/);
    assert.match(cfg, /"tag": "actors-do-Ledger",\s*"new_sqlite_classes": \[\s*"Ledger"\s*\]/);
    const ledger = async (op, n) => (await (await fetch(`${base}/ledger/acct-${run}/${op}${n ? `?n=${n}` : ""}`)).json()).value;
    assert.equal(await ledger("add", 5), 5);
    assert.equal(await ledger("add", 7), 12);
    assert.equal(await ledger("total"), 12);
  });

  await test("FR6: explorer lists raw Durable Object instances and browses their tables (read-only)", async () => {
    const objs = await api("/objects");
    const cls = objs.find((o) => o.class === "Ledger");
    assert.equal(cls.binding, "LEDGER");
    const inst = cls.instances.find((i) => i.name === `acct-${run}`);
    assert.ok(inst, "instance listed by name");
    const d = await api(`/objects/Ledger/${inst.id}`);
    assert.deepEqual(d.tables, [{ name: "lines", rows: 2 }], "internal tables are hidden");
    const t = await api(`/objects/Ledger/${inst.id}/tables/lines?limit=1`);
    assert.equal(t.total, 2);
    assert.deepEqual(t.columns, ["id", "amount"]);
    assert.deepEqual(t.rows, [[2, 7]], "newest first, paged");
    const bad = await fetch(`${base}/__actors/api/objects/Ledger/${inst.id}/tables/${encodeURIComponent("lines; DROP TABLE lines")}`);
    assert.equal(bad.status, 404, "only real table names are queried");
  });

  await test("FR6: opening an unknown Durable Object id returns 404 and creates nothing", async () => {
    const before = (await api("/objects")).find((o) => o.class === "Ledger").instances.length;
    const r = await fetch(`${base}/__actors/api/objects/Ledger/${"ab".repeat(32)}`);
    assert.equal(r.status, 404);
    assert.equal((await api("/objects")).find((o) => o.class === "Ledger").instances.length, before);
  });

  // ── WebSockets ──
  const wsOpen = (room, user) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}/ws/${room}?user=${user}`);
      const got = [];
      ws.onmessage = (e) => got.push(JSON.parse(e.data));
      ws.onopen = () => resolve({ ws, got });
      ws.onerror = () => reject(new Error(`could not connect ${user}`));
    });
  const roomCall = async (room, method, args = []) =>
    (await (await fetch(`${base}/room/${room}/${method}`, { method: "POST", body: JSON.stringify(args) })).json()).value;
  const upgrade = (path, extraHeaders = []) =>
    spawnSync("curl", ["-s", "-i", "-N", "--max-time", "2", `${base}${path}`, "-H", "Upgrade: websocket", "-H", "Connection: Upgrade",
      "-H", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "-H", "Sec-WebSocket-Version: 13", ...extraHeaders.flatMap((h) => ["-H", h])],
      { encoding: "latin1" }).stdout;
  const room = `room-${run}`;

  await test("WS: onConnect runs, conn.send reaches only that client, broadcasts reach everyone", async () => {
    const a = await wsOpen(room, "ada");
    const b = await wsOpen(room, "bob");
    await sleep(200);
    assert.deepEqual(a.got[0], { hello: "ada", online: [] }, "a connection isn't listed during its own onConnect");
    assert.deepEqual(b.got[0], { hello: "bob", online: ["ada"] });
    a.ws.send("hi");
    await sleep(200);
    assert.deepEqual(a.got.at(-1), { from: "ada", text: "hi" });
    assert.deepEqual(b.got.at(-1), { from: "ada", text: "hi" });
    assert.deepEqual(await roomCall(room, "online"), ["ada", "bob"]);
    globalThis.__ws = { a, b };
  });

  await test("WS: a hook that throws sends nothing and keeps no state; the socket stays open", async () => {
    const { a, b } = globalThis.__ws;
    const before = [a.got.length, b.got.length];
    a.ws.send("fail");
    await sleep(300);
    assert.deepEqual([a.got.length, b.got.length], before, "rolled-back broadcast was delivered");
    assert.ok(!(await roomCall(room, "log")).includes("ada:fail"));
    assert.equal(a.ws.readyState, WebSocket.OPEN);
    const d = await api(`/actors/Room/${room}`);
    assert.ok(d.invocations.some((i) => i.method === "onMessage" && i.source === "websocket" && !i.ok));
  });

  await test("WS: actions can broadcast to connected clients", async () => {
    const { a, b } = globalThis.__ws;
    await roomCall(room, "shout", ["hello all"]);
    await sleep(200);
    assert.deepEqual(a.got.at(-1), { from: "server", text: "hello all" });
    assert.deepEqual(b.got.at(-1), { from: "server", text: "hello all" });
  });

  await test("WS: onClose runs and the connection leaves ctx.connections() and the Explorer", async () => {
    const { a, b } = globalThis.__ws;
    b.ws.close(1000, "bye");
    await sleep(400);
    assert.deepEqual(await roomCall(room, "online"), ["ada"]);
    assert.ok((await roomCall(room, "log")).includes("bob:left"));
    const d = await api(`/actors/Room/${room}`);
    assert.deepEqual(d.lifecycle.connections.map((c) => c.data.user), ["ada"]);
    a.ws.close();
    await sleep(300);
  });

  await test("WS: onConnect can refuse (403, no socket); plain requests get 426", async () => {
    const refused = upgrade(`/ws/${room}?user=banned`);
    assert.match(refused, /^HTTP\/1\.1 403/);
    assert.match(refused, /banned user/);
    const plain = await fetch(`${base}/ws/${room}?user=x`);
    assert.equal(plain.status, 426);
  });

  await test("WS: connection data and routing headers can't be forged by the client", async () => {
    const out = upgrade(`/ws/${room}?user=eve`, ["x-actors-data: %7B%22user%22%3A%22mallory%22%7D", "x-actors-actor: Probe"]);
    assert.match(out, /^HTTP\/1\.1 101/);
    assert.match(out, /"hello":"eve"/);
    assert.doesNotMatch(out, /mallory/);
  });

  await test("FR7: failed invocation is traceable to actor, method, error and logs", async () => {
    const d = await api(`/actors/Probe/${k}`);
    const failed = d.invocations.find((i) => i.method === "addThenThrow");
    assert.ok(failed && !failed.ok && failed.invocation && failed.error.message === "boom");
  });

  await test("CLI: actors inspect prints state and errors", async () => {
    const r = spawnSync(process.execPath, [cli, "inspect", "Probe", k, "--port", String(PORT)], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Probe\("k-/);
    assert.match(r.stdout, /addThenThrow/);
    assert.match(r.stdout, /\[redacted\]/);
  });

  await test("§8.6: explorer refuses non-localhost hosts", async () => {
    // Node's fetch won't send a custom Host header, so use curl.
    const r = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-H", "Host: example.com", `${base}/__actors/api/types`], { encoding: "utf8" });
    assert.equal(r.stdout, "403");
  });

  console.log("restart (same persisted store)");
  await stop(server);
  server = start(process.execPath, [cli, "dev", "--port", String(PORT), "--persist-to", persist]);
  await waitReady(server);

  await test("FR3: state survives a full runtime restart", async () => {
    assert.equal((await call(k, "get")).value.n, 15);
    assert.equal((await call(`conc-${run}`, "get")).value.n, 100);
    const d = await api(`/actors/Probe/${k}`);
    assert.ok(d.invocations.length > 5, "invocation history survives restart");
  });

  await stop(server);

  console.log("wrangler dev (production entry)");
  server = start(wrangler, ["dev", "--port", String(PORT), "--persist-to", persist]);
  await waitReady(server);

  await test("§8.6: production entry has no explorer routes but actors still work", async () => {
    const r = await fetch(`${base}/__actors/api/types`);
    assert.equal(r.status, 404);
    assert.equal(await r.text(), "fixture worker");
    assert.equal((await call(k, "get")).value.n, 15);
    assert.equal((await call(`prod-${run}`, "add", [2])).value, 2);
    assert.equal((await (await fetch(`${base}/ledger/acct-${run}/total`)).json()).value, 12, "raw DO state survives restart");
  });

  await stop(server);

  console.log("actors dev again (sees data written by the production entry)");
  server = start(process.execPath, [cli, "dev", "--port", String(PORT), "--persist-to", persist]);
  await waitReady(server);

  await test("FR6: instances created outside the dev entry are listed and inspectable", async () => {
    assert.ok((await api("/instances")).some((i) => i.key === `prod-${run}`));
    const d = await api(`/actors/Probe/prod-${run}`);
    assert.equal(d.state.n, 2);
    assert.equal(d.invocations.length, 0, "production instrumentation records errors only");
  });

  await stop(server);
  server = undefined;

  await test("FR5: actors deploy --dry-run bundles a valid Worker without dev tooling", async () => {
    const out = mkdtempSync(join(tmpdir(), "actors-bundle-"));
    const r = spawnSync(process.execPath, [cli, "deploy", "--dry-run", "--outdir", out], { cwd: fixture, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const bundle = readdirSync(out).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(out, f), "utf8")).join("");
    assert.ok(bundle.includes("ActorHost"));
    assert.ok(!bundle.includes("Actor Explorer"), "explorer HTML must not ship to production");
    assert.ok(!bundle.includes("actorInspect(actor") || bundle.includes("only available in development"), "inspect is gated");
    rmSync(out, { recursive: true, force: true });
  });

  const scratchProject = (files) => {
    const dir = mkdtempSync(join(tmpdir(), "actors-gen-"));
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), text);
    }
    return dir;
  };

  await test("FR5: a bound Durable Object class that disappeared is reported, never deleted", async () => {
    const dir = scratchProject({
      "wrangler.jsonc": `{ "name": "x", "main": ".actors/entry.ts", "compatibility_date": "2026-09-01",
        "durable_objects": { "bindings": [{ "name": "GONE", "class_name": "Gone" }] },
        "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Gone"] }] }`,
      "src/index.ts": "export default { fetch: () => new Response('x') };",
    });
    const r = spawnSync(process.execPath, [cli, "generate"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Binding GONE → Gone, but no exported class Gone/);
    assert.match(r.stdout, /deleted_classes/);
    assert.match(readFileSync(join(dir, "wrangler.jsonc"), "utf8"), /"class_name": "Gone"/);
    rmSync(dir, { recursive: true, force: true });
  });

  await test("FR5: a binding-name clash fails with an actionable error", async () => {
    const dir = scratchProject({
      "wrangler.jsonc": `{ "name": "x", "compatibility_date": "2026-09-01", "kv_namespaces": [{ "binding": "CHAT_ROOM", "id": "abc" }] }`,
      "src/room.ts": "import { DurableObject } from 'cloudflare:workers';\nexport class ChatRoom extends DurableObject {}\n",
    });
    const r = spawnSync(process.execPath, [cli, "generate"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /"ChatRoom" would get the binding "CHAT_ROOM", but that name is already used by KV binding/);
    rmSync(dir, { recursive: true, force: true });
  });

  await test("FR5: generate is deterministic (second run changes nothing)", async () => {
    const before = readFileSync(join(fixture, ".actors/entry.ts"), "utf8") + readFileSync(join(fixture, "wrangler.jsonc"), "utf8");
    const r = spawnSync(process.execPath, [cli, "generate"], { cwd: fixture, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /wrote|created|added|set /);
    const after = readFileSync(join(fixture, ".actors/entry.ts"), "utf8") + readFileSync(join(fixture, "wrangler.jsonc"), "utf8");
    assert.equal(after, before);
  });
}

try {
  await main();
} catch (err) {
  failures.push("harness");
  console.error(err);
} finally {
  await stop(server);
  rmSync(persist, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
