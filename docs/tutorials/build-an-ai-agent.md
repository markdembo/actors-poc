# Build a persistent AI agent

> [!WARNING]
> **Unofficial, AI-generated proof of concept.** This is not Cloudflare documentation, and the project has no support. Read the [warning in the project README](../../README.md) before using any of it.

In this tutorial, you build a support agent with one instance per customer. The agent:

- Keeps the conversation, long-term memory and tasks in its state.
- Runs model tool calls that change that state.
- Schedules reminders that arrive later.
- Never keeps a half-finished turn when the model call fails.
- Hides a stored API token from debugging tools.

The model is simulated so you can run everything without API keys. The finished code is in [`examples/agent`](../../examples/agent).

## Prerequisites

Complete [Get started](../get-started.md) first.

## 1. Add a model

Copy [`examples/agent/src/model.ts`](../../examples/agent/src/model.ts) into `src/model.ts`. It exports one function:

```ts
respond(input: { message: string; name: string | null; memory: string[]; openTasks: string[] })
  : Promise<{ reply: string; toolCalls: ToolCall[] }>
```

It recognizes phrases like `my name is Ada`, `remember that ...`, `task: ...` and `remind me in 5 seconds to ...`, and returns the matching tool calls. To use a real model, replace the body of `respond`. The actor code doesn't change.

## 2. Define the agent

Create `src/actors/support-agent.ts`:

```ts title="src/actors/support-agent.ts"
import { actor } from "actors-poc";
import { respond } from "../model";

export interface Message {
  role: "user" | "assistant";
  content: string;
  at: number;
}

export const SupportAgent = actor({
  state: (customerId: string) => ({
    customerId,
    name: null as string | null,
    messages: [] as Message[],
    memory: [] as string[],
    tasks: [] as { id: number; title: string; done: boolean }[],
    nextTaskId: 1,
    crmToken: null as string | null,
  }),

  redact: { state: ["crmToken"], args: ["connectCrm"] },

  actions: {
    async chat(ctx, message: string) {
      const { state } = ctx;
      if (typeof message !== "string" || !message.trim()) throw new Error("message must be a non-empty string");
      state.messages.push({ role: "user", content: message, at: Date.now() });

      const out = await respond({
        message,
        name: state.name,
        memory: state.memory,
        openTasks: state.tasks.filter((t) => !t.done).map((t) => t.title),
      });

      for (const call of out.toolCalls) {
        ctx.log("tool call", call);
        if (call.tool === "set_name") state.name = call.name;
        else if (call.tool === "remember") state.memory.push(call.fact);
        else if (call.tool === "add_task") state.tasks.push({ id: state.nextTaskId++, title: call.title, done: false });
        else if (call.tool === "remind") ctx.schedule(call.inSeconds, "followUp", call.note);
      }

      state.messages.push({ role: "assistant", content: out.reply, at: Date.now() });
      state.messages = state.messages.slice(-200);
      return out.reply;
    },

    followUp({ state }, note: string) {
      state.messages.push({ role: "assistant", content: `Reminder: ${note}`, at: Date.now() });
    },

    connectCrm({ state }, token: string) {
      state.crmToken = token;
    },

    history({ state }, limit: number = 20) {
      return { name: state.name, memory: state.memory, tasks: state.tasks, messages: state.messages.slice(-limit) };
    },
  },
});
```

In the code above, you have:

1. **Pushed the user's message before calling the model.** If `respond` throws, that push is rolled back with everything else, so the transcript never shows a question without an answer.
2. **Applied tool calls to the draft state.** They commit together with the reply, or not at all.
3. **Scheduled a reminder with `ctx.schedule`.** It is part of the same transaction: a failed turn schedules nothing. The reminder runs `followUp` later, at least once.
4. **Logged each tool call with `ctx.log`,** so it appears next to the invocation in the Actor Explorer.
5. **Redacted the CRM token** from state views and from the recorded arguments of `connectCrm`.

> [!NOTE]
> Actions run one at a time. While a real model call is in flight, other calls to the same customer's agent wait. That's usually what you want for one conversation. For agents that run long, multi-step jobs, consider a dedicated agent runtime hosted as a [custom class](../api/durable.md).

## 3. Expose it over HTTP

Create `src/index.ts`:

```ts title="src/index.ts"
import { ActorError } from "actors-poc";
import { SupportAgent } from "./actors/support-agent";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, resource, customer] = url.pathname.split("/").map(decodeURIComponent);
    if (resource !== "agents" || !customer) return new Response("Not found", { status: 404 });

    const agent = SupportAgent.get(customer, { timeoutMs: 30_000 });
    try {
      if (request.method === "POST") {
        const { message } = await request.json<{ message: string }>();
        return Response.json({ reply: await agent.chat(message) });
      }
      return Response.json(await agent.history());
    } catch (err) {
      if (err instanceof ActorError && err.kind === "action") {
        return Response.json({ error: err.message }, { status: 422 });
      }
      throw err;
    }
  },
};
```

## 4. Talk to it

```sh
pnpm dev
```

```sh
curl -X POST localhost:8787/agents/acme -d '{"message":"my name is Ada"}'
curl -X POST localhost:8787/agents/acme -d '{"message":"remind me in 5 seconds to check the invoice"}'
curl localhost:8787/agents/acme
```

After five seconds, read the history again. The reminder has been added by the scheduled `followUp`.

## 5. Debug a failure

Send a malformed tool call, which makes the simulated model throw:

```sh
curl -X POST localhost:8787/agents/acme -d '{"message":"tool {\"tool\": \"remember\""}'
```

You get HTTP 422. Then inspect the agent:

```sh
pnpm exec actors inspect SupportAgent acme
```

The failed `chat` is listed with its input, a `SyntaxError`, a stack trace through the model code, and the label **rolled back**. The transcript has no trace of the failed turn.

## Summary

By finishing this tutorial, you have:

- Kept an agent's conversation, memory and tasks in transactional state.
- Applied model tool calls atomically with the reply.
- Scheduled durable follow-ups.
- Diagnosed a failed turn from the invocation log.

## Related resources

- [Rules of actors: side effects](../best-practices/rules-of-actors.md#make-side-effects-safe-to-repeat)
- [Action context: `schedule`](../api/action-context.md#schedule)
- [Custom classes](../api/durable.md): hosting a dedicated agent runtime
