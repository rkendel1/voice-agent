/**
 * Agent capabilities: what a voice or SMS agent can do for a business, published as AppPort
 * capabilities. Each call is made by the voice runtime as itself (role "voice"), in the business the
 * call or conversation belongs to, naming the agent profile acting. `authorize` (feltkit/_authz.ts)
 * admits it only if that profile is active and granted the capability.
 *
 * Every invocation:
 *   - has an identity (the runtime's principal and the agent profile),
 *   - has an authorization decision (FeltKit's roles + authorize; a refusal is recorded by the runtime),
 *   - has validated arguments (the schemas below),
 *   - has a defined result: { ok: true, ... } or { ok: false, error } — a refusal is a result the agent
 *     must relay, never a success it may claim,
 *   - is recorded in `invocations`, keyed by the runtime's tool-call id: repeating it returns the
 *     first result instead of acting twice.
 */
import { fail, s, type MutationCtx } from "@feltdb/feltkit";
import { agents, app, appointments, calls, contacts, conversations, invocations, messages, tasks } from "./app.js";
import { business } from "./_authz.js";
import { loadBusiness, queueSms, recordAudit, type BusinessDoc, type ContactDoc, type ConversationDoc } from "./_ops.js";
import { addDays, freeSlots, isOpen, localParts, localToEpoch } from "./_policy.js";

/** Who is acting and where: supplied by the runtime, never by the model. */
const Acting = {
  agentId: s.string(),
  callId: s.optional(s.string()),
  conversationId: s.optional(s.string()),
  /** The runtime's id for this tool call (idempotency). */
  toolCallId: s.string({ minLength: 1, maxLength: 120 }),
};
const Result = s.record(s.unknown());

type Where = { business: BusinessDoc; contact: ContactDoc; conversation: ConversationDoc; callId?: string; agentId: string; agentName: string };
type Out = { ok: boolean; [k: string]: unknown };

async function invoke(ctx: MutationCtx, capability: string, args: Record<string, any>, run: (w: Where) => Promise<Out>): Promise<Out> {
  const { businessId } = business(ctx);
  const idempotencyKey = `${args.agentId}:${args.toolCallId}`;
  const [prior] = await ctx.db.find(invocations, { idempotencyKey });
  if (prior) return { ...((prior.result ?? { ok: false, error: prior.error }) as Out), repeated: true };
  const agent = (await ctx.db.get(agents, args.agentId))!;
  const b = await loadBusiness(ctx);
  let conversation: ConversationDoc;
  let callId: string | undefined;
  if (args.callId) {
    const call = (await ctx.db.get(calls, args.callId)) ?? fail("NOT_FOUND", "Call not found.");
    conversation = (await ctx.db.get(conversations, call.conversationId))!;
    callId = call.id;
  } else {
    conversation = (await ctx.db.get(conversations, args.conversationId)) ?? fail("NOT_FOUND", "Conversation not found.");
  }
  const contact = (await ctx.db.get(contacts, conversation.contactId))!;
  const { agentId: _a, callId: _c, conversationId: _v, toolCallId: _t, ...given } = args;
  let out: Out;
  try {
    out = await run({ business: b, contact, conversation, ...(callId ? { callId } : {}), agentId: agent.id, agentName: agent.name });
  } catch (error: any) {
    // A domain refusal (a taken slot, a bad date) is a result, recorded; anything else is a failure, recorded.
    out = { ok: false, error: String(error?.message ?? error).slice(0, 300), code: error?.code ?? "INTERNAL" };
  }
  await ctx.db.insert(invocations, {
    businessId, agentId: agent.id, ...(callId ? { callId } : {}), conversationId: conversation.id, capability, args: given,
    decision: "allowed", status: out.ok ? "succeeded" : "failed", result: out, ...(out.ok ? {} : { error: String(out.error ?? "failed").slice(0, 500) }),
    idempotencyKey, at: Date.now(),
  });
  return out;
}

export const lookupContact = app.mutation({
  access: "voice.tools",
  args: { ...Acting },
  returns: Result,
  capability: { name: "contacts.lookup", description: "Who the agent is talking to: name if known, upcoming appointments, text opt-out." },
  handler: (ctx, args) => invoke(ctx, "contacts.lookup", args, async ({ contact, business: b }) => {
    const upcoming = (await ctx.db.find(appointments, { contactId: contact.id })).filter((a) => a.status === "booked" && a.startsAt > Date.now());
    return { ok: true, known: Boolean(contact.name), name: contact.name ?? null, phone: contact.phone, textsAllowed: !contact.smsOptOut, upcomingAppointments: upcoming.map((a) => describeSlot(a.startsAt, b.timezone)) };
  }),
});

export const businessInfo = app.mutation({
  access: "voice.tools",
  args: { ...Acting },
  returns: Result,
  capability: { name: "business.info", description: "The business's name, description, opening hours and whether it is open now." },
  handler: (ctx, args) => invoke(ctx, "business.info", args, async ({ business: b }) => ({
    ok: true, name: b.name, about: b.about, timezone: b.timezone, openNow: isOpen(b.hours, b.timezone, Date.now()),
    hours: b.hours.map((h) => `${h.day} ${h.open}-${h.close}`), appointmentMinutes: b.appointmentMinutes,
  })),
});

export const availability = app.mutation({
  access: "voice.tools",
  args: { ...Acting, date: s.optional(s.string({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })), days: s.optional(s.integer({ minimum: 1, maximum: 14 })) },
  returns: Result,
  capability: { name: "appointments.availability", description: "Free appointment slots from a date (default today) for a number of days, in the business's time zone." },
  handler: (ctx, args) => invoke(ctx, "appointments.availability", args, async ({ business: b }) => {
    const now = Date.now();
    const start = args.date ?? localParts(now, b.timezone).date;
    const booked = new Set((await ctx.db.find(appointments, { status: "booked" })).map((a) => a.slot));
    const days = [];
    for (let i = 0; i < (args.days ?? 3); i++) {
      const date = addDays(start, i);
      const slots = freeSlots({ hours: b.hours, timezone: b.timezone, date, minutes: b.appointmentMinutes, booked, now });
      if (slots.length) days.push({ date, weekday: localParts(localToEpoch(date, "12:00", b.timezone), b.timezone).day, slots: slots.map((s) => s.time) });
    }
    return { ok: true, timezone: b.timezone, days };
  }),
});

/**
 * Book a slot for the contact. The slot must be inside opening hours, in the future and free; the
 * unique slot key makes a double booking impossible even under concurrent calls.
 */
export const book = app.mutation({
  access: "voice.tools",
  args: { ...Acting, slot: s.string({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$" }), name: s.optional(s.string({ minLength: 1, maxLength: 120 })), reason: s.optional(s.string({ maxLength: 300 })) },
  returns: Result,
  capability: { name: "appointments.book", description: "Book an appointment slot (YYYY-MM-DDTHH:MM, business time) for the caller." },
  handler: (ctx, args) => invoke(ctx, "appointments.book", args, async ({ business: b, contact, callId, agentId, agentName }) => {
    const [date, time] = args.slot.split("T") as [string, string];
    const now = Date.now();
    const booked = new Set((await ctx.db.find(appointments, { status: "booked" })).map((a) => a.slot));
    const free = freeSlots({ hours: b.hours, timezone: b.timezone, date, minutes: b.appointmentMinutes, booked: new Set(), now });
    if (!free.some((x) => x.time === time)) return { ok: false, error: `${args.slot} is not a bookable time (outside opening hours, in the past, or not on a ${b.appointmentMinutes}-minute boundary).` };
    if (booked.has(args.slot)) return { ok: false, error: `${args.slot} is already booked.` };
    const startsAt = localToEpoch(date, time, b.timezone);
    if (args.name && !contact.name) await ctx.db.patch(contacts, contact.id, { name: args.name });
    const id = await ctx.db.insert(appointments, {
      businessId: b.businessId, contactId: contact.id, startsAt, endsAt: startsAt + b.appointmentMinutes * 60_000, slot: args.slot, status: "booked",
      ...(args.reason ? { reason: args.reason } : {}), bookedBy: agentId, ...(callId ? { callId } : {}), createdAt: now,
    });
    const when = describeSlot(startsAt, b.timezone);
    await recordAudit(ctx, b.businessId, agentId, "agent", "appointment.booked", `${agentName} booked ${when} for ${args.name ?? contact.name ?? contact.phone}`, id);
    ctx.afterCommit.webhooks.emit("appointment.booked", { businessId: b.businessId, appointmentId: id, contactId: contact.id, slot: args.slot, startsAt, callId: callId ?? null, at: now });
    return { ok: true, appointmentId: id, slot: args.slot, when };
  }),
});

export const followup = app.mutation({
  access: "voice.tools",
  args: { ...Acting, title: s.string({ minLength: 1, maxLength: 200 }), detail: s.optional(s.string({ maxLength: 2000 })) },
  returns: Result,
  capability: { name: "followups.create", description: "Create a follow-up task for staff (a message for someone, a callback)." },
  handler: (ctx, args) => invoke(ctx, "followups.create", args, async ({ business: b, contact, conversation, callId, agentId, agentName }) => {
    const id = await ctx.db.insert(tasks, { businessId: b.businessId, title: args.title, ...(args.detail ? { detail: args.detail } : {}), contactId: contact.id, conversationId: conversation.id, ...(callId ? { callId } : {}), status: "open", createdBy: agentId, createdByKind: "agent", createdAt: Date.now() });
    await recordAudit(ctx, b.businessId, agentId, "agent", "followup.created", `${agentName}: ${args.title}`, id);
    ctx.afterCommit.webhooks.emit("followup.created", { businessId: b.businessId, taskId: id, contactId: contact.id, callId: callId ?? null, reason: "agent", at: Date.now() });
    return { ok: true, taskId: id };
  }),
});

/**
 * Text the contact. Queued here under the business's policy; the runtime then hands it to the
 * provider and tells the agent whether the provider accepted it. "queued" is not "sent".
 */
export const sendSms = app.mutation({
  access: "voice.tools",
  args: { ...Acting, body: s.string({ minLength: 1, maxLength: 1000 }) },
  returns: Result,
  capability: { name: "sms.send", description: "Text the person the agent is talking to (policy-checked; returns queued or blocked with the reason)." },
  handler: (ctx, args) => invoke(ctx, "sms.send", args, async ({ business: b, contact, conversation, callId, agentId }) => {
    const r = await queueSms(ctx, { business: b, conversation, contact, body: args.body, author: agentId, authorKind: "agent", idempotencyKey: `tool:${args.agentId}:${args.toolCallId}`, ...(callId ? { callId } : {}), now: Date.now() });
    return r.status === "queued" ? { ok: true, status: "queued", messageId: r.messageId } : { ok: false, status: "blocked", messageId: r.messageId, error: r.reason };
  }),
});

/** Ask to transfer the call to one of the business's escalation contacts (the agent's default if none is named). */
export const transfer = app.mutation({
  access: "voice.tools",
  args: { ...Acting, escalationId: s.optional(s.string({ maxLength: 32 })), reason: s.string({ minLength: 1, maxLength: 200 }) },
  returns: Result,
  capability: { name: "calls.transfer", description: "Transfer the current call to one of the business's escalation contacts." },
  handler: (ctx, args) => invoke(ctx, "calls.transfer", args, async ({ business: b, callId, agentId, agentName }) => {
    if (!callId) return { ok: false, error: "There is no call to transfer." };
    const agent = (await ctx.db.get(agents, agentId))!;
    const target = b.escalation.find((e) => e.id === (args.escalationId ?? agent.escalateTo)) ?? b.escalation[0];
    if (!target) return { ok: false, error: "The business has no escalation contact to transfer to." };
    await ctx.db.patch(calls, callId, { transfer: { to: target.phone, toName: target.name, status: "requested", reason: args.reason, by: agentId, at: Date.now() } });
    await recordAudit(ctx, b.businessId, agentId, "agent", "call.transfer", `${agentName} transferring to ${target.name}: ${args.reason}`, callId);
    return { ok: true, status: "requested", to: target.name };
  }),
});

export const history = app.mutation({
  access: "voice.tools",
  args: { ...Acting, limit: s.optional(s.integer({ minimum: 1, maximum: 20 })) },
  returns: Result,
  capability: { name: "conversations.history", description: "Recent texts and call summaries with this contact." },
  handler: (ctx, args) => invoke(ctx, "conversations.history", args, async ({ conversation, callId }) => {
    const n = args.limit ?? 8;
    const texts = (await ctx.db.find(messages, { conversationId: conversation.id, kind: "sms" }, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: n })).map((m) => ({ at: new Date(m.createdAt).toISOString(), from: m.direction === "inbound" ? "contact" : "business", text: m.body }));
    const past = (await ctx.db.find(calls, { conversationId: conversation.id }, { orderBy: [{ field: "startedAt", direction: "desc" }], limit: n })).filter((c) => c.id !== callId).map((c) => ({ at: new Date(c.startedAt).toISOString(), direction: c.direction, outcome: c.outcome ?? c.status, summary: c.summary ?? null }));
    return { ok: true, texts, calls: past };
  }),
});

export function describeSlot(at: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(at));
}
