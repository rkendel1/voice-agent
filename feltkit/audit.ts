import { s } from "@feltdb/feltkit";
import { app, audit } from "./app.js";

/** The audit log, newest first; `type` filters by prefix ("config.", "call.", "sms."). */
export const list = app.query({
  access: "audit.read",
  args: { type: s.optional(s.string({ maxLength: 64 })), limit: s.optional(s.integer({ minimum: 1, maximum: 500 })) },
  handler: async (ctx, { type, limit = 200 }) => {
    const rows = await ctx.db.find(audit, {}, { orderBy: [{ field: "at", direction: "desc" }], limit: 1000 });
    return rows.filter((r) => !type || r.type.startsWith(type)).slice(0, limit);
  },
});
