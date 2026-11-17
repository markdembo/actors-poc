# durable()

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../../README.md) before using any of it.

Sometimes you need a real Durable Object class:

- a library that brings its own durability, such as an agent runtime
- your own SQLite schema
- streaming responses
- per-class platform settings

Write the class as usual. `actors generate` wires it up, and `durable()` gives you a typed stub.

## Zero-config classes

Any class declared as `export class X extends DurableObject` in a file under `src/` is discovered. For each one, `actors generate`:

1. Adds a binding named after the class, in UPPER_SNAKE_CASE: `Session` → `SESSION`, `ChatRoom` → `CHAT_ROOM`. If you already wrote a binding for the class in `wrangler.jsonc`, yours is used.
2. Appends a SQLite migration, `actors-do-<Class>`, the first time it sees the class.
3. Re-exports the class from the generated entry points.
4. Lists its instances in the Actor Explorer, where you can browse their SQLite tables read-only.

It never deletes anything. If a class it bound disappears from `src/`, `generate` warns and explains how to remove the class on purpose with a `deleted_classes` migration. If the binding name would clash with another binding, `generate` stops and tells you to name the binding yourself.

> [!NOTE]
> Only `extends DurableObject` is detected, and only when declared with `export class`. For classes that extend another base, such as an Agents SDK `Agent`, write the binding and migration yourself and export the class from `src/index.ts`.

## `durable`

`durable<T>(cls: abstract new (ctx: DurableObjectState, env: any) => T)`: `DurableRef<T>`

#### Parameters

- `cls`
  - Your Durable Object class.

#### Returns

A `DurableRef<T>`:

- `get(name: string, options?)` `DurableObjectStub<T>`
  - The stub for the instance with this name (`idFromName`). RPC methods are typed from your class.
- `binding` `string`
  - The binding name `actors generate` assigned.
- `namespace` `DurableObjectNamespace<T>`
  - The namespace itself, for `newUniqueId`, jurisdictions and other advanced uses.

#### Example

```ts title="src/session.ts"
import { DurableObject } from "cloudflare:workers";

export class Session extends DurableObject {
  async ask(question: string): Promise<string> {
    // your own storage, alarms, libraries...
    return `You asked: ${question}`;
  }
}
```

```ts title="src/index.ts"
import { durable } from "actors-poc";
import { Session } from "./session";

export default {
  async fetch(request: Request): Promise<Response> {
    const answer = await durable(Session).get("demo").ask("hello"); // Promise<string>
    return new Response(answer);
  },
};
```

The [`examples/pi-session`](../../examples/pi-session) example hosts a [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) ↗ agent session this way.

## Actors or raw Durable Objects?

Use an actor when the state fits in one JSON document and actions are short. Use a raw class when you need:

- full control of storage
- long-running work
- streaming
- a framework with its own base class

## Related resources

- [Configuration](../reference/configuration.md)
- [Durable Objects: Base class](https://developers.cloudflare.com/durable-objects/api/base/) ↗
