/**
 * Development-only surface: the Actor Explorer UI and its JSON API, mounted at /__actors.
 * Only the generated dev entry (.actors/entry.dev.ts, used by `actors dev`) imports this module,
 * so production bundles do not contain these routes at all.
 *
 * Data sources:
 *  - Which instances exist, and everything persisted (state, invocation log, schedules), comes
 *    from Wrangler's Local Explorer API (/cdn-cgi/local/explorer/api): it lists every local
 *    Durable Object by name and runs read-only SQL against its storage. No custom index.
 *  - Live runtime info (running action, queue depth, next alarm) comes from the instance itself
 *    via the dev-only `actorRuntime()` RPC, because it isn't in storage.
 *  - Invocations from the console go through the normal actor path (`actorInvoke`).
 */
import type { AnyActor } from "./index.ts";
import {
  describeActors,
  type InspectResult,
  type InvocationRecord,
  type RuntimeInfo,
  toInvocationRecord,
} from "./runtime.ts";
import { BINDING, HOST_CLASS, type InvokeResult } from "./shared.ts";
import { EXPLORER_HTML } from "./explorer-html.ts";

type Handler = { fetch?: (req: Request, env: any, ctx: ExecutionContext) => Response | Promise<Response> } & Record<
  string,
  unknown
>;

export interface DevWorkerOptions {
  /** Worker name from wrangler.jsonc; picks the right namespaces when several Workers run together. */
  workerName?: string;
  /** Raw Durable Object classes discovered by `actors generate`: class name → binding name. */
  objects?: Record<string, string>;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const LOCAL_EXPLORER_PATH = "/cdn-cgi/local/explorer/api";
/** Per-instance stats need one SQL query each; past this many instances the list shows names only. */
const STATS_LIMIT = 200;

export function createDevWorker(
  registry: Record<string, AnyActor>,
  userWorker: Handler | undefined,
  options: DevWorkerOptions = {},
) {
  return {
    ...(userWorker ?? {}),
    async fetch(req: Request, env: Record<string, unknown>, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/__actors" || url.pathname.startsWith("/__actors/")) {
        if (!LOCAL_HOSTS.has(url.hostname)) {
          return json({ error: "The Actor Explorer is only served on localhost." }, 403);
        }
        try {
          return await explorer(req, url, env, registry, options);
        } catch (err) {
          return json({ error: (err as Error).message, stack: (err as Error).stack }, 500);
        }
      }
      if (typeof userWorker?.fetch !== "function") {
        return new Response(
          "No fetch handler. Add `export default { fetch(req) { ... } }` to src/index.ts.\n" +
            "Actor Explorer: /__actors\n",
          { status: 404 },
        );
      }
      return userWorker.fetch.call(userWorker, req, env, ctx);
    },
  };
}

// ───────────────────────────── Wrangler Local Explorer client ─────────────────────────────

interface LocalObject {
  id: string;
  name?: string;
  hasStoredData: boolean;
}

type Row = Record<string, SqlStorageValue>;

class LocalExplorer {
  constructor(
    private readonly base: string,
    private readonly workerName: string | undefined,
  ) {}

  #namespaces = new Map<string, string>();

  async #call<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + path, init);
    } catch (err) {
      throw this.#unavailable(String(err));
    }
    const body = (await res.json().catch(() => null)) as
      | { success: boolean; result: T; errors?: { message: string }[]; result_info?: { cursor?: string } }
      | null;
    if (!body) throw this.#unavailable(`${res.status} ${res.statusText}`);
    if (!res.ok || !body.success) {
      throw new Error(`Wrangler Local Explorer ${path}: ${body.errors?.[0]?.message ?? `${res.status} ${res.statusText}`}`);
    }
    return body as T;
  }

  #unavailable(detail: string) {
    return new Error(
      `The Actor Explorer reads local storage through Wrangler's Local Explorer API (${LOCAL_EXPLORER_PATH}), ` +
        `which did not respond (${detail}). Use Wrangler 4.163 or later, and make sure X_LOCAL_EXPLORER is not set to false.`,
    );
  }

  async namespaceId(className: string = HOST_CLASS): Promise<string> {
    const cached = this.#namespaces.get(className);
    if (cached) return cached;
    const body = await this.#call<{ result: { id: string; class: string; script: string }[] }>(
      "/workers/durable_objects/namespaces",
    );
    const candidates = body.result.filter((n) => n.class === className);
    const match =
      candidates.find((n) => n.script === this.workerName) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!match) {
      throw new Error(
        `No ${className} namespace for Worker "${this.workerName ?? "?"}" in Wrangler's Local Explorer ` +
          `(found: ${candidates.map((h) => h.script).join(", ") || "none"}). Run "actors generate".`,
      );
    }
    this.#namespaces.set(className, match.id);
    return match.id;
  }

  /** Every object of a class (default: the ActorHost namespace) that has local storage. */
  async objects(className: string = HOST_CLASS): Promise<LocalObject[]> {
    const ns = await this.namespaceId(className);
    const all: LocalObject[] = [];
    let cursor = "";
    do {
      const qs = `?limit=10000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const body = await this.#call<{ result: LocalObject[]; result_info?: { cursor?: string } }>(
        `/workers/durable_objects/namespaces/${encodeURIComponent(ns)}/objects${qs}`,
      );
      all.push(...body.result);
      cursor = body.result_info?.cursor ?? "";
    } while (cursor);
    return all;
  }

  /**
   * Run read-only SQL against one object, by name. Note: this instantiates the object, and
   * an object that never existed gets (empty) storage. Callers check `objects()` first.
   */
  async query(
    target: string | { className: string; id: string },
    queries: { sql: string; params?: unknown[] }[],
  ): Promise<Row[][]> {
    const byId = typeof target !== "string";
    const ns = await this.namespaceId(byId ? target.className : HOST_CLASS);
    const body = await this.#call<{ result: { columns: string[]; rows: SqlStorageValue[][] }[] }>(
      `/workers/durable_objects/namespaces/${encodeURIComponent(ns)}/query`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(byId ? { durable_object_id: target.id, queries } : { durable_object_name: target, queries }),
      },
    );
    return body.result.map((r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))));
  }
}

/** Parse "<Type>:<key>" object names. Objects named any other way are not actors. */
function parseName(name: string | undefined, registry: Record<string, AnyActor>) {
  if (!name) return null;
  const i = name.indexOf(":");
  if (i <= 0) return null;
  const actor = name.slice(0, i);
  return registry[actor] ? { actor, key: name.slice(i + 1) } : null;
}

const STATS_SQL = `SELECT
  (SELECT created_at FROM _actor_state) AS created_at,
  (SELECT updated_at FROM _actor_state) AS updated_at,
  (SELECT schema FROM _actor_state) AS schema,
  (SELECT code_version FROM _actor_log ORDER BY id DESC LIMIT 1) AS code_version,
  (SELECT COUNT(*) FROM _actor_log) AS invocations,
  (SELECT COUNT(*) FROM _actor_log WHERE ok = 0) AS errors,
  (SELECT MIN(ts) FROM _actor_log) AS first_ts,
  (SELECT MAX(ts) FROM _actor_log) AS last_ts`;

async function listInstances(le: LocalExplorer, registry: Record<string, AnyActor>) {
  const objects = (await le.objects())
    .filter((o) => o.hasStoredData !== false)
    .map((o) => ({ o, id: parseName(o.name, registry) }))
    .filter((x): x is { o: LocalObject; id: { actor: string; key: string } } => !!x.id);

  const withStats = await mapLimit(objects, 16, async ({ o, id }, i) => {
    if (i >= STATS_LIMIT) {
      return { ...id, exists: null, firstSeen: null, lastSeen: null, invocations: null, errors: null, schema: null, codeVersion: null };
    }
    let r: Row | undefined;
    try {
      r = (await le.query(o.name!, [{ sql: STATS_SQL }]))[0][0];
    } catch {
      r = undefined; // not created by this runtime (e.g. tables missing): list it without stats
    }
    const num = (v: SqlStorageValue | undefined) => (v == null ? null : Number(v));
    const first = [num(r?.created_at), num(r?.first_ts)].filter((x): x is number => x !== null);
    const last = [num(r?.updated_at), num(r?.last_ts)].filter((x): x is number => x !== null);
    if (r && r.created_at == null && !Number(r.invocations)) return null; // empty (e.g. wiped)
    return {
      ...id,
      exists: r?.created_at != null,
      firstSeen: first.length ? Math.min(...first) : null,
      lastSeen: last.length ? Math.max(...last) : null,
      invocations: num(r?.invocations) ?? 0,
      errors: num(r?.errors) ?? 0,
      /** Migrations the state has run. */
      schema: num(r?.schema),
      /** Code version of the most recent logged call. */
      codeVersion: r?.code_version == null ? null : String(r.code_version),
    };
  });
  return withStats.filter((x) => x !== null).sort(
    (a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0) || a.actor.localeCompare(b.actor) || a.key.localeCompare(b.key),
  );
}

async function inspect(
  le: LocalExplorer,
  stub: { actorRuntime(): Promise<RuntimeInfo> },
  registry: Record<string, AnyActor>,
  actor: string,
  key: string,
): Promise<InspectResult> {
  const name = `${actor}:${key}`;
  const note =
    "instanceStartedAt changes when the runtime evicts or restarts this instance. " +
    "Eviction and placement events are not otherwise observable from inside the runtime.";
  const known = (await le.objects()).some((o) => o.name === name);
  if (!known) {
    // Don't query: that would create an empty object for a key that was never used.
    return {
      exists: false, actor, key, latestSchema: latestSchema(registry, actor), invocations: [], schedules: [],
      storage: { databaseSizeBytes: 0, stateBytes: 0 }, lifecycle: null,
      source: "wrangler-local-explorer",
    };
  }

  const [[stateRow], logRows, scheduleRows] = await le.query(name, [
    { sql: "SELECT state, version, schema, created_at, updated_at, length(CAST(state AS BLOB)) AS bytes FROM _actor_state" },
    { sql: "SELECT * FROM _actor_log ORDER BY id DESC LIMIT 50" },
    { sql: "SELECT id, at, action, args, attempts FROM _actor_schedule ORDER BY at" },
  ]);
  const runtime = await stub.actorRuntime();

  const redact = (registry[actor]?.__config.redact?.state ?? []) as string[];
  let state: unknown;
  if (stateRow) {
    state = JSON.parse(String(stateRow.state));
    if (state && typeof state === "object") for (const k of redact) if (k in state) (state as any)[k] = "[redacted]";
  }
  const { databaseSizeBytes, ...lifecycle } = runtime;
  return {
    exists: !!stateRow,
    actor,
    key,
    state,
    redacted: redact,
    version: stateRow ? Number(stateRow.version) : undefined,
    schema: stateRow ? Number(stateRow.schema ?? 0) : undefined,
    latestSchema: latestSchema(registry, actor),
    createdAt: stateRow ? Number(stateRow.created_at) : undefined,
    updatedAt: stateRow ? Number(stateRow.updated_at) : undefined,
    invocations: logRows.map((r): InvocationRecord => toInvocationRecord(r)),
    schedules: scheduleRows.map((r) => ({
      id: String(r.id),
      at: Number(r.at),
      action: String(r.action),
      args: JSON.parse(String(r.args)),
      attempts: Number(r.attempts),
    })),
    storage: { databaseSizeBytes, stateBytes: stateRow ? Number(stateRow.bytes) : 0 },
    lifecycle: { ...lifecycle, note },
    source: "wrangler-local-explorer",
  };
}

function latestSchema(registry: Record<string, AnyActor>, actor: string) {
  return registry[actor]?.__config.migrations?.length ?? 0;
}

// ───────────────────────────── raw Durable Objects (read-only) ─────────────────────────────

const HIDDEN_TABLE = /^(sqlite_|_cf_|__miniflare)/;
const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function listObjects(le: LocalExplorer, objects: Record<string, string>) {
  return Promise.all(
    Object.entries(objects)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([className, binding]) => {
        try {
          const instances = (await le.objects(className))
            .filter((o) => o.hasStoredData !== false)
            .map((o) => ({ id: o.id, name: o.name ?? null }))
            .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
          return { class: className, binding, instances };
        } catch (err) {
          // A class with no instances yet may not have a namespace in the Local Explorer.
          return { class: className, binding, instances: [], note: (err as Error).message };
        }
      }),
  );
}

/** Only objects that already exist are queried: a query instantiates (and for unknown ids, creates) the object. */
async function findObject(le: LocalExplorer, className: string, id: string) {
  const found = (await le.objects(className)).find((o) => o.id === id);
  if (!found) throw new HttpError(404, `No ${className} object with id ${id} in local storage.`);
  return found;
}

async function inspectObject(le: LocalExplorer, className: string, binding: string, id: string) {
  const obj = await findObject(le, className, id);
  const target = { className, id };
  const [tables] = await le.query(target, [{ sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name" }]);
  const names = tables.map((t) => String(t.name)).filter((n) => !HIDDEN_TABLE.test(n));
  const counts = names.length
    ? await le.query(target, names.map((n) => ({ sql: `SELECT COUNT(*) AS n FROM ${quoteIdent(n)}` })))
    : [];
  return {
    class: className,
    binding,
    id,
    name: obj.name ?? null,
    tables: names.map((name, i) => ({ name, rows: Number(counts[i]?.[0]?.n ?? 0) })),
    note:
      "Read-only. Reads go through Wrangler's Local Explorer, which runs them inside the object: " +
      "opening an object starts it (its constructor runs) if it wasn't running.",
  };
}

async function readTable(le: LocalExplorer, className: string, id: string, table: string, limit: number, offset: number) {
  await findObject(le, className, id);
  const target = { className, id };
  const [tables] = await le.query(target, [{ sql: "SELECT name FROM sqlite_master WHERE type = 'table'" }]);
  if (!tables.some((t) => t.name === table) || HIDDEN_TABLE.test(table)) throw new HttpError(404, `No table "${table}".`);
  const q = quoteIdent(table);
  let rows: Row[];
  try {
    [rows] = await le.query(target, [{ sql: `SELECT * FROM ${q} ORDER BY rowid DESC LIMIT ? OFFSET ?`, params: [limit, offset] }]);
  } catch {
    [rows] = await le.query(target, [{ sql: `SELECT * FROM ${q} LIMIT ? OFFSET ?`, params: [limit, offset] }]); // WITHOUT ROWID
  }
  const [[total]] = await le.query(target, [{ sql: `SELECT COUNT(*) AS n FROM ${q}` }]);
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return {
    table,
    total: Number(total?.n ?? 0),
    offset,
    columns,
    rows: rows.map((r) => columns.map((c) => preview(r[c]))),
  };
}

function preview(v: unknown): unknown {
  if (typeof v === "string" && v.length > 400) return `${v.slice(0, 400)}… (${v.length} chars)`;
  if (Array.isArray(v) || v instanceof ArrayBuffer) return `[blob ${(v as ArrayLike<unknown>).length ?? (v as ArrayBuffer).byteLength} bytes]`;
  return v;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ───────────────────────────── routes ─────────────────────────────

async function explorer(
  req: Request,
  url: URL,
  env: Record<string, unknown>,
  registry: Record<string, AnyActor>,
  options: DevWorkerOptions,
) {
  const ns = env[BINDING] as DurableObjectNamespace;
  const stub = (name: string) => ns.get(ns.idFromName(name)) as any;
  const le = new LocalExplorer(url.origin + LOCAL_EXPLORER_PATH, options.workerName);
  const path = url.pathname.replace(/^\/__actors\/?/, "");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);

  if (parts.length === 0) {
    return new Response(EXPLORER_HTML, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (parts[0] !== "api") return json({ error: "Not found" }, 404);

  // GET /__actors/api/types
  if (parts[1] === "types" && req.method === "GET") {
    return json(describeActors(registry));
  }
  // GET /__actors/api/instances
  if (parts[1] === "instances" && req.method === "GET") {
    return json(await listInstances(le, registry));
  }
  const objects = options.objects ?? {};
  // GET /__actors/api/objects
  if (parts[1] === "objects" && !parts[2] && req.method === "GET") {
    return json(await listObjects(le, objects));
  }
  // GET /__actors/api/objects/:class/:id[/tables/:table]
  if (parts[1] === "objects" && parts[2] && parts[3] && req.method === "GET") {
    const [, , className, id, sub, table] = parts;
    if (!objects[className]) return json({ error: `Unknown Durable Object class "${className}"` }, 404);
    try {
      if (!sub) return json(await inspectObject(le, className, objects[className], id));
      if (sub === "tables" && table) {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
        return json(await readTable(le, className, id, table, limit, offset));
      }
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      throw err;
    }
  }
  // /__actors/api/actors/:type/:key[/invoke]
  if (parts[1] === "actors" && parts[2] && parts[3]) {
    const [, , type, key, op] = parts;
    if (!registry[type]) return json({ error: `Unknown actor type "${type}"` }, 404);
    const s = stub(`${type}:${key}`);
    if (!op && req.method === "GET") {
      return json(await inspect(le, s, registry, type, key));
    }
    if (!op && req.method === "DELETE") {
      await s.actorWipe();
      return json({ ok: true });
    }
    if (op === "invoke" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { method?: unknown; args?: unknown } | null;
      if (!body || typeof body.method !== "string") return json({ error: 'Body must be {"method": string, "args": []}' }, 400);
      const args = body.args ?? [];
      if (!Array.isArray(args)) return json({ error: "args must be a JSON array" }, 400);
      const started = Date.now();
      const result: InvokeResult = await s.actorInvoke({ actor: type, key, method: body.method, args, source: "explorer" });
      return json({ ...result, durationMs: Date.now() - started });
    }
  }
  return json({ error: "Not found" }, 404);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
