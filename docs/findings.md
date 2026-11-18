# Findings and recommendations

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../README.md) before using any of it.

**Bottom line:** the hypothesis holds for Personas A and B. In the comparison app, application code needs **zero** Durable Objects concepts (down from 15), **zero** hand-written config (down from 10 lines), and **35% less code**, while gaining an invocation log, an Explorer, rollback semantics and redaction. Everything runs on stock Workers, Durable Objects and Wrangler, with no new runtime or deploy backend.

We do not recommend shipping this as a new framework yet. Two of the findings below (§3.1 and §3.2) suggest the work should be folded into existing efforts.

Validated with Wrangler 4.163.0, `@cloudflare/workers-types` 5.20261116.1 and compatibility date 2026-09-01, locally (`wrangler dev`) and with `wrangler deploy --dry-run`. Nothing was deployed to a Cloudflare account.

## 1. P0 acceptance criteria

| | Criterion | Status | Evidence |
|---|---|---|---|
| FR1 | Counter with no DO subclass | ✅ | `examples/counter/src/actors/counter.ts` |
| FR2 | `Counter.get("customer-123")` always targets the same instance, scoped to the deployment | ✅ | `"<Type>:<key>"` via `idFromName`. Scope is documented in semantics.md. |
| FR3 | Mutation survives restart; failed transaction leaves no partial state | ✅ | e2e: restart, throw, invalid state, schedule rollback |
| FR4 | Bad method or argument types fail to compile; no retries, and that is documented | ✅ | `tests/types/inference.ts` (10 `@ts-expect-error` cases) |
| FR5 | Fresh project runs and deploys with no hand-written DO config; generated files are inspectable and reproducible | ✅ (deploy is a dry run) | `actors generate` is deterministic (e2e). `wrangler deploy --dry-run` bundles. |
| FR6 | Find an actor, inspect state, run an action, see the change | ✅ | Explorer at `/__actors` and `actors inspect`, built on Wrangler's Local Explorer API. Tested e2e and by hand in a browser. |
| FR7 (P1) | Failure traceable to actor, method, error and logs | ✅ | Invocation log with `ctx.log` lines, error, `code` and stack |
| FR8 (P1) | Native DO features without leaving the abstraction | ✅ | `ctx.schedule` (alarms), `ctx.sql`, `ctx.storage`, `ctx.env`, user DO classes re-exported |
| FR9 | Per-customer agent and counter examples | ✅ | `examples/agent` and `examples/counter` |
| FR10 | Reproducible comparison | ✅ partial | Static comparison against raw DO. No PartyServer comparison (not applicable) and no timed user study (needs participants). See `comparison/README.md`. |
| §8.6 | Explorer local-only; admin routes not in production; no secrets in inspection | ✅ | Localhost check, separate production entry (verified by bundle scan), `redact.state` and `redact.args` |

## 2. Success metrics (PRD §11)

| Metric | Target | Result |
|---|---|---|
| Manual DO configuration | Zero | **Zero.** The binding and migration are written by `actors generate`. |
| Infrastructure boilerplate | ≥70% less | **Not measured on its own.** Total code is 35% less, and most of the 63-line difference is infrastructure. Splitting infrastructure from logic needs a judgment call (see `comparison/README.md`). |
| Type safety | All public methods checked at compile time | **Yes**, including optional and default parameters and inferred return types |
| Time to inspect state | < 30 s | `actors inspect` answers in under 1 s once you know the key. This is tool latency, not a user study. |
| Time to first local app, to first deploy, to diagnose an injected error | 10 min / 90% success / 2 min | **Not measured.** This needs the 5–10 person study. The tasks are ready: counter, agent, injected `tool {` failure. |

## 3. Things we learned that change the plan

### 3.1 `@cloudflare/actors` already exists on npm
The PRD's working name is taken by an existing Cloudflare package, "An easier way to build with Cloudflare Durable Objects" ([cloudflare/actors](https://github.com/cloudflare/actors), `0.0.1-beta.6`). The overlap the PRD calls Risk 3 (framework fragmentation) is real. This PoC uses the package name `actors-poc` to avoid confusion.

**How it compares.** This is based on reading its README, examples and core source in November 2026. We did not install or run it.

The two projects aim at different things. `@cloudflare/actors` makes Durable Object classes nicer to write, but the developer still has to understand Durable Objects. This PoC aims at the PRD's goal of not needing to understand them at all.

Both landed on several of the same ideas:
- `MyActor.get(id)` with no `env` passed in, using the `cloudflare:workers` env import
- JSON state in the object's own SQLite storage
- multiple scheduled jobs on one platform alarm
- a way to list instances

| | `@cloudflare/actors` | This PoC |
|---|---|---|
| Defining an actor | Class extending `Actor` (a `DurableObject` subclass) | `actor({ state, actions })`, no class |
| Wrangler config | Hand-written; binding, `class_name` and migration must match the class name | Generated (`actors generate`) |
| New actor type | New class, binding and migration | Nothing: one `ActorHost` class runs every type (§3.3) |
| When state is saved | `@Persist` writes on every property change, including nested ones via a deep Proxy; the writes are not awaited | Once, in one transaction, when the action returns |
| Method throws | Changes made before the throw are already saved | Everything is discarded, including schedules |
| Overlapping calls | Not specified in the docs | One action at a time per instance, in arrival order |
| Value types | Also Date, Map, Set, RegExp and Error (type markers) | Strict JSON; other types are rejected with a fix-it message |
| Instance list | Opt-in (`handler(..., { track })`), only for calls through `handler()`; listing means raw SQL on the `_cf_actors` instance | Every local instance via Wrangler's Local Explorer; dev only (§3.2) |
| Tooling | Library only | CLI, config generation, Actor Explorer, `actors inspect`, call log, redaction |
| Retries | Opt-in helpers (`tryN`, jittered backoff, `isErrorRetryable`) | None, by design; typed `ActorError` with `kind` and `code` |

Features it has that this PoC lacks:
- HTTP routing (`handler()`, `nameFromRequest`)
- per-class location hints
- cron schedules
- migrations for user SQL tables
- lifecycle hooks (`onInit`, `onAlarm`, `onPersist`)
- Worker entrypoint helpers

The biggest design difference is when state is saved. `@Persist` saves each change as it happens, which is simple and works with ordinary class code. This PoC saves once per action, so a failed action leaves nothing behind. The two suit different needs, and they could coexist as options.

**Recommendation:** rather than a second framework, these pieces could be offered to that project:
- save-on-return transactions, as a mode of `@Persist`
- config generation
- the Explorer, built on Wrangler's Local Explorer
- `actor({...})` as an optional layer over its `Actor` class

One decision needs agreement with that project first. Running every type in one host class (§3.3) gives up per-class location hints, which its design supports.

### 3.2 Wrangler's Local Explorer already enumerates Durable Objects locally (now used)
`wrangler dev` serves `/cdn-cgi/local/explorer/api`. It lists every local object **by name** (`Counter:customer-123`) and runs SQL against an object's storage by name. The PRD assumed there was no enumeration, so the first version of the PoC kept its own dev-only index (FR6). **The Explorer now reads through Wrangler's Local Explorer instead, and the custom index is gone.**

- **Instances** come from the namespace's object list. Names that parse as `<Type>:<key>` for a registered type are actors. That includes instances created by the production entry, or before the Explorer existed.
- **Persisted data** (state, the last 50 invocations, schedules) comes from read-only SQL on `_actor_state`, `_actor_log` and `_actor_schedule`. Reads return in about 25 ms even while a 3-second action is running, because they don't queue behind actions.
- **Live data** (the running action, queue depth, next alarm, instance start time) still needs one dev-only RPC, `actorRuntime()`, because it isn't in storage.
- **Gotcha:** a by-name SQL query instantiates the object, so querying a key that was never used *creates* that object. The Explorer checks the object list first. Opening an unknown key shows "not created" and leaves nothing behind (tested).
- **Costs:** instance stats (recent call and error counts) take one SQL request per instance, capped at 200 instances. Counts cover the last 100 invocations, not all time.

**Next:** check whether the production Cloudflare API returns object names and allows SQL queries. If it does, a production Explorer (PRD §15) becomes mostly a UI and authorization problem.

### 3.3 One host class removes migrations from the developer's path
Every actor type runs in one `ActorHost` class. Instances are named `Type:key`. Adding, renaming or deleting an actor type never needs a DO migration, so the only migration is the one-time `actors-v1`. This was the largest removal of cognitive load in the PoC (open question 4).
Costs: you cannot configure Durable Object settings per type, and namespace-level metrics are not split by type. Data for a deleted actor type is orphaned rather than removed by `deleted_classes`. Renaming an actor type changes its instance names, so renames effectively start fresh. A rename map in config would fix that.

### 3.4 `import { env } from "cloudflare:workers"` is what makes `Counter.get(key)` possible
Without passing `env` around, references resolve the binding lazily at call time. When the binding is missing, the error says what to run instead of `DurableObjectNamespace binding undefined` (DX2).

### 3.5 Serializing actions is the right default, and the place where agents hurt
Running one action at a time removes a whole class of bugs. The raw version needed a hand-written queue and copy-then-commit to match it. But a 20-second LLM call blocks every other action on that agent, including reads. Future work should add read-only actions that skip the queue and read committed state, plus a "commit intent, then do I/O in a scheduled step" helper. This is also the natural boundary with Workflows and the Agents SDK (open question 8).

### 3.6 Agent runtimes plug in as raw Durable Objects, not as actors
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) 1.5.2, a durable agent harness from the Pi authors, runs unmodified in workerd as a plain Durable Object, using its own `storage/sqlite/cloudflare` backend and alarm pattern. It bundles without `nodejs_compat` (about 840 KiB). See `examples/pi-session`, which uses pi-ai's fake model.

Hosting it *inside* `actor()` would have needed four additions:
- a per-start hook with in-memory state
- shared ownership of the alarm
- actions that skip the queue (a run takes minutes)
- streaming return values

Our JSON state would also sit unused next to pi-durable's own transactional documents. Instead, `actors generate` now gives any `export class X extends DurableObject` the same zero-config treatment: a binding, a migration, a typed `durable(X).get(key)`, and Explorer listing and read-only table browsing.

This suggests the right split. Actors serve Persona A (stateful services). Agent runtimes (pi-durable, the Agents SDK) bring their own durability and only need hosting and tooling.

Not covered:
- a real model, or pi-durable's file and shell tools, which need a non-Node execution environment such as the Cloudflare Sandbox SDK
- crash recovery mid-turn

### 3.7 WebSockets fit the actor model; sends must wait for the save
`connections: { onConnect, onMessage, onClose }` treats each socket event as an action: queued, saved in one transaction, rolled back if it throws. That makes one rule necessary: `conn.send` and `ctx.broadcast` must be held until the save succeeds. Otherwise a hook that broadcasts and then fails would tell clients about a change that never happened. Raw Durable Objects and PartyServer send immediately. Tests check that a rolled-back hook delivers nothing.

Connection data (for example, the authenticated user) is set by the Worker's `Actor.connect(key, request, { data })` and stored on the socket, so it survives hibernation and can't be forged by the client (also tested). Presence comes from `ctx.connections()`, not stored state, so it can't go stale after a crash.

Not covered:
- forced hibernation and wake (can't be triggered locally)
- batching many small messages into one frame (recommended by Cloudflare's docs for chatty rooms)
- load testing

### 3.8 Sharding: what can and can't be automated
One instance is single-threaded. Cloudflare's limits for one object are about 1,000 requests/s (soft), 10 GB storage, and 32,768 hibernatable sockets. In practice, sending every message to every user hits first: 5,000 members × 20 messages/s is 100,000 sends/s.

A single ordered history (a chat room) cannot be transparently split without breaking its ordering, and the PRD lists automatic sharding as a non-goal. Patterns that keep the ordering exact:
- **Spread the sending.** One room object orders and stores each message, then forwards batches to N connection objects that each hold a slice of the users.
- **Archive old history** to R2 or D1.
- **Split by meaning:** threads or channels.

The only kind a framework can safely shard automatically is state whose order doesn't matter, such as counters and presence (an opt-in `shards: N` with a `merge` function). None of this is built yet.

### 3.9 Smaller findings
- **Durable Object RPC preserves error `name`, `message` and custom properties** (verified: `code` survives and `remote: true` is set), but **not the remote stack**. The actor runtime captures the stack into the invocation log, which is where it matters for debugging.
- **Stack traces point at the bundled file** (`.wrangler/tmp/.../entry.dev.js:801`). Function names make them usable, but source-mapped `err.stack` inside the runtime would make the Explorer much better. This is a platform request.
- **`wrangler dev <script>` overrides `main`.** Dev and production use different entries from one ordinary `wrangler.jsonc`, so the explorer is absent from production bundles without a second config. `wrangler secret`, `wrangler tail` and the rest keep working.
- **Regex discovery is fragile.** `export { Counter }` or re-exports from a barrel file are not found. A Wrangler or esbuild plugin that discovers actors from the module graph is the robust version.
- **Testing found a real secret leak.** Redacting a state key isn't enough when the action that *sets* it records its arguments. `redact.args` was added, and the e2e suite asserts that a token never appears in inspect output.

### 3.10 Migrations and mixed versions
Lazy migration isn't a choice so much as the only option: production has no way to list every instance, and instances nobody calls never wake up. So migrations run on an instance's next call, which means a migration can never be deleted: some instance may still need it. Making the list append-only, with the schema number derived from its length, removes the number the developer would otherwise keep in sync.

Gradual deployments pin each Durable Object to one version, and while percentages only go up, no instance moves back. So old code meets new state only after a rollback. Refusing that state (kind `version`) and telling people to deploy forward replaces "expand, then contract" with a one-line rule. The skew that does happen in a normal rollout is between a caller and an instance on different versions, and between persisted schedules and new code. Neither can be fixed at runtime, so `actors deploy` checks the action list against `actors.lock.json` before shipping.

Every call records the code version that ran it (from the `version_metadata` binding), so the Explorer shows deploy boundaries, migrations and cross-version calls on each instance's timeline. In local dev each start of the dev server gets a new version id, which is enough to see the same thing.

The check reads each action's argument and return types with the TypeScript compiler and stores them by structure in the lock file. Arguments must stay assignable from the old types, and return values to the old types. This needs no runtime schemas: calls only come from your own type-checked Worker, so the only time arguments arrive in an unexpected shape is when versions disagree, and that is caught before shipping. Runtime schemas (zod, valibot) still make sense for state, through `validate`.

Not solved: `any`/`unknown` and changes in meaning aren't caught; a production view of which instances run which version needs a production Explorer (open question 9); and migrations can't do I/O.

**Future work: retiring old migrations.** Lazy migration means a migration can never be deleted, because some instance may not have run it. Old migrations cost little (untyped functions that run only on instances that haven't migrated), so this stays unbuilt until one of these happens: data must really be gone (a removed field that held personal data stays in every instance nobody calls), old migrations hold back code you want to delete, or users report long migration lists as a problem. The design: an `actors migrate` sweep visits every instance (locally through the Local Explorer, in production through the API that lists a namespace's objects; each instance knows its own key), runs pending migrations and records the lowest schema in the lock file. Then `migrations: [...squashed(n), ...]` replaces the first n with placeholders that keep the schema numbers and refuse any instance still below n. The check refuses squashing past what the last sweep proved. The same sweep can count pending scheduled calls per action, which would let the check decide when removing an action is safe instead of trusting `--allow-breaking`.

## 4. Answers to the PRD's open questions

1. **Functional or class API?** Functional `actor({ state, actions })`. TypeScript infers state from the initial value and gives every action a typed `ctx`. Caller types come from the definition without codegen. One wrinkle: empty arrays need `[] as Message[]`.
2. **State model?** A JSON document with draft-and-commit for the common case, and `ctx.sql` for large or relational data. The document is easy to inspect and diff (changed keys are highlighted). It is limited to 2 MB, and every write rewrites the whole document, which is fine at agent scale.
3. **Serialize, or rely on native concurrency?** Serialize per instance. Input gates alone do not protect state across a non-storage `await`.
4. **One host class or one per type?** One. See §3.3.
5. **Schema versions?** An append-only `migrations` list on the definition; its length is the schema version. Missing migrations run lazily on an instance's next call, in their own transaction. Code never downgrades state: older code refuses it. See §3.10.
6. **Authorization?** Keep it out of the actor. The key is an address. The example derives it from the URL and says so in a comment. A future `authorize(ctx, caller)` hook could take a verified identity from the Worker.
7. **Build on DO or share PartyServer primitives?** Build directly on Durable Objects. Real-time is now an optional `connections` block built directly on the Hibernation API: about 190 lines of runtime code. It differs from PartyServer in that hooks are transactional and sends wait for the save. A PartyServer comparison is now applicable and is not done yet.
8. **Agents SDK overlap?** Scheduling, persisted state and RPC overlap directly. A common actor core (identity, transactional state, schedule, invocation log) could sit under both. See §3.1 first. §3.6 shows a different path that works today: agent runtimes as zero-config raw Durable Objects.
9. **Platform APIs for a production Explorer?** Name-aware object listing and read-only SQL against a named object, both of which Wrangler's Local Explorer already has locally (§3.2), in the production API, source-mapped stacks (§3.9), and lifecycle events such as eviction and placement.
10. **SDK, framework or built-in?** Built-in. The highest-leverage pieces are small and belong in existing tools: the single-host-class pattern, `env`-based typed references, and a transactional-state helper in the DO or Agents SDK. The Explorer belongs on top of Wrangler's Local Explorer, and discovery and config belong in Wrangler.

## 5. Known limitations

- Re-entrant calls (an actor awaiting itself, or a cycle) deadlock until the platform times out.
- Side effects inside actions are not rolled back. The semantics doc says so, but the API does not prevent it.
- The Explorer needs Wrangler's Local Explorer API (Wrangler 4.163 was verified; it is on unless `X_LOCAL_EXPLORER=false`). Without it, the Explorer shows an error naming the fix.
- `redact` hides values in the Actor Explorer and `actors inspect`. Wrangler's own `/cdn-cgi/local/explorer` API still exposes raw local storage to anyone who can reach the dev server.
- The Explorer's argument entry is untyped JSON. Types are checked only at compile time.
- `actors generate` manages `main` and expects the Worker at `src/index.ts`. `wrangler.toml` is not supported.
- Only `extends DurableObject` classes are discovered, and only when declared as `export class` (not re-exported). Classes extending other bases (`Agent`, `Server`, `@cloudflare/actors`' `Actor`) need a hand-written binding.
- The Explorer's view of raw Durable Objects is read-only, and opening one starts it (its constructor runs) if it wasn't running. For pi-durable, that means opening a session resumes any unfinished work.
- Not load-tested or benchmarked against native Durable Objects (Risk 6). The extra cost per call is one JSON parse and stringify of the state document plus one log row.
