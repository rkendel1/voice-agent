import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "../feltkit/_generated/api.js";
import { CALLER, NUMBER, Phone, call, post, rejects, setup, until } from "./helpers.js";

test("inbound SMS: contact, conversation, message; the agent replies through the provider", async () => {
  const s = await setup();
  try {
    const r = await post(s.rt, "/simulator/sms", { from: CALLER, to: NUMBER, body: "What are your hours?" });
    assert.equal(r.status, 200);
    assert.equal(r.body.outcome, "agent_reply_queued");
    const [conv] = await s.ada.query(api.conversations.list, {});
    assert.equal(conv!.contact!.phone, CALLER);
    assert.equal(conv!.unread, 1);
    assert.equal(await s.rt.work(), 1);
    const { items } = await s.ada.query(api.conversations.timeline, { conversationId: conv!.id });
    const out = items.find((i: any) => i.type === "sms" && i.direction === "outbound") as any;
    assert.ok(out, "the agent answered");
    assert.match(out.body, /Acme Dental: .*hours/s, "first text carries the sender line");
    assert.match(out.body, /Reply STOP to opt out/);
    assert.equal(out.status, "sent");
    assert.match(out.providerSid, /^SMsim/, "the provider's receipt is stored");
    // The simulated phone received it, and the provider's delivery report advances the status.
    const phone = await (await fetch(`${s.rt.url}/simulator/phone?number=${encodeURIComponent(CALLER)}`)).json();
    assert.equal(phone.texts.length, 1);
    await until(() => s.ada.query(api.conversations.timeline, { conversationId: conv!.id }), (t: any) => t.items.some((i: any) => i.id === out.id && i.status === "delivered"));
  } finally { await s.close(); }
});

test("outbound SMS: staff reply is queued, sent once, delivered; repeating the request does not send twice", async () => {
  const s = await setup();
  try {
    await post(s.rt, "/simulator/sms", { from: CALLER, to: NUMBER, body: "STOP?" }); // not a keyword (punctuation kept)
    await s.rt.work();
    const [conv] = await s.grace.query(api.conversations.list, {});
    const a = await s.grace.mutation(api.conversations.reply, { conversationId: conv!.id, body: "See you Tuesday!", idempotencyKey: "reply-0001" });
    const b = await s.grace.mutation(api.conversations.reply, { conversationId: conv!.id, body: "See you Tuesday!", idempotencyKey: "reply-0001" });
    assert.equal(a.status, "queued");
    assert.equal(b.messageId, a.messageId);
    assert.equal(b.duplicate, true);
    await s.rt.work();
    const phone = await (await fetch(`${s.rt.url}/simulator/phone?number=${encodeURIComponent(CALLER)}`)).json();
    assert.equal(phone.texts.filter((x: any) => x.body.includes("See you Tuesday")).length, 1);
  } finally { await s.close(); }
});

test("inbound call: the agent books an appointment, texts a confirmation, and the record holds it all", async () => {
  const s = await setup();
  try {
    const { plan, phone } = await call(s.rt);
    assert.equal(plan.kind, "relay");
    const [greeting] = await phone!.utterances(2);
    assert.match(greeting!, /automated assistant/, "disclosure first");
    assert.match(phone!.heard[1]!, /Thanks for calling Acme Dental/);
    const offer = await phone!.ask("I'd like to book an appointment tomorrow please");
    assert.match(offer, /earliest I have is tomorrow at/);
    assert.match(await phone!.ask("the first one"), /name for the booking/);
    const done = await phone!.ask("It's Jordan Lee");
    assert.match(done, /You're all set for/);
    assert.match(done, /texted you a confirmation/, "only after the provider accepted it");
    const live = await s.ada.query(api.calls.live, {});
    assert.equal(live.length, 1);
    const callId = live[0]!.id;
    phone!.hangup();
    await until(() => s.ada.query(api.calls.get, { id: callId }), (c: any) => c.call.status === "completed");
    await s.rt.work(); // summary
    const c = await s.ada.query(api.calls.get, { id: callId });
    assert.equal(c.call.outcome, "appointment_booked");
    assert.equal(c.contact!.name, "Jordan Lee");
    assert.deepEqual(c.actions.map((a: any) => [a.capability, a.status]), [["appointments.availability", "succeeded"], ["appointments.book", "succeeded"], ["sms.send", "succeeded"]]);
    assert.ok(c.transcript.some((x: any) => x.speaker === "caller" && x.text === "the first one"));
    assert.match(c.call.summary!, /booked/);
    const appts = await s.ada.query(api.appointments.list, {});
    assert.equal(appts.length, 1);
    const texts = (await (await fetch(`${s.rt.url}/simulator/phone?number=${encodeURIComponent(CALLER)}`)).json()).texts;
    assert.match(texts[0].body, /confirmed for/);
  } finally { await s.close(); }
});

test("outbound call: refused without consent; with consent it is dialled, answered and handled by the agent", async () => {
  const s = await setup();
  try {
    await s.ada.mutation(api.business.update, { policy: { outboundCalls: true } });
    const contactId = await s.ada.mutation(api.contacts.save, { phone: "+15557770999", name: "Pat" });
    await rejects(s.ada.mutation(api.calls.start, { contactId, idempotencyKey: "call-00001" }), "FAILED_PRECONDITION");
    await s.ada.mutation(api.contacts.setConsent, { id: contactId, callConsent: { source: "Asked for a callback on the web form" } });
    const { callId } = await s.ada.mutation(api.calls.start, { contactId, idempotencyKey: "call-00002" });
    assert.equal((await s.ada.mutation(api.calls.start, { contactId, idempotencyKey: "call-00002" })).callId, callId, "idempotent");
    await s.rt.work();
    const ring = await until(async () => (await (await fetch(`${s.rt.url}/simulator/phone?number=%2B15557770999`)).json()).ringing, (r: any[]) => r.length === 1);
    const answer = await post(s.rt, "/simulator/answer", { sid: ring[0].sid });
    assert.equal(answer.body.kind, "relay");
    const phone = new Phone(answer.body.relayUrl);
    await phone.open();
    phone.setup(ring[0].sid);
    await phone.utterances(2);
    assert.match(phone.heard[1]!, /Front desk calling from Acme Dental/);
    phone.hangup();
    const done = await until(() => s.ada.query(api.calls.get, { id: callId }), (c: any) => c.call.status === "completed");
    assert.equal(done.call.direction, "outbound");
    assert.ok(done.call.providerSid?.startsWith("CAsim"));
  } finally { await s.close(); }
});

test("human escalation: the caller asks for a person and is transferred to the escalation contact", async () => {
  const s = await setup();
  try {
    const { phone } = await call(s.rt);
    await phone!.utterances(2);
    const said = await phone!.ask("Can I talk to a person please");
    assert.match(said, /transferring you to Reception/);
    await until(async () => phone!.ended, (e) => Boolean(e));
    assert.equal(phone!.ended.reason, "transfer");
    const [c] = await s.ada.query(api.calls.list, {});
    const full = await until(() => s.ada.query(api.calls.get, { id: c!.id }), (x: any) => x.call.status === "completed");
    assert.equal(full.call.transfer?.status, "completed");
    assert.equal(full.call.outcome, "transferred");
  } finally { await s.close(); }
});

test("operator intervention: say a line, take over, hang up", async () => {
  const s = await setup();
  try {
    const { phone } = await call(s.rt);
    await phone!.utterances(2);
    const [live] = await s.grace.query(api.calls.live, {});
    await s.grace.mutation(api.calls.control, { callId: live!.id, action: "say", text: "Hi, this is Grace from reception." });
    await phone!.utterances(3);
    assert.equal(phone!.heard[2], "Hi, this is Grace from reception.");
    await s.grace.mutation(api.calls.control, { callId: live!.id, action: "takeover" });
    await until(() => s.grace.query(api.calls.get, { id: live!.id }), (c: any) => c.transcript.some((t: any) => /took over/.test(t.text)));
    phone!.say("Hello?");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(phone!.heard.length, 3, "the agent stays quiet while a person has the call");
    await s.grace.mutation(api.calls.control, { callId: live!.id, action: "hangup" });
    await until(async () => phone!.ended, Boolean);
    const c = await until(() => s.grace.query(api.calls.get, { id: live!.id }), (x: any) => x.call.status === "completed");
    assert.ok(c.transcript.some((t: any) => t.speaker === "operator"));
    const audit = await s.ada.query(api.audit.list, { type: "call.intervention" });
    assert.equal(audit.length, 3);
  } finally { await s.close(); }
});

test("missed call: no agent on duty and no fallback → message to the caller, missed, follow-up task, text-back by policy", async () => {
  const s = await setup();
  try {
    const [n] = await s.ada.query(api.numbers.list, {});
    await s.ada.mutation(api.numbers.update, { id: n!.id, agentId: null });
    await s.ada.mutation(api.business.update, { policy: { missedCallTextBack: true } });
    const { plan } = await call(s.rt);
    assert.equal(plan.kind, "unavailable");
    const [c] = await until(() => s.ada.query(api.calls.list, {}), (l: any[]) => l[0]?.status === "completed");
    assert.equal(c!.outcome, "missed");
    await s.t.runtime.runServices(); // FeltKit runs the voice agent's durable follow-up workflow
    const tasks = await until(() => s.ada.query(api.tasks.list, {}), (l: any[]) => l.length === 1);
    assert.match(tasks[0]!.title, /Call back/);
    await s.rt.work();
    const texts = (await (await fetch(`${s.rt.url}/simulator/phone?number=${encodeURIComponent(CALLER)}`)).json()).texts;
    assert.match(texts[0].body, /Sorry we missed your call/);
  } finally { await s.close(); }
});

test("message taking: the agent creates a follow-up with the caller's words", async () => {
  const s = await setup();
  try {
    const { phone } = await call(s.rt);
    await phone!.utterances(2);
    assert.match(await phone!.ask("Can I leave a message"), /What message/);
    assert.match(await phone!.ask("Please ask Dr. Smith to call me about my crown"), /passed your message on/);
    const [task] = await s.ada.query(api.tasks.list, {});
    assert.equal(task!.createdByKind, "agent");
    assert.match(task!.detail!, /crown/);
    phone!.hangup();
    const [c] = await until(() => s.ada.query(api.calls.list, {}), (l: any[]) => l[0]?.status === "completed");
    assert.equal(c!.outcome, "message_taken");
  } finally { await s.close(); }
});
