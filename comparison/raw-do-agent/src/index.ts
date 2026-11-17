import { type Env, SupportAgent } from "./agent";

export { SupportAgent };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, resource, customer, op] = url.pathname.split("/").map(decodeURIComponent);
    if (resource !== "agents" || !customer) {
      return new Response("Not found\n", { status: 404 });
    }

    const agent = env.SUPPORT_AGENT.get(env.SUPPORT_AGENT.idFromName(customer));
    try {
      if (request.method === "POST" && op === "chat") {
        const { message } = await request.json<{ message: string }>();
        return Response.json({ reply: await agent.chat(customer, message) });
      }
      if (request.method === "POST" && op === "tasks") {
        const { title } = await request.json<{ title: string }>();
        return Response.json(await agent.addTask(customer, title), { status: 201 });
      }
      if (request.method === "GET" && !op) {
        return Response.json(await agent.history(customer));
      }
      return new Response("Not found\n", { status: 404 });
    } catch (err) {
      // RPC preserves name, message and custom props (e.g. `code`) and sets `remote: true`
      // for errors thrown by the object's code. Infrastructure errors carry `retryable`/`overloaded`.
      const e = err as Error & { remote?: boolean; retryable?: boolean; overloaded?: boolean; code?: string };
      if (e.remote && !e.retryable && !e.overloaded) {
        return Response.json({ error: e.message, code: e.code }, { status: 422 });
      }
      throw err;
    }
  },
};
