import { s } from "@feltdb/feltkit";
import { app, businesses, contacts, conversations, messages, phoneNumbers, agents } from "./app.js";
import { business } from "./_authz.js";
import { ensureConversation, loadBusiness, recordAudit, touchConversation } from "./_ops.js";

/**
 * Sample data for a first look: opening hours, escalation contacts, a simulator number answered by the
 * Front desk agent, and two contacts with a short text history. Every record is ordinary data, marked
 * provider "simulator" where it involves a phone; nothing pretends to be a real call.
 */
export const seed = app.mutation({
  access: "demo.seed",
  args: { simulatorNumber: s.optional(s.string({ pattern: "^\\+[1-9]\\d{6,14}$" })) },
  handler: async (ctx, { simulatorNumber }) => {
    const { businessId, actor } = business(ctx);
    const b = await loadBusiness(ctx);
    const now = Date.now();
    await ctx.db.patch(businesses, b.id, {
      about: "Family dental practice. Cleanings, check-ups, fillings and whitening. 120 Main Street, Springfield. New patients welcome; most insurance accepted.",
      hours: (["mon", "tue", "wed", "thu", "fri"] as const).map((day) => ({ day, open: "08:00", close: "18:00" })).concat([{ day: "sat" as any, open: "09:00", close: "13:00" }]),
      escalation: [{ id: "frontdesk", name: "Reception (Grace)", phone: "+15550000001" }, { id: "oncall", name: "On-call dentist", phone: "+15550000002" }],
      updatedAt: now, updatedBy: actor,
    });
    const [agent] = await ctx.db.find(agents, {});
    if (agent && !agent.escalateTo) await ctx.db.patch(agents, agent.id, { escalateTo: "frontdesk" });
    const e164 = simulatorNumber ?? `+1555${String(Math.abs(hash(businessId)) % 10_000_000).padStart(7, "0")}`;
    if (!(await ctx.db.find(phoneNumbers, {})).length) {
      const id = await ctx.db.insert(phoneNumbers, { businessId, e164, label: "Main line (simulator)", provider: "simulator", sms: true, voice: true, ...(agent ? { agentId: agent.id } : {}), outbound: true, createdAt: now });
      const { numberRoutes } = await import("./app.js");
      if (!(await ctx.db.find(numberRoutes, { e164 })).length) await ctx.db.insert(numberRoutes, { e164, businessId, numberId: id, provider: "simulator" });
    }
    const people = [
      { phone: "+15557770101", name: "Jordan Lee", texts: [["inbound", "Hi, do you take new patients?"], ["outbound", "We do! Call or text any time to book a visit."]] },
      { phone: "+15557770102", name: "Sam Rivera", texts: [["inbound", "Running 10 minutes late for my cleaning, sorry!"]] },
    ] as const;
    for (const p of people) {
      if ((await ctx.db.find(contacts, { phone: p.phone })).length) continue;
      const cid = await ctx.db.insert(contacts, { businessId, phone: p.phone, name: p.name, tags: ["sample"], smsOptOut: false, doNotCall: false, firstSeenAt: now - 86_400_000, lastContactAt: now - 3_600_000 });
      const conv = await ensureConversation(ctx, businessId, cid, now);
      let t = now - 3_600_000;
      for (const [direction, body] of p.texts) {
        t += 60_000;
        await ctx.db.insert(messages, { businessId, conversationId: conv.id, kind: "sms", direction, body, media: [], status: direction === "inbound" ? "received" : "delivered", from: direction === "inbound" ? p.phone : e164, to: direction === "inbound" ? e164 : p.phone, provider: "simulator", author: direction === "inbound" ? "contact" : actor, authorKind: direction === "inbound" ? "contact" : "human", createdAt: t, updatedAt: t });
        await touchConversation(ctx, (await ctx.db.get(conversations, conv.id))!, "sms", body, direction === "inbound" ? 1 : 0, t);
      }
    }
    await recordAudit(ctx, businessId, actor, "human", "demo.seeded", "Sample data loaded (simulator number, contacts, texts)");
    return { number: e164 };
  },
});

function hash(s: string): number { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }
