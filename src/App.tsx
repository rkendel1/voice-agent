import { useEffect, useRef, useState } from "react";
import { AccountSettings, CreateTenant, InvitationsPanel, MembersPanel, SignIn, TenantSwitcher, useAuth, useFeltKit, useMutation, useQuery, useQueryState, useTenant, useConnectionState, AcceptInvitation, useAuthRedirect } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { ToastStack, useRoute, useToasts, Card, type Toasts } from "./ui";
import { Overview } from "./screens/Overview";
import { Live } from "./screens/Live";
import { Inbox } from "./screens/Inbox";
import { Contacts } from "./screens/Contacts";
import { Followups } from "./screens/Followups";
import { Agents } from "./screens/Agents";
import { Numbers } from "./screens/Numbers";
import { Settings } from "./screens/Settings";
import { Setup } from "./screens/Setup";
import { Activity } from "./screens/Activity";
import { SimulatorPhone } from "./Phone";

/**
 * The shell. Accounts, sign-in, businesses (FeltKit tenants), members and invitations are FeltKit's;
 * this file decides which screen shows and enters the current business (business:ensure).
 */
export function App() {
  const auth = useAuth();
  const tenant = useTenant();
  const client = useFeltKit();
  const { redirect } = useAuthRedirect();
  const toasts = useToasts();
  const [seeding, setSeeding] = useState(false);

  // Development: ?as=<dev user> signs this window in as that identity.
  const tried = useRef(false);
  useEffect(() => {
    const wanted = new URLSearchParams(location.search).get("as");
    if (!auth.session || tried.current || !wanted || auth.user?.id === wanted) return;
    if (!auth.session.devUsers?.some((u) => u.id === wanted)) return;
    tried.current = true;
    void client.signInAsDevUser(wanted).catch(toasts.error);
  }, [auth.session, auth.user?.id]);

  const brand = { name: "Voice Agent", logo: "/logo.svg" };
  if (auth.loading) return <div className="center muted" role="status">Connecting…</div>;
  if (redirect?.kind === "invitation") return <div className="signed-out"><AcceptInvitation brand={brand} onAccepted={() => toasts.info("You joined the business.")} /><ToastStack items={toasts.items} /></div>;
  if (!auth.user) return <div className="signed-out"><SignIn brand={brand} /><ToastStack items={toasts.items} /></div>;
  if (seeding || tenant.loading) return <div className="center muted" role="status">{seeding ? "Setting up the sample business…" : "Loading your businesses…"}</div>;
  if (!tenant.current) return <><Onboarding onSeeding={setSeeding} toasts={toasts} /><ToastStack items={toasts.items} /></>;
  return (
    <>
      <Enter key={`${auth.user.id}:${tenant.current.id}`} toasts={toasts} />
      <ToastStack items={toasts.items} />
    </>
  );
}

/** Enter the session's business: an owner or admin creates its record with safe defaults on first entry. */
function Enter({ toasts }: { toasts: Toasts }) {
  const ensure = useMutation(api.business.ensure);
  const [state, setState] = useState<"entering" | "ready" | { error: string }>("entering");
  useEffect(() => {
    void ensure({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }).then(() => setState("ready"), (e) => setState({ error: e.message }));
  }, []);
  if (state === "entering") return <div className="center muted" role="status">Opening the business…</div>;
  if (typeof state === "object") return <div className="center"><div className="card narrow"><div className="card-body error-text" role="alert">{state.error}</div><div className="card-body"><TenantSwitcher /></div></div></div>;
  return <Shell toasts={toasts} />;
}

export async function connectRuntime(client: ReturnType<typeof useFeltKit>) {
  // The voice runtime is a FeltKit application agent; it acts here only as a member, with its own role.
  await client.addMember("voice-runtime", "agent").catch((e: any) => { if (!/already/i.test(e.message)) throw e; });
  await client.mutation(api.agents.connect, {});
}

function Onboarding({ onSeeding, toasts }: { onSeeding: (on: boolean) => void; toasts: Toasts }) {
  const client = useFeltKit();
  const auth = useAuth();
  const sample = async () => {
    onSeeding(true);
    try {
      await client.createTenant("Acme Dental (sample)");
      await client.mutation(api.business.ensure, { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      await connectRuntime(client);
      await client.mutation(api.demo.seed, {});
      location.hash = "#/setup";
    } catch (e) {
      toasts.error(e);
    } finally {
      onSeeding(false);
    }
  };
  return (
    <main className="onboarding">
      <div className="onboarding-card">
        <div className="brand-hero"><Logo size={36} /> <span>Voice Agent</span></div>
        <p className="lead">Hi {(auth.user?.displayName ?? "there").split(" ")[0]} — agents that answer your phone and texts, and do real work: book appointments, take messages, text confirmations, hand callers to a person.</p>
        <CreateTenant title="Your businesses" className="embedded" />
        <section className="demo-box">
          <div>
            <h2>Try it with a sample business</h2>
            <p className="muted">A dental practice with opening hours, a Front desk agent, a <strong>simulated</strong> phone number and two contacts. Call it from the built-in simulator phone; no phone number or credentials needed.</p>
          </div>
          <button className="secondary" onClick={() => void sample()}>Open sample business</button>
        </section>
        <p className="muted small"><button className="link" onClick={() => void auth.signOut()}>Sign out</button></p>
      </div>
    </main>
  );
}

const NAV: Array<{ group: string; items: Array<{ id: string; label: string; icon: string }> }> = [
  { group: "Operations", items: [{ id: "overview", label: "Overview", icon: "◎" }, { id: "live", label: "Live calls", icon: "◉" }, { id: "inbox", label: "Inbox", icon: "✉" }, { id: "contacts", label: "Contacts", icon: "☺" }, { id: "followups", label: "Follow-ups", icon: "✓" }] },
  { group: "Agents & numbers", items: [{ id: "agents", label: "Agents", icon: "✦" }, { id: "numbers", label: "Phone numbers", icon: "☎" }] },
  { group: "Business", items: [{ id: "settings", label: "Settings & policy", icon: "⚙" }, { id: "team", label: "Team", icon: "⚇" }] },
  { group: "System", items: [{ id: "setup", label: "Setup & health", icon: "♥" }, { id: "activity", label: "Activity & audit", icon: "≡" }] },
];

function Shell({ toasts }: { toasts: Toasts }) {
  const [route, go] = useRoute();
  const live = useConnectionState();
  const auth = useAuth();
  const biz = useQuery(api.business.get, {});
  const setup = useQueryState(api.business.setup, {});
  const liveCalls = useQuery(api.calls.live, {}) ?? [];
  const convs = useQuery(api.conversations.list, { filter: "unread" }) ?? [];
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const page = route[0] ?? "overview";
  const counts: Record<string, number> = { live: liveCalls.length, inbox: convs.length };
  const runtime = setup.data?.runtime;
  const incomplete = setup.data && !setup.data.complete;

  return (
    <div className={`shell ${menu ? "menu-open" : ""} ${phoneOpen && runtime?.url ? "with-phone" : ""}`}>
      <aside className="sidebar">
        <div className="side-brand"><Logo /> <span>Voice Agent</span></div>
        <TenantSwitcher className="side-tenant" />
        <nav>
          {NAV.map((g) => (
            <div key={g.group} className="nav-group">
              <div className="nav-title">{g.group}</div>
              {g.items.map((i) => (
                <a key={i.id} href={`#/${i.id}`} className={page === i.id ? "active" : ""} onClick={() => setMenu(false)}>
                  <span className="nav-icon" aria-hidden>{i.icon}</span>{i.label}
                  {counts[i.id] ? <span className={`count ${i.id === "live" ? "live" : ""}`}>{counts[i.id]}</span> : null}
                  {i.id === "setup" && incomplete ? <span className="dot warn" title="Setup incomplete" /> : null}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <a className="studio-link" href="/_feltkit/" target="_blank" rel="noreferrer" title="FeltKit Studio: providers, credentials, models, webhooks, data. In development, open the Dashboard link `npm run dev` printed.">FeltKit Studio ↗</a>
          <div className="muted small">{auth.user?.displayName} · <button className="link" onClick={() => void auth.signOut()}>Sign out</button></div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="ghost menu-btn" aria-label="Menu" onClick={() => setMenu(!menu)}>☰</button>
          <div className="topbar-title">
            <strong>{(biz as any)?.name ?? "…"}</strong>
            {biz && !("missing" in biz) && <span className={`open-state ${(biz as any).openNow ? "open" : ""}`}>{(biz as any).openNow ? "Open now" : "Closed now"}</span>}
          </div>
          <div className="topbar-right">
            {runtime && <span className={`runtime-pill ${runtime.ready && runtime.fresh ? "ok" : "bad"}`} title={runtime.problems.join(" ") || "Telephony runtime healthy"}>{runtime.provider === "simulator" ? "Simulator mode" : "Twilio"} · {runtime.ready && runtime.fresh ? "ready" : "attention"}</span>}
            {!live && <span className="runtime-pill bad">Reconnecting…</span>}
            {runtime?.simulator && <button className="secondary small" onClick={() => setPhoneOpen(!phoneOpen)}>{phoneOpen ? "Close phone" : "📱 Simulator phone"}</button>}
          </div>
        </header>
        {incomplete && page !== "setup" && <div className="banner warn">Setup isn't finished: {setup.data!.steps.filter((s) => !s.done).map((s) => s.label.toLowerCase()).join(", ")}. <a href="#/setup">Finish setup →</a></div>}
        <main className="content">
          {page === "overview" && <Overview go={go} />}
          {page === "live" && <Live id={route[1]} go={go} toasts={toasts} />}
          {page === "inbox" && <Inbox id={route[1]} go={go} toasts={toasts} />}
          {page === "contacts" && <Contacts id={route[1]} go={go} toasts={toasts} />}
          {page === "followups" && <Followups toasts={toasts} />}
          {page === "agents" && <Agents id={route[1]} go={go} toasts={toasts} />}
          {page === "numbers" && <Numbers toasts={toasts} />}
          {page === "settings" && <Settings toasts={toasts} />}
          {page === "team" && <Team />}
          {page === "setup" && <Setup go={go} toasts={toasts} openPhone={() => setPhoneOpen(true)} />}
          {page === "activity" && <Activity />}
        </main>
      </div>
      {phoneOpen && runtime?.url && <SimulatorPhone runtimeUrl={runtime.url} onClose={() => setPhoneOpen(false)} toasts={toasts} />}
    </div>
  );
}

function Team() {
  return (
    <div className="page">
      <div className="page-head"><h1>Team</h1><p className="muted">People and agents in this business. Roles: <b>owner</b> and <b>admin</b> configure the business; <b>staff</b> operate calls and texts. The voice runtime is a member with the role <b>agent</b>; its authority is its own, never a person's.</p></div>
      <div className="grid two">
        <Card title="Members"><MembersPanel /></Card>
        <Card title="Invitations"><InvitationsPanel /></Card>
      </div>
      <Card title="Your account"><AccountSettings /></Card>
    </div>
  );
}

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="logo">
      <rect width="32" height="32" rx="8" fill="var(--brand)" />
      <path d="M11 9.5c1-.6 2.2-.3 2.8.7l1.3 2.3c.5.9.3 2-.5 2.6l-1 .8c.9 1.9 2.4 3.4 4.3 4.3l.8-1c.6-.8 1.7-1 2.6-.5l2.3 1.3c1 .6 1.3 1.8.7 2.8l-.8 1.3c-.7 1.2-2.2 1.8-3.6 1.4-5-1.4-8.9-5.3-10.3-10.3-.4-1.4.2-2.9 1.4-3.6z" fill="var(--brand-ink)" />
      <path d="M19 6.5a7 7 0 0 1 6.5 6.5M19 10a3.6 3.6 0 0 1 3 3" stroke="var(--brand-ink)" strokeWidth="1.8" fill="none" strokeLinecap="round" />
    </svg>
  );
}
