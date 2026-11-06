import { useFeltKit, useMutation, useQuery } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { connectRuntime } from "../App";
import { ago, Badge, Card, Loading, type Toasts } from "../ui";

/**
 * First run and health: what this business still needs, from records (never assumed), and where each
 * kind of configuration lives. Business configuration is here in the app; deployment configuration
 * (provider, credentials, model, webhooks) is operator work in FeltKit Studio.
 */
export function Setup({ go, toasts, openPhone }: { go: (p: string) => void; toasts: Toasts; openPhone: () => void }) {
  const setup = useQuery(api.business.setup, {});
  const biz = useQuery(api.business.get, {}) as any;
  const client = useFeltKit();
  const seed = useMutation(api.demo.seed);
  const add = useMutation(api.numbers.add);
  const agents = useQuery(api.agents.list, {}) ?? [];
  if (!setup) return <Loading what="setup" />;
  const admin = biz && (biz.role === "owner" || biz.role === "admin");
  const fix: Record<string, { label: string; run: () => unknown } | undefined> = {
    business: { label: "Set hours", run: () => go("settings") },
    agent: { label: "Configure an agent", run: () => go("agents") },
    connect: admin ? { label: "Connect voice runtime", run: () => connectRuntime(client).then(() => toasts.info("Voice runtime connected"), toasts.error) } : undefined,
    number: admin ? { label: "Add a simulator number", run: () => add({ e164: `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`, label: "Simulator line", provider: "simulator", sms: true, voice: true, ...(agents[0] ? { agentId: agents[0].id } : {}) }).then(() => toasts.info("Simulator number added"), toasts.error) } : undefined,
    assign: { label: "Assign an agent", run: () => go("numbers") },
    runtime: undefined,
  };
  const r = setup.runtime;
  return (
    <div className="page narrow-page">
      <div className="page-head"><h1>Setup & health</h1><p className="muted">The minimum for a real call to work, checked against what is actually configured.</p></div>
      <Card title={setup.complete ? "Ready ✓" : "Finish setting up"}>
        <ol className="steps">
          {setup.steps.map((s) => (
            <li key={s.id} className={s.done ? "done" : ""}>
              <span className="step-mark" aria-hidden>{s.done ? "✓" : "○"}</span>
              <div className="grow"><strong>{s.label}</strong><div className="muted small">{s.detail}</div></div>
              {!s.done && fix[s.id] && <button className="secondary small" onClick={() => void fix[s.id]!.run()}>{fix[s.id]!.label}</button>}
            </li>
          ))}
        </ol>
        {setup.complete && r?.simulator && <p>Try it: <button className="link" onClick={openPhone}>open the simulator phone</button>, call your number, and ask to book an appointment.</p>}
        {admin && <p className="muted small">Exploring? <button className="link" onClick={() => void seed({}).then(() => toasts.info("Sample data loaded"), toasts.error)}>Load sample hours, escalation contacts and contacts</button>.</p>}
      </Card>
      <Card title="Telephony runtime">
        {!r ? <p className="error-text">The runtime has not reported. Is <code>npm run dev</code> (or <code>npm start</code>) running?</p> : (
          <dl className="kv">
            <dt>Provider</dt><dd>{r.provider === "simulator" ? <Badge tone="sim">Simulator (development)</Badge> : <Badge tone="info">Twilio</Badge>}</dd>
            <dt>State</dt><dd>{r.ready && r.fresh ? <Badge tone="good">ready</Badge> : <Badge tone="bad">needs attention</Badge>} {!r.fresh && <span className="muted small">no heartbeat in 30 s</span>}</dd>
            {r.problems.length > 0 && <><dt>Problems</dt><dd><ul className="plain">{r.problems.map((p) => <li key={p} className="error-text small">{p}</li>)}</ul></dd></>}
            <dt>Public URL</dt><dd>{r.publicBaseUrl ? <code>{r.publicBaseUrl}</code> : <span className="muted">not set (only needed for Twilio)</span>}</dd>
            <dt>Last webhook</dt><dd>{r.lastWebhookAt ? ago(r.lastWebhookAt) : <span className="muted">none yet</span>}</dd>
            <dt>Rejected requests</dt><dd>{r.signatureFailures ? <Badge tone="warn">{r.signatureFailures} unsigned or forged</Badge> : "0"}</dd>
          </dl>
        )}
      </Card>
      <Card title="Where configuration lives">
        <table className="table compact">
          <thead><tr><th>Setting</th><th>Where</th><th>Who</th></tr></thead>
          <tbody>
            <tr><td>Agents, phone numbers, hours, escalation, policy</td><td>This app (Agents, Phone numbers, Settings)</td><td>Business owner/admin</td></tr>
            <tr><td>Telephony provider, Twilio account, public URL</td><td>Studio → Services → Configuration: <code>TELEPHONY_PROVIDER</code>, <code>TWILIO_ACCOUNT_SID</code>, <code>PUBLIC_BASE_URL</code></td><td>Operator</td></tr>
            <tr><td>Twilio auth token</td><td>Studio → Services → Credentials: <code>twilio-auth-token</code> (or <code>npx feltkit credential set credential-ref:twilio-auth-token</code>)</td><td>Operator</td></tr>
            <tr><td>Model provider, model, API key</td><td>Studio → Models (or <code>npx feltkit model set</code>)</td><td>Operator</td></tr>
            <tr><td>Events to your CRM / calendar sync</td><td>Studio → Services → Webhooks: <code>call.completed</code>, <code>message.received</code>, <code>appointment.booked</code>, <code>followup.created</code>, <code>contact.opted_out</code></td><td>Operator</td></tr>
            <tr><td>Calendar, CRM and other APIs as capabilities</td><td>Studio → Integrations</td><td>Operator</td></tr>
            <tr><td>New capabilities, new behavior</td><td>Code: <code>feltkit/tools.ts</code>, <code>gateway/</code></td><td>Developer</td></tr>
          </tbody>
        </table>
        <p className="muted small">Studio is at <code>/_feltkit/</code>. In development, open the <b>Dashboard</b> link that <code>npm run dev</code> prints (it carries the sign-in token) and choose <b>Act as → Ada</b> (operator) on Services pages.</p>
      </Card>
    </div>
  );
}
