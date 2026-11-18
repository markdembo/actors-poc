#!/usr/bin/env node
// actors — CLI for Actors on Cloudflare (PoC).
//
//   actors generate            discover actors, write .actors/ entry points, manage wrangler.jsonc
//   actors dev [wrangler args] generate, then `wrangler dev` with the Actor Explorer at /__actors
//   actors deploy [args]       generate, check compatibility, then `wrangler deploy` (no explorer / admin routes)
//   actors upload [args]       generate, check compatibility, then `wrangler versions upload` (gradual deployments)
//   actors check               compare actor APIs and migrations with the last deployed or uploaded version
//   actors inspect <Type> <key> [--port 8787] [--json]
//   actors list [--port 8787] [--json]
//
// The CLI never deploys anything itself: it writes standard Wrangler config and delegates.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { compareAction, readTypes } from "./types.mjs";

const BINDING = "ACTORS";
const HOST_CLASS = "ActorHost";
const MIGRATION_TAG = "actors-v1";
const VERSION_BINDING = "CF_VERSION_METADATA";
const LOCK_FILE = "actors.lock.json";
const GEN_DIR = ".actors";
const PROD_ENTRY = `${GEN_DIR}/entry.ts`;
const DEV_ENTRY = `${GEN_DIR}/entry.dev.ts`;
const DEFAULT_COMPAT_DATE = "2026-09-01";
const USER_WORKER_CANDIDATES = ["src/index.ts", "src/index.js", "src/worker.ts", "src/worker.js"];
const SOURCE_EXT = /\.(m?ts|m?js|tsx|jsx)$/;
const DO_CLASS_EXPORT = /export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\s+extends\s+DurableObject\b/g;
const ACTOR_EXPORT = /export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*actor\s*(?:<[\s\S]*?>)?\s*\(/g;

const c = process.stdout.isTTY
  ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m` }
  : { dim: (s) => s, bold: (s) => s, red: (s) => s, green: (s) => s, yellow: (s) => s, cyan: (s) => s };

class CliError extends Error {}

// ───────────────────────────── discovery ─────────────────────────────

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SOURCE_EXT.test(name) && !name.endsWith(".d.ts") && !/\.(test|spec)\./.test(name)) out.push(p);
  }
  return out;
}

export function discover(root) {
  const actors = [];
  for (const file of walk(join(root, "src"))) {
    const src = readFileSync(file, "utf8");
    if (!/\bactor\b/.test(src)) continue;
    for (const m of src.matchAll(ACTOR_EXPORT)) {
      actors.push({ name: m[1], file: relative(root, file).split(sep).join("/") });
    }
  }
  actors.sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Map();
  for (const a of actors) {
    if (seen.has(a.name)) {
      throw new CliError(`Two actors are named "${a.name}" (${seen.get(a.name)} and ${a.file}). Actor names must be unique.`);
    }
    if (a.name === HOST_CLASS || a.name.startsWith("__")) {
      throw new CliError(`"${a.name}" in ${a.file} is a reserved name. Rename the actor.`);
    }
    seen.set(a.name, a.file);
  }
  return actors;
}

/** Raw Durable Object classes: `export class X extends DurableObject` anywhere under src/. */
export function discoverObjects(root, actors) {
  const objects = [];
  for (const file of walk(join(root, "src"))) {
    const src = readFileSync(file, "utf8");
    if (!/\bDurableObject\b/.test(src)) continue;
    for (const m of src.matchAll(DO_CLASS_EXPORT)) {
      objects.push({ name: m[1], file: relative(root, file).split(sep).join("/") });
    }
  }
  objects.sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Map();
  for (const o of objects) {
    if (seen.has(o.name)) {
      throw new CliError(`Two Durable Object classes are named "${o.name}" (${seen.get(o.name)} and ${o.file}). Class names must be unique.`);
    }
    if (o.name === HOST_CLASS) throw new CliError(`"${HOST_CLASS}" in ${o.file} is reserved for the actor runtime. Rename the class.`);
    const actor = actors.find((a) => a.name === o.name);
    if (actor) throw new CliError(`"${o.name}" is both an actor (${actor.file}) and a Durable Object class (${o.file}). Rename one.`);
    seen.set(o.name, o.file);
  }
  return objects;
}

/** ChatRoom → CHAT_ROOM. Mirrors bindingNameFor() in the SDK. */
function bindingNameFor(className) {
  return className
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toUpperCase();
}

function findUserWorker(root) {
  return USER_WORKER_CANDIDATES.find((p) => existsSync(join(root, p))) ?? null;
}

// ───────────────────────────── code generation ─────────────────────────────

const HEADER = "// Generated by `actors generate`. Do not edit: changes are overwritten.\n// Source of truth: your actor definitions under src/.\n";

/** Other classes exported from the Worker file (Workflows, entrypoints, Durable Objects of other base classes). */
function otherWorkerClasses(root, userWorker, objects) {
  if (!userWorker) return [];
  const src = readFileSync(join(root, userWorker), "utf8");
  const classes = [...src.matchAll(/export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  if (classes.includes(HOST_CLASS)) throw new CliError(`${userWorker} exports a class named "${HOST_CLASS}", which is reserved.`);
  return classes.filter((n) => !objects.some((o) => o.name === n));
}

function entrySource(root, actors, objects, bindings, userWorker, dev, workerName) {
  const imp = (file) => `../${file}`;
  const lines = [HEADER];
  lines.push(`import { createHost } from "actors-poc/runtime";`);
  if (dev) lines.push(`import { createDevWorker } from "actors-poc/dev";`);
  if (objects.length) lines.push(`import { __registerDurableObjects } from "actors-poc";`);
  for (const a of actors) lines.push(`import { ${a.name} } from ${JSON.stringify(imp(a.file))};`);
  for (const o of objects) lines.push(`import { ${o.name} } from ${JSON.stringify(imp(o.file))};`);
  if (userWorker) {
    lines.push(`import userWorker from ${JSON.stringify(imp(userWorker))};`);
    // Re-export the Worker file's other classes (Workflows, entrypoints, ...): escape hatch.
    const others = otherWorkerClasses(root, userWorker, objects);
    if (others.length) lines.push(`export { ${others.join(", ")} } from ${JSON.stringify(imp(userWorker))};`);
  }
  if (objects.length) lines.push(`export { ${objects.map((o) => o.name).join(", ")} };`);
  lines.push("");
  if (objects.length) {
    lines.push(
      `__registerDurableObjects({ ${objects.map((o) => `${o.name}: [${o.name}, ${JSON.stringify(bindings[o.name])}]`).join(", ")} });`,
    );
  }
  lines.push(`const actors = ${actors.length ? `{ ${actors.map((a) => a.name).join(", ")} }` : "{}"};`);
  lines.push(`export const ${HOST_CLASS} = createHost(actors${dev ? ", { dev: true }" : ""});`);
  if (dev) {
    const opts = [];
    if (workerName) opts.push(`workerName: ${JSON.stringify(workerName)}`);
    if (objects.length) opts.push(`objects: { ${objects.map((o) => `${o.name}: ${JSON.stringify(bindings[o.name])}`).join(", ")} }`);
    lines.push(
      `export default createDevWorker(actors, ${userWorker ? "userWorker" : "undefined"}${opts.length ? `, { ${opts.join(", ")} }` : ""});`,
    );
  } else if (userWorker) {
    lines.push(`export default userWorker;`);
  } else {
    lines.push(`export default { fetch: () => new Response("No fetch handler: add src/index.ts", { status: 404 }) };`);
  }
  return `${lines.join("\n")}\n`;
}

function writeIfChanged(path, content) {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

// ───────────────────────────── wrangler.jsonc management ─────────────────────────────

const FMT = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } };

function sanitizeName(s) {
  return (s || "actors-app").toLowerCase().replace(/^@[^/]+\//, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "actors-app";
}

function ensureWranglerConfig(root, objects = [], otherClasses = []) {
  if (existsSync(join(root, "wrangler.toml"))) {
    throw new CliError("Found wrangler.toml. This PoC manages wrangler.jsonc only; convert your config to wrangler.jsonc.");
  }
  const path = existsSync(join(root, "wrangler.json")) ? join(root, "wrangler.json") : join(root, "wrangler.jsonc");
  const changes = [];
  let text;
  if (!existsSync(path)) {
    const pkg = existsSync(join(root, "package.json")) ? JSON.parse(readFileSync(join(root, "package.json"), "utf8")) : {};
    text = `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": ${JSON.stringify(sanitizeName(pkg.name || basename(root)))},
  "compatibility_date": ${JSON.stringify(DEFAULT_COMPAT_DATE)},
  "observability": { "enabled": true },

  // ── Managed by \`actors generate\` ──────────────────────────────────────────
  // One Durable Object class (${HOST_CLASS}) hosts every actor type, so adding or
  // removing actors never needs a new migration. version_metadata lets the runtime
  // record which code version handled each call. Everything else here is yours.
  "main": "${PROD_ENTRY}",
  "durable_objects": { "bindings": [{ "name": "${BINDING}", "class_name": "${HOST_CLASS}" }] },
  "migrations": [{ "tag": "${MIGRATION_TAG}", "new_sqlite_classes": ["${HOST_CLASS}"] }],
  "version_metadata": { "binding": "${VERSION_BINDING}" }
}
`;
    changes.push("created wrangler.jsonc");
  } else {
    text = readFileSync(path, "utf8");
  }

  const errors = [];
  let cfg = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    throw new CliError(`${basename(path)} is not valid JSONC (${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}).`);
  }
  const edit = (p, value, opts = {}) => {
    text = applyEdits(text, modify(text, p, value, { ...FMT, ...opts }));
    cfg = parseJsonc(text, [], { allowTrailingComma: true });
  };

  if (cfg.main !== PROD_ENTRY) {
    if (cfg.main && !USER_WORKER_CANDIDATES.includes(cfg.main.replace(/^\.\//, ""))) {
      throw new CliError(
        `wrangler.jsonc "main" is "${cfg.main}". actors manages "main" (it points at the generated entry). ` +
          `Move your Worker to src/index.ts and it will be wired in automatically.`,
      );
    }
    edit(["main"], PROD_ENTRY);
    changes.push(`set main → ${PROD_ENTRY}`);
  }
  if (!cfg.compatibility_date) {
    edit(["compatibility_date"], DEFAULT_COMPAT_DATE);
    changes.push(`set compatibility_date → ${DEFAULT_COMPAT_DATE}`);
  } else if (cfg.compatibility_date < "2024-04-03") {
    throw new CliError(`compatibility_date ${cfg.compatibility_date} is too old: actors need Durable Object RPC (2024-04-03 or later).`);
  }

  const bindings = cfg.durable_objects?.bindings ?? [];
  const existing = bindings.find((b) => b.name === BINDING);
  if (existing && existing.class_name !== HOST_CLASS) {
    throw new CliError(`Durable Object binding "${BINDING}" is reserved for actors but points to "${existing.class_name}". Rename your binding.`);
  }
  if (!existing) {
    edit(["durable_objects", "bindings", bindings.length], { name: BINDING, class_name: HOST_CLASS }, { isArrayInsertion: true });
    changes.push(`added Durable Object binding ${BINDING} → ${HOST_CLASS}`);
  }

  const migrations = cfg.migrations ?? [];
  const hasHost = migrations.some((m) =>
    [...(m.new_sqlite_classes ?? []), ...(m.new_classes ?? [])].includes(HOST_CLASS) ||
    (m.renamed_classes ?? []).some((r) => r.to === HOST_CLASS),
  );
  if (!hasHost) {
    if (migrations.some((m) => m.tag === MIGRATION_TAG)) throw new CliError(`Migration tag "${MIGRATION_TAG}" is taken by another migration.`);
    edit(["migrations", migrations.length], { tag: MIGRATION_TAG, new_sqlite_classes: [HOST_CLASS] }, { isArrayInsertion: true });
    changes.push(`added migration ${MIGRATION_TAG} (new_sqlite_classes: ${HOST_CLASS})`);
  }

  // ── Code version: recorded with every call, so mixed versions during a gradual deployment are visible.
  const warnings = [];
  if (!cfg.version_metadata) {
    const taken = bindingNames(cfg).get(VERSION_BINDING);
    if (taken) {
      warnings.push(`${VERSION_BINDING} is already used by ${taken}, so the code version of each call won't be recorded.`);
    } else {
      edit(["version_metadata"], { binding: VERSION_BINDING });
      changes.push(`added version_metadata binding ${VERSION_BINDING}`);
    }
  } else if (cfg.version_metadata.binding !== VERSION_BINDING) {
    warnings.push(
      `version_metadata is bound as ${cfg.version_metadata.binding}. Actors reads it as ${VERSION_BINDING}; ` +
        "rename the binding to record which code version handled each call.",
    );
  }

  // ── Raw Durable Object classes: one binding + one migration each, never removed automatically.
  const objectBindings = {};
  const migrated = (cls) =>
    (cfg.migrations ?? []).some(
      (m) =>
        [...(m.new_sqlite_classes ?? []), ...(m.new_classes ?? [])].includes(cls) ||
        [...(m.renamed_classes ?? []), ...(m.transferred_classes ?? [])].some((r) => r.to === cls),
    );
  for (const o of objects) {
    const doBindings = cfg.durable_objects?.bindings ?? [];
    const own = doBindings.find((b) => b.class_name === o.name && !b.script_name);
    if (own) {
      objectBindings[o.name] = own.name; // a hand-written binding wins
    } else {
      const name = bindingNameFor(o.name);
      const taken = bindingNames(cfg).get(name);
      if (taken) {
        throw new CliError(
          `Durable Object class "${o.name}" would get the binding "${name}", but that name is already used by ${taken}. ` +
            `Add your own binding for it in wrangler.jsonc (durable_objects.bindings: { "name": "...", "class_name": "${o.name}" }).`,
        );
      }
      edit(["durable_objects", "bindings", doBindings.length], { name, class_name: o.name }, { isArrayInsertion: true });
      changes.push(`added Durable Object binding ${name} → ${o.name}`);
      objectBindings[o.name] = name;
    }
    if (!migrated(o.name)) {
      const tag = `actors-do-${o.name}`;
      const migrations = cfg.migrations ?? [];
      if (migrations.some((m) => m.tag === tag)) throw new CliError(`Migration tag "${tag}" is taken by another migration.`);
      edit(["migrations", migrations.length], { tag, new_sqlite_classes: [o.name] }, { isArrayInsertion: true });
      changes.push(`added migration ${tag} (new_sqlite_classes: ${o.name})`);
    }
  }
  // A bound class that is no longer exported breaks deploys. Never delete data on the user's behalf.
  const exported = new Set([HOST_CLASS, ...objects.map((o) => o.name), ...otherClasses]);
  for (const b of cfg.durable_objects?.bindings ?? []) {
    if (b.script_name || exported.has(b.class_name)) continue;
    warnings.push(
      `Binding ${b.name} → ${b.class_name}, but no exported class ${b.class_name} was found under src/. ` +
        `Restore it, or export it from src/index.ts. To delete its data on purpose, remove the binding and add a migration ` +
        `{ "tag": "...", "deleted_classes": ["${b.class_name}"] }.`,
    );
  }

  writeIfChanged(path, text);
  return { path, changes, warnings, objectBindings, config: cfg };
}

/** Every binding name in a config, mapped to a description of what uses it. */
function bindingNames(cfg) {
  const names = new Map();
  const add = (list, key, what) => {
    for (const b of Array.isArray(list) ? list : []) if (b?.[key]) names.set(b[key], `${what} binding "${b[key]}"`);
  };
  add(cfg.durable_objects?.bindings, "name", "Durable Object");
  add(cfg.kv_namespaces, "binding", "KV");
  add(cfg.r2_buckets, "binding", "R2");
  add(cfg.d1_databases, "binding", "D1");
  add(cfg.services, "binding", "service");
  add(cfg.queues?.producers, "binding", "queue");
  add(cfg.vectorize, "binding", "Vectorize");
  add(cfg.workflows, "binding", "Workflow");
  add(cfg.hyperdrive, "binding", "Hyperdrive");
  add(cfg.analytics_engine_datasets, "binding", "Analytics Engine");
  for (const k of Object.keys(cfg.vars ?? {})) names.set(k, `var "${k}"`);
  for (const one of ["ai", "browser", "images", "version_metadata"]) if (cfg[one]?.binding) names.set(cfg[one].binding, `${one} binding`);
  if (cfg.assets?.binding) names.set(cfg.assets.binding, "assets binding");
  return names;
}

// ───────────────────────────── commands ─────────────────────────────

function generate(root, { quiet = false } = {}) {
  const actors = discover(root);
  const objects = discoverObjects(root, actors);
  const userWorker = findUserWorker(root);
  const cfg = ensureWranglerConfig(root, objects, otherWorkerClasses(root, userWorker, objects));
  const objectsWithBindings = objects.map((o) => ({ ...o, binding: cfg.objectBindings[o.name] }));
  const manifest = {
    note: "Generated by `actors generate`. Reproducible from src/; safe to delete.",
    binding: BINDING,
    hostClass: HOST_CLASS,
    worker: userWorker,
    actors,
    objects: objectsWithBindings,
  };
  const wrote = [
    writeIfChanged(join(root, PROD_ENTRY), entrySource(root, actors, objects, cfg.objectBindings, userWorker, false)),
    writeIfChanged(join(root, DEV_ENTRY), entrySource(root, actors, objects, cfg.objectBindings, userWorker, true, cfg.config.name)),
    writeIfChanged(join(root, GEN_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
  ].some(Boolean);
  if (!quiet) {
    if (!actors.length) {
      console.log(c.yellow("No actors found.") + c.dim(" Define one under src/ as `export const Name = actor({ ... })`."));
    } else {
      console.log(`${c.green("✓")} ${actors.length} actor${actors.length === 1 ? "" : "s"}: ${actors.map((a) => `${c.bold(a.name)} ${c.dim(a.file)}`).join(", ")}`);
    }
    if (objects.length) {
      console.log(`${c.green("✓")} ${objects.length} Durable Object class${objects.length === 1 ? "" : "es"}: ${objectsWithBindings.map((o) => `${c.bold(o.name)} ${c.dim(`→ ${o.binding}, ${o.file}`)}`).join(", ")}`);
    }
    console.log(`${c.green("✓")} worker: ${userWorker ?? c.dim("(none — add src/index.ts to handle requests)")}`);
    for (const ch of cfg.changes) console.log(`${c.green("✓")} ${basename(cfg.path)}: ${ch}`);
    if (wrote) console.log(`${c.green("✓")} wrote ${GEN_DIR}/ (entry.ts, entry.dev.ts, manifest.json)`);
  }
  if (!quiet) for (const w of cfg.warnings) console.log(c.yellow(`! ${w}`));
  return { actors, objects: objectsWithBindings, userWorker };
}

function findBin(root, name) {
  let dir = root;
  while (true) {
    const p = join(dir, "node_modules", ".bin", name);
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function runWrangler(root, args) {
  const bin = findBin(root, "wrangler");
  const [cmd, cmdArgs] = bin ? [bin, args] : ["npx", ["--yes", "wrangler@4", ...args]];
  console.log(c.dim(`$ wrangler ${args.join(" ")}`));
  return spawn(cmd, cmdArgs, { cwd: root, stdio: "inherit", env: process.env });
}

function dev(root, passthrough) {
  let { actors, objects } = generate(root);
  const port = flagValue(passthrough, "--port") ?? "8787";
  console.log(`${c.cyan("◆")} Actor Explorer: ${c.bold(`http://localhost:${port}/__actors`)}\n`);
  const child = runWrangler(root, ["dev", DEV_ENTRY, ...passthrough]);

  // Re-run discovery when sources change, so new actors are wired in without a restart.
  let timer;
  try {
    watch(join(root, "src"), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          const before = JSON.stringify([actors, objects]);
          ({ actors, objects } = generate(root, { quiet: true }));
          if (JSON.stringify([actors, objects]) !== before) {
            console.log(`${c.cyan("◆")} discovered: ${[...actors, ...objects].map((a) => a.name).join(", ") || "(none)"}`);
          }
        } catch (err) {
          console.error(c.red(`actors: ${err.message}`));
        }
      }, 150);
    });
  } catch {
    /* recursive watch unsupported: discovery runs on restart only */
  }
  const stop = () => child.kill("SIGINT");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => process.exit(code ?? 0));
}

// ───────────────────────────── compatibility check ─────────────────────────────
//
// During a deployment, old and new code run side by side: a Worker on one version calls instances
// on another, and scheduled calls saved by old code run on new code. So an action that disappears
// or changes its parameters breaks callers that still run the previous version, and removing a
// migration makes instances that already ran it refuse the new code. `actors deploy` and
// `actors upload` compare the actor API with the one last shipped (recorded in actors.lock.json).

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const CLOUDFLARE_STUB = `export const env = {};
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class RpcTarget {}
export function waitUntil() {}
export default {};`;

const lockPath = (root, args) => {
  const env = flagValue(args, "--env") ?? flagValue(args, "-e");
  return join(root, env ? `actors.lock.${env}.json` : LOCK_FILE);
};

/** Load the actor definitions in Node (cloudflare:* modules stubbed) and describe their public API. */
async function readApi(root, actors) {
  const { build } = await import("esbuild");
  const dir = mkdtempSync(join(tmpdir(), "actors-api-"));
  try {
    const entry = [
      ...actors.map((a) => `export { ${a.name} } from ${JSON.stringify(join(root, a.file))};`),
      `export { describeParams } from ${JSON.stringify(join(SRC_DIR, "shared.ts"))};`,
    ].join("\n");
    const outfile = join(dir, "api.mjs");
    await build({
      stdin: { contents: entry, resolveDir: root, loader: "ts" },
      bundle: true,
      format: "esm",
      platform: "node",
      outfile,
      logLevel: "silent",
      // Wrangler's default module rules.
      loader: { ".html": "text", ".txt": "text", ".sql": "text", ".bin": "binary", ".wasm": "binary" },
      plugins: [{
        name: "cloudflare-stub",
        setup(b) {
          b.onResolve({ filter: /^cloudflare:/ }, (a) => ({ path: a.path, namespace: "cloudflare-stub" }));
          b.onLoad({ filter: /.*/, namespace: "cloudflare-stub" }, () => ({ contents: CLOUDFLARE_STUB, loader: "js" }));
        },
      }],
    });
    const mod = await import(pathToFileURL(outfile).href);
    // Parameter and return types come from the TypeScript compiler, when the project has it.
    let types = {};
    let typesSkipped = null;
    try {
      const r = readTypes(root, actors);
      if (r.skipped) typesSkipped = r.skipped;
      else types = r.types;
    } catch (err) {
      typesSkipped = `couldn't read types (${String(err.message ?? err).split("\n")[0]})`;
    }
    const api = {};
    for (const a of actors) {
      const cfg = mod[a.name]?.__config;
      if (!cfg) continue;
      api[a.name] = {
        actions: Object.fromEntries(
          Object.entries(cfg.actions).map(([n, fn]) => [n, { params: mod.describeParams(fn), ...(types[a.name]?.[n] ?? {}) }]),
        ),
        migrations: (cfg.migrations ?? []).map((m) => createHash("sha256").update(String(m)).digest("hex").slice(0, 12)),
      };
    }
    return { api, typesSkipped };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Durable Object class migration tags in wrangler.jsonc. */
function classMigrationTags(root) {
  const path = existsSync(join(root, "wrangler.json")) ? join(root, "wrangler.json") : join(root, "wrangler.jsonc");
  const cfg = parseJsonc(readFileSync(path, "utf8"), [], { allowTrailingComma: true }) ?? {};
  return (cfg.migrations ?? []).map((m) => m.tag).filter(Boolean);
}

export function compareApi(prev, next) {
  const breaking = [];
  const notes = [];
  const n = (k, word) => `${k} ${word}${k === 1 ? "" : "s"}`;
  for (const [name, before] of Object.entries(prev.actors ?? {})) {
    const after = next.actors[name];
    if (!after) {
      breaking.push(`Actor ${name} was removed. Callers on the previous version get "not registered" errors, and its instances' data stays but can't be reached.`);
      continue;
    }
    for (const [action, was] of Object.entries(before.actions)) {
      const now = after.actions[action];
      if (!now) {
        breaking.push(`${name}.${action}() was removed. Workers on the previous version, and calls it scheduled, still call it.`);
        continue;
      }
      const label = `${name}.${action}()`;
      if (was.args && now.args) {
        // Both versions have types: compare arguments and return values structurally.
        for (const problem of compareAction(label, was, now)) {
          breaking.push(`${problem} Add a new action instead (e.g. ${action}V2) and remove this one later.`);
        }
      } else {
        // Types unavailable on one side: fall back to counting arguments.
        const before = Array.isArray(was) ? was : was.params;
        const after = Array.isArray(now) ? now : now.params;
        if (after.length !== before.length) {
          breaking.push(
            `${label} now takes ${n(after.length, "argument")} instead of ${before.length}. ` +
              `Add a new action instead (e.g. ${action}V2) and remove this one later.`,
          );
        }
      }
    }
    if (after.migrations.length < before.migrations.length) {
      breaking.push(
        `${name} has ${n(after.migrations.length, "migration")}; the previous version had ${before.migrations.length}. ` +
          "Migrations are append-only: instances that already ran them refuse this code.",
      );
    } else {
      before.migrations.forEach((hash, i) => {
        if (after.migrations[i] !== hash) {
          notes.push(
            `${name} migrations[${i}] looks different from the one last shipped. It won't run again on instances that ran it; ` +
              "to change their state, append a new migration instead.",
          );
        }
      });
      const added = after.migrations.length - before.migrations.length;
      if (added > 0) notes.push(`${name}: ${n(added, "new migration")}; each instance runs ${added === 1 ? "it" : "them"} on its next call.`);
    }
  }
  const newTags = (next.classMigrations ?? []).filter((t) => !(prev.classMigrations ?? []).includes(t));
  return { breaking, notes, newClassMigrations: prev.actors ? newTags : [] };
}

/**
 * Compare with the lock file. Returns the API to save after a successful ship.
 * mode: "deploy" (all at once), "upload" (gradual), "check" (report only).
 */
async function checkCompatibility(root, actors, args, mode) {
  let api;
  try {
    const read = await readApi(root, actors);
    api = { actors: read.api, classMigrations: classMigrationTags(root) };
    if (read.typesSkipped) console.log(c.yellow(`! Checking argument counts only: ${read.typesSkipped}.`));
  } catch (err) {
    console.log(c.yellow(`! Skipped the compatibility check: couldn't load the actor definitions in Node (${String(err.message ?? err).split("\n")[0]}).`));
    return null;
  }
  const path = lockPath(root, args);
  const prev = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  if (!prev) {
    console.log(c.dim(`No ${basename(path)} yet: nothing to compare with.${mode === "check" ? "" : " It is written after this ships."}`));
    return api;
  }
  const { breaking, notes, newClassMigrations } = compareApi(prev, api);
  for (const note of notes) console.log(`${c.cyan("◆")} ${note}`);
  if (newClassMigrations.length) {
    const msg = `This version adds Durable Object class migrations (${newClassMigrations.join(", ")}). They can't roll out gradually.`;
    if (mode === "upload") throw new CliError(`${msg} Ship them with "actors deploy" first, then upload other changes.`);
    console.log(`${c.cyan("◆")} ${msg} ${mode === "check" ? 'Ship them with "actors deploy", not "actors upload".' : ""}`);
  }
  if (breaking.length) {
    const allowed = args.includes("--allow-breaking");
    const list = breaking.map((b) => `  - ${b}`).join("\n");
    if (!allowed) {
      throw new CliError(
        `Breaking changes compared with the version last shipped (${basename(path)}):\n${list}\n\n` +
          "Callers running the previous version would fail. Keep the old actions until that version is gone, then pass " +
          "--allow-breaking (once no Worker version that uses them is deployed and no scheduled calls to them are pending).",
      );
    }
    console.log(c.yellow(`! Breaking changes, allowed by --allow-breaking:\n${list}`));
  } else {
    console.log(`${c.green("✓")} Compatible with the version last shipped (${basename(path)}).`);
  }
  return api;
}

function writeLock(root, args, api) {
  if (!api) return;
  const lock = {
    note:
      "Written by `actors deploy` / `actors upload`: the actor API last shipped. Commit it. " +
      "The next deploy is checked against it so callers on the previous version keep working.",
    ...api,
  };
  writeFileSync(lockPath(root, args), `${JSON.stringify(lock, null, 2)}\n`);
}

const OWN_FLAGS = ["--allow-breaking"];
const wranglerArgs = (args) => args.filter((a) => !OWN_FLAGS.includes(a));

async function ship(root, passthrough, mode) {
  const { actors } = generate(root);
  if (!actors.length) console.log(c.yellow("Warning: deploying with no actors defined."));
  const prod = readFileSync(join(root, PROD_ENTRY), "utf8");
  if (prod.includes("actors-poc/dev")) throw new CliError("Refusing to deploy: production entry imports dev tooling.");
  const api = await checkCompatibility(root, actors, passthrough, mode);
  const cmd = mode === "upload" ? ["versions", "upload"] : ["deploy"];
  const child = runWrangler(root, [...cmd, ...wranglerArgs(passthrough)]);
  child.on("exit", (code) => {
    if (code === 0) {
      if (!passthrough.includes("--dry-run")) writeLock(root, passthrough, api);
      console.log(
        mode === "upload"
          ? `\n${c.green("✓")} Uploaded. Roll it out with "npx wrangler versions deploy". Each call records the code version that ran it.`
          : `\n${c.green("✓")} Deployed with ${actors.length} actor type(s). The Actor Explorer is not included in production builds.`,
      );
    } else {
      console.error(c.red(`\nwrangler ${cmd.join(" ")} failed (exit ${code}). If this is an authentication error, run "npx wrangler login".`));
    }
    process.exit(code ?? 1);
  });
}

async function check(root, args) {
  const { actors } = generate(root, { quiet: true });
  await checkCompatibility(root, actors, args, "check");
}

async function devApi(port, path) {
  const url = `http://localhost:${port}/__actors/api${path}`;
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new CliError(`Could not reach the dev server at http://localhost:${port}. Is "actors dev" running? (use --port to change)`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new CliError(body?.error ?? `${res.status} ${res.statusText}`);
  return body;
}

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(ts).toLocaleString();
}

async function inspect(args) {
  const [type, key] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--port");
  if (!type || !key) throw new CliError("Usage: actors inspect <Type> <key> [--port 8787] [--json]");
  const port = flagValue(args, "--port") ?? "8787";
  const types = await devApi(port, "/types");
  if (!types.some((t) => t.name === type)) {
    throw new CliError(`Unknown actor type "${type}". Known: ${types.map((t) => t.name).join(", ") || "(none)"}`);
  }
  const d = await devApi(port, `/actors/${encodeURIComponent(type)}/${encodeURIComponent(key)}`);
  if (args.includes("--json")) return console.log(JSON.stringify(d, null, 2));

  const schema = !d.exists ? "" : d.schema > d.latestSchema
    ? c.red(` schema ${d.schema}: saved by newer code (this code defines ${d.latestSchema} migrations)`)
    : d.schema < d.latestSchema ? c.yellow(` schema ${d.schema} → ${d.latestSchema} on next call`) : c.dim(` schema ${d.schema}`);
  console.log(`${c.bold(`${d.actor}("${d.key}")`)}  ${d.exists ? c.dim(`rev ${d.version} · created ${ago(d.createdAt)} · updated ${ago(d.updatedAt)} ·`) + schema : c.yellow("not created (no committed state)")}`);
  if (d.exists) {
    console.log(`\n${c.bold("State")}${d.redacted?.length ? c.dim(` (redacted: ${d.redacted.join(", ")})`) : ""}`);
    console.log(JSON.stringify(d.state, null, 2).replace(/^/gm, "  "));
  }
  console.log(`\n${c.bold("Recent invocations")} ${c.dim(`(${d.invocations.length})`)}`);
  if (!d.invocations.length) console.log(c.dim("  none recorded"));
  const shown = d.invocations.slice(0, 15);
  shown.forEach((inv, n) => {
    const mark = inv.ok ? c.green("✓") : c.red("✗");
    const call = inv.source === "migration"
      ? `${c.bold("migrate")} schema ${inv.migratedFrom} → ${inv.ok ? inv.schema : "?"}`
      : `${c.bold(inv.method)}(${inv.args ? inv.args.slice(1, -1) : "…"})`;
    const effect = inv.ok ? (inv.changed ? `changed ${inv.changedKeys.join(", ")}` : "no change") : "rolled back";
    const code = inv.codeVersion ? ` · code ${inv.codeVersion}` : "";
    const skew = inv.callerVersion && inv.codeVersion && inv.callerVersion !== inv.codeVersion ? c.yellow(` called from ${inv.callerVersion}`) : "";
    console.log(`  ${mark} ${call}  ${c.dim(`${inv.durationMs}ms · ${inv.source} · ${ago(inv.ts)} · ${effect}${code} · #${inv.invocation}`)}${skew}`);
    if (inv.error) {
      console.log(`      ${c.red(`${inv.error.name}: ${inv.error.message}`)}${inv.error.code ? c.dim(` [${inv.error.code}]`) : ""}`);
      const frames = (inv.error.stack ?? "").split("\n").slice(1, 4).map((l) => l.trim());
      for (const f of frames) console.log(c.dim(`        ${f}`));
    }
    for (const l of inv.logs) console.log(c.dim(`      log: ${l}`));
    const older = shown[n + 1];
    if (older?.codeVersion && inv.codeVersion && older.codeVersion !== inv.codeVersion) {
      console.log(c.dim(`  ── new code version: ${older.codeVersion} → ${inv.codeVersion} ──`));
    }
  });
  if (d.schedules.length) {
    console.log(`\n${c.bold("Scheduled")}`);
    for (const s of d.schedules) console.log(`  ${s.action}(${JSON.stringify(s.args).slice(1, -1)}) ${c.dim(`at ${new Date(s.at).toLocaleTimeString()}`)}`);
  }
  const L = d.lifecycle;
  if (!L) {
    console.log(c.dim("\nNo instance with this key exists in local storage. (Inspecting does not create one.)"));
    return;
  }
  console.log(`\n${c.bold("Storage")}  state ${d.storage.stateBytes} B · SQLite ${d.storage.databaseSizeBytes} B`);
  console.log(`${c.bold("Runtime")}  code ${L.codeVersion} · instance started ${ago(L.instanceStartedAt)} · ${L.activeAction ? `running ${L.activeAction.method} for ${Math.round((Date.now() - L.activeAction.since) / 1000)}s` : "idle"} · ${L.queuedActions} queued · next alarm ${L.nextAlarm ? new Date(L.nextAlarm).toLocaleTimeString() : "none"}`);
  console.log(c.dim(`         DO id ${L.durableObjectId} · persisted data read via Wrangler's Local Explorer`));
  if (L.connections?.length) {
    console.log(`${c.bold("Connections")} ${L.connections.length} open`);
    for (const k of L.connections) console.log(`  ${k.id.slice(0, 8)}  ${c.dim(`${ago(k.connectedAt)} · ${JSON.stringify(k.data)}`)}`);
  }
}

async function list(args) {
  const port = flagValue(args, "--port") ?? "8787";
  const [types, instances] = await Promise.all([devApi(port, "/types"), devApi(port, "/instances")]);
  if (args.includes("--json")) return console.log(JSON.stringify({ types, instances }, null, 2));
  for (const t of types) {
    console.log(`${c.bold(t.name)} ${c.dim(t.actions.map((a) => `${a.name}(${a.params.join(", ")})`).join("  "))}`);
    const mine = instances.filter((i) => i.actor === t.name);
    if (!mine.length) console.log(c.dim("  (no instances observed)"));
    for (const i of mine) {
      const stats = i.invocations === null ? "stats skipped" : `${i.invocations} recent calls · ${i.errors} errors${i.lastSeen ? ` · last ${ago(i.lastSeen)}` : ""}` +
        `${i.schema != null ? ` · schema ${i.schema}` : ""}${i.codeVersion ? ` · code ${i.codeVersion}` : ""}`;
      console.log(`  ${i.key}  ${c.dim(stats)}`);
    }
  }
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

const HELP = `${c.bold("actors")} — Actors on Cloudflare (PoC)

  actors generate               Discover actors and write config (.actors/, wrangler.jsonc)
  actors dev [wrangler args]    Run locally; Actor Explorer at /__actors
  actors deploy [wrangler args] Check compatibility, then deploy with Wrangler (e.g. --dry-run)
  actors upload [wrangler args] Check compatibility, then upload a version for a gradual deployment
  actors check                  Compare actor APIs and migrations with the version last shipped
  actors inspect <Type> <key>   Show an actor's state, activity and errors (needs actors dev)
  actors list                   List actor types and observed instances (needs actors dev)

Options: --cwd <dir>   project directory (default: current)
         --port <n>    dev server port for inspect/list (default 8787)
         --allow-breaking  deploy/upload even if callers on the previous version would break
`;

async function main() {
  const argv = process.argv.slice(2);
  const cwdFlag = flagValue(argv, "--cwd");
  const root = resolve(cwdFlag ?? process.cwd());
  const args = argv.filter((a, i) => a !== "--cwd" && argv[i - 1] !== "--cwd" && !a.startsWith("--cwd="));
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "generate": return void generate(root);
    case "dev": return dev(root, rest);
    case "deploy": return ship(root, rest, "deploy");
    case "upload": return ship(root, rest, "upload");
    case "check": return check(root, rest);
    case "inspect": return inspect(rest);
    case "list": case "ls": return list(rest);
    case undefined: case "help": case "--help": case "-h": return console.log(HELP);
    default: throw new CliError(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

main().catch((err) => {
  console.error(err instanceof CliError ? c.red(`actors: ${err.message}`) : err);
  process.exit(1);
});
