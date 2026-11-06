import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { ago, Badge, CALL_TONE, clock, duration, Empty, ErrorNote, fmtPhone, idem, Loading, SimBadge, SMS_TONE, type Toasts } from "../ui";
import { ContactPanel } from "./Contacts";

export function Inbox({ id, go, toasts }: { id?: string; go: (p: string) => void; toasts: Toasts }) {
  const [filter, setFilter] = useState<"all" | "unread" | "open" | "closed">("all");
  const [search, setSearch] = useState("");
  const list = useQuery(api.conversations.list, { filter, ...(search.trim() ? { search: search.trim() } : {}) });
  const selected = id ?? list?.[0]?.id;
  return (
    <div className="page split">
      <div className="list-pane">
        <div className="pane-head"><h1>Inbox</h1></div>
        <div className="pane-tools">
          <input type="search" placeholder="Search names, numbers, texts…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search conversations" />
          <div className="segmented">{(["all", "unread", "open", "closed"] as const).map((f) => <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f}</button>)}</div>
        </div>
        {!list ? <Loading what="conversations" /> : !list.length ? <Empty title={search ? "No matches" : "No conversations"}>{search ? "" : "Texts and calls from contacts appear here."}</Empty> : (
          <ul className="rows">
            {list.map((c: any) => (
              <li key={c.id} className={`row clickable ${selected === c.id ? "selected" : ""} ${c.unread ? "unread" : ""}`} onClick={() => go(`inbox/${c.id}`)}>
                <div className="avatar" aria-hidden>{(c.contact?.name ?? "#").slice(0, 1)}</div>
                <div className="grow">
                  <div className="row-top"><strong>{c.contact?.name ?? fmtPhone(c.contact?.phone)}</strong><span className="muted small nowrap">{ago(c.lastAt)}</span></div>
                  <div className="muted small ellipsis">{c.lastKind === "call" ? "☎ " : c.lastKind === "note" ? "✎ " : ""}{c.lastPreview}</div>
                </div>
                {c.live && <Badge tone="live">live</Badge>}
                {c.contact?.smsOptOut && <Badge tone="warn" title="Opted out of texts">STOP</Badge>}
                {c.unread > 0 && <span className="count">{c.unread}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="detail-pane">{selected ? <Conversation key={selected} id={selected} toasts={toasts} go={go} /> : <Empty title="No conversation selected" />}</div>
    </div>
  );
}

function Conversation({ id, toasts, go }: { id: string; toasts: Toasts; go: (p: string) => void }) {
  const q = useQueryState(api.conversations.timeline, { conversationId: id });
  const markRead = useMutation(api.conversations.markRead);
  const reply = useMutation(api.conversations.reply);
  const note = useMutation(api.conversations.note);
  const setStatus = useMutation(api.conversations.setStatus);
  const complete = useMutation(api.tasks.complete);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"sms" | "note">("sms");
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const n = q.data?.items.length ?? 0;
  useEffect(() => { if (q.data?.conversation.unread) void markRead({ conversationId: id }).catch(() => {}); }, [q.data?.conversation.unread]);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [n]);
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading what="the conversation" />;
  const { conversation, contact, items, tasks } = q.data as any;
  const submit = async () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    try {
      if (mode === "note") { await note({ conversationId: id, body }); setText(""); return; }
      const r = await reply({ conversationId: id, body, idempotencyKey: idem() });
      setText("");
      if (r.status === "blocked") toasts.error(`Not sent: ${r.reason}`);
    } catch (e) { toasts.error(e); } finally { setSending(false); }
  };
  return (
    <div className="conversation">
      <div className="thread">
        <header className="thread-head">
          <div><h2>{contact.name ?? fmtPhone(contact.phone)}</h2><div className="muted small">{fmtPhone(contact.phone)}{contact.smsOptOut ? " · opted out of texts" : ""}</div></div>
          <button className="secondary small" onClick={() => void setStatus({ conversationId: id, status: conversation.status === "open" ? "closed" : "open" }).catch(toasts.error)}>{conversation.status === "open" ? "Close" : "Reopen"}</button>
        </header>
        <div className="timeline">
          {items.map((i: any) => <Item key={`${i.type}:${i.id}`} i={i} go={go} />)}
          <div ref={end} />
        </div>
        <form className="composer" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="segmented small"><button type="button" className={mode === "sms" ? "on" : ""} onClick={() => setMode("sms")}>Text</button><button type="button" className={mode === "note" ? "on" : ""} onClick={() => setMode("note")}>Internal note</button></div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={mode === "sms" ? 1400 : 1600} aria-label={mode === "sms" ? "Reply by text" : "Internal note"}
            placeholder={mode === "sms" ? (contact.smsOptOut ? "This contact opted out of texts: replies are blocked." : `Text ${contact.name ?? fmtPhone(contact.phone)}…`) : "A note for the team (never sent)…"}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(); }} />
          <button type="submit" disabled={sending || !text.trim()}>{mode === "sms" ? "Send text" : "Add note"}</button>
        </form>
      </div>
      <aside className="context">
        <ContactPanel id={contact.id} toasts={toasts} />
        <section className="side-card">
          <h3>Follow-ups</h3>
          {!tasks.length ? <p className="muted small">None.</p> : tasks.map((t: any) => (
            <label key={t.id} className="task"><input type="checkbox" checked={t.status === "done"} onChange={(e) => void complete({ id: t.id, done: e.target.checked }).catch(toasts.error)} /> <span className={t.status === "done" ? "done" : ""}>{t.title}{t.detail ? <span className="muted small"> — {t.detail}</span> : null}</span></label>
          ))}
        </section>
      </aside>
    </div>
  );
}

function Item({ i, go }: { i: any; go: (p: string) => void }) {
  if (i.type === "sms") {
    return (
      <div className={`bubble-row ${i.direction}`}>
        <div className={`bubble ${i.direction} ${i.status === "blocked" ? "blocked" : ""}`}>
          <div className="bubble-text">{i.body}</div>
          {i.media?.map((m: any) => <a key={m.url} href={m.url} target="_blank" rel="noreferrer" className="small">📎 {m.contentType}</a>)}
          <div className="bubble-meta">
            {i.authorKind === "agent" && <Badge tone="info">agent</Badge>}
            <SimBadge provider={i.provider} />
            {i.direction === "outbound" && <Badge tone={SMS_TONE[i.status]} title={i.error}>{i.status}</Badge>}
            <span>{clock(i.createdAt)}</span>
          </div>
          {i.error && i.direction === "outbound" && <div className="bubble-error">{i.error}</div>}
        </div>
      </div>
    );
  }
  if (i.type === "note") return <div className="note">✎ <b>Note</b> · {i.body} <span className="muted small">{clock(i.createdAt)}</span></div>;
  if (i.type === "call") {
    return (
      <div className="call-card clickable" onClick={() => go(`live/${i.id}`)}>
        <span className={`dir ${i.direction}`}>{i.direction === "inbound" ? "↙" : "↗"}</span>
        <div className="grow">
          <div><b>{i.direction === "inbound" ? "Incoming call" : "Outgoing call"}</b> <Badge tone={CALL_TONE[i.status]}>{i.status}</Badge> {i.outcome && <Badge tone={i.outcome === "missed" ? "bad" : i.outcome === "appointment_booked" ? "good" : "neutral"}>{i.outcome.replace("_", " ")}</Badge>} <SimBadge provider={i.provider} /></div>
          <div className="muted small">{clock(i.startedAt)}{i.durationSec ? ` · ${duration(i.durationSec)}` : ""}{i.transfer ? ` · transfer to ${i.transfer.toName}: ${i.transfer.status}` : ""}</div>
          {i.summary && <div className="small">{i.summary}</div>}
        </div>
        <span className="muted small">Transcript →</span>
      </div>
    );
  }
  if (i.type === "action") {
    return <div className={`agent-action ${i.status}`}>⚙ <b>{i.capability}</b> {i.status === "succeeded" ? "succeeded" : i.decision === "denied" ? `refused: ${i.error}` : `failed: ${i.error}`} <span className="muted small">{clock(i.at)}</span></div>;
  }
  return null;
}
