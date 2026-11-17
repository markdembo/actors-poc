# Actors (proof of concept)

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../README.md) before using any of it.

Actors is a TypeScript framework for building stateful backends on Cloudflare Workers.

An actor is a small service that owns its own state. You create one for each thing your app cares about, such as a customer, a cart, a chat room or an AI agent, and call it by name from anywhere in your app. Each actor remembers everything between calls, handles one request at a time, and never leaves a half-finished change behind.

Use actors to build:

- Per-customer or per-tenant services with isolated state.
- Persistent AI agents with memory, tasks and scheduled follow-ups.
- Real-time rooms over WebSockets: chat, presence, collaborative sessions.
- Anything where many requests must agree on one piece of state.

**[Get started](get-started.md)**

### What is an actor?

An actor combines three things you would otherwise assemble yourself:

- **An identity.** `Cart.get("alice")` always reaches the same actor, from any request, anywhere.
- **Private state.** Only the actor's own actions can read or change it. The state survives restarts and deploys.
- **One request at a time.** Calls to one actor are handled in order, so two requests can never overwrite each other's changes. You never write locks.

On top of that, every action is a transaction: its changes are saved together when it succeeds and discarded when it throws. And calls are typed end to end: `Cart.get("alice").add("sku-1", 2)` is checked at compile time, from method name to return type.

Refer to [What are actors?](concepts/what-are-actors.md) to learn more.

## Features

#### [Transactional state](concepts/how-actors-work.md#state-and-transactions)
Each actor's state is saved atomically, together with its scheduled work and its activity log. A failed action changes nothing.

#### [WebSockets](best-practices/websockets.md)
Clients connect straight to an actor. Messages go out only after the change that produced them is saved.

#### [Scheduling](api/action-context.md#schedule)
Run an action later, at least once, with retries. Scheduling is part of the same transaction as the action that requests it.

#### [Actor Explorer](reference/cli.md#actor-explorer)
A local web UI and CLI to list actors, read their state, invoke actions and trace failures.

#### [Custom classes](api/durable.md)
When an actor isn't the right shape, write your own class with full control over storage, and keep the zero-config setup and typed client.

## Related products

**[Workers](https://developers.cloudflare.com/workers/) ↗**
Your app's entry point and the runtime actors run in. Your Worker calls actors and hands WebSocket connections to them.

**[Wrangler](https://developers.cloudflare.com/workers/wrangler/) ↗**
The Cloudflare CLI. The `actors` CLI generates its configuration and uses it to run and deploy your app.

## More resources

#### [Get started](get-started.md)
Build and run a shopping cart actor locally in about ten minutes.

#### [Rules of actors](best-practices/rules-of-actors.md)
How to design actors, keep state healthy, handle side effects and errors.

#### [API reference](api/README.md)
`actor()`, the action context, connections, errors and custom classes.

#### [Semantics](semantics.md)
The exact guarantees for persistence, concurrency, failures, scheduling and WebSockets.

#### [Findings](findings.md)
What this proof of concept set out to test, what it found, and what is still unproven.
