import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { ago, Badge, CALL_TONE, Card, clock, duration, Empty, ErrorNote, fmtPhone, Loading, SimBadge, useTick, type Toasts } from "../ui";

const LIVE = new Set(["queued", "initiated", "ringing", "in-progress"]);

export function Live({ id, go, toasts }: { id?: string; go: (p: string) => void; toasts: Toasts }) {
  const live = useQuery(api.calls.live, {});
  const [filter, setFilter] = useState<"all" | "missed" | "inbound" | "outbound">("all");
  const recent = useQuery(api.calls.list, { filter, limit: 60 });
  useTick();
  const selected = id ?? live?.[0]?.id;
  return (
    <div className="page split">
      <div className="list-pane">
        <div className="pane-head"><h1>Calls</h1></div>
        <div className="pane-section">Live now</div>
        {!live ? <Loading what="calls" /> : !live.length ? <div className="muted pad small">No calls in progress.</div> : (
          <ul className="rows">
            {live.map((c: any) => (
              <li key={c.id} className={`row clickable ${selected === c.id ? "selected" : ""}`} onClick={() => go(`live/${c.id}`)}>
                <span className="pulse" aria-hidden />
                <div className="grow"><strong>{c.contactName ?? fmtPhone(c.direction === "inbound" ? c.from : c.to)}</strong><div className="muted small">{c.direction} · {c.takenOver ? "operator" : c.handling}</div></div>
                <SimBadge provider={c.provider} />
                <span className="mono small">{c.answeredAt ? duration(Math.round((Date.now() - c.answeredAt) / 1000)) : c.status}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="pane-section">
          History
          <select value={filter} onChange={(e) => setFilter(e.target.value as any)} aria-label="Filter calls"><option value="all">All</option><option value="missed">Missed</option><option value="inbound">Inbound</option><option value="outbound">Outbound</option></select>
        </div>
        <ul className="rows">
          {(recent ?? []).filter((c: any) => !LIVE.has(c.status)).map((c: any) => (
            <li key={c.id} className={`row clickable ${selected === c.id ? "selected" : ""}`} onClick={() => go(`live/${c.id}`)}>
              <span className={`dir ${c.direction}`}>{c.direction === "inbound" ? "↙" : "↗"}</span>
              <div className="grow"><strong>{c.contactName ?? fmtPhone(c.direction === "inbound" ? c.from : c.to)}</strong><div className="muted small">{c.outcome?.replace("_", " ") ?? c.status}{c.durationSec ? ` · ${duration(c.durationSec)}` : ""}</div></div>
              <SimBadge provider={c.provider} />
              <span className="muted small nowrap">{ago(c.startedAt)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="detail-pane">{selected ? <CallView key={selected} id={selected} toasts={toasts} go={go} /> : <Empty title="No call selected">Live calls and history appear on the left.</Empty>}</div>
    </div>
  );
}

export function CallView({ id, toasts, go }: { id: string; toasts: Toasts; go: (p: string) => void }) {
  const q = useQueryState(api.calls.get, { id });
  const control = useMutation(api.calls.control);
  const [line, setLine] = useState("");
  const [target, setTarget] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useTick();
  const n = q.data?.transcript.length ?? 0;
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [n]);
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading what="the call" />;
  const { call, contact, agent, transcript, actions, escalation, transcriptsEnabled } = q.data as any;
  const isLive = LIVE.has(call.status);
  const act = (action: string, extra: Record<string, unknown> = {}) => control({ callId: id, action: action as any, ...extra }).then(() => toasts.info(`${action === "say" ? "Said" : action} — sent to the call`), toasts.error);
  const timeline = [...transcript.map((t: any) => ({ kind: "turn", at: t.at, t })), ...actions.map((a: any) => ({ kind: "action", at: a.at, a }))].sort((x, y) => x.at - y.at);
  return (
    <div className="call-view">
      <header className="call-head">
        <div>
          <h2>{contact?.name ?? fmtPhone(call.direction === "inbound" ? call.from : call.to)} <SimBadge provider={call.provider} /></h2>
          <div className="muted small">{call.direction === "inbound" ? `${fmtPhone(call.from)} → ${fmtPhone(call.to)}` : `${fmtPhone(call.from)} → ${fmtPhone(call.to)}`} · {agent ? `Agent: ${agent.name}` : call.handling} · started {clock(call.startedAt)}</div>
        </div>
        <div className="call-state">
          <Badge tone={CALL_TONE[call.status]}>{call.status}</Badge>
          {call.answeredAt && <span className="mono">{duration(call.durationSec ?? Math.round(((call.endedAt ?? Date.now()) - call.answeredAt) / 1000))}</span>}
          {call.session === "lost" && <Badge tone="warn" title="The media connection dropped; the record is intact">connection lost</Badge>}
          {call.takenOver && <Badge tone="info">operator has the call</Badge>}
        </div>
      </header>
      {call.transfer && <div className={`banner ${call.transfer.status === "failed" ? "bad" : "info"}`}>Transfer to <b>{call.transfer.toName}</b> ({fmtPhone(call.transfer.to)}): {call.transfer.status} — {call.transfer.reason}</div>}
      {call.summary && <div className="summary"><b>Summary.</b> {call.summary}</div>}
      <div className="transcript" aria-live="polite">
        {!transcriptsEnabled && <div className="muted small pad">Transcripts are off for this business (Settings → Policy). Agent actions are still recorded.</div>}
        {timeline.map((x: any) => x.kind === "turn" ? (
          <div key={`t${x.t.seq}`} className={`turn ${x.t.speaker}`}>
            <span className="who">{x.t.speaker === "caller" ? "Caller" : x.t.speaker === "agent" ? agent?.name ?? "Agent" : x.t.speaker === "operator" ? "Operator" : "System"}</span>
            <span className="said">{x.t.text}{x.t.interrupted && <em className="muted"> — interrupted</em>}{x.t.partial && <em className="muted"> — cut off</em>}</span>
          </div>
        ) : (
          <div key={`a${x.a.id}`} className={`action ${x.a.status}`}>
            <span className="who">⚙ {x.a.capability}</span>
            <span className="said">{x.a.status === "succeeded" ? describe(x.a) : `${x.a.decision === "denied" ? "Refused" : "Failed"}: ${x.a.error}`}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
      {isLive ? (
        <div className="controls">
          <form className="say" onSubmit={(e) => { e.preventDefault(); if (line.trim()) void act("say", { text: line.trim() }).then(() => setLine("")); }}>
            <input value={line} onChange={(e) => setLine(e.target.value)} placeholder={call.takenOver ? "You have the call: type what to say…" : "Say something to the caller…"} aria-label="Say to the caller" />
            <button type="submit" disabled={!line.trim()}>Say</button>
          </form>
          <div className="control-row">
            {call.takenOver ? <button className="secondary" onClick={() => void act("release")}>Hand back to agent</button> : <button className="secondary" onClick={() => void act("takeover")}>Take over</button>}
            <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Transfer to">
              <option value="">Transfer to…</option>
              {escalation.map((e: any) => <option key={e.id} value={e.id}>{e.name} ({fmtPhone(e.phone)})</option>)}
            </select>
            <button className="secondary" disabled={!target} onClick={() => void act("transfer", { escalationId: target })}>Transfer</button>
            <button className="danger" onClick={() => void act("hangup")}>Hang up</button>
          </div>
        </div>
      ) : (
        <div className="muted small pad">{call.outcome ? `Outcome: ${call.outcome.replace("_", " ")}` : ""}{call.endedAt ? ` · ended ${clock(call.endedAt)}` : ""} · <button className="link" onClick={() => go(`inbox/${call.conversationId}`)}>Open conversation</button></div>
      )}
    </div>
  );
}

function describe(a: any): string {
  const r = a.result ?? {};
  switch (a.capability) {
    case "appointments.book": return `Booked ${r.when}`;
    case "appointments.availability": return `Found ${(r.days ?? []).reduce((n: number, d: any) => n + d.slots.length, 0)} free slots`;
    case "sms.send": return `Text ${r.status ?? "queued"}`;
    case "followups.create": return "Follow-up created for staff";
    case "calls.transfer": return `Transfer requested to ${r.to}`;
    case "contacts.lookup": return r.known ? `Known contact: ${r.name}` : "New contact";
    case "business.info": return "Read business info";
    default: return "Done";
  }
}
