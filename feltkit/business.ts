import { fail, s } from "@feltdb/feltkit";
import { agents, app, businesses, phoneNumbers, runtimeStatus } from "./app.js";
import { business } from "./_authz.js";
import { loadBusiness, recordAudit } from "./_ops.js";
import { isOpen } from "./_policy.js";

export const VOICE_RUNTIME = "voice-runtime";

const DEFAULT_HOURS = (["mon", "tue", "wed", "thu", "fri"] as const).map((day) => ({ day, open: "09:00", close: "17:00" }));
export const DEFAULT_POLICY = {
  transcripts: true,
  disclosure: "This call is answered by an automated assistant and may be transcribed.",
  transcriptRetentionDays: 90,
  quietStart: "21:00",
  quietEnd: "08:00",
  outboundCalls: false,
  maxOutboundCallsPerHour: 10,
  smsSenderLine: true,
  missedCallTextBack: false,
};
export const DEFAULT_AGENT_INSTRUCTIONS =
  "You answer the phone for the business. Be brief and friendly: callers are on the phone. Help with opening hours, " +
  "questions about the business, and booking appointments. Only say something was done (booked, texted, transferred) " +
  "when the tool result says it succeeded. If you cannot help, offer to take a message or transfer the caller to a person.";

/** The business record, open/closed now, and the caller's role. */
export const get = app.query({
  access: "business.read",
  handler: async (ctx) => {
    const { role, businessName } = business(ctx);
    const [b] = await ctx.db.find(businesses, {});
    return b ? { ...b, role, openNow: isOpen(b.hours, b.timezone, Date.now()) } : { role, name: businessName, missing: true as const };
  },
});

/**
 * First entry by an owner or admin: create the business record with safe defaults and a first
 * agent ("Front desk", scripted, no model needed). Idempotent; staff entering an unconfigured
 * business are told to ask an admin.
 */
export const ensure = app.mutation({
  access: "business.read",
  args: { timezone: s.optional(s.string({ maxLength: 64 })) },
  handler: async (ctx, { timezone }) => {
    const { businessId, businessName, role, actor } = business(ctx);
    const [existing] = await ctx.db.find(businesses, {});
    if (existing) return { id: existing.id, created: false };
    if (role !== "owner" && role !== "admin") fail("FAILED_PRECONDITION", "This business is not set up yet. Ask an owner or admin to open it first.");
    const tz = timezone && isZone(timezone) ? timezone : "America/New_York";
    const now = Date.now();
    const id = await ctx.db.insert(businesses, {
      businessId, name: businessName, timezone: tz, hours: DEFAULT_HOURS, about: "", escalation: [], appointmentMinutes: 30,
      policy: DEFAULT_POLICY, updatedAt: now, updatedBy: actor,
    });
    await ctx.db.insert(agents, {
      businessId, name: "Front desk", purpose: "Answer calls and texts, book appointments, take messages.", instructions: DEFAULT_AGENT_INSTRUCTIONS,
      greeting: `Thanks for calling ${businessName}. How can I help you today?`,
      voice: { ttsProvider: "ElevenLabs", language: "en-US" }, brain: "deterministic", temperature: 0.3,
      capabilities: ["contacts.lookup", "business.info", "appointments.availability", "appointments.book", "followups.create", "sms.send", "calls.transfer", "conversations.history"],
      schedule: "always", smsAutoReply: true, active: true, createdAt: now, updatedAt: now,
    });
    await recordAudit(ctx, businessId, actor, "human", "business.created", `${businessName} set up with default policy and the Front desk agent`, id);
    return { id, created: true };
  },
});

const Hours = s.array(s.object({ day: s.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]), open: s.string({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }), close: s.string({ pattern: "^([01]\\d|2[0-4]):[0-5]\\d$" }) }), { maxItems: 14 });
const Policy = s.object({
  transcripts: s.optional(s.boolean()), disclosure: s.optional(s.string({ maxLength: 300 })), transcriptRetentionDays: s.optional(s.integer({ minimum: 1, maximum: 3650 })),
  quietStart: s.optional(s.string({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" })), quietEnd: s.optional(s.string({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" })),
  outboundCalls: s.optional(s.boolean()), maxOutboundCallsPerHour: s.optional(s.integer({ minimum: 0, maximum: 100 })), smsSenderLine: s.optional(s.boolean()), missedCallTextBack: s.optional(s.boolean()),
});

/** Change the business profile, hours, escalation contacts or policy. Every change is audited with what changed. */
export const update = app.mutation({
  access: "business.write",
  args: {
    name: s.optional(s.string({ minLength: 1, maxLength: 120 })), timezone: s.optional(s.string({ maxLength: 64 })), hours: s.optional(Hours),
    about: s.optional(s.string({ maxLength: 4000 })), appointmentMinutes: s.optional(s.integer({ minimum: 10, maximum: 240 })),
    escalation: s.optional(s.array(s.object({ id: s.string({ minLength: 1, maxLength: 32 }), name: s.string({ maxLength: 80 }), phone: s.string({ pattern: "^\\+[1-9]\\d{6,14}$" }) }), { maxItems: 10 })),
    policy: s.optional(Policy),
  },
  capability: { name: "business.configure", description: "Change a business's profile, hours, escalation contacts or communication policy." },
  returns: s.object({ changed: s.array(s.string()) }),
  handler: async (ctx, args) => {
    const { businessId, actor } = business(ctx);
    const b = await loadBusiness(ctx);
    if (args.timezone !== undefined && !isZone(args.timezone)) fail("INVALID_ARGUMENT", `Unknown time zone "${args.timezone}".`);
    for (const h of args.hours ?? []) if (h.open >= h.close) fail("INVALID_ARGUMENT", `${h.day}: opening ${h.open} must be before closing ${h.close}.`);
    const ids = new Set<string>();
    for (const e of args.escalation ?? []) { if (ids.has(e.id)) fail("INVALID_ARGUMENT", `Escalation id "${e.id}" is repeated.`); ids.add(e.id); }
    const patch: Record<string, unknown> = {};
    for (const k of ["name", "timezone", "hours", "about", "appointmentMinutes", "escalation"] as const) if (args[k] !== undefined) patch[k] = args[k];
    if (args.policy) patch.policy = { ...b.policy, ...Object.fromEntries(Object.entries(args.policy).filter(([, v]) => v !== undefined)) };
    const changed = Object.keys(patch).flatMap((k) => (k === "policy" ? Object.keys(args.policy!).map((p) => `policy.${p}`) : [k]));
    if (!changed.length) return { changed };
    await ctx.db.patch(businesses, b.id, { ...patch, updatedAt: Date.now(), updatedBy: actor });
    await recordAudit(ctx, businessId, actor, "human", "config.business", `Business settings changed: ${changed.join(", ")}`, b.id);
    return { changed };
  },
});

/**
 * The first-run checklist: what this business still needs before a real call works, from records
 * (business, agents, numbers, the voice runtime's membership and its last report), never assumed.
 */
export const setup = app.query({
  access: "business.read",
  handler: async (ctx) => {
    const [b] = await ctx.db.find(businesses, {});
    const agentList = await ctx.db.find(agents, {});
    const numbers = await ctx.db.find(phoneNumbers, {});
    const members = await ctx.tenancy.members();
    const [status] = await ctx.db.find(runtimeStatus, {});
    const runtimeFresh = Boolean(status && Date.now() - status.heartbeatAt < 30_000);
    const steps = [
      { id: "business", done: Boolean(b && b.hours.length), label: "Business profile and opening hours", detail: b ? `${b.hours.length} opening periods, ${b.timezone}` : "Not set up" },
      { id: "agent", done: agentList.some((a) => a.active), label: "An active agent", detail: `${agentList.filter((a) => a.active).length} active` },
      { id: "connect", done: members.some((m) => m.principalId === VOICE_RUNTIME), label: "Voice runtime connected to this business", detail: "The runtime acts here only as a member, with its own role." },
      { id: "number", done: numbers.length > 0, label: "A phone number (or a simulator number)", detail: numbers.map((n) => `${n.e164} (${n.provider})`).join(", ") || "None" },
      { id: "assign", done: numbers.some((n) => n.agentId), label: "An agent answers a number", detail: numbers.filter((n) => n.agentId).map((n) => n.e164).join(", ") || "No number has an agent" },
      { id: "runtime", done: runtimeFresh && Boolean(status?.ready), label: "Telephony runtime running and configured", detail: !status ? "The runtime has not reported (is `npm run dev` running?)" : !runtimeFresh ? "No heartbeat in 30 s" : status.problems.join(" ") || `${status.provider} ready` },
    ];
    return {
      steps, complete: steps.every((x) => x.done),
      runtime: status ? { provider: status.provider, ready: status.ready, fresh: runtimeFresh, problems: status.problems, publicBaseUrl: status.publicBaseUrl ?? null, signatureFailures: status.signatureFailures, lastWebhookAt: status.lastWebhookAt ?? null } : null,
    };
  },
});

function isZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
