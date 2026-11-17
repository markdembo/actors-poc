# Comparison methodology (FR10)

## The app

A per-customer support agent: chat with a model (simulated and deterministic, shared by both versions), long-term memory, tasks, reminders scheduled N seconds ahead, and no half-written turns when the model call fails.

- **Actors:** [`examples/agent`](../examples/agent): `src/actors/support-agent.ts` and `src/index.ts`
- **Raw Durable Objects:** [`raw-do-agent`](raw-do-agent): `src/agent.ts`, `src/index.ts` and `wrangler.jsonc`

The raw version is written the way a competent Workers developer would write it, not as a strawman. It copies state and commits only after a successful write, and it serializes requests so turns cannot interleave across the model `await`. Without those two measures it would have real bugs: in-memory state diverging from storage after a throw, and interleaved conversation turns. Both versions were run and give the same HTTP behavior for the demo script.

## Results

```bash
node comparison/measure.mjs
```

| | Actors | Raw DO | Reduction |
|---|---:|---:|---:|
| Application code (lines) | 116 | 169 | 31% |
| Hand-written config (lines) | 0 | 10 | 100% |
| **Total developer-authored lines** | **116** | **179** | **35%** |
| Durable Objects concepts in the code | 0 | 15 | 100% |

Lines exclude blanks and comments. The shared model file is excluded from both counts.

## What the numbers do and don't say

- **The business logic is about the same size in both** (chat, tool dispatch, tasks). Almost all of the 63-line difference is infrastructure: the class shell, the env typing, the constructor with `blockConcurrencyWhile`, identity plumbing, the copy-and-commit and queue helpers, the alarm and reminder table, stubs, and config. We did not measure the PRD's "≥70% less infrastructure boilerplate" on its own, because separating "infrastructure" from "logic" involves judgment. The 35% total is the number to quote.
- **The raw version does less.** It has no invocation log, no Explorer or inspect, no redaction, no remote stack traces (Durable Object RPC keeps an error's `name`, `message` and custom properties like `code`, but drops the stack), no state validation, and no reminder retries. Its reminder insert is not atomic with the state write. Matching the Actors version feature-for-feature would widen the gap.
- **The concept list is ours.** We chose the 15 regexes in `measure.mjs`, so treat the count as indicative. Every item on it is something a developer has to learn from the Durable Objects docs to write that file.
- **PartyServer was not built.** PartyServer targets rooms, connections and broadcast over WebSockets. For a request/response agent called from a Worker it would add a `Server` subclass and routing on top of the raw DO version without removing any of the concepts above. The PRD lists it as "where applicable", and it is not applicable to this workload. Compare against it when real-time extensions exist (PRD §15).
- **Time-based metrics are not measured here.** Time to first run, time to deploy and time to diagnose need the 5–10 person study in PRD §11. This repo provides the tasks for that study: the counter, the agent, and the injected `tool {...` failure.
