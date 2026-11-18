# CLI

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../../README.md) before using any of it.

The `actors` CLI ships with the package. Run it with `pnpm exec actors`, or through the `dev` and `deploy` scripts from [Get started](../get-started.md). It writes standard Wrangler configuration and delegates to Wrangler; it never deploys anything itself.

Every command accepts `--cwd <dir>` to run against another project folder.

## `generate`

```sh
actors generate
```

Finds everything under `src/` that the framework manages:

- actors, written as `export const X = actor(`
- custom classes, written as `export class X extends DurableObject`

Then it writes:

- `.actors/entry.ts`: the production entry point.
- `.actors/entry.dev.ts`: the development entry point, with the Actor Explorer.
- `.actors/manifest.json`: what was discovered.
- `wrangler.jsonc`: creates the file, or edits it in place, keeping your settings and comments. It sets `main`, adds the `ACTORS` binding, the `actors-v1` migration and the `CF_VERSION_METADATA` version metadata binding, and adds one binding and migration per custom class.

Running it twice changes nothing. It fails with an explanation when:

- two actors or classes share a name
- a name is reserved
- a binding name clashes
- `main` points somewhere other than `src/index.ts`
- the project uses `wrangler.toml`

## `dev`

```sh
actors dev [wrangler dev options]
```

Runs `generate`, then `wrangler dev .actors/entry.dev.ts` with any options you pass, such as `--port 8788` or `--persist-to ./data`. It re-runs discovery when files under `src/` change, so new actors are picked up without a restart.

The Actor Explorer is served at `/__actors`.

## `deploy`

```sh
actors deploy [wrangler deploy options]
```

Runs `generate`, checks that the production entry contains no development tooling, runs the [compatibility check](#check), then runs `wrangler deploy` with any options you pass, such as `--dry-run --outdir dist`.

After a successful deploy (not a dry run), it writes `actors.lock.json`: the actors, actions and migrations that shipped. Commit it. With `--env <name>`, the file is `actors.lock.<name>.json`.

- `--allow-breaking`: deploy even when the check finds breaking changes. Use it once no Worker version that calls the removed actions is deployed.

## `upload`

```sh
actors upload [wrangler versions upload options]
```

Like `deploy`, but runs `wrangler versions upload`: the new version is uploaded without serving traffic. Roll it out with `npx wrangler versions deploy`, for example 10% first. Pass `--tag v2` to name the version; the tag is what the Explorer and `inspect` show for calls it handles.

Refuses when the version adds or removes a Durable Object class, because those can't roll out gradually. Ship them with `actors deploy` first.

## `check`

```sh
actors check [--env <name>] [--allow-breaking]
```

Compares your actors with the version last shipped (`actors.lock.json`). While a deploy rolls out, old and new code call each other, so it fails on:

- a removed actor type or action
- an argument whose type changed so that old callers' values are no longer accepted, a new required argument or property, or an optional one that became required
- a return type that can now produce values old callers don't expect
- fewer migrations than before

Types come from the TypeScript compiler, using the project's `tsconfig.json`. They are stored in the lock file by structure, so renaming a type isn't a change. Without TypeScript in the project, the check compares the number of arguments instead. Arguments typed `any` or `unknown` aren't checked.

It also notes new migrations, migrations that look different from the shipped ones, and new Durable Object class migrations. It loads your actor files in Node to read their actions and migrations, with `cloudflare:*` modules stubbed. If that fails, it says so and skips the check instead of blocking. `deploy` and `upload` run it for you. Refer to [Changing actors safely](../best-practices/changing-actors.md).

## `inspect`

```sh
actors inspect <Type> <key> [--port 8787] [--json]
```

Prints one instance:

- its state, with redacted keys hidden, and its schema (how many migrations it has run)
- its last 15 invocations, with errors, stack traces, log lines and the code version that ran each one, including migrations
- pending schedules
- storage size
- runtime info: what's running, how many calls are queued, the next alarm
- open WebSocket connections

`--json` prints the full record (the last 50 invocations) for scripts and coding agents.

Requires a running `actors dev`. Inspecting a key that doesn't exist reports "not created" and doesn't create it.

## `list`

```sh
actors list [--port 8787] [--json]
```

Lists actor types with their actions and parameters, and every instance in local storage with its recent call and error counts, schema and the code version of its last call. Requires a running `actors dev`.

## Actor Explorer

A web UI served by `actors dev` at `http://localhost:8787/__actors`. It is not included in production builds, and it only answers requests addressed to `localhost`.

- **Actor types and instances.** Every instance in local storage, read through Wrangler's Local Explorer API. Instances with recent failures are flagged.
- **Instance view.** Saved state with the last change highlighted, an action console that takes JSON arguments, the activity timeline with stack traces and logs, storage size, runtime info, open connections, and pending schedules. You can delete an instance's storage from here.
- **Versions.** Each timeline entry shows the code version that ran it, with a marker where it changes, and calls from a Worker on another version are flagged. Migrations are entries of their own. The header shows the instance's schema, or that it will migrate on its next call. When an actor's instances last ran different code versions, the list shows how many ran each.
- **Custom classes.** Instances of your [custom classes](../api/durable.md), with a read-only, paged view of their SQLite tables. Opening one starts it if it wasn't running.

The Explorer reads storage through Wrangler's Local Explorer API (`/cdn-cgi/local/explorer/api`). It requires Wrangler 4.163 or later, and it doesn't work if `X_LOCAL_EXPLORER` is set to `false`.

> [!CAUTION]
> `redact` hides values in the Actor Explorer and `actors inspect` only. Wrangler's Local Explorer API exposes raw local storage to anything that can reach your dev server.
