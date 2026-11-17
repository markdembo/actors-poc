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
- raw Durable Object classes, written as `export class X extends DurableObject`

Then it writes:

- `.actors/entry.ts`: the production entry point.
- `.actors/entry.dev.ts`: the development entry point, with the Actor Explorer.
- `.actors/manifest.json`: what was discovered.
- `wrangler.jsonc`: creates the file, or edits it in place, keeping your settings and comments. It sets `main`, adds the `ACTORS` binding and the `actors-v1` migration, and adds one binding and migration per Durable Object class.

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

Runs `generate`, checks that the production entry contains no development tooling, then runs `wrangler deploy` with any options you pass, such as `--dry-run --outdir dist`.

## `inspect`

```sh
actors inspect <Type> <key> [--port 8787] [--json]
```

Prints one instance:

- its state, with redacted keys hidden
- its last 15 invocations, with errors, stack traces and log lines
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

Lists actor types with their actions and parameters, and every instance in local storage with its recent call and error counts. Requires a running `actors dev`.

## Actor Explorer

A web UI served by `actors dev` at `http://localhost:8787/__actors`. It is not included in production builds, and it only answers requests addressed to `localhost`.

- **Actor types and instances.** Every instance in local storage, read through Wrangler's Local Explorer API. Instances with recent failures are flagged.
- **Instance view.** Saved state with the last change highlighted, an action console that takes JSON arguments, the activity timeline with stack traces and logs, storage size, runtime info, open connections, and pending schedules. You can delete an instance's storage from here.
- **Durable Objects.** Instances of your raw Durable Object classes, with a read-only, paged view of their SQLite tables. Opening one starts it if it wasn't running.

The Explorer reads storage through Wrangler's Local Explorer API (`/cdn-cgi/local/explorer/api`). It requires Wrangler 4.163 or later, and it doesn't work if `X_LOCAL_EXPLORER` is set to `false`.

> [!CAUTION]
> `redact` hides values in the Actor Explorer and `actors inspect` only. Wrangler's Local Explorer API exposes raw local storage to anything that can reach your dev server.
