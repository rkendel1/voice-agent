import { useEffect, useRef, useState } from "react";
import { useQuery } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { fmtPhone, type Toasts } from "./ui";

/**
 * The development simulator: the phone of a simulated contact. It calls and texts the business's
 * simulator numbers through the voice runtime's simulator endpoints, which feed the same handlers as
 * Twilio's webhooks; on a call it speaks Twilio's ConversationRelay protocol over a WebSocket. With
 * "Speak" on, the browser reads the agent aloud; the microphone uses the browser's speech recognition
 * where available (Chrome). Nothing here is a real phone call.
 */
type Line = { who: "me" | "agent" | "system"; text: string };

export function SimulatorPhone({ runtimeUrl, onClose, toasts }: { runtimeUrl: string; onClose: () => void; toasts: Toasts }) {
  const numbers = (useQuery(api.numbers.list, {}) ?? []).filter((n: any) => n.provider === "simulator");
  const [mine, setMine] = useState(() => { try { return localStorage.getItem("sim.phone") ?? "+15557770123"; } catch { return "+15557770123"; } });
  const [target, setTarget] = useState("");
  const [tab, setTab] = useState<"call" | "texts">("call");
  const [phoneState, setPhoneState] = useState<{ texts: any[]; ringing: any[] }>({ texts: [], ringing: [] });
  const [sent, setSent] = useState<Array<{ body: string; at: number }>>([]);
  const [draft, setDraft] = useState("");
  const [call, setCall] = useState<null | { sid: string; ws: WebSocket | null; status: string }>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [speak, setSpeak] = useState(true);
  const [listening, setListening] = useState(false);
  const current = useRef("");
  const spoken = useRef(0);
  const speaking = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const to = target || numbers[0]?.e164 || "";

  useEffect(() => { try { localStorage.setItem("sim.phone", mine); } catch { /* private mode */ } }, [mine]);
  useEffect(() => {
    const poll = async () => {
      try { setPhoneState(await (await fetch(`${runtimeUrl}/simulator/phone?number=${encodeURIComponent(mine)}`)).json()); } catch { /* runtime restarting */ }
    };
    void poll();
    const t = setInterval(poll, 1000);
    return () => clearInterval(t);
  }, [runtimeUrl, mine]);
  useEffect(() => { scroller.current?.scrollTo({ top: 1e6 }); }, [lines.length, phoneState.texts.length, sent.length, tab]);
  useEffect(() => () => { call?.ws?.close(); window.speechSynthesis?.cancel(); }, []);

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${runtimeUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `Simulator: ${res.status}`);
    return json;
  };

  const say = (text: string) => {
    if (!speak || !("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.onstart = () => { speaking.current = true; spoken.current = 0; };
    u.onboundary = (e) => { spoken.current = e.charIndex; };
    u.onend = () => { speaking.current = false; };
    window.speechSynthesis.speak(u);
  };

  const connect = (plan: any, sid: string) => {
    if (plan.kind !== "relay") {
      setLines((l) => [...l, { who: "system", text: plan.kind === "forward" ? `Forwarded to ${plan.forwardTo} (simulated: no one answers)` : `“${plan.say}” — the call ends.` }]);
      setCall(null);
      return;
    }
    const ws = new WebSocket(plan.relayUrl);
    ws.onopen = () => ws.send(JSON.stringify({ type: "setup", callSid: sid, from: mine, to }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "text") {
        current.current += m.token;
        if (m.last) {
          const text = current.current.trim();
          current.current = "";
          if (text) { setLines((l) => [...l, { who: "agent", text }]); say(text); }
        }
      }
      if (m.type === "end") {
        const h = JSON.parse(m.handoffData ?? "{}");
        setLines((l) => [...l, { who: "system", text: h.reason === "transfer" ? "Transferring to a person (simulated) — call ends here." : "The agent ended the call." }]);
      }
    };
    ws.onclose = () => setCall((c) => (c && c.sid === sid ? { ...c, ws: null, status: "ended" } : c));
    setCall({ sid, ws, status: "connected" });
  };

  const dial = async () => {
    if (!to) return toasts.error("Add a simulator number first (Phone numbers).");
    setLines([]);
    try {
      const r = await post("/simulator/call", { from: mine, to });
      setCall({ sid: r.sid, ws: null, status: "connecting" });
      connect(r, r.sid);
    } catch (e) { toasts.error(e); }
  };
  const answer = async (sid: string) => {
    setLines([]);
    try { const r = await post("/simulator/answer", { sid }); connect(r, sid); setTab("call"); } catch (e) { toasts.error(e); }
  };
  const hangup = async () => {
    if (!call) return;
    window.speechSynthesis?.cancel();
    // Like a phone network: the hang-up is reported, then the media stream closes.
    await post("/simulator/hangup", { sid: call.sid }).catch(() => {});
    call.ws?.close();
    setCall(null);
  };

  /** Speak to the agent. If it is talking, barge in: it stops, and is told what was heard. */
  const send = (text: string) => {
    const ws = call?.ws;
    if (!ws || ws.readyState !== 1 || !text.trim()) return;
    const inFlight = current.current || (speaking.current ? lines.filter((l) => l.who === "agent").at(-1)?.text ?? "" : "");
    if (inFlight) {
      const heard = speaking.current ? inFlight.slice(0, spoken.current) : inFlight;
      ws.send(JSON.stringify({ type: "interrupt", utteranceUntilInterrupt: heard, durationUntilInterruptMs: 0 }));
      current.current = "";
      window.speechSynthesis?.cancel();
      speaking.current = false;
    }
    ws.send(JSON.stringify({ type: "prompt", voicePrompt: text.trim(), lang: "en-US", last: true }));
    setLines((l) => [...l, { who: "me", text: text.trim() }]);
  };

  const listen = () => {
    const SR = (window as any).webkitSpeechRecognition ?? (window as any).SpeechRecognition;
    if (!SR) return toasts.error("This browser has no speech recognition; type instead.");
    const r = new SR();
    r.lang = "en-US";
    r.interimResults = false;
    r.onresult = (e: any) => send(e.results[0][0].transcript);
    r.onend = () => setListening(false);
    setListening(true);
    r.start();
  };

  const thread = [...phoneState.texts.map((t) => ({ me: false, body: t.body, at: t.at })), ...sent.map((t) => ({ me: true, ...t }))].sort((a, b) => a.at - b.at);
  const ringing = phoneState.ringing[0];
  return (
    <aside className="phone" aria-label="Simulator phone">
      <header className="phone-head">
        <div><strong>Simulator phone</strong><div className="small">Development only · not a real call</div></div>
        <button className="ghost" onClick={onClose} aria-label="Close">✕</button>
      </header>
      <div className="phone-setup">
        <label>This phone<input value={mine} onChange={(e) => setMine(e.target.value)} disabled={Boolean(call)} /></label>
        <label>Business number<select value={to} onChange={(e) => setTarget(e.target.value)} disabled={Boolean(call)}>{numbers.length ? numbers.map((n: any) => <option key={n.id} value={n.e164}>{fmtPhone(n.e164)} · {n.label}</option>) : <option value="">No simulator numbers</option>}</select></label>
      </div>
      {ringing && !call && (
        <div className="ringing" role="alert">
          <div>📞 Incoming call from <b>{fmtPhone(ringing.from)}</b></div>
          <div className="actions"><button onClick={() => void answer(ringing.sid)}>Answer</button><button className="danger" onClick={() => void post("/simulator/decline", { sid: ringing.sid }).catch(toasts.error)}>Decline</button></div>
        </div>
      )}
      <div className="segmented phone-tabs"><button className={tab === "call" ? "on" : ""} onClick={() => setTab("call")}>Call</button><button className={tab === "texts" ? "on" : ""} onClick={() => setTab("texts")}>Texts {phoneState.texts.length ? `(${phoneState.texts.length})` : ""}</button></div>
      <div className="phone-body" ref={scroller}>
        {tab === "call" ? (
          lines.length ? lines.map((l, i) => <div key={i} className={`pl ${l.who}`}>{l.text}</div>) : <p className="muted small pad">Call the business and talk to its agent. Try: “I'd like to book an appointment tomorrow”, “what are your hours?”, “can I leave a message?”, or “let me talk to a person”.</p>
        ) : (
          thread.length ? thread.map((t, i) => <div key={i} className={`pl ${t.me ? "me" : "agent"}`}>{t.body}</div>) : <p className="muted small pad">Text the business. Send STOP to opt out, START to opt back in.</p>
        )}
      </div>
      {tab === "call" ? (
        call ? (
          <div className="phone-controls">
            <form onSubmit={(e) => { e.preventDefault(); send(draft); setDraft(""); }}>
              <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={call.ws ? "Say something…" : "Call ended"} disabled={!call.ws} aria-label="Say" />
              <button type="button" className={`secondary ${listening ? "on" : ""}`} onClick={listen} disabled={!call.ws} title="Speak (browser speech recognition)">🎤</button>
            </form>
            <div className="actions">
              <label className="toggle small"><input type="checkbox" checked={speak} onChange={(e) => { setSpeak(e.target.checked); if (!e.target.checked) window.speechSynthesis?.cancel(); }} /> Speak aloud</label>
              <button className="danger" onClick={() => void hangup()}>{call.ws ? "Hang up" : "Close"}</button>
            </div>
          </div>
        ) : <div className="phone-controls"><button className="call-btn" onClick={() => void dial()} disabled={!to}>📞 Call {fmtPhone(to)}</button></div>
      ) : (
        <form className="phone-controls" onSubmit={(e) => { e.preventDefault(); const body = draft.trim(); if (!body) return; void post("/simulator/sms", { from: mine, to, body }).then(() => { setSent((s) => [...s, { body, at: Date.now() }]); setDraft(""); }, toasts.error); }}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Text message" aria-label="Text message" />
          <button type="submit" disabled={!to}>Send</button>
        </form>
      )}
    </aside>
  );
}
