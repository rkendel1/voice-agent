import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "../feltkit/_generated/api.js";
import { VoiceRuntime } from "../gateway/runtime.js";
import { SIM_REFUSE, SIM_UNDELIVERED } from "../gateway/providers/simulator.js";
import { CALLER, NUMBER, VOICE, call, post, setup, until } from "./helpers.js";

test("duplicate webhook delivery: the same provider event twice is one message", async () => {
  const s = await setup();
  try {
    const event = { provider: "simulator" as const, sid: "SMdup0000000000000000000000000001", from: CALLER, to: NUMBER, body: "once", media: [] };
    const first = await s.rt.inboundSms(event);
    const second = await s.rt.inboundSms(event);
    assert.equal((first as any).duplicate, false);
    assert.equal((second as any).duplicate, true);
    const [conv] = await s.ada.query(api.conversations.list, {});
    assert.equal((await s.ada.query(api.conversations.timeline, { conversationId: conv!.id })).items.filter((i: any) => i.type === "sms").length, 1);
    assert.equal(conv!.unread, 1);
  } finally { await s.close(); }
});

test("out-of-order call events: a late status cannot move a call backwards", async () => {
  const s = await setup();
  try {
    const { phone } = await call(s.rt);
    await phone!.utterances(2);
    const [live] = await s.ada.query(api.calls.live, {});
    const sid = live!.providerSid!;
    await s.rt.callStatus({ provider: "simulator", sid, status: "completed", duration: 12, businessId: s.acme.id });
    await s.rt.callStatus({ provider: "simulator", sid, status: "ringing", businessId: s.acme.id });
    await s.rt.callStatus({ provider: "simulator", sid, status: "in-progress", businessId: s.acme.id });
    const c = await s.ada.query(api.calls.get, { id: live!.id });
    assert.equal(c.call.status, "completed");
    assert.equal(c.call.durationSec, 12);
    phone!.hangup();
  } finally { await s.close(); }
});

test("disconnected call: the last partial words are kept, the session is marked lost, the record is whole", async () => {
  const s = await setup();
  try {
    const { phone } = await call(s.rt);
    await phone!.utterances(2);
    await phone!.ask("what are your hours");
    phone!.partial("I wanted to ask about my bi");
    await new Promise((r) => setTimeout(r, 50));
    phone!.ws.terminate(); // the network drops; no goodbye
    const [c] = await until(() => s.ada.query(api.calls.list, {}), (l: any[]) => l[0]?.status === "completed");
    const full = await s.ada.query(api.calls.get, { id: c!.id });
    assert.equal(full.call.session, "lost");
    const last = full.transcript.at(-1)!;
    assert.deepEqual([last.speaker, last.text, last.partial], ["caller", "I wanted to ask about my bi", true]);
    assert.deepEqual(full.transcript.map((t: any) => t.seq), full.transcript.map((_: any, i: number) => i), "turns are complete and in order");
  } finally { await s.close(); }
});

test("agent restart: work a stopped runtime had leased is taken over when its lease expires; an interrupted send is not repeated", async () => {
  const s = await setup();
  try {
    await post(s.rt, "/simulator/sms", { from: CALLER, to: NUMBER, body: "hello" });
    const [conv] = await s.ada.query(api.conversations.list, {});
    // Runtime A leases everything and dies before finishing.
    const leased = await s.rt.bridge.call("gateway:claimWork", { limit: 10, leaseMs: 1000 });
    assert.equal(leased.length, 1);
    // A text it was in the middle of sending: claimed (sending), provider answer never recorded.
    const otherId = await s.ada.mutation(api.contacts.save, { phone: "+15557770777", name: "Other" });
    const other = (await s.ada.query(api.conversations.list, {})).find((c: any) => c.contactId === otherId)!;
    const r = await s.ada.mutation(api.conversations.reply, { conversationId: other.id, body: "mid-send", idempotencyKey: "midsend-001" });
    await s.rt.bridge.call("gateway:claimWork", { limit: 10, leaseMs: 1000 });
    await s.rt.bridge.call("gateway:sendClaim", { messageId: r.messageId }, s.acme.id);
    assert.equal(await s.rt.work(), 0, "nothing is due while the leases hold");
    await new Promise((res) => setTimeout(res, 1100));
    // Runtime B starts (the state survives a FeltKit restart too).
    await s.rt.close();
    await s.t.restart();
    const b = await new VoiceRuntime({ runtime: s.t.runtime as any, port: 0, workIntervalMs: 0, log: () => {} }).start();
    try {
      assert.equal(await b.work(), 2);
      const { items } = await s.ada.query(api.conversations.timeline, { conversationId: conv!.id });
      assert.ok(items.some((i: any) => i.direction === "outbound" && i.authorKind === "agent" && i.status === "sent"), "the agent's reply was completed");
      const mid = (await s.ada.query(api.conversations.timeline, { conversationId: other.id })).items.find((i: any) => i.id === r.messageId) as any;
      assert.equal(mid.status, "unknown", "may have been sent: recorded as unknown, not sent again");
      const texts = (await (await fetch(`${b.url}/simulator/phone?number=%2B15557770777`)).json()).texts;
      assert.ok(!texts.some((t: any) => t.body.includes("mid-send")));
    } finally { await b.close(); }
  } finally { await s.t.close(); }
});

test("repeated capability execution: one tool call id, one appointment; concurrent bookings of one slot, one wins", async () => {
  const s = await setup();
  try {
    const { phone } = await call(s.rt);
    await phone!.utterances(2);
    const [live] = await s.ada.query(api.calls.live, {});
    const [agent] = await s.ada.query(api.agents.list, {});
    const vr = s.t.as(VOICE, { tenant: s.acme.id });
    const avail = await vr.mutation(api.tools.availability, { agentId: agent!.id, callId: live!.id, toolCallId: "a1", days: 2 });
    const day = (avail as any).days[0];
    const slot = `${day.date}T${day.slots[0]}`;
    const one = await vr.mutation(api.tools.book, { agentId: agent!.id, callId: live!.id, toolCallId: "b1", slot, name: "Kim" });
    const again = await vr.mutation(api.tools.book, { agentId: agent!.id, callId: live!.id, toolCallId: "b1", slot, name: "Kim" });
    assert.equal(one.ok, true);
    assert.equal(again.repeated, true);
    assert.equal(again.appointmentId, one.appointmentId);
    const slot2 = `${day.date}T${day.slots[1]}`;
    const race = await Promise.all([1, 2, 3].map((i) => s.rt.bridge.call("tools:book", { agentId: agent!.id, callId: live!.id, toolCallId: `race-${i}`, slot: slot2 }, s.acme.id)));
    assert.equal(race.filter((r: any) => r.ok).length, 1, JSON.stringify(race));
    assert.equal((await s.ada.query(api.appointments.list, {})).length, 2);
    phone!.hangup();
  } finally { await s.close(); }
});

test("failed SMS: refused by the provider → failed; accepted then undelivered → undelivered; both audited", async () => {
  const s = await setup();
  try {
    const ids: Record<string, string> = {};
    for (const phone of [SIM_REFUSE, SIM_UNDELIVERED]) {
      const contactId = await s.ada.mutation(api.contacts.save, { phone, name: phone });
      const conv = (await s.ada.query(api.conversations.list, {})).find((c: any) => c.contactId === contactId)!;
      ids[phone] = (await s.ada.mutation(api.conversations.reply, { conversationId: conv.id, body: "test", idempotencyKey: `fail-${phone}` })).messageId;
      ids[`${phone}:conv`] = conv.id;
    }
    await s.rt.work();
    const status = async (p: string) => ((await s.ada.query(api.conversations.timeline, { conversationId: ids[`${p}:conv`]! })).items.find((i: any) => i.id === ids[p]) as any).status;
    assert.equal(await status(SIM_REFUSE), "failed");
    await until(() => status(SIM_UNDELIVERED), (st) => st === "undelivered");
    assert.equal((await s.ada.query(api.audit.list, { type: "sms.failed" })).length, 2);
    assert.equal((await s.ada.query(api.overview.get, {})).smsFailed, 2);
  } finally { await s.close(); }
});
