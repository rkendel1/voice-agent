/**
 * The application's authorization policy, in one place: registered with `feltkit({ authorize })`.
 * FeltKit calls it for every call to every function (HTTP, AppPort, MCP, agent runs, jobs, and the
 * voice runtime's in-process calls) after the role check and argument validation, before the handler.
 *
 *   - Default deny: a function not listed in SCOPE is refused.
 *   - The business is the session's (`principal.tenant`, FeltKit's live membership). A `businessId`
 *     argument that differs is refused; ids from another business do not resolve (tenant-scoped
 *     collections), and an unknown id and a forbidden one are refused alike (NOT_FOUND).
 *   - Agent capabilities (tools:*) are allowed only for an active agent profile of this business
 *     that lists the capability, acting in a live call or an existing conversation of this business.
 *     The model never chooses the agent, the call or the business: the voice runtime supplies them.
 */
import { fail, type AuthorizeHook, type AuthContext, type DatabaseReader } from "@feltdb/feltkit";
import { agents, calls, conversations, type Capability } from "./app.js";

export interface Ctx {
  readonly auth: AuthContext;
  readonly db: DatabaseReader;
}

/** How each function is scoped. "business": needs a session in a business. "global": the voice runtime's cross-business work. */
type Scope = "business" | "global" | "tool";
const SCOPE: Record<string, Scope> = {};
const add = (scope: Scope, ...names: string[]) => names.forEach((n) => (SCOPE[n] = scope));

add("business",
  "business:get", "business:ensure", "business:update", "business:setup",
  "overview:get",
  "agents:list", "agents:save", "agents:remove", "agents:connect",
  "numbers:list", "numbers:add", "numbers:update", "numbers:release",
  "contacts:list", "contacts:get", "contacts:save", "contacts:setConsent",
  "conversations:list", "conversations:timeline", "conversations:markRead", "conversations:reply", "conversations:note", "conversations:setStatus",
  "calls:list", "calls:get", "calls:live", "calls:start", "calls:control",
  "tasks:list", "tasks:create", "tasks:complete",
  "appointments:list", "appointments:cancel",
  "audit:list", "demo:seed", "appointments:list", "appointments:cancel",
  // The voice runtime, inside the business an event belongs to.
  "gateway:inboundSms", "gateway:smsStatus", "gateway:inboundCall", "gateway:callStatus", "gateway:sessionOpened", "gateway:sessionClosed",
  "gateway:transcript", "gateway:context", "gateway:controls", "gateway:controlApplied", "gateway:transferResult", "gateway:sendClaim", "gateway:sendResult",
  "gateway:dialClaim", "gateway:dialResult", "gateway:summaryContext", "gateway:recordSummary", "gateway:smsAgentContext", "gateway:purge", "gateway:toolDenied", "gateway:answerPlan", "gateway:agentReply",
  // The application agent's durable run (feltkit/agents.ts).
  "agent/voice",
);
add("global", "gateway:route", "gateway:heartbeat", "gateway:status", "gateway:settings");
add("tool", "tools:lookupContact", "tools:businessInfo", "tools:availability", "tools:book", "tools:followup", "tools:sendSms", "tools:transfer", "tools:history");

/** The capability each tool function is: an agent profile must list it. */
export const TOOL_CAPABILITY: Record<string, Capability> = {
  "tools:lookupContact": "contacts.lookup",
  "tools:businessInfo": "business.info",
  "tools:availability": "appointments.availability",
  "tools:book": "appointments.book",
  "tools:followup": "followups.create",
  "tools:sendSms": "sms.send",
  "tools:transfer": "calls.transfer",
  "tools:history": "conversations.history",
};

const hidden = (): never => fail("NOT_FOUND", "Not found.");
const LIVE = new Set(["queued", "initiated", "ringing", "in-progress"]);

export const authorize: AuthorizeHook = async (r) => {
  const scope = SCOPE[r.function];
  if (!scope) return { allowed: false, code: "FORBIDDEN", reason: `No policy admits ${r.function}.` };
  if (!r.principal) return { allowed: false, code: "UNAUTHORIZED" };
  if (scope === "global") {
    // Cross-business work belongs to the voice runtime alone (its role holds voice.route / voice.work).
    return r.principal.type === "agent" || r.principal.type === "service" ? true : { allowed: false, code: "FORBIDDEN" };
  }
  const tenant = r.principal.tenant ?? hidden();
  if (r.args.businessId !== undefined && r.args.businessId !== tenant.id) hidden();
  if (scope === "business") return true;

  // A tool: an agent profile of this business that is active and granted the capability, in a live call
  // or an existing conversation of this business.
  const str = (k: string) => (typeof r.args[k] === "string" ? (r.args[k] as string) : undefined);
  const agentId = str("agentId") ?? hidden();
  const agent = (await r.db.get(agents, agentId)) ?? hidden();
  const capability = TOOL_CAPABILITY[r.function]!;
  if (!agent.active) return { allowed: false, code: "FORBIDDEN", reason: `Agent "${agent.name}" is not active.` };
  if (!agent.capabilities.includes(capability)) return { allowed: false, code: "FORBIDDEN", reason: `Agent "${agent.name}" is not granted ${capability}.` };
  const callId = str("callId");
  const conversationId = str("conversationId");
  if (callId) {
    const call = (await r.db.get(calls, callId)) ?? hidden();
    if (call.agentId !== agent.id) return { allowed: false, code: "FORBIDDEN", reason: "This agent is not handling that call." };
    if (!LIVE.has(call.status) && capability === "calls.transfer") return { allowed: false, code: "FORBIDDEN", reason: "The call has ended." };
    return true;
  }
  if (conversationId) {
    (await r.db.get(conversations, conversationId)) ?? hidden();
    return true;
  }
  return { allowed: false, code: "FORBIDDEN", reason: "A tool acts within a call or a conversation." };
};

/** The session's business and the caller's role there (FeltKit's). */
export function business(ctx: Ctx): { businessId: string; businessName: string; role: string; actor: string; actorName: string } {
  const tenant = ctx.auth.tenant ?? fail("INTERNAL", "authorize admitted a call without a business.");
  const principal = ctx.auth.requirePrincipal();
  return { businessId: tenant.id, businessName: tenant.name, role: tenant.role, actor: principal.id, actorName: principal.displayName ?? principal.id };
}
