import { app, appointments, audit, calls, conversations, messages, tasks } from "./app.js";

/** Overview numbers for the dashboard, computed from records. */
export const get = app.query({
  access: "overview.read",
  handler: async (ctx) => {
    const now = Date.now();
    const day = now - 24 * 3600_000;
    const allCalls = await ctx.db.find(calls, {}, { orderBy: [{ field: "startedAt", direction: "desc" }], limit: 1000 });
    const recent = allCalls.filter((c) => c.startedAt > day);
    const convs = await ctx.db.find(conversations, {});
    const sms = (await ctx.db.find(messages, { kind: "sms" })).filter((m) => m.createdAt > day);
    const outcomes: Record<string, number> = {};
    for (const c of recent) if (c.outcome) outcomes[c.outcome] = (outcomes[c.outcome] ?? 0) + 1;
    const upcoming = (await ctx.db.find(appointments, { status: "booked" })).filter((a) => a.startsAt > now).length;
    return {
      activeCalls: allCalls.filter((c) => c.status === "in-progress" || c.status === "ringing").length,
      callsToday: recent.length,
      missedToday: recent.filter((c) => c.outcome === "missed").length,
      unreadConversations: convs.filter((c) => c.unread > 0).length,
      smsIn: sms.filter((m) => m.direction === "inbound").length,
      smsOut: sms.filter((m) => m.direction === "outbound" && m.status !== "blocked").length,
      smsFailed: sms.filter((m) => ["failed", "undelivered", "unknown"].includes(m.status)).length,
      outcomes,
      openFollowups: (await ctx.db.find(tasks, { status: "open" })).length,
      upcomingAppointments: upcoming,
      recentActivity: await ctx.db.find(audit, {}, { orderBy: [{ field: "at", direction: "desc" }], limit: 8 }),
    };
  },
});
