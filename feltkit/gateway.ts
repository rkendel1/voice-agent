/**
 * The voice runtime's contract with the application: provider-independent events in, durable work out.
 * Called only by the voice runtime (role "voice"), in the business the event belongs to (resolved by
 * gateway:route from the phone number), after the provider adapter verified the request's signature.
 *
 * Durability rules, enforced here in one transaction per event:
 *   - Every provider event is recorded once in providerEvents (provider, key). A repeated or replayed
 *     webhook finds its key and changes nothing; the answer is the same as the first time.
 *   - Statuses only move forward (_policy.ts): a late or out-of-order callback cannot undo a later one.
 *   - Work the runtime must do later (send, dial, reply, summarise) is queued in the same transaction.
 */
import { fail, s, type MutationCtx } from "@feltdb/feltkit";
import { agents, app, appointments, calls, contacts, conversations, invocations, messages, numberRoutes, phoneNumbers, providerEvents, runtimeStatus, transcripts, work } from "./app.js";
import { business } from "./_authz.js";
import { enqueue, ensureContact, ensureConversation, loadBusiness, queueSms, recordAudit, touchConversation } from "./_ops.js";
import { agentOnDuty, CALL_TERMINAL, callAdvances, isOpen, localParts, smsAdvances, smsKeyword } from "./_policy.js";
import { VOICE_RUNTIME } from "./business.js";

const Provider = s.enum(["twilio", "simulator"]);
const RUNTIME = VOICE_RUNTIME;

/** Record a provider event once. Returns the earlier outcome when it was seen before. */
async function once(ctx: MutationCtx, provider: "twilio" | "simulator", key: string, kind: string, businessId: string | undefined): Promise<{ seen: string } | null> {
  const [seen] = await ctx.db.find(providerEvents, { provider, key });
  if (seen) return { seen: seen.outcome };
  await ctx.db.insert(providerEvents, { provider, key, kind, ...(businessId ? { businessId } : {}), outcome: "processing", at: Date.now() });
  return null;
}
async function settle(ctx: MutationCtx, provider: "twilio" | "simulator", key: string, outcome: string) {
  const [e] = await ctx.db.find(providerEvents, { provider, key });
  if (e) await ctx.db.patch(providerEvents, e.id, { outcome: outcome.slice(0, 200) });
}

// ── Routing and runtime health (no business yet) ────────────────────────────

/** Which business a number belongs to. Unknown numbers are null: the runtime answers them with nothing. */
export const route = app.query({
  access: "voice.route",
  args: { to: s.string({ maxLength: 32 }) },
  handler: async (ctx, { to }) => {
    const [r] = await ctx.db.find(numberRoutes, { e164: to });
    return r ? { businessId: r.businessId, numberId: r.numberId, provider: r.provider } : null;
  },
});

export const heartbeat = app.mutation({
  access: "voice.work",
  args: { provider: Provider, ready: s.boolean(), problems: s.array(s.string({ maxLength: 300 }), { maxItems: 20 }), publicBaseUrl: s.optional(s.string({ maxLength: 300 })), url: s.optional(s.string({ maxLength: 300 })), simulator: s.optional(s.boolean()), signatureFailures: s.integer({ minimum: 0 }), lastWebhookAt: s.optional(s.number()), startedAt: s.number() },
  handler: async (ctx, args) => {
    const [row] = await ctx.db.find(runtimeStatus, {});
    const value = { ...args, heartbeatAt: Date.now() };
    if (row) await ctx.db.replace(runtimeStatus, row.id, value);
    else await ctx.db.insert(runtimeStatus, value);
  },
});

export const status = app.query({
  access: "voice.work",
  handler: async (ctx) => (await ctx.db.find(runtimeStatus, {}))[0] ?? null,
});

/**
 * Lease due work: pending items, and leased items whose lease expired (a runtime that stopped
 * mid-work). The runtime finishes each with finishWork; an item that keeps failing is given up.
 */
export const claimWork = app.mutation({
  access: "voice.work",
  args: { limit: s.integer({ minimum: 1, maximum: 50 }), leaseMs: s.integer({ minimum: 1000, maximum: 600_000 }) },
  handler: async (ctx, { limit, leaseMs }) => {
    const now = Date.now();
    const due = [
      ...(await ctx.db.find(work, { status: "pending" }, { limit: 200 })),
      ...(await ctx.db.find(work, { status: "leased" }, { limit: 200 })).filter((w) => w.leaseUntil < now),
    ].sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
    for (const w of due) await ctx.db.patch(work, w.id, { status: "leased", leaseUntil: now + leaseMs, attempts: w.attempts + 1, updatedAt: now });
    return due.map((w) => ({ id: w.id, businessId: w.businessId, kind: w.kind, refId: w.refId, attempts: w.attempts + 1, resumed: w.status === "leased" }));
  },
});

export const finishWork = app.mutation({
  access: "voice.work",
  args: { id: s.string(), outcome: s.enum(["done", "retry", "failed"]), error: s.optional(s.string({ maxLength: 300 })), retryInMs: s.optional(s.integer({ minimum: 0, maximum: 3_600_000 })) },
  handler: async (ctx, { id, outcome, error, retryInMs }) => {
    const w = await ctx.db.get(work, id);
    if (!w) return;
    const now = Date.now();
    if (outcome === "retry" && w.attempts < 6) await ctx.db.patch(work, id, { status: "leased", leaseUntil: now + (retryInMs ?? 2000 * 2 ** w.attempts), ...(error ? { lastError: error } : {}), updatedAt: now });
    else await ctx.db.patch(work, id, { status: outcome === "done" ? "done" : "failed", ...(error ? { lastError: error } : {}), updatedAt: now });
  },
});

// ── Texts ──────────────────────────────────────────────────────────────────

/**
 * A text arrived. Contact and conversation are found or created; STOP/START/HELP change consent
 * (the provider sends the carrier-required reply, see gateway/providers); otherwise the answering
 * agent is asked to reply when it may.
 */
export const inboundSms = app.mutation({
  access: "voice.ingest",
  args: { provider: Provider, sid: s.string({ maxLength: 64 }), from: s.string({ maxLength: 32 }), to: s.string({ maxLength: 32 }), body: s.string({ maxLength: 1600 }), media: s.array(s.object({ url: s.string({ maxLength: 1000 }), contentType: s.string({ maxLength: 100 }) }), { maxItems: 10 }) },
  handler: async (ctx, a) => {
    const { businessId } = business(ctx);
    const key = `sms:${a.sid}`;
    const seen = await once(ctx, a.provider, key, "sms.inbound", businessId);
    if (seen) return { duplicate: true, outcome: seen.seen };
    const b = await loadBusiness(ctx);
    const now = Date.now();
    const contact = await ensureContact(ctx, businessId, a.from, now);
    const conversation = await ensureConversation(ctx, businessId, contact.id, now);
    const messageId = await ctx.db.insert(messages, {
      businessId, conversationId: conversation.id, kind: "sms", direction: "inbound", body: a.body, media: a.media, status: "received",
      from: a.from, to: a.to, provider: a.provider, providerSid: a.sid, author: "contact", authorKind: "contact", createdAt: now, updatedAt: now,
    });
    await touchConversation(ctx, conversation, "sms", a.body || "(attachment)", 1, now);
    ctx.afterCommit.webhooks.emit("message.received", { businessId, conversationId: conversation.id, messageId, contactId: contact.id, at: now });
    const keyword = smsKeyword(a.body);
    let outcome = "stored";
    if (keyword === "stop" && !contact.smsOptOut) {
      await ctx.db.patch(contacts, contact.id, { smsOptOut: true });
      await recordAudit(ctx, businessId, a.from, "provider", "contact.consent", `${a.from} opted out of texts (STOP)`, contact.id);
      ctx.afterCommit.webhooks.emit("contact.opted_out", { businessId, contactId: contact.id, at: now });
      outcome = "opted_out";
    } else if (keyword === "start" && contact.smsOptOut) {
      await ctx.db.patch(contacts, contact.id, { smsOptOut: false });
      await recordAudit(ctx, businessId, a.from, "provider", "contact.consent", `${a.from} opted back in to texts (START)`, contact.id);
      outcome = "opted_in";
    } else if (!keyword) {
      const [number] = await ctx.db.find(phoneNumbers, { e164: a.to });
      const agent = number?.agentId ? await ctx.db.get(agents, number.agentId) : null;
      if (agent?.active && agent.smsAutoReply && !contact.smsOptOut && agentOnDuty(agent.schedule, isOpen(b.hours, b.timezone, now))) {
        await enqueue(ctx, businessId, "agent.sms", messageId, now);
        outcome = "agent_reply_queued";
      }
    }
    await settle(ctx, a.provider, key, outcome);
    return { duplicate: false, outcome, messageId, conversationId: conversation.id, keyword };
  },
});

/** A delivery report. Out-of-order and repeated reports cannot move a message backwards. */
export const smsStatus = app.mutation({
  access: "voice.ingest",
  args: { provider: Provider, sid: s.string({ maxLength: 64 }), status: s.string({ maxLength: 32 }), errorCode: s.optional(s.string({ maxLength: 16 })) },
  handler: async (ctx, a) => {
    const { businessId } = business(ctx);
    const key = `sms-status:${a.sid}:${a.status}`;
    if (await once(ctx, a.provider, key, "sms.status", businessId)) return { duplicate: true, applied: false };
    const [m] = await ctx.db.find(messages, { providerSid: a.sid });
    const map: Record<string, string> = { accepted: "sent", queued: "sent", sending: "sent", sent: "sent", delivered: "delivered", undelivered: "undelivered", failed: "failed", read: "delivered" };
    const next = map[a.status];
    if (!m || !next || !smsAdvances(m.status, next)) { await settle(ctx, a.provider, key, m ? "stale" : "unmatched"); return { duplicate: false, applied: false }; }
    await ctx.db.patch(messages, m.id, { status: next as any, ...(a.errorCode ? { error: `Provider error ${a.errorCode}` } : {}), updatedAt: Date.now() });
    if (next === "failed" || next === "undelivered") await recordAudit(ctx, businessId, "provider", "provider", "sms.failed", `Text to ${m.to} ${next}${a.errorCode ? ` (error ${a.errorCode})` : ""}`, m.id);
    await settle(ctx, a.provider, key, next);
    return { duplicate: false, applied: true };
  },
});

/** Claim a queued text for sending: queued → sending. Anything else (sent, blocked, already sending) is not sent again. */
export const sendClaim = app.mutation({
  access: "voice.work",
  args: { messageId: s.string(), resumed: s.optional(s.boolean()) },
  handler: async (ctx, { messageId, resumed }) => {
    const m = await ctx.db.get(messages, messageId);
    if (!m) return { send: false as const, status: "missing" };
    // A runtime stopped after handing it to the provider and before recording the answer: it may have been
    // sent. Recorded as unknown, never sent again (a person can check the provider and resend).
    if (m.status === "sending" && resumed) {
      await ctx.db.patch(messages, m.id, { status: "unknown", error: "The runtime stopped while sending: it may or may not have been sent.", updatedAt: Date.now() });
      return { send: false as const, status: "unknown" };
    }
    if (m.status !== "queued") return { send: false as const, status: m.status };
    const c = await ctx.db.get(contacts, (await ctx.db.get(conversations, m.conversationId))!.contactId);
    // Consent can change between queueing and sending: STOP wins.
    if (c?.smsOptOut) {
      await ctx.db.patch(messages, m.id, { status: "blocked", error: "The contact opted out before it was sent.", updatedAt: Date.now() });
      return { send: false as const, status: "blocked" };
    }
    await ctx.db.patch(messages, m.id, { status: "sending", updatedAt: Date.now() });
    return { send: true as const, to: m.to!, from: m.from!, body: m.body, provider: m.provider!, idempotencyKey: m.idempotencyKey ?? m.id };
  },
});

/**
 * The provider's answer to a send. Accepted: the receipt (provider id) is stored. Refused: failed with
 * the reason. Unknown (the request may or may not have reached the provider): "unknown", never retried
 * automatically, because a retry could text the person twice.
 */
export const sendResult = app.mutation({
  access: "voice.work",
  args: { messageId: s.string(), outcome: s.enum(["accepted", "refused", "unknown"]), providerSid: s.optional(s.string({ maxLength: 64 })), error: s.optional(s.string({ maxLength: 300 })), retryable: s.optional(s.boolean()) },
  handler: async (ctx, { messageId, outcome, providerSid, error, retryable }) => {
    const { businessId } = business(ctx);
    const m = (await ctx.db.get(messages, messageId)) ?? fail("NOT_FOUND", "Message not found.");
    if (m.status !== "sending") return { status: m.status };
    // It never reached the provider (unreachable, rate-limited): back to the queue, safe to try again.
    if (outcome === "refused" && retryable) { await ctx.db.patch(messages, m.id, { status: "queued", ...(error ? { error } : {}), updatedAt: Date.now() }); return { status: "queued" }; }
    const status = outcome === "accepted" ? "sent" : outcome === "refused" ? "failed" : "unknown";
    await ctx.db.patch(messages, m.id, { status, ...(providerSid ? { providerSid } : {}), ...(error ? { error } : {}), updatedAt: Date.now() });
    if (status !== "sent") await recordAudit(ctx, businessId, RUNTIME, "system", "sms.failed", `Text to ${m.to} ${status}: ${error ?? ""}`.trim(), m.id);
    else await recordAudit(ctx, businessId, RUNTIME, "system", "sms.sent", `Text to ${m.to} accepted by the provider`, m.id);
    return { status };
  },
});

/** What the SMS agent needs to answer an inbound text, or skip:true when it should not (opted out since, answered, agent off). */
export const smsAgentContext = app.query({
  access: "voice.work",
  args: { messageId: s.string() },
  handler: async (ctx, { messageId }) => {
    const m = await ctx.db.get(messages, messageId);
    if (!m || m.direction !== "inbound") return { skip: true as const, reason: "missing" };
    const conv = (await ctx.db.get(conversations, m.conversationId))!;
    const contact = (await ctx.db.get(contacts, conv.contactId))!;
    const [number] = await ctx.db.find(phoneNumbers, { e164: m.to ?? "" });
    const agent = number?.agentId ? await ctx.db.get(agents, number.agentId) : null;
    if (!agent?.active || contact.smsOptOut) return { skip: true as const, reason: contact.smsOptOut ? "opted out" : "no active agent" };
    const later = (await ctx.db.find(messages, { conversationId: conv.id })).some((x) => x.direction === "outbound" && x.createdAt > m.createdAt && x.authorKind !== "agent");
    if (later) return { skip: true as const, reason: "a person already answered" };
    return { skip: false as const, agentId: agent.id, conversationId: conv.id };
  },
});

// ── Calls ──────────────────────────────────────────────────────────────────

const LIVE = new Set(["queued", "initiated", "ringing", "in-progress"]);

async function voiceSettings(ctx: MutationCtx, agentId: string | undefined) {
  const b = await loadBusiness(ctx);
  const agent = agentId ? await ctx.db.get(agents, agentId) : null;
  return {
    greeting: agent?.greeting ?? `Thanks for calling ${b.name}.`,
    disclosure: b.policy.transcripts ? b.policy.disclosure : "",
    voice: agent?.voice ?? { ttsProvider: "ElevenLabs" as const, language: "en-US" },
  };
}

/**
 * A call came in. Decide how it is handled, from configuration: the number's agent if it is active and
 * on duty; otherwise forward to the number's fallback contact; otherwise say the business is unavailable
 * (recorded as missed, which starts the follow-up workflow). A repeated webhook gets the same answer.
 */
export const inboundCall = app.mutation({
  access: "voice.ingest",
  args: { provider: Provider, sid: s.string({ maxLength: 64 }), from: s.string({ maxLength: 32 }), to: s.string({ maxLength: 32 }), sessionTokenHash: s.string({ minLength: 32, maxLength: 128 }) },
  handler: async (ctx, a) => {
    const { businessId } = business(ctx);
    const b = await loadBusiness(ctx);
    const [existing] = await ctx.db.find(calls, { providerSid: a.sid });
    if (existing) return decision(existing, await voiceSettings(ctx, existing.agentId), b, true);
    const now = Date.now();
    const [number] = await ctx.db.find(phoneNumbers, { e164: a.to });
    if (!number) fail("NOT_FOUND", "Number not found.");
    const contact = await ensureContact(ctx, businessId, a.from, now);
    const conversation = await ensureConversation(ctx, businessId, contact.id, now);
    const agent = number.agentId ? await ctx.db.get(agents, number.agentId) : null;
    const open = isOpen(b.hours, b.timezone, now);
    const answers = Boolean(number.voice && agent?.active && agentOnDuty(agent.schedule, open));
    const fallback = !answers && number.fallbackEscalationId ? b.escalation.find((e) => e.id === number.fallbackEscalationId) : undefined;
    const handling = answers ? "agent" : fallback ? "forward" : "voicemail";
    const id = await ctx.db.insert(calls, {
      businessId, conversationId: conversation.id, contactId: contact.id, numberId: number.id, direction: "inbound", provider: a.provider, providerSid: a.sid,
      from: a.from, to: a.to, status: "ringing", handling, ...(answers ? { agentId: agent!.id, sessionTokenHash: a.sessionTokenHash } : {}),
      session: "none", ...(fallback ? { transfer: { to: fallback.phone, toName: fallback.name, status: "dialing" as const, reason: "No agent on duty", by: RUNTIME, at: now } } : {}),
      startedAt: now,
    });
    await touchConversation(ctx, conversation, "call", `Incoming call${answers ? ` · ${agent!.name}` : fallback ? ` · forwarded to ${fallback.name}` : ""}`, 1, now);
    await recordAudit(ctx, businessId, a.from, "provider", "call.inbound", `Call from ${a.from} to ${a.to}: ${handling}${answers ? ` (${agent!.name})` : fallback ? ` → ${fallback.name}` : ""}`, id);
    const call = (await ctx.db.get(calls, id))!;
    return decision(call, await voiceSettings(ctx, call.agentId), b, false);
  },
});

function decision(call: any, v: Awaited<ReturnType<typeof voiceSettings>>, b: any, duplicate: boolean) {
  return {
    duplicate, callId: call.id, handling: call.handling as "agent" | "forward" | "voicemail" | "operator",
    forwardTo: call.handling === "forward" ? call.transfer?.to ?? null : null,
    unavailable: `Sorry, ${b.name} can't take your call right now. Please call back during business hours, or send us a text.`,
    ...v,
  };
}

/** Claim an outbound call for dialling (queued → initiated), with the session binding. */
export const dialClaim = app.mutation({
  access: "voice.work",
  args: { callId: s.string(), sessionTokenHash: s.string({ minLength: 32, maxLength: 128 }), resumed: s.optional(s.boolean()) },
  handler: async (ctx, { callId, sessionTokenHash, resumed }) => {
    const call = await ctx.db.get(calls, callId);
    if (call && call.status === "initiated" && !call.providerSid && resumed) {
      await ctx.db.patch(calls, callId, { status: "failed", outcome: "failed", summary: "The runtime stopped while dialling: the provider may have placed the call. Not dialled again.", endedAt: Date.now() });
      return { dial: false as const, status: "failed" };
    }
    if (!call || call.status !== "queued") return { dial: false as const, status: call?.status ?? "missing" };
    const contact = (await ctx.db.get(contacts, call.contactId))!;
    if (contact.doNotCall) {
      await ctx.db.patch(calls, callId, { status: "canceled", outcome: "failed", summary: "Not dialled: the contact is on the do-not-call list.", endedAt: Date.now() });
      return { dial: false as const, status: "canceled" };
    }
    await ctx.db.patch(calls, callId, { status: "initiated", sessionTokenHash });
    return { dial: true as const, to: call.to, from: call.from, provider: call.provider, handling: call.handling, ...(await voiceSettings(ctx, call.agentId)) };
  },
});

export const dialResult = app.mutation({
  access: "voice.work",
  args: { callId: s.string(), outcome: s.enum(["accepted", "refused", "unknown"]), providerSid: s.optional(s.string({ maxLength: 64 })), error: s.optional(s.string({ maxLength: 300 })) },
  handler: async (ctx, { callId, outcome, providerSid, error }) => {
    const { businessId } = business(ctx);
    const call = (await ctx.db.get(calls, callId)) ?? fail("NOT_FOUND", "Call not found.");
    if (outcome === "accepted") {
      if (!call.providerSid) await ctx.db.patch(calls, callId, { providerSid });
      return;
    }
    if (CALL_TERMINAL.has(call.status)) return;
    await ctx.db.patch(calls, callId, { status: "failed", outcome: "failed", summary: `Not placed: ${error ?? outcome}`.slice(0, 2000), endedAt: Date.now(), ...(providerSid ? { providerSid } : {}) });
    await recordAudit(ctx, businessId, RUNTIME, "system", "call.failed", `Outbound call to ${call.to} ${outcome === "unknown" ? "outcome unknown" : "refused"}: ${error ?? ""}`, callId);
  },
});

/**
 * A call status callback. Advances only forward. On the call's end: duration, outcome (missed when it
 * was never answered), the follow-up workflow for missed calls, a summary job, and call.completed.
 */
export const callStatus = app.mutation({
  access: "voice.ingest",
  args: { provider: Provider, sid: s.string({ maxLength: 64 }), callId: s.optional(s.string()), status: s.enum(["queued", "initiated", "ringing", "in-progress", "completed", "busy", "no-answer", "failed", "canceled"]), duration: s.optional(s.integer({ minimum: 0 })), sequence: s.optional(s.string({ maxLength: 16 })) },
  handler: async (ctx, a) => {
    const { businessId } = business(ctx);
    const key = `call-status:${a.sid}:${a.status}`;
    if (await once(ctx, a.provider, key, "call.status", businessId)) return { duplicate: true, applied: false };
    let [call] = await ctx.db.find(calls, { providerSid: a.sid });
    if (!call && a.callId) {
      const byId = await ctx.db.get(calls, a.callId);
      if (byId && (!byId.providerSid || byId.providerSid === a.sid)) { await ctx.db.patch(calls, byId.id, { providerSid: a.sid }); call = { ...byId, providerSid: a.sid }; }
    }
    if (!call) { await settle(ctx, a.provider, key, "unmatched"); return { duplicate: false, applied: false }; }
    if (!callAdvances(call.status, a.status)) { await settle(ctx, a.provider, key, "stale"); return { duplicate: false, applied: false }; }
    const now = Date.now();
    const patch: Record<string, unknown> = { status: a.status };
    if (a.status === "in-progress" && !call.answeredAt) patch.answeredAt = now;
    if (CALL_TERMINAL.has(a.status)) {
      patch.endedAt = now;
      if (a.duration !== undefined) patch.durationSec = a.duration;
      if (!call.outcome) patch.outcome = await outcomeOf(ctx, call, a.status);
      if (call.session === "connected") patch.session = "ended";
      if (call.transfer && call.transfer.status !== "failed" && call.handling === "forward") patch.transfer = { ...call.transfer, status: a.status === "completed" ? "completed" : "failed" };
    }
    await ctx.db.patch(calls, call.id, patch);
    if (CALL_TERMINAL.has(a.status)) {
      const ended = (await ctx.db.get(calls, call.id))!;
      await recordAudit(ctx, businessId, a.sid, "provider", "call.ended", `Call ${call.direction === "inbound" ? "from" : "to"} ${call.direction === "inbound" ? call.from : call.to} ended: ${a.status}${ended.outcome ? ` (${ended.outcome})` : ""}`, call.id);
      if (ended.outcome === "missed") ctx.afterCommit.agent("voice", { callId: call.id });
      if ((await ctx.db.query(transcripts, { where: [{ field: "callId", eq: call.id }], limit: 1 })).records.length) await enqueue(ctx, businessId, "call.summarize", call.id, now);
      ctx.afterCommit.webhooks.emit("call.completed", { businessId, callId: call.id, direction: call.direction, status: a.status, outcome: ended.outcome ?? null, durationSec: a.duration ?? null, contactId: call.contactId, at: now });
      const conv = await ctx.db.get(conversations, call.conversationId);
      if (conv) await touchConversation(ctx, conv, "call", `Call ${a.status}${ended.outcome ? ` · ${ended.outcome.replace("_", " ")}` : ""}`, ended.outcome === "missed" ? 1 : 0, now);
    }
    await settle(ctx, a.provider, key, a.status);
    return { duplicate: false, applied: true };
  },
});

async function outcomeOf(ctx: MutationCtx, call: any, status: string) {
  if (status !== "completed" || !call.answeredAt && call.session === "none" && call.handling !== "forward") {
    return status === "failed" ? "failed" : call.direction === "inbound" ? "missed" : "abandoned";
  }
  if (call.transfer?.status === "completed" || call.transfer?.status === "dialing") return "transferred";
  if ((await ctx.db.find(appointments, { callId: call.id })).some((x) => x.status === "booked")) return "appointment_booked";
  if ((await ctx.db.find(invocations, { callId: call.id })).some((i) => i.capability === "followups.create" && i.status === "succeeded")) return "message_taken";
  return "resolved";
}

/**
 * The media session opened (the provider connected the WebSocket). The session token binds it to this
 * call: a connection with another token, or for an ended call, is refused.
 */
export const sessionOpened = app.mutation({
  access: "voice.ingest",
  args: { callId: s.string(), sessionTokenHash: s.string({ minLength: 32, maxLength: 128 }), providerSid: s.optional(s.string({ maxLength: 64 })) },
  handler: async (ctx, { callId, sessionTokenHash, providerSid }) => {
    const call = (await ctx.db.get(calls, callId)) ?? fail("NOT_FOUND", "Not found.");
    if (!call.sessionTokenHash || call.sessionTokenHash !== sessionTokenHash) fail("FORBIDDEN", "This media session is not bound to that call.");
    if (!LIVE.has(call.status)) fail("FAILED_PRECONDITION", "The call has ended.");
    if (providerSid && call.providerSid && providerSid !== call.providerSid) fail("FORBIDDEN", "The media session belongs to another call.");
    const now = Date.now();
    await ctx.db.patch(calls, callId, { session: "connected", status: "in-progress", ...(call.answeredAt ? {} : { answeredAt: now }), ...(providerSid && !call.providerSid ? { providerSid } : {}) });
    // Turns are numbered from where the record ends: a reconnected session continues the transcript.
    const [last] = (await ctx.db.query(transcripts, { where: [{ field: "callId", eq: callId }], orderBy: [{ field: "seq", direction: "desc" }], limit: 1 })).records;
    return { agentId: call.agentId ?? null, transcriptSegments: last ? last.seq + 1 : 0 };
  },
});

/** The media session ended: by us ("ended") or the connection dropped ("lost"). The call's status still comes from the provider. */
export const sessionClosed = app.mutation({
  access: "voice.ingest",
  args: { callId: s.string(), reason: s.enum(["ended", "lost"]) },
  handler: async (ctx, { callId, reason }) => {
    const call = (await ctx.db.get(calls, callId)) ?? fail("NOT_FOUND", "Not found.");
    // A close on a call that already ended (the caller hung up) is an ordinary end, not a lost connection.
    if (call.session === "connected") await ctx.db.patch(calls, callId, { session: CALL_TERMINAL.has(call.status) ? "ended" : reason });
  },
});

/** One transcript turn. Stored only when the business keeps transcripts; a repeated seq is a no-op. */
export const transcript = app.mutation({
  access: "voice.ingest",
  args: { callId: s.string(), seq: s.integer({ minimum: 0 }), speaker: s.enum(["caller", "agent", "operator", "system"]), text: s.string({ maxLength: 4000 }), interrupted: s.boolean(), partial: s.boolean() },
  handler: async (ctx, a) => {
    const { businessId } = business(ctx);
    const b = await loadBusiness(ctx);
    (await ctx.db.get(calls, a.callId)) ?? fail("NOT_FOUND", "Not found.");
    if (!b.policy.transcripts) return { stored: false };
    if ((await ctx.db.find(transcripts, { callId: a.callId, seq: a.seq })).length) return { stored: false, duplicate: true };
    await ctx.db.insert(transcripts, { businessId, callId: a.callId, seq: a.seq, speaker: a.speaker, text: a.text, interrupted: a.interrupted, partial: a.partial, at: Date.now() });
    return { stored: true };
  },
});

/** What the agent needs to converse: its profile, the business, the contact, recent history, the time. */
export const context = app.query({
  access: "voice.work",
  args: { agentId: s.string(), callId: s.optional(s.string()), conversationId: s.optional(s.string()) },
  handler: async (ctx, { agentId, callId, conversationId }) => {
    const agent = (await ctx.db.get(agents, agentId)) ?? fail("NOT_FOUND", "Agent not found.");
    const b = await loadBusiness(ctx);
    const call = callId ? (await ctx.db.get(calls, callId)) ?? fail("NOT_FOUND", "Call not found.") : null;
    const conv = (await ctx.db.get(conversations, call?.conversationId ?? conversationId ?? "")) ?? fail("NOT_FOUND", "Conversation not found.");
    const contact = (await ctx.db.get(contacts, conv.contactId))!;
    const texts = (await ctx.db.find(messages, { conversationId: conv.id, kind: "sms" }, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 12 })).reverse();
    const now = Date.now();
    const local = localParts(now, b.timezone);
    return {
      agent: { id: agent.id, name: agent.name, purpose: agent.purpose, instructions: agent.instructions, brain: agent.brain, temperature: agent.temperature, capabilities: agent.capabilities, escalateTo: agent.escalateTo ?? null, voice: agent.voice },
      business: { name: b.name, about: b.about, timezone: b.timezone, hours: b.hours, openNow: isOpen(b.hours, b.timezone, now), escalation: b.escalation.map((e) => ({ id: e.id, name: e.name })), appointmentMinutes: b.appointmentMinutes },
      contact: { name: contact.name ?? null, phone: contact.phone, smsOptOut: contact.smsOptOut },
      conversationId: conv.id,
      texts: texts.map((m) => ({ direction: m.direction, body: m.body, at: m.createdAt, status: m.status })),
      now: { iso: new Date(now).toISOString(), date: local.date, time: local.time, day: local.day },
    };
  },
});

/** Operator control waiting for a live call, its transfer, and whether a person has taken it over. */
export const controls = app.query({
  access: "voice.work",
  args: { callId: s.string() },
  handler: async (ctx, { callId }) => {
    const call = await ctx.db.get(calls, callId);
    if (!call) return null;
    return { status: call.status, control: call.control && !call.control.applied ? call.control : null, takenOver: call.takenOver ?? null, transfer: call.transfer ?? null };
  },
});

export const controlApplied = app.mutation({
  access: "voice.work",
  args: { callId: s.string(), seq: s.integer() },
  handler: async (ctx, { callId, seq }) => {
    const call = await ctx.db.get(calls, callId);
    if (call?.control && call.control.seq === seq && !call.control.applied) await ctx.db.patch(calls, callId, { control: { ...call.control, applied: true } });
  },
});

export const transferResult = app.mutation({
  access: "voice.work",
  args: { callId: s.string(), status: s.enum(["dialing", "completed", "failed"]), error: s.optional(s.string({ maxLength: 300 })) },
  handler: async (ctx, { callId, status, error }) => {
    const { businessId } = business(ctx);
    const call = (await ctx.db.get(calls, callId)) ?? fail("NOT_FOUND", "Not found.");
    if (!call.transfer || call.transfer.status === status) return;
    await ctx.db.patch(calls, callId, { transfer: { ...call.transfer, status }, ...(status !== "failed" ? { handling: "forward" as const } : {}) });
    await recordAudit(ctx, businessId, RUNTIME, "system", "call.transfer", `Transfer to ${call.transfer.toName}: ${status}${error ? ` (${error})` : ""}`, callId);
  },
});

/** A tool the authorization policy refused: recorded as a denied invocation, so the refusal is auditable. */
export const toolDenied = app.mutation({
  access: "voice.ingest",
  args: { agentId: s.string(), callId: s.optional(s.string()), conversationId: s.optional(s.string()), capability: s.string({ maxLength: 64 }), toolCallId: s.string({ maxLength: 120 }), reason: s.string({ maxLength: 300 }), args: s.record(s.unknown()) },
  handler: async (ctx, a) => {
    const { businessId } = business(ctx);
    const idempotencyKey = `${a.agentId}:${a.toolCallId}`;
    if ((await ctx.db.find(invocations, { idempotencyKey })).length) return;
    const call = a.callId ? await ctx.db.get(calls, a.callId) : null;
    await ctx.db.insert(invocations, { businessId, agentId: a.agentId, ...(call ? { callId: call.id, conversationId: call.conversationId } : a.conversationId ? { conversationId: a.conversationId } : {}), capability: a.capability, args: a.args, decision: "denied", status: "denied", error: a.reason, idempotencyKey, at: Date.now() });
    await recordAudit(ctx, businessId, a.agentId, "agent", "agent.denied", `Refused ${a.capability}: ${a.reason}`, call?.id ?? a.conversationId);
  },
});

export const summaryContext = app.query({
  access: "voice.work",
  args: { callId: s.string() },
  handler: async (ctx, { callId }) => {
    const call = await ctx.db.get(calls, callId);
    if (!call) return null;
    const turns = await ctx.db.find(transcripts, { callId }, { orderBy: [{ field: "seq", direction: "asc" }] });
    const actions = await ctx.db.find(invocations, { callId });
    // A text's outcome is its message's status now (delivered, failed…), not what the tool returned when it queued it.
    const statusOf = async (i: any) => {
      const id = i.capability === "sms.send" ? (i.result as any)?.messageId : null;
      const m = typeof id === "string" ? await ctx.db.get(messages, id) : null;
      return m ? { ...(i.result ?? {}), status: m.status } : i.result ?? null;
    };
    for (const a of actions as any[]) a.result = await statusOf(a);
    return { call: { id: call.id, direction: call.direction, outcome: call.outcome ?? null, summary: call.summary ?? null, agentId: call.agentId ?? null }, turns: turns.map((t) => ({ speaker: t.speaker, text: t.text })), actions: actions.map((i) => ({ capability: i.capability, status: i.status, result: i.result ?? null, error: i.error ?? null })) };
  },
});

export const recordSummary = app.mutation({
  access: "voice.work",
  args: { callId: s.string(), summary: s.string({ maxLength: 2000 }) },
  handler: async (ctx, { callId, summary }) => {
    const call = await ctx.db.get(calls, callId);
    if (call && !call.summary) await ctx.db.patch(calls, callId, { summary });
  },
});

/** Delete transcripts older than the business's retention period. */
export const purge = app.mutation({
  access: "voice.work",
  handler: async (ctx) => {
    const { businessId } = business(ctx);
    const b = await loadBusiness(ctx);
    const cutoff = Date.now() - b.policy.transcriptRetentionDays * 24 * 3600_000;
    const old = await ctx.db.query(transcripts, { where: [{ field: "at", lt: cutoff }], limit: 500 });
    for (const t of old.records) await ctx.db.delete(transcripts, t.id);
    if (old.records.length) await recordAudit(ctx, businessId, RUNTIME, "system", "retention.purged", `Deleted ${old.records.length} transcript turns older than ${b.policy.transcriptRetentionDays} days`);
    return { deleted: old.records.length };
  },
});

/**
 * The telephony settings an operator sets in Studio → Services → Configuration (no code, no redeploy):
 *   TELEPHONY_PROVIDER  "simulator" (default) or "twilio"
 *   TWILIO_ACCOUNT_SID  the Twilio account (its auth token is the credential twilio-auth-token)
 *   PUBLIC_BASE_URL     the https URL Twilio reaches this runtime at (webhooks and media)
 * Read by the runtime with its own configuration.read permission.
 */
export const settings = app.query({
  access: "voice.work",
  handler: async (ctx) => {
    const get = async (name: string) => (await ctx.services.configuration.get(name).catch(() => null)) ?? null;
    return { provider: (await get("TELEPHONY_PROVIDER")) ?? null, twilioAccountSid: await get("TWILIO_ACCOUNT_SID"), publicBaseUrl: await get("PUBLIC_BASE_URL") };
  },
});

/** How to answer an outbound call the provider has just connected (Twilio requests the answer URL). */
export const answerPlan = app.query({
  access: "voice.work",
  args: { callId: s.string() },
  handler: async (ctx, { callId }) => {
    const call = await ctx.db.get(calls, callId);
    if (!call || CALL_TERMINAL.has(call.status)) return null;
    const b = await loadBusiness(ctx);
    const agent = call.agentId ? await ctx.db.get(agents, call.agentId) : null;
    return { callId: call.id, handling: call.handling, from: call.from, to: call.to, greeting: call.direction === "inbound" ? agent?.greeting ?? `Thanks for calling ${b.name}.` : agent ? `Hello, this is ${agent.name} calling from ${b.name}.` : `Hello, this is ${b.name}.`, disclosure: b.policy.transcripts ? b.policy.disclosure : "", voice: agent?.voice ?? { ttsProvider: "ElevenLabs" as const, language: "en-US" } };
  },
});

/** The SMS agent's answer to an inbound text: sent through the same policy path as any text. */
export const agentReply = app.mutation({
  access: "voice.work",
  args: { messageId: s.string(), agentId: s.string(), body: s.string({ minLength: 1, maxLength: 1400 }) },
  handler: async (ctx, { messageId, agentId, body }) => {
    const b = await loadBusiness(ctx);
    const inbound = (await ctx.db.get(messages, messageId)) ?? fail("NOT_FOUND", "Message not found.");
    const conversation = (await ctx.db.get(conversations, inbound.conversationId))!;
    const contact = (await ctx.db.get(contacts, conversation.contactId))!;
    return queueSms(ctx, { business: b, conversation, contact, body, author: agentId, authorKind: "agent", idempotencyKey: `agent-reply:${messageId}`, now: Date.now() });
  },
});
