# How actors work

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../../README.md) before using any of it.

This page explains what happens between `Cart.get("alice").add("sku-1")` and the result, and where the data lives.

## The request path

```txt
Worker                              Durable Object "Cart:alice" (class ActorHost)
──────                              ─────────────────────────────────────────────
Cart.get("alice")                   
  .add("sku-1") ── RPC ──────────▶  queue ─▶ draft = copy of state
                                             run add(ctx, "sku-1")
                                             validate state + return value
                                             one SQLite transaction:
                                               state, schedules, log entry
                                             send queued WebSocket messages
              ◀──────── result ────  (held until the write is durable)
```

1. **Resolve.** `Cart.get("alice")` maps to the Durable Object named `Cart:alice` in the single `ACTORS` namespace. Nothing is sent until you call an action.
2. **Queue.** The instance runs actions one at a time, in arrival order. A new call waits for the one before it, even across `await`.
3. **Draft.** The action receives a private copy of the saved state as `ctx.state`.
4. **Run.** Your code mutates the draft, or replaces it by assigning `ctx.state`.
5. **Validate.** The new state must be plain JSON under 2 MB and pass your `validate` function. The return value must be sendable to the caller.
6. **Commit.** State, scheduled work and the log entry are written in one SQLite transaction. If anything before this point failed, nothing is written.
7. **Deliver.** Messages queued with `conn.send` or `ctx.broadcast` go out after the commit. The caller's result is held until the write is durable.

## State and transactions

Each instance stores one JSON document. Every action either commits a whole new version or changes nothing.

What is **inside** the transaction:

- Changes to `ctx.state`.
- `ctx.schedule()` and `ctx.cancelSchedule()`.
- `ctx.broadcast()` and `conn.send()`: they are sent only if the commit succeeds.

What is **outside** the transaction:

- `fetch()` calls, emails and calls to other actors. They happen when you make them and are not undone.
- Writes through `ctx.sql` and `ctx.storage`. They apply immediately.

Refer to [Make side effects safe to repeat](../best-practices/rules-of-actors.md#make-side-effects-safe-to-repeat) for patterns.

## One host class for every actor type

Every actor type runs in one Durable Object class, `ActorHost`, and instances are named `<Type>:<key>`. The practical result: adding, renaming or removing an actor type never needs a Durable Object migration. The CLI writes one migration, once.

The trade-offs:

- **Per-type platform settings aren't available.** For example, you can't set a location hint per actor type.
- **Renaming an actor type starts it fresh.** The old instances' data stays under the old name.

## Storage layout

Each instance's SQLite database has three tables owned by the runtime:

| Table | Holds |
|---|---|
| `_actor_state` | The state document, its version and timestamps |
| `_actor_log` | The last 100 invocations: method, source, duration, error, logs, changed keys |
| `_actor_schedule` | Pending scheduled actions, driven by the Durable Object alarm |

You can create your own tables with `ctx.sql`. Avoid names that start with `_actor`.

## Lifecycle

- **Creation.** An instance is created by its first action or WebSocket connection. `onCreate` runs once, inside that first transaction.
- **Eviction.** The platform evicts idle instances from memory. Nothing is lost: memory only caches the saved document.
- **Hibernation.** Instances with WebSocket connections can be evicted while their sockets stay open. The next message wakes the instance.
- **Deletion.** There is no delete API yet. In local development, the Actor Explorer can delete an instance's storage.

## Generated files

`actors generate` (also run by `actors dev` and `actors deploy`) writes:

| File | Purpose |
|---|---|
| `.actors/entry.ts` | Production entry point: your Worker, `ActorHost` and your exported Durable Object classes |
| `.actors/entry.dev.ts` | The same, plus the Actor Explorer at `/__actors` |
| `.actors/manifest.json` | What was discovered, for tools |
| `wrangler.jsonc` | Adds `main`, the `ACTORS` binding and the `actors-v1` migration. Your other settings are kept. |

Refer to [Configuration](../reference/configuration.md) for details.

## Related resources

- [Semantics](../semantics.md): the full list of guarantees.
- [Limits](../reference/limits.md): sizes and counts.
- [Durable Objects: lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) ↗
