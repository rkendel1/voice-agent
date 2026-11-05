/**
 * A brain decides what the agent says and which capability it invokes next. It never acts itself:
 * `runTool` invokes the capability through the application (authorization, validation, audit), and
 * the result it returns is the only evidence of what happened.
 */
export interface AgentContext {
  agent: { id: string; name: string; purpose: string; instructions: string; brain: "environment" | "deterministic"; temperature: number; capabilities: string[]; escalateTo: string | null; voice: { language: string } };
  business: { name: string; about: string; timezone: string; hours: Array<{ day: string; open: string; close: string }>; openNow: boolean; escalation: Array<{ id: string; name: string }>; appointmentMinutes: number };
  contact: { name: string | null; phone: string; smsOptOut: boolean };
  conversationId: string;
  texts: Array<{ direction: string; body: string; at: number; status: string }>;
  now: { iso: string; date: string; time: string; day: string };
}

export type Channel = "voice" | "sms";
export type ToolResult = { ok: boolean; [k: string]: unknown };
export type ToolRunner = (name: ToolName, args: Record<string, unknown>) => Promise<ToolResult>;

export interface TurnInput {
  userText: string;
  /** Speak or send text as it is produced (voice: streamed to TTS). */
  emit: (text: string) => void;
  runTool: ToolRunner;
  signal: AbortSignal;
}

export interface Brain {
  readonly kind: string;
  /** One agent turn in answer to the user. Resolves when the agent has finished (or was aborted). */
  turn(input: TurnInput): Promise<void>;
  /** The caller interrupted: only `spoken` of the last answer was heard. */
  interrupted(spoken: string): void;
  /** Whether the agent wants the call to end after this turn (said goodbye). */
  readonly wantsHangup: boolean;
}

export const TOOLS = {
  contacts_lookup: { capability: "contacts.lookup", fn: "tools:lookupContact", description: "Look up the person you are talking to: their name if known, upcoming appointments, whether texts are allowed.", parameters: { type: "object", properties: {} } },
  business_info: { capability: "business.info", fn: "tools:businessInfo", description: "The business's description, opening hours and whether it is open now.", parameters: { type: "object", properties: {} } },
  appointments_availability: { capability: "appointments.availability", fn: "tools:availability", description: "Free appointment slots. date: YYYY-MM-DD in the business's time zone (default today); days: how many days to look ahead (default 3).", parameters: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" }, days: { type: "integer", minimum: 1, maximum: 14 } } } },
  appointments_book: { capability: "appointments.book", fn: "tools:book", description: "Book a free slot for the caller. slot: YYYY-MM-DDTHH:MM exactly as returned by appointments_availability. Only tell the caller it is booked if the result has ok: true.", parameters: { type: "object", properties: { slot: { type: "string" }, name: { type: "string", description: "The caller's name, if they gave it" }, reason: { type: "string" } }, required: ["slot"] } },
  followups_create: { capability: "followups.create", fn: "tools:followup", description: "Leave a follow-up task for staff: a message, or a request to call back.", parameters: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" } }, required: ["title"] } },
  sms_send: { capability: "sms.send", fn: "tools:sendSms", description: "Text the person you are talking to (e.g. a booking confirmation). The result says whether the provider accepted it; only say it was sent if ok is true.", parameters: { type: "object", properties: { body: { type: "string" } }, required: ["body"] } },
  calls_transfer: { capability: "calls.transfer", fn: "tools:transfer", description: "Transfer the call to a person. escalationId: one of the business's escalation contacts (optional). Use when the caller asks for a person or you cannot help.", parameters: { type: "object", properties: { escalationId: { type: "string" }, reason: { type: "string" } }, required: ["reason"] } },
  conversations_history: { capability: "conversations.history", fn: "tools:history", description: "Recent texts and call summaries with this person.", parameters: { type: "object", properties: { limit: { type: "integer" } } } },
} as const;
export type ToolName = keyof typeof TOOLS;

/** The tools this agent may use on this channel: its granted capabilities only. */
export function toolsFor(ctx: AgentContext, channel: Channel): ToolName[] {
  return (Object.keys(TOOLS) as ToolName[]).filter((n) => ctx.agent.capabilities.includes(TOOLS[n].capability) && !(channel === "sms" && n === "calls_transfer"));
}

/** "14:30" → "2:30 PM" */
export function speakTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}
