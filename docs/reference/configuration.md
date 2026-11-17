# Configuration

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../../README.md) before using any of it.

## Project layout

```txt
my-app/
├── src/
│   ├── index.ts          # your Worker: export default { fetch }
│   ├── actors/*.ts       # actors: export const X = actor({...})   (any folder under src/ works)
│   └── *.ts              # optional custom classes: export class X extends DurableObject
├── wrangler.jsonc        # yours, with a few keys managed by `actors generate`
└── .actors/              # generated, add to .gitignore
```

The Worker entry must be `src/index.ts` (or `src/index.js`, `src/worker.ts`, `src/worker.js`). Other classes it exports, such as Workflows or entrypoints, are re-exported automatically.

## `wrangler.jsonc`

`actors generate` edits only these keys and keeps everything else, comments included:

| Key | Value |
|---|---|
| `main` | `.actors/entry.ts` |
| `compatibility_date` | Set to `2026-09-01` if missing. Must be `2024-04-03` or later. |
| `durable_objects.bindings` | Adds `ACTORS` → `ActorHost`, and one binding per custom class |
| `migrations` | Adds `actors-v1` (`ActorHost`) once, and `actors-do-<Class>` per custom class |

The binding name `ACTORS` and the class name `ActorHost` are reserved. Because `wrangler.jsonc` stays a normal Wrangler file, `wrangler secret put`, `wrangler tail` and the rest work without extra flags.

## Environment variables

| Variable | Values | Default |
|---|---|---|
| `ACTORS_INSTRUMENTATION` | `all`, `errors`, `off` | `all` in `actors dev`, `errors` in production |

Set it in `vars` in `wrangler.jsonc`. `errors` records only failed invocations in the per-instance log, which keeps production writes down. `off` records nothing.

## Development and production builds

| | `actors dev` | `actors deploy` |
|---|---|---|
| Entry point | `.actors/entry.dev.ts` | `.actors/entry.ts` |
| Actor Explorer and `/__actors` routes | Included, localhost only | Not in the bundle |
| Dev-only inspection RPCs | Enabled | Rejected |
| Default instrumentation | `all`, with arguments | `errors`, no arguments |

## Related resources

- [CLI](cli.md)
- [How actors work: generated files](../concepts/how-actors-work.md#generated-files)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/) ↗
