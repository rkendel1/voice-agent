import { fail, s } from "@feltdb/feltkit";
import { agents, app, calls, CAPABILITIES, contacts, conversations, phoneNumbers, tasks } from "./app.js";
import { business } from "./_authz.js";
import { loadBusiness, queueSms, recordAudit } from "./_ops.js";
import { VOICE_RUNTIME } from "./business.js";

/**
 * The voice runtime's identity: a FeltKit application agent. The telephony runtime (gateway/) acts
 * as this principal; a business admits it by adding it as a member ("Connect voice runtime"), and
 * removing that membership revokes everything it can do there on the next call.
 *
 * Its own durable run handles what must happen after a call ends without an answer: a follow-up
 * task for staff and, when the business's policy allows it, a text back. FeltKit delivers the run
 * at least once and commits its writes at most once; the handler is idempotent on the call.
 */
export const voice = app.agent("voice", {
  principal: { id: VOICE_RUNTIME, displayName: "Voice runtime" },
  roles: ["voice"],
  access: "voice.work",
  retry: { maxAttempts: 5, backoffMs: 500 },
  handler: async (ctx, input: { callId: string }) => {
    const call = await ctx.db.get(calls, input.callId);
    if (!call || call.outcome !== "missed") return;
    if ((await ctx.db.find(tasks, { callId: call.id })).length) return; // already handled (a repeated delivery)
    const b = await loadBusiness(ctx);
    const contact = (await ctx.db.get(contacts, call.contactId))!;
    const conversation = (await ctx.db.get(conversations, call.conversationId))!;
    const now = Date.now();
    const taskId = await ctx.db.insert(tasks, {
      businessId: b.businessId, title: `Call back ${contact.name ?? contact.phone}`, detail: `Missed call at ${new Date(call.startedAt).toISOString()}.`,
      contactId: contact.id, conversationId: conversation.id, callId: call.id, status: "open", createdBy: VOICE_RUNTIME, createdByKind: "system", createdAt: now,
    });
    await recordAudit(ctx, b.businessId, VOICE_RUNTIME, "system", "followup.created", `Follow-up: call back ${contact.phone} (missed call)`, taskId);
    ctx.afterCommit.webhooks.emit("followup.created", { businessId: b.businessId, taskId, contactId: contact.id, callId: call.id, reason: "missed_call", at: now });
    if (b.policy.missedCallTextBack && call.direction === "inbound") {
      await queueSms(ctx, { business: b, conversation, contact, body: `Sorry we missed your call. Reply here or call us back at ${call.to}.`, author: VOICE_RUNTIME, authorKind: "system", idempotencyKey: `missed:${call.id}`, callId: call.id, now });
    }
  },
});

const Voice = s.object({ ttsProvider: s.enum(["ElevenLabs", "Google", "Amazon"]), voice: s.optional(s.string({ maxLength: 80 })), language: s.string({ maxLength: 16 }) });

export const list = app.query({
  access: "agents.read",
  handler: async (ctx) => {
    const numbers = await ctx.db.find(phoneNumbers, {});
    return (await ctx.db.find(agents, {}, { orderBy: [{ field: "createdAt", direction: "asc" }] })).map((a) => ({ ...a, numbers: numbers.filter((n) => n.agentId === a.id).map((n) => n.e164) }));
  },
});

/** Create or change an agent. Capabilities are an explicit allow-list; nothing is inherited from the person saving it. */
export const save = app.mutation({
  access: "agents.write",
  args: {
    id: s.optional(s.string()),
    name: s.string({ minLength: 1, maxLength: 60 }),
    purpose: s.string({ maxLength: 200 }),
    instructions: s.string({ maxLength: 8000 }),
    greeting: s.string({ maxLength: 300 }),
    voice: Voice,
    brain: s.enum(["environment", "deterministic"]),
    temperature: s.number({ minimum: 0, maximum: 1 }),
    capabilities: s.array(s.enum(CAPABILITIES), { maxItems: CAPABILITIES.length }),
    escalateTo: s.optional(s.string({ maxLength: 32 })),
    schedule: s.enum(["always", "after_hours", "business_hours"]),
    smsAutoReply: s.boolean(),
    active: s.boolean(),
  },
  returns: s.string(),
  capability: { name: "agents.configure", description: "Create or change a voice/SMS agent: instructions, voice, model, granted capabilities, escalation and schedule." },
  handler: async (ctx, { id, ...fields }) => {
    const { businessId, actor } = business(ctx);
    const b = await loadBusiness(ctx);
    if (fields.escalateTo && !b.escalation.some((e) => e.id === fields.escalateTo)) fail("INVALID_ARGUMENT", `"${fields.escalateTo}" is not one of the business's escalation contacts.`);
    const capabilities = [...new Set(fields.capabilities)];
    const now = Date.now();
    if (id) {
      const existing = (await ctx.db.get(agents, id)) ?? fail("NOT_FOUND", "Agent not found.");
      const changed = (Object.keys(fields) as Array<keyof typeof fields>).filter((k) => JSON.stringify(existing[k]) !== JSON.stringify(k === "capabilities" ? capabilities : fields[k]));
      await ctx.db.patch(agents, id, { ...fields, capabilities, escalateTo: fields.escalateTo || undefined, updatedAt: now });
      if (changed.length) await recordAudit(ctx, businessId, actor, "human", "config.agent", `Agent "${fields.name}" changed: ${changed.join(", ")}`, id);
      return id;
    }
    const newId = await ctx.db.insert(agents, { businessId, ...fields, capabilities, ...(fields.escalateTo ? { escalateTo: fields.escalateTo } : {}), createdAt: now, updatedAt: now });
    await recordAudit(ctx, businessId, actor, "human", "config.agent", `Agent "${fields.name}" created with ${capabilities.length} capabilities`, newId);
    return newId;
  },
});

/** Remove an agent. Numbers it answered stop routing to it (they fall back to their fallback contact or a message). */
export const remove = app.mutation({
  access: "agents.write",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const { businessId, actor } = business(ctx);
    const a = (await ctx.db.get(agents, id)) ?? fail("NOT_FOUND", "Agent not found.");
    for (const n of await ctx.db.find(phoneNumbers, { agentId: id })) await ctx.db.patch(phoneNumbers, n.id, { agentId: undefined });
    await ctx.db.delete(agents, id);
    await recordAudit(ctx, businessId, actor, "human", "config.agent", `Agent "${a.name}" removed`, id);
  },
});

/** Record that an admin connected the voice runtime (after FeltKit's addMember). Refuses if it is not actually a member. */
export const connect = app.mutation({
  access: "tenant.members.manage",
  handler: async (ctx) => {
    const { businessId, actor } = business(ctx);
    const member = (await ctx.tenancy.members()).find((m) => m.principalId === VOICE_RUNTIME);
    if (!member) fail("FAILED_PRECONDITION", "The voice runtime is not a member of this business yet.", { hint: "Add it first: client.addMember(\"voice-runtime\", \"agent\")." });
    await recordAudit(ctx, businessId, actor, "human", "config.runtime", "Voice runtime connected to the business", VOICE_RUNTIME);
    return { connected: true };
  },
});
