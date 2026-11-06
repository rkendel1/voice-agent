/**
 * The development simulator: a deterministic stand-in for a telephony provider, so the whole
 * application can be exercised without buying a number or holding credentials. It is a provider
 * adapter like Twilio's: events it produces go through the same runtime handlers and application
 * functions, and media sessions use the same ConversationRelay protocol. Everything it creates is
 * recorded with provider "simulator" and labelled as simulated in the UI.
 *
 * Its "phones" (what a simulated contact has received, calls ringing at a simulated phone) are held
 * in memory: they stand for the outside world, not for application state.
 *
 * Deterministic failure numbers, for trying failure paths:
 *   +15550000999  every text to it is refused by the "provider"
 *   +15550000998  every text to it is accepted, then reported undelivered
 */
import { randomUUID } from "node:crypto";
import type { OutboundResult, TelephonyProvider } from "./types.js";

export const SIM_REFUSE = "+15550000999";
export const SIM_UNDELIVERED = "+15550000998";

export interface SimText { sid: string; from: string; to: string; body: string; at: number }
export interface SimRinging { sid: string; from: string; to: string; answerUrl: string; statusCallbackUrl: string; at: number }

export class SimulatorProvider implements TelephonyProvider {
  readonly id = "simulator" as const;
  readonly texts = new Map<string, SimText[]>();
  readonly ringing = new Map<string, SimRinging>();
  /** Called with delivery reports, as Twilio would POST them. */
  onSmsStatus: (sid: string, status: string, errorCode?: string) => void = () => {};
  /** Called with call status changes for calls it placed. */
  onCallStatus: (ring: SimRinging, status: string) => void = () => {};

  async sendSms(input: { from: string; to: string; body: string }): Promise<OutboundResult> {
    if (input.to === SIM_REFUSE) return { outcome: "refused", error: "Simulator: this number does not accept texts (21610)." };
    const sid = `SMsim${randomUUID().replace(/-/g, "").slice(0, 26)}`;
    const list = this.texts.get(input.to) ?? [];
    list.push({ sid, from: input.from, to: input.to, body: input.body, at: Date.now() });
    this.texts.set(input.to, list.slice(-200));
    setTimeout(() => this.onSmsStatus(sid, "sent"), 50);
    setTimeout(() => (input.to === SIM_UNDELIVERED ? this.onSmsStatus(sid, "undelivered", "30003") : this.onSmsStatus(sid, "delivered")), 250);
    return { outcome: "accepted", sid };
  }

  async dial(input: { from: string; to: string; answerUrl: string; statusCallbackUrl: string }): Promise<OutboundResult> {
    const sid = `CAsim${randomUUID().replace(/-/g, "").slice(0, 26)}`;
    const ring = { sid, ...input, at: Date.now() };
    this.ringing.set(sid, ring);
    setTimeout(() => this.onCallStatus(ring, "ringing"), 20);
    // Unanswered for 45 s: no-answer, as a real phone would.
    setTimeout(() => { if (this.ringing.delete(sid)) this.onCallStatus(ring, "no-answer"); }, 45_000).unref?.();
    return { outcome: "accepted", sid };
  }
}
