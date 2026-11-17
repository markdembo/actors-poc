// The same per-customer support agent as examples/agent, written directly against
// Durable Objects the way a competent Workers developer would.
import { DurableObject } from "cloudflare:workers";
import { respond } from "../../../examples/agent/src/model";

export interface Env {
  SUPPORT_AGENT: DurableObjectNamespace<SupportAgent>;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  at: number;
}

interface Task {
  id: number;
  title: string;
  done: boolean;
}

interface State {
  customerId: string;
  name: string | null;
  messages: Message[];
  memory: string[];
  tasks: Task[];
  nextTaskId: number;
  crmToken: string | null;
}

export class SupportAgent extends DurableObject<Env> {
  private state: State | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, note TEXT NOT NULL)",
      );
      this.state = await ctx.storage.get<State>("state");
    });
  }

  // The DO doesn't know which customer it is for, so callers pass it in.
  private load(customerId: string): State {
    this.state ??= {
      customerId,
      name: null,
      messages: [],
      memory: [],
      tasks: [],
      nextTaskId: 1,
      crmToken: null,
    };
    return this.state;
  }

  // Work on a copy and only swap it in after a successful write, so a throw mid-way
  // doesn't leave memory and storage out of sync.
  private async mutate<T>(customerId: string, fn: (s: State) => T | Promise<T>): Promise<T> {
    const run = async () => {
      const draft = structuredClone(this.load(customerId));
      const result = await fn(draft);
      await this.ctx.storage.put("state", draft);
      this.state = draft;
      return result;
    };
    // Serialize: awaiting the model lets other requests in, which would interleave turns.
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async chat(customerId: string, message: string): Promise<string> {
    if (typeof message !== "string" || !message.trim()) throw new Error("message must be a non-empty string");
    return this.mutate(customerId, async (state) => {
      state.messages.push({ role: "user", content: message, at: Date.now() });
      const out = await respond({
        message,
        name: state.name,
        memory: state.memory,
        openTasks: state.tasks.filter((t) => !t.done).map((t) => t.title),
      });
      for (const call of out.toolCalls) {
        console.log(`[${customerId}] tool call`, JSON.stringify(call));
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
            // Not atomic with the state write above; acceptable for reminders.
            await this.addReminder(Date.now() + call.inSeconds * 1000, call.note);
            break;
          default:
            throw new Error(`Unknown tool "${(call as { tool: string }).tool}"`);
        }
      }
      state.messages.push({ role: "assistant", content: out.reply, at: Date.now() });
      state.messages = state.messages.slice(-200);
      return out.reply;
    });
  }

  async addTask(customerId: string, title: string): Promise<Task> {
    return this.mutate(customerId, (state) => {
      const task = { id: state.nextTaskId++, title, done: false };
      state.tasks.push(task);
      return task;
    });
  }

  async completeTask(customerId: string, id: number): Promise<Task> {
    return this.mutate(customerId, (state) => {
      const task = state.tasks.find((t) => t.id === id);
      if (!task) throw Object.assign(new Error(`No task ${id}`), { code: "TASK_NOT_FOUND" });
      task.done = true;
      return task;
    });
  }

  async connectCrm(customerId: string, token: string): Promise<void> {
    await this.mutate(customerId, (state) => {
      state.crmToken = token;
    });
  }

  async history(customerId: string, limit = 20) {
    const state = this.load(customerId);
    return { name: state.name, memory: state.memory, tasks: state.tasks, messages: state.messages.slice(-limit) };
  }

  private async addReminder(at: number, note: string) {
    this.ctx.storage.sql.exec("INSERT INTO reminders (at, note) VALUES (?, ?)", at, note);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    const due = this.ctx.storage.sql
      .exec<{ id: number; note: string }>("SELECT id, note FROM reminders WHERE at <= ? ORDER BY at", Date.now())
      .toArray();
    for (const r of due) {
      await this.mutate(this.state!.customerId, (state) => {
        state.messages.push({ role: "assistant", content: `Reminder: ${r.note}`, at: Date.now() });
      });
      this.ctx.storage.sql.exec("DELETE FROM reminders WHERE id = ?", r.id);
    }
    const next = this.ctx.storage.sql.exec<{ at: number | null }>("SELECT MIN(at) AS at FROM reminders").one().at;
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}
