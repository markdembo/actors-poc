# What are actors?

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../../README.md) before using any of it.

An actor is a small, stateful service with its own identity. You don't deploy or start actors: you address one by name, and it exists. Each actor owns private state, handles requests one at a time, and keeps its state until you delete it.

The idea comes from the actor model: a system built from many small, independent units that each own their data and talk only through messages. Here, the messages are typed method calls.

## Actors compared with what you know

| | Stateless function | Database row | Actor |
|---|---|---|---|
| Keeps state between requests | No | Yes | Yes |
| Where the logic runs | In the function, after loading data | Outside, in your app | Next to the state, inside the actor |
| Two requests at once | Each sees its own copy of the data, last write wins | Needs transactions or locks | Handled in order, never interleaved |
| A request fails halfway | You clean up | You roll back | Changes are discarded automatically |
| Real-time connections | No | No | Yes, clients connect to the actor |

Use a stateless function for work that doesn't depend on shared state. Use a database for data you query across many records. Use an actor when requests must agree on one piece of state, and the code that changes it should live next to it.

## The four ideas

**Actor.** A type of service, such as `Cart`, `ChatRoom` or `SupportAgent`, defined once with `actor({...})` and exported from any file under `src/`.

**Key.** Which actor you mean: `Cart.get("alice")`. The same key always reaches the same actor within one deployment. Different deployments or environments have separate actors.

**State.** Each actor's private data, kept as a JSON document. Every action gets a private draft. The draft is saved when the action returns and thrown away when it throws.

**Action.** An async function `(ctx, ...args)`. Callers see it as `(...args) => Promise<Result>` with full types.

## When to use actors

Actors fit when your data has a natural owner:

- **A customer, tenant or workspace**: settings, quotas, usage.
- **A conversation or agent**: messages, memory, tool state.
- **A shared space**: a chat room, document or game lobby.
- **A coordinator**: a rate limiter, booking slot or job tracker for one resource.

Actors fit less well for:

- **Queries across many actors.** There is no global query over actor state. Keep an index in a database if you need one.
- **One very hot key.** One actor handles roughly a thousand simple requests per second. Refer to [Avoid hot actors](../best-practices/rules-of-actors.md#avoid-hot-actors).
- **Long-running work inside one call.** Actions run one at a time, so a slow action delays everything else on that actor.

> [!NOTE]
> **Already know Cloudflare Durable Objects?** Each actor runs as one. Actors handle the class, configuration, routing, transactions and debugging tools for you. Refer to [Under the hood](how-actors-work.md#under-the-hood).

## Related resources

- [How actors work](how-actors-work.md): the request path, state, and lifecycle.
- [Rules of actors](../best-practices/rules-of-actors.md): design guidance.
- [Semantics](../semantics.md): the exact guarantees.
