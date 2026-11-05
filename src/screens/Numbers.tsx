import { useState } from "react";
import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { Badge, Card, Empty, fmtPhone, Loading, SimBadge, type Toasts } from "../ui";

export function Numbers({ toasts }: { toasts: Toasts }) {
  const list = useQuery(api.numbers.list, {});
  const agents = useQuery(api.agents.list, {}) ?? [];
  const biz = useQuery(api.business.get, {}) as any;
  const setup = useQuery(api.business.setup, {});
  const add = useMutation(api.numbers.add);
  const update = useMutation(api.numbers.update);
  const release = useMutation(api.numbers.release);
  const [form, setForm] = useState({ e164: "", label: "", provider: "simulator" as "simulator" | "twilio", agentId: "" });
  const canEdit = biz && (biz.role === "owner" || biz.role === "admin");
  const base = setup?.runtime?.publicBaseUrl;
  const patch = (id: string, p: Record<string, unknown>) => update({ id, ...p } as any).then(() => toasts.info("Saved"), toasts.error);
  return (
    <div className="page">
      <div className="page-head"><h1>Phone numbers</h1><p className="muted">Each number belongs to one business. Its agent answers calls and texts; when the agent is off duty, calls go to the fallback contact or the caller is asked to call back (recorded as missed).</p></div>
      <Card title="Numbers" pad={false}>
        {!list ? <Loading what="numbers" /> : !list.length ? <Empty title="No numbers yet">Add a simulator number to try it now, or attach a Twilio number below.</Empty> : (
          <table className="table">
            <thead><tr><th>Number</th><th>Agent</th><th>Fallback</th><th>SMS</th><th>Voice</th><th>Caller ID</th><th /></tr></thead>
            <tbody>
              {list.map((n: any) => (
                <tr key={n.id}>
                  <td><strong>{fmtPhone(n.e164)}</strong> <SimBadge provider={n.provider} />{n.provider === "twilio" && <Badge tone="info">Twilio</Badge>}<div className="muted small">{n.label}</div></td>
                  <td><select disabled={!canEdit} value={n.agentId ?? ""} onChange={(e) => void patch(n.id, { agentId: e.target.value || null })} aria-label="Agent"><option value="">— none —</option>{agents.map((a: any) => <option key={a.id} value={a.id}>{a.name}{a.active ? "" : " (off)"}</option>)}</select></td>
                  <td><select disabled={!canEdit} value={n.fallbackEscalationId ?? ""} onChange={(e) => void patch(n.id, { fallbackEscalationId: e.target.value || null })} aria-label="Fallback"><option value="">Ask to call back</option>{(biz?.escalation ?? []).map((e: any) => <option key={e.id} value={e.id}>Forward to {e.name}</option>)}</select></td>
                  <td><input type="checkbox" disabled={!canEdit} checked={n.sms} onChange={(e) => void patch(n.id, { sms: e.target.checked })} aria-label="SMS" /></td>
                  <td><input type="checkbox" disabled={!canEdit} checked={n.voice} onChange={(e) => void patch(n.id, { voice: e.target.checked })} aria-label="Voice" /></td>
                  <td><input type="radio" name="callerid" disabled={!canEdit} checked={n.outbound} onChange={() => void patch(n.id, { outbound: true })} aria-label="Outbound caller ID" /></td>
                  <td>{canEdit && <button className="link small" onClick={() => { if (confirm(`Release ${n.e164} from this business?`)) void release({ id: n.id }).catch(toasts.error); }}>Release</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {canEdit && (
        <div className="grid two">
          <Card title="Attach a number">
            <form className="stack" onSubmit={(e) => { e.preventDefault(); void add({ e164: form.e164, label: form.label, provider: form.provider, sms: true, voice: true, ...(form.agentId ? { agentId: form.agentId } : {}) }).then(() => { toasts.info("Number attached"); setForm({ ...form, e164: "", label: "" }); }, toasts.error); }}>
              <div className="segmented"><button type="button" className={form.provider === "simulator" ? "on" : ""} onClick={() => setForm({ ...form, provider: "simulator" })}>Simulator</button><button type="button" className={form.provider === "twilio" ? "on" : ""} onClick={() => setForm({ ...form, provider: "twilio" })}>Twilio</button></div>
              <label>Number<input value={form.e164} placeholder={form.provider === "simulator" ? "+1 555 010 0000 (any number)" : "+1 415 555 0100 (bought in Twilio)"} onChange={(e) => setForm({ ...form, e164: e.target.value })} required /></label>
              <label>Label<input value={form.label} placeholder="Main line" onChange={(e) => setForm({ ...form, label: e.target.value })} /></label>
              <label>Answered by<select value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}><option value="">— none —</option>{agents.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
              <button type="submit">Attach</button>
              {form.provider === "simulator" && <p className="muted small">A simulator number exists only in development. Call and text it from the simulator phone (top right).</p>}
            </form>
          </Card>
          <Card title="Twilio webhooks for a number">
            <p className="small">In the Twilio console, open the number and set:</p>
            <dl className="kv">
              <dt>A message comes in</dt><dd><code>{base ?? "<PUBLIC_BASE_URL>"}/twilio/sms</code> (HTTP POST)</dd>
              <dt>A call comes in</dt><dd><code>{base ?? "<PUBLIC_BASE_URL>"}/twilio/voice</code> (HTTP POST)</dd>
              <dt>Call status changes</dt><dd><code>{base ?? "<PUBLIC_BASE_URL>"}/twilio/call-status</code> (HTTP POST)</dd>
            </dl>
            <p className="muted small">PUBLIC_BASE_URL, TELEPHONY_PROVIDER=twilio and TWILIO_ACCOUNT_SID are set in FeltKit Studio → Services → Configuration; the auth token in Studio → Services → Credentials as <code>twilio-auth-token</code>. Every request is signature-checked; nothing unsigned reaches the business.</p>
          </Card>
        </div>
      )}
    </div>
  );
}
