/**
 * Communication policy and scheduling, as pure functions: no I/O, no clock unless passed in.
 * Used by the functions in feltkit/ and by the voice runtime, and tested directly.
 */
import type { Day } from "./app.js";

const DAY_NAMES: Day[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as unknown as Day[];

/** The wall-clock parts of an instant in a time zone. */
export function localParts(at: number, timezone: string): { date: string; time: string; day: Day; minutes: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  const day = String(p.weekday).toLowerCase().slice(0, 3) as Day;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, day, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** The instant of a local wall-clock time ("2026-11-06", "14:30") in a time zone. */
export function localToEpoch(date: string, time: string, timezone: string): number {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes of "how far is the zone from UTC at this instant" settle DST boundaries.
  let at = guess;
  for (let i = 0; i < 2; i++) {
    const p = localParts(at, timezone);
    const [py, pm, pd] = p.date.split("-").map(Number) as [number, number, number];
    const shown = Date.UTC(py, pm - 1, pd, Math.floor(p.minutes / 60), p.minutes % 60);
    at += guess - shown;
  }
  return at;
}

export const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export interface Hours { day: Day; open: string; close: string }

/** Whether the business is open at an instant. */
export function isOpen(hours: readonly Hours[], timezone: string, at: number): boolean {
  const p = localParts(at, timezone);
  return hours.some((h) => h.day === p.day && p.minutes >= toMinutes(h.open) && p.minutes < toMinutes(h.close));
}

/** Whether an instant falls in quiet hours (start > end wraps past midnight). */
export function inQuietHours(quietStart: string, quietEnd: string, timezone: string, at: number): boolean {
  const m = localParts(at, timezone).minutes;
  const s = toMinutes(quietStart), e = toMinutes(quietEnd);
  return s === e ? false : s < e ? m >= s && m < e : m >= s || m < e;
}

/** Whether an agent with this schedule may answer now. */
export function agentOnDuty(schedule: "always" | "after_hours" | "business_hours", open: boolean): boolean {
  return schedule === "always" || (schedule === "after_hours" ? !open : open);
}

/** Free appointment slots on a local date: inside opening hours, not in the past, not booked. */
export function freeSlots(input: { hours: readonly Hours[]; timezone: string; date: string; minutes: number; booked: ReadonlySet<string>; now: number }): Array<{ slot: string; startsAt: number; time: string }> {
  const noon = localToEpoch(input.date, "12:00", input.timezone);
  const day = localParts(noon, input.timezone).day;
  const out: Array<{ slot: string; startsAt: number; time: string }> = [];
  for (const h of input.hours.filter((x) => x.day === day)) {
    for (let m = toMinutes(h.open); m + input.minutes <= toMinutes(h.close); m += input.minutes) {
      const time = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      const slot = `${input.date}T${time}`;
      const startsAt = localToEpoch(input.date, time, input.timezone);
      if (startsAt > input.now && !input.booked.has(slot)) out.push({ slot, startsAt, time });
    }
  }
  return out;
}

/** A local date `days` after an instant's local date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Carrier-standard keywords. A body that is exactly one of these (any case, trimmed) is a command. */
const STOP = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "revoke", "optout"]);
const START = new Set(["start", "unstop", "yes", "subscribe"]);
const HELP = new Set(["help", "info"]);
export function smsKeyword(body: string): "stop" | "start" | "help" | null {
  const w = body.trim().toLowerCase().replace(/[.!]+$/, "");
  return STOP.has(w) ? "stop" : START.has(w) ? "start" : HELP.has(w) ? "help" : null;
}

/** The sender line and opt-out instructions added to the first text a contact receives. */
export function withSenderLine(body: string, businessName: string): string {
  return `${businessName}: ${body}\nReply STOP to opt out.`;
}

/** Provider status order. A status may only move forward; terminal ones never change. */
const SMS_RANK: Record<string, number> = { received: 0, queued: 1, sending: 2, sent: 3, unknown: 3, delivered: 4, undelivered: 4, failed: 4, blocked: 4 };
export function smsAdvances(from: string, to: string): boolean {
  return (SMS_RANK[to] ?? -1) > (SMS_RANK[from] ?? -1);
}
const CALL_RANK: Record<string, number> = { queued: 0, initiated: 1, ringing: 2, "in-progress": 3, completed: 4, busy: 4, "no-answer": 4, failed: 4, canceled: 4 };
export function callAdvances(from: string, to: string): boolean {
  return (CALL_RANK[to] ?? -1) > (CALL_RANK[from] ?? -1);
}
export const CALL_TERMINAL = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (/^\+[1-9]\d{6,14}$/.test(digits)) return digits;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return null;
}

export const DAY_ORDER: readonly Day[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export { DAY_NAMES };
