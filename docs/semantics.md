# Semantics: persistence, concurrency, failure

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../README.md) before using any of it.

These are the guarantees actors make. They promise nothing the underlying platform doesn't provide.

## Identity

- An actor is addressed by `(actor type, key)`. The mapping is deterministic: the same pair always reaches the same actor.
- Keys are scoped to **one deployment's namespace**. The same key in a different Worker, environment or account is a different instance.
- A key is an address, not proof of authorization. Authenticate the caller first, then derive the key from their identity. Do not trust a key that came from the client.

## State and transactions

Each instance stores one JSON document in SQLite (table `_actor_state`).

For every action:

1. The committed document is parsed into a **private draft** (`ctx.state`).
2. On an instance's first call, `onCreate` runs first, on the same draft.
3. The action runs. It can mutate the draft or reassign `ctx.state`.
4. **If the action throws**, the draft is discarded. Nothing is written: no state, no schedules. The failure is recorded in the invocation log.
5. **If it returns**, the new state is checked: it must be plain JSON, `validate()` must pass, and it must be under 2 MB. The return value must be structured-cloneable. If any check fails, the action is rolled back as a `validation` error.
6. The state, any `schedule`/`cancelSchedule` operations, and the log entry are committed in **one SQLite transaction** (`transactionSync`). If nothing changed, no state write happens.
7. The caller gets the result, but only once the write is durable.

Things that are **not** inside the transaction:

- External side effects: `fetch`, emails, calls to other actors. If an action calls an API and then throws, the API call already happened. For effects that must happen exactly once, commit an intent in state, then perform it from a scheduled action that is idempotent.
- Writes through `ctx.sql` and `ctx.storage`. They apply immediately and are not rolled back when the action throws.

## Concurrency

- Actions on **one instance run one at a time, in arrival order**. The runtime keeps a queue per instance, so actions never interleave across `await`s. Lost updates are impossible (tested with 100 concurrent increments).
- The cost: a slow action (for example a long LLM call) blocks the instance's other actions. Keep long I/O short, or move it to a scheduled action or a Workflow.
- **Re-entrancy deadlocks.** If an action awaits a call to *its own* instance, the call waits behind the running action forever, or until the platform times it out. Cycles deadlock the same way: A awaits B while B awaits A. Calls that don't come back to the caller are fine.
- Different instances run independently. There are no cross-actor transactions.
- Inspection (`actors inspect`, the Explorer's state view) does **not** queue. It reads committed state, so it works while an action is stuck.

## Calls, errors, retries

- Calls are **never retried automatically**. Retrying a non-idempotent action (such as `increment`) can apply it twice.
- Every failure surfaces as an `ActorError` with a `kind`:

| kind | Meaning | Did the action's state change commit? |
|---|---|---|
| `action` | The action threw (`code` is preserved if the error had one) | No |
| `validation` | The state or return value was rejected | No |
| `config` | Unknown actor or action, missing binding, bad key | No (the action never ran) |
| `transport` | The call failed in transit | **Unknown.** It may have run. `retryable` reflects the platform's hint. |
| `timeout` | `timeoutMs` elapsed on the caller side | **Unknown.** It usually still completes. |

## Scheduling

`ctx.schedule(seconds | Date, action, ...args)` stores a row and sets an alarm. Scheduling is transactional: it is discarded if the action throws. Scheduled runs go through the same queued, transactional path, recorded with source `schedule`. Delivery is at least once: a failed run is attempted up to 3 times in total (retries after 2 s and 4 s), then dropped. The failure stays visible in the log. Scheduled actions should be idempotent.

## WebSockets

- **Hooks are actions.** `onConnect`, `onMessage` and `onClose` are queued with the instance's other actions and follow the same transaction rules. A hook that throws changes nothing.
- **Sends wait for the save.** `conn.send`, `conn.close` and `ctx.broadcast` only queue messages. They go out after the transaction commits, in the order they were queued. If the invocation fails, they are discarded, so a client never sees a message about a change that didn't happen.
- **Delivery is at most once.** Messages go to sockets that are open at send time. A client that is disconnected (or reconnecting) misses them. Clients that need everything should keep a cursor (for example, the last message id) and fetch what they missed after reconnecting, as the chat example's `welcome` message does with recent history.
- **`onConnect` runs before the socket is accepted.** The new connection is not in `ctx.connections()` during its own `onConnect`. Messages it sends to that connection are delivered right after acceptance. If `onConnect` throws, the client gets HTTP 403 (or 500 for validation errors) and no socket is opened.
- **`onMessage` failures don't close the socket.** If you want clients to learn about errors, catch them in the hook and `conn.send` a reply. A reply sent from a hook that then throws is discarded with everything else.
- **`onClose` runs once per connection** (for a close or an error). The closing connection is already absent from `ctx.connections()`.
- **Connection data** comes only from the Worker's `connect(key, request, { data })`. The headers that carry it are overwritten, so a client can't forge them. It must be JSON and at most 8 KB, because it is stored on the socket (the Hibernation API caps a socket's stored data at 16 KB).
- **Hibernation.** Sockets are accepted through the Hibernation API: an idle instance can be evicted from memory while its sockets stay open, and an incoming message wakes it. Connection state lives on the sockets and in SQLite, not in memory, so nothing is lost on wake. Not tested here: forcing hibernation locally isn't possible.
- **Throughput.** Every incoming message is one queued, transactional invocation, and a broadcast is one send per open socket. One instance tops out around Cloudflare's soft limit of 1,000 requests/s and its CPU budget. Very large rooms need the patterns in findings §3.8.

## Restarts, eviction, redeploys

All state lives in SQLite. In-memory state is only a cache of the committed document. After an eviction, crash or redeploy, the next call reloads from storage. Tests cover state and invocation history surviving a full runtime restart. `lifecycle.instanceStartedAt` in `inspect` changes when the instance was recreated. The runtime does not expose other eviction or placement events, and the PoC does not pretend it does.

## Schema changes

The state document has no schema version. If you change the shape of state, old instances keep their old shape until an action rewrites it. Handle this with defaults in your actions, or a `validate` that normalizes. Versioned migrations are future work (PRD §15).

## Limits

- State document: 2 MB. This is a conservative limit chosen by this proof of concept: the platform allows values up to 8 MB, but every change rewrites the whole document. Put large or growing data in `ctx.sql` tables.
- Arguments and return values: structured-cloneable.
- Invocation log: the last 100 entries per instance. Arguments are recorded only in dev, never for actions listed in `redact.args`.
- Instrumentation defaults to `all` in dev and `errors` in production. Override it with the `ACTORS_INSTRUMENTATION` var (`all` | `errors` | `off`).
