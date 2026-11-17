# Rules of actors

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../../README.md) before using any of it.

Actors make stateful code simple to write, but they don't change the distributed-systems facts underneath. This is a guide to designing actors that stay fast, consistent and debuggable. Each rule explains why, then shows a recommended (✅) and a discouraged (🔴) version.

## Design

### Model one actor per entity that owns its data

Pick the thing whose state must stay consistent, such as a customer, cart, room or agent, and make it the key. Every instance runs independently, so many small actors scale across machines automatically. One big actor runs on one thread.

```ts
// ✅ One instance per cart: carts never contend with each other.
const cart = Cart.get(userId);

// 🔴 One instance for every cart: a single thread for your whole store.
const carts = AllCarts.get("global");
```

### Derive keys from authenticated identity

A key is an address. Anyone who can make your Worker call `Cart.get(key)` with a key of their choice can read or change that instance. Authenticate first, then compute the key on the server.

```ts
// ✅ The key comes from a verified session.
const session = await requireSession(request); // your auth
const cart = Cart.get(session.userId);

// 🔴 The key comes straight from the client.
const cart = Cart.get(new URL(request.url).searchParams.get("cart")!);
```

### Make keys stable and structured

The key identifies stored data forever. Changing the format later strands old instances. Prefix keys that come from different sources so they can't collide, and stay under 512 characters.

```ts
// ✅ Stable, namespaced, collision-free.
Workspace.get(`org:${orgId}:ws:${workspaceId}`);

// 🔴 Display names change, and two orgs can share one.
Workspace.get(workspaceName);
```

### Keep one consistency boundary per operation

A single action is atomic. Calls across two actors are not: the second can fail after the first committed. When an operation must be all-or-nothing, put all of its state in one actor. When it can't be, design compensation: a step that undoes or retries the first.

> [!NOTE]
> Different actor types also never share a transaction. If two pieces of state must change together, they belong to the same actor.

### Avoid hot actors

One instance handles roughly a thousand simple requests per second. Past that, callers see `transport` errors. If one key gets most of the traffic, split it by meaning (threads instead of one room, one counter per region), or aggregate writes before they reach the actor. Refer to [Sharding](../findings.md#38-sharding-what-can-and-cant-be-automated).

## State

### Keep the state document small and bounded

Every change rewrites the whole document, and it is capped at 2 MB. Lists that grow forever eventually fail every action. Trim them in the action that appends.

```ts
// ✅ Bounded history.
state.messages.push(message);
state.messages = state.messages.slice(-500);

// 🔴 Grows until the 2 MB limit, then every action fails.
state.messages.push(message);
```

Move old data out, for example to D1 or R2, when you need to keep it.

### Type empty and nullable values explicitly

State types are inferred from the initial value. An empty array literal infers `never[]`, and `null` infers `null`.

```ts
// ✅
state: { messages: [] as Message[], owner: null as string | null }

// 🔴 You can never push to `messages` or set `owner`.
state: { messages: [], owner: null }
```

### Store plain JSON only

The state must survive a JSON round trip. Dates, Maps, Sets and class instances are rejected with a message that says what to use instead.

```ts
// ✅
state.lastSeenAt = Date.now();          // epoch milliseconds
state.tags = [...new Set(state.tags)];  // arrays, not Sets

// 🔴 Rejected: "state.lastSeenAt is a Date (store an ISO string or epoch ms)"
state.lastSeenAt = new Date();
```

### Plan for old state shapes

There are no state migrations. Instances keep whatever shape they last saved. When you add a field, default it where you read it, or normalize it in `validate`.

```ts
// ✅ Works for instances saved before `tags` existed.
const tags = state.tags ?? [];

// 🔴 Throws for every pre-existing instance.
state.tags.push(tag);
```

### Derive what you can instead of storing it

State that mirrors something live goes stale after a crash. Presence is the classic case: read it from `ctx.connections()` instead of keeping an `online` list.

```ts
// ✅ Always correct.
online: (ctx) => ctx.connections().map((c) => c.data.user),

// 🔴 Stale if onClose never ran.
online: ({ state }) => state.online,
```

## Actions and concurrency

### Keep actions short

Actions on one instance run one at a time. A 20-second model call blocks every other action on that instance, including reads, for 20 seconds. Keep slow I/O out of hot paths, or move it to a [scheduled action](../api/action-context.md#schedule). For work that runs for minutes, use a [custom class](../api/durable.md) with a runtime built for it.

### Never await your own actor

A call to the same instance waits behind the action that made it, so it never runs. Cycles (A awaits B, which awaits A) deadlock the same way.

```ts
// ✅ Call a local function.
const total = computeTotal(ctx.state);

// 🔴 Deadlock: waits behind itself.
const total = await Cart.get(ctx.key).total();
```

### Validate arguments at the top of the action

Types are checked at compile time, but the Actor Explorer and other callers can still send anything at runtime. Throw before you mutate.

```ts
// ✅
add: ({ state }, quantity: number) => {
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error("invalid quantity");
  state.count += quantity;
},
```

## Side effects

### Make side effects safe to repeat

Calls to other services are not rolled back. If an action sends an email and then throws, the email is still sent, and a retry sends it again. Record the intent in state, and do the effect in a scheduled action that checks whether it already happened.

```ts
// ✅ The intent commits atomically with the order; delivery is retried and idempotent.
placeOrder: (ctx, order: Order) => {
  ctx.state.orders.push(order);
  ctx.schedule(0, "sendConfirmation", order.id);
},
sendConfirmation: async (ctx, orderId: string) => {
  if (ctx.state.confirmed.includes(orderId)) return; // already done
  await sendEmail(ctx.env, orderId);                  // your email call
  ctx.state.confirmed.push(orderId);
},

// 🔴 If validation fails after this, the email is out and the order isn't saved.
placeOrder: async (ctx, order: Order) => {
  await sendEmail(ctx.env, order.id);
  ctx.state.orders.push(order);
},
```

Scheduled actions are delivered at least once, so the check at the top matters.

### Deduplicate non-idempotent calls with request IDs

Calls are never retried automatically. If you retry after a `transport` error or timeout, the first attempt may already have committed. Have callers send a request ID, and keep a bounded list of processed IDs.

```ts
// ✅
charge: ({ state }, requestId: string, cents: number) => {
  if (state.processed.includes(requestId)) return state.balance;
  state.balance -= cents;
  state.processed = [...state.processed, requestId].slice(-1000);
  return state.balance;
},
```

### Don't treat `ctx.sql` writes as transactional

`ctx.sql` and `ctx.storage` write immediately, even if the action throws afterwards. Use them for data where a stray row is harmless, such as append-only logs and caches. Keep anything that must change atomically in `ctx.state`.

## Errors

### Map error kinds, not messages

Every failed call throws an `ActorError` with a `kind`. Branch on `kind` and `code`, never on message text.

```ts
// ✅
} catch (err) {
  if (!(err instanceof ActorError)) throw err;
  if (err.kind === "action") return Response.json({ error: err.code ?? err.message }, { status: 400 });
  if (err.kind === "transport" || err.kind === "timeout") return new Response("Try again", { status: 503 });
  throw err; // validation and config errors are bugs
}
```

### Give expected failures a code

Throw errors with a `code` property for conditions callers handle. The code survives the trip to the caller.

```ts
// ✅
if (!task) throw Object.assign(new Error(`No task ${id}`), { code: "TASK_NOT_FOUND" });
```

### Put a timeout on user-facing calls

A request should fail fast rather than hang behind a slow action. A timeout stops the wait, not the action.

```ts
// ✅
const items = await Cart.get(userId, { timeoutMs: 2_000 }).list();
```

### Retry only what is safe to retry

Retry only when `err.kind === "transport" && err.retryable`, only for actions that are idempotent or deduplicated, and with backoff. Never retry `action` or `validation` errors: they fail the same way every time.

## Security and privacy

- **Keep the Actor Explorer local.** It is only in `actors dev` builds and only answers on `localhost`. Don't proxy it anywhere.
- **Redact secrets from dev tooling.** List sensitive state keys in `redact.state`, and actions that receive secrets in `redact.args`.
- **Prefer environment secrets over state.** Read API keys from `ctx.env`. Store a user's token in state only when it is per-user, and redact it.
- **Treat connection data as trusted, messages as untrusted.** Identity goes in `connect(..., { data })` from your Worker. Everything a client sends over a WebSocket is input to validate.

## Testing and debugging

- **Inspect, don't guess.** `actors inspect <Type> <key>` and the Actor Explorer show state, the last 100 calls, errors with stacks, and open connections.
- **Log with `ctx.log`.** Lines are attached to the invocation that wrote them, so you can read them next to its error.
- **Inject failures on purpose.** A test-only action that throws after mutating state is the fastest way to confirm rollback in your own app.
- **Test against the real runtime.** Run `actors dev` and drive it over HTTP and WebSockets. The project's own [end-to-end tests](../../tests/e2e.mjs) show the pattern.

## Related resources

- [WebSockets best practices](websockets.md)
- [Semantics](../semantics.md)
- [Limits](../reference/limits.md)
