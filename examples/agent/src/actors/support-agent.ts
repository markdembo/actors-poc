import { actor } from "actors-poc";
import { respond } from "../model";

export interface Message {
  role: "user" | "assistant";
  content: string;
  at: number;
}

export interface Task {
  id: number;
  title: string;
  done: boolean;
}

/** One persistent support agent per customer: conversation, memory, tasks and reminders. */
export const SupportAgent = actor({
  state: (customerId: string) => ({
    customerId,
    name: null as string | null,
    messages: [] as Message[],
    memory: [] as string[],
    tasks: [] as Task[],
    nextTaskId: 1,
    crmToken: null as string | null,
  }),

  // Kept out of the Actor Explorer, `actors inspect` and the invocation log.
  redact: { state: ["crmToken"], args: ["connectCrm"] },

  actions: {
    async chat(ctx, message: string) {
      const { state } = ctx;
      if (typeof message !== "string" || !message.trim()) throw new Error("message must be a non-empty string");
      state.messages.push({ role: "user", content: message, at: Date.now() });

      // If the model call throws, the user message above is rolled back too: no half-written turns.
      const out = await respond({
        message,
        name: state.name,
        memory: state.memory,
        openTasks: state.tasks.filter((t) => !t.done).map((t) => t.title),
      });

      for (const call of out.toolCalls) {
        ctx.log("tool call", call);
        switch (call.tool) {
          case "set_name":
            state.name = call.name;
            break;
          case "remember":
            state.memory.push(call.fact);
            break;
          case "add_task":
            state.tasks.push({ id: state.nextTaskId++, title: call.title, done: false });
            break;
          case "remind":
            ctx.schedule(call.inSeconds, "followUp", call.note);
            break;
          default:
            throw new Error(`Unknown tool "${(call as { tool: string }).tool}"`);
        }
      }

      state.messages.push({ role: "assistant", content: out.reply, at: Date.now() });
      state.messages = state.messages.slice(-200); // keep the document bounded
      return out.reply;
    },

    /** Called by the scheduler (see `remind`), but callable directly too. */
    followUp({ state }, note: string) {
      state.messages.push({ role: "assistant", content: `Reminder: ${note}`, at: Date.now() });
    },

    addTask({ state }, title: string) {
      const task = { id: state.nextTaskId++, title, done: false };
      state.tasks.push(task);
      return task;
    },

    completeTask({ state }, id: number) {
      const task = state.tasks.find((t) => t.id === id);
      if (!task) throw Object.assign(new Error(`No task ${id}`), { code: "TASK_NOT_FOUND" });
      task.done = true;
      return task;
    },

    connectCrm({ state }, token: string) {
      state.crmToken = token;
    },

    history({ state }, limit: number = 20) {
      return { name: state.name, memory: state.memory, tasks: state.tasks, messages: state.messages.slice(-limit) };
    },

    reset(ctx) {
      ctx.state = { ...ctx.state, name: null, messages: [], memory: [], tasks: [], nextTaskId: 1 };
    },
  },
});
