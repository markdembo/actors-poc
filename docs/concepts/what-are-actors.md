# What are actors?

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../../README.md) before using any of it.

An actor is a small, stateful service with one instance per key. Each instance owns its own state, handles one action at a time, and lives until you delete its data. Under the hood, every instance is a [Durable Object](https://developers.cloudflare.com/durable-objects/) ↗.

## Actors, Workers and Durable Objects

| | Worker | Durable Object | Actor |
|---|---|---|---|
| State between requests | None | Yes, in its storage | Yes, a JSON document per instance |
| Instances | Many, anywhere | One per ID | One per (actor type, key) |
| Concurrency | Fully parallel | One thread; requests can interleave at `await` | One action at a time, in order |
| What you write | A `fetch` handler | A class, binding, migration, ID and stub | `actor({ state, actions })` |
| Failed request | Nothing to undo | Your code decides | State changes are rolled back |

Use a Worker for stateless work. Use an actor when requests must agree on shared state. Use a raw Durable Object when you need something actors don't offer, such as a custom storage schema, streaming responses or another framework's base class. Refer to [`durable()`](../api/durable.md).

## The four ideas

**Actor.** A type of service, such as `Cart`, `ChatRoom` or `SupportAgent`, defined once with `actor({...})` and exported from any file under `src/`.

**Key.** Which instance you mean: `Cart.get("alice")`. The same key always reaches the same instance within one deployment. Different deployments or environments have separate instances.

**State.** A JSON document per instance. Every action gets a private draft. The draft is saved when the action returns and thrown away when it throws.

**Action.** An async function `(ctx, ...args)`. Callers see it as `(...args) => Promise<Result>` with full types.

## When to use actors

Actors fit when your data has a natural owner:

- **A customer, tenant or workspace**: settings, quotas, usage.
- **A conversation or agent**: messages, memory, tool state.
- **A shared space**: a chat room, document or game lobby.
- **A coordinator**: a rate limiter, booking slot or job tracker for one resource.

Actors fit less well for:

- **Queries across many instances.** There is no global query over actor state. Keep an index in D1 or another store if you need one.
- **One very hot key.** One instance handles roughly a thousand simple requests per second. Refer to [Avoid hot actors](../best-practices/rules-of-actors.md#avoid-hot-actors).
- **Long-running work inside one call.** Actions run one at a time, so a slow action delays everything else on that instance.

## Related resources

- [How actors work](how-actors-work.md): the request path, storage layout and lifecycle.
- [Rules of actors](../best-practices/rules-of-actors.md): design guidance.
- [Semantics](../semantics.md): the exact guarantees.
