// Compile-time checks for FR4. `tsc -p tests/types` must pass: every @ts-expect-error
// line must actually be an error, and every other line must type-check.
import { DurableObject } from "cloudflare:workers";
import { actor, durable, typed, type ActorRef } from "actors-poc";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assert = <T extends true>() => {};

const Counter = actor({
  state: { count: 0, label: "x" },
  actions: {
    increment: ({ state }, amount: number = 1) => {
      state.count += amount;
      // @ts-expect-error state is typed from the initial state
      state.count = "nope";
      // @ts-expect-error unknown state field
      state.missing = 1;
      return state.count;
    },
    rename: async (ctx, label: string, opts: { upper: boolean }) => {
      ctx.state.label = opts.upper ? label.toUpperCase() : label;
      return { label: ctx.state.label, at: Date.now() };
    },
    get: ({ state }) => state.count,
  },
});

async function usage() {
  const c = Counter.get("customer-123");

  // Return types are inferred and wrapped in a Promise.
  const n = await c.increment(2);
  assert<Equal<typeof n, number>>();
  const r = await c.rename("a", { upper: true });
  assert<Equal<typeof r, { label: string; at: number }>>();

  // Optional args follow the action's signature.
  await c.increment();

  // @ts-expect-error invalid method name
  await c.decrement(1);
  // @ts-expect-error wrong argument type
  await c.increment("1");
  // @ts-expect-error missing required argument
  await c.rename("a");
  // @ts-expect-error too many arguments
  await c.get(1);
  // @ts-expect-error the ctx parameter is not part of the caller's signature
  await c.increment({ state: { count: 0 } }, 1);

  // Refs are plain types you can pass around.
  const ref: ActorRef<typeof Counter.__config.actions> = c;
  void ref;
}
void usage;

// State factories receive the key and drive the state type.
const Agent = actor({
  state: (id: string) => ({ id, messages: [] as string[] }),
  actions: {
    say: ({ state }, m: string) => {
      state.messages.push(m);
      return state.messages.length;
    },
  },
});
async function agentUsage() {
  const len = await Agent.get("a").say("hi");
  assert<Equal<typeof len, number>>();
  // @ts-expect-error
  await Agent.get("a").say(42);
}
void agentUsage;

// redact keys are checked against state keys and action names.
actor({
  state: { token: "", n: 0 },
  redact: { state: ["token"], args: ["setToken"] },
  actions: { setToken: ({ state }, t: string) => void (state.token = t) },
});
actor({
  state: { token: "" },
  // @ts-expect-error not a state key
  redact: { state: ["nope"] },
  actions: { a: () => 1 },
});

// durable(): typed stubs for raw Durable Object classes.
class Ledger extends DurableObject {
  async add(amount: number): Promise<number> {
    return amount;
  }
}
async function durableUsage() {
  const total = await durable(Ledger).get("acct-1").add(5);
  assert<Equal<typeof total, number>>();
  // @ts-expect-error wrong argument type
  await durable(Ledger).get("acct-1").add("5");
  // @ts-expect-error no such method
  await durable(Ledger).get("acct-1").remove(5);
  // @ts-expect-error durable() takes a Durable Object class
  durable(class NotADurableObject {});
}
void durableUsage;

// WebSocket hooks: per-connection data is typed end to end.
const Room = actor({
  state: { log: [] as string[] },
  connections: {
    data: typed<{ user: string }>(),
    onConnect(ctx, conn) {
      const user: string = conn.data.user;
      // @ts-expect-error not a field of the connection data
      void conn.data.nope;
      ctx.state.log.push(user);
      conn.send({ hello: user });
    },
    onMessage(ctx, conn, message) {
      const m: string | ArrayBuffer = message;
      ctx.broadcast({ from: conn.data.user, m: String(m) }, { except: conn.id });
    },
  },
  actions: {
    online: (ctx) => ctx.connections().map((c) => c.data.user),
  },
});
async function roomUsage(request: Request) {
  const online = await Room.get("r").online();
  assert<Equal<typeof online, string[]>>();
  await Room.connect("r", request, { data: { user: "ada" } });
  // @ts-expect-error data must match connections.data
  await Room.connect("r", request, { data: { name: "ada" } });
  // Actors without connections.data accept no connection data.
  // @ts-expect-error Counter declares no connection data
  await Counter.connect("c", request, { data: { user: "ada" } });
}
void roomUsage;

// ── Migrations: old shapes are untyped (annotate if you like); each step returns the next state.
export const Migrated = actor({
  state: { items: [] as string[], currency: "USD" },
  migrations: [
    ({ lines, ...s }: { lines: string[] }) => ({ ...s, items: lines }),
    (s, ctx) => {
      ctx.sql.exec("SELECT 1");
      const k: string = ctx.key;
      void k;
      return { ...s, currency: "USD" };
    },
  ],
  actions: { count: ({ state }) => state.items.length },
});
actor({
  state: { n: 0 },
  // @ts-expect-error a migration must return the new state
  migrations: [(s) => void s],
  actions: {},
});
