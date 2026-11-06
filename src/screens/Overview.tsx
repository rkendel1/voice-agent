import { useQuery } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { ago, Badge, CALL_TONE, Card, Empty, fmtPhone, Loading, SimBadge, Stat } from "../ui";

export function Overview({ go }: { go: (p: string) => void }) {
  const o = useQuery(api.overview.get, {});
  const calls = useQuery(api.calls.list, { limit: 8 });
  const convs = useQuery(api.conversations.list, {});
  const agents = useQuery(api.agents.list, {});
  const tasks = useQuery(api.tasks.list, {});
  if (!o) return <Loading what="the overview" />;
  return (
    <div className="page">
      <div className="page-head"><h1>Overview</h1><p className="muted">Today's calls and texts, what the agents did, and what is waiting for a person.</p></div>
      <div className="stats">
        <Stat label="Active calls" value={o.activeCalls} tone={o.activeCalls ? "live" : ""} onClick={() => go("live")} />
        <Stat label="Calls (24h)" value={o.callsToday} onClick={() => go("live")} />
        <Stat label="Missed (24h)" value={o.missedToday} tone={o.missedToday ? "bad" : ""} onClick={() => go("live")} />
        <Stat label="Unread conversations" value={o.unreadConversations} tone={o.unreadConversations ? "warn" : ""} onClick={() => go("inbox")} />
        <Stat label="Texts in / out (24h)" value={`${o.smsIn} / ${o.smsOut}`} hint={o.smsFailed ? `${o.smsFailed} failed` : undefined} tone={o.smsFailed ? "warn" : ""} onClick={() => go("inbox")} />
        <Stat label="Open follow-ups" value={o.openFollowups} tone={o.openFollowups ? "warn" : ""} onClick={() => go("followups")} />
        <Stat label="Upcoming appointments" value={o.upcomingAppointments} />
      </div>
      <div className="grid two">
        <Card title="Recent calls" action={<a href="#/live">All calls →</a>} pad={false}>
          {!calls?.length ? <Empty title="No calls yet">Call your number, or use the simulator phone.</Empty> : (
            <ul className="rows">
              {calls.map((c: any) => (
                <li key={c.id} className="row clickable" onClick={() => go(`live/${c.id}`)}>
                  <span className={`dir ${c.direction}`} title={c.direction}>{c.direction === "inbound" ? "↙" : "↗"}</span>
                  <div className="grow"><strong>{c.contactName ?? fmtPhone(c.direction === "inbound" ? c.from : c.to)}</strong><div className="muted small">{c.summary ?? (c.outcome ? c.outcome.replace("_", " ") : c.handling)}</div></div>
                  <SimBadge provider={c.provider} />
                  {c.outcome ? <Badge tone={c.outcome === "missed" || c.outcome === "failed" ? "bad" : c.outcome === "appointment_booked" ? "good" : "neutral"}>{c.outcome.replace("_", " ")}</Badge> : <Badge tone={CALL_TONE[c.status]}>{c.status}</Badge>}
                  <span className="muted small nowrap">{ago(c.startedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Recent conversations" action={<a href="#/inbox">Inbox →</a>} pad={false}>
          {!convs?.length ? <Empty title="No conversations yet" /> : (
            <ul className="rows">
              {convs.slice(0, 8).map((c: any) => (
                <li key={c.id} className="row clickable" onClick={() => go(`inbox/${c.id}`)}>
                  <div className="grow"><strong>{c.contact?.name ?? fmtPhone(c.contact?.phone)}</strong><div className="muted small ellipsis">{c.lastPreview}</div></div>
                  {c.live && <Badge tone="live">on a call</Badge>}
                  {c.unread > 0 && <span className="count">{c.unread}</span>}
                  <span className="muted small nowrap">{ago(c.lastAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Agents" action={<a href="#/agents">Manage →</a>} pad={false}>
          <ul className="rows">
            {(agents ?? []).map((a: any) => (
              <li key={a.id} className="row clickable" onClick={() => go(`agents/${a.id}`)}>
                <div className="grow"><strong>{a.name}</strong><div className="muted small">{a.numbers.length ? `Answers ${a.numbers.map(fmtPhone).join(", ")}` : "No number assigned"} · {a.brain === "deterministic" ? "scripted" : "model"} · {a.schedule.replace("_", " ")}</div></div>
                <Badge tone={a.active ? "good" : "neutral"}>{a.active ? "active" : "off"}</Badge>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Waiting for a person" action={<a href="#/followups">Follow-ups →</a>} pad={false}>
          {!tasks?.length ? <Empty title="Nothing waiting">Messages the agents take and missed calls appear here.</Empty> : (
            <ul className="rows">{tasks.slice(0, 6).map((t: any) => <li key={t.id} className="row"><div className="grow"><strong>{t.title}</strong><div className="muted small ellipsis">{t.detail}</div></div><Badge tone={t.createdByKind === "agent" ? "info" : "neutral"}>{t.createdByKind}</Badge><span className="muted small nowrap">{ago(t.createdAt)}</span></li>)}</ul>
          )}
        </Card>
      </div>
      <Card title="Outcomes (24h)">
        <div className="chips">{Object.entries(o.outcomes).length ? Object.entries(o.outcomes).map(([k, v]) => <Badge key={k} tone={k === "missed" || k === "failed" ? "bad" : k === "appointment_booked" ? "good" : "neutral"}>{k.replace("_", " ")}: {v as number}</Badge>) : <span className="muted">No completed calls in the last 24 hours.</span>}</div>
      </Card>
    </div>
  );
}
