import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { Card, Loading, type Toasts } from "../ui";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_NAME: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

export function Settings({ toasts }: { toasts: Toasts }) {
  const b = useQuery(api.business.get, {}) as any;
  const update = useMutation(api.business.update);
  const [draft, setDraft] = useState<any>(null);
  useEffect(() => { if (b && !b.missing) setDraft(structuredClone(b)); }, [b?.updatedAt]);
  if (!b || !draft) return <Loading what="settings" />;
  const canEdit = b.role === "owner" || b.role === "admin";
  const set = (k: string, v: unknown) => setDraft((d: any) => ({ ...d, [k]: v }));
  const setPolicy = (k: string, v: unknown) => setDraft((d: any) => ({ ...d, policy: { ...d.policy, [k]: v } }));
  const save = () => update({
    name: draft.name, timezone: draft.timezone, about: draft.about, appointmentMinutes: Number(draft.appointmentMinutes), hours: draft.hours, escalation: draft.escalation,
    policy: { ...draft.policy, transcriptRetentionDays: Number(draft.policy.transcriptRetentionDays), maxOutboundCallsPerHour: Number(draft.policy.maxOutboundCallsPerHour) },
  }).then((r) => toasts.info(r.changed.length ? `Saved: ${r.changed.join(", ")}` : "No changes"), toasts.error);
  const dayHours = (day: string) => draft.hours.find((h: any) => h.day === day);
  const setDay = (day: string, open: boolean, field?: "open" | "close", value?: string) => {
    const others = draft.hours.filter((h: any) => h.day !== day);
    if (!open) return set("hours", others);
    const cur = dayHours(day) ?? { day, open: "09:00", close: "17:00" };
    set("hours", [...others, field ? { ...cur, [field]: value } : cur]);
  };
  return (
    <form className="page narrow-page" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="page-head row-between">
        <div><h1>Settings & policy</h1><p className="muted">How this business operates. Changes apply to the next call or text and are recorded in the audit log.</p></div>
        {canEdit && <button type="submit">Save changes</button>}
      </div>
      {!canEdit && <div className="banner info">Only owners and admins change settings.</div>}
      <fieldset disabled={!canEdit} className="stack">
        <Card title="Business">
          <div className="grid two tight">
            <label>Name<input value={draft.name} onChange={(e) => set("name", e.target.value)} required /></label>
            <label>Time zone<input value={draft.timezone} onChange={(e) => set("timezone", e.target.value)} list="zones" /></label>
          </div>
          <datalist id="zones">{["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Australia/Sydney"].map((z) => <option key={z} value={z} />)}</datalist>
          <label>What callers should know (agents read this)<textarea rows={4} value={draft.about} onChange={(e) => set("about", e.target.value)} placeholder="Address, services, prices, insurance, parking…" /></label>
          <label className="short">Appointment length (minutes)<input type="number" min={10} max={240} step={5} value={draft.appointmentMinutes} onChange={(e) => set("appointmentMinutes", e.target.value)} /></label>
        </Card>
        <Card title="Opening hours">
          <div className="hours">
            {DAYS.map((d) => {
              const h = dayHours(d);
              return (
                <div key={d} className="hours-row">
                  <label className="toggle"><input type="checkbox" checked={Boolean(h)} onChange={(e) => setDay(d, e.target.checked)} /> {DAY_NAME[d]}</label>
                  {h ? <><input type="time" value={h.open} onChange={(e) => setDay(d, true, "open", e.target.value)} aria-label={`${d} opens`} /> – <input type="time" value={h.close === "24:00" ? "23:59" : h.close} onChange={(e) => setDay(d, true, "close", e.target.value)} aria-label={`${d} closes`} /></> : <span className="muted">Closed</span>}
                </div>
              );
            })}
          </div>
        </Card>
        <Card title="Escalation contacts" action={canEdit ? <button type="button" className="secondary small" onClick={() => set("escalation", [...draft.escalation, { id: `person${draft.escalation.length + 1}`, name: "", phone: "" }])}>＋ Add</button> : null}>
          <p className="muted small">The people a call can be transferred to. Agents choose among these; they can never dial a number of their own.</p>
          {draft.escalation.map((e: any, i: number) => (
            <div key={i} className="grid three tight">
              <label>Id<input value={e.id} onChange={(x) => set("escalation", draft.escalation.map((y: any, j: number) => (j === i ? { ...y, id: x.target.value } : y)))} required /></label>
              <label>Name<input value={e.name} onChange={(x) => set("escalation", draft.escalation.map((y: any, j: number) => (j === i ? { ...y, name: x.target.value } : y)))} required /></label>
              <label>Phone<input value={e.phone} placeholder="+14155550100" onChange={(x) => set("escalation", draft.escalation.map((y: any, j: number) => (j === i ? { ...y, phone: x.target.value } : y)))} required /></label>
            </div>
          ))}
        </Card>
        <Card title="Communication policy">
          <div className="policy">
            <label className="toggle"><input type="checkbox" checked={draft.policy.transcripts} onChange={(e) => setPolicy("transcripts", e.target.checked)} /> Keep call transcripts <span className="muted small">(audio is never recorded)</span></label>
            <label>Disclosure spoken at the start of every transcribed call<input value={draft.policy.disclosure} onChange={(e) => setPolicy("disclosure", e.target.value)} /></label>
            <label className="short">Delete transcripts after (days)<input type="number" min={1} max={3650} value={draft.policy.transcriptRetentionDays} onChange={(e) => setPolicy("transcriptRetentionDays", e.target.value)} /></label>
            <div className="grid two tight">
              <label>Quiet hours start<input type="time" value={draft.policy.quietStart} onChange={(e) => setPolicy("quietStart", e.target.value)} /></label>
              <label>Quiet hours end<input type="time" value={draft.policy.quietEnd} onChange={(e) => setPolicy("quietEnd", e.target.value)} /></label>
            </div>
            <p className="muted small">In quiet hours no outbound calls are placed and no texts are sent, except replies to someone who wrote or called in the last 24 hours.</p>
            <label className="toggle"><input type="checkbox" checked={draft.policy.outboundCalls} onChange={(e) => setPolicy("outboundCalls", e.target.checked)} /> Allow outbound calls <span className="muted small">(one contact at a time, started by a person, only with recorded consent)</span></label>
            <label className="short">Outbound calls per hour, at most<input type="number" min={0} max={100} value={draft.policy.maxOutboundCallsPerHour} onChange={(e) => setPolicy("maxOutboundCallsPerHour", e.target.value)} /></label>
            <label className="toggle"><input type="checkbox" checked={draft.policy.smsSenderLine} onChange={(e) => setPolicy("smsSenderLine", e.target.checked)} /> Identify the business and add "Reply STOP to opt out" on the first text to a contact</label>
            <label className="toggle"><input type="checkbox" checked={draft.policy.missedCallTextBack} onChange={(e) => setPolicy("missedCallTextBack", e.target.checked)} /> Text back missed callers (never to anyone who opted out)</label>
          </div>
        </Card>
      </fieldset>
    </form>
  );
}
