import { actor, typed } from "actors-poc";

// WebSocket edge cases exercised by tests/e2e.mjs.
export const Room = actor({
  state: { log: [] as string[] },
  connections: {
    data: typed<{ user: string }>(),
    onConnect(ctx, conn) {
      if (conn.data.user === "banned") throw new Error("banned user");
      conn.send({ hello: conn.data.user, online: ctx.connections().map((c) => c.data.user) });
    },
    onMessage(ctx, conn, message) {
      const text = String(message);
      ctx.state.log.push(`${conn.data.user}:${text}`);
      ctx.broadcast({ from: conn.data.user, text });
      if (text === "destroy") ctx.destroy(); // deletes the room once this hook returns
      if (text === "fail") throw new Error("rolled back after broadcast");
    },
    onClose(ctx, conn) {
      ctx.state.log.push(`${conn.data.user}:left`);
    },
  },
  actions: {
    log: ({ state }) => state.log,
    online: (ctx) => ctx.connections().map((c) => c.data.user).sort(),
    shout: (ctx, text: string) => ctx.broadcast({ from: "server", text }),
    closeRoom: (ctx) => {
      ctx.broadcast({ closing: true }); // delivered before the sockets close
      ctx.destroy();
    },
  },
});
