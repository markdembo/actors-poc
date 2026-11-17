import { Counter } from "./actors/counter";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // GET /counter/:id            -> current value
    // POST /counter/:id/increment -> increment by ?by= (default 1)
    const [, resource, id, op] = url.pathname.split("/");
    if (resource !== "counter" || !id) {
      return new Response("Try: curl -X POST localhost:8787/counter/customer-123/increment\n", { status: 404 });
    }

    const counter = Counter.get(id);
    if (request.method === "POST" && op === "increment") {
      const count = await counter.increment(Number(url.searchParams.get("by") ?? 1));
      return Response.json({ id, count });
    }
    return Response.json({ id, count: await counter.get() });
  },
};
