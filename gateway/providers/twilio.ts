/**
 * Twilio: Programmable Messaging for SMS, Programmable Voice with ConversationRelay for calls.
 * Everything Twilio-specific is in this file: request signatures, TwiML, and the two REST calls.
 *
 * Signatures (X-Twilio-Signature): HMAC-SHA1 over the full URL Twilio requested followed by the POST
 * parameters sorted by name (name and value concatenated, no delimiters), keyed with the account's
 * auth token, base64. The URL is reconstructed from PUBLIC_BASE_URL, which must be exactly what
 * Twilio is configured to call. Twilio's signatures carry no timestamp, so replay protection is the
 * application's: every event is recorded once by its Twilio id (feltkit/gateway.ts).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AnswerPlan, OutboundResult, TelephonyProvider } from "./types.js";

export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

/** Whether a request's signature is valid for any of the candidate URLs (WebSocket handshakes may be signed with a trailing "/"). */
export function verifyTwilio(authToken: string, signature: string | undefined, urls: string[], params: Record<string, string>): boolean {
  if (!signature) return false;
  const given = Buffer.from(signature);
  return urls.some((url) => {
    const expected = Buffer.from(twilioSignature(authToken, url, params));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** TwiML for answering a call as the application decided. */
export function answerTwiml(plan: AnswerPlan): string {
  if (plan.kind === "relay") {
    const v = plan.voice!;
    const attrs = [
      `url="${esc(plan.relayUrl!)}"`, `language="${esc(v.language)}"`, `ttsProvider="${esc(v.ttsProvider)}"`, ...(v.voice ? [`voice="${esc(v.voice)}"`] : []),
      `interruptible="any"`, `dtmfDetection="true"`,
    ];
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect action="${esc(plan.actionUrl!)}"><ConversationRelay ${attrs.join(" ")}/></Connect></Response>`;
  }
  if (plan.kind === "forward") {
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${plan.say ? `<Say>${esc(plan.say)}</Say>` : ""}<Dial${plan.callerId ? ` callerId="${esc(plan.callerId)}"` : ""}>${esc(plan.forwardTo!)}</Dial></Response>`;
  }
  if (plan.kind === "unavailable") return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${esc(plan.say ?? "Sorry, we can't take your call right now.")}</Say><Hangup/></Response>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>`;
}

export const EMPTY_TWIML = `<?xml version="1.0" encoding="UTF-8"?><Response/>`;
export const HANGUP_TWIML = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;

export class TwilioProvider implements TelephonyProvider {
  readonly id = "twilio" as const;
  constructor(private readonly accountSid: string, private readonly authToken: string, private readonly fetchImpl: typeof fetch = fetch, private readonly apiBase = "https://api.twilio.com") {}

  sendSms(input: { from: string; to: string; body: string; statusCallbackUrl: string }): Promise<OutboundResult> {
    return this.#post("Messages.json", { To: input.to, From: input.from, Body: input.body, StatusCallback: input.statusCallbackUrl });
  }

  dial(input: { from: string; to: string; answerUrl: string; statusCallbackUrl: string }): Promise<OutboundResult> {
    const body = new URLSearchParams({ To: input.to, From: input.from, Url: input.answerUrl, Method: "POST", StatusCallback: input.statusCallbackUrl, StatusCallbackMethod: "POST" });
    for (const e of ["initiated", "ringing", "answered", "completed"]) body.append("StatusCallbackEvent", e);
    return this.#post("Calls.json", body);
  }

  async #post(resource: string, form: Record<string, string> | URLSearchParams): Promise<OutboundResult> {
    const url = `${this.apiBase}/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/${resource}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
        body: form instanceof URLSearchParams ? form : new URLSearchParams(form),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error: any) {
      // Never connected (DNS, refused): it did not reach Twilio, so retrying is safe. Anything else
      // (a timeout, a reset after sending) may have reached it: the outcome is unknown.
      const code = error?.cause?.code;
      if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "EAI_AGAIN") return { outcome: "refused", error: `Twilio unreachable (${code})`, retryable: true };
      return { outcome: "unknown", error: `No answer from Twilio: ${error?.name === "TimeoutError" ? "timed out" : String(error?.message ?? error)}` };
    }
    const json: any = await response.json().catch(() => ({}));
    if (response.ok && json.sid) return { outcome: "accepted", sid: json.sid };
    if (response.status >= 500) return { outcome: "unknown", error: `Twilio ${response.status}: ${json.message ?? response.statusText}` };
    return { outcome: "refused", error: `Twilio ${response.status}${json.code ? ` (${json.code})` : ""}: ${json.message ?? response.statusText}`, retryable: response.status === 429 };
  }
}
