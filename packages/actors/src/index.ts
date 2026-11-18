/**
 * Actors on Cloudflare — public API.
 *
 *   export const Counter = actor({
 *     state: { count: 0 },
 *     actions: {
 *       increment: ({ state }, by: number = 1) => (state.count += by),
 *     },
 *   });
 *
 *   await Counter.get("customer-123").increment(5);
 *
 * Semantics (see docs/semantics.md):
 *  - One actor instance per (actor type, key). Keys are scoped to one deployment.
 *  - Actions on one instance run one at a time, in arrival order.
 *  - Each action works on a private draft of the state. When it returns, the draft is
 *    validated and committed atomically. When it throws, the draft is discarded.
 *  - External side effects (fetch, other actors, raw ctx.sql writes) are NOT rolled back.
 *  - Actors adds no retries. The Workers runtime retries calls that never reached the
 *    instance, and never runs an action twice.
 */
import { env as workerEnv } from "cloudflare:workers";
import {
  ActorError,
  BINDING,
  codeVersion,
  findJsonProblem,
  HEADER_ACTOR,
  HEADER_DATA,
  HEADER_KEY,
  type InvokeRequest,
  type InvokeResult,
  MAX_CONNECTION_DATA_BYTES,
} from "./shared.ts";

export { ActorError } from "./shared.ts";
export type { ActorErrorKind, SerializedError } from "./shared.ts";

/** One live WebSocket connection to an actor instance. */
export interface Connection<C = unknown> {
  /** Stable id for this connection (survives hibernation). */
  readonly id: string;
  /** Data the Worker attached in `Actor.connect(key, request, { data })`, e.g. the authenticated user. */
  readonly data: C;
  /** Queue a message to this connection. Sent only if the current action commits. Non-strings are JSON-encoded. */
  send(message: string | object | number | boolean | null): void;
  /** Close this connection once the current action commits. */
  close(code?: number, reason?: string): void;
}

export interface ConnectionInfo<C = unknown> {
  readonly id: string;
  readonly data: C;
  readonly connectedAt: number;
}

export interface BroadcastOptions {
  /** Skip these connection ids (e.g. the sender). */
  except?: string | string[];
  /** Send only to these connection ids. */
  only?: string[];
}

/** WebSocket hooks. Each runs like an action: queued, transactional, rolled back if it throws. */
export interface ConnectionsConfig<S, C> {
  /**
   * The type of per-connection data, as a type witness: `data: typed<{ user: string }>()`.
   * Values come from the Worker (`Actor.connect(key, request, { data })`), never from the client.
   */
  data?: C;
  /** A client connected. Throw to refuse it: the client gets an HTTP 403 and no socket is opened. */
  onConnect?: (ctx: ActionContext<S, C>, conn: Connection<C>) => void | Promise<void>;
  /** A message arrived. If this throws, its state changes and queued sends are discarded; the socket stays open. */
  onMessage?: (ctx: ActionContext<S, C>, conn: Connection<C>, message: string | ArrayBuffer) => void | Promise<void>;
  /** The client went away. `conn` is no longer in `ctx.connections()`. */
  onClose?: (
    ctx: ActionContext<S, C>,
    conn: Connection<C>,
    info: { code: number; reason: string; wasClean: boolean },
  ) => void | Promise<void>;
}

/** A type witness for `connections.data`: `typed<{ user: string }>()`. Returns undefined at runtime. */
export function typed<T>(): T {
  return undefined as T;
}

/** What an action receives as its first argument. */
export interface ActionContext<S, C = unknown> {
  /**
   * A private draft of this actor's state. Mutate it (or reassign `ctx.state`).
   * Committed atomically when the action returns; discarded when it throws.
   */
  state: S;
  /** Actor type name, e.g. "Counter". */
  readonly actor: string;
  /** Logical identity of this instance, e.g. "customer-123". */
  readonly key: string;
  /** Log a line that is attached to this invocation in the Actor Explorer (and console). */
  log(...args: unknown[]): void;
  /**
   * Run one of this actor's actions later (Durable Object alarm under the hood).
   * Part of the same transaction: if the current action throws, nothing is scheduled.
   * Scheduled runs are at-least-once: each is attempted up to 3 times in total (retries after 2 s and 4 s).
   * @param when seconds from now, or an absolute Date
   * @returns schedule id
   */
  schedule(when: number | Date, action: string, ...args: unknown[]): string;
  /** Cancel a pending schedule (transactional, like `schedule`). */
  cancelSchedule(id: string): void;
  /** Escape hatch: the Worker environment (bindings, vars, secrets). */
  readonly env: Cloudflare.Env;
  /** Escape hatch: raw Durable Object storage. Writes here are NOT part of the state transaction. */
  readonly storage: DurableObjectStorage;
  /** Escape hatch: raw SQLite. Writes here are NOT part of the state transaction. Avoid tables prefixed `_actor`. */
  readonly sql: SqlStorage;
  /**
   * Queue a message to every open connection (or a subset). Sent only if the current action commits,
   * so clients never see a change that was rolled back. Non-strings are JSON-encoded.
   */
  broadcast(message: string | object | number | boolean | null, options?: BroadcastOptions): void;
  /** Open WebSocket connections to this instance. */
  connections(): ConnectionInfo<C>[];
}

/** What a migration receives besides the old state. Runs synchronously: no awaits, no fetch, no other actors. */
export interface MigrationContext {
  readonly actor: string;
  readonly key: string;
  /** Raw SQLite, in the same transaction as the migration: use it to change your own tables too. */
  readonly sql: SqlStorage;
}

/** One step in `migrations`: old state in, new state out. */
// biome-ignore lint: old shapes are not typed; annotate the parameter if you want to.
export type Migration = (state: any, ctx: MigrationContext) => object;

// biome-ignore lint: `any` is required for contextual typing of action parameters.
export type ActionFn<S, C = any> = (ctx: ActionContext<S, C>, ...args: any[]) => unknown;

export interface ActorConfig<S extends object, A extends Record<string, ActionFn<S, C>>, C = undefined> {
  /** Optional explicit name. Defaults to the exported const name (`export const Counter = actor(...)`). */
  name?: string;
  /** Initial state for a new instance, or a function of the instance key. Must be JSON-serializable. */
  state: S | ((key: string) => S);
  /** Callable methods. First parameter is the ActionContext; the rest are the caller's arguments. */
  actions: A;
  /** Runs once, before the first action, when an instance is created. Same transaction as that action. */
  onCreate?: (ctx: ActionContext<S>) => void | Promise<void>;
  /** Extra validation before every commit (e.g. `(s) => schema.parse(s)`). Throw to reject the commit. */
  validate?: (state: S) => void;
  /**
   * Changes to the shape of state, oldest first. Append only: never edit, reorder or remove one.
   * Each takes the previous state and returns the next; the last must return the current shape `S`.
   * An instance runs the ones it hasn't run yet, in order, the first time it is called after a deploy:
   * synchronously, in one transaction of their own (together with any `ctx.sql` changes), before the action.
   * New instances start from `state` and never run them.
   */
  migrations?: readonly Migration[];
  /**
   * Keep sensitive data out of dev tooling (Actor Explorer, `actors inspect`, invocation log):
   *  - state: top-level state keys shown as "[redacted]"
   *  - args:  actions whose arguments are never recorded (e.g. one that receives a token)
   */
  redact?: { state?: (keyof S & string)[]; args?: (keyof A & string)[] };
  /** WebSocket support. Clients connect through `Actor.connect(key, request, { data })` in your Worker. */
  connections?: ConnectionsConfig<S, C>;
}

export interface ConnectOptions<C> {
  /** Per-connection data (JSON, at most 8 KB), typically the authenticated user. Never taken from the client. */
  data?: C;
}

/** The caller-side view of an actor: every action becomes an async method without the ctx parameter. */
export type ActorRef<A> = {
  readonly [K in keyof A]: A[K] extends (ctx: any, ...args: infer P) => infer R
    ? (...args: P) => Promise<Awaited<R>>
    : never;
};

export interface GetOptions {
  /**
   * Reject with an ActorError(kind "timeout") if no response arrives in time.
   * The action may still complete on the actor; a timeout does not cancel it.
   */
  timeoutMs?: number;
}

export interface Actor<S extends object, A extends Record<string, ActionFn<S, C>>, C = undefined> {
  /** Get a typed reference to the instance with this key. Cheap; does not contact the actor. */
  get(key: string, options?: GetOptions): ActorRef<A>;
  /**
   * Hand a WebSocket upgrade request to the instance with this key. Return the result from your fetch handler.
   * Returns 426 if the request is not a WebSocket upgrade, 403 if `onConnect` refused it.
   */
  connect(key: string, request: Request, options?: ConnectOptions<C>): Promise<Response>;
  /** The actor type name. Throws if the actor was never registered (see `actors generate`). */
  readonly name: string;
  /** @internal */
  readonly __config: ActorConfig<S, A, C>;
  /** @internal called by the generated entry point */
  __register(name: string): void;
}

export type AnyActor = Actor<any, Record<string, ActionFn<any, any>>, any>;

const RESERVED_ACTIONS = new Set(["then", "catch", "finally", "constructor", "toJSON", "valueOf", "toString"]);

export function actor<S extends object, A extends Record<string, ActionFn<S, C>>, C = undefined>(
  config: ActorConfig<S, A, C>,
): Actor<S, A, C> {
  if (!config || typeof config !== "object") throw new TypeError("actor(config): config must be an object");
  if (!config.actions || typeof config.actions !== "object") {
    throw new TypeError("actor(config): `actions` must be an object of functions");
  }
  for (const [name, fn] of Object.entries(config.actions)) {
    if (typeof fn !== "function") throw new TypeError(`actor(config): action "${name}" is not a function`);
    if (RESERVED_ACTIONS.has(name) || name.startsWith("__")) {
      throw new TypeError(`actor(config): "${name}" is a reserved name and cannot be used as an action`);
    }
  }

  let registeredName: string | undefined = config.name;

  if (config.migrations !== undefined) {
    if (!Array.isArray(config.migrations)) throw new TypeError("actor(config): `migrations` must be an array of functions");
    config.migrations.forEach((m, i) => {
      if (typeof m !== "function") throw new TypeError(`actor(config): migrations[${i}] is not a function`);
    });
  }

  for (const hook of ["onConnect", "onMessage", "onClose"] as const) {
    const fn = config.connections?.[hook];
    if (fn !== undefined && typeof fn !== "function") throw new TypeError(`actor(config): connections.${hook} must be a function`);
  }

  const def: Actor<S, A, C> = {
    __config: config,
    get name() {
      if (!registeredName) {
        throw new ActorError(
          "This actor definition was never registered. Export it from a file under src/ as " +
            '`export const Name = actor({...})`, then run "actors generate" (or "actors dev").',
          { kind: "config" },
        );
      }
      return registeredName;
    },
    __register(name: string) {
      if (registeredName && registeredName !== name) {
        throw new ActorError(`Actor "${registeredName}" is also exported as "${name}". Export each actor once.`, {
          kind: "config",
        });
      }
      registeredName = name;
    },
    async connect(key: string, request: Request, options: ConnectOptions<C> = {}) {
      const name = def.name;
      checkKey(name, key, "connect");
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected a WebSocket upgrade (Upgrade: websocket).\n", {
          status: 426,
          headers: { Upgrade: "websocket" },
        });
      }
      const data = options.data ?? null;
      const problem = findJsonProblem(data, "data");
      if (problem) throw new ActorError(`${name}.connect(): ${problem}.`, { kind: "validation", actor: name, key });
      const encoded = JSON.stringify(data);
      if (new TextEncoder().encode(encoded).length > MAX_CONNECTION_DATA_BYTES) {
        throw new ActorError(`${name}.connect(): data is larger than ${MAX_CONNECTION_DATA_BYTES} bytes.`, {
          kind: "validation",
          actor: name,
          key,
        });
      }
      // Our headers overwrite any the client sent, so a client cannot forge identity or data.
      const headers = new Headers(request.headers);
      headers.set(HEADER_ACTOR, name);
      headers.set(HEADER_KEY, encodeURIComponent(key));
      headers.set(HEADER_DATA, encodeURIComponent(encoded));
      const stub = resolveStub(name, key) as unknown as Fetcher;
      return stub.fetch(new Request(request, { headers }));
    },
    get(key: string, options: GetOptions = {}) {
      const name = def.name;
      checkKey(name, key, "get");
      let stub: { actorInvoke(req: InvokeRequest): Promise<InvokeResult> } | undefined;
      const cache = new Map<string, (...args: unknown[]) => Promise<unknown>>();
      return new Proxy({} as ActorRef<A>, {
        get(_target, prop) {
          if (typeof prop !== "string" || prop === "then") return undefined;
          let fn = cache.get(prop);
          if (!fn) {
            fn = async (...args: unknown[]) => {
              if (!Object.hasOwn(config.actions, prop)) {
                throw new ActorError(
                  `Actor "${name}" has no action "${prop}". Available: ${Object.keys(config.actions).join(", ")}`,
                  { kind: "config", actor: name, key, method: prop },
                );
              }
              stub ??= resolveStub(name, key);
              const callerVersion = codeVersion(workerEnv);
              return invoke(stub, { actor: name, key, method: prop, args, source: "rpc", callerVersion }, options);
            };
            cache.set(prop, fn);
          }
          return fn;
        },
        has(_target, prop) {
          return typeof prop === "string" && Object.hasOwn(config.actions, prop);
        },
        ownKeys() {
          return Object.keys(config.actions);
        },
        getOwnPropertyDescriptor(_target, prop) {
          return typeof prop === "string" && Object.hasOwn(config.actions, prop)
            ? { enumerable: true, configurable: true }
            : undefined;
        },
      });
    },
  };
  return def;
}

function checkKey(name: string, key: string, method: string) {
  if (typeof key !== "string" || key.length === 0 || key.length > 512) {
    throw new ActorError(`${name}.${method}(key): key must be a non-empty string of at most 512 characters`, {
      kind: "config",
      actor: name,
    });
  }
}

function resolveStub(name: string, key: string) {
  const ns = (workerEnv as unknown as Record<string, DurableObjectNamespace | undefined>)?.[BINDING];
  if (!ns || typeof (ns as DurableObjectNamespace).idFromName !== "function") {
    throw new ActorError(
      `Actor "${name}" could not be resolved: the "${BINDING}" Durable Object binding is missing. ` +
        'Run "actors generate" to refresh the generated configuration, and start the app with "actors dev".',
      { kind: "config", actor: name, key },
    );
  }
  return ns.get(ns.idFromName(`${name}:${key}`)) as unknown as {
    actorInvoke(req: InvokeRequest): Promise<InvokeResult>;
  };
}

async function invoke(
  stub: { actorInvoke(req: InvokeRequest): Promise<InvokeResult> },
  req: InvokeRequest,
  options: GetOptions,
): Promise<unknown> {
  const where = { actor: req.actor, key: req.key, method: req.method };
  let result: InvokeResult;
  try {
    const call = stub.actorInvoke(req);
    result = options.timeoutMs ? await withTimeout(call, options.timeoutMs, where) : await call;
  } catch (err) {
    if (err instanceof ActorError) throw err;
    // Infrastructure / transport failure. The action may or may not have run.
    const e = err as Error & { retryable?: boolean; overloaded?: boolean };
    throw new ActorError(
      `Call to ${req.actor}("${req.key}").${req.method}() failed before a result was received: ${e?.message ?? e}. ` +
        "The action may or may not have run. Any runtime retries are done; Actors did not retry it.",
      { kind: "transport", ...where, retryable: !!e?.retryable && !e?.overloaded, cause: err },
    );
  }
  if (result.ok) return result.value;
  throw ActorError.fromSerialized(result.error, where);
}

function withTimeout<T>(p: Promise<T>, ms: number, where: { actor: string; key: string; method: string }) {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ActorError(
            `${where.actor}("${where.key}").${where.method}() did not respond within ${ms}ms. ` +
              "It may still complete; timeouts do not cancel actions.",
            { kind: "timeout", ...where, retryable: false },
          ),
        ),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// ───────────────────────────── raw Durable Objects ─────────────────────────────
//
// Escape hatch for code that wants a real Durable Object class (a library such as
// pi-durable, WebSockets, custom alarms). Export it from any file under src/:
//
//   export class Session extends DurableObject { async ask(q: string) { ... } }
//
// `actors generate` writes its binding and migration and re-exports it. Callers use:
//
//   const stub = durable(Session).get("acme");   // DurableObjectStub<Session>, typed RPC
//   await stub.ask("hello");

type DurableClass<T extends Rpc.DurableObjectBranded> = abstract new (ctx: DurableObjectState, env: any) => T;

export interface DurableRef<T extends Rpc.DurableObjectBranded> {
  /** Typed stub for the instance with this name (`idFromName`). Cheap; no network until called. */
  get(name: string, options?: DurableObjectNamespaceGetDurableObjectOptions): DurableObjectStub<T>;
  /** The binding name `actors generate` assigned, e.g. "SESSION". */
  readonly binding: string;
  /** Escape hatch: the namespace itself (newUniqueId, idFromString, jurisdictions…). */
  readonly namespace: DurableObjectNamespace<T>;
}

const objectBindings = new Map<Function, string>();

/** @internal Called by the generated entry point with the class → binding map from wrangler.jsonc. */
export function __registerDurableObjects(map: Record<string, [Function, string]>) {
  for (const [cls, binding] of Object.values(map)) objectBindings.set(cls, binding);
}

/** UPPER_SNAKE binding name for a class name: ChatRoom → CHAT_ROOM. Mirrors the CLI. */
export function bindingNameFor(className: string): string {
  return className
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toUpperCase();
}

export function durable<T extends Rpc.DurableObjectBranded>(cls: DurableClass<T>): DurableRef<T> {
  const resolve = () => {
    const binding = objectBindings.get(cls) ?? bindingNameFor(cls.name);
    const ns = (workerEnv as unknown as Record<string, unknown>)?.[binding] as DurableObjectNamespace<T> | undefined;
    if (!ns || typeof ns.idFromName !== "function") {
      throw new ActorError(
        `Durable Object class "${cls.name}" could not be resolved: no "${binding}" binding. ` +
          `Export it from a file under src/ as \`export class ${cls.name} extends DurableObject\`, ` +
          'then run "actors generate" (or "actors dev").',
        { kind: "config" },
      );
    }
    return { binding, ns };
  };
  return {
    get(name, options) {
      if (typeof name !== "string" || name.length === 0) {
        throw new ActorError(`durable(${cls.name}).get(name): name must be a non-empty string`, { kind: "config" });
      }
      const { ns } = resolve();
      return ns.get(ns.idFromName(name), options);
    },
    get binding() {
      return resolve().binding;
    },
    get namespace() {
      return resolve().ns;
    },
  };
}
