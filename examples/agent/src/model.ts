/**
 * A deterministic stand-in for an LLM, so the demo needs no API keys and tests are stable.
 * Swap `respond` for Workers AI / any model call; the actor code does not change.
 */
export interface ModelInput {
  message: string;
  name: string | null;
  memory: string[];
  openTasks: string[];
}

export type ToolCall =
  | { tool: "set_name"; name: string }
  | { tool: "remember"; fact: string }
  | { tool: "add_task"; title: string }
  | { tool: "remind"; inSeconds: number; note: string };

export interface ModelOutput {
  reply: string;
  toolCalls: ToolCall[];
}

export async function respond(input: ModelInput): Promise<ModelOutput> {
  await new Promise((r) => setTimeout(r, 5)); // pretend to do I/O
  const text = input.message.trim();
  const who = input.name ?? "there";
  let m: RegExpMatchArray | null;

  if ((m = text.match(/^my name is (\w+)/i))) {
    return { reply: `Nice to meet you, ${m[1]}!`, toolCalls: [{ tool: "set_name", name: m[1] }] };
  }
  if ((m = text.match(/^remember (?:that )?(.+)/i))) {
    return { reply: `Got it, I'll remember that ${m[1]}.`, toolCalls: [{ tool: "remember", fact: m[1] }] };
  }
  if ((m = text.match(/^(?:add )?task:? (.+)/i))) {
    return { reply: `Added "${m[1]}" to your tasks.`, toolCalls: [{ tool: "add_task", title: m[1] }] };
  }
  if ((m = text.match(/^remind me in (\d+) seconds? to (.+)/i))) {
    return {
      reply: `I'll remind you in ${m[1]}s.`,
      toolCalls: [{ tool: "remind", inSeconds: Number(m[1]), note: m[2] }],
    };
  }
  if (/what('s| is) my name/i.test(text)) {
    return { reply: input.name ? `You're ${input.name}.` : "You haven't told me your name yet.", toolCalls: [] };
  }
  if (/what do you (know|remember)/i.test(text)) {
    return {
      reply: input.memory.length ? `I remember: ${input.memory.join("; ")}.` : "Nothing yet.",
      toolCalls: [],
    };
  }
  if (/^tool /i.test(text)) {
    // Simulates a model emitting a raw tool call. Malformed JSON here is the "injected failure"
    // used in the debugging walkthrough (README): try `tool {"tool": "remember"`.
    return { reply: "Running tool.", toolCalls: [parseToolCall(text.slice(5))] };
  }
  const tasks = input.openTasks.length ? ` You have ${input.openTasks.length} open task(s).` : "";
  return { reply: `Hi ${who}! You said: "${text}".${tasks}`, toolCalls: [] };
}

function parseToolCall(raw: string): ToolCall {
  const call = JSON.parse(raw) as ToolCall; // throws SyntaxError on malformed model output
  if (!call || typeof call.tool !== "string") throw new Error("Model returned a tool call without a `tool` field");
  return call;
}
