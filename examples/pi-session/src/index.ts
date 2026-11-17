import { durable } from "actors-poc";
import { Session } from "./session";

// POST /sessions/:id  {"message": "..."}   → the agent's answer
// GET  /sessions/:id                       → recent transcript
//
// A session id in a URL is not authorization: derive it from an authenticated user in a real app.
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, resource, id] = url.pathname.split("/").map(decodeURIComponent);
    if (resource !== "sessions" || !id) {
      return new Response('Try: curl -X POST localhost:8787/sessions/demo -d \'{"message":"hello"}\'\n', { status: 404 });
    }
    const session = durable(Session).get(id); // DurableObjectStub<Session>: typed RPC, no binding code
    if (request.method === "POST") {
      const { message, requestId } = await request.json<{ message: string; requestId?: string }>();
      return Response.json(await session.ask(message, requestId ?? crypto.randomUUID()));
    }
    return Response.json(await session.history());
  },
};
