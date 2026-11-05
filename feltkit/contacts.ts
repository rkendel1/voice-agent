import { fail, s } from "@feltdb/feltkit";
import { app, appointments, calls, contacts, conversations, tasks } from "./app.js";
import { business } from "./_authz.js";
import { ensureConversation, recordAudit } from "./_ops.js";
import { normalizePhone } from "./_policy.js";

export const list = app.query({
  access: "contacts.read",
  args: { search: s.optional(s.string({ maxLength: 100 })) },
  handler: async (ctx, { search }) => {
    const q = search?.trim();
    const rows = q
      ? await ctx.db.search(contacts, { text: q, limit: 100 })
      : await ctx.db.find(contacts, {}, { orderBy: [{ field: "lastContactAt", direction: "desc" }], limit: 500 });
    const convs = new Map((await ctx.db.find(conversations, {})).map((c) => [c.contactId, c.id]));
    return rows.map((c: any) => ({ ...c, conversationId: convs.get(c.id) ?? null }));
  },
});

export const get = app.query({
  access: "contacts.read",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const c = (await ctx.db.get(contacts, id)) ?? fail("NOT_FOUND", "Contact not found.");
    const [conv] = await ctx.db.find(conversations, { contactId: id });
    const callList = await ctx.db.find(calls, { contactId: id }, { orderBy: [{ field: "startedAt", direction: "desc" }], limit: 20 });
    const appts = await ctx.db.find(appointments, { contactId: id });
    const open = (await ctx.db.find(tasks, { contactId: id })).filter((t) => t.status === "open");
    return { contact: c, conversationId: conv?.id ?? null, calls: callList.length, lastCall: callList[0]?.startedAt ?? null, appointments: appts.filter((a) => a.status === "booked").sort((a, b) => a.startsAt - b.startsAt), openTasks: open.length };
  },
});

/** Create or edit a contact (name, e-mail, notes, tags). Consent is changed only through setConsent. */
export const save = app.mutation({
  access: "contacts.write",
  args: { id: s.optional(s.string()), phone: s.optional(s.string({ maxLength: 32 })), name: s.optional(s.string({ maxLength: 120 })), email: s.optional(s.string({ maxLength: 200 })), notes: s.optional(s.string({ maxLength: 4000 })), tags: s.optional(s.array(s.string({ maxLength: 32 }), { maxItems: 20 })) },
  returns: s.string(),
  handler: async (ctx, { id, phone, ...fields }) => {
    const { businessId, actor } = business(ctx);
    const now = Date.now();
    if (id) {
      (await ctx.db.get(contacts, id)) ?? fail("NOT_FOUND", "Contact not found.");
      await ctx.db.patch(contacts, id, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
      return id;
    }
    const e164 = normalizePhone(phone ?? "") ?? fail("INVALID_ARGUMENT", "Enter the number in international format, e.g. +14155550100.");
    if ((await ctx.db.find(contacts, { phone: e164 })).length) fail("CONFLICT", `${e164} is already a contact.`);
    const newId = await ctx.db.insert(contacts, { businessId, phone: e164, ...fields, tags: fields.tags ?? [], smsOptOut: false, doNotCall: false, firstSeenAt: now, lastContactAt: now });
    await ensureConversation(ctx, businessId, newId, now);
    await recordAudit(ctx, businessId, actor, "human", "contact.created", `Contact ${fields.name ?? e164} added`, newId);
    return newId;
  },
});

/**
 * Consent and communication preferences, each change audited with who made it and why.
 * Recording call consent requires a source (how it was obtained), because outbound calls rely on it.
 */
export const setConsent = app.mutation({
  access: "contacts.write",
  args: { id: s.string(), smsOptOut: s.optional(s.boolean()), doNotCall: s.optional(s.boolean()), callConsent: s.optional(s.nullable(s.object({ source: s.string({ minLength: 3, maxLength: 200 }) }))) },
  handler: async (ctx, { id, smsOptOut, doNotCall, callConsent }) => {
    const { businessId, actor } = business(ctx);
    const c = (await ctx.db.get(contacts, id)) ?? fail("NOT_FOUND", "Contact not found.");
    const changes: string[] = [];
    const patch: Record<string, unknown> = {};
    if (smsOptOut !== undefined && smsOptOut !== c.smsOptOut) { patch.smsOptOut = smsOptOut; changes.push(smsOptOut ? "opted out of texts" : "opted back in to texts"); }
    if (doNotCall !== undefined && doNotCall !== c.doNotCall) { patch.doNotCall = doNotCall; changes.push(doNotCall ? "added to do-not-call" : "removed from do-not-call"); }
    if (callConsent !== undefined) { patch.callConsent = callConsent ? { at: Date.now(), source: callConsent.source } : undefined; changes.push(callConsent ? `call consent recorded (${callConsent.source})` : "call consent withdrawn"); }
    if (!changes.length) return;
    await ctx.db.patch(contacts, id, patch);
    await recordAudit(ctx, businessId, actor, "human", "contact.consent", `${c.name ?? c.phone}: ${changes.join("; ")}`, id);
  },
});
