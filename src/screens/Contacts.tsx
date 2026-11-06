import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryState } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { ago, Badge, Card, Empty, fmtPhone, idem, Loading, type Toasts } from "../ui";

export function Contacts({ id, go, toasts }: { id?: string; go: (p: string) => void; toasts: Toasts }) {
  const [search, setSearch] = useState("");
  const list = useQuery(api.contacts.list, search.trim() ? { search: search.trim() } : {});
  const save = useMutation(api.contacts.save);
  const [adding, setAdding] = useState(false);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const selected = id ?? list?.[0]?.id;
  return (
    <div className="page split">
      <div className="list-pane">
        <div className="pane-head"><h1>Contacts</h1><button className="secondary small" onClick={() => setAdding(!adding)}>＋ Add</button></div>
        {adding && (
          <form className="pane-tools stack" onSubmit={(e) => { e.preventDefault(); void save({ phone, ...(name ? { name } : {}) }).then((cid) => { setAdding(false); setPhone(""); setName(""); go(`contacts/${cid}`); }, toasts.error); }}>
            <input placeholder="+1 415 555 0100" value={phone} onChange={(e) => setPhone(e.target.value)} aria-label="Phone number" required />
            <input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
            <button type="submit">Add contact</button>
          </form>
        )}
        <div className="pane-tools"><input type="search" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search contacts" /></div>
        {!list ? <Loading what="contacts" /> : !list.length ? <Empty title="No contacts">People who call or text appear here.</Empty> : (
          <ul className="rows">
            {list.map((c: any) => (
              <li key={c.id} className={`row clickable ${selected === c.id ? "selected" : ""}`} onClick={() => go(`contacts/${c.id}`)}>
                <div className="avatar" aria-hidden>{(c.name ?? "#").slice(0, 1)}</div>
                <div className="grow"><strong>{c.name ?? fmtPhone(c.phone)}</strong><div className="muted small">{fmtPhone(c.phone)} · {ago(c.lastContactAt)}</div></div>
                {c.smsOptOut && <Badge tone="warn">STOP</Badge>}
                {c.doNotCall && <Badge tone="bad">DNC</Badge>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="detail-pane">{selected ? <ContactDetail key={selected} id={selected} go={go} toasts={toasts} /> : <Empty title="No contact selected" />}</div>
    </div>
  );
}

function ContactDetail({ id, go, toasts }: { id: string; go: (p: string) => void; toasts: Toasts }) {
  const q = useQueryState(api.contacts.get, { id });
  const start = useMutation(api.calls.start);
  if (!q.data) return <Loading what="the contact" />;
  const { contact, conversationId, appointments } = q.data as any;
  const call = () => start({ contactId: id, idempotencyKey: idem() }).then((r) => { toasts.info("Calling…"); go(`live/${r.callId}`); }, toasts.error);
  return (
    <div className="page narrow-page">
      <div className="page-head row-between">
        <div><h1>{contact.name ?? fmtPhone(contact.phone)}</h1><p className="muted">{fmtPhone(contact.phone)} · first seen {ago(contact.firstSeenAt)}</p></div>
        <div className="actions">
          {conversationId && <button className="secondary" onClick={() => go(`inbox/${conversationId}`)}>Conversation</button>}
          <button onClick={() => void call()} title="Policy-checked: consent, do-not-call, quiet hours, hourly limit">☎ Call with agent</button>
        </div>
      </div>
      <div className="grid two">
        <ContactPanel id={id} toasts={toasts} edit />
        <Card title="Upcoming appointments">{!appointments.length ? <p className="muted">None.</p> : <ul className="plain">{appointments.map((a: any) => <li key={a.id}>{new Date(a.startsAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{a.reason ? ` — ${a.reason}` : ""}</li>)}</ul>}</Card>
      </div>
    </div>
  );
}

/** Contact details and consent, editable; every consent change is audited. */
export function ContactPanel({ id, toasts, edit }: { id: string; toasts: Toasts; edit?: boolean }) {
  const q = useQuery(api.contacts.get, { id });
  const save = useMutation(api.contacts.save);
  const consent = useMutation(api.contacts.setConsent);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [source, setSource] = useState("");
  useEffect(() => { if (q) { setName(q.contact.name ?? ""); setNotes(q.contact.notes ?? ""); } }, [q?.contact.id, q?.contact.name, q?.contact.notes]);
  if (!q) return <section className="side-card"><Loading what="contact" /></section>;
  const c = q.contact as any;
  return (
    <section className="side-card">
      <h3>Contact</h3>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save({ id, name: name || undefined, notes }).then(() => toasts.info("Saved"), toasts.error); }}>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        {edit && <label>Notes<textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>}
        <button type="submit" className="secondary small">Save</button>
      </form>
      <h3>Consent & preferences</h3>
      <label className="toggle"><input type="checkbox" checked={!c.smsOptOut} onChange={(e) => void consent({ id, smsOptOut: !e.target.checked }).catch(toasts.error)} /> Texts allowed {c.smsOptOut && <Badge tone="warn">opted out</Badge>}</label>
      <label className="toggle"><input type="checkbox" checked={c.doNotCall} onChange={(e) => void consent({ id, doNotCall: e.target.checked }).catch(toasts.error)} /> Do not call</label>
      {c.callConsent ? (
        <div className="small">Call consent: <b>{c.callConsent.source}</b> <span className="muted">({ago(c.callConsent.at)})</span> <button className="link" onClick={() => void consent({ id, callConsent: null }).catch(toasts.error)}>withdraw</button></div>
      ) : (
        <form className="inline" onSubmit={(e) => { e.preventDefault(); void consent({ id, callConsent: { source } }).then(() => setSource(""), toasts.error); }}>
          <input placeholder="How consent to call was given" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Call consent source" minLength={3} required />
          <button type="submit" className="secondary small">Record</button>
        </form>
      )}
    </section>
  );
}
