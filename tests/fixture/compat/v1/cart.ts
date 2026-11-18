import { actor } from "actors-poc";

// The "shipped" version for tests/compat.mjs. v2/cart.ts changes each action in one way.
type Line = { sku: string; qty: number };

export const Cart = actor({
  state: { lines: [] as Line[], status: "open" as "open" | "paid" },
  actions: {
    add: ({ state }, sku: string, qty: number) => void state.lines.push({ sku, qty }),
    remove: ({ state }, sku: string) => void (state.lines = state.lines.filter((l) => l.sku !== sku)),
    setQty: (_ctx, _sku: string, _qty: number) => {},
    checkout: (_ctx, _opts: { coupon?: string }) => {},
    ship: (_ctx, _address: { city: string }) => {},
    list: ({ state }): Line[] => state.lines,
    total: ({ state }) => state.lines.reduce((n, l) => n + l.qty, 0),
    status: ({ state }) => state.status,
    tag: (_ctx, _t: "a" | "b") => {},
    limit: (_ctx, _n?: number) => {},
    since: (_ctx, _d: Date) => {},
    find: (_ctx, _q: { sku: string }): Line | undefined => undefined,
    gone: () => {},
  },
});
