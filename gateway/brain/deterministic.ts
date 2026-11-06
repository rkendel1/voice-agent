/**
 * The scripted agent: no model, no API key, fully deterministic. It answers questions about the
 * business, books appointments (offering real free slots), texts a confirmation, takes messages and
 * transfers to a person, all through the same authorized capabilities an LLM agent uses. Everything
 * it says about an action comes from that action's result.
 */
import { speakTime, toolsFor, type AgentContext, type Brain, type Channel, type ToolName, type TurnInput } from "./types.js";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SHORT: Record<string, string> = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const weekdayOf = (date: string) => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]!;

/** "tomorrow", "friday", "next tuesday", "today", "2026-11-07" → a date, relative to the business's today. */
export function parseDay(text: string, today: string): string | null {
  const t = text.toLowerCase();
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1]!;
  if (/\btoday\b/.test(t)) return today;
  if (/\btomorrow\b/.test(t)) return addDays(today, 1);
  const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b|\\b${w.slice(0, 3)}\\b`).test(t));
  if (wd >= 0) {
    const cur = WEEKDAYS.indexOf(weekdayOf(today));
    // A weekday name never means today ("today" does): Friday said on a Friday is next Friday.
    const diff = (wd - cur + 7) % 7 || 7;
    return addDays(today, diff);
  }
  return null;
}

/** "2pm", "2:30 pm", "14:30", "at 10", "noon" → "HH:MM". Bare 1–7 means afternoon. */
export function parseTime(text: string): string | null {
  const t = text.toLowerCase().replace(/\./g, "");
  if (/\bnoon\b/.test(t)) return "12:00";
  const m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a m|p m)?\b/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.replace(" ", "");
  if (h > 23 || min > 59) return null;
  if (!m[2] && !ap && !/\bat\s+\d/.test(t) && !/o'?clock/.test(t)) return null; // a bare number is not a time
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (!ap && h >= 1 && h <= 7) h += 12;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

const has = (t: string, ...words: string[]) => words.some((w) => new RegExp(`\\b${w}\\b`, "i").test(t));

type Slot = { date: string; time: string };

export class DeterministicBrain implements Brain {
  readonly kind = "deterministic";
  wantsHangup = false;
  #awaiting: null | "message" | "name" = null;
  #offered: Slot[] = [];
  #pendingSlot: Slot | null = null;
  readonly #tools: Set<ToolName>;

  constructor(private readonly ctx: AgentContext, private readonly channel: Channel) {
    this.#tools = new Set(toolsFor(ctx, channel));
  }

  interrupted(): void {}

  async turn({ userText, emit, runTool, signal }: TurnInput): Promise<void> {
    const t = userText.trim();
    const say = (s: string) => { if (!signal.aborted) emit(s); };
    const can = (n: ToolName) => this.#tools.has(n);
    const today = this.ctx.now.date;

    if (this.#awaiting === "message") {
      this.#awaiting = null;
      if (!can("followups_create")) return say("I'm sorry, I can't take messages. ");
      const r = await runTool("followups_create", { title: `Message from ${this.ctx.contact.name ?? this.ctx.contact.phone}`, detail: t });
      return say(r.ok ? "Thank you. I've passed your message on, and someone will get back to you. Is there anything else? " : `I'm sorry, I couldn't save your message: ${r.error}. `);
    }
    if (this.#awaiting === "name" && this.#pendingSlot) {
      this.#awaiting = null;
      const name = t.replace(/^(it'?s|this is|my name is|i'?m|name'?s)\s+/i, "").replace(/[.!]$/, "").slice(0, 80);
      return this.#book(this.#pendingSlot, name, say, runTool);
    }

    if (has(t, "bye", "goodbye", "that's all", "thats all", "no thanks", "nothing else")) {
      this.wantsHangup = this.channel === "voice";
      return say(`Thanks for contacting ${this.ctx.business.name}. Goodbye! `);
    }
    if (has(t, "person", "human", "someone", "representative", "operator", "reception", "receptionist", "staff") || t === "0") {
      if (this.channel === "voice" && can("calls_transfer")) {
        const r = await runTool("calls_transfer", { reason: `Caller asked for a person: "${t.slice(0, 120)}"` });
        return say(r.ok ? `Of course. I'm transferring you to ${r.to} now. ` : `I'm sorry, I can't transfer you right now (${r.error}). I can take a message instead — what would you like to pass on? `), void (r.ok || (this.#awaiting = "message"));
      }
      if (can("followups_create")) { this.#awaiting = "message"; return say("I'll make sure someone from the team gets back to you. What would you like me to pass on? "); }
    }
    const time = parseTime(t);
    const day = parseDay(t, today);
    const pick = this.#choose(t, time, day);
    if (pick) return this.#pendingOrBook(pick, say, runTool);
    if (has(t, "book", "appointment", "schedule", "available", "availability", "opening", "slot", "come in", "reschedule") || (this.#offered.length === 0 && day && time)) {
      if (day && time) return this.#pendingOrBook({ date: day, time }, say, runTool);
      return this.#offer(day ?? today, say, runTool);
    }
    if (has(t, "hours", "open", "close", "closed", "closing")) {
      if (!can("business_info")) return say("I'm not able to look that up. ");
      const r: any = await runTool("business_info", {});
      if (!r.ok) return say("I'm sorry, I couldn't look up our hours. ");
      return say(`We're ${r.openNow ? "open now" : "closed right now"}. Our hours are ${describeHours(r.hours)}. Would you like to book an appointment? `);
    }
    if (has(t, "where", "address", "located", "location", "insurance", "price", "prices", "cost", "services", "offer", "parking")) {
      return say(this.ctx.business.about ? `${this.ctx.business.about} ` : "I don't have those details, but I can take a message for the team. ");
    }
    if (has(t, "message", "call me back", "callback", "call back", "leave")) {
      if (!can("followups_create")) return say("I'm sorry, I can't take messages. ");
      this.#awaiting = "message";
      return say("Sure. What message would you like me to pass on? ");
    }
    if (has(t, "hello", "hi", "hey")) return say("Hi! How can I help you today? ");
    return say(`I can tell you about our hours, book an appointment, or take a message${can("calls_transfer") && this.channel === "voice" ? ", or connect you with a person" : ""}. What would you like? `);
  }

  /** A slot the person picked from the ones offered ("the first one", "9:30", "Thursday at 10"). */
  #choose(t: string, time: string | null, day: string | null): Slot | null {
    if (!this.#offered.length) return null;
    const ord = has(t, "first", "earliest", "that one", "sounds good", "perfect", "yes") ? 0 : has(t, "second") ? 1 : has(t, "third", "last") ? 2 : -1;
    if (time) return this.#offered.find((s) => s.time === time && (!day || s.date === day)) ?? (day ? { date: day, time } : { date: this.#offered[0]!.date, time });
    if (ord >= 0) return this.#offered[ord] ?? null;
    return null;
  }

  async #offer(from: string, say: (s: string) => void, runTool: TurnInput["runTool"]) {
    if (!this.#tools.has("appointments_availability")) return say("I'm sorry, I can't check appointments. ");
    const r: any = await runTool("appointments_availability", { date: from, days: 7 });
    if (!r.ok) return say(`I'm sorry, I couldn't check availability: ${r.error}. `);
    const first = r.days[0];
    if (!first) return say("I'm sorry, I don't see any free appointments in the next week. I can take a message for the team instead. ");
    this.#offered = first.slots.slice(0, 3).map((time: string) => ({ date: first.date, time }));
    const when = first.date === this.ctx.now.date ? "today" : first.date === addDays(this.ctx.now.date, 1) ? "tomorrow" : SHORT[first.weekday] ?? first.weekday;
    const list = this.#offered.map((s) => speakTime(s.time));
    return say(`The earliest I have is ${when} at ${list.length > 1 ? `${list.slice(0, -1).join(", ")} or ${list.at(-1)}` : list[0]}. Which would you like? `);
  }

  async #pendingOrBook(slot: Slot, say: (s: string) => void, runTool: TurnInput["runTool"]) {
    if (!this.ctx.contact.name) {
      this.#pendingSlot = slot;
      this.#awaiting = "name";
      return say(`${spokenDate(slot.date, this.ctx.now.date)} at ${speakTime(slot.time)}. Can I get your name for the booking? `);
    }
    return this.#book(slot, undefined, say, runTool);
  }

  async #book(slot: Slot, name: string | undefined, say: (s: string) => void, runTool: TurnInput["runTool"]) {
    this.#pendingSlot = null;
    if (!this.#tools.has("appointments_book")) return say("I'm sorry, I can't book appointments. I can take a message instead. ");
    const r: any = await runTool("appointments_book", { slot: `${slot.date}T${slot.time}`, ...(name ? { name } : {}) });
    if (!r.ok) {
      this.#offered = [];
      say(`I'm sorry, I couldn't book that: ${String(r.error ?? "it is not available")} `);
      return this.#offer(slot.date, say, runTool);
    }
    if (name) this.ctx.contact.name = name;
    this.#offered = [];
    say(`You're all set for ${r.when}. `);
    if (this.#tools.has("sms_send") && !this.ctx.contact.smsOptOut) {
      const sms = await runTool("sms_send", { body: `Your appointment at ${this.ctx.business.name} is confirmed for ${r.when}. Reply to this message if you need to change it.` });
      say(sms.ok ? (this.channel === "voice" ? "I've also texted you a confirmation. " : "") : `I wasn't able to text you a confirmation (${String(sms.error ?? "not sent")}). `);
    }
    say("Is there anything else I can help with? ");
  }
}

function spokenDate(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  const wd = weekdayOf(date);
  return wd[0]!.toUpperCase() + wd.slice(1);
}

function describeHours(hours: string[]): string {
  if (!hours.length) return "not set";
  return hours.map((h) => { const [d, span] = h.split(" ") as [string, string]; const [o, c] = span.split("-") as [string, string]; return `${SHORT[d] ?? d} ${speakTime(o)} to ${speakTime(c)}`; }).join(", ");
}
