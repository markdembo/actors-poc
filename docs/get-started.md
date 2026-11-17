# Get started

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../README.md) before using any of it.

This guide walks you through:

- Creating a project that uses actors.
- Writing a shopping cart actor with typed actions.
- Calling it from a Worker.
- Running it locally and inspecting its state.
- Deploying it.

Refer to [What are actors?](concepts/what-are-actors.md) for the ideas behind each step.

## Prerequisites

1. [Node.js](https://nodejs.org/) ↗ 22 or later. This guide was tested with Node.js 24.
2. [pnpm](https://pnpm.io/) ↗ 10 or later. The package is installed from a subdirectory of a Git repository, which npm does not support.
3. A [Cloudflare account](https://dash.cloudflare.com/sign-up/workers-and-pages) ↗, only for the deploy step.

## 1. Create a project

Create a folder and a `package.json`:

```sh
mkdir my-actors && cd my-actors
pnpm init
```

Allow the native builds Wrangler needs. Add this to `package.json`, and set the module type and scripts at the same time:

```json title="package.json"
{
  "type": "module",
  "scripts": {
    "dev": "actors dev",
    "deploy": "actors deploy",
    "typecheck": "tsc --noEmit"
  },
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild", "workerd"]
  }
}
```

Install the package from GitHub, plus Wrangler, the Workers types and TypeScript:

```sh
pnpm add "github:markdembo/actors-poc#path:packages/actors"
pnpm add -D wrangler@^4.163.0 @cloudflare/workers-types typescript
```

Add a `tsconfig.json`:

```json title="tsconfig.json"
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src"]
}
```

> [!NOTE]
> `allowImportingTsExtensions` is needed because the package ships TypeScript sources rather than compiled JavaScript.

## 2. Write an actor

Create `src/actors/cart.ts`:

```ts title="src/actors/cart.ts"
import { actor } from "actors-poc";

export interface CartItem {
  sku: string;
  quantity: number;
}

export const Cart = actor({
  state: { items: [] as CartItem[] },
  actions: {
    add: ({ state }, sku: string, quantity: number = 1) => {
      if (!Number.isInteger(quantity) || quantity < 1) throw new Error("quantity must be a positive integer");
      const existing = state.items.find((item) => item.sku === sku);
      if (existing) existing.quantity += quantity;
      else state.items.push({ sku, quantity });
      return state.items;
    },
    remove: ({ state }, sku: string) => {
      state.items = state.items.filter((item) => item.sku !== sku);
      return state.items;
    },
    list: ({ state }) => state.items,
  },
});
```

In the code above, you have:

1. Exported the actor as `export const Cart = actor(...)`. The CLI finds actors by this exact form, and the export name becomes the actor's name.
2. Declared the initial state of every new cart. `[] as CartItem[]` tells TypeScript what the empty array will hold.
3. Defined three actions. Each receives a context (`{ state }`) first, then the caller's arguments.
4. Thrown an error for bad input. When an action throws, any change it made to `state` is discarded.

## 3. Call it from your Worker

Create `src/index.ts`:

```ts title="src/index.ts"
import { ActorError } from "actors-poc";
import { Cart } from "./actors/cart";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, resource, cartId, sku] = url.pathname.split("/");
    if (resource !== "carts" || !cartId) return new Response("Not found", { status: 404 });

    const cart = Cart.get(cartId);
    try {
      if (request.method === "POST" && sku) {
        return Response.json(await cart.add(sku, Number(url.searchParams.get("quantity") ?? 1)));
      }
      if (request.method === "DELETE" && sku) return Response.json(await cart.remove(sku));
      return Response.json(await cart.list());
    } catch (err) {
      if (err instanceof ActorError && err.kind === "action") {
        return Response.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  },
};
```

In the code above, you have:

1. Got a typed reference with `Cart.get(cartId)`. Every request with the same `cartId` reaches the same instance.
2. Called actions like ordinary async methods. `cart.add("x", "2")` would not compile.
3. Mapped errors the action threw (`kind: "action"`) to HTTP 400 and let everything else fail loudly.

> [!CAUTION]
> In a real app, derive `cartId` from the authenticated user, not from the URL. An actor key is an address, not proof of who is asking. Refer to [Rules of actors](best-practices/rules-of-actors.md#derive-keys-from-authenticated-identity).

## 4. Run it locally

```sh
pnpm dev
```

The CLI discovers `Cart`, writes `wrangler.jsonc` and the generated entry points in `.actors/`, and starts `wrangler dev`. You should see:

```txt
✓ 1 actor: Cart src/actors/cart.ts
✓ worker: src/index.ts
✓ wrangler.jsonc: created wrangler.jsonc
◆ Actor Explorer: http://localhost:8787/__actors
```

In a second terminal, add an item, try an invalid one, and read the cart:

```sh
curl -X POST "localhost:8787/carts/alice/sku-123?quantity=2"
curl -X POST "localhost:8787/carts/alice/sku-123?quantity=0"
curl localhost:8787/carts/alice
```

The second request returns `400` and the cart still has two items: the failed action changed nothing.

Add `.actors/` and `.wrangler/` to your `.gitignore`. Both are reproducible.

## 5. Inspect the actor

Open `http://localhost:8787/__actors` and select **Cart → alice**. You can see the saved state, every recent call (including the failed one, with its stack trace), and invoke actions with JSON arguments.

From the terminal:

```sh
pnpm exec actors inspect Cart alice
```

Stop and restart `pnpm dev`, then read the cart again. The state survives because it lives in the instance's SQLite storage, not in memory.

## 6. Deploy

Log in to Wrangler, then deploy:

```sh
pnpm exec wrangler login
pnpm run deploy
```

Use `pnpm run deploy`, not `pnpm deploy`: pnpm has a built-in `deploy` command that runs instead.

The production build does not include the Actor Explorer or any inspection routes.

> [!CAUTION]
> This proof of concept has been run locally and bundled with `wrangler deploy --dry-run`, but not tested on a real account. Expect rough edges.

## Summary and final code

By finishing this guide, you have:

- Defined an actor with typed state and actions.
- Called it from a Worker with compile-time checked arguments and results.
- Seen a failed action leave state untouched.
- Inspected live state locally and confirmed it survives a restart.

The full project is the four files above: `package.json`, `tsconfig.json`, `src/actors/cart.ts` and `src/index.ts`. Everything else is generated.

## Related resources

- [Rules of actors](best-practices/rules-of-actors.md): design actors that scale and fail safely.
- [Build a chat room](tutorials/build-a-chat-room.md): add WebSockets.
- [Build a persistent AI agent](tutorials/build-an-ai-agent.md): memory, tools, scheduling and rollback.
- [API reference](api/README.md): everything `actor()` accepts.
