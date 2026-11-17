# Connections

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../../README.md) before using any of it.

Add `connections` to an actor to accept WebSockets through [`Actor.connect()`](actor.md#connect). Each hook runs like an action: queued with the instance's other actions, committed atomically, and rolled back if it throws. Sockets hibernate: an idle actor can be unloaded from memory without closing them, and the next message wakes it.

```ts
import { actor, typed } from "actors-poc";

export const Room = actor({
  state: { messages: [] as string[] },
  connections: {
    data: typed<{ user: string }>(),
    onConnect(ctx, conn) { conn.send({ history: ctx.state.messages }); },
    onMessage(ctx, conn, message) {
      ctx.state.messages.push(String(message));
      ctx.broadcast({ from: conn.data.user, message: String(message) });
    },
    onClose(ctx, conn) { ctx.broadcast({ left: conn.data.user }); },
  },
  actions: {},
});
```

## `connections.data`

`data?: C`

A type witness for per-connection data. Write `data: typed<YourType>()`. The values come from `Actor.connect(key, request, { data })`, never from the client.

## `typed`

`typed<T>(): T`

Returns `undefined` with the type `T`. It exists only to declare `connections.data`.

## `onConnect`

`onConnect?(ctx: ActionContext<S, C>, conn: Connection<C>): void | Promise<void>`

A client is connecting. Runs before the socket is accepted. Throw to refuse: the client gets HTTP 403 with your message, and no socket opens. Messages sent to `conn` are delivered right after the socket is accepted.

## `onMessage`

`onMessage?(ctx: ActionContext<S, C>, conn: Connection<C>, message: string | ArrayBuffer): void | Promise<void>`

A message arrived. If the hook throws, its state changes and queued messages are discarded, and the socket stays open. Catch errors and `conn.send` a reply if the client should know. Without this hook, incoming messages are ignored.

## `onClose`

`onClose?(ctx: ActionContext<S, C>, conn: Connection<C>, info: { code: number; reason: string; wasClean: boolean }): void | Promise<void>`

The client disconnected, or the connection failed. Runs once per connection.

## `Connection`

The `conn` argument of every hook.

| Member | Type | Description |
|---|---|---|
| `id` | `string` | Stable ID for this connection. Survives hibernation. |
| `data` | `C` | The data your Worker passed to `connect()`. |
| `send(message)` | `(message: string \| object \| number \| boolean \| null) => void` | Queues a message to this connection only. Sent after commit. |
| `close(code?, reason?)` | `(code?: number, reason?: string) => void` | Closes this connection after commit. |

## Delivery guarantees

- **After commit.** Messages are delivered only after the invocation that queued them commits, in the order they were queued.
- **At most once.** Clients that are disconnected when a message is sent don't get it. Resync on reconnect.
- **Bounded data.** Connection data is stored on the socket, so it is limited to 8 KB of JSON.

Refer to [WebSockets best practices](../best-practices/websockets.md) and [Semantics: WebSockets](../semantics.md#websockets).
