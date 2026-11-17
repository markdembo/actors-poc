# Actors (proof of concept)

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../README.md) before using any of it.

Build stateful TypeScript services on Durable Objects without writing Durable Object classes, bindings or migrations.

An actor is a typed, stateful service with one instance per key: one per customer, cart, chat room or AI agent. You define its state and its actions. The framework runs each instance in a Durable Object, saves its state transactionally, and gives you a typed client to call it from your Worker.

Use actors to build:

- Per-customer or per-tenant services with isolated state.
- Persistent AI agents with memory, tasks and scheduled follow-ups.
- Real-time rooms over WebSockets: chat, presence, collaborative sessions.
- Anything where many requests must agree on one piece of state.

**[Get started](get-started.md)**

### What is an actor?

An actor is a Durable Object you never have to write by hand:

- **Defined, not subclassed.** You write `actor({ state, actions })`. There is no class, binding, migration, ID or stub in your code.
- **Transactional.** Each action works on a private copy of the state. It is saved atomically when the action returns and discarded when it throws.
- **One at a time.** Actions on one instance run in arrival order, so you never write locks.
- **Typed end to end.** `Counter.get("customer-123").increment(5)` is checked at compile time, from method name to return type.

Refer to [What are actors?](concepts/what-are-actors.md) to learn more.

## Features

#### [Transactional state](concepts/how-actors-work.md#state-and-transactions)
State is a JSON document per instance, committed atomically, together with scheduled work and an invocation log.

#### [WebSockets](best-practices/websockets.md)
Connection hooks run as actions. Messages go out only after the change that produced them is saved.

#### [Scheduling](api/action-context.md#schedule)
Run an action later, at least once, with retries. Scheduling is part of the same transaction as the action that requests it.

#### [Actor Explorer](reference/cli.md#actor-explorer)
A local web UI and CLI to list instances, read their state, replay actions and trace failures.

#### [Zero-config Durable Objects](api/durable.md)
Need a real Durable Object class? Export it, and the CLI wires up its binding and migration, with a typed `durable(Class).get(name)`.

## Related products

**[Durable Objects](https://developers.cloudflare.com/durable-objects/) ↗**
The platform every actor instance runs on. Each instance is one Durable Object with its own SQLite storage.

**[Workers](https://developers.cloudflare.com/workers/) ↗**
Your app's entry point. Your Worker calls actors and hands WebSocket upgrades to them.

**[Wrangler](https://developers.cloudflare.com/workers/wrangler/) ↗**
The CLI that the `actors` CLI generates configuration for and delegates to.

## More resources

#### [Get started](get-started.md)
Build and run a shopping cart actor locally in about ten minutes.

#### [Rules of actors](best-practices/rules-of-actors.md)
How to design actors, keep state healthy, handle side effects and errors.

#### [API reference](api/README.md)
`actor()`, the action context, connections, errors and `durable()`.

#### [Semantics](semantics.md)
The exact guarantees for persistence, concurrency, failures, scheduling and WebSockets.

#### [Findings](findings.md)
What this proof of concept set out to test, what it found, and what is still unproven.
