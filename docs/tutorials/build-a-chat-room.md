# Build a chat room

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../../README.md) before using any of it.

In this tutorial, you build a real-time chat room where:

- Every room is one actor instance, keyed by room name.
- Clients connect over WebSockets, with their identity set by your Worker.
- Messages are saved, then broadcast. A message that fails to save is never broadcast.
- The online list comes from live connections, so it can't go stale.

The finished code is in [`examples/chat`](../../examples/chat).

## Prerequisites

Complete [Get started](../get-started.md) first, or start from a project with the same `package.json` and `tsconfig.json`.

## 1. Define the room

Create `src/actors/room.ts`:

```ts title="src/actors/room.ts"
import { actor, typed } from "actors-poc";

export interface ChatMessage {
  id: number;
  user: string;
  text: string;
  at: number;
}

export const ChatRoom = actor({
  state: (room: string) => ({ room, nextId: 1, messages: [] as ChatMessage[] }),

  connections: {
    data: typed<{ user: string }>(),

    onConnect(ctx, conn) {
      if (!/^[\w-]{1,32}$/.test(conn.data.user)) throw new Error("Pick a name: letters, digits, - or _ (max 32)");
      const online = [...ctx.connections().map((c) => c.data.user), conn.data.user];
      conn.send({ type: "welcome", messages: ctx.state.messages.slice(-50), online });
      ctx.broadcast({ type: "joined", user: conn.data.user }, { except: conn.id });
    },

    onMessage(ctx, conn, raw) {
      if (typeof raw !== "string") return;
      const text = raw.trim();
      if (!text || text.length > 2000) {
        conn.send({ type: "error", error: "Messages must be 1-2000 characters" });
        return;
      }
      const message = { id: ctx.state.nextId++, user: conn.data.user, text, at: Date.now() };
      ctx.state.messages.push(message);
      ctx.state.messages = ctx.state.messages.slice(-500);
      ctx.broadcast({ type: "message", message });
    },

    onClose(ctx, conn) {
      ctx.broadcast({ type: "left", user: conn.data.user });
    },
  },

  actions: {
    history: ({ state }, limit: number = 50) => state.messages.slice(-limit),
    online: (ctx) => ctx.connections().map((c) => c.data.user),
  },
});
```

In the code above, you have:

1. Used a state factory, `(room) => ({ room, ... })`, so each instance knows its own name.
2. Declared the connection data type with `typed<{ user: string }>()`. `conn.data.user` is now a `string` everywhere.
3. Refused bad names in `onConnect` by throwing. The client gets HTTP 403 and no socket opens.
4. Sent the newcomer recent history with `conn.send`, and told everyone else with `ctx.broadcast`, using `except` to skip the newcomer.
5. Replied to bad input instead of throwing, so the client learns what went wrong.
6. Bounded the history to 500 messages, so the state document never outgrows its limit.

## 2. Connect from your Worker

Create `src/index.ts`:

```ts title="src/index.ts"
import { ChatRoom } from "./actors/room";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, resource, room, op] = url.pathname.split("/").map(decodeURIComponent);
    if (resource !== "rooms" || !room) return new Response("Not found", { status: 404 });

    if (op === "ws") {
      const user = url.searchParams.get("user") ?? ""; // demo only: use your real auth here
      return ChatRoom.connect(room, request, { data: { user } });
    }
    const ref = ChatRoom.get(room);
    return Response.json({ messages: await ref.history(), online: await ref.online() });
  },
};
```

`ChatRoom.connect()` returns `426` for requests that aren't WebSocket upgrades, `403` when `onConnect` refuses, and the upgrade response otherwise. Return it from your handler as-is.

> [!CAUTION]
> Taking the user name from the query string keeps this tutorial short. In a real app, authenticate the request and pass the verified identity as `data`. Refer to [Authenticate in the Worker](../best-practices/websockets.md#authenticate-in-the-worker-then-connect).

## 3. Try it

```sh
pnpm dev
```

Connect two clients, for example with two browser tabs on the [example's page](../../examples/chat/src/page.html), or from Node.js 22+:

```js title="client.mjs"
const ws = new WebSocket("ws://localhost:8787/rooms/lobby/ws?user=ada");
ws.onmessage = (e) => console.log(JSON.parse(e.data));
ws.onopen = () => ws.send("hello");
```

Every connected client receives `{ type: "message", ... }`. Read the room over HTTP:

```sh
curl localhost:8787/rooms/lobby
```

## 4. Inspect it

Open `http://localhost:8787/__actors` and select **ChatRoom → lobby**. You can see:

- **Persisted state**: the saved messages.
- **Activity**: each `onConnect`, `onMessage` and `onClose`, with source `websocket`.
- **Connections**: the open sockets and their data.

Invoke `history` with `[5]` from the console to read the last five messages.

## Summary

By finishing this tutorial, you have:

- Built a durable chat room with typed connection data.
- Seen that messages are saved before they are broadcast.
- Used live connections for presence instead of stored state.

## Related resources

- [WebSockets best practices](../best-practices/websockets.md)
- [Connections API](../api/connections.md)
- [Semantics: WebSockets](../semantics.md#websockets)
