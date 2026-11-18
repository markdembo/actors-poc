import { actor } from "actors-poc";

// Edge cases exercised by tests/e2e.mjs.
export const Probe = actor({
  state: (key: string) => ({ key, n: 0, items: [] as string[], created: false, when: null as unknown, secret: "s3cr3t" }),
  onCreate: ({ state }) => {
    state.created = true;
  },
  redact: { state: ["secret"], args: ["setSecret"] },
  actions: {
    add: ({ state }, by: number) => (state.n += by),
    addThenThrow: ({ state }) => {
      state.n += 1000;
      throw Object.assign(new Error("boom"), { code: "BOOM" });
    },
    storeDate: ({ state }) => {
      state.when = new Date();
    },
    returnFn: () => () => 1,
    replace: (ctx) => {
      ctx.state = { ...ctx.state, n: -1 };
    },
    scheduleThenThrow: (ctx) => {
      ctx.schedule(1, "add", 1);
      throw new Error("no schedule should survive this");
    },
    scheduleAdd: (ctx, seconds: number, by: number) => ctx.schedule(seconds, "add", by),
    slow: async ({ state }, ms: number) => {
      await new Promise((r) => setTimeout(r, ms));
      state.items.push("slow");
    },
    fast: ({ state }) => {
      state.items.push("fast");
    },
    setSecret: ({ state }, s: string) => {
      state.secret = s;
    },
    get: ({ state }) => state,
    expire: (ctx) => {
      ctx.destroy();
      return "bye";
    },
    destroyThenThrow: (ctx) => {
      ctx.destroy();
      throw new Error("nothing is deleted");
    },
    scheduleExpire: (ctx, seconds: number) => ctx.schedule(seconds, "expire"),
  },
});
