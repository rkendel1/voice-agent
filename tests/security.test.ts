import assert from "node:assert/strict";
import { test } from "node:test";
import WebSocket from "ws";
import { api } from "../feltkit/_generated/api.js";
import { ADA, ALAN, CALLER, MALLORY, NUMBER, OTHER_NUMBER, VOICE, actor, call, join, post, rejects, setup, until } from "./helpers.js";

test("cross-business: another business's records do not exist, and a forged businessId is refused", async () => {
  const s = await setup();
  try {
    await post(s.rt, "/simulator/sms", { from: CALLER, to: NUMBER, body: "hello" });
    const [conv] = await s.ada.query(api.conversations.list, {});
    const contactId = conv!.contactId;
    await rejects(s.mallory.query(api.conversations.timeline, { conversationId: conv!.id }), "NOT_FOUND");
    await rejects(s.mallory.query(api.contacts.get, { id: contactId }), "NOT_FOUND");
    await rejects(s.mallory.mutation(api.conversations.reply, { conversationId: conv!.id, body: "hi", idempotencyKey: "evil-0001" }), "NOT_FOUND");
    await rejects(s.mallory.mutation(api.calls.control, { callId: "anything", action: "hangup" }), "NOT_FOUND");
    assert.deepEqual(await s.mallory.query(api.conversations.list, {}), []);
    assert.deepEqual(await s.mallory.query(api.contacts.list, {}), []);
    // A business id in the arguments is never trusted.
    await rejects(s.mallory.query(api.business.get, { businessId: s.acme.id } as any), ["NOT_FOUND", "INVALID_ARGUMENT"]);
    // Mallory's own inbound text lands in her business only.
    await post(s.rt, "/simulator/sms", { from: CALLER, to: OTHER_NUMBER, body: "hello evil" });
    assert.equal((await s.ada.query(api.conversations.list, {})).length, 1);
    assert.equal((await s.mallory.query(api.conversations.list, {})).length, 1);
  } finally { await s.close(); }
});

test("phone numbers: one business per number, staff cannot change routing, outsiders cannot see numbers", async () => {
  const s = await setup();
  try {
    await rejects(s.mallory.mutation(api.numbers.add, { e164: NUMBER, label: "steal", provider: "simulator", sms: true, voice: true }), "CONFLICT");
    const e = await rejects(s.grace.mutation(api.numbers.add, { e164: "+15550001111", label: "x", provider: "simulator", sms: true, voice: true }), "FORBIDDEN");
    assert.ok(e);
    const [n] = await s.ada.query(api.numbers.list, {});
    await rejects(s.grace.mutation(api.numbers.update, { id: n!.id, agentId: null }), "FORBIDDEN");
    await rejects(s.mallory.mutation(api.numbers.update, { id: n!.id, label: "mine" }), "NOT_FOUND");
    await rejects(s.mallory.mutation(api.numbers.release, { id: n!.id }), "NOT_FOUND");
    // A person who is not a member of any business sees nothing.
    await rejects(s.t.as(ALAN).query(api.numbers.list, {}), ["NOT_FOUND", "FORBIDDEN"]);
  } finally { await s.close(); }
});

test("agent least privilege: a capability the agent profile does not list is refused and recorded", async () => {
  const s = await setup();
  try {
    const [agent] = await s.ada.query(api.agents.list, {});
    await s.ada.mutation(api.agents.save, { ...pick(agent), capabilities: ["business.info", "followups.create"] });
    const { phone } = await call(s.rt);
    await phone!.utterances(2);
    const said = await phone!.ask("I want to book an appointment tomorrow");
    assert.match(said, /can't check appointments/, "a scripted agent without the capability does not try");
    // The model (or anything else) asking anyway: the policy refuses it, and the refusal is recorded.
    const [live] = await s.ada.query(api.calls.live, {});
    const vr = s.t.as(VOICE, { tenant: s.acme.id });
    await rejects(vr.mutation(api.tools.book, { agentId: agent!.id, callId: live!.id, toolCallId: "x1", slot: "2030-01-01T10:00" }), "FORBIDDEN");
    await rejects(vr.mutation(api.tools.sendSms, { agentId: agent!.id, callId: live!.id, toolCallId: "x2", body: "hi" }), "FORBIDDEN");
    // An inactive agent may do nothing.
    await s.ada.mutation(api.agents.save, { ...pick(agent), active: false });
    await rejects(vr.mutation(api.tools.businessInfo, { agentId: agent!.id, callId: live!.id, toolCallId: "x3" }), "FORBIDDEN");
    phone!.hangup();
  } finally { await s.close(); }
});

test("privilege escalation: the voice runtime cannot act as staff, people cannot invoke agent tools, outsiders cannot use the runtime", async () => {
  const s = await setup();
  try {
    const vr = s.t.as(VOICE, { tenant: s.acme.id });
    await rejects(vr.mutation(api.business.update, { name: "pwned" }), "FORBIDDEN");
    await rejects(vr.mutation(api.numbers.add, { e164: "+15550002222", label: "x", provider: "simulator", sms: true, voice: true }), "FORBIDDEN");
    await rejects(vr.mutation(api.calls.start, { contactId: "x", idempotencyKey: "auto-dial-01" }), "FORBIDDEN"); // no automated dialling
    await rejects(vr.query(api.conversations.list, {}), "FORBIDDEN");
    const [agent] = await s.ada.query(api.agents.list, {});
    await rejects(s.ada.mutation(api.tools.businessInfo, { agentId: agent!.id, conversationId: "x", toolCallId: "y" }), "FORBIDDEN");
    // The runtime is not a member of a business that did not connect it.
    const other = (await s.t.tenancy!.create("Unconnected", ALAN)).id;
    await rejects(s.rt.bridge.call("business:get", {}, other), "FORBIDDEN");
    // Global runtime functions are closed to people.
    await rejects(s.ada.query(api.gateway.route, { to: NUMBER }), "FORBIDDEN");
    await rejects(s.ada.mutation(api.gateway.claimWork, { limit: 1, leaseMs: 1000 }), "FORBIDDEN");
  } finally { await s.close(); }
});

test("tool calls are bound to the agent's own call", async () => {
  const s = await setup();
  try {
    const [a1] = await s.ada.query(api.agents.list, {});
    const a2 = await s.ada.mutation(api.agents.save, { ...pick(a1), id: undefined, name: "Night line" });
    const { phone } = await call(s.rt);
    await phone!.utterances(2);
    const [live] = await s.ada.query(api.calls.live, {});
    const vr = s.t.as(VOICE, { tenant: s.acme.id });
    await rejects(vr.mutation(api.tools.transfer, { agentId: a2, callId: live!.id, toolCallId: "t1", reason: "x" }), "FORBIDDEN");
    phone!.hangup();
  } finally { await s.close(); }
});

test("SMS opt-out: STOP blocks every later text (staff, agent, text-back); START re-enables", async () => {
  const s = await setup();
  try {
    await post(s.rt, "/simulator/sms", { from: CALLER, to: NUMBER, body: "hi" });
    await s.rt.work();
    const r = await post(s.rt, "/simulator/sms", { from: CALLER, to: NUMBER, body: " Stop " });
    assert.equal(r.body.outcome, "opted_out");
    const [conv] = await s.ada.query(api.conversations.list, {});
    assert.equal(conv!.contact!.smsOptOut, true);
    const reply = await s.ada.mutation(api.conversations.reply, { conversationId: conv!.id, body: "Are you sure?", idempotencyKey: "after-stop-1" });
    assert.equal(reply.status, "blocked");
    assert.match(reply.reason!, /opted out/);
    // A text queued before STOP is not sent after it.
    await post(s.rt, "/simulator/sms", { from: CALLER, to: NUMBER, body: "START" });
    const queued = await s.ada.mutation(api.conversations.reply, { conversationId: conv!.id, body: "queued before stop", idempotencyKey: "before-stop-2" });
    assert.equal(queued.status, "queued");
    await post(s.rt, "/simulator/sms", { from: CALLER, to: NUMBER, body: "STOP" });
    await s.rt.work();
    const texts = (await (await fetch(`${s.rt.url}/simulator/phone?number=${encodeURIComponent(CALLER)}`)).json()).texts.map((t: any) => t.body);
    assert.ok(!texts.some((b: string) => b.includes("queued before stop") || b.includes("Are you sure")), JSON.stringify(texts));
    const audit = await s.ada.query(api.audit.list, { type: "contact.consent" });
    assert.equal(audit.length, 3);
  } finally { await s.close(); }
});

test("transcripts are stored only when the business's policy allows it", async () => {
  const s = await setup();
  try {
    await s.ada.mutation(api.business.update, { policy: { transcripts: false } });
    const { phone } = await call(s.rt);
    await phone!.utterances(1);
    assert.ok(!phone!.heard[0]!.includes("transcribed"), "no transcription disclosure when nothing is transcribed");
    await phone!.ask("what are your hours");
    const [live] = await s.ada.query(api.calls.live, {});
    phone!.hangup();
    const c = await until(() => s.ada.query(api.calls.get, { id: live!.id }), (x: any) => x.call.status === "completed");
    assert.equal(c.transcript.length, 0);
  } finally { await s.close(); }
});

test("removed members lose access at once; a business that disconnects the runtime closes it out", async () => {
  const s = await setup();
  try {
    assert.ok(Array.isArray(await s.grace.query(api.conversations.list, {})));
    await s.t.tenancy!.remove(await actor(s.t, s.acme.id, ADA), "grace");
    await rejects(s.grace.query(api.conversations.list, {}), ["NOT_FOUND", "FORBIDDEN"]);
    await s.t.tenancy!.remove(await actor(s.t, s.acme.id, ADA), VOICE.id);
    const r = await post(s.rt, "/simulator/sms", { from: CALLER, to: NUMBER, body: "anyone there?" });
    assert.equal(r.status, 500, "the runtime cannot write into a business it is not a member of");
    assert.equal((await s.ada.query(api.conversations.list, {})).length, 0);
  } finally { await s.close(); }
});

test("media sessions: a wrong token is refused before anything is said", async () => {
  const s = await setup();
  try {
    const r = await post(s.rt, "/simulator/call", { from: CALLER, to: NUMBER });
    const forged = r.body.relayUrl.replace(/t=[^&]+/, "t=forged-token");
    const ws = new WebSocket(forged);
    const heard: string[] = [];
    ws.on("message", (m) => heard.push(String(m)));
    await new Promise((res) => ws.on("open", res));
    ws.send(JSON.stringify({ type: "setup" }));
    await new Promise((res) => ws.on("close", res));
    assert.deepEqual(heard, []);
  } finally { await s.close(); }
});

test("the simulator answers only on this machine", async () => {
  const s = await setup();
  try {
    // A request that names another host (DNS rebinding, a tunnel) is refused even from this machine.
    const { request } = await import("node:http");
    const port = new URL(s.rt.url).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/simulator/sms", method: "POST", headers: { host: "evil.example.com", "content-type": "application/json" } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on("error", reject);
      req.end(JSON.stringify({ from: CALLER, to: NUMBER, body: "x" }));
    });
    assert.equal(status, 403);
    const prod = await setup({ production: true });
    try { assert.equal((await post(prod.rt, "/simulator/sms", { from: CALLER, to: NUMBER, body: "x" })).status, 403); } finally { await prod.close(); }
  } finally { await s.close(); }
});

function pick(a: any) {
  const { id, name, purpose, instructions, greeting, voice, brain, temperature, capabilities, escalateTo, schedule, smsAutoReply, active } = a;
  return { id, name, purpose, instructions, greeting, voice, brain, temperature, capabilities, ...(escalateTo ? { escalateTo } : {}), schedule, smsAutoReply, active };
}
void MALLORY; void join;
