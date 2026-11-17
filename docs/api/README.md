# API reference

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../../README.md) before using any of it.

Everything is imported from `actors-poc`:

```ts
import { actor, typed, durable, ActorError } from "actors-poc";
```

- [`actor()`](actor.md): define an actor, then call it with `get()` or `connect()`.
- [Action context](action-context.md): what every action and hook receives as `ctx`.
- [Connections](connections.md): WebSocket hooks, `Connection`, `typed()`.
- [Errors](errors.md): `ActorError` and its kinds.
- [`durable()`](durable.md): custom classes, for when an actor isn't the right shape.

For the command line, refer to the [CLI reference](../reference/cli.md).
