import { useState } from "react";
import { useQuery } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { Badge, Card, Empty, Loading } from "../ui";

const FILTERS = [["", "Everything"], ["call.", "Calls"], ["sms.", "Texts"], ["agent.", "Agent refusals"], ["appointment.", "Appointments"], ["followup.", "Follow-ups"], ["config.", "Configuration"], ["contact.", "Consent"], ["retention.", "Retention"]] as const;

export function Activity() {
  const [type, setType] = useState("");
  const rows = useQuery(api.audit.list, type ? { type } : {});
  return (
    <div className="page">
      <div className="page-head"><h1>Activity & audit</h1><p className="muted">Calls placed and received, texts, agent actions and refusals, interventions, transfers, configuration and consent changes. Every function call (with identity and outcome) is also in Studio → Activity.</p></div>
      <div className="segmented wrap">{FILTERS.map(([v, l]) => <button key={v} className={type === v ? "on" : ""} onClick={() => setType(v)}>{l}</button>)}</div>
      <Card pad={false}>
        {!rows ? <Loading what="activity" /> : !rows.length ? <Empty title="Nothing recorded yet" /> : (
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Event</th></tr></thead>
            <tbody>
              {rows.map((r: any) => (
                <tr key={r.id}>
                  <td className="nowrap small">{new Date(r.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })}</td>
                  <td className="small"><Badge tone={r.actorKind === "agent" ? "info" : r.actorKind === "provider" ? "neutral" : r.actorKind === "system" ? "warn" : "good"}>{r.actorKind}</Badge> <span className="mono">{r.actor.length > 18 ? `${r.actor.slice(0, 16)}…` : r.actor}</span></td>
                  <td>{r.summary}</td>
                  <td><code className="small">{r.type}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
