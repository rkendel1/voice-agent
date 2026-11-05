import { fail, s } from "@feltdb/feltkit";
import { app, calls, contacts, conversations, invocations, messages, tasks } from "./app.js";
import { business } from "./_authz.js";
import { loadBusiness, queueSms, recordAudit, touchConversation } from "./_ops.js";

/** The unified inbox: one row per contact, newest activity first, with filters. */
export const list = app.query({
  access: "conversations.read",
  args: { filter: s.optional(s.enum(["all", "unread", "open", "closed"])), search: s.optional(s.string({ maxLength: 100 })) },
  handler: async (ctx, { filter = "all", search }) => {
    let rows = await ctx.db.find(conversations, {}, { orderBy: [{ field: "lastAt", direction: "desc" }], limit: 500 });
    if (filter === "unread") rows = rows.filter((c) => c.unread > 0);
    if (filter === "open" || filter === "closed") rows = rows.filter((c) => c.status === filter);
    const people = new Map((await ctx.db.find(contacts, {})).map((c) => [c.id, c]));
    let matched: Set<string> | null = null;
    const q = search?.trim();
    if (q) {
      matched = new Set();
      for (const m of await ctx.db.search(messages, { text: q, limit: 200 })) matched.add(m.conversationId);
      for (const c of rows) {
        const p = people.get(c.contactId);
        if (p && `${p.name ?? ""} ${p.phone}`.toLowerCase().includes(q.toLowerCase())) matched.add(c.id);
      }
    }
    const live = new Set((await ctx.db.find(calls, {})).filter((c) => c.status === "in-progress" || c.status === "ringing").map((c) => c.conversationId));
    return rows.filter((c) => !matched || matched.has(c.id)).map((c) => {
      const p = people.get(c.contactId);
      return { ...c, contact: p ? { id: p.id, name: p.name ?? null, phone: p.phone, smsOptOut: p.smsOptOut } : null, live: live.has(c.id) };
    });
  },
});

/** A conversation's whole history: texts, notes, calls (with summaries), agent actions and follow-ups, in time order. */
export const timeline = app.query({
  access: "conversations.read",
  args: { conversationId: s.string() },
  handler: async (ctx, { conversationId }) => {
    const conv = (await ctx.db.get(conversations, conversationId)) ?? fail("NOT_FOUND", "Conversation not found.");
    const contact = (await ctx.db.get(contacts, conv.contactId))!;
    const items: Array<{ type: string; at: number; [k: string]: unknown }> = [];
    for (const m of await ctx.db.find(messages, { conversationId })) items.push({ type: m.kind, ...m, at: m.createdAt });
    for (const c of await ctx.db.find(calls, { conversationId })) items.push({ type: "call", at: c.startedAt, ...c, sessionTokenHash: undefined });
    for (const i of await ctx.db.find(invocations, { conversationId })) items.push({ type: "action", ...i });
    const callIds = items.filter((i) => i.type === "call").map((i) => i.id as string);
    for (const callId of callIds) for (const i of await ctx.db.find(invocations, { callId })) if (!i.conversationId) items.push({ type: "action", ...i });
    const followups = await ctx.db.find(tasks, { conversationId });
    items.sort((a, b) => a.at - b.at);
    return { conversation: conv, contact, items, tasks: followups };
  },
});

export const markRead = app.mutation({
  access: "conversations.read",
  args: { conversationId: s.string() },
  handler: async (ctx, { conversationId }) => {
    const conv = (await ctx.db.get(conversations, conversationId)) ?? fail("NOT_FOUND", "Conversation not found.");
    if (conv.unread) await ctx.db.patch(conversations, conversationId, { unread: 0 });
  },
});

/**
 * A staff member replies by text. Policy (opt-out, quiet hours, a sender number) is enforced in
 * queueSms; a refused reply is answered with the reason and recorded as blocked, never sent.
 */
export const reply = app.mutation({
  access: "conversations.write",
  args: { conversationId: s.string(), body: s.string({ minLength: 1, maxLength: 1400 }), idempotencyKey: s.string({ minLength: 8, maxLength: 80 }) },
  returns: s.object({ messageId: s.string(), status: s.enum(["queued", "blocked"]), reason: s.optional(s.string()), duplicate: s.boolean() }),
  capability: { name: "conversations.reply", description: "Text a contact from the business (policy-checked: opt-out, quiet hours, sender identification)." },
  handler: async (ctx, { conversationId, body, idempotencyKey }) => {
    const { actor } = business(ctx);
    const b = await loadBusiness(ctx);
    const conversation = (await ctx.db.get(conversations, conversationId)) ?? fail("NOT_FOUND", "Conversation not found.");
    const contact = (await ctx.db.get(contacts, conversation.contactId))!;
    const r = await queueSms(ctx, { business: b, conversation, contact, body, author: actor, authorKind: "human", idempotencyKey: `staff:${actor}:${idempotencyKey}`, now: Date.now() });
    await ctx.db.patch(conversations, conversationId, { unread: 0 });
    return { messageId: r.messageId, status: r.status, ...(r.reason ? { reason: r.reason } : {}), duplicate: r.duplicate };
  },
});

export const note = app.mutation({
  access: "conversations.write",
  args: { conversationId: s.string(), body: s.string({ minLength: 1, maxLength: 1600 }) },
  returns: s.string(),
  handler: async (ctx, { conversationId, body }) => {
    const { businessId, actor, actorName } = business(ctx);
    const conversation = (await ctx.db.get(conversations, conversationId)) ?? fail("NOT_FOUND", "Conversation not found.");
    const now = Date.now();
    const id = await ctx.db.insert(messages, { businessId, conversationId, kind: "note", direction: "internal", body, media: [], status: "received", author: actor, authorKind: "human", createdAt: now, updatedAt: now });
    await touchConversation(ctx, conversation, "note", `${actorName}: ${body}`, 0, now);
    await recordAudit(ctx, businessId, actor, "human", "note.added", `${actorName} added a note`, id);
    return id;
  },
});

export const setStatus = app.mutation({
  access: "conversations.write",
  args: { conversationId: s.string(), status: s.enum(["open", "closed"]) },
  handler: async (ctx, { conversationId, status }) => {
    (await ctx.db.get(conversations, conversationId)) ?? fail("NOT_FOUND", "Conversation not found.");
    await ctx.db.patch(conversations, conversationId, { status, ...(status === "closed" ? { unread: 0 } : {}) });
  },
});
