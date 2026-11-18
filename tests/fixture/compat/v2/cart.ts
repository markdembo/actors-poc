import { actor } from "actors-poc";

// The new version for tests/compat.mjs. Compare with v1/cart.ts.
interface Line {
  sku: string;
  qty: number;
  price: number;
}

export const Cart = actor({
  state: { lines: [] as Line[], status: "open" as "open" | "paid" | "shipped" },
  actions: {
    add: ({ state }, sku: string, qty: number, _note?: string) => void state.lines.push({ sku, qty, price: 0 }), // ok: optional arg added
    remove: ({ state }, sku: string | number) => void (state.lines = state.lines.filter((l) => l.sku !== sku)), // ok: widened
    setQty: (_ctx, _sku: string, _qty: string) => {}, // breaks: number → string
    checkout: (_ctx, _opts: { coupon: string }) => {}, // breaks: coupon became required
    ship: (_ctx, _address: { city: string; zip: string }) => {}, // breaks: new required property
    list: ({ state }): Line[] => state.lines, // ok: returns an extra property
    total: ({ state }) => (state.lines.length ? state.lines.reduce((n, l) => n + l.qty, 0) : null), // breaks: may return null
    status: ({ state }) => state.status, // breaks: may return "shipped"
    tag: (_ctx, _t: "a" | "b" | "c") => {}, // ok: widened
    limit: (_ctx, _n: number) => {}, // breaks: became required
    since: (_ctx, _d: Date) => {}, // ok: unchanged
    find: (_ctx, _q: { sku: string }): Promise<Line | undefined> => Promise.resolve(undefined), // ok: async, same shape
    renamed: () => {}, // `gone` was removed
  },
});
