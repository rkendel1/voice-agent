/**
 * The provider adapter boundary. Everything provider-specific (wire formats, signatures, REST calls,
 * call-control markup) is behind it; the application and the voice session see only these types.
 *
 * Media sessions use one protocol for every provider: Twilio ConversationRelay's JSON messages
 * (setup / prompt / interrupt / dtmf in; text / end out). Twilio speaks it natively and does speech
 * recognition, speech synthesis and barge-in detection; the simulator speaks it from the browser.
 * A provider that streams raw audio would add an adapter that turns audio into these messages.
 */
export type ProviderId = "twilio" | "simulator";

/** The answer to a request that may have an effect at the provider. */
export interface OutboundResult {
  /**
   * accepted: the provider took it and gave a receipt (sid).
   * refused:  the provider said no, or it never reached the provider (safe to retry when `retryable`).
   * unknown:  it may have reached the provider (timeout, dropped connection): never retried automatically.
   */
  outcome: "accepted" | "refused" | "unknown";
  sid?: string;
  error?: string;
  retryable?: boolean;
}

export interface TelephonyProvider {
  readonly id: ProviderId;
  sendSms(input: { from: string; to: string; body: string; statusCallbackUrl: string }): Promise<OutboundResult>;
  dial(input: { from: string; to: string; answerUrl: string; statusCallbackUrl: string }): Promise<OutboundResult>;
}

/** Provider-neutral events the runtime hands to the application. */
export interface InboundSms { provider: ProviderId; sid: string; from: string; to: string; body: string; media: Array<{ url: string; contentType: string }> }
export interface SmsStatus { provider: ProviderId; sid: string; status: string; errorCode?: string }
export interface InboundCall { provider: ProviderId; sid: string; from: string; to: string }
export interface CallStatus { provider: ProviderId; sid: string; status: string; duration?: number; callId?: string; businessId?: string }

/** How a call is answered, decided by the application from configuration. */
export interface AnswerPlan {
  kind: "relay" | "forward" | "unavailable" | "reject";
  relayUrl?: string;
  actionUrl?: string;
  voice?: { ttsProvider: string; voice?: string; language: string };
  forwardTo?: string;
  callerId?: string;
  say?: string;
}

/** ConversationRelay messages (the subset this runtime uses). */
export type RelayIn =
  | { type: "setup"; sessionId?: string; callSid?: string; from?: string; to?: string; direction?: string; customParameters?: Record<string, string> }
  | { type: "prompt"; voicePrompt: string; lang?: string; last: boolean }
  | { type: "interrupt"; utteranceUntilInterrupt: string; durationUntilInterruptMs?: number }
  | { type: "dtmf"; digit: string }
  | { type: "error"; description: string }
  | { type: "info"; [k: string]: unknown };
export type RelayOut =
  | { type: "text"; token: string; last: boolean; interruptible?: boolean }
  | { type: "end"; handoffData?: string };
