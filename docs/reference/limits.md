# Limits

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../../README.md) before using any of it.

## Actor limits

These limits are set by this framework.

| Limit | Value | Notes |
|---|---|---|
| State document size | 2 MB of JSON | A conservative choice. Every change rewrites the whole document. |
| State contents | Plain JSON | No `Date`, `Map`, `Set`, class instances, `NaN`, `Infinity`, `bigint`, or `undefined` in arrays |
| Key length | 1–512 characters | |
| Connection data | 8 KB of JSON | Stored on the socket, which allows 16 KB in total |
| Invocation log | Last 100 per instance | `inspect --json` returns the last 50 |
| Log lines per invocation | 50 | Written with `ctx.log` |
| Recorded arguments | First 2,000 characters | Recorded in development only, never for actions in `redact.args` |
| Scheduled action attempts | 3 in total | Retries after 2 s and 4 s, then the schedule is dropped |
| Explorer instance stats | First 200 instances | More instances are listed without call counts |
| Concurrency per instance | 1 action at a time | Other calls wait in arrival order |

## Platform limits

Actors run on Cloudflare Durable Objects, so each actor is subject to the [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) ↗. The ones you are most likely to meet:

- **Throughput:** about a thousand simple requests per second per actor (a soft limit). Past that, calls fail as overloaded, which appears as a `transport` error.
- **Storage:** 10 GB per actor, and 8 MB per SQLite value.
- **CPU:** 30 seconds per request by default, configurable up to 5 minutes. Each WebSocket message resets the budget.
- **WebSockets:** up to 32,768 hibernatable connections per actor, fewer in practice, and 32 MiB per incoming message.

The platform figures above were read from Cloudflare's documentation in November 2026. Check that page for current values.
