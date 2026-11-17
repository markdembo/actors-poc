import { actor, typed } from "actors-poc";

export interface ChatMessage {
  id: number;
  user: string;
  text: string;
  at: number;
}

/** One chat room per key. Messages are durable; who's online comes from live connections. */
export const ChatRoom = actor({
  state: (room: string) => ({ room, nextId: 1, messages: [] as ChatMessage[] }),

  connections: {
    // Set by the Worker in ChatRoom.connect(...), never by the client.
    data: typed<{ user: string }>(),

    onConnect(ctx, conn) {
      if (!/^[\w-]{1,32}$/.test(conn.data.user)) throw new Error("Pick a name: letters, digits, - or _ (max 32)");
      const online = [...ctx.connections().map((c) => c.data.user), conn.data.user];
      conn.send({ type: "welcome", messages: ctx.state.messages.slice(-50), online });
      ctx.broadcast({ type: "joined", user: conn.data.user }, { except: conn.id });
    },

    onMessage(ctx, conn, raw) {
      if (typeof raw !== "string") throw new Error("Text messages only");
      const text = raw.trim();
      if (!text) return;
      if (text.length > 2000) throw new Error("Message too long");
      const message = { id: ctx.state.nextId++, user: conn.data.user, text, at: Date.now() };
      ctx.state.messages.push(message);
      ctx.state.messages = ctx.state.messages.slice(-500);
      ctx.broadcast({ type: "message", message });
      // Injected failure for the demo: the message above is rolled back and never delivered.
      if (text === "/fail") throw new Error("Simulated failure after broadcasting");
    },

    onClose(ctx, conn) {
      ctx.broadcast({ type: "left", user: conn.data.user });
    },
  },

  actions: {
    history: ({ state }, limit: number = 50) => state.messages.slice(-limit),

    online: (ctx) => ctx.connections().map((c) => c.data.user),

    /** Server-side announcement, e.g. from a cron or admin endpoint. Reaches every open socket. */
    announce: (ctx, text: string) => {
      const message = { id: ctx.state.nextId++, user: "system", text, at: Date.now() };
      ctx.state.messages.push(message);
      ctx.broadcast({ type: "message", message });
      return message.id;
    },
  },
});
