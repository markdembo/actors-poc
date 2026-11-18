/**
 * The generic actor runtime: ONE Durable Object class that hosts every actor type.
 *
 * Why one class? Adding, renaming or removing an actor type then never needs a Durable
 * Object migration — the only migration is the one that creates `ActorHost`. Instances are
 * named "<Type>:<key>", so different actor types never share an instance.
 *
 * Storage layout (SQLite, per instance):
 *   _actor_state     one row: type, key, JSON state document, version (commit counter),
 *                    schema (how many of the actor's migrations it has run), timestamps
 *   _actor_log       ring buffer of recent invocations (instrumentation)
 *   _actor_schedule  pending scheduled actions (driven by the DO alarm)
 */
import { DurableObject } from "cloudflare:workers";
import type { ActionContext, AnyActor, BroadcastOptions, Connection, ConnectionInfo } from "./index.ts";
import {
  ActorError,
  codeVersion,
  describeParams,
  findJsonProblem,
  HEADER_ACTOR,
  HEADER_DATA,
  HEADER_KEY,
  type InvokeRequest,
  type InvokeResult,
  type SerializedError,
  serializeError,
} from "./shared.ts";

export type InstrumentationLevel = "all" | "errors" | "off";

export interface HostOptions {
  /** Enables the dev-only RPC (actorRuntime). The generated dev entry sets this; the deploy entry does not. */
  dev?: boolean;
  /** What goes into the per-instance invocation log table. Default: "all" in dev, "errors" in production. Override with the ACTORS_INSTRUMENTATION var. */
  instrumentation?: InstrumentationLevel;
  /** Which calls emit a structured log line (Workers Logs). Default: "all" in production, "errors" in dev. Override with the ACTORS_LOGS var. */
  logs?: InstrumentationLevel;
}

const LOG_LIMIT = 100;
const MAX_STATE_BYTES = 2_000_000; // Conservative PoC limit (Durable Objects SQLite allows 8 MB per value); every change rewrites the whole document
const MAX_SCHEDULE_ATTEMPTS = 3;
const ARG_PREVIEW_CHARS = 2_000;
/** A scheduled action that fails because of a version mismatch waits this long and is not counted as an attempt. */
const VERSION_RETRY_MS = 60_000;

interface StateRow {
  actor: string;
  key: string;
  json: string;
  version: number;
  /** How many of the actor's migrations this state has run. */
  schema: number;
  createdAt: number;
  updatedAt: number;
}

/** Stored on each hibernatable WebSocket (serializeAttachment), so it survives hibernation. */
interface Attachment {
  id: string;
  actor: string;
  key: string;
  data: unknown;
  at: number;
}

/** Messages queued by an invocation; delivered only after it commits. */
type Outgoing =
  | { kind: "send"; payload: string; only?: string[]; except?: string[] }
  | { kind: "close"; id: string; code?: number; reason?: string };

type HookName = "onConnect" | "onMessage" | "onClose";

interface HookCall {
  name: HookName;
  conn: Attachment;
  args: unknown[];
  /** Connection to leave out of ctx.connections() (the one closing). */
  excludeId?: string;
  /** Runs after the commit, before queued messages are sent (onConnect: accept the socket). */
  afterCommit?: () => void;
}

type ScheduleOp =
  | { op: "add"; id: string; at: number; action: string; args: string }
  | { op: "cancel"; id: string };

export interface InvocationRecord {
  id: number;
  invocation: string;
  ts: number;
  method: string;
  source: string;
  args: string | null;
  durationMs: number;
  ok: boolean;
  changed: boolean;
  changedKeys: string[];
  version: number;
  /** State schema after this invocation (number of migrations run). */
  schema: number;
  /** Set on migration entries: the schema the state had before. */
  migratedFrom: number | null;
  /** Code version that ran this invocation (version tag, or the start of the version id). */
  codeVersion: string | null;
  /** Code version of the Worker that made the call, when it sent one. */
  callerVersion: string | null;
  error: SerializedError | null;
  logs: string[];
}

/** Live diagnostics only the running instance knows. Persisted data is read through Wrangler's Local Explorer. */
export interface RuntimeInfo {
  durableObjectId: string;
  /** Code version this instance is running now. */
  codeVersion: string;
  instanceStartedAt: number;
  activeAction: { method: string; since: number } | null;
  queuedActions: number;
  nextAlarm: number | null;
  databaseSizeBytes: number;
  connections: { id: string; data: unknown; connectedAt: number }[];
}

export interface InspectResult {
  exists: boolean;
  actor: string;
  key: string;
  state?: unknown;
  redacted?: string[];
  version?: number;
  /** Migrations this state has run. */
  schema?: number;
  /** Migrations the actor's current code defines. Less than `schema`: saved by newer code. More: migrates on its next call. */
  latestSchema: number;
  createdAt?: number;
  updatedAt?: number;
  invocations: InvocationRecord[];
  schedules: { id: string; at: number; action: string; args: unknown[]; attempts: number }[];
  storage: { databaseSizeBytes: number; stateBytes: number };
  /** null when the instance has never been created (it is not instantiated just to look at it). */
  lifecycle: (Omit<RuntimeInfo, "databaseSizeBytes"> & { note: string }) | null;
  /** Where persisted data came from. */
  source: "wrangler-local-explorer";
}

export interface ActorTypeInfo {
  name: string;
  actions: { name: string; params: string[] }[];
  hasOnCreate: boolean;
  /** Number of migrations: the schema new and migrated instances are at. */
  schema: number;
  redact: { state: string[]; args: string[] };
}

export function registerActors(registry: Record<string, AnyActor>) {
  for (const [name, def] of Object.entries(registry)) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name) || name.startsWith("__")) {
      throw new ActorError(`Invalid actor name "${name}"`, { kind: "config" });
    }
    def.__register(name);
  }
}

export function describeActors(registry: Record<string, AnyActor>): ActorTypeInfo[] {
  return Object.entries(registry)
    .map(([name, def]) => ({
      name,
      actions: Object.entries(def.__config.actions).map(([a, fn]) => ({ name: a, params: describeParams(fn) })),
      hasOnCreate: typeof def.__config.onCreate === "function",
      schema: def.__config.migrations?.length ?? 0,
      redact: {
        state: (def.__config.redact?.state ?? []) as string[],
        args: (def.__config.redact?.args ?? []) as string[],
      },
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function createHost(registry: Record<string, AnyActor>, options: HostOptions = {}) {
  registerActors(registry);
  const dev = !!options.dev;

  return class ActorHost extends DurableObject<Record<string, unknown>> {
    #queue: Promise<unknown> = Promise.resolve();
    #queued = 0;
    #active: { method: string; since: number } | null = null;
    #row: StateRow | null | undefined; // undefined = not loaded yet
    /** Tables are created on first use, not in the constructor, so touching an instance (or deleting one) leaves no storage behind. */
    #tables = false;
    /** Bumped when the instance is deleted, so work queued before the delete (due schedules) is dropped. */
    #generation = 0;
    readonly #startedAt = Date.now();
    readonly #level: InstrumentationLevel;
    readonly #logs: InstrumentationLevel;
    readonly #code: string;

    constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
      super(ctx, env);
      this.#level = level(env.ACTORS_INSTRUMENTATION) ?? options.instrumentation ?? (dev ? "all" : "errors");
      this.#logs = level(env.ACTORS_LOGS) ?? options.logs ?? (dev ? "errors" : "all");
      this.#code = codeVersion(env);
    }

    #ensureTables() {
      if (this.#tables) return;
      const sql = this.ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS _actor_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        actor TEXT NOT NULL, key TEXT NOT NULL, state TEXT NOT NULL,
        version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS _actor_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, inv TEXT NOT NULL, ts INTEGER NOT NULL,
        method TEXT NOT NULL, source TEXT NOT NULL, args TEXT, duration_ms INTEGER NOT NULL,
        ok INTEGER NOT NULL, changed INTEGER NOT NULL, changed_keys TEXT NOT NULL,
        version INTEGER NOT NULL, error TEXT, logs TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS _actor_schedule (
        id TEXT PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL,
        args TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)`);
      // Columns added after the first release. Instances created before have none of them.
      addColumns(sql, "_actor_state", { schema: "INTEGER NOT NULL DEFAULT 0" });
      addColumns(sql, "_actor_log", {
        schema: "INTEGER",
        migrated_from: "INTEGER",
        code_version: "TEXT",
        caller_version: "TEXT",
      });
      this.#tables = true;
    }

    // ───────────────────────────── public RPC ─────────────────────────────

    /** Run one action. Never throws for application errors: returns an envelope. */
    async actorInvoke(req: InvokeRequest): Promise<InvokeResult> {
      return this.#enqueue(req.method, () => this.#run(req));
    }

    /**
     * Dev only: live diagnostics that are not in storage. Not queued, so it answers while an
     * action is running or stuck. Persisted state, the invocation log and schedules are read
     * by dev tooling straight from SQLite through Wrangler's Local Explorer instead.
     */
    async actorRuntime(): Promise<RuntimeInfo> {
      this.#requireDev();
      return {
        durableObjectId: this.ctx.id.toString(),
        codeVersion: this.#code,
        instanceStartedAt: this.#startedAt,
        activeAction: this.#active,
        queuedActions: Math.max(0, this.#queued - (this.#active ? 1 : 0)),
        nextAlarm: await this.ctx.storage.getAlarm(),
        databaseSizeBytes: this.ctx.storage.sql.databaseSize,
        connections: this.#attachments().map((a) => ({ id: a.id, data: a.data, connectedAt: a.at })),
      };
    }

    /**
     * Delete this instance (`Actor.delete(key)`, the Explorer's delete button). Queued like an action, so it
     * waits for the running one. Returns `{ ok: true, value: existed }`.
     */
    async actorDelete(req: { actor: string; key: string; callerVersion?: string; source?: InvokeRequest["source"] }): Promise<InvokeResult> {
      return this.#enqueue("delete", async () => {
        const started = Date.now();
        const entry: InvokeRequest = { ...req, method: "delete", args: [], source: req.source ?? "rpc" };
        const row = this.#hasTables() ? this.#load() : null;
        if (row && (row.actor !== req.actor || row.key !== req.key)) {
          const error: SerializedError = {
            name: "ActorError",
            kind: "config",
            message: `Identity mismatch: this instance belongs to ${row.actor}("${row.key}")`,
          };
          this.#emit("delete", entry, crypto.randomUUID().slice(0, 8), started, { ok: false, error });
          return { ok: false, error };
        }
        await this.#wipe();
        this.#emit("delete", entry, crypto.randomUUID().slice(0, 8), started, { ok: true, deleted: !!row });
        return { ok: true, value: !!row };
      });
    }

    // ───────────────────────────── WebSockets (hibernation API) ─────────────────────────────

    /** WebSocket upgrades forwarded by `Actor.connect()` in the Worker. */
    override async fetch(request: Request): Promise<Response> {
      const actor = request.headers.get(HEADER_ACTOR);
      const def = actor ? registry[actor] : undefined;
      if (!actor || !def) return new Response("Use Actor.connect(key, request) to open WebSockets.\n", { status: 400 });
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected a WebSocket upgrade.\n", { status: 426 });
      }
      const key = decodeURIComponent(request.headers.get(HEADER_KEY) ?? "");
      const data = JSON.parse(decodeURIComponent(request.headers.get(HEADER_DATA) ?? "null"));
      const { 0: client, 1: server } = new WebSocketPair();
      const conn: Attachment = { id: crypto.randomUUID(), actor, key, data, at: Date.now() };
      const accept = () => {
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment(conn);
      };

      if (!def.__config.connections?.onConnect) {
        accept();
      } else {
        const req: InvokeRequest = { actor, key, method: "onConnect", args: [conn.id], source: "websocket" };
        const result = await this.#enqueue("onConnect", () =>
          this.#run(req, undefined, { name: "onConnect", conn, args: [], afterCommit: accept }),
        );
        if (!result.ok) {
          // Refused (or failed) before the upgrade: the client gets an HTTP error, no socket opens.
          const status = result.error.kind === "action" ? 403 : 500;
          return Response.json({ error: result.error.message, code: result.error.code }, { status });
        }
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
      const conn = attachmentOf(ws);
      if (!conn || !registry[conn.actor]?.__config.connections?.onMessage) return;
      const preview = typeof message === "string" ? message : `[binary ${message.byteLength} bytes]`;
      const req: InvokeRequest = { actor: conn.actor, key: conn.key, method: "onMessage", args: [preview], source: "websocket" };
      await this.#enqueue("onMessage", () => this.#run(req, undefined, { name: "onMessage", conn, args: [message] }));
    }

    override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
      try {
        ws.close(code, reason); // complete the closing handshake; throws for reserved codes (1005/1006)
      } catch {}
      await this.#closed(ws, { code, reason, wasClean });
    }

    override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
      await this.#closed(ws, { code: 1006, reason: String((error as Error)?.message ?? error), wasClean: false });
    }

    readonly #closedIds = new Set<string>();

    async #closed(ws: WebSocket, info: { code: number; reason: string; wasClean: boolean }) {
      const conn = attachmentOf(ws);
      if (!conn || this.#closedIds.has(conn.id)) return; // error + close: run onClose once
      this.#closedIds.add(conn.id);
      if (!registry[conn.actor]?.__config.connections?.onClose) return;
      const req: InvokeRequest = {
        actor: conn.actor,
        key: conn.key,
        method: "onClose",
        args: [conn.id, info.code],
        source: "websocket",
      };
      await this.#enqueue("onClose", () =>
        this.#run(req, undefined, { name: "onClose", conn, args: [info], excludeId: conn.id }),
      );
    }

    #attachments(excludeId?: string): Attachment[] {
      const out: Attachment[] = [];
      for (const ws of this.ctx.getWebSockets()) {
        const a = attachmentOf(ws);
        if (a && a.id !== excludeId && !this.#closedIds.has(a.id)) out.push(a);
      }
      return out;
    }

    /** Deliver messages queued by a committed invocation. Sockets that went away are skipped. */
    #flush(outbox: Outgoing[]) {
      if (!outbox.length) return;
      const sockets = this.ctx.getWebSockets().map((ws) => ({ ws, id: attachmentOf(ws)?.id }));
      for (const o of outbox) {
        if (o.kind === "close") {
          for (const s of sockets) {
            if (s.id !== o.id) continue;
            try {
              s.ws.close(o.code ?? 1000, o.reason ?? "");
            } catch {}
          }
          continue;
        }
        for (const s of sockets) {
          if (!s.id || this.#closedIds.has(s.id)) continue;
          if (o.only && !o.only.includes(s.id)) continue;
          if (o.except?.includes(s.id)) continue;
          try {
            s.ws.send(o.payload);
          } catch {}
        }
      }
    }

    /** Durable Object alarm: run due scheduled actions through the normal (queued, transactional) path. */
    override async alarm(): Promise<void> {
      if (!this.#hasTables()) return; // deleted, or never created
      const row = this.#load();
      if (!row) return;
      const gen = this.#generation;
      const due = this.ctx.storage.sql
        .exec(`SELECT id, action, args FROM _actor_schedule WHERE at <= ? ORDER BY at`, Date.now())
        .toArray();
      for (const s of due) {
        await this.#enqueue(String(s.action), async () => {
          // Re-check when its turn comes: an earlier run may have cancelled it, or deleted the instance.
          if (this.#generation !== gen) return;
          if (!this.ctx.storage.sql.exec(`SELECT 1 FROM _actor_schedule WHERE id = ?`, s.id).toArray().length) return;
          await this.#run(
            { actor: row.actor, key: row.key, method: String(s.action), args: JSON.parse(String(s.args)), source: "schedule" },
            String(s.id),
          );
        });
        if (this.#generation !== gen) return; // deleted: nothing left to run or re-arm
      }
      await this.#rearm();
    }

    // ───────────────────────────── internals ─────────────────────────────

    #requireDev() {
      if (!dev) throw new Error("Actor inspection is only available in development builds (actors dev).");
    }

    /** Serialize actions on this instance: one runs at a time, in arrival order. */
    #enqueue<T>(method: string, fn: () => Promise<T>): Promise<T> {
      this.#queued++;
      const run = async () => {
        this.#active = { method, since: Date.now() };
        try {
          return await fn();
        } finally {
          this.#active = null;
          this.#queued--;
        }
      };
      const p = this.#queue.then(run, run);
      this.#queue = p.catch(() => {});
      return p;
    }

    /** Whether this instance has its tables, without creating them. */
    #hasTables(): boolean {
      return (
        this.#tables ||
        this.ctx.storage.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_actor_state'`).toArray()
          .length > 0
      );
    }

    /**
     * Close this instance's sockets, then delete its alarm and everything it stores (state, schedules, invocation
     * log, its own ctx.sql tables). `onClose` does not run for those sockets: it would recreate the instance.
     */
    async #wipe() {
      for (const ws of this.ctx.getWebSockets()) {
        const a = attachmentOf(ws);
        if (a) this.#closedIds.add(a.id);
        try {
          ws.close(1000, "Actor instance deleted");
        } catch {}
      }
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.#row = undefined;
      this.#tables = false;
      this.#generation++;
    }

    #load(): StateRow | null {
      if (this.#row !== undefined) return this.#row;
      this.#ensureTables();
      const r = this.ctx.storage.sql.exec(`SELECT * FROM _actor_state WHERE id = 1`).toArray()[0];
      this.#row = r
        ? {
            actor: String(r.actor),
            key: String(r.key),
            json: String(r.state),
            version: Number(r.version),
            schema: Number(r.schema ?? 0),
            createdAt: Number(r.created_at),
            updatedAt: Number(r.updated_at),
          }
        : null;
      return this.#row;
    }

    async #run(req: InvokeRequest, scheduleId?: string, hook?: HookCall): Promise<InvokeResult> {
      const started = Date.now();
      const invocation = crypto.randomUUID().slice(0, 8);
      const logs: string[] = [];
      const scheduleOps: ScheduleOp[] = [];
      const outbox: Outgoing[] = [];
      const def = registry[req.actor];
      let row = this.#load();

      const fail = (error: SerializedError, changedKeys: string[] = []): InvokeResult => {
        this.#record(req, invocation, started, logs, false, false, changedKeys, row?.version ?? 0, row?.schema ?? 0, null, error);
        const dropped = scheduleId ? this.#scheduleFailed(scheduleId, error.kind === "version") : false;
        this.#emit("invoke", req, invocation, started, {
          ok: false, error, stateVersion: row?.version, schema: row?.schema, ...(scheduleId && { scheduleId, scheduleDropped: dropped }),
        });
        return { ok: false, error };
      };

      if (!def) {
        return fail({
          name: "ActorError",
          kind: "config",
          message: `Actor type "${req.actor}" is not registered in this deployment. Registered: ${
            Object.keys(registry).join(", ") || "(none)"
          }. Run "actors generate".`,
        });
      }
      const hookFn = hook ? def.__config.connections?.[hook.name] : undefined;
      const action = hook
        ? hookFn && ((c: ActionContext<any>) => (hookFn as Function)(c, connection(hook.conn, outbox), ...hook.args))
        : Object.hasOwn(def.__config.actions, req.method)
          ? def.__config.actions[req.method]
          : undefined;
      if (!action) {
        const skew = req.callerVersion && req.callerVersion !== this.#code;
        return fail({
          name: "ActorError",
          kind: skew ? "version" : "config",
          message:
            `Actor "${req.actor}" has no action "${req.method}". Available: ${Object.keys(def.__config.actions).join(", ")}` +
            (skew
              ? `. The caller runs code version ${req.callerVersion}, this instance runs ${this.#code}: during a gradual ` +
                "deployment, keep an action until no Worker version that calls it is still deployed."
              : ""),
        });
      }
      if (row && (row.actor !== req.actor || row.key !== req.key)) {
        return fail({
          name: "ActorError",
          kind: "config",
          message: `Identity mismatch: this instance belongs to ${row.actor}("${row.key}")`,
        });
      }

      // Bring old state up to this code's schema, or refuse state that newer code saved.
      const latest = def.__config.migrations?.length ?? 0;
      if (row && row.schema > latest) {
        return fail({
          name: "ActorError",
          kind: "version",
          message:
            `${req.actor}("${req.key}") was saved by newer code: its state has run ${row.schema} migrations, but this code ` +
            `version (${this.#code}) defines ${latest}. Nothing was changed. Migrations only go forward: instead of ` +
            "rolling back, deploy a version that keeps all of them (fix the problem with another migration if needed).",
        });
      }
      if (row && row.schema < latest) {
        const migrated = this.#migrate(def, req, row, latest);
        if (!migrated.ok) return fail(migrated.error);
        row = migrated.row;
      }

      // 1. Build a private draft. JSON.parse of the committed document is a deep copy.
      const creating = !row;
      let draft: unknown;
      try {
        draft = row ? JSON.parse(row.json) : initialState(def, req.key);
      } catch (err) {
        return fail(serializeError(err, "action"));
      }

      const control = { destroy: false };
      const ctx = this.#context(def, req, invocation, draft, logs, scheduleOps, outbox, hook?.excludeId, control);

      // 2. Run onCreate (first call only) and the action against the draft.
      let value: unknown;
      try {
        if (creating && def.__config.onCreate) await def.__config.onCreate(ctx);
        value = await action(ctx, ...(req.args ?? []));
      } catch (err) {
        return fail(serializeError(err, "action")); // draft discarded = rollback
      }

      // 3. Validate the new state and the return value before anything is written.
      //    A destroyed instance keeps no state, so only the return value is checked.
      const next = ctx.state;
      let json = "";
      try {
        if (!control.destroy) {
          const problem = findJsonProblem(next);
          if (problem) throw new ActorError(`State validation failed: ${problem}.`, { kind: "validation" });
          def.__config.validate?.(next);
          json = JSON.stringify(next);
          const bytes = byteLength(json);
          if (bytes > MAX_STATE_BYTES) {
            throw new ActorError(
              `State is ${bytes} bytes; the limit is ${MAX_STATE_BYTES}. Move large or growing data into ctx.sql tables.`,
              { kind: "validation" },
            );
          }
        }
        try {
          structuredClone(value);
        } catch {
          throw new ActorError(
            `Action "${req.method}" returned a value that cannot be sent to the caller (functions, class instances with private fields, etc.). Return plain data.`,
            { kind: "validation" },
          );
        }
      } catch (err) {
        return fail(serializeError(err, "validation"));
      }

      // ctx.destroy(): instead of committing, deliver queued messages, then delete everything.
      if (control.destroy) {
        hook?.afterCommit?.();
        this.#flush(outbox);
        await this.#wipe();
        this.#emit("invoke", req, invocation, started, { ok: true, deleted: true, ...(scheduleId && { scheduleId }) });
        return { ok: true, value };
      }

      // 4. Commit atomically: state + schedules + log row in one SQLite transaction.
      const changed = !row || json !== row.json;
      const changedKeys = changed ? diffTopLevel(row?.json, json) : [];
      const now = Date.now();
      const version = changed ? (row?.version ?? 0) + 1 : row!.version;
      const schema = row?.schema ?? latest; // new instances start at the latest schema
      const sql = this.ctx.storage.sql;
      this.ctx.storage.transactionSync(() => {
        if (changed) this.#writeState(req, json, version, schema, row?.createdAt ?? now, now);
        for (const op of scheduleOps) {
          if (op.op === "add") {
            sql.exec(`INSERT INTO _actor_schedule (id, at, action, args) VALUES (?, ?, ?, ?)`, op.id, op.at, op.action, op.args);
          } else {
            sql.exec(`DELETE FROM _actor_schedule WHERE id = ?`, op.id);
          }
        }
        if (scheduleId) sql.exec(`DELETE FROM _actor_schedule WHERE id = ?`, scheduleId);
        this.#record(req, invocation, started, logs, true, changed, changedKeys, version, schema, null, null);
      });
      if (changed) {
        this.#row = { actor: req.actor, key: req.key, json, version, schema, createdAt: row?.createdAt ?? now, updatedAt: now };
      }
      hook?.afterCommit?.();
      this.#flush(outbox); // only now: rolled-back invocations never reach clients
      if (scheduleOps.length > 0) await this.#rearm();
      this.#emit("invoke", req, invocation, started, {
        ok: true, changed, stateVersion: version, schema,
        ...(scheduleOps.length > 0 && { schedulesAdded: scheduleOps.filter((o) => o.op === "add").length }),
        ...(scheduleId && { scheduleId }),
      });
      return { ok: true, value };
    }

    #writeState(req: InvokeRequest, json: string, version: number, schema: number, createdAt: number, now: number) {
      this.ctx.storage.sql.exec(
        `INSERT INTO _actor_state (id, actor, key, state, version, schema, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, version = excluded.version, schema = excluded.schema,
           updated_at = excluded.updated_at`,
        req.actor, req.key, json, version, schema, createdAt, now,
      );
    }

    /**
     * Run the migrations this state hasn't run yet, in one synchronous transaction of their own:
     * state, schema and any ctx.sql changes commit together, or nothing does. Logged as its own entry.
     */
    #migrate(
      def: AnyActor,
      req: InvokeRequest,
      row: StateRow,
      latest: number,
    ): { ok: true; row: StateRow } | { ok: false; error: SerializedError } {
      const started = Date.now();
      const invocation = crypto.randomUUID().slice(0, 8);
      const entry: InvokeRequest = { ...req, method: "migrate", args: [], source: "migration" };
      const migrations = def.__config.migrations ?? [];
      const sql = this.ctx.storage.sql;
      let step = row.schema;
      try {
        let state: unknown = JSON.parse(row.json);
        const next = this.ctx.storage.transactionSync(() => {
          for (; step < latest; step++) {
            const out: unknown = migrations[step](state, { actor: req.actor, key: req.key, sql });
            if (out && typeof (out as { then?: unknown }).then === "function") {
              throw new ActorError("it returned a Promise. Migrations must be synchronous: no await, fetch or calls to other actors.");
            }
            if (out === undefined) throw new ActorError("it returned undefined. Return the new state.");
            state = out;
          }
          const problem = findJsonProblem(state);
          if (problem) throw new ActorError(`the result is not valid state: ${problem}.`);
          def.__config.validate?.(state);
          const json = JSON.stringify(state);
          const now = Date.now();
          const r: StateRow = { ...row, json, version: row.version + 1, schema: latest, updatedAt: now };
          this.#writeState(req, json, r.version, latest, row.createdAt, now);
          const changedKeys = diffTopLevel(row.json, json);
          this.#record(entry, invocation, started, [], true, true, changedKeys, r.version, latest, row.schema, null);
          return r;
        });
        this.#row = next;
        this.#emit("migrate", entry, invocation, started, {
          ok: true, changed: true, stateVersion: next.version, schema: latest, migratedFrom: row.schema,
        });
        return { ok: true, row: next };
      } catch (err) {
        const e = serializeError(err, "version");
        const failed = step < latest ? `migrations[${step}]` : "validating the migrated state";
        const error: SerializedError = {
          ...e,
          kind: "version",
          message:
            `Migrating ${req.actor}("${req.key}") from schema ${row.schema} to ${latest} failed at ${failed}: ${e.message} ` +
            "Nothing was changed; the migration runs again on the next call. Fix it by deploying a corrected migration.",
        };
        this.#record(entry, invocation, started, [], false, false, [], row.version, row.schema, row.schema, error);
        this.#emit("migrate", entry, invocation, started, {
          ok: false, error, stateVersion: row.version, schema: row.schema, migratedFrom: row.schema,
        });
        return { ok: false, error };
      }
    }

    #context(
      def: AnyActor,
      req: InvokeRequest,
      invocation: string,
      draft: unknown,
      logs: string[],
      scheduleOps: ScheduleOp[],
      outbox: Outgoing[],
      excludeId: string | undefined,
      control: { destroy: boolean },
    ): ActionContext<any> {
      const self = this;
      const tag = `[${req.actor}("${req.key}") #${invocation}]`;
      return {
        state: draft,
        actor: req.actor,
        key: req.key,
        env: this.env as Cloudflare.Env,
        storage: this.ctx.storage,
        sql: this.ctx.storage.sql,
        log(...args: unknown[]) {
          logs.push(args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" "));
          console.log(tag, ...args);
        },
        schedule(when: number | Date, action: string, ...args: unknown[]) {
          if (!Object.hasOwn(def.__config.actions, action)) {
            throw new ActorError(`schedule(): actor "${req.actor}" has no action "${action}"`, { kind: "config" });
          }
          const problem = findJsonProblem(args, "args");
          if (problem) throw new ActorError(`schedule(): ${problem}`, { kind: "validation" });
          const at = when instanceof Date ? when.getTime() : Date.now() + Math.max(0, when) * 1000;
          const id = crypto.randomUUID();
          scheduleOps.push({ op: "add", id, at, action, args: JSON.stringify(args) });
          return id;
        },
        cancelSchedule(id: string) {
          scheduleOps.push({ op: "cancel", id });
        },
        broadcast(message: unknown, options: BroadcastOptions = {}) {
          const except = options.except === undefined ? undefined : [options.except].flat();
          outbox.push({ kind: "send", payload: encodeMessage(message), only: options.only, except });
        },
        connections(): ConnectionInfo[] {
          return self.#attachments(excludeId).map((a) => ({ id: a.id, data: a.data, connectedAt: a.at }));
        },
        destroy() {
          control.destroy = true;
        },
        get [Symbol.toStringTag]() {
          return `ActionContext ${tag} on ${self.ctx.id}`;
        },
      } as ActionContext<any>;
    }

    #record(
      req: InvokeRequest,
      invocation: string,
      started: number,
      logs: string[],
      ok: boolean,
      changed: boolean,
      changedKeys: string[],
      version: number,
      schema: number,
      migratedFrom: number | null,
      error: SerializedError | null,
    ) {
      // Migrations are rare and worth seeing: logged unless instrumentation is off.
      if (this.#level === "off" || (this.#level === "errors" && ok && migratedFrom === null)) return;
      const sql = this.ctx.storage.sql;
      const secretArgs = (registry[req.actor]?.__config.redact?.args ?? []) as string[];
      const args = !dev ? null : secretArgs.includes(req.method) ? '["[redacted]"]' : truncate(safeJson(req.args ?? []), ARG_PREVIEW_CHARS);
      sql.exec(
        `INSERT INTO _actor_log (inv, ts, method, source, args, duration_ms, ok, changed, changed_keys, version, error, logs,
           schema, migrated_from, code_version, caller_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        invocation, started, req.method, req.source, args, Date.now() - started, ok ? 1 : 0, changed ? 1 : 0,
        JSON.stringify(changedKeys), version, error ? JSON.stringify(error) : null, JSON.stringify(logs.slice(0, 50)),
        schema, migratedFrom, this.#code, req.callerVersion ?? null,
      );
      sql.exec(`DELETE FROM _actor_log WHERE id <= (SELECT MAX(id) FROM _actor_log) - ?`, LOG_LIMIT);
    }

    /** Retry later, or drop it after the last attempt. Returns true when it was dropped. */
    #scheduleFailed(id: string, versionMismatch = false): boolean {
      const sql = this.ctx.storage.sql;
      const r = sql.exec(`SELECT attempts FROM _actor_schedule WHERE id = ?`, id).toArray()[0];
      if (!r) return false;
      if (versionMismatch) {
        // Wrong code version for this state or action (e.g. after a rollback): wait for a deploy, don't use up attempts.
        sql.exec(`UPDATE _actor_schedule SET at = ? WHERE id = ?`, Date.now() + VERSION_RETRY_MS, id);
        return false;
      }
      const attempts = Number(r.attempts) + 1;
      if (attempts >= MAX_SCHEDULE_ATTEMPTS) {
        sql.exec(`DELETE FROM _actor_schedule WHERE id = ?`, id);
        return true;
      }
      sql.exec(`UPDATE _actor_schedule SET attempts = ?, at = ? WHERE id = ?`, attempts, Date.now() + 2 ** attempts * 1000, id);
      return false;
    }

    /**
     * One structured log line per invocation, migration and delete, for Workers Logs (`observability` is on in
     * the generated config). Fields are flat so they can be filtered on: actor, key, method, ok, error.kind…
     * Arguments and state are never logged. Failures go to console.error.
     */
    #emit(
      event: "invoke" | "migrate" | "delete",
      req: InvokeRequest,
      invocation: string,
      started: number,
      outcome: {
        ok: boolean;
        error?: SerializedError;
        changed?: boolean;
        stateVersion?: number;
        schema?: number;
        migratedFrom?: number;
        deleted?: boolean;
        scheduleId?: string;
        scheduleDropped?: boolean;
        schedulesAdded?: number;
      },
    ) {
      if (this.#logs === "off" || (this.#logs === "errors" && outcome.ok)) return;
      const durationMs = Date.now() - started;
      const { error, ...rest } = outcome;
      const what = `${req.actor}("${req.key}").${req.method}`;
      const line = {
        message: outcome.ok
          ? `${what} ok in ${durationMs}ms${outcome.deleted ? " (instance deleted)" : ""}`
          : `${what} failed (${error?.kind}): ${error?.message}${outcome.scheduleDropped ? " — scheduled call dropped after the last attempt" : ""}`,
        event: `actor.${event}`,
        actor: req.actor,
        key: req.key,
        method: req.method,
        trigger: req.source,
        invocation,
        durationMs,
        ...rest,
        codeVersion: this.#code,
        ...(req.callerVersion && { callerVersion: req.callerVersion }),
        ...(error && {
          error: { kind: error.kind, name: error.name, message: error.message, code: error.code, stack: error.stack && truncate(error.stack, 4_000) },
        }),
      };
      try {
        (outcome.ok ? console.log : console.error)(line);
      } catch {}
    }

    async #rearm() {
      const r = this.ctx.storage.sql.exec(`SELECT MIN(at) AS at FROM _actor_schedule`).toArray()[0];
      const at = r?.at == null ? null : Number(r.at);
      if (at === null) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(at);
    }
  };
}

function level(v: unknown): InstrumentationLevel | undefined {
  return v === "all" || v === "errors" || v === "off" ? v : undefined;
}

/** Add columns that don't exist yet (tables created by an older runtime). */
function addColumns(sql: SqlStorage, table: string, columns: Record<string, string>) {
  const have = new Set(sql.exec(`SELECT name FROM pragma_table_info(?)`, table).toArray().map((r) => String(r.name)));
  for (const [name, type] of Object.entries(columns)) {
    if (!have.has(name)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

function attachmentOf(ws: WebSocket): Attachment | null {
  try {
    return ws.deserializeAttachment() as Attachment | null;
  } catch {
    return null;
  }
}

function encodeMessage(message: unknown): string {
  if (typeof message === "string") return message;
  const problem = findJsonProblem(message, "message");
  if (problem) throw new ActorError(`Cannot send: ${problem}.`, { kind: "validation" });
  return JSON.stringify(message);
}

function connection(a: Attachment, outbox: Outgoing[]): Connection {
  return {
    id: a.id,
    data: a.data,
    send(message) {
      outbox.push({ kind: "send", payload: encodeMessage(message), only: [a.id] });
    },
    close(code, reason) {
      outbox.push({ kind: "close", id: a.id, code, reason });
    },
  };
}

function initialState(def: AnyActor, key: string): unknown {
  const s = def.__config.state;
  const value = typeof s === "function" ? (s as (key: string) => unknown)(key) : s;
  return JSON.parse(JSON.stringify(value ?? {}));
}

function diffTopLevel(prevJson: string | undefined, nextJson: string): string[] {
  const prev = prevJson ? JSON.parse(prevJson) : {};
  const next = JSON.parse(nextJson);
  if (!isObj(prev) || !isObj(next)) return ["(root)"];
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...keys].filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k])).sort();
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function toInvocationRecord(r: Record<string, SqlStorageValue>): InvocationRecord {
  return {
    id: Number(r.id),
    invocation: String(r.inv),
    ts: Number(r.ts),
    method: String(r.method),
    source: String(r.source),
    args: r.args == null ? null : String(r.args),
    durationMs: Number(r.duration_ms),
    ok: Number(r.ok) === 1,
    changed: Number(r.changed) === 1,
    changedKeys: JSON.parse(String(r.changed_keys)),
    version: Number(r.version),
    schema: r.schema == null ? 0 : Number(r.schema),
    migratedFrom: r.migrated_from == null ? null : Number(r.migrated_from),
    codeVersion: r.code_version == null ? null : String(r.code_version),
    callerVersion: r.caller_version == null ? null : String(r.caller_version),
    error: r.error == null ? null : JSON.parse(String(r.error)),
    logs: JSON.parse(String(r.logs)),
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function byteLength(s: string) {
  return new TextEncoder().encode(s).length;
}
