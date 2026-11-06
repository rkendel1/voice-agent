/**
 * The voice runtime: the process-side half of the application, embedded in the same Node process as
 * FeltKit (server/dev.ts, server/start.ts). It exists because telephony needs two things FeltKit does
 * not serve to applications: provider webhooks at public URLs (form-encoded, provider-signed) and a
 * long-lived WebSocket per call. It holds no state of its own: every event becomes a FeltKit call
 * (gateway/bridge.ts), and every piece of work it does later is FeltKit durable work recorded for this
 * component by the application's mutations (`ctx.afterCommit.work`), claimed and settled through `ctx.work`.
 *
 * Configuration comes from Studio, re-read every few seconds, so changing it needs no restart:
 *   TELEPHONY_PROVIDER, TWILIO_ACCOUNT_SID, PUBLIC_BASE_URL (Configuration), twilio-auth-token (Credentials),
 *   and the model (Models) for agents whose brain is "environment".
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { isFeltKitError, type ComponentWorkOutcome } from "@feltdb/feltkit";
import type { ComponentContext, ComponentHealth, ComponentState } from "@feltdb/feltkit/server";
import type { WorkInput } from "../feltkit/_ops.js";
import { Bridge } from "./bridge.js";
import { DeterministicBrain } from "./brain/deterministic.js";
import { LlmBrain, type ModelConnection } from "./brain/llm.js";
import type { AgentContext, Brain, Channel } from "./brain/types.js";
import { SimulatorProvider, type SimRinging } from "./providers/simulator.js";
import { answerTwiml, EMPTY_TWIML, HANGUP_TWIML, TwilioProvider, verifyTwilio } from "./providers/twilio.js";
import type { AnswerPlan, CallStatus, InboundCall, InboundSms, ProviderId, SmsStatus, TelephonyProvider } from "./providers/types.js";
import { hashToken, VoiceSession } from "./voice.js";

export interface VoiceRuntimeOptions {
  /** The FeltKit component context (gateway/component.ts), or one built for tests. */
  context: ComponentContext;
  /** Serve the simulator (default: outside production; in production only with SIMULATOR_ENABLED=1). */
  simulator?: boolean;
  log?: (line: string) => void;
  /** Tests: Twilio's API base and fetch. */
  twilioApiBase?: string;
  fetch?: typeof fetch;
  workIntervalMs?: number;
}

interface Settings { provider: ProviderId; accountSid: string | null; authToken: string | null; publicBaseUrl: string | null }

const TERMINAL = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

export class VoiceRuntime {
  readonly bridge: Bridge;
  readonly simulator = new SimulatorProvider();
  readonly sessions = new Map<string, VoiceSession>();
  settings: Settings = { provider: "simulator", accountSid: null, authToken: null, publicBaseUrl: null };
  problems: string[] = [];
  signatureFailures = 0;
  lastWebhookAt: number | undefined;
  server: Server | null = null;
  url = "";
  readonly #startedAt = Date.now();
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  #twilio: TwilioProvider | null = null;
  #timers: NodeJS.Timeout[] = [];
  #working = false;
  #closed = false;
  #again = false;
  #modelProblem: string | null = null;
  /** The origin the simulator phone reached us at (the application's own, under FeltKit). */
  #simulatorBase: string | null = null;
  #lastWorkAt = 0;
  readonly #simCalls = new Map<string, { sid: string; callId: string; businessId: string; answeredAt?: number; startedAt: number }>();

  constructor(readonly options: VoiceRuntimeOptions) {
    this.bridge = new Bridge(options.context);
    this.simulator.onSmsStatus = (sid, status, errorCode) => void this.#simSmsStatus(sid, status, errorCode);
    this.simulator.onCallStatus = (ring, status) => void this.#simDialStatus(ring, status);
  }

  log(line: string) {
    (this.options.log ?? ((l) => console.log(l)))(`[voice] ${line}`);
  }

  get simulatorEnabled(): boolean {
    return this.options.simulator ?? (!this.options.context.environment.production || process.env.SIMULATOR_ENABLED === "1");
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Start the runtime's work: configuration refresh, heartbeat, the work loop. Traffic arrives through request() and upgrade(). */
  async start(): Promise<this> {
    this.#lastWorkAt = Date.now();
    await this.refresh();
    const every = (ms: number, fn: () => unknown) => { const t = setInterval(() => { if (!this.#closed) void Promise.resolve(fn()).catch((e) => this.log(String(e?.message ?? e))); }, ms); t.unref?.(); this.#timers.push(t); };
    every(5000, () => this.refresh());
    every(5000, () => this.heartbeat());
    if ((this.options.workIntervalMs ?? 400) > 0) every(this.options.workIntervalMs ?? 400, () => this.work());
    await this.heartbeat();
    return this;
  }

  /** Serve on a port of its own (tests, or a host that routes a separate port). Under FeltKit, the application's server routes to it. */
  async listen(port = 0, host = "127.0.0.1"): Promise<this> {
    this.server = createServer((req, res) => void this.request(req, res));
    this.server.on("upgrade", (req, socket, head) => this.upgrade(req, socket as any, head));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => resolve());
    });
    this.url = `http://localhost:${(this.server.address() as { port: number }).port}`;
    return this;
  }

  async close() {
    this.#closed = true;
    for (const t of this.#timers) clearInterval(t);
    for (const s of this.sessions.values()) await s.end({ reason: "hangup" }).catch(() => {});
    for (const c of this.#wss.clients) c.terminate();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server?.closeAllConnections?.();
  }

  /** Re-read Studio's configuration and credentials. Problems are reported, never guessed around. */
  async refresh() {
    const s = await this.bridge.call("gateway:settings");
    const provider: ProviderId = s.provider === "twilio" ? "twilio" : "simulator";
    const problems: string[] = [];
    if (s.provider && s.provider !== "twilio" && s.provider !== "simulator") problems.push(`TELEPHONY_PROVIDER "${s.provider}" is not supported (twilio or simulator).`);
    const authToken = provider === "twilio" ? await this.bridge.secret("twilio-auth-token") : null;
    const publicBaseUrl = (s.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? null)?.replace(/\/+$/, "") ?? null;
    if (provider === "twilio") {
      if (!s.twilioAccountSid) problems.push("Set TWILIO_ACCOUNT_SID in Studio → Services → Configuration.");
      if (!authToken) problems.push("Set the credential twilio-auth-token in Studio → Services → Credentials (or `npx feltkit credential set credential-ref:twilio-auth-token`).");
      if (!publicBaseUrl) problems.push("Set PUBLIC_BASE_URL (the https URL Twilio reaches this runtime at) in Studio → Services → Configuration.");
      else if (!publicBaseUrl.startsWith("https://")) problems.push("PUBLIC_BASE_URL must be https:// (Twilio requires TLS for media WebSockets).");
    } else if (!this.simulatorEnabled) problems.push("TELEPHONY_PROVIDER is simulator, but the simulator is disabled in production (SIMULATOR_ENABLED=1 to allow it).");
    if (this.#modelProblem) problems.push(this.#modelProblem);
    this.settings = { provider, accountSid: s.twilioAccountSid, authToken, publicBaseUrl };
    this.#twilio = provider === "twilio" && s.twilioAccountSid && authToken ? new TwilioProvider(s.twilioAccountSid, authToken, this.options.fetch ?? fetch, this.options.twilioApiBase) : null;
    this.problems = problems;
  }

  async heartbeat() {
    await this.bridge.call("gateway:heartbeat", {
      provider: this.settings.provider, ready: this.problems.length === 0, problems: this.problems.slice(0, 20),
      ...(this.settings.publicBaseUrl ? { publicBaseUrl: this.settings.publicBaseUrl } : {}), ...(this.url ? { url: this.url } : {}), simulator: this.simulatorEnabled, signatureFailures: this.signatureFailures,
      ...(this.lastWebhookAt ? { lastWebhookAt: this.lastWebhookAt } : {}), startedAt: this.#startedAt,
    });
  }

  noteRefusal(provider: ProviderId, why: string) {
    this.log(why);
    if (provider === "twilio") this.signatureFailures++;
  }

  #provider(id: ProviderId): TelephonyProvider | null {
    return id === "simulator" ? (this.simulatorEnabled ? this.simulator : null) : this.#twilio;
  }

  /** The base URL providers call back: the public URL for Twilio, this server for the simulator. */
  #base(id: ProviderId) {
    return id === "twilio" ? this.settings.publicBaseUrl ?? "" : this.#simulatorBase ?? this.url;
  }

  /** The media-session token for a call key: derived (HMAC with the app's auth secret), so it survives a restart; only its hash is stored. */
  #token(key: string) {
    return this.options.context.derive(`voice-relay:${key}`);
  }

  // ── Agents ──────────────────────────────────────────────────────────────────

  /**
   * The brain for an agent: the scripted one, or the model selected in Studio → Models. If the agent asks
   * for a model that is not configured, the scripted agent answers and the problem is reported on Setup.
   */
  async brainFor(ctx: AgentContext, channel: Channel, _businessId: string): Promise<Brain> {
    if (ctx.agent.brain !== "environment") return new DeterministicBrain(ctx, channel);
    const model = await this.options.context.model();
    if (!model) {
      this.#modelProblem = `Agent "${ctx.agent.name}" uses the environment model, but none is ready: the scripted agent answers instead. Choose a model in Studio → Models.`;
      return new DeterministicBrain(ctx, channel);
    }
    this.#modelProblem = null;
    return new LlmBrain(ctx, channel, model, this.options.fetch ?? fetch);
  }

  // ── Provider-neutral handlers ─────────────────────────────────────────────

  async #route(to: string) {
    return this.bridge.call<{ businessId: string; numberId: string; provider: ProviderId } | null>("gateway:route", { to });
  }

  async inboundSms(e: InboundSms) {
    const r = await this.#route(e.to);
    if (!r) return { routed: false as const };
    const out = await this.bridge.call("gateway:inboundSms", e, r.businessId);
    if (out.outcome === "agent_reply_queued") this.kick();
    return { routed: true as const, ...out };
  }

  async smsStatus(e: SmsStatus, businessId: string | null, ourNumber?: string) {
    const b = businessId ?? (ourNumber ? (await this.#route(ourNumber))?.businessId : null);
    if (!b) return { applied: false };
    return this.bridge.call("gateway:smsStatus", e, b);
  }

  /** A call arrived: the application decides; this turns the decision into the provider's answer. */
  async inboundCall(e: InboundCall): Promise<AnswerPlan & { callId?: string; businessId?: string }> {
    const r = await this.#route(e.to);
    if (!r) return { kind: "reject" };
    const token = this.#token(`sid:${e.sid}`);
    const d = await this.bridge.call("gateway:inboundCall", { ...e, sessionTokenHash: hashToken(token) }, r.businessId);
    return { ...this.#plan(e.provider, d, r.businessId, token, e.to), callId: d.callId, businessId: r.businessId };
  }

  #plan(provider: ProviderId, d: any, businessId: string, token: string, ourNumber: string): AnswerPlan {
    if (d.handling === "agent") {
      const base = this.#base(provider);
      const q = `callId=${encodeURIComponent(d.callId)}&b=${encodeURIComponent(businessId)}`;
      return { kind: "relay", relayUrl: `${base.replace(/^http/, "ws")}/${provider}/relay?${q}&t=${token}`, actionUrl: `${base}/${provider}/connect-action?${q}`, voice: d.voice };
    }
    if (d.handling === "forward" && d.forwardTo) return { kind: "forward", forwardTo: d.forwardTo, callerId: ourNumber, say: "Please hold while we connect you." };
    return { kind: "unavailable", say: d.unavailable ?? "Sorry, we can't take your call right now." };
  }

  /** The provider connected an outbound call we placed: answer it with the agent (or the operator's line). */
  async answerOutbound(provider: ProviderId, callId: string, businessId: string): Promise<AnswerPlan> {
    const p = await this.bridge.call("gateway:answerPlan", { callId }, businessId);
    if (!p) return { kind: "unavailable", say: "Goodbye." };
    if (p.handling !== "agent") return { kind: "unavailable", say: "This call could not be connected to an agent. Goodbye." };
    return this.#plan(provider, { ...p, callId }, businessId, this.#token(`call:${callId}`), p.from);
  }

  async callStatus(e: CallStatus) {
    let b = e.businessId ?? null;
    if (!b) return { applied: false };
    const out = await this.bridge.call("gateway:callStatus", { provider: e.provider, sid: e.sid, status: e.status, ...(e.callId ? { callId: e.callId } : {}), ...(e.duration !== undefined ? { duration: e.duration } : {}) }, b);
    this.kick();
    return out;
  }

  /** The media session ended (Twilio's <Connect action>): transfer if one was asked for, else hang up. */
  async connectAction(callId: string, businessId: string, handoff: { reason?: string } | null, sessionStatus: string | undefined): Promise<AnswerPlan | null> {
    if (handoff?.reason === "transfer") {
      const c = await this.bridge.call("gateway:controls", { callId }, businessId);
      if (c?.transfer?.to) {
        await this.bridge.call("gateway:transferResult", { callId, status: "dialing" }, businessId);
        return { kind: "forward", forwardTo: c.transfer.to, say: `Connecting you to ${c.transfer.toName}.` };
      }
      await this.bridge.call("gateway:transferResult", { callId, status: "failed", error: "No transfer target" }, businessId).catch(() => {});
    }
    if (sessionStatus === "failed") this.log(`media session failed for ${callId}`);
    return null;
  }

  /**
   * The component's health, for the application's /_feltkit/health. Named checks let an operator (and a
   * control plane) tell which part is unavailable:
   *   webhooks  a provider is configured and its webhooks can be verified (or the development simulator)
   *   media     WebSocket media sessions can be accepted at a URL the provider can reach
   *   work      the durable work loop is running (sends, dials, agent replies, summaries)
   */
  health(): ComponentHealth {
    const twilio = this.settings.provider === "twilio";
    const configured = twilio ? Boolean(this.settings.accountSid && this.settings.authToken && this.settings.publicBaseUrl?.startsWith("https://")) : this.simulatorEnabled;
    const webhooks: { state: ComponentState; detail?: string } = configured
      ? { state: "ready", detail: twilio ? `Twilio, signed at ${this.settings.publicBaseUrl}` : "development simulator" }
      : { state: "unconfigured", detail: this.problems.filter((p) => !p.startsWith("Agent ")).join(" ") || "No telephony provider is configured." };
    const media: { state: ComponentState; detail?: string } = this.#closed
      ? { state: "failed", detail: "closed" }
      : configured ? { state: "ready", detail: `${this.sessions.size} live session(s)` } : { state: "unconfigured", detail: "Needs a configured provider (and an https PUBLIC_BASE_URL for Twilio)." };
    const manual = this.options.workIntervalMs === 0;
    const work: { state: ComponentState; detail?: string } = this.#closed
      ? { state: "failed", detail: "closed" }
      : manual || Date.now() - this.#lastWorkAt < 10_000 ? { state: "ready" } : { state: "degraded", detail: "The work loop has not run in 10 s." };
    const checks = { webhooks, media, work };
    const order: ComponentState[] = ["failed", "starting", "degraded", "unconfigured", "ready"];
    const state = order.find((st) => Object.values(checks).some((c) => c.state === st)) ?? "ready";
    return { state, ...(state !== "ready" ? { detail: Object.entries(checks).filter(([, c]) => c.state !== "ready").map(([n, c]) => `${n}: ${c.detail ?? c.state}`).join("; ") } : {}), checks };
  }

  // ── Durable work ────────────────────────────────────────────────────────────

  /** Do due work now (not in manual mode, `workIntervalMs: 0`, where the caller drives `work()`). */
  kick() {
    if (this.#closed || this.options.workIntervalMs === 0) return;
    void this.work().catch((e) => this.log(`work: ${e?.message ?? e}`));
  }

  /** Lease and perform due work. Runs on a timer and when something new is queued; never concurrently. */
  async work(): Promise<number> {
    this.#lastWorkAt = Date.now();
    if (this.#working) { this.#again = true; return 0; }
    this.#working = true;
    let done = 0;
    try {
      do {
        this.#again = false;
        const items = await this.bridge.context.work.claim({ limit: 10, leaseMs: 60_000 });
        for (const item of items) {
          done++;
          const w = { kind: item.kind, ...(item.input as unknown as WorkInput), resumed: item.resumed };
          let outcome: ComponentWorkOutcome;
          try {
            outcome = await this.#perform(w);
          } catch (e: any) {
            const permanent = isFeltKitError(e) && ["FORBIDDEN", "NOT_FOUND", "INVALID_ARGUMENT", "FAILED_PRECONDITION"].includes(e.code);
            const error = { ...(isFeltKitError(e) ? { code: e.code } : {}), message: String(e?.message ?? e).slice(0, 300) };
            outcome = permanent ? { outcome: "failed", error } : { outcome: "retry", error };
          }
          // Refused (CONFLICT) when the lease expired and another performer took the item over: theirs to settle.
          await this.bridge.context.work.finish(item, outcome).catch((e) => this.log(`work ${item.id} not settled: ${e?.message ?? e}`));
        }
        if (items.length === 10) this.#again = true;
      } while (this.#again);
    } finally {
      this.#working = false;
    }
    return done;
  }

  /** Perform one item; the outcome is its receipt (done), or why not (retry, failed). */
  async #perform(w: WorkInput & { kind: string; resumed?: boolean }): Promise<ComponentWorkOutcome> {
    switch (w.kind) {
      case "sms.send": {
        const r = await this.sendNow(w.businessId, w.refId, { resumed: Boolean(w.resumed) });
        if (r.status === "queued") return { outcome: "retry", error: { message: String(r.error ?? "provider unreachable") } };
        // An earlier attempt may have reached the provider: never sent again by itself; a person decides.
        if (r.status === "unknown") return { outcome: "unknown", error: { code: "SEND_OUTCOME_UNKNOWN", message: "The text may have been sent before the runtime stopped." }, receipt: { messageId: w.refId, status: r.status } };
        return { outcome: "done", receipt: { messageId: w.refId, status: r.status } };
      }
      case "call.dial": await this.dialNow(w.businessId, w.refId, { resumed: Boolean(w.resumed) }); return { outcome: "done", receipt: { callId: w.refId } };
      case "agent.sms": await this.#agentSms(w.businessId, w.refId); return { outcome: "done", receipt: { messageId: w.refId } };
      case "call.summarize": await this.#summarize(w.businessId, w.refId); return { outcome: "done", receipt: { callId: w.refId } };
    }
    return { outcome: "failed", error: { code: "UNKNOWN_KIND", message: `Unknown work ${w.kind}` } };
  }

  /**
   * Hand a queued text to its provider, once. The result is the provider's answer, which is what an agent
   * may tell a person: accepted (with the provider's id), refused, or unknown.
   */
  async sendNow(businessId: string, messageId: string, opts: { resumed?: boolean } = {}): Promise<{ ok: boolean; status: string; error?: string; messageId: string }> {
    const claim = await this.bridge.call("gateway:sendClaim", { messageId, ...(opts.resumed ? { resumed: true } : {}) }, businessId);
    if (!claim.send) return { ok: ["sent", "delivered"].includes(claim.status), status: claim.status, messageId, ...(claim.status === "blocked" ? { error: "blocked by policy" } : {}) };
    const provider = this.#provider(claim.provider);
    if (!provider) {
      await this.bridge.call("gateway:sendResult", { messageId, outcome: "refused", error: `${claim.provider} is not configured or not enabled.` }, businessId);
      return { ok: false, status: "failed", error: `${claim.provider} is not configured`, messageId };
    }
    const r = await provider.sendSms({ from: claim.from, to: claim.to, body: claim.body, statusCallbackUrl: `${this.#base(claim.provider)}/${claim.provider}/sms-status?b=${encodeURIComponent(businessId)}` });
    const res = await this.bridge.call("gateway:sendResult", { messageId, outcome: r.outcome, ...(r.sid ? { providerSid: r.sid } : {}), ...(r.error ? { error: r.error } : {}), ...(r.retryable ? { retryable: true } : {}) }, businessId);
    return { ok: r.outcome === "accepted", status: res.status, messageId, ...(r.error ? { error: r.error } : {}) };
  }

  async dialNow(businessId: string, callId: string, opts: { resumed?: boolean } = {}) {
    const token = this.#token(`call:${callId}`);
    const claim = await this.bridge.call("gateway:dialClaim", { callId, sessionTokenHash: hashToken(token), ...(opts.resumed ? { resumed: true } : {}) }, businessId);
    if (!claim.dial) return;
    const provider = this.#provider(claim.provider);
    if (!provider) return this.bridge.call("gateway:dialResult", { callId, outcome: "refused", error: `${claim.provider} is not configured or not enabled.` }, businessId);
    const base = this.#base(claim.provider);
    const q = `callId=${encodeURIComponent(callId)}&b=${encodeURIComponent(businessId)}`;
    const r = await provider.dial({ from: claim.from, to: claim.to, answerUrl: `${base}/${claim.provider}/voice?${q}`, statusCallbackUrl: `${base}/${claim.provider}/call-status?${q}` });
    if (r.outcome === "accepted" && claim.provider === "simulator") this.#simCalls.set(r.sid!, { sid: r.sid!, callId, businessId, startedAt: Date.now() });
    await this.bridge.call("gateway:dialResult", { callId, outcome: r.outcome, ...(r.sid ? { providerSid: r.sid } : {}), ...(r.error ? { error: r.error } : {}) }, businessId);
  }

  /** The SMS agent answers an inbound text, through the same policy path as any text, then sends it. */
  async #agentSms(businessId: string, messageId: string) {
    const c = await this.bridge.call("gateway:smsAgentContext", { messageId }, businessId);
    if (c.skip) return;
    const ctx = await this.bridge.call("gateway:context", { agentId: c.agentId, conversationId: c.conversationId }, businessId);
    const inbound = [...ctx.texts].reverse().find((t: any) => t.direction === "inbound");
    ctx.texts = ctx.texts.filter((t: any) => t !== inbound);
    const brain = await this.brainFor(ctx, "sms", businessId);
    let reply = "";
    let calls = 0;
    await brain.turn({
      userText: inbound?.body ?? "",
      emit: (t) => (reply += t),
      signal: new AbortController().signal,
      runTool: async (name, args) => {
        const { TOOLS } = await import("./brain/types.js");
        const spec = TOOLS[name];
        const acting = { agentId: c.agentId, conversationId: c.conversationId, toolCallId: `sms:${messageId}:${++calls}` };
        try {
          const result = await this.bridge.call(spec.fn, { ...args, ...acting }, businessId);
          return name === "sms_send" && result.ok ? this.sendNow(businessId, result.messageId) : result;
        } catch (e: any) {
          const reason = String(e?.message ?? e).slice(0, 300);
          if (isFeltKitError(e) && ["FORBIDDEN", "NOT_FOUND"].includes(e.code)) await this.bridge.call("gateway:toolDenied", { ...acting, capability: spec.capability, reason, args }, businessId).catch(() => {});
          return { ok: false, error: reason };
        }
      },
    });
    const body = reply.trim();
    if (!body) return;
    const queued = await this.bridge.call("gateway:agentReply", { messageId, agentId: c.agentId, body: body.slice(0, 1400) }, businessId);
    if (queued.status === "queued") await this.sendNow(businessId, queued.messageId);
  }

  /** A call summary from its record: what was said and what was done. Deterministic: it cannot invent an outcome. */
  async #summarize(businessId: string, callId: string) {
    const c = await this.bridge.call("gateway:summaryContext", { callId }, businessId);
    if (!c || c.call.summary) return;
    const asked = c.turns.filter((t: any) => t.speaker === "caller").map((t: any) => t.text).slice(0, 3);
    const done = c.actions.filter((a: any) => a.status === "succeeded" && !["contacts.lookup", "business.info", "appointments.availability", "conversations.history"].includes(a.capability)).map((a: any) => describeAction(a));
    const failed = c.actions.filter((a: any) => a.status !== "succeeded").map((a: any) => `${a.capability} ${a.status}${a.error ? ` (${a.error})` : ""}`);
    const summary = [
      asked.length ? `Caller said: ${asked.map((a: string) => `"${a.slice(0, 120)}"`).join("; ")}.` : "The caller said nothing that was recognised.",
      done.length ? `Done: ${done.join("; ")}.` : "No actions were taken.",
      failed.length ? `Not done: ${failed.join("; ")}.` : "",
      c.call.outcome ? `Outcome: ${c.call.outcome.replace("_", " ")}.` : "",
    ].filter(Boolean).join(" ");
    await this.bridge.call("gateway:recordSummary", { callId, summary: summary.slice(0, 2000) }, businessId);
    await this.bridge.call("gateway:purge", {}, businessId).catch(() => {});
  }

  // ── Media sessions ──────────────────────────────────────────────────────────

  sessionGone(s: VoiceSession) {
    if (this.sessions.get(s.callId) === s) this.sessions.delete(s.callId);
  }

  /** A WebSocket upgrade on one of the component's routes (the media sessions). */
  upgrade(req: IncomingMessage, socket: import("node:net").Socket, head: Buffer) {
    const url = new URL(req.url ?? "/", "http://local");
    const provider: ProviderId | null = url.pathname === "/twilio/relay" ? "twilio" : url.pathname === "/simulator/relay" ? "simulator" : null;
    const callId = url.searchParams.get("callId"), b = url.searchParams.get("b"), t = url.searchParams.get("t");
    const refuse = (code: number, why: string) => { this.noteRefusal(provider ?? "simulator", `WebSocket refused: ${why}`); socket.end(`HTTP/1.1 ${code} ${why}\r\n\r\n`); };
    if (!provider || !callId || !b || !t) return refuse(404, "Not Found");
    if (provider === "simulator" && (!this.simulatorEnabled || !isLoopback(req))) return refuse(403, "Forbidden");
    if (provider === "twilio") {
      if (!this.settings.authToken || !this.settings.publicBaseUrl) return refuse(503, "Service Unavailable");
      const wsUrl = `${this.settings.publicBaseUrl.replace(/^http/, "ws")}${req.url}`;
      if (!verifyTwilio(this.settings.authToken, header(req, "x-twilio-signature"), [wsUrl, wsUrl.replace(/\?/, "/?"), `${wsUrl}/`], {})) return refuse(403, "Forbidden");
    }
    this.#wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      // The token is checked against the call record (gateway:sessionOpened) on setup; until then nothing is spoken.
      const previous = this.sessions.get(callId);
      const session = new VoiceSession(this, ws, callId, b, t, provider);
      this.sessions.set(callId, session);
      if (previous) this.log(`call ${callId} reconnected its media session`);
    });
  }

  // ── Simulator ───────────────────────────────────────────────────────────────

  async #simSmsStatus(sid: string, status: string, errorCode?: string) {
    // The simulator reports like Twilio does; the message's business is found by its receipt.
    for (const [, texts] of this.simulator.texts) {
      const t = texts.find((x) => x.sid === sid);
      if (t) { await this.smsStatus({ provider: "simulator", sid, status, ...(errorCode ? { errorCode } : {}) }, null, t.from).catch((e) => this.log(String(e.message))); return; }
    }
  }

  async #simDialStatus(ring: SimRinging, status: string) {
    const u = new URL(ring.statusCallbackUrl);
    await this.callStatus({ provider: "simulator", sid: ring.sid, status, callId: u.searchParams.get("callId") ?? undefined, businessId: u.searchParams.get("b") ?? undefined }).catch((e) => this.log(String(e.message)));
  }

  async simulatorSessionEnded(callId: string, businessId: string, reason: string) {
    const sim = [...this.#simCalls.values()].find((c) => c.callId === callId);
    if (reason === "transfer") {
      const plan = await this.connectAction(callId, businessId, { reason }, "ended");
      if (plan?.kind === "forward") await this.bridge.call("gateway:transferResult", { callId, status: "completed" }, businessId).catch(() => {});
    }
    if (sim) await this.#simEnd(sim, "completed");
  }

  async simulatorHangup(callId: string, businessId: string) {
    const sim = [...this.#simCalls.values()].find((c) => c.callId === callId && c.businessId === businessId);
    if (sim) await this.#simEnd(sim, "completed");
  }

  async #simEnd(sim: { sid: string; callId: string; businessId: string; answeredAt?: number; startedAt: number }, status: string) {
    if (!this.#simCalls.delete(sim.sid)) return;
    const duration = sim.answeredAt ? Math.round((Date.now() - sim.answeredAt) / 1000) : 0;
    await this.callStatus({ provider: "simulator", sid: sim.sid, status, duration, callId: sim.callId, businessId: sim.businessId });
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────

  /** An HTTP request on one of the component's routes (/twilio/*, /simulator/*). */
  async request(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname;
    try {
      if (path === "/health") return json(res, 200, { ok: true, provider: this.settings.provider, ready: this.problems.length === 0, problems: this.problems });
      if (path.startsWith("/twilio/")) return await this.#twilioRoute(req, res, url);
      if (path.startsWith("/simulator/")) return await this.#simulatorRoute(req, res, url);
      json(res, 404, { error: "Not found" });
    } catch (e: any) {
      this.log(`${req.method} ${path} failed: ${e?.message ?? e}`);
      if (!res.headersSent) json(res, isFeltKitError(e) && e.code === "INVALID_ARGUMENT" ? 400 : 500, { error: isFeltKitError(e) ? e.message : "Internal error" });
    }
  }

  /** Twilio webhooks: verify the signature first; nothing unverified reaches the application. */
  async #twilioRoute(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    if (this.settings.provider !== "twilio" || !this.settings.authToken || !this.settings.publicBaseUrl) return xml(res, 503, EMPTY_TWIML);
    const raw = await readBody(req, 64 * 1024);
    const params = Object.fromEntries(new URLSearchParams(raw));
    const signedUrl = `${this.settings.publicBaseUrl}${req.url}`;
    if (!verifyTwilio(this.settings.authToken, header(req, "x-twilio-signature"), [signedUrl], params)) {
      this.signatureFailures++;
      this.log(`rejected unsigned or forged request to ${url.pathname}`);
      return xml(res, 403, EMPTY_TWIML);
    }
    if (this.settings.accountSid && params.AccountSid && params.AccountSid !== this.settings.accountSid) return xml(res, 403, EMPTY_TWIML);
    this.lastWebhookAt = Date.now();
    const b = url.searchParams.get("b");
    const callId = url.searchParams.get("callId");
    switch (url.pathname) {
      case "/twilio/sms": {
        const media = Array.from({ length: Math.min(Number(params.NumMedia ?? 0), 10) }, (_, i) => ({ url: params[`MediaUrl${i}`] ?? "", contentType: params[`MediaContentType${i}`] ?? "" })).filter((m) => m.url);
        await this.inboundSms({ provider: "twilio", sid: params.MessageSid ?? params.SmsSid ?? "", from: params.From ?? "", to: params.To ?? "", body: params.Body ?? "", media });
        // STOP/HELP replies are Twilio's (Advanced Opt-Out); the application records the consent change.
        return xml(res, 200, EMPTY_TWIML);
      }
      case "/twilio/sms-status":
        await this.smsStatus({ provider: "twilio", sid: params.MessageSid ?? params.SmsSid ?? "", status: params.MessageStatus ?? params.SmsStatus ?? "", ...(params.ErrorCode ? { errorCode: params.ErrorCode } : {}) }, b, params.From);
        return xml(res, 200, EMPTY_TWIML);
      case "/twilio/voice": {
        if (callId && b) return xml(res, 200, answerTwiml(await this.answerOutbound("twilio", callId, b)));
        return xml(res, 200, answerTwiml(await this.inboundCall({ provider: "twilio", sid: params.CallSid ?? "", from: params.From ?? "", to: params.To ?? "" })));
      }
      case "/twilio/call-status": {
        const business = b ?? (await this.#route(params.To ?? ""))?.businessId ?? (await this.#route(params.From ?? ""))?.businessId ?? null;
        const duration = params.CallDuration ? Number(params.CallDuration) : undefined;
        await this.callStatus({ provider: "twilio", sid: params.CallSid ?? "", status: params.CallStatus ?? "", ...(callId ? { callId } : {}), ...(business ? { businessId: business } : {}), ...(duration !== undefined && Number.isFinite(duration) ? { duration } : {}) });
        return xml(res, 200, EMPTY_TWIML);
      }
      case "/twilio/connect-action": {
        if (!callId || !b) return xml(res, 200, HANGUP_TWIML);
        let handoff: any = null;
        try { handoff = params.HandoffData ? JSON.parse(params.HandoffData) : null; } catch { /* not ours */ }
        const plan = await this.connectAction(callId, b, handoff, params.SessionStatus);
        return xml(res, 200, plan ? answerTwiml(plan) : HANGUP_TWIML);
      }
    }
    return xml(res, 404, EMPTY_TWIML);
  }

  /**
   * The simulator: a phone in the browser. Development only (or SIMULATOR_ENABLED=1), loopback only.
   * It drives the same handlers as Twilio's webhooks, as a simulated contact's phone.
   */
  async #simulatorRoute(req: IncomingMessage, res: ServerResponse, url: URL) {
    const origin = header(req, "origin");
    if (origin && this.#allowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    if (!this.simulatorEnabled || !isLoopback(req)) return json(res, 403, { error: "The simulator is available only in development, on this machine." });
    this.#simulatorBase = `http://${header(req, "host")}`;
    if (origin && !this.#allowedOrigin(origin)) return json(res, 403, { error: "Origin not allowed." });
    if (req.method === "GET" && url.pathname === "/simulator/phone") {
      const number = url.searchParams.get("number") ?? "";
      return json(res, 200, { texts: this.simulator.texts.get(number) ?? [], ringing: [...this.simulator.ringing.values()].filter((r) => r.to === number).map((r) => ({ sid: r.sid, from: r.from, at: r.at })) });
    }
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    const body = JSON.parse((await readBody(req, 16 * 1024)) || "{}");
    const str = (k: string) => (typeof body[k] === "string" ? body[k] as string : "");
    switch (url.pathname) {
      case "/simulator/sms": {
        const out = await this.inboundSms({ provider: "simulator", sid: `SMsim${randomUUID().replace(/-/g, "").slice(0, 26)}`, from: str("from"), to: str("to"), body: str("body").slice(0, 1600), media: [] });
        return json(res, out.routed ? 200 : 404, out.routed ? out : { error: `No business has the number ${str("to")}.` });
      }
      case "/simulator/call": {
        const sid = `CAsim${randomUUID().replace(/-/g, "").slice(0, 26)}`;
        const plan = await this.inboundCall({ provider: "simulator", sid, from: str("from"), to: str("to") });
        if (plan.kind === "reject") return json(res, 404, { error: `No business has the number ${str("to")}.` });
        if (plan.callId) this.#simCalls.set(sid, { sid, callId: plan.callId, businessId: plan.businessId!, startedAt: Date.now(), ...(plan.kind === "relay" ? { answeredAt: Date.now() } : {}) });
        // Forwarded or unavailable: the simulated call ends at once (a real one would ring the forward number).
        if (plan.kind !== "relay") setTimeout(() => { const s = this.#simCalls.get(sid); if (s) void this.#simEnd(s, plan.kind === "forward" ? "completed" : "completed"); }, 300);
        return json(res, 200, { sid, ...plan });
      }
      case "/simulator/answer": {
        const ring = this.simulator.ringing.get(str("sid"));
        if (!ring) return json(res, 404, { error: "Not ringing." });
        this.simulator.ringing.delete(ring.sid);
        const u = new URL(ring.answerUrl);
        const callId = u.searchParams.get("callId")!, b = u.searchParams.get("b")!;
        const sim = this.#simCalls.get(ring.sid);
        if (sim) sim.answeredAt = Date.now();
        await this.callStatus({ provider: "simulator", sid: ring.sid, status: "in-progress", callId, businessId: b });
        return json(res, 200, { sid: ring.sid, ...(await this.answerOutbound("simulator", callId, b)) });
      }
      case "/simulator/decline": {
        const ring = this.simulator.ringing.get(str("sid"));
        if (!ring) return json(res, 404, { error: "Not ringing." });
        this.simulator.ringing.delete(ring.sid);
        const sim = this.#simCalls.get(ring.sid);
        if (sim) await this.#simEnd(sim, "busy");
        return json(res, 200, { ok: true });
      }
      case "/simulator/hangup": {
        const sim = this.#simCalls.get(str("sid"));
        if (sim) await this.#simEnd(sim, "completed");
        return json(res, 200, { ok: true });
      }
    }
    return json(res, 404, { error: "Not found" });
  }

  #allowedOrigin(origin: string) {
    try {
      const o = new URL(origin);
      return ["localhost", "127.0.0.1"].includes(o.hostname);
    } catch { return false; }
  }
}

function describeAction(a: { capability: string; result: any }): string {
  const r = a.result ?? {};
  switch (a.capability) {
    case "appointments.book": return `booked ${r.when ?? r.slot}`;
    case "sms.send": return r.status === "delivered" || r.status === "sent" ? `texted the caller (${r.status})` : `tried to text the caller (${r.status ?? "unknown"})`;
    case "followups.create": return "left a follow-up for staff";
    case "calls.transfer": return `transferred to ${r.to}`;
    default: return a.capability;
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? "";
  const host = (header(req, "host") ?? "").replace(/:\d+$/, "");
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(a) && ["localhost", "127.0.0.1", "[::1]"].includes(host);
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw Object.assign(new Error("Request too large"), { code: "INVALID_ARGUMENT" });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const json = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
const xml = (res: ServerResponse, status: number, body: string) => void res.writeHead(status, { "content-type": "text/xml" }).end(body);
