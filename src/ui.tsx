import { useCallback, useEffect, useState, type ReactNode } from "react";

export type Toasts = ReturnType<typeof useToasts>;

export function useToasts() {
  const [items, setItems] = useState<Array<{ id: number; text: string; tone: "info" | "error" }>>([]);
  const push = useCallback((text: string, tone: "info" | "error") => {
    const id = Math.random();
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === "error" ? 7000 : 3500);
  }, []);
  return {
    items,
    info: useCallback((t: string) => push(t, "info"), [push]),
    error: useCallback((e: unknown) => push(e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as any).message) : String(e), "error"), [push]),
  };
}

export function ToastStack({ items }: { items: Toasts["items"] }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}
    </div>
  );
}

/** Hash routes: #/inbox/<id>, #/live/<id> … */
export function useRoute(): [string[], (path: string) => void] {
  const read = () => (location.hash.replace(/^#\/?/, "") || "overview").split("/");
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return [route, (path) => { location.hash = `#/${path}`; }];
}

export function Card(props: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`card ${props.className ?? ""}`}>
      {(props.title || props.action) && <header className="card-head"><h2>{props.title}</h2>{props.action}</header>}
      <div className={props.pad === false ? "" : "card-body"}>{props.children}</div>
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}

export function Badge({ tone = "neutral", children, title }: { tone?: "neutral" | "good" | "warn" | "bad" | "info" | "sim" | "live"; children: ReactNode; title?: string }) {
  return <span className={`badge ${tone}`} title={title}>{children}</span>;
}

export function SimBadge({ provider }: { provider?: string | null }) {
  return provider === "simulator" ? <Badge tone="sim" title="Created by the development simulator, not a real phone network">Simulated</Badge> : null;
}

export function Stat({ label, value, tone, hint, onClick }: { label: string; value: ReactNode; tone?: string; hint?: string; onClick?: () => void }) {
  return (
    <button className={`stat ${tone ?? ""}`} onClick={onClick} disabled={!onClick} title={hint}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </button>
  );
}

export function Loading({ what }: { what: string }) {
  return <div className="muted pad" role="status">Loading {what}…</div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  return <div className="error-text pad" role="alert">{(error as any)?.message ?? String(error)}</div>;
}

export const fmtPhone = (e164?: string | null) => {
  if (!e164) return "";
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
};

export function ago(at?: number | null): string {
  if (!at) return "";
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export function duration(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Re-render every second (call timers). */
export function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((x) => x + 1), ms); return () => clearInterval(t); }, [ms]);
}

export const CALL_TONE: Record<string, "good" | "warn" | "bad" | "info" | "live" | "neutral"> = {
  "in-progress": "live", ringing: "warn", queued: "info", initiated: "info", completed: "neutral", busy: "bad", "no-answer": "bad", failed: "bad", canceled: "neutral",
};
export const SMS_TONE: Record<string, "good" | "warn" | "bad" | "info" | "neutral"> = {
  received: "neutral", queued: "info", sending: "info", sent: "good", delivered: "good", failed: "bad", undelivered: "bad", blocked: "warn", unknown: "warn",
};

export function idem() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const CAPABILITY_LABEL: Record<string, string> = {
  "contacts.lookup": "Look up the caller",
  "business.info": "Business info & hours",
  "appointments.availability": "Check availability",
  "appointments.book": "Book appointments",
  "followups.create": "Create follow-ups",
  "sms.send": "Send texts",
  "calls.transfer": "Transfer calls",
  "conversations.history": "Read conversation history",
};
