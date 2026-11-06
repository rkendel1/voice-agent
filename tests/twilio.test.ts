/**
 * The Twilio adapter against a local stand-in for Twilio's REST API, with webhooks signed exactly as
 * Twilio signs them. Configured the supported way (Configuration variables + the auth token credential).
 * What this cannot prove: that Twilio's live service behaves as documented. See docs/ACCEPTANCE.md.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { test } from "node:test";
import WebSocket from "ws";
import { api } from "../feltkit/_generated/api.js";
import { twilioSignature } from "../gateway/providers/twilio.js";
import { CALLER, NUMBER, configureTwilio, setup, until } from "./helpers.js";

const SID = "AC00000000000000000000000000000001";
const TOKEN = "test-twilio-auth-token-0123456789abcdef";
const PUBLIC = "https://voice.example.com";

async function fakeTwilio(answer: (path: string, form: URLSearchParams, req: IncomingMessage) => { status: number; body: unknown } | "drop") {
  const requests: Array<{ path: string; form: URLSearchParams; auth: string }> = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const form = new URLSearchParams(raw);
    requests.push({ path: req.url!, form, auth: String(req.headers.authorization) });
    const a = answer(req.url!, form, req);
    if (a === "drop") return req.socket.destroy();
    res.writeHead(a.status, { "content-type": "application/json" }).end(JSON.stringify(a.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, requests, close: () => new Promise((r) => server.close(r)) };
}

async function twilioSetup(answer: Parameters<typeof fakeTwilio>[0] = () => ({ status: 201, body: { sid: `SM${Math.random().toString(16).slice(2).padEnd(32, "0")}`, status: "queued" } })) {
  const api_ = await fakeTwilio(answer);
  const s = await setup({ twilioApiBase: api_.url });
  await configureTwilio(s.t, { accountSid: SID, authToken: TOKEN, publicBaseUrl: PUBLIC });
  // The number is a Twilio number now.
  const [n] = await s.ada.query(api.numbers.list, {});
  await s.ada.mutation(api.numbers.release, { id: n!.id });
  const [agent] = await s.ada.query(api.agents.list, {});
  await s.ada.mutation(api.numbers.add, { e164: NUMBER, label: "Twilio", provider: "twilio", sms: true, voice: true, agentId: agent!.id });
  await s.rt.refresh();
  /** POST a webhook as Twilio would: form-encoded, signed over PUBLIC + path + sorted params. */
  const hook = async (path: string, params: Record<string, string>, opts: { sign?: "valid" | "none" | "forged" } = {}) => {
    const all = { AccountSid: SID, ...params };
    const sig = opts.sign === "none" ? undefined : opts.sign === "forged" ? twilioSignature("wrong-token", PUBLIC + path, all) : twilioSignature(TOKEN, PUBLIC + path, all);
    const res = await fetch(`${s.rt.url}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(sig ? { "x-twilio-signature": sig } : {}) }, body: new URLSearchParams(all) });
    return { status: res.status, text: await res.text() };
  };
  return { ...s, twilio: api_, hook, close: async () => { await s.close(); await api_.close(); } };
}

test("Twilio webhooks: unsigned and forged requests are refused and counted; a valid one is processed once, replays change nothing", async () => {
  const s = await twilioSetup();
  try {
    assert.equal(s.rt.problems.length, 0, s.rt.problems.join(" "));
    const params = { MessageSid: "SM11111111111111111111111111111111", From: CALLER, To: NUMBER, Body: "Hello from Twilio", NumMedia: "0" };
    assert.equal((await s.hook("/twilio/sms", params, { sign: "none" })).status, 403);
    assert.equal((await s.hook("/twilio/sms", params, { sign: "forged" })).status, 403);
    assert.equal(s.rt.signatureFailures, 2);
    assert.equal((await s.ada.query(api.conversations.list, {})).length, 0, "nothing unverified reaches the application");
    const ok = await s.hook("/twilio/sms", params);
    assert.equal(ok.status, 200);
    assert.match(ok.text, /<Response\/>/);
    await s.hook("/twilio/sms", params); // Twilio retry / replay
    await s.hook("/twilio/sms", params);
    const [conv] = await s.ada.query(api.conversations.list, {});
    const { items } = await s.ada.query(api.conversations.timeline, { conversationId: conv!.id });
    assert.equal(items.filter((i: any) => i.type === "sms" && i.direction === "inbound").length, 1);
    // A request signed for another account's id is refused.
    assert.equal((await s.hook("/twilio/sms", { ...params, AccountSid: "AC999" })).status, 403);
  } finally { await s.close(); }
});

test("Twilio outbound SMS: form-encoded, basic auth, status callback; receipts and delivery reports", async () => {
  const s = await twilioSetup();
  try {
    await s.hook("/twilio/sms", { MessageSid: "SM22222222222222222222222222222222", From: CALLER, To: NUMBER, Body: "hours?", NumMedia: "0" });
    await s.rt.work();
    const req = s.twilio.requests.find((r) => r.path.endsWith("/Messages.json"))!;
    assert.equal(req.path, `/2010-04-01/Accounts/${SID}/Messages.json`);
    assert.equal(req.auth, `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`);
    assert.equal(req.form.get("To"), CALLER);
    assert.equal(req.form.get("From"), NUMBER);
    assert.match(req.form.get("StatusCallback")!, /^https:\/\/voice\.example\.com\/twilio\/sms-status\?b=/);
    const [conv] = await s.ada.query(api.conversations.list, {});
    let out = (await s.ada.query(api.conversations.timeline, { conversationId: conv!.id })).items.find((i: any) => i.direction === "outbound") as any;
    assert.equal(out.status, "sent");
    // Delivery reports, out of order: delivered first, then a late "sent". It stays delivered.
    const cb = new URL(req.form.get("StatusCallback")!);
    await s.hook(`${cb.pathname}${cb.search}`, { MessageSid: out.providerSid, MessageStatus: "delivered", From: NUMBER, To: CALLER });
    await s.hook(`${cb.pathname}${cb.search}`, { MessageSid: out.providerSid, MessageStatus: "sent", From: NUMBER, To: CALLER });
    out = (await s.ada.query(api.conversations.timeline, { conversationId: conv!.id })).items.find((i: any) => i.id === out.id);
    assert.equal(out.status, "delivered");
  } finally { await s.close(); }
});

test("Twilio send failures: refused → failed; 5xx or dropped connection → unknown and never resent automatically", async () => {
  let mode: "refuse" | "error" | "drop" = "refuse";
  const s = await twilioSetup(() => (mode === "refuse" ? { status: 400, body: { code: 21610, message: "Attempt to send to unsubscribed recipient" } } : mode === "error" ? { status: 503, body: { message: "busy" } } : "drop"));
  try {
    const contactId = await s.ada.mutation(api.contacts.save, { phone: CALLER, name: "Pat" });
    const [conv] = await s.ada.query(api.conversations.list, {});
    void contactId;
    const send = async (key: string) => { const r = await s.ada.mutation(api.conversations.reply, { conversationId: conv!.id, body: key, idempotencyKey: key }); await s.rt.work(); return r.messageId; };
    const status = async (id: string) => ((await s.ada.query(api.conversations.timeline, { conversationId: conv!.id })).items.find((i: any) => i.id === id) as any);
    const refused = await send("refused-01");
    assert.equal((await status(refused)).status, "failed");
    assert.match((await status(refused)).error, /21610/);
    mode = "error";
    const unknown = await send("unknown-01");
    assert.equal((await status(unknown)).status, "unknown");
    const before = s.twilio.requests.length;
    await s.rt.work();
    assert.equal(s.twilio.requests.length, before, "an unknown outcome is never retried automatically");
    mode = "drop";
    const dropped = await send("dropped-01");
    assert.equal((await status(dropped)).status, "unknown", "a connection dropped after sending may have reached Twilio");
  } finally { await s.close(); }
});

test("Twilio voice: TwiML connects ConversationRelay with a bound token; the handshake must be signed; transfer becomes <Dial>", async () => {
  const s = await twilioSetup();
  try {
    const res = await s.hook("/twilio/voice", { CallSid: "CA33333333333333333333333333333333", From: CALLER, To: NUMBER, Direction: "inbound" });
    assert.equal(res.status, 200);
    const relay = res.text.match(/<ConversationRelay url="([^"]+)"/)![1]!.replace(/&amp;/g, "&");
    assert.match(relay, /^wss:\/\/voice\.example\.com\/twilio\/relay\?callId=.+&b=.+&t=.+/);
    assert.match(res.text, /<Connect action="https:\/\/voice\.example\.com\/twilio\/connect-action\?/);
    assert.match(res.text, /ttsProvider="ElevenLabs"/);
    // Twilio's retry of the same webhook gets the same answer (same call, same token).
    assert.equal((await s.hook("/twilio/voice", { CallSid: "CA33333333333333333333333333333333", From: CALLER, To: NUMBER, Direction: "inbound" })).text, res.text);
    const local = relay.replace("wss://voice.example.com", s.rt.url.replace("http", "ws"));
    // Unsigned handshake: refused.
    await assert.rejects(new Promise((ok, fail) => { const w = new WebSocket(local); w.on("open", ok); w.on("error", fail); }));
    // Signed as Twilio signs the handshake (URL, no parameters).
    const signed = new WebSocket(local, { headers: { "x-twilio-signature": twilioSignature(TOKEN, relay, {}) } });
    const heard: string[] = [];
    signed.on("message", (m) => { const x = JSON.parse(String(m)); if (x.type === "text" && x.last) heard.push(x.token); if (x.type === "end") heard.push(`END ${x.handoffData}`); });
    await new Promise((r) => signed.on("open", r));
    signed.send(JSON.stringify({ type: "setup", callSid: "CA33333333333333333333333333333333" }));
    await until(async () => heard.length, (n) => n >= 2);
    signed.send(JSON.stringify({ type: "prompt", voicePrompt: "I need to talk to a person", last: true }));
    await until(async () => heard.join(" "), (h) => h.includes("END"));
    const callId = new URL(local).searchParams.get("callId")!;
    const b = new URL(local).searchParams.get("b")!;
    const action = await s.hook(`/twilio/connect-action?callId=${callId}&b=${b}`, { CallSid: "CA33333333333333333333333333333333", SessionStatus: "ended", HandoffData: JSON.stringify({ reason: "transfer", callId }) });
    assert.match(action.text, /<Dial callerId="[^"]*">\+15550000001<\/Dial>|<Dial>\+15550000001<\/Dial>/);
    await s.hook(`/twilio/call-status`, { CallSid: "CA33333333333333333333333333333333", CallStatus: "completed", CallDuration: "42", From: CALLER, To: NUMBER });
    await s.hook(`/twilio/call-status`, { CallSid: "CA33333333333333333333333333333333", CallStatus: "ringing", From: CALLER, To: NUMBER }); // late, out of order
    const c = await s.ada.query(api.calls.get, { id: callId });
    assert.equal(c.call.status, "completed");
    assert.equal(c.call.durationSec, 42);
    assert.equal(c.call.outcome, "transferred");
    signed.close();
  } finally { await s.close(); }
});

test("credentials never leave custody: not in responses, records, audit, status or logs", async () => {
  const s = await twilioSetup();
  try {
    await s.hook("/twilio/sms", { MessageSid: "SM44444444444444444444444444444444", From: CALLER, To: NUMBER, Body: "hi", NumMedia: "0" });
    await s.rt.work();
    await s.rt.heartbeat();
    const seen = JSON.stringify([
      await s.ada.query(api.business.setup, {}), await s.ada.query(api.audit.list, {}), await s.ada.query(api.conversations.list, {}),
      await s.rt.bridge.call("gateway:settings"), await s.rt.bridge.call("gateway:status"), s.logs,
      await (await fetch(`${s.rt.url}/health`)).json(),
    ]);
    assert.ok(!seen.includes(TOKEN), "the auth token appears nowhere");
    assert.ok(seen.includes(SID), "(sanity: the account id, which is not secret, does)");
  } finally { await s.close(); }
});
