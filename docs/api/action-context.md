# Action context

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../../README.md) before using any of it.

Every action and connection hook receives an `ActionContext` as its first argument, usually destructured or named `ctx`.

```ts
increment: (ctx, by: number) => {
  ctx.state.count += by;
  ctx.log("incremented", by);
  return ctx.state.count;
},
```

## Identity

### `state`

`state: S`

A private draft of this instance's state. Mutate it, or assign a new object to `ctx.state`. It is committed when the action returns and discarded when it throws.

### `actor`

`readonly actor: string`

The actor type name, such as `"Counter"`.

### `key`

`readonly key: string`

This instance's key, such as `"customer-123"`.

## Logging

### `log`

`log(...args: unknown[]): void`

Writes a line to the console and attaches it to this invocation in the Actor Explorer and `actors inspect`. Non-strings are JSON-encoded. Each invocation keeps up to 50 lines.

## Scheduling

### `schedule`

`schedule(when: number | Date, action: string, ...args: unknown[]): string`

Runs one of this actor's actions later, with the given arguments, through the normal queued and transactional path. The invocation is recorded with source `schedule`.

#### Parameters

- `when` `number | Date`
  - Seconds from now, or an absolute time.
- `action` `string`
  - The name of an action on this actor. Unknown names throw immediately.
- `...args` `unknown[]`
  - Plain JSON arguments.

#### Returns

The schedule ID, for `cancelSchedule`.

> [!NOTE]
> Scheduling is transactional: if the current action throws, nothing is scheduled. Delivery is at least once: a scheduled action that throws is attempted up to 3 times in total (retries after 2 and then 4 seconds), then dropped. The failures stay visible in the invocation log. Make scheduled actions idempotent.

### `cancelSchedule`

`cancelSchedule(id: string): void`

Cancels a pending schedule when the current action commits.

## WebSockets

### `broadcast`

`broadcast(message: string | object | number | boolean | null, options?: BroadcastOptions): void`

Queues a message to every open connection, or to a subset. It is sent only if the current action commits. Strings are sent as they are; everything else is JSON-encoded. Works in any action, not only in connection hooks.

#### Parameters

- `options.except` `string | string[]` Optional
  - Connection IDs to skip, such as the sender's `conn.id`.
- `options.only` `string[]` Optional
  - Send only to these connection IDs.

### `connections`

`connections(): ConnectionInfo<C>[]`

The open WebSocket connections to this instance: `{ id, data, connectedAt }`. During `onConnect`, the new connection is not listed yet. During `onClose`, the closing one is not listed anymore.

## Lifecycle

### `destroy`

`destroy(): void`

Deletes this instance when the current action returns. Nothing is saved. In order:
1. Queued messages are sent.
2. State, schedules, the invocation log and the instance's `ctx.sql` tables are deleted.
3. Its WebSockets are closed with code `1000` (`onClose` does not run).

If the action throws, nothing is deleted. The return value still goes to the caller. The next call to this key starts a new instance. This is the same as [`Actor.delete(key)`](actor.md#delete), but from inside the actor.

#### Example

```ts
export const Session = actor({
  state: { user: "" },
  onCreate: (ctx) => {
    ctx.schedule(30 * 24 * 3600, "expire"); // delete after 30 days
  },
  actions: {
    expire: (ctx) => ctx.destroy(),
  },
});
```

## Escape hatches

### `env`

`readonly env: Cloudflare.Env`

The Worker environment: bindings, variables and secrets.

### `sql`

`readonly sql: SqlStorage`

The instance's raw [SQLite API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) ↗. Writes apply immediately and are **not** rolled back when the action throws. Avoid table names starting with `_actor`.

### `storage`

`readonly storage: DurableObjectStorage`

The instance's raw [storage API](https://developers.cloudflare.com/durable-objects/api/storage-api/) ↗. Same caveat as `sql`. Don't use `setAlarm` here: the runtime owns the alarm for `schedule`.

## Related resources

- [Semantics](../semantics.md)
- [Connections](connections.md)
