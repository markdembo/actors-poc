import { ActorError, durable } from "actors-poc";
import { Ledger } from "./ledger";
import { Probe } from "./probe";
import { Room } from "./room";

// POST /call/:key/:method?timeoutMs=  body: JSON array of args
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, route, key, method] = url.pathname.split("/").map(decodeURIComponent);
    if (route === "ws") return Room.connect(key, request, { data: { user: url.searchParams.get("user") ?? "" } });
    if (route === "room") {
      const args = request.method === "POST" ? await request.json<unknown[]>() : [];
      const ref = Room.get(key) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      return Response.json({ ok: true, value: await ref[method](...args) });
    }
    if (route === "ledger") {
      const ledger = durable(Ledger).get(key);
      const value = method === "add" ? await ledger.add(Number(url.searchParams.get("n") ?? 1)) : await ledger.total();
      return Response.json({ ok: true, value });
    }
    if (route !== "call") return new Response("fixture worker", { status: 404 });
    const args = request.method === "POST" ? await request.json<unknown[]>() : [];
    const timeoutMs = url.searchParams.has("timeoutMs") ? Number(url.searchParams.get("timeoutMs")) : undefined;
    const ref = Probe.get(key, { timeoutMs }) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    try {
      return Response.json({ ok: true, value: await ref[method](...args) });
    } catch (err) {
      if (!(err instanceof ActorError)) throw err;
      const { kind, code, remoteName, actor, method: m, retryable, message } = err;
      return Response.json({ ok: false, error: { kind, code, remoteName, actor, method: m, retryable, message } });
    }
  },
};
