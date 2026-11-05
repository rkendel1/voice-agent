/**
 * Voice Agent: phone calls and SMS answered by agents that do real work for a business.
 *
 * Code defines what the application can do; configuration decides how it operates.
 *
 *   Code (this directory)      collections, roles, the authorization policy, the agent capabilities,
 *                              the provider adapter boundary (gateway/).
 *   Control (FeltKit Studio)   Configuration: TELEPHONY_PROVIDER, TWILIO_ACCOUNT_SID, PUBLIC_BASE_URL
 *                              Credentials:   credential-ref:twilio-auth-token
 *                              Models:        the model agents converse with (Intelligence)
 *                              Data:          agents, phone numbers, business hours and policies
 *                              Webhooks:      call.completed, message.received, appointment.booked
 *                              Integrations:  calendars, CRMs and other HTTP APIs, as capabilities
 *
 * Businesses are FeltKit tenants (`auth.tenant`). Every business record is tenant-scoped on
 * `businessId`, so another business's records do not exist for a call. Authority has two layers,
 * both enforced by FeltKit on every interface: roles (below) and `authorize` (feltkit/_authz.ts).
 *
 * The voice runtime (gateway/) is the application agent "voice-runtime" (`app.agent`, feltkit/agents.ts).
 * It works in a business only while it is a member there, and acts only through the functions its
 * role grants. A configured agent profile narrows that further: a capability the profile does not
 * list is refused, whatever the model asks for.
 */
import { feltkit, s } from "@feltdb/feltkit";
import { authorize } from "./_authz.js";

/**
 * Business permissions, least privilege first.
 *   staff  operates communications: reads everything in the business, replies, notes, follow-ups,
 *          starts a policy-checked outbound call, intervenes in live calls.
 *   admin  also configures the business: profile, hours, policies, agents, phone numbers, members.
 *   owner  also loads the sample data and manages the tenant itself.
 */
const STAFF = [
  "business.read", "overview.read", "conversations.read", "conversations.write", "contacts.read", "contacts.write",
  "calls.read", "calls.start", "calls.control", "tasks.read", "tasks.write", "appointments.read", "appointments.write",
  "agents.read", "numbers.read", "audit.read",
];
const ADMIN = [...STAFF, "business.write", "agents.write", "numbers.write", "tenant.members.manage"];
const OWNER = [...ADMIN, "demo.seed", "tenant.*"];

/** Everything the voice runtime may do: ingest provider events, run its work, and invoke agent tools. */
const VOICE = ["voice.route", "voice.ingest", "voice.work", "voice.tools", "configuration.read", "webhooks.emit", "webhooks.deliver", "notifications.send"];

export const app = feltkit({
  name: "voice-agent",
  description: "Voice Agent: phone calls and SMS answered by agents that do real work for a business.",
  roles: {
    // Every account: its notifications, nothing in any business until it works in one.
    person: ["notifications.*", "webhooks.emit", "webhooks.deliver"],
    owner: OWNER,
    admin: ADMIN,
    staff: STAFF,
    // The membership role the voice runtime holds in a business. Its authority is its own role "voice".
    agent: [],
    voice: VOICE,
    // Operating the deployment (Studio): providers, credentials, models, jobs. Not a business role.
    operator: ["intelligence.*", "credential.*", "configuration.*", "apikeys.*", "webhooks.*", "jobs.*", "schedules.*", "feltkit.operations.*"],
  },
  auth: {
    accounts: { roles: ["person"], password: true, magicLink: true, email: { from: "auth@voice-agent.example" } },
    tenant: { name: "business", roles: ["owner", "admin", "staff", "agent"] },
  },
  authorize,
  dev: {
    users: [
      { id: "ada", name: "Ada Lovelace", roles: ["person", "operator"] },
      { id: "grace", name: "Grace Hopper", roles: ["person"] },
      { id: "alan", name: "Alan Turing", roles: ["person"] },
    ],
  },
  services: {
    notifications: { types: ["call.missed", "sms.received", "call.escalated", "task.assigned"] },
    // Operators register endpoints in Studio → Services → Webhooks: a CRM, a calendar sync, a Slack bridge.
    webhooks: { events: ["call.completed", "message.received", "appointment.booked", "followup.created", "contact.opted_out"] },
    // TELEPHONY_PROVIDER, TWILIO_ACCOUNT_SID, PUBLIC_BASE_URL (Studio → Services → Configuration).
    configuration: true,
    // The model agents converse with (Studio → Models).
    intelligence: true,
  },
});

/** Business data: FeltKit stamps the session's business into businessId and filters every read and write by it. */
const B = { tenant: { field: "businessId" } } as const;

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];
/** Opening hours for one day, "09:00"–"17:00" in the business's time zone. Absent day: closed. */
const Hours = s.object({ day: s.enum(DAYS), open: s.string({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }), close: s.string({ pattern: "^([01]\\d|2[0-4]):[0-5]\\d$" }) });
const E164 = s.string({ pattern: "^\\+[1-9]\\d{6,14}$" });

// ── Business configuration ──────────────────────────────────────────────────

export const businesses = app.collection("businesses", {
  businessId: s.string(),
  name: s.string({ minLength: 1, maxLength: 120 }),
  /** IANA time zone, e.g. "America/New_York". Hours, quiet hours and availability use it. */
  timezone: s.string({ minLength: 1, maxLength: 64 }),
  hours: s.array(Hours, { maxItems: 14 }),
  /** What callers should know: address, services, prices. Agents read it through business.info. */
  about: s.string({ maxLength: 4000 }),
  /** People a call or conversation may be handed to. Agents choose among these ids, never a free-form number. */
  escalation: s.array(s.object({ id: s.string({ minLength: 1, maxLength: 32 }), name: s.string({ maxLength: 80 }), phone: E164 }), { maxItems: 10 }),
  appointmentMinutes: s.integer({ minimum: 10, maximum: 240 }),
  /**
   * Communication policy. Defaults are the safe ones (see business:ensure): no recording, quiet hours
   * 21:00–08:00, outbound calls only to contacts with consent, a sender line on first contact.
   */
  policy: s.object({
    /** Store transcripts of calls. Audio is never recorded by this application. */
    transcripts: s.boolean(),
    /** Spoken at the start of every call when transcripts are on. */
    disclosure: s.string({ maxLength: 300 }),
    transcriptRetentionDays: s.integer({ minimum: 1, maximum: 3650 }),
    quietStart: s.string({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
    quietEnd: s.string({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
    outboundCalls: s.boolean(),
    maxOutboundCallsPerHour: s.integer({ minimum: 0, maximum: 100 }),
    /** Text the sender line and opt-out instructions on the first message to a contact. */
    smsSenderLine: s.boolean(),
    /** Text a caller back when a call is missed (only to contacts who have not opted out). */
    missedCallTextBack: s.boolean(),
  }),
  updatedAt: s.number(),
  updatedBy: s.string(),
}, { ...B, description: "One per business: identity, hours, time zone, escalation contacts and communication policy.", unique: [["businessId"]] });

export const CAPABILITIES = [
  "contacts.lookup", "business.info", "appointments.availability", "appointments.book",
  "followups.create", "sms.send", "calls.transfer", "conversations.history",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const agents = app.collection("agents", {
  businessId: s.string(),
  name: s.string({ minLength: 1, maxLength: 60 }),
  purpose: s.string({ maxLength: 200 }),
  /** The agent's instructions. Business facts come from the business record, not from here. */
  instructions: s.string({ maxLength: 8000 }),
  greeting: s.string({ maxLength: 300 }),
  /** Voice and language for speech (Twilio ConversationRelay: ttsProvider, voice, language). */
  voice: s.object({ ttsProvider: s.enum(["ElevenLabs", "Google", "Amazon"]), voice: s.optional(s.string({ maxLength: 80 })), language: s.string({ maxLength: 16 }) }),
  /**
   * "environment": converse with the model selected in Studio → Models. "deterministic": the built-in
   * scripted agent (no model, no key): it books, texts, takes messages and transfers.
   */
  brain: s.enum(["environment", "deterministic"]),
  temperature: s.number({ minimum: 0, maximum: 1 }),
  /** The capabilities this agent may invoke. Anything else is refused, whatever the model asks. */
  capabilities: s.array(s.enum(CAPABILITIES), { maxItems: CAPABILITIES.length }),
  /** Hand the call to a human (an escalation id) when the caller asks for one or the agent cannot help. */
  escalateTo: s.optional(s.string({ maxLength: 32 })),
  /** "always", or only outside / inside business hours. */
  schedule: s.enum(["always", "after_hours", "business_hours"]),
  smsAutoReply: s.boolean(),
  active: s.boolean(),
  createdAt: s.number(),
  updatedAt: s.number(),
}, { ...B, description: "Voice and SMS agents: instructions, voice, model, granted capabilities, escalation and schedule.", indexes: [{ fields: ["businessId"] }] });

export const phoneNumbers = app.collection("phoneNumbers", {
  businessId: s.string(),
  e164: E164,
  label: s.string({ maxLength: 60 }),
  provider: s.enum(["twilio", "simulator"]),
  sms: s.boolean(),
  voice: s.boolean(),
  /** The agent that answers. None: calls go to the fallback, texts land in the inbox. */
  agentId: s.optional(s.string()),
  /** When no agent may answer (schedule, inactive): forward to this escalation id, else take a message. */
  fallbackEscalationId: s.optional(s.string({ maxLength: 32 })),
  /** Use as caller ID for outbound calls and texts. */
  outbound: s.boolean(),
  createdAt: s.number(),
}, { ...B, description: "Phone numbers this business owns: provider, SMS/voice, the answering agent, fallback routing, caller ID.", unique: [["e164"]], indexes: [{ fields: ["businessId"] }] });

/**
 * Which business a number belongs to, for provider events that arrive before any business is known.
 * Not business data: written only in the same transaction as phoneNumbers, read only by the voice runtime.
 */
export const numberRoutes = app.collection("numberRoutes", {
  e164: E164,
  businessId: s.string(),
  numberId: s.string(),
  provider: s.enum(["twilio", "simulator"]),
}, { description: "Routing table: phone number → business (maintained by numbers:*; read by the voice runtime only).", unique: [["e164"]] });

// ── Contacts and consent ────────────────────────────────────────────────────

export const contacts = app.collection("contacts", {
  businessId: s.string(),
  phone: E164,
  name: s.optional(s.string({ maxLength: 120 })),
  email: s.optional(s.string({ maxLength: 200 })),
  notes: s.optional(s.string({ maxLength: 4000 })),
  tags: s.array(s.string({ maxLength: 32 }), { maxItems: 20 }),
  /** STOP (or an operator) opts the contact out of texts; START opts back in. */
  smsOptOut: s.boolean(),
  /** Never place outbound calls to this contact. */
  doNotCall: s.boolean(),
  /** Consent to be called: given (when, how) or not. Outbound calls require it. */
  callConsent: s.optional(s.object({ at: s.number(), source: s.string({ maxLength: 200 }) })),
  firstSeenAt: s.number(),
  lastContactAt: s.number(),
}, { ...B, description: "People who call and text the business, with consent and opt-out state.", unique: [["businessId", "phone"]], indexes: [{ fields: ["businessId", "lastContactAt"] }], search: ["name", "phone", "notes"] });

// ── Communications ──────────────────────────────────────────────────────────

/** One conversation per contact per business: calls, texts and notes in one history. */
export const conversations = app.collection("conversations", {
  businessId: s.string(),
  contactId: s.ref(contacts),
  status: s.enum(["open", "closed"]),
  unread: s.integer({ minimum: 0 }),
  lastAt: s.number(),
  lastPreview: s.string({ maxLength: 200 }),
  lastKind: s.enum(["sms", "call", "note"]),
  createdAt: s.number(),
}, { ...B, description: "The unified inbox: one conversation per contact.", unique: [["businessId", "contactId"]], indexes: [{ fields: ["businessId", "lastAt"] }] });

export const MESSAGE_STATUS = ["received", "queued", "sending", "sent", "delivered", "failed", "undelivered", "blocked", "unknown"] as const;

export const messages = app.collection("messages", {
  businessId: s.string(),
  conversationId: s.ref(conversations),
  kind: s.enum(["sms", "note"]),
  direction: s.enum(["inbound", "outbound", "internal"]),
  body: s.string({ maxLength: 1600 }),
  media: s.array(s.object({ url: s.string(), contentType: s.string() }), { maxItems: 10 }),
  /** Inbound: received. Outbound: queued → sending → sent (the provider accepted it) → delivered, or failed/undelivered/blocked; unknown when a send was interrupted and its outcome cannot be known. */
  status: s.enum(MESSAGE_STATUS),
  from: s.optional(s.string()),
  to: s.optional(s.string()),
  provider: s.optional(s.enum(["twilio", "simulator"])),
  /** The provider's id: the receipt. Unique, so a repeated webhook cannot create a second message. */
  providerSid: s.optional(s.string()),
  /** The sender's idempotency key: repeating a send with the same key returns the first message. */
  idempotencyKey: s.optional(s.string()),
  error: s.optional(s.string({ maxLength: 300 })),
  /** Who wrote it: a principal id, "contact", or an agent id. */
  author: s.string(),
  authorKind: s.enum(["contact", "human", "agent", "system"]),
  callId: s.optional(s.string()),
  createdAt: s.number(),
  updatedAt: s.number(),
}, {
  ...B,
  description: "Texts (both directions) and internal notes, with provider receipts and delivery state.",
  unique: [{ fields: ["providerSid"], sparse: true }, { fields: ["businessId", "idempotencyKey"], sparse: true }],
  indexes: [{ fields: ["conversationId", "createdAt"] }, { fields: ["businessId", "status"] }],
  search: ["body"],
});

export const CALL_STATUS = ["queued", "initiated", "ringing", "in-progress", "completed", "busy", "no-answer", "failed", "canceled"] as const;

export const calls = app.collection("calls", {
  businessId: s.string(),
  conversationId: s.ref(conversations),
  contactId: s.ref(contacts),
  numberId: s.string(),
  direction: s.enum(["inbound", "outbound"]),
  provider: s.enum(["twilio", "simulator"]),
  providerSid: s.optional(s.string()),
  from: s.string(),
  to: s.string(),
  /** The provider's call status, advanced only forward (late or repeated callbacks cannot move it back). */
  status: s.enum(CALL_STATUS),
  /** How the call was handled: by an agent, forwarded to a person, or a message was taken. */
  handling: s.enum(["agent", "forward", "voicemail", "operator"]),
  agentId: s.optional(s.string()),
  /** The live media session (ConversationRelay WebSocket): open, closed by us, or lost. */
  session: s.enum(["none", "connected", "ended", "lost"]),
  /** Secret binding the media session to this call (hash only; the token is in the TwiML URL). */
  sessionTokenHash: s.optional(s.string()),
  transfer: s.optional(s.object({ to: s.string(), toName: s.string(), status: s.enum(["requested", "dialing", "completed", "failed"]), reason: s.string({ maxLength: 200 }), by: s.string(), at: s.number() })),
  /** A human operator's control of a live call (calls:control). The runtime applies it and reports back. */
  control: s.optional(s.object({ seq: s.integer(), action: s.enum(["hangup", "transfer", "takeover", "release", "say"]), text: s.optional(s.string({ maxLength: 500 })), escalationId: s.optional(s.string()), by: s.string(), at: s.number(), applied: s.boolean() })),
  takenOver: s.optional(s.string()),
  outcome: s.optional(s.enum(["resolved", "appointment_booked", "message_taken", "transferred", "missed", "abandoned", "failed"])),
  summary: s.optional(s.string({ maxLength: 2000 })),
  startedAt: s.number(),
  answeredAt: s.optional(s.number()),
  endedAt: s.optional(s.number()),
  durationSec: s.optional(s.integer({ minimum: 0 })),
  startedBy: s.optional(s.string()),
}, {
  ...B,
  description: "Phone calls with provider receipts, live state, transfers, operator control and outcomes.",
  unique: [{ fields: ["providerSid"], sparse: true }],
  indexes: [{ fields: ["businessId", "startedAt"] }, { fields: ["businessId", "status"] }, { fields: ["conversationId"] }],
});

export const transcripts = app.collection("transcripts", {
  businessId: s.string(),
  callId: s.ref(calls),
  /** Order within the call, assigned by the voice runtime: a repeated write of the same seq is a no-op. */
  seq: s.integer({ minimum: 0 }),
  speaker: s.enum(["caller", "agent", "operator", "system"]),
  text: s.string({ maxLength: 4000 }),
  /** The agent was cut off (barge-in): `text` is what was spoken before the interruption. */
  interrupted: s.boolean(),
  /** The caller hung up mid-utterance: the last words, as far as recognised. */
  partial: s.boolean(),
  at: s.number(),
}, { ...B, description: "Call transcripts, one record per turn (kept only when the business's policy allows).", unique: [["callId", "seq"]], indexes: [{ fields: ["callId", "seq"] }, { fields: ["businessId", "at"] }] });

// ── Work the agents do ──────────────────────────────────────────────────────

/** Every capability an agent invoked: who, what, the decision, the result. The audit trail of agent work. */
export const invocations = app.collection("invocations", {
  businessId: s.string(),
  agentId: s.string(),
  callId: s.optional(s.string()),
  conversationId: s.optional(s.string()),
  capability: s.string(),
  /** The arguments as validated (no secrets are ever arguments). */
  args: s.record(s.unknown()),
  decision: s.enum(["allowed", "denied"]),
  status: s.enum(["succeeded", "failed", "denied"]),
  result: s.optional(s.record(s.unknown())),
  error: s.optional(s.string({ maxLength: 500 })),
  /** The runtime's id for this tool call: repeating it returns the first result instead of acting twice. */
  idempotencyKey: s.string(),
  at: s.number(),
}, { ...B, description: "Agent capability invocations with authorization decision and result (the agent's audit trail).", unique: [["businessId", "idempotencyKey"]], indexes: [{ fields: ["callId"] }, { fields: ["conversationId"] }, { fields: ["businessId", "at"] }] });

export const appointments = app.collection("appointments", {
  businessId: s.string(),
  contactId: s.ref(contacts),
  startsAt: s.number(),
  endsAt: s.number(),
  /** "YYYY-MM-DDTHH:MM" in the business's time zone: unique, so one slot is booked once. */
  slot: s.string(),
  status: s.enum(["booked", "cancelled"]),
  reason: s.optional(s.string({ maxLength: 300 })),
  bookedBy: s.string(),
  callId: s.optional(s.string()),
  createdAt: s.number(),
}, { ...B, description: "Appointments booked by agents or staff (the system of record for availability).", unique: [["businessId", "slot"]], indexes: [{ fields: ["businessId", "startsAt"] }, { fields: ["contactId"] }] });

export const tasks = app.collection("tasks", {
  businessId: s.string(),
  title: s.string({ minLength: 1, maxLength: 200 }),
  detail: s.optional(s.string({ maxLength: 2000 })),
  contactId: s.optional(s.string()),
  conversationId: s.optional(s.string()),
  callId: s.optional(s.string()),
  due: s.optional(s.number()),
  status: s.enum(["open", "done"]),
  createdBy: s.string(),
  createdByKind: s.enum(["human", "agent", "system"]),
  doneBy: s.optional(s.string()),
  createdAt: s.number(),
  doneAt: s.optional(s.number()),
}, { ...B, description: "Follow-ups for people: created by agents, staff, or missed calls.", indexes: [{ fields: ["businessId", "status"] }, { fields: ["conversationId"] }] });

/** Meaningful changes in a business, including configuration changes and consent. */
export const audit = app.collection("audit", {
  businessId: s.string(),
  actor: s.string(),
  actorKind: s.enum(["human", "agent", "system", "provider"]),
  type: s.string({ maxLength: 64 }),
  summary: s.string({ maxLength: 300 }),
  subjectId: s.optional(s.string()),
  at: s.number(),
}, { ...B, description: "Audit log: calls, texts, agent actions, interventions, transfers, configuration and consent changes.", indexes: [{ fields: ["businessId", "at"] }, { fields: ["type"] }] });

// ── Provider events and runtime work (not business data) ───────────────────

/**
 * Every provider event once: (provider, key) is unique, so a duplicate or replayed webhook is
 * recognised and not processed again. Holds identifiers and outcome only, not message bodies.
 */
export const providerEvents = app.collection("providerEvents", {
  provider: s.enum(["twilio", "simulator"]),
  key: s.string({ maxLength: 200 }),
  kind: s.string({ maxLength: 40 }),
  businessId: s.optional(s.string()),
  outcome: s.string({ maxLength: 200 }),
  at: s.number(),
}, { description: "Provider webhook receipts, deduplicated by provider event key (idempotency and replay protection).", unique: [["provider", "key"]], indexes: [{ fields: ["at"] }] });

/**
 * Work the voice runtime performs outside a request: sending a text, dialling a call, answering a
 * text with an agent, summarising a call. Written in the same transaction as the record it is for,
 * so work is never lost; leased, so a restarted runtime picks up what an earlier one left.
 */
export const work = app.collection("work", {
  businessId: s.string(),
  kind: s.enum(["sms.send", "call.dial", "agent.sms", "call.summarize"]),
  refId: s.string(),
  status: s.enum(["pending", "leased", "done", "failed"]),
  attempts: s.integer({ minimum: 0 }),
  leaseUntil: s.number(),
  lastError: s.optional(s.string({ maxLength: 300 })),
  createdAt: s.number(),
  updatedAt: s.number(),
}, { description: "Durable work queue for the voice runtime (send, dial, agent replies, summaries).", unique: [["kind", "refId"]], indexes: [{ fields: ["status", "leaseUntil"] }] });

/** What the running voice runtime last reported: provider, readiness, problems. Shown on Setup. */
export const runtimeStatus = app.collection("runtimeStatus", {
  provider: s.enum(["twilio", "simulator"]),
  ready: s.boolean(),
  problems: s.array(s.string({ maxLength: 300 })),
  publicBaseUrl: s.optional(s.string()),
  signatureFailures: s.integer({ minimum: 0 }),
  lastWebhookAt: s.optional(s.number()),
  startedAt: s.number(),
  heartbeatAt: s.number(),
}, { description: "Health of the telephony runtime, as it last reported it." });
