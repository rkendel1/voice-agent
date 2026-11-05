import { fail, s } from "@feltdb/feltkit";
import { app, contacts, conversations, tasks } from "./app.js";
import { business } from "./_authz.js";
import { recordAudit } from "./_ops.js";

export const list = app.query({
  access: "tasks.read",
  args: { status: s.optional(s.enum(["open", "done", "all"])) },
  handler: async (ctx, { status = "open" }) => {
    const rows = (await ctx.db.find(tasks, {}, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 500 })).filter((t) => status === "all" || t.status === status);
    const people = new Map((await ctx.db.find(contacts, {})).map((c) => [c.id, c]));
    return rows.map((t) => ({ ...t, contact: t.contactId ? { name: people.get(t.contactId)?.name ?? null, phone: people.get(t.contactId)?.phone ?? null } : null }));
  },
});

export const create = app.mutation({
  access: "tasks.write",
  args: { title: s.string({ minLength: 1, maxLength: 200 }), detail: s.optional(s.string({ maxLength: 2000 })), conversationId: s.optional(s.string()), due: s.optional(s.number()) },
  returns: s.string(),
  handler: async (ctx, { title, detail, conversationId, due }) => {
    const { businessId, actor } = business(ctx);
    const conv = conversationId ? (await ctx.db.get(conversations, conversationId)) ?? fail("NOT_FOUND", "Conversation not found.") : null;
    const id = await ctx.db.insert(tasks, { businessId, title, ...(detail ? { detail } : {}), ...(conv ? { conversationId: conv.id, contactId: conv.contactId } : {}), ...(due ? { due } : {}), status: "open", createdBy: actor, createdByKind: "human", createdAt: Date.now() });
    await recordAudit(ctx, businessId, actor, "human", "followup.created", `Follow-up: ${title}`, id);
    return id;
  },
});

export const complete = app.mutation({
  access: "tasks.write",
  args: { id: s.string(), done: s.boolean() },
  handler: async (ctx, { id, done }) => {
    const { businessId, actor } = business(ctx);
    const t = (await ctx.db.get(tasks, id)) ?? fail("NOT_FOUND", "Task not found.");
    await ctx.db.patch(tasks, id, done ? { status: "done", doneBy: actor, doneAt: Date.now() } : { status: "open", doneBy: undefined, doneAt: undefined });
    await recordAudit(ctx, businessId, actor, "human", done ? "followup.done" : "followup.reopened", `${done ? "Done" : "Reopened"}: ${t.title}`, id);
  },
});
