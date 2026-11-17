# WebSockets

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../../README.md) before using any of it.

Actors accept WebSocket connections through `Actor.connect()`. Each socket event (`onConnect`, `onMessage`, `onClose`) runs as an action: queued, transactional, and rolled back if it throws. Messages you send go out only after the event's changes are saved.

This page covers how to use that model well. Refer to the [connections API](../api/connections.md) for every option.

## Authenticate in the Worker, then connect

Your Worker sees the upgrade request first. Verify who is connecting there, and pass the verified identity as connection data. The actor never sees the raw request, and clients can't forge the data.

```ts
// ✅
const session = await requireSession(request); // your auth
return ChatRoom.connect(roomId, request, { data: { user: session.userId } });

// 🔴 Identity read from a message the client controls.
onMessage(ctx, conn, raw) {
  const { user, text } = JSON.parse(String(raw));
  ctx.broadcast({ user, text });
}
```

## Refuse connections in `onConnect`

Throwing in `onConnect` returns HTTP 403 with your message, and no socket is opened. Check membership, bans and capacity there.

```ts
// ✅
onConnect(ctx, conn) {
  if (!ctx.state.members.includes(conn.data.user)) throw new Error("Not a member of this room");
  if (ctx.connections().length >= 500) throw new Error("Room is full");
},
```

## Treat every message as untrusted input

Parse and validate inside `onMessage`, and limit size. To report a problem to the client, catch it and reply. If you throw instead, your reply is discarded along with everything else.

```ts
// ✅ The client learns what went wrong; state is untouched.
onMessage(ctx, conn, raw) {
  const parsed = parseClientMessage(raw); // returns { ok, value } or { ok: false, error }
  if (!parsed.ok) {
    conn.send({ type: "error", error: parsed.error });
    return;
  }
  // ...apply parsed.value
},

// 🔴 The client never hears about the error.
onMessage(ctx, conn, raw) {
  const msg = JSON.parse(String(raw)); // throws on bad input; any reply is discarded
},
```

## Resync on reconnect

Delivery is at most once. A client that is offline, reconnecting or slow misses broadcasts. Give every durable event an increasing ID, send recent history in `onConnect`, and let clients ask for what they missed.

```ts
// ✅
onConnect(ctx, conn) {
  conn.send({ type: "welcome", messages: ctx.state.messages.slice(-50) });
},
// client keeps the last id it saw and, after reconnecting, fetches newer messages
```

## Broadcast changes, not whole state

Each broadcast is sent once per open socket. Send the event that happened, not the full document.

```ts
// ✅
ctx.broadcast({ type: "message", message });

// 🔴 Resends everything to everyone on every message.
ctx.broadcast({ type: "state", state: ctx.state });
```

For very chatty rooms, collect several events and broadcast them as one array. Cloudflare's guidance is 10–100 logical messages per frame.

## Derive presence from live connections

`ctx.connections()` lists the sockets that are open right now, with their data. A stored "online" list goes stale when a process dies before `onClose` runs.

```ts
// ✅
online: (ctx) => [...new Set(ctx.connections().map((c) => c.data.user))],
```

## Know where one room stops scaling

Every message is one transactional action, and every broadcast is one send per socket. One instance is a single thread with a soft limit of about a thousand requests per second. Large rooms run out of fan-out first, around 5,000 members sending 20 messages a second. Split the room by meaning (threads or channels) before you reach that point. Refer to [Sharding](../findings.md#38-sharding-what-can-and-cant-be-automated).

## Related resources

- [Build a chat room](../tutorials/build-a-chat-room.md)
- [Connections API](../api/connections.md)
- [Semantics: WebSockets](../semantics.md#websockets)
- [Durable Objects: WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) ↗
