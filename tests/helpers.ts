/**
 * Test harness: the application in FeltKit's test runtime (a real, isolated FeltDB), the voice runtime
 * on a real port in the same process, and a simulated phone that speaks ConversationRelay over a real
 * WebSocket. Nothing is mocked between the phone and the database.
 */
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import WebSocket from "ws";
import { api } from "../feltkit/_generated/api.js";
import { VoiceRuntime, type VoiceRuntimeOptions } from "../gateway/runtime.js";

export const ADA = { id: "ada", type: "user" as const, displayName: "Ada Lovelace", roles: ["person", "operator"] };
export const GRACE = { id: "grace", type: "user" as const, displayName: "Grace Hopper", roles: ["person"] };
export const ALAN = { id: "alan", type: "user" as const, displayName: "Alan Turing", roles: ["person"] };
export const MALLORY = { id: "mallory", type: "user" as const, displayName: "Mallory", roles: ["person"] };
export const VOICE = { id: "voice-runtime", type: "agent" as const, displayName: "Voice runtime", roles: ["voice"] };

export const NUMBER = "+15551230001";
export const OTHER_NUMBER = "+15559870001";
export const CALLER = "+15557770123";

export async function actor(t: TestApp, businessId: string, p: { id: string; displayName?: string }) {
  const ctx = await t.tenancy!.context(businessId, p.id);
  if (!ctx) throw new Error(`${p.id} is not a member of ${businessId}`);
  return { ...ctx, principalId: p.id, ...(p.displayName ? { displayName: p.displayName } : {}) };
}

export async function join(t: TestApp, businessId: string, by: typeof ADA, who: typeof GRACE, role: string) {
  const { token } = await t.tenancy!.invite(await actor(t, businessId, by), { email: `${who.id}@example.com`, role });
  await t.tenancy!.accept(token, who, { allowAnyAddress: true });
  return t.as(who, { tenant: businessId });
}

/** A business set up the way the UI does it: business:ensure, hours every day, a number answered by Front desk, the runtime connected. */
export async function business(t: TestApp, name: string, owner: typeof ADA, number: string, opts: { connect?: boolean } = {}) {
  const id = (await t.tenancy!.create(name, owner)).id;
  const me = t.as(owner, { tenant: id });
  await me.mutation(api.business.ensure, { timezone: "America/New_York" });
  const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
  await me.mutation(api.business.update, {
    hours: days.map((day) => ({ day, open: "00:00", close: "24:00" })),
    escalation: [{ id: "frontdesk", name: "Reception", phone: "+15550000001" }],
    about: `${name} is a dental practice at 1 Main St.`,
    policy: { quietStart: "00:00", quietEnd: "00:00" },
  });
  const [agent] = await me.query(api.agents.list, {});
  const numberId = await me.mutation(api.numbers.add, { e164: number, label: "Main", provider: "simulator", sms: true, voice: true, agentId: agent!.id });
  if (opts.connect !== false) {
    await t.tenancy!.addPrincipal(await actor(t, id, owner), VOICE, "agent");
    await me.mutation(api.agents.connect, {});
  }
  return { id, me, agentId: agent!.id as string, numberId };
}

export async function setup(options: Partial<VoiceRuntimeOptions> = {}) {
  const t = await createTestApp();
  const acme = await business(t, "Acme Dental", ADA, NUMBER);
  const grace = await join(t, acme.id, ADA, GRACE, "staff");
  const evil = await business(t, "Evil Corp", MALLORY, OTHER_NUMBER);
  const logs: string[] = [];
  const rt = await new VoiceRuntime({ runtime: t.runtime as any, port: 0, workIntervalMs: 0, log: (l) => logs.push(l), ...options }).start();
  return { t, acme, ada: acme.me, grace, evil, mallory: evil.me, rt, logs, close: async () => { await rt.close(); await t.close(); } };
}

/** Configure Twilio the supported way: Configuration variables (as `feltkit config import`) and the auth token credential (as `feltkit credential set`). */
export async function configureTwilio(t: TestApp, vars: { accountSid: string; authToken: string; publicBaseUrl: string }) {
  const runtime: any = t.runtime;
  const doc = await runtime.services.exportConfiguration();
  doc.variables = [
    { name: "TELEPHONY_PROVIDER", value: "twilio" },
    { name: "TWILIO_ACCOUNT_SID", value: vars.accountSid },
    { name: "PUBLIC_BASE_URL", value: vars.publicBaseUrl },
  ];
  await runtime.services.importConfiguration(doc, { overwrite: true });
  await runtime.credentials.store({ reference: { secretId: "twilio-auth-token" }, value: vars.authToken });
}

export async function post(rt: VoiceRuntime, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${rt.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** A simulated phone on a live call: ConversationRelay over a real WebSocket. */
export class Phone {
  readonly ws: WebSocket;
  readonly heard: string[] = [];
  #current = "";
  ended: any = null;
  closed = false;
  #waiters: Array<() => void> = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "text") {
        this.#current += m.token;
        if (m.last) { this.heard.push(this.#current.trim()); this.#current = ""; }
      }
      if (m.type === "end") this.ended = JSON.parse(m.handoffData ?? "{}");
      this.#waiters.splice(0).forEach((w) => w());
    });
    this.ws.on("close", () => { this.closed = true; this.#waiters.splice(0).forEach((w) => w()); });
  }
  open() { return new Promise<void>((r, j) => { this.ws.once("open", () => r()); this.ws.once("error", j); }); }
  setup(callSid?: string) { this.ws.send(JSON.stringify({ type: "setup", ...(callSid ? { callSid } : {}) })); }
  say(text: string) { this.ws.send(JSON.stringify({ type: "prompt", voicePrompt: text, lang: "en-US", last: true })); }
  partial(text: string) { this.ws.send(JSON.stringify({ type: "prompt", voicePrompt: text, last: false })); }
  /** Speak over the agent: like Twilio, the phone drops whatever of the answer it has not played. */
  interrupt(heard: string) { this.#current = ""; this.ws.send(JSON.stringify({ type: "interrupt", utteranceUntilInterrupt: heard, durationUntilInterruptMs: 500 })); }
  /** Wait until the agent has finished n utterances in total (or the session ends). */
  async utterances(n: number, ms = 5000): Promise<string[]> {
    const until = Date.now() + ms;
    while (this.heard.length < n && !this.ended && !this.closed) {
      if (Date.now() > until) throw new Error(`Heard ${this.heard.length}/${n}: ${JSON.stringify(this.heard)}`);
      await new Promise<void>((r) => { this.#waiters.push(r); setTimeout(r, 100); });
    }
    return this.heard;
  }
  /** Say something and return the agent's answer. */
  async ask(text: string, ms = 5000): Promise<string> {
    const n = this.heard.length;
    this.say(text);
    await this.utterances(n + 1, ms);
    return this.heard[n] ?? "";
  }
  hangup() { this.ws.close(); }
}

export async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`Timed out; last value: ${JSON.stringify(v).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function rejects(p: Promise<unknown>, code: string | string[]) {
  const codes = Array.isArray(code) ? code : [code];
  try { await p; } catch (e: any) {
    if (!codes.includes(e?.code)) throw new Error(`expected ${codes.join("|")}, got ${e?.code}: ${e?.message}`);
    return e;
  }
  throw new Error(`expected ${codes.join("|")}, but it succeeded`);
}

/** Start an inbound call from the simulator and connect its media session. */
export async function call(rt: VoiceRuntime, from = CALLER, to = NUMBER) {
  const r = await post(rt, "/simulator/call", { from, to });
  if (r.status !== 200) throw new Error(`call failed: ${JSON.stringify(r.body)}`);
  if (r.body.kind !== "relay") return { plan: r.body, phone: null as Phone | null };
  const phone = new Phone(r.body.relayUrl);
  await phone.open();
  phone.setup(r.body.sid);
  return { plan: r.body, phone };
}
