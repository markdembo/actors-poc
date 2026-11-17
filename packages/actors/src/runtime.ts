/**
 * The generic actor runtime: ONE Durable Object class that hosts every actor type.
 *
 * Why one class? Adding, renaming or removing an actor type then never needs a Durable
 * Object migration — the only migration is the one that creates `ActorHost`. Instances are
 * named "<Type>:<key>", so different actor types never share an instance.
 *
 * Storage layout (SQLite, per instance):
 *   _actor_state     one row: type, key, JSON state document, version, timestamps
 *   _actor_log       ring buffer of recent invocations (instrumentation)
 *   _actor_schedule  pending scheduled actions (driven by the DO alarm)
 */
import { DurableObject } from "cloudflare:workers";
import type { ActionContext, AnyActor, BroadcastOptions, Connection, ConnectionInfo } from "./index.ts";
import {
  ActorError,
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
  /** Enables the dev-only RPCs (actorRuntime, actorWipe). The generated dev entry sets this; the deploy entry does not. */
  dev?: boolean;
  /** Default: "all" in dev, "errors" in production. Override with the ACTORS_INSTRUMENTATION var. */
  instrumentation?: InstrumentationLevel;
}

const LOG_LIMIT = 100;
const MAX_STATE_BYTES = 2_000_000; // Durable Objects SQLite: max 2 MB per value
const MAX_SCHEDULE_ATTEMPTS = 3;
const ARG_PREVIEW_CHARS = 2_000;

interface StateRow {
  actor: string;
  key: string;
  json: string;
  version: number;
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
  error: SerializedError | null;
  logs: string[];
}

/** Live diagnostics only the running instance knows. Persisted data is read through Wrangler's Local Explorer. */
export interface RuntimeInfo {
  durableObjectId: string;
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
    readonly #startedAt = Date.now();
    readonly #level: InstrumentationLevel;

    constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
      super(ctx, env);
      const lvl = env.ACTORS_INSTRUMENTATION;
      this.#level =
        lvl === "all" || lvl === "errors" || lvl === "off" ? lvl : (options.instrumentation ?? (dev ? "all" : "errors"));
      this.#ensureTables();
    }

    #ensureTables() {
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
        instanceStartedAt: this.#startedAt,
        activeAction: this.#active,
        queuedActions: Math.max(0, this.#queued - (this.#active ? 1 : 0)),
        nextAlarm: await this.ctx.storage.getAlarm(),
        databaseSizeBytes: this.ctx.storage.sql.databaseSize,
        connections: this.#attachments().map((a) => ({ id: a.id, data: a.data, connectedAt: a.at })),
      };
    }

    /** Dev only: delete all of this instance's storage. */
    async actorWipe(): Promise<void> {
      this.#requireDev();
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.#row = null;
      this.#ensureTables();
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1001, "Actor instance deleted");
        } catch {}
      }
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
      const row = this.#load();
      if (!row) return;
      const due = this.ctx.storage.sql
        .exec(`SELECT id, action, args FROM _actor_schedule WHERE at <= ? ORDER BY at`, Date.now())
        .toArray();
      for (const s of due) {
        await this.#enqueue(String(s.action), () =>
          this.#run(
            { actor: row.actor, key: row.key, method: String(s.action), args: JSON.parse(String(s.args)), source: "schedule" },
            String(s.id),
          ),
        );
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

    #load(): StateRow | null {
      if (this.#row !== undefined) return this.#row;
      const r = this.ctx.storage.sql.exec(`SELECT * FROM _actor_state WHERE id = 1`).toArray()[0];
      this.#row = r
        ? {
            actor: String(r.actor),
            key: String(r.key),
            json: String(r.state),
            version: Number(r.version),
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
      const row = this.#load();

      const fail = (error: SerializedError, changedKeys: string[] = []): InvokeResult => {
        this.#record(req, invocation, started, logs, false, false, changedKeys, row?.version ?? 0, error);
        if (scheduleId) this.#scheduleFailed(scheduleId);
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
        return fail({
          name: "ActorError",
          kind: "config",
          message: `Actor "${req.actor}" has no action "${req.method}". Available: ${Object.keys(def.__config.actions).join(", ")}`,
        });
      }
      if (row && (row.actor !== req.actor || row.key !== req.key)) {
        return fail({
          name: "ActorError",
          kind: "config",
          message: `Identity mismatch: this instance belongs to ${row.actor}("${row.key}")`,
        });
      }

      // 1. Build a private draft. JSON.parse of the committed document is a deep copy.
      const creating = !row;
      let draft: unknown;
      try {
        draft = creating ? initialState(def, req.key) : JSON.parse(row.json);
      } catch (err) {
        return fail(serializeError(err, "action"));
      }

      const ctx = this.#context(def, req, invocation, draft, logs, scheduleOps, outbox, hook?.excludeId);

      // 2. Run onCreate (first call only) and the action against the draft.
      let value: unknown;
      try {
        if (creating && def.__config.onCreate) await def.__config.onCreate(ctx);
        value = await action(ctx, ...(req.args ?? []));
      } catch (err) {
        return fail(serializeError(err, "action")); // draft discarded = rollback
      }

      // 3. Validate the new state and the return value before anything is written.
      const next = ctx.state;
      let json: string;
      try {
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

      // 4. Commit atomically: state + schedules + log row in one SQLite transaction.
      const changed = creating || json !== row.json;
      const changedKeys = changed ? diffTopLevel(creating ? undefined : row.json, json) : [];
      const now = Date.now();
      const version = changed ? (row?.version ?? 0) + 1 : row!.version;
      const sql = this.ctx.storage.sql;
      this.ctx.storage.transactionSync(() => {
        if (changed) {
          sql.exec(
            `INSERT INTO _actor_state (id, actor, key, state, version, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET state = excluded.state, version = excluded.version, updated_at = excluded.updated_at`,
            req.actor, req.key, json, version, row?.createdAt ?? now, now,
          );
        }
        for (const op of scheduleOps) {
          if (op.op === "add") {
            sql.exec(`INSERT INTO _actor_schedule (id, at, action, args) VALUES (?, ?, ?, ?)`, op.id, op.at, op.action, op.args);
          } else {
            sql.exec(`DELETE FROM _actor_schedule WHERE id = ?`, op.id);
          }
        }
        if (scheduleId) sql.exec(`DELETE FROM _actor_schedule WHERE id = ?`, scheduleId);
        this.#record(req, invocation, started, logs, true, changed, changedKeys, version, null);
      });
      if (changed) {
        this.#row = { actor: req.actor, key: req.key, json, version, createdAt: row?.createdAt ?? now, updatedAt: now };
      }
      hook?.afterCommit?.();
      this.#flush(outbox); // only now: rolled-back invocations never reach clients
      if (scheduleOps.length > 0) await this.#rearm();
      return { ok: true, value };
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
      error: SerializedError | null,
    ) {
      if (this.#level === "off" || (this.#level === "errors" && ok)) return;
      const sql = this.ctx.storage.sql;
      const secretArgs = (registry[req.actor]?.__config.redact?.args ?? []) as string[];
      const args = !dev ? null : secretArgs.includes(req.method) ? '["[redacted]"]' : truncate(safeJson(req.args ?? []), ARG_PREVIEW_CHARS);
      sql.exec(
        `INSERT INTO _actor_log (inv, ts, method, source, args, duration_ms, ok, changed, changed_keys, version, error, logs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        invocation, started, req.method, req.source, args, Date.now() - started, ok ? 1 : 0, changed ? 1 : 0,
        JSON.stringify(changedKeys), version, error ? JSON.stringify(error) : null, JSON.stringify(logs.slice(0, 50)),
      );
      sql.exec(`DELETE FROM _actor_log WHERE id <= (SELECT MAX(id) FROM _actor_log) - ?`, LOG_LIMIT);
    }

    #scheduleFailed(id: string) {
      const sql = this.ctx.storage.sql;
      const r = sql.exec(`SELECT attempts FROM _actor_schedule WHERE id = ?`, id).toArray()[0];
      if (!r) return;
      const attempts = Number(r.attempts) + 1;
      if (attempts >= MAX_SCHEDULE_ATTEMPTS) {
        sql.exec(`DELETE FROM _actor_schedule WHERE id = ?`, id);
      } else {
        sql.exec(`UPDATE _actor_schedule SET attempts = ?, at = ? WHERE id = ?`, attempts, Date.now() + 2 ** attempts * 1000, id);
      }
    }

    async #rearm() {
      const r = this.ctx.storage.sql.exec(`SELECT MIN(at) AS at FROM _actor_schedule`).toArray()[0];
      const at = r?.at == null ? null : Number(r.at);
      if (at === null) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(at);
    }
  };
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
