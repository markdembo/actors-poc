import { ChatRoom } from "./actors/room";
import page from "./page.html";

// GET  /                      → a tiny browser client
// GET  /rooms/:room/ws?user=  → WebSocket (ChatRoom.connect)
// GET  /rooms/:room           → recent messages and who's online
// POST /rooms/:room/announce  {"text": "..."} → system message to everyone
//
// NOTE: the user name comes from the query string to keep the demo small. A real app must
// authenticate the request and pass the verified identity as `data`.
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });

    const [, resource, room, op] = url.pathname.split("/").map(decodeURIComponent);
    if (resource !== "rooms" || !room) return new Response("Not found\n", { status: 404 });

    if (op === "ws") {
      return ChatRoom.connect(room, request, { data: { user: url.searchParams.get("user") ?? "" } });
    }
    const ref = ChatRoom.get(room);
    if (op === "announce" && request.method === "POST") {
      const { text } = await request.json<{ text: string }>();
      return Response.json({ id: await ref.announce(text) });
    }
    if (!op) return Response.json({ messages: await ref.history(), online: await ref.online() });
    return new Response("Not found\n", { status: 404 });
  },
};
