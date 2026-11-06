import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { Badge, CAPABILITY_LABEL, Card, Empty, fmtPhone, Loading, type Toasts } from "../ui";

const ALL = Object.keys(CAPABILITY_LABEL);
const BLANK = {
  name: "New agent", purpose: "", instructions: "You answer the phone for the business. Be brief and friendly. Only say an action happened when its result says it succeeded.",
  greeting: "Thanks for calling. How can I help?", voice: { ttsProvider: "ElevenLabs", language: "en-US" }, brain: "deterministic", temperature: 0.3,
  capabilities: ["business.info", "followups.create"], schedule: "always", smsAutoReply: false, active: false,
};

export function Agents({ id, go, toasts }: { id?: string; go: (p: string) => void; toasts: Toasts }) {
  const list = useQuery(api.agents.list, {});
  const selected = id === "new" ? "new" : id ?? list?.[0]?.id;
  return (
    <div className="page split">
      <div className="list-pane">
        <div className="pane-head"><h1>Agents</h1><button className="secondary small" onClick={() => go("agents/new")}>＋ New</button></div>
        {!list ? <Loading what="agents" /> : (
          <ul className="rows">
            {list.map((a: any) => (
              <li key={a.id} className={`row clickable ${selected === a.id ? "selected" : ""}`} onClick={() => go(`agents/${a.id}`)}>
                <div className="grow"><strong>{a.name}</strong><div className="muted small">{a.capabilities.length} capabilities · {a.brain === "deterministic" ? "scripted" : "model"}</div></div>
                <Badge tone={a.active ? "good" : "neutral"}>{a.active ? "active" : "off"}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="detail-pane">
        {selected === "new" ? <AgentEditor key="new" agent={null} go={go} toasts={toasts} /> : selected && list ? <AgentEditor key={selected} agent={list.find((a: any) => a.id === selected) ?? null} go={go} toasts={toasts} /> : <Empty title="No agent selected" />}
      </div>
    </div>
  );
}

function AgentEditor({ agent, go, toasts }: { agent: any | null; go: (p: string) => void; toasts: Toasts }) {
  const save = useMutation(api.agents.save);
  const remove = useMutation(api.agents.remove);
  const biz = useQuery(api.business.get, {}) as any;
  const [a, setA] = useState<any>(agent ?? BLANK);
  useEffect(() => setA(agent ?? BLANK), [agent?.id, agent?.updatedAt]);
  const set = (k: string, v: unknown) => setA((x: any) => ({ ...x, [k]: v }));
  const canEdit = biz && (biz.role === "owner" || biz.role === "admin");
  const submit = async () => {
    const { id, name, purpose, instructions, greeting, voice, brain, temperature, capabilities, escalateTo, schedule, smsAutoReply, active } = a;
    try {
      const saved = await save({ ...(id ? { id } : {}), name, purpose, instructions, greeting, voice: { ttsProvider: voice.ttsProvider, language: voice.language, ...(voice.voice ? { voice: voice.voice } : {}) }, brain, temperature: Number(temperature), capabilities, ...(escalateTo ? { escalateTo } : {}), schedule, smsAutoReply, active });
      toasts.info("Agent saved — it applies to the next call or text");
      if (!id) go(`agents/${saved}`);
    } catch (e) { toasts.error(e); }
  };
  return (
    <form className="page narrow-page" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="page-head row-between">
        <div><h1>{a.name || "Agent"}</h1><p className="muted">{agent?.numbers?.length ? `Answers ${agent.numbers.map(fmtPhone).join(", ")}` : "Not assigned to a number (Phone numbers)."}</p></div>
        <div className="actions">
          <label className="toggle"><input type="checkbox" checked={a.active} onChange={(e) => set("active", e.target.checked)} disabled={!canEdit} /> Active</label>
          {canEdit && <button type="submit">Save</button>}
        </div>
      </div>
      {!canEdit && <div className="banner info">Only owners and admins change agents.</div>}
      <fieldset disabled={!canEdit} className="stack">
        <Card title="Identity">
          <div className="grid two tight">
            <label>Name<input value={a.name} onChange={(e) => set("name", e.target.value)} required maxLength={60} /></label>
            <label>Purpose<input value={a.purpose} onChange={(e) => set("purpose", e.target.value)} maxLength={200} /></label>
          </div>
          <label>Greeting<input value={a.greeting} onChange={(e) => set("greeting", e.target.value)} maxLength={300} /></label>
          <label>Instructions<textarea rows={6} value={a.instructions} onChange={(e) => set("instructions", e.target.value)} maxLength={8000} /></label>
        </Card>
        <Card title="Voice and model">
          <div className="grid three tight">
            <label>Speech provider<select value={a.voice.ttsProvider} onChange={(e) => set("voice", { ...a.voice, ttsProvider: e.target.value })}><option>ElevenLabs</option><option>Google</option><option>Amazon</option></select></label>
            <label>Voice (provider's id)<input value={a.voice.voice ?? ""} placeholder="provider default" onChange={(e) => set("voice", { ...a.voice, voice: e.target.value })} /></label>
            <label>Language<input value={a.voice.language} onChange={(e) => set("voice", { ...a.voice, language: e.target.value })} /></label>
          </div>
          <div className="grid two tight">
            <label>Brain<select value={a.brain} onChange={(e) => set("brain", e.target.value)}><option value="deterministic">Scripted (no model, no key)</option><option value="environment">The model selected in Studio → Models</option></select></label>
            <label>Temperature<input type="number" min={0} max={1} step={0.1} value={a.temperature} onChange={(e) => set("temperature", e.target.value)} /></label>
          </div>
          <p className="muted small">The model and its API key are operator configuration in FeltKit Studio → Models (or <code>npx feltkit model set</code>). The speech voice is spoken by the telephony provider (Twilio ConversationRelay).</p>
        </Card>
        <Card title="Capabilities (what this agent may do)">
          <p className="muted small">An explicit allow-list. The agent never inherits a person's permissions; anything not ticked is refused by the authorization policy, and the refusal is recorded.</p>
          <div className="checks">
            {ALL.map((c) => (
              <label key={c} className="check"><input type="checkbox" checked={a.capabilities.includes(c)} onChange={(e) => set("capabilities", e.target.checked ? [...a.capabilities, c] : a.capabilities.filter((x: string) => x !== c))} /> {CAPABILITY_LABEL[c]} <code className="muted">{c}</code></label>
            ))}
          </div>
        </Card>
        <Card title="Schedule and escalation">
          <div className="grid three tight">
            <label>Answers<select value={a.schedule} onChange={(e) => set("schedule", e.target.value)}><option value="always">Always</option><option value="business_hours">During business hours</option><option value="after_hours">Outside business hours</option></select></label>
            <label>Escalate to<select value={a.escalateTo ?? ""} onChange={(e) => set("escalateTo", e.target.value || undefined)}><option value="">First escalation contact</option>{(biz?.escalation ?? []).map((e: any) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
            <label className="toggle tall"><input type="checkbox" checked={a.smsAutoReply} onChange={(e) => set("smsAutoReply", e.target.checked)} /> Answers texts</label>
          </div>
        </Card>
      </fieldset>
      {agent && canEdit && <p><button type="button" className="link danger-text" onClick={() => { if (confirm(`Remove ${agent.name}? Numbers it answers fall back to their fallback contact.`)) void remove({ id: agent.id }).then(() => go("agents"), toasts.error); }}>Remove agent</button></p>}
    </form>
  );
}
