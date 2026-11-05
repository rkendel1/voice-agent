/**
 * Model-driven agents, streaming, with tool use: the model selected in Studio → Models (AppPort
 * Services Intelligence), its key from FeltKit's credential custody. Two wire protocols cover the
 * providers Intelligence offers: Anthropic Messages and OpenAI Chat Completions (OpenAI, Ollama and
 * any OpenAI-compatible endpoint). No SDK dependency: the provider stays replaceable.
 *
 * Voice latency: text is emitted as it streams, so speech starts on the first tokens; an interruption
 * aborts the request at once (AbortSignal) and the unheard rest of the answer is dropped from memory.
 */
import { TOOLS, toolsFor, type AgentContext, type Brain, type Channel, type ToolName, type TurnInput } from "./types.js";

export interface ModelConnection { protocol: "anthropic" | "openai" | "openai-compatible"; model: string; endpoint: string | null; apiKey: string | null }

const MAX_TOOL_ROUNDS = 4;

export function systemPrompt(ctx: AgentContext, channel: Channel): string {
  const b = ctx.business;
  return [
    ctx.agent.instructions,
    "",
    `You are ${ctx.agent.name}, the ${channel === "voice" ? "phone" : "text message"} agent for ${b.name}. ${ctx.agent.purpose}`,
    channel === "voice"
      ? "You are speaking on a phone call: answer in one to three short sentences, no lists, no markdown, no emoji. Say times like \"2:30 PM\"."
      : "You are replying by text message: be brief (under 320 characters), plain text.",
    "Rules you must follow:",
    "- Only say an action happened (booked, texted, transferred, message taken) if the tool result for it has ok: true. If ok is false, say so plainly and offer an alternative.",
    "- Never invent appointment times: use appointments_availability, and book only a slot it returned.",
    "- If you cannot help, offer to take a message (followups_create) or, on a call, to transfer to a person (calls_transfer).",
    "",
    `Business: ${b.name}. ${b.about}`,
    `Opening hours (${b.timezone}): ${b.hours.map((h) => `${h.day} ${h.open}-${h.close}`).join(", ") || "not set"}. Open now: ${b.openNow ? "yes" : "no"}.`,
    `Now: ${ctx.now.day} ${ctx.now.date} ${ctx.now.time} (${b.timezone}).`,
    `You are talking to: ${ctx.contact.name ?? "unknown name"} (${ctx.contact.phone})${ctx.contact.smsOptOut ? "; they opted out of texts, do not text them" : ""}.`,
    b.escalation.length ? `People calls can be transferred to (escalationId: name): ${b.escalation.map((e) => `${e.id}: ${e.name}`).join(", ")}.` : "",
  ].join("\n");
}

type Call = { id: string; name: string; args: Record<string, unknown> };

/** One message history, held in the provider's own shape. */
export class LlmBrain implements Brain {
  readonly kind: string;
  wantsHangup = false;
  #history: any[] = [];
  readonly #tools: ToolName[];
  readonly #system: string;

  constructor(private readonly ctx: AgentContext, private readonly channel: Channel, private readonly conn: ModelConnection, private readonly fetchImpl: typeof fetch = fetch) {
    this.kind = `${conn.protocol}:${conn.model}`;
    this.#tools = toolsFor(ctx, channel);
    this.#system = systemPrompt(ctx, channel);
    for (const m of ctx.texts.slice(-6)) this.#history.push({ role: m.direction === "inbound" ? "user" : "assistant", content: m.body });
    this.#history = mergeRoles(this.#history);
  }

  interrupted(spoken: string): void {
    const last = this.#history.at(-1);
    if (last?.role === "assistant" && typeof last.content === "string") last.content = spoken ? `${spoken}…` : "(interrupted)";
  }

  async turn({ userText, emit, runTool, signal }: TurnInput): Promise<void> {
    this.#push({ role: "user", content: userText });
    for (let round = 0; round <= MAX_TOOL_ROUNDS && !signal.aborted; round++) {
      const { text, calls } = this.conn.protocol === "anthropic" ? await this.#anthropic(emit, signal) : await this.#openai(emit, signal);
      if (signal.aborted) return;
      if (!calls.length || round === MAX_TOOL_ROUNDS) {
        if (/\b(goodbye|bye)\b/i.test(text) && this.channel === "voice") this.wantsHangup = true;
        return;
      }
      const results: Array<{ call: Call; result: unknown }> = [];
      for (const call of calls) {
        const name = call.name as ToolName;
        const result = this.#tools.includes(name) ? await runTool(name, call.args) : { ok: false, error: `Tool ${call.name} is not available to this agent.` };
        results.push({ call, result });
      }
      this.#toolResults(results);
    }
  }

  #push(m: any) {
    const last = this.#history.at(-1);
    if (last && last.role === m.role && typeof last.content === "string" && typeof m.content === "string") last.content += `\n${m.content}`;
    else this.#history.push(m);
  }

  #toolResults(results: Array<{ call: Call; result: unknown }>) {
    if (this.conn.protocol === "anthropic") {
      this.#history.push({ role: "user", content: results.map((r) => ({ type: "tool_result", tool_use_id: r.call.id, content: JSON.stringify(r.result) })) });
    } else {
      for (const r of results) this.#history.push({ role: "tool", tool_call_id: r.call.id, content: JSON.stringify(r.result) });
    }
  }

  async #anthropic(emit: (t: string) => void, signal: AbortSignal) {
    const base = (this.conn.endpoint ?? "https://api.anthropic.com").replace(/\/+$/, "").replace(/\/v1$/, "");
    const response = await this.fetchImpl(`${base}/v1/messages`, {
      method: "POST", signal,
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(this.conn.apiKey ? { "x-api-key": this.conn.apiKey } : {}) },
      body: JSON.stringify({
        model: this.conn.model, max_tokens: this.channel === "voice" ? 300 : 400, temperature: this.ctx.agent.temperature, stream: true, system: this.#system,
        messages: this.#history, tools: this.#tools.map((n) => ({ name: n, description: TOOLS[n].description, input_schema: TOOLS[n].parameters })),
      }),
    });
    if (!response.ok || !response.body) throw new Error(`Model request failed: ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`);
    let text = "";
    const blocks: any[] = [];
    for await (const event of sse(response.body, signal)) {
      if (event.type === "content_block_start") blocks[event.index] = event.content_block.type === "tool_use" ? { type: "tool_use", id: event.content_block.id, name: event.content_block.name, json: "" } : { type: "text", text: "" };
      else if (event.type === "content_block_delta") {
        const b = blocks[event.index];
        if (event.delta.type === "text_delta") { b.text += event.delta.text; text += event.delta.text; emit(event.delta.text); }
        else if (event.delta.type === "input_json_delta") b.json += event.delta.partial_json;
      }
    }
    const content = blocks.filter(Boolean).map((b) => (b.type === "text" ? { type: "text", text: b.text } : { type: "tool_use", id: b.id, name: b.name, input: safeJson(b.json) })).filter((b) => b.type !== "text" || b.text);
    const calls = content.filter((b: any) => b.type === "tool_use").map((b: any) => ({ id: b.id, name: b.name, args: b.input }));
    this.#history.push({ role: "assistant", content: calls.length ? content : text });
    return { text, calls };
  }

  async #openai(emit: (t: string) => void, signal: AbortSignal) {
    const base = (this.conn.endpoint ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const response = await this.fetchImpl(`${base}/chat/completions`, {
      method: "POST", signal,
      headers: { "content-type": "application/json", ...(this.conn.apiKey ? { authorization: `Bearer ${this.conn.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.conn.model, temperature: this.ctx.agent.temperature, stream: true,
        messages: [{ role: "system", content: this.#system }, ...this.#history],
        ...(this.#tools.length ? { tools: this.#tools.map((n) => ({ type: "function", function: { name: n, description: TOOLS[n].description, parameters: TOOLS[n].parameters } })) } : {}),
      }),
    });
    if (!response.ok || !response.body) throw new Error(`Model request failed: ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`);
    let text = "";
    const partial: Array<{ id: string; name: string; json: string }> = [];
    for await (const event of sse(response.body, signal)) {
      const delta = event.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) { text += delta.content; emit(delta.content); }
      for (const tc of delta.tool_calls ?? []) {
        const p = (partial[tc.index ?? 0] ??= { id: "", name: "", json: "" });
        if (tc.id) p.id = tc.id;
        if (tc.function?.name) p.name += tc.function.name;
        if (tc.function?.arguments) p.json += tc.function.arguments;
      }
    }
    const calls = partial.filter(Boolean).map((p, i) => ({ id: p.id || `call_${i}`, name: p.name, args: safeJson(p.json) }));
    this.#history.push(calls.length ? { role: "assistant", content: text || null, tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : { role: "assistant", content: text });
    return { text, calls };
  }
}

/** Server-sent events → JSON objects. */
export async function* sse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try { yield JSON.parse(data); } catch { /* keep-alive or partial */ }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

const safeJson = (s: string) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
function mergeRoles(list: any[]) {
  const out: any[] = [];
  for (const m of list) { const last = out.at(-1); if (last?.role === m.role) last.content += `\n${m.content}`; else out.push({ ...m }); }
  while (out[0]?.role === "assistant") out.shift();
  return out;
}
