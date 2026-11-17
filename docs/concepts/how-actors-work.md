# How actors work

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../../README.md) before using any of it.

This page explains what happens between `Cart.get("alice").add("sku-1")` and the result, and where the data lives.

## The request path

```txt
Your Worker                         Actor Cart "alice"
───────────                         ──────────────────
Cart.get("alice")
  .add("sku-1") ── call ─────────▶  queue ─▶ draft = copy of state
                                             run add(ctx, "sku-1")
                                             validate state + return value
                                             save in one transaction:
                                               state, schedules, activity log
                                             send queued WebSocket messages
              ◀──────── result ────  (only once the save is durable)
```

1. **Address.** `Cart.get("alice")` gives you a reference to the actor `Cart` with key `"alice"`. Nothing is sent until you call an action.
2. **Queue.** The actor handles calls one at a time, in arrival order. A new call waits for the one before it, even while that one is awaiting I/O.
3. **Draft.** The action receives a private copy of the saved state as `ctx.state`.
4. **Run.** Your code changes the draft, or replaces it by assigning `ctx.state`.
5. **Validate.** The new state must be plain JSON under 2 MB and pass your `validate` function. The return value must be sendable to the caller.
6. **Save.** State, scheduled work and the activity log entry are written in one transaction. If anything before this point failed, nothing is written.
7. **Deliver.** Messages queued with `conn.send` or `ctx.broadcast` go out. The caller gets the result once the save is durable.

## State and transactions

Each actor stores its state as one JSON document. Every action either saves a whole new version or changes nothing.

What is **inside** the transaction:

- Changes to `ctx.state`.
- `ctx.schedule()` and `ctx.cancelSchedule()`.
- `ctx.broadcast()` and `conn.send()`: they are sent only if the save succeeds.

What is **outside** the transaction:

- `fetch()` calls, emails and calls to other actors. They happen when you make them and are not undone.
- Writes through `ctx.sql` and `ctx.storage`. They apply immediately.

Refer to [Make side effects safe to repeat](../best-practices/rules-of-actors.md#make-side-effects-safe-to-repeat) for patterns.

## Storage

Besides the state document, each actor keeps:

| Data | Holds |
|---|---|
| Activity log | The last 100 calls: method, source, duration, error, logs, changed keys |
| Schedules | Pending scheduled actions |

Each actor also has its own SQLite database, which you can use through `ctx.sql` for data that doesn't fit the state document. The runtime's own tables start with `_actor`; avoid that prefix for yours.

## Lifecycle

- **Creation.** An actor is created by its first action or WebSocket connection. `onCreate` runs once, inside that first transaction.
- **Idle.** An idle actor is unloaded from memory. Nothing is lost: memory only caches the saved state, and the next call loads it again.
- **Connections.** An actor with open WebSockets can be unloaded while its sockets stay open. The next message wakes it.
- **Deletion.** There is no delete API yet. In local development, the Actor Explorer can delete an actor's storage.

## Generated files

`actors generate` (also run by `actors dev` and `actors deploy`) writes:

| File | Purpose |
|---|---|
| `.actors/entry.ts` | Production entry point: your Worker, the actor runtime, and any custom classes |
| `.actors/entry.dev.ts` | The same, plus the Actor Explorer at `/__actors` |
| `.actors/manifest.json` | What was discovered, for tools |
| `wrangler.jsonc` | Adds the few settings actors need. Your other settings are kept. |

Refer to [Configuration](../reference/configuration.md) for details.

## Under the hood

You don't need this section to use actors, but it explains the limits and the generated configuration.

Actors run on [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) ↗. Each actor is one Durable Object, named `<Type>:<key>`, with its own SQLite database. Durable Objects provide the single-threaded execution, the per-actor storage, the alarms behind `ctx.schedule`, and the WebSocket hibernation behind connections. That's also where the [platform limits](../reference/limits.md#platform-limits) come from.

Every actor type runs in the same Durable Object class, `ActorHost`, which is why adding, renaming or removing an actor type never needs a migration. The trade-offs:

- **Per-type platform settings aren't available.** For example, you can't set a location hint per actor type.
- **Renaming an actor type starts it fresh.** Existing actors keep their data under the old name.

## Related resources

- [Semantics](../semantics.md): the full list of guarantees.
- [Limits](../reference/limits.md): sizes and counts.
