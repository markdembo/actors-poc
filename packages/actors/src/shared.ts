/** Internals shared by the client (index.ts), the runtime (runtime.ts) and dev tooling (dev.ts). */

/** The single Durable Object binding that hosts every actor type. */
export const BINDING = "ACTORS";
/** The single Durable Object class that hosts every actor type. */
export const HOST_CLASS = "ActorHost";

export type InvokeSource = "rpc" | "explorer" | "schedule" | "websocket";

/** Headers the Worker-side `connect()` sets on the upgrade request it forwards to the instance. */
export const HEADER_ACTOR = "x-actors-actor";
export const HEADER_KEY = "x-actors-key";
export const HEADER_DATA = "x-actors-data";
/** Per-connection data limit; the hibernation attachment (data + bookkeeping) is capped at 16 KB. */
export const MAX_CONNECTION_DATA_BYTES = 8_000;

export interface InvokeRequest {
  actor: string;
  key: string;
  method: string;
  args: unknown[];
  source: InvokeSource;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  kind: ActorErrorKind;
}

export type InvokeResult = { ok: true; value: unknown } | { ok: false; error: SerializedError };

/**
 * - action:     the action threw (state was rolled back)
 * - validation: the action returned, but the new state or return value was rejected (rolled back)
 * - config:     unknown actor/action, missing binding, bad key
 * - transport:  the call failed in transit; the action may or may not have run
 * - timeout:    the caller stopped waiting; the action may still complete
 */
export type ActorErrorKind = "action" | "validation" | "config" | "transport" | "timeout";

export class ActorError extends Error {
  override name = "ActorError";
  readonly kind: ActorErrorKind;
  readonly actor?: string;
  readonly key?: string;
  readonly method?: string;
  /** Application error code, if the action threw an error with a `code` property. */
  readonly code?: string;
  /** Name of the original error thrown inside the actor (e.g. "TypeError"). */
  readonly remoteName?: string;
  /** Stack trace from inside the actor. */
  readonly remoteStack?: string;
  /** True only when the platform says the call is safe to retry. Never retried automatically. */
  readonly retryable: boolean;

  constructor(
    message: string,
    opts: {
      kind?: ActorErrorKind;
      actor?: string;
      key?: string;
      method?: string;
      code?: string;
      remoteName?: string;
      remoteStack?: string;
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: opts.cause });
    this.kind = opts.kind ?? "action";
    this.actor = opts.actor;
    this.key = opts.key;
    this.method = opts.method;
    this.code = opts.code;
    this.remoteName = opts.remoteName;
    this.remoteStack = opts.remoteStack;
    this.retryable = opts.retryable ?? false;
  }

  static fromSerialized(e: SerializedError, where: { actor: string; key: string; method: string }) {
    return new ActorError(`${where.actor}("${where.key}").${where.method}(): ${e.message}`, {
      ...where,
      kind: e.kind,
      code: e.code,
      remoteName: e.name,
      remoteStack: e.stack,
    });
  }
}

export function serializeError(err: unknown, kind: ActorErrorKind): SerializedError {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      code: typeof code === "string" ? code : undefined,
      kind: err instanceof ActorError ? err.kind : kind,
    };
  }
  return { name: "Error", message: String(err), kind };
}

/**
 * Check that a value round-trips through JSON without silently losing data.
 * Returns a human-readable problem description, or null when the value is fine.
 */
export function findJsonProblem(value: unknown, path = "state", seen = new Set<object>()): string | null {
  switch (typeof value) {
    case "string":
    case "boolean":
      return null;
    case "number":
      return Number.isFinite(value) ? null : `${path} is ${value}; only finite numbers can be stored`;
    case "undefined":
      return `${path} is undefined; use null or delete the property`;
    case "bigint":
      return `${path} is a bigint; store it as a string`;
    case "function":
      return `${path} is a function; state must be plain data`;
    case "symbol":
      return `${path} is a symbol; state must be plain data`;
  }
  if (value === null) return null;
  const obj = value as object;
  if (seen.has(obj)) return `${path} is a circular reference`;
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const p = findJsonProblem(obj[i], `${path}[${i}]`, seen);
        if (p) return p;
      }
      return null;
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      const kind = obj instanceof Date ? "a Date (store an ISO string or epoch ms)" :
        obj instanceof Map ? "a Map (use a plain object)" :
        obj instanceof Set ? "a Set (use an array)" :
        `an instance of ${obj.constructor?.name ?? "a class"} (state must be plain objects and arrays)`;
      return `${path} is ${kind}`;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue; // dropped by JSON, matches "property absent"
      const p = findJsonProblem(v, `${path}.${k}`, seen);
      if (p) return p;
    }
    return null;
  } finally {
    seen.delete(obj);
  }
}

/** Best-effort parameter names for an action (for Explorer hints). Skips the ctx parameter. */
export function describeParams(fn: Function): string[] {
  const src = Function.prototype.toString.call(fn);
  let start = src.indexOf("(");
  const arrow = src.indexOf("=>");
  if (start === -1 || (arrow !== -1 && arrow < start)) {
    // single-parameter arrow without parens: only ctx
    return [];
  }
  let depth = 0;
  let cur = "";
  const params: string[] = [];
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) {
      if (depth === 0) {
        params.push(cur.trim());
        break;
      }
      depth--;
    }
    if (ch === "," && depth === 0) {
      params.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  return params.slice(1).filter(Boolean).map((p) => p.replace(/\s+/g, " "));
}
