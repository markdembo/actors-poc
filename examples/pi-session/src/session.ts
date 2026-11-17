/**
 * A durable pi agent session as a plain Durable Object, following pi-durable's own
 * Cloudflare pattern (README "Sleeping and Waking Up"). Nothing Actors-specific here:
 * `actors generate` finds this class and writes its binding and migration.
 *
 * The model is pi-ai's deterministic faux provider so the example runs without API keys.
 * For a real model, replace `fauxModels()` with e.g. `models.setProvider(openaiProvider())`
 * (and a secret), or one of pi-ai's Cloudflare providers (Workers AI, AI Gateway).
 */
import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { type FauxResponseFactory, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type Wake } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

const context = BACKGROUND_CONTEXT;

export interface Turn {
  id: number;
  kind: string;
  role?: string;
  text: string;
}

export class Session extends DurableObject {
  #harness!: Harness;
  #model!: { provider: string; modelId: string };

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      // Arm a fallback first: an object whose open or recovery fails is started again.
      const fallback = Date.now() + 60_000;
      const current = await ctx.storage.getAlarm();
      if (current === null || current > fallback) await ctx.storage.setAlarm(fallback);

      const { models, model } = fauxModels();
      this.#model = model;
      const storage = await openDurableObjectSqliteStorage(ctx.storage as never);
      const onWake = (wake: Wake) => void this.#arm(wake).catch(() => ctx.abort("Alarm write failed"));
      this.#harness = await Harness.open(storage, { models, registry: createRegistry(), onWake }, context);
      await this.#arm(this.#harness.wake());
      this.#harness.resume(); // work a lost instance left, and due sleeps
    });
  }

  override async alarm(): Promise<void> {
    await this.#arm({ ...this.#harness.wake(), active: true });
    this.#harness.resume();
  }

  /** Submit a message and wait for the answer. `requestId` makes retries safe (same id → same submission). */
  async ask(text: string, requestId: string): Promise<{ status: string; answer?: string }> {
    await this.#arm({ ...this.#harness.wake(), active: true }); // arm before anything can start work
    const root = await this.#harness.root(context, { agent: { model: this.#model } });
    const submission = await root.submit({ type: "input", content: text, requestId }, context);
    const settled = await submission.wait(context);
    if (settled.status !== "done") return { status: settled.status };
    const [last] = (await root.entries({ order: "descending" }, 1, undefined, context)).items;
    return { status: "done", answer: last ? textOf(last.model) : undefined };
  }

  /** The newest `limit` transcript entries, oldest first. */
  async history(limit = 20): Promise<Turn[]> {
    const root = await this.#harness.root(context, { agent: { model: this.#model } });
    const page = await root.entries({ order: "descending" }, limit, undefined, context);
    return page.items
      .map((e) => ({ id: e.id as number, kind: e.kind, role: e.model?.[0]?.role, text: textOf(e.model) }))
      .reverse();
  }

  async #arm(wake: Wake): Promise<void> {
    // A recovery heartbeat while work runs, never later than the earliest sleep.
    const heartbeat = wake.active ? Date.now() + 60_000 : undefined;
    const at = heartbeat === undefined || wake.at === undefined ? (heartbeat ?? wake.at) : Math.min(heartbeat, wake.at);
    if (at === undefined) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(at);
  }
}

function fauxModels() {
  const faux = fauxProvider();
  const reply = (c: { messages?: readonly { role: string; content: unknown }[] }) => {
    const last = [...(c.messages ?? [])].reverse().find((m) => m.role === "user");
    return fauxAssistantMessage(`You said: ${textOf(last ? [last] : [])}`);
  };
  // The faux provider answers from a queue; keep it topped up.
  const step: FauxResponseFactory = (c) => {
    if (faux.getPendingResponseCount() < 10) refill();
    return reply(c);
  };
  const refill = (): void => faux.appendResponses(Array.from({ length: 100 }, () => step));
  refill();
  const models = createModels();
  models.setProvider(faux.provider);
  const m = faux.getModel();
  return { models, model: { provider: m.provider, modelId: m.id } };
}

function textOf(messages: readonly { content?: unknown }[] | undefined): string {
  const parts: string[] = [];
  for (const m of messages ?? []) {
    if (typeof m.content === "string") parts.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const b of m.content) if (b && typeof b === "object" && "text" in b) parts.push(String(b.text));
    }
  }
  return parts.join("");
}
