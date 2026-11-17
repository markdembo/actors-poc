import { ActorError } from "actors-poc";
import { SupportAgent } from "./actors/support-agent";

// A tiny HTTP API in front of one SupportAgent per customer.
//   POST /agents/:customer/chat   {"message": "..."}
//   GET  /agents/:customer
//   POST /agents/:customer/tasks  {"title": "..."}
//
// NOTE: a customer id in a URL is not authorization. A real app would authenticate the
// caller and derive the actor key from the session, never trust it from the client.
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, resource, customer, op] = url.pathname.split("/").map(decodeURIComponent);
    if (resource !== "agents" || !customer) {
      return new Response(
        'Try: curl -X POST localhost:8787/agents/acme/chat -d \'{"message":"my name is Ada"}\'\n',
        { status: 404 },
      );
    }

    const agent = SupportAgent.get(customer);
    try {
      if (request.method === "POST" && op === "chat") {
        const { message } = await request.json<{ message: string }>();
        return Response.json({ reply: await agent.chat(message) });
      }
      if (request.method === "POST" && op === "tasks") {
        const { title } = await request.json<{ title: string }>();
        return Response.json(await agent.addTask(title), { status: 201 });
      }
      if (request.method === "GET" && !op) {
        return Response.json(await agent.history());
      }
      return new Response("Not found\n", { status: 404 });
    } catch (err) {
      if (err instanceof ActorError && err.kind === "action") {
        return Response.json({ error: err.message, code: err.code }, { status: 422 });
      }
      throw err;
    }
  },
};
