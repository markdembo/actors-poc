# Changing actors safely

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../../README.md) before using any of it.

Actors live longer than your code. Every deploy meets state that older code saved. During a deploy, two versions of your code also run side by side. This page covers both. You need one new idea, `migrations`, and one rule: **only go forward**.

## Change the shape of state with migrations

Add `migrations` to the actor: a list of functions that each take the old state and return the new one. Always add new migrations to the end of the list.

```ts
export const Cart = actor({
  // The current shape. New carts start here and never run a migration.
  state: { items: [] as Item[], currency: "USD" },
  migrations: [
    // 1: `lines` was renamed to `items`
    ({ lines, ...s }) => ({ ...s, items: lines }),
    // 2: carts gained a currency
    (s) => ({ ...s, currency: "USD" }),
  ],
  actions: {
    add: ({ state }, item: Item) => void state.items.push(item),
  },
});
```

How migrations run:

- **Lazily.** An instance runs the migrations it hasn't run yet the first time it's called after a deploy. Instances that nobody calls keep their old state until someone does. No job has to visit every instance, so it works for millions of them.
- **In order, once each.** Each instance stores how many migrations it has run (its *schema*). New instances start at the latest schema.
- **In one transaction, before the action.** The state, the new schema and any `ctx.sql` changes the migrations make are saved together, or nothing is saved. The action then runs on the migrated state.
- **Synchronously.** A migration can't `await`, call `fetch` or call other actors. To transform data with I/O, do it in an action.
- **Checked like any commit.** The result must be plain JSON and pass `validate`.

If a migration throws, nothing changes and the call fails with an `ActorError` of kind `version`. The next call tries again. Fix it by deploying a corrected migration.

A migration also receives `{ actor, key, sql }`, so it can change your own tables in the same transaction:

```ts
migrations: [
  (s, { sql }) => {
    sql.exec("ALTER TABLE messages ADD COLUMN edited_at INTEGER");
    return s;
  },
],
```

> [!NOTE]
> Never edit, reorder or remove a migration that has shipped. Instances that already ran it won't run it again, and instances that haven't will run your edited version. To change state again, append another migration. `actors deploy` warns when a shipped migration looks different and refuses when one is missing.

## What happens while two versions run

When you deploy, especially as a [gradual deployment](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/), old and new code run at the same time:

- Each actor instance runs **one** code version at a time. While you only increase the new version's share, an instance never moves back to the old version.
- The Worker that calls an actor can run a different version from the actor. A Worker on the old version can call an actor already on the new one, and the other way round.
- Calls that old code scheduled run on whatever version the instance has when they fire.

Actors handles each of these:

| Situation | What happens |
|---|---|
| New code, old state | The state migrates on the instance's next call. |
| Old code, newer state (after a rollback) | The call fails with kind `version`: "saved by newer code". Nothing is changed or downgraded. Scheduled calls wait and retry without using up their attempts. |
| A caller on another version asks for an action this version doesn't have | The call fails with kind `version`, naming both code versions. |
| You remove or change an action that the last shipped version had | `actors deploy` and `actors upload` refuse before anything ships. |

## Only go forward

Migrations have no "down" step. If a release with a migration goes wrong, don't roll back: ship a fix forward, with another migration if the state needs repairing. Instances that already migrated refuse older code, so a rollback past a migration makes them fail until you deploy forward again.

## Keep actions compatible until the old version is gone

Treat actions like a public API, because during a deploy they are one:

- **Adding** an action is always safe.
- **Changing** an action's arguments breaks callers that still send the old ones. Add a new action (`addV2`) instead.
- **Removing** an action breaks callers on the previous version and calls it has already scheduled. Remove it in a later deploy, once no Worker version that calls it is deployed.

You don't have to remember this. `actors deploy` compares your actors with the version you last shipped (recorded in `actors.lock.json`, which you commit) and stops on changes that would break callers still on that version. When the old version is gone, ship the change with `--allow-breaking`.

It reads your actions' types with the TypeScript compiler and compares their structure, not their names, so renaming a type or turning a `type` into an `interface` isn't a change:

| Change | Result |
|---|---|
| Add an action, or an optional argument at the end | ✅ Compatible |
| Widen an argument (`string` → `string \| number`, `"a" \| "b"` → `"a" \| "b" \| "c"`) | ✅ Compatible |
| Return an extra property, or make a sync action async | ✅ Compatible |
| Remove an actor, an action or an argument | 🔴 Breaking |
| Change an argument's type, or add a required argument or property | 🔴 Breaking |
| Make an optional argument or property required | 🔴 Breaking |
| Return something old callers don't expect (`number` → `number \| null`, a new literal) | 🔴 Breaking |
| Remove a migration | 🔴 Breaking |

```bash
actors deploy
```

```txt
actors: Breaking changes compared with the version last shipped (actors.lock.json):
  - Cart.checkout(): argument 1 changed from { coupon?: string | undefined } to { coupon: string } (property "coupon" became required).
    Callers on the previous version still send the old shape. Add a new action instead (e.g. checkoutV2) and remove this one later.
  - Cart.applyCoupon() was removed. Workers on the previous version, and calls it scheduled, still call it.
```

What it can't see: arguments typed `any` or `unknown`, and changes in meaning that keep the same type. Without TypeScript in the project (plain JavaScript), it only counts arguments.

## Ship gradually

`actors upload` runs the same checks, then uploads a new version without deploying it. Roll it out with Wrangler:

```bash
actors upload --tag v2
```

```bash
npx wrangler versions deploy
```

Changes that add or remove a Durable Object class (the `migrations` in `wrangler.jsonc`, not actor migrations) can't roll out gradually. `actors upload` refuses them; ship them with `actors deploy` on their own first. Actor types never need one, because every actor runs in the same class.

## See which version did what

Every call records the code version that ran it: the version tag if you set one (`--tag v2`), otherwise the start of the version id. In the [Actor Explorer](../reference/cli.md#actor-explorer) and `actors inspect`:

- The activity timeline shows the code version of each call, marks where it changes, and shows migrations as their own entries (`migrate schema 0 → 2`).
- A call from a Worker on another version is marked `called from <version>`.
- The header shows the instance's schema, and whether it will migrate on its next call or was saved by newer code.
- The list shows how many instances each code version last served.

Locally, each `actors dev` start counts as a new code version, so restarting with changed code shows the same timeline you'd see after a deploy.

## Related resources

- [`actor()`: `migrations`](../api/actor.md)
- [Errors: kind `version`](../api/errors.md)
- [CLI: `deploy`, `upload`, `check`](../reference/cli.md)
- [Semantics: versions and migrations](../semantics.md#versions-and-migrations)
