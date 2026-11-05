/**
 * Operations shared by functions: no policy decisions about *who* may act (that is `authorize`),
 * but every communication rule about *what* may be sent is here, in one path.
 */
import { fail, type DatabaseReader, type DatabaseWriter, type Doc } from "@feltdb/feltkit";
import { audit, businesses, contacts, conversations, messages, phoneNumbers, work } from "./app.js";
import { inQuietHours, withSenderLine } from "./_policy.js";

export type BusinessDoc = Doc<typeof businesses.shape>;
export type ContactDoc = Doc<typeof contacts.shape>;
export type ConversationDoc = Doc<typeof conversations.shape>;
type W = { db: DatabaseWriter };
type R = { db: DatabaseReader };

export async function loadBusiness(ctx: R): Promise<BusinessDoc> {
  const [b] = await ctx.db.find(businesses, {});
  return b ?? fail("FAILED_PRECONDITION", "This business is not set up yet.", { hint: "An owner or admin opens the app once (business:ensure)." });
}

export async function recordAudit(ctx: W, businessId: string, actor: string, actorKind: "human" | "agent" | "system" | "provider", type: string, summary: string, subjectId?: string) {
  await ctx.db.insert(audit, { businessId, actor, actorKind, type, summary: summary.slice(0, 300), ...(subjectId ? { subjectId } : {}), at: Date.now() });
}

export async function ensureContact(ctx: W, businessId: string, phone: string, now: number): Promise<ContactDoc> {
  const [c] = await ctx.db.find(contacts, { phone });
  if (c) {
    await ctx.db.patch(contacts, c.id, { lastContactAt: now });
    return { ...c, lastContactAt: now };
  }
  const id = await ctx.db.insert(contacts, { businessId, phone, tags: [], smsOptOut: false, doNotCall: false, firstSeenAt: now, lastContactAt: now });
  return (await ctx.db.get(contacts, id))!;
}

export async function ensureConversation(ctx: W, businessId: string, contactId: string, now: number): Promise<ConversationDoc> {
  const [c] = await ctx.db.find(conversations, { contactId });
  if (c) return c;
  const id = await ctx.db.insert(conversations, { businessId, contactId, status: "open", unread: 0, lastAt: now, lastPreview: "", lastKind: "sms", createdAt: now });
  return (await ctx.db.get(conversations, id))!;
}

export async function touchConversation(ctx: W, conversation: ConversationDoc, kind: "sms" | "call" | "note", preview: string, unread: number, now: number) {
  const fresh = (await ctx.db.get(conversations, conversation.id))!;
  await ctx.db.patch(conversations, conversation.id, {
    lastAt: now, lastKind: kind, lastPreview: preview.slice(0, 200), unread: fresh.unread + unread,
    ...(unread > 0 ? { status: "open" as const } : {}),
  });
}

/** Queue work for the voice runtime, once per (kind, ref): in the caller's transaction. */
export async function enqueue(ctx: W, businessId: string, kind: "sms.send" | "call.dial" | "agent.sms" | "call.summarize", refId: string, now = Date.now()) {
  const [existing] = await ctx.db.find(work, { kind, refId });
  if (existing) return existing.id;
  return ctx.db.insert(work, { businessId, kind, refId, status: "pending", attempts: 0, leaseUntil: 0, createdAt: now, updatedAt: now });
}

export interface QueueSms {
  business: BusinessDoc;
  conversation: ConversationDoc;
  contact: ContactDoc;
  body: string;
  author: string;
  authorKind: "human" | "agent" | "system";
  idempotencyKey: string;
  callId?: string;
  /** Answers the contact (they wrote or called within the last 24 hours): allowed in quiet hours. */
  now: number;
}

export type QueueResult = { messageId: string; status: "queued" | "blocked"; reason?: string; duplicate: boolean; body: string; from?: string };

/**
 * Queue a text to a contact, enforcing the business's communication policy. A refused text is still
 * recorded (status "blocked", with the reason) so the refusal is visible; it is never sent.
 */
export async function queueSms(ctx: W, q: QueueSms): Promise<QueueResult> {
  const [prior] = await ctx.db.find(messages, { idempotencyKey: q.idempotencyKey });
  if (prior) return { messageId: prior.id, status: prior.status === "blocked" ? "blocked" : "queued", ...(prior.error ? { reason: prior.error } : {}), duplicate: true, body: prior.body, ...(prior.from ? { from: prior.from } : {}) };
  const text = q.body.trim();
  if (!text) fail("INVALID_ARGUMENT", "A text needs a body.");
  if (text.length > 1400) fail("INVALID_ARGUMENT", "A text is at most 1400 characters.");

  const history = await ctx.db.find(messages, { conversationId: q.conversation.id });
  const recentInbound = history.some((m) => m.direction === "inbound" && m.kind === "sms" && q.now - m.createdAt < 24 * 3600_000);
  const recentCall = q.contact.lastContactAt > q.now - 24 * 3600_000 && Boolean(q.callId);
  const firstOutbound = !history.some((m) => m.direction === "outbound" && m.kind === "sms" && m.status !== "blocked");
  const numbers = (await ctx.db.find(phoneNumbers, {})).filter((n) => n.sms);
  const lastTo = [...history].reverse().find((m) => m.direction === "inbound" && m.to)?.to;
  const from = numbers.find((n) => n.e164 === lastTo) ?? numbers.find((n) => n.outbound) ?? numbers[0];

  let reason: string | undefined;
  if (q.contact.smsOptOut) reason = "The contact opted out of texts (STOP).";
  else if (!from) reason = "The business has no SMS-enabled phone number.";
  else if (!recentInbound && !recentCall && inQuietHours(q.business.policy.quietStart, q.business.policy.quietEnd, q.business.timezone, q.now)) reason = `Quiet hours (${q.business.policy.quietStart}–${q.business.policy.quietEnd}): only replies to a contact who wrote or called in the last 24 hours are sent.`;

  const body = firstOutbound && q.business.policy.smsSenderLine ? withSenderLine(text, q.business.name) : text;
  const messageId = await ctx.db.insert(messages, {
    businessId: q.business.businessId, conversationId: q.conversation.id, kind: "sms", direction: "outbound", body, media: [],
    status: reason ? "blocked" : "queued", ...(from ? { from: from.e164, provider: from.provider } : {}), to: q.contact.phone,
    idempotencyKey: q.idempotencyKey, ...(reason ? { error: reason } : {}), author: q.author, authorKind: q.authorKind,
    ...(q.callId ? { callId: q.callId } : {}), createdAt: q.now, updatedAt: q.now,
  });
  await touchConversation(ctx, q.conversation, "sms", reason ? `Not sent: ${reason}` : body, 0, q.now);
  if (!reason) await enqueue(ctx, q.business.businessId, "sms.send", messageId, q.now);
  await recordAudit(ctx, q.business.businessId, q.author, q.authorKind, reason ? "sms.blocked" : "sms.queued", reason ? `Text to ${q.contact.phone} not sent: ${reason}` : `Text to ${q.contact.phone} queued`, messageId);
  return { messageId, status: reason ? "blocked" : "queued", ...(reason ? { reason } : {}), duplicate: false, body, ...(from ? { from: from.e164 } : {}) };
}
