# Errors

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../../README.md) before using any of it.

Every failed call through an actor reference rejects with an `ActorError`.

## `ActorError`

`class ActorError extends Error`

| Property | Type | Description |
|---|---|---|
| `kind` | `"action" \| "validation" \| "config" \| "transport" \| "timeout" \| "version"` | What went wrong. Refer to the table below. |
| `code` | `string \| undefined` | The `code` property of the error the action threw, if it had one. |
| `actor`, `key`, `method` | `string \| undefined` | Which call failed. |
| `remoteName` | `string \| undefined` | The original error's name inside the actor, such as `"TypeError"`. |
| `remoteStack` | `string \| undefined` | The stack trace from inside the actor. |
| `retryable` | `boolean` | `true` only when the platform marked a `transport` failure as safe to retry. |

## Kinds

| `kind` | Meaning | State committed? | What to do |
|---|---|---|---|
| `action` | The action threw | No | Expected failures: map to a 4xx and use `code` |
| `validation` | The new state or return value was rejected | No | A bug: fix the action |
| `config` | Unknown actor or action, missing binding, bad key | No (never ran) | A bug or a stale build: run `actors generate` |
| `transport` | The call failed in transit, for example an overloaded instance | **Unknown** | Retry only if `retryable` and the action is idempotent |
| `timeout` | `timeoutMs` passed | **Unknown, usually yes** | Don't assume failure; read state or deduplicate |
| `version` | Code and state, or caller and actor, are from different versions: the state was saved by newer code, a migration failed, or the caller asked for an action this version doesn't have | No | Deploy forward. Refer to [Changing actors safely](../best-practices/changing-actors.md) |

## Throwing errors with a code

```ts
completeTask: ({ state }, id: number) => {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) throw Object.assign(new Error(`No task ${id}`), { code: "TASK_NOT_FOUND" });
  task.done = true;
},
```

```ts
try {
  await agent.completeTask(99);
} catch (err) {
  if (err instanceof ActorError && err.code === "TASK_NOT_FOUND") return new Response("Not found", { status: 404 });
  throw err;
}
```

You can also throw `ActorError` yourself inside an action. Its `kind` is preserved.

## Related resources

- [Rules of actors: errors](../best-practices/rules-of-actors.md#errors)
- [Semantics: calls, errors, retries](../semantics.md#calls-errors-retries)
