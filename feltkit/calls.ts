import { fail, s } from "@feltdb/feltkit";
import { agents, app, calls, contacts, invocations, messages, phoneNumbers, transcripts } from "./app.js";
import { business } from "./_authz.js";
import { enqueue, ensureConversation, loadBusiness, recordAudit, touchConversation } from "./_ops.js";
import { CALL_TERMINAL, inQuietHours } from "./_policy.js";

const LIVE = ["queued", "initiated", "ringing", "in-progress"];
const view = (c: any) => ({ ...c, sessionTokenHash: undefined });

export const list = app.query({
  access: "calls.read",
  args: { filter: s.optional(s.enum(["all", "missed", "inbound", "outbound"])), limit: s.optional(s.integer({ minimum: 1, maximum: 200 })) },
  handler: async (ctx, { filter = "all", limit = 100 }) => {
    let rows = await ctx.db.find(calls, {}, { orderBy: [{ field: "startedAt", direction: "desc" }], limit: 500 });
    if (filter === "missed") rows = rows.filter((c) => c.outcome === "missed");
    if (filter === "inbound" || filter === "outbound") rows = rows.filter((c) => c.direction === filter);
    const people = new Map((await ctx.db.find(contacts, {})).map((c) => [c.id, c]));
    return rows.slice(0, limit).map((c) => ({ ...view(c), contactName: people.get(c.contactId)?.name ?? null }));
  },
});

/** Calls in progress (or ringing), for the live board. */
export const live = app.query({
  access: "calls.read",
  handler: async (ctx) => {
    const rows = (await ctx.db.find(calls, {})).filter((c) => LIVE.includes(c.status));
    const people = new Map((await ctx.db.find(contacts, {})).map((c) => [c.id, c]));
    return rows.sort((a, b) => b.startedAt - a.startedAt).map((c) => ({ ...view(c), contactName: people.get(c.contactId)?.name ?? null }));
  },
});

/** One call: its state, transcript, every agent action, and the contact. Live queries re-run as turns are written. */
export const get = app.query({
  access: "calls.read",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const call = (await ctx.db.get(calls, id)) ?? fail("NOT_FOUND", "Call not found.");
    const contact = await ctx.db.get(contacts, call.contactId);
    const agent = call.agentId ? await ctx.db.get(agents, call.agentId) : null;
    const turns = await ctx.db.find(transcripts, { callId: id }, { orderBy: [{ field: "seq", direction: "asc" }] });
    const actions = await ctx.db.find(invocations, { callId: id }, { orderBy: [{ field: "at", direction: "asc" }] });
    const b = await loadBusiness(ctx);
    return { call: view(call), contact, agent: agent ? { id: agent.id, name: agent.name, brain: agent.brain } : null, transcript: turns, actions, escalation: b.escalation, transcriptsEnabled: b.policy.transcripts };
  },
});

/**
 * A person starts an outbound call to one contact. There is no bulk or automated dialling: agents do
 * not hold calls.start. The business's policy decides: outbound calls enabled, not on the do-not-call
 * list, consent recorded (or returning the contact's own call or text from the last 7 days), outside
 * quiet hours, under the hourly limit, and a voice number to call from.
 */
export const start = app.mutation({
  access: "calls.start",
  args: { contactId: s.string(), agentId: s.optional(s.string()), idempotencyKey: s.string({ minLength: 8, maxLength: 80 }) },
  returns: s.object({ callId: s.string(), duplicate: s.boolean() }),
  handler: async (ctx, { contactId, agentId, idempotencyKey }) => {
    const { businessId, actor, actorName } = business(ctx);
    const b = await loadBusiness(ctx);
    const contact = (await ctx.db.get(contacts, contactId)) ?? fail("NOT_FOUND", "Contact not found.");
    const key = `start:${actor}:${idempotencyKey}`;
    const [prior] = (await ctx.db.find(calls, { startedBy: key }));
    if (prior) return { callId: prior.id, duplicate: true };
    const now = Date.now();
    const refuse = (why: string): never => fail("FAILED_PRECONDITION", why);
    if (!b.policy.outboundCalls) refuse("Outbound calls are off for this business (Settings → Policies).");
    if (contact.doNotCall) refuse("This contact is on the do-not-call list.");
    const week = now - 7 * 24 * 3600_000;
    const conv = await ensureConversation(ctx, businessId, contact.id, now);
    const returning = (await ctx.db.find(calls, { contactId })).some((c) => c.direction === "inbound" && c.startedAt > week)
      || (await ctx.db.find(messages, { conversationId: conv.id })).some((m) => m.direction === "inbound" && m.createdAt > week);
    if (!contact.callConsent && !returning) refuse("No call consent is recorded for this contact. Record how consent was given, or wait for them to contact you.");
    if (inQuietHours(b.policy.quietStart, b.policy.quietEnd, b.timezone, now)) refuse(`Quiet hours (${b.policy.quietStart}–${b.policy.quietEnd}, ${b.timezone}).`);
    const lastHour = (await ctx.db.find(calls, { direction: "outbound" })).filter((c) => c.startedAt > now - 3600_000).length;
    if (lastHour >= b.policy.maxOutboundCallsPerHour) refuse(`The hourly limit of ${b.policy.maxOutboundCallsPerHour} outbound calls is reached.`);
    const numbers = (await ctx.db.find(phoneNumbers, {})).filter((n) => n.voice);
    const from = numbers.find((n) => n.outbound) ?? numbers[0] ?? refuse("The business has no voice-enabled phone number.");
    const agent = agentId ? (await ctx.db.get(agents, agentId)) ?? fail("NOT_FOUND", "Agent not found.") : from.agentId ? await ctx.db.get(agents, from.agentId) : null;
    const conversation = conv;
    const callId = await ctx.db.insert(calls, {
      businessId, conversationId: conversation.id, contactId: contact.id, numberId: from.id, direction: "outbound", provider: from.provider,
      from: from.e164, to: contact.phone, status: "queued", handling: agent?.active ? "agent" : "operator", ...(agent?.active ? { agentId: agent.id } : {}),
      session: "none", transcriptSegments: 0, startedAt: now, startedBy: key,
    });
    await enqueue(ctx, businessId, "call.dial", callId, now);
    await touchConversation(ctx, conversation, "call", `Outbound call by ${actorName}`, 0, now);
    await recordAudit(ctx, businessId, actor, "human", "call.outbound", `${actorName} called ${contact.name ?? contact.phone}${agent?.active ? ` with agent ${agent.name}` : ""}`, callId);
    return { callId, duplicate: false };
  },
});

/**
 * A person intervenes in a live call: hang up, transfer to an escalation contact, take over (the agent
 * stops answering and the operator's words are spoken), release back to the agent, or say one line.
 * The voice runtime applies it and marks it applied; the transcript records what was said.
 */
export const control = app.mutation({
  access: "calls.control",
  args: { callId: s.string(), action: s.enum(["hangup", "transfer", "takeover", "release", "say"]), text: s.optional(s.string({ minLength: 1, maxLength: 500 })), escalationId: s.optional(s.string({ maxLength: 32 })) },
  returns: s.object({ seq: s.integer() }),
  capability: { name: "calls.intervene", description: "Hang up, transfer, take over, release or speak into a live call." },
  handler: async (ctx, { callId, action, text, escalationId }) => {
    const { businessId, actor, actorName } = business(ctx);
    const b = await loadBusiness(ctx);
    const call = (await ctx.db.get(calls, callId)) ?? fail("NOT_FOUND", "Call not found.");
    if (CALL_TERMINAL.has(call.status)) fail("FAILED_PRECONDITION", "The call has ended.");
    if (action === "say" && !text) fail("INVALID_ARGUMENT", "Say what?");
    if (action === "transfer") {
      const target = b.escalation.find((e) => e.id === escalationId) ?? fail("INVALID_ARGUMENT", "Choose one of the business's escalation contacts.");
      await ctx.db.patch(calls, callId, { transfer: { to: target.phone, toName: target.name, status: "requested", reason: `Transferred by ${actorName}`, by: actor, at: Date.now() } });
    }
    const seq = (call.control?.seq ?? 0) + 1;
    await ctx.db.patch(calls, callId, {
      control: { seq, action, ...(text ? { text } : {}), ...(escalationId ? { escalationId } : {}), by: actor, at: Date.now(), applied: false },
      ...(action === "takeover" ? { takenOver: actor } : action === "release" ? { takenOver: undefined } : {}),
    });
    await recordAudit(ctx, businessId, actor, "human", "call.intervention", `${actorName}: ${action}${text ? ` "${text.slice(0, 80)}"` : ""}${escalationId ? ` → ${escalationId}` : ""}`, callId);
    return { seq };
  },
});
