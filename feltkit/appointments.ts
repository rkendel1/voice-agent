import { fail, s } from "@feltdb/feltkit";
import { app, appointments, contacts } from "./app.js";
import { business } from "./_authz.js";
import { recordAudit } from "./_ops.js";

export const list = app.query({
  access: "appointments.read",
  args: { upcoming: s.optional(s.boolean()) },
  handler: async (ctx, { upcoming = true }) => {
    const now = Date.now();
    const rows = (await ctx.db.find(appointments, {}, { orderBy: [{ field: "startsAt", direction: "asc" }] })).filter((a) => !upcoming || (a.startsAt > now - 3600_000 && a.status === "booked"));
    const people = new Map((await ctx.db.find(contacts, {})).map((c) => [c.id, c]));
    return rows.map((a) => ({ ...a, contact: { name: people.get(a.contactId)?.name ?? null, phone: people.get(a.contactId)?.phone ?? null } }));
  },
});

/** Cancel an appointment (frees the slot: a cancelled booking keeps its record under a released slot key). */
export const cancel = app.mutation({
  access: "appointments.write",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const { businessId, actor } = business(ctx);
    const a = (await ctx.db.get(appointments, id)) ?? fail("NOT_FOUND", "Appointment not found.");
    if (a.status === "cancelled") return;
    await ctx.db.patch(appointments, id, { status: "cancelled", slot: `${a.slot}#cancelled:${id}` });
    await recordAudit(ctx, businessId, actor, "human", "appointment.cancelled", `Appointment ${a.slot} cancelled`, id);
  },
});
