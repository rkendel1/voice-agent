import { useState } from "react";
import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { ago, Badge, Card, Empty, fmtPhone, Loading, type Toasts } from "../ui";

export function Followups({ toasts }: { toasts: Toasts }) {
  const [status, setStatus] = useState<"open" | "done" | "all">("open");
  const list = useQuery(api.tasks.list, { status });
  const appts = useQuery(api.appointments.list, {});
  const complete = useMutation(api.tasks.complete);
  const cancel = useMutation(api.appointments.cancel);
  return (
    <div className="page">
      <div className="page-head"><h1>Follow-ups</h1><p className="muted">Messages agents took, missed calls to return, and anything staff added.</p></div>
      <div className="grid two">
        <Card title="Tasks" action={<div className="segmented small">{(["open", "done", "all"] as const).map((s) => <button key={s} className={status === s ? "on" : ""} onClick={() => setStatus(s)}>{s}</button>)}</div>} pad={false}>
          {!list ? <Loading what="follow-ups" /> : !list.length ? <Empty title="Nothing here" /> : (
            <ul className="rows">
              {list.map((t: any) => (
                <li key={t.id} className="row">
                  <input type="checkbox" aria-label="Done" checked={t.status === "done"} onChange={(e) => void complete({ id: t.id, done: e.target.checked }).catch(toasts.error)} />
                  <div className="grow"><strong className={t.status === "done" ? "done" : ""}>{t.title}</strong><div className="muted small">{t.detail}{t.contact ? ` · ${t.contact.name ?? fmtPhone(t.contact.phone)}` : ""}</div></div>
                  <Badge tone={t.createdByKind === "agent" ? "info" : t.createdByKind === "system" ? "warn" : "neutral"}>{t.createdByKind}</Badge>
                  {t.conversationId && <a className="small" href={`#/inbox/${t.conversationId}`}>Open</a>}
                  <span className="muted small nowrap">{ago(t.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Upcoming appointments" pad={false}>
          {!appts ? <Loading what="appointments" /> : !appts.length ? <Empty title="No upcoming appointments">Agents book them from the business's free slots.</Empty> : (
            <ul className="rows">
              {appts.map((a: any) => (
                <li key={a.id} className="row">
                  <div className="grow"><strong>{new Date(a.startsAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</strong><div className="muted small">{a.contact.name ?? fmtPhone(a.contact.phone)}{a.reason ? ` · ${a.reason}` : ""}</div></div>
                  <button className="link small" onClick={() => { if (confirm("Cancel this appointment?")) void cancel({ id: a.id }).catch(toasts.error); }}>Cancel</button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
