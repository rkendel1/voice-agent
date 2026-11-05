/**
 * One live call's conversation: the ConversationRelay protocol in, the agent's speech out.
 *
 *   setup      bind the session to its call (token) → load the agent's context → speak the disclosure and greeting
 *   prompt     the caller finished an utterance → record it → the agent answers, streaming text to speech
 *   interrupt  the caller spoke over the agent → abort the answer at once; record only what was heard
 *   dtmf "0"   ask for a person
 *   close      persist a partial utterance, mark the session lost or ended; the call's status comes from the provider
 *
 * The transport is not the record. Every turn is written to the application as it happens, in order,
 * through a single write queue; a dropped connection loses at most the words not yet recognised.
 * Operator control (hang up, transfer, take over, say) is read from the call record and applied here.
 */
import { createHash } from "node:crypto";
import type { WebSocket } from "ws";
import { isFeltKitError } from "@feltdb/feltkit";
import type { Brain, ToolName, ToolResult } from "./brain/types.js";
import { TOOLS } from "./brain/types.js";
import type { ProviderId, RelayIn, RelayOut } from "./providers/types.js";
import type { VoiceRuntime } from "./runtime.js";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export class VoiceSession {
  #seq = 0;
  #brain: Brain | null = null;
  #agentId: string | null = null;
  #speaking: { abort: AbortController; text: string } | null = null;
  #turn: Promise<void> = Promise.resolve();
  #writes: Promise<void> = Promise.resolve();
  #partial = "";
  #ended = false;
  #closed = false;
  #takenOver = false;
  #transfer = false;
  #toolCalls = 0;
  #poll: NodeJS.Timeout | null = null;
  #ready: Promise<boolean>;
  #resolveReady!: (ok: boolean) => void;

  constructor(private readonly rt: VoiceRuntime, private readonly ws: WebSocket, readonly callId: string, readonly businessId: string, private readonly token: string, readonly provider: ProviderId) {
    this.#ready = new Promise((r) => (this.#resolveReady = r));
    ws.on("message", (raw) => {
      let msg: RelayIn;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      void this.#on(msg).catch((e) => rt.log(`session ${callId}: ${e?.message ?? e}`));
    });
    ws.on("close", () => void this.#onClose());
    ws.on("error", () => void this.#onClose());
  }

  /** Whether setup bound this session to its call. */
  get ready() { return this.#ready; }

  #send(m: RelayOut) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  async #on(msg: RelayIn) {
    switch (msg.type) {
      case "setup": return this.#setup(msg.callSid);
      case "prompt": {
        if (!(await this.#ready)) return;
        if (!msg.last) { this.#partial = msg.voicePrompt; return; }
        this.#partial = "";
        const text = msg.voicePrompt.trim();
        if (!text) return;
        this.#record("caller", text);
        if (this.#takenOver || this.#ended) return;
        this.#respond(text);
        return;
      }
      case "interrupt": {
        const s = this.#speaking;
        if (!s) return;
        s.abort.abort();
        this.#speaking = null;
        const heard = (msg.utteranceUntilInterrupt ?? "").trim();
        this.#record("agent", heard || "(interrupted before speaking)", { interrupted: true });
        this.#brain?.interrupted(heard);
        return;
      }
      case "dtmf":
        if (msg.digit === "0" && !this.#takenOver && (await this.#ready)) { this.#record("caller", "[pressed 0]"); this.#respond("I'd like to speak to a person, please."); }
        return;
      case "error":
        this.rt.log(`relay error on ${this.callId}: ${msg.description}`);
        return;
    }
  }

  async #setup(providerSid?: string) {
    try {
      const opened = await this.rt.bridge.call("gateway:sessionOpened", { callId: this.callId, sessionTokenHash: hashToken(this.token), ...(providerSid ? { providerSid } : {}) }, this.businessId);
      this.#seq = opened.transcriptSegments;
      this.#agentId = opened.agentId;
      if (!this.#agentId) throw new Error("No agent handles this call.");
      const ctx = await this.rt.bridge.call("gateway:context", { agentId: this.#agentId, callId: this.callId }, this.businessId);
      this.#brain = await this.rt.brainFor(ctx, "voice", this.businessId);
      this.#resolveReady(true);
      const plan = await this.rt.bridge.call("gateway:answerPlan", { callId: this.callId }, this.businessId);
      if (plan?.disclosure && opened.transcriptSegments === 0) { this.#say(plan.disclosure, true); this.#record("system", plan.disclosure); }
      const first = ctx.contact.name?.split(" ")[0];
      const greeting = opened.transcriptSegments > 0 ? "Sorry about that, I'm back. How can I help?" : first ? `Hi ${first}! ${plan?.greeting ?? "How can I help?"}` : plan?.greeting ?? "Hello, how can I help?";
      this.#say(greeting, true);
      this.#record("agent", greeting);
      this.#poll = setInterval(() => void this.#controls(), 700);
    } catch (e: any) {
      this.#resolveReady(false);
      this.rt.noteRefusal(this.provider, `media session for ${this.callId} refused: ${e?.message ?? e}`);
      this.#ended = true;
      this.ws.close(1008, "Not authorized");
    }
  }

  #say(text: string, last: boolean) {
    this.#send({ type: "text", token: text, last });
  }

  #respond(text: string) {
    this.#turn = this.#turn.then(async () => {
      if (this.#ended || this.#takenOver || !this.#brain) return;
      const abort = new AbortController();
      const speaking = { abort, text: "" };
      this.#speaking = speaking;
      try {
        await this.#brain.turn({
          userText: text,
          signal: abort.signal,
          emit: (t) => { if (!abort.signal.aborted) { speaking.text += t; this.#send({ type: "text", token: t, last: false }); } },
          runTool: (name, args) => this.#runTool(name, args),
        });
      } catch (e: any) {
        if (abort.signal.aborted) return;
        this.rt.log(`agent turn failed on ${this.callId}: ${e?.message ?? e}`);
        const sorry = " Sorry, I'm having trouble right now.";
        speaking.text += sorry;
        this.#send({ type: "text", token: sorry, last: false });
      }
      if (abort.signal.aborted) return;
      this.#speaking = null;
      this.#send({ type: "text", token: "", last: true });
      if (speaking.text.trim()) this.#record("agent", speaking.text.trim());
      if (this.#transfer) await this.end({ reason: "transfer" });
      else if (this.#brain.wantsHangup) await this.end({ reason: "goodbye" });
    });
  }

  /**
   * Invoke a capability for the agent. The runtime supplies who and where (agent, call, tool-call id);
   * the model supplies only the arguments. A refusal is recorded and returned to the agent as a result.
   */
  async #runTool(name: ToolName, args: Record<string, unknown>): Promise<ToolResult> {
    const spec = TOOLS[name];
    const toolCallId = `${this.callId}:${this.#seq}:${++this.#toolCalls}`;
    const acting = { agentId: this.#agentId!, callId: this.callId, toolCallId };
    try {
      const result: ToolResult = await this.rt.bridge.call(spec.fn, { ...args, ...acting }, this.businessId);
      if (name === "sms_send" && result.ok && result.messageId) return { ...(await this.rt.sendNow(this.businessId, String(result.messageId))) };
      if (name === "calls_transfer" && result.ok) this.#transfer = true;
      return result;
    } catch (e: any) {
      const reason = String(e?.message ?? e).slice(0, 300);
      if (isFeltKitError(e) && ["FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"].includes(e.code)) {
        await this.rt.bridge.call("gateway:toolDenied", { ...acting, capability: spec.capability, reason, args }, this.businessId).catch(() => {});
        return { ok: false, error: `Not permitted: ${reason}` };
      }
      this.rt.log(`tool ${spec.capability} failed on ${this.callId}: ${e?.code ?? ""} ${reason}`);
      return { ok: false, error: isFeltKitError(e) && e.code === "INVALID_ARGUMENT" ? `Invalid request: ${reason}` : "The action failed." };
    }
  }

  async #controls() {
    if (this.#ended) return;
    let c: any;
    try { c = await this.rt.bridge.call("gateway:controls", { callId: this.callId }, this.businessId); } catch { return; }
    if (!c) return;
    if (["completed", "busy", "no-answer", "failed", "canceled"].includes(c.status)) return this.#stop();
    const control = c.control;
    if (!control) return;
    await this.rt.bridge.call("gateway:controlApplied", { callId: this.callId, seq: control.seq }, this.businessId).catch(() => {});
    switch (control.action) {
      case "hangup": this.#cancelSpeech(); this.#say("I need to end the call now. Goodbye.", true); this.#record("system", `Ended by ${control.by}`); return this.end({ reason: "hangup" });
      case "transfer": this.#cancelSpeech(); this.#say(`Please hold while I transfer you to ${c.transfer?.toName ?? "a colleague"}.`, true); this.#record("system", `Transferred by ${control.by} to ${c.transfer?.toName}`); return this.end({ reason: "transfer" });
      case "takeover": this.#takenOver = true; this.#cancelSpeech(); this.#record("system", `${control.by} took over the call`); return;
      case "release": this.#takenOver = false; this.#record("system", `${control.by} handed the call back to the agent`); return;
      case "say": this.#say(control.text, true); this.#record("operator", control.text); return;
    }
  }

  #cancelSpeech() {
    if (this.#speaking) { this.#speaking.abort.abort(); this.#speaking = null; }
  }

  /** End the media session ourselves. With a transfer, the provider then dials the escalation contact. */
  async end(handoff: { reason: "transfer" | "hangup" | "goodbye" }) {
    if (this.#ended) return;
    this.#ended = true;
    this.#send({ type: "end", handoffData: JSON.stringify({ ...handoff, callId: this.callId }) });
    await this.#writes;
    await this.rt.bridge.call("gateway:sessionClosed", { callId: this.callId, reason: "ended" }, this.businessId).catch(() => {});
    this.#stop();
    if (this.provider === "simulator") await this.rt.simulatorSessionEnded(this.callId, this.businessId, handoff.reason);
  }

  #stop() {
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = null;
  }

  async #onClose() {
    if (this.#closed) return;
    this.#closed = true;
    this.#stop();
    this.#cancelSpeech();
    if (!(await Promise.race([this.#ready, Promise.resolve(false)]))) return void this.rt.sessionGone(this);
    if (this.#partial.trim()) this.#record("caller", this.#partial.trim(), { partial: true });
    await this.#writes;
    if (!this.#ended) {
      await this.rt.bridge.call("gateway:sessionClosed", { callId: this.callId, reason: "lost" }, this.businessId).catch(() => {});
      if (this.provider === "simulator") await this.rt.simulatorHangup(this.callId, this.businessId);
    }
    this.rt.sessionGone(this);
  }

  /** Append a transcript turn, in order, durably. A failed write is retried once and then logged; the call goes on. */
  #record(speaker: "caller" | "agent" | "operator" | "system", text: string, flags: { interrupted?: boolean; partial?: boolean } = {}) {
    const seq = this.#seq++;
    const args = { callId: this.callId, seq, speaker, text: text.slice(0, 4000), interrupted: Boolean(flags.interrupted), partial: Boolean(flags.partial) };
    this.#writes = this.#writes.then(async () => {
      try { await this.rt.bridge.call("gateway:transcript", args, this.businessId); }
      catch {
        try { await this.rt.bridge.call("gateway:transcript", args, this.businessId); }
        catch (e: any) { this.rt.log(`transcript ${this.callId}#${seq} not saved: ${e?.message ?? e}`); }
      }
    });
  }
}
