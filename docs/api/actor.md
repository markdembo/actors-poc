# actor()

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../../README.md) before using any of it.

## `actor`

`actor(config: ActorConfig<S, A, C>)`: `Actor<S, A, C>`

Defines an actor type. Export the result from any file under `src/` as `export const Name = actor({...})`. The export name becomes the actor's name, and the CLI discovers it by this exact form.

#### Parameters

- `config.state` `S | (key: string) => S`
  - The initial state of a new instance, or a function that builds it from the instance's key. Must be plain JSON.
- `config.actions` `Record<string, (ctx: ActionContext<S, C>, ...args) => unknown>`
  - The callable methods. Names starting with `__` and the names `then`, `catch`, `finally`, `constructor`, `toJSON`, `valueOf` and `toString` are reserved.
- `config.onCreate` `(ctx) => void | Promise<void>` Optional
  - Runs once, before the first action or connection of a new instance, in the same transaction.
- `config.validate` `(state: S) => void` Optional
  - Runs before every commit. Throw to reject the commit as a `validation` error. Works well with schema libraries: `validate: (s) => void Schema.parse(s)`.
- `config.migrations` `((state, ctx: { actor, key, sql }) => object)[]` Optional
  - Changes to the shape of state, oldest first. Append only. Each takes the previous state and returns the next. An instance runs the ones it hasn't run yet on its first call after a deploy, synchronously and in one transaction, before the action. New instances start from `state` and never run them. Refer to [Changing actors safely](../best-practices/changing-actors.md).
- `config.redact` `{ state?: (keyof S)[]; args?: (keyof A)[] }` Optional
  - Top-level state keys shown as `"[redacted]"` in the Actor Explorer and `actors inspect`, and actions whose arguments are never recorded in the invocation log.
- `config.connections` `ConnectionsConfig<S, C>` Optional
  - WebSocket hooks. Refer to [Connections](connections.md).
- `config.name` `string` Optional
  - An explicit name. Defaults to the export name.

#### Returns

An `Actor` with `get()` and `connect()`.

#### Example

```ts
import { actor } from "actors-poc";

export const Counter = actor({
  state: { count: 0 },
  actions: {
    increment: ({ state }, by: number = 1) => (state.count += by),
    get: ({ state }) => state.count,
  },
});
```

## `get`

`Actor.get(key: string, options?: GetOptions)`: `ActorRef<A>`

Returns a typed reference to the instance with this key. Creating a reference is free: nothing is sent until you call an action. The instance itself is created by its first action.

#### Parameters

- `key` `string`
  - A non-empty string of at most 512 characters. The same key always reaches the same instance within one deployment.
- `options.timeoutMs` `number` Optional
  - Reject with an `ActorError` of kind `timeout` if no result arrives in time. The action may still complete.

#### Returns

An object with one async method per action. Each takes the action's arguments without `ctx`, and resolves to its return value:

```ts
const total: number = await Counter.get("customer-123").increment(5);
```

The Workers runtime retries a call that fails before it reaches the actor, and never runs an action twice. Actors adds no retries of its own. Failures reject with an [`ActorError`](errors.md).

## `connect`

`Actor.connect(key: string, request: Request, options?: ConnectOptions<C>)`: `Promise<Response>`

Hands a WebSocket upgrade request to the instance with this key. Return the result from your `fetch` handler.

#### Parameters

- `key` `string`
  - The instance to connect to.
- `request` `Request`
  - The incoming upgrade request.
- `options.data` `C` Optional
  - Per-connection data, typically the authenticated user. Plain JSON, at most 8 KB. It must match `connections.data`. It is available as `conn.data` in every hook.

#### Returns

- `101` with the WebSocket, when the connection is accepted.
- `426` when the request is not a WebSocket upgrade.
- `403` with `{ error, code }` when `onConnect` throws.
- `500` with `{ error, code }` when `onConnect` fails validation.

Works on actors without `connections` hooks too. Those sockets only receive broadcasts.

#### Example

```ts
export default {
  async fetch(request: Request) {
    const session = await requireSession(request); // your auth
    return ChatRoom.connect("lobby", request, { data: { user: session.userId } });
  },
};
```

## Related resources

- [Action context](action-context.md)
- [Semantics](../semantics.md)
