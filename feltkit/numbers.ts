import { fail, s } from "@feltdb/feltkit";
import { agents, app, numberRoutes, phoneNumbers } from "./app.js";
import { business } from "./_authz.js";
import { loadBusiness, recordAudit } from "./_ops.js";
import { normalizePhone } from "./_policy.js";

export const list = app.query({
  access: "numbers.read",
  handler: async (ctx) => {
    const names = new Map((await ctx.db.find(agents, {})).map((a) => [a.id, a.name]));
    return (await ctx.db.find(phoneNumbers, {}, { orderBy: [{ field: "createdAt", direction: "asc" }] })).map((n) => ({ ...n, agentName: n.agentId ? names.get(n.agentId) ?? null : null }));
  },
});

/**
 * Attach a phone number to this business. The number must already exist at the provider (bought in
 * the Twilio console, with its webhooks pointed at this app) or be a simulator number. A number
 * belongs to one business: a number another business holds is refused without saying whose it is.
 */
export const add = app.mutation({
  access: "numbers.write",
  args: { e164: s.string({ maxLength: 32 }), label: s.string({ maxLength: 60 }), provider: s.enum(["twilio", "simulator"]), sms: s.boolean(), voice: s.boolean(), agentId: s.optional(s.string()), outbound: s.optional(s.boolean()) },
  returns: s.string(),
  capability: { name: "numbers.attach", description: "Attach a provider phone number (or a simulator number) to the business and choose the agent that answers it." },
  handler: async (ctx, args) => {
    const { businessId, actor } = business(ctx);
    await loadBusiness(ctx);
    const e164 = normalizePhone(args.e164) ?? fail("INVALID_ARGUMENT", "Enter the number in international format, e.g. +14155550100.");
    if (args.agentId && !(await ctx.db.get(agents, args.agentId))) fail("NOT_FOUND", "Agent not found.");
    if ((await ctx.db.find(numberRoutes, { e164 })).length) fail("CONFLICT", `${e164} is already attached to a business.`);
    const now = Date.now();
    const first = !(await ctx.db.find(phoneNumbers, {})).length;
    const id = await ctx.db.insert(phoneNumbers, { businessId, e164, label: args.label || e164, provider: args.provider, sms: args.sms, voice: args.voice, ...(args.agentId ? { agentId: args.agentId } : {}), outbound: args.outbound ?? first, createdAt: now });
    await ctx.db.insert(numberRoutes, { e164, businessId, numberId: id, provider: args.provider });
    await recordAudit(ctx, businessId, actor, "human", "config.number", `Number ${e164} (${args.provider}) attached`, id);
    return id;
  },
});

export const update = app.mutation({
  access: "numbers.write",
  args: { id: s.string(), label: s.optional(s.string({ maxLength: 60 })), sms: s.optional(s.boolean()), voice: s.optional(s.boolean()), agentId: s.optional(s.nullable(s.string())), fallbackEscalationId: s.optional(s.nullable(s.string())), outbound: s.optional(s.boolean()) },
  handler: async (ctx, { id, ...args }) => {
    const { businessId, actor } = business(ctx);
    const b = await loadBusiness(ctx);
    const n = (await ctx.db.get(phoneNumbers, id)) ?? fail("NOT_FOUND", "Number not found.");
    if (args.agentId && !(await ctx.db.get(agents, args.agentId))) fail("NOT_FOUND", "Agent not found.");
    if (args.fallbackEscalationId && !b.escalation.some((e) => e.id === args.fallbackEscalationId)) fail("INVALID_ARGUMENT", "Not one of the business's escalation contacts.");
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) if (v !== undefined) patch[k] = v === null ? undefined : v;
    if (!Object.keys(patch).length) return;
    await ctx.db.patch(phoneNumbers, id, patch);
    // One caller ID at a time.
    if (args.outbound) for (const o of await ctx.db.find(phoneNumbers, { outbound: true })) if (o.id !== id) await ctx.db.patch(phoneNumbers, o.id, { outbound: false });
    await recordAudit(ctx, businessId, actor, "human", "config.number", `Number ${n.e164} changed: ${Object.keys(patch).join(", ")}`, id);
  },
});

export const release = app.mutation({
  access: "numbers.write",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const { businessId, actor } = business(ctx);
    const n = (await ctx.db.get(phoneNumbers, id)) ?? fail("NOT_FOUND", "Number not found.");
    for (const r of await ctx.db.find(numberRoutes, { e164: n.e164 })) if (r.businessId === businessId) await ctx.db.delete(numberRoutes, r.id);
    await ctx.db.delete(phoneNumbers, id);
    await recordAudit(ctx, businessId, actor, "human", "config.number", `Number ${n.e164} released`, id);
  },
});
