# Test and acceptance report

Date: 2026-11-05. FeltKit 0.3.18, Node 22.

## What ran

| Suite | Count | Result | How |
|---|---|---|---|
| `tests/functional.test.ts` | 8 | pass | Simulator phone over a real WebSocket → runtime → FeltKit → FeltDB |
| `tests/security.test.ts` | 10 | pass | Cross-business, number ownership, privilege escalation, agent least privilege, opt-out, transcript policy, member removal, session tokens, simulator exposure |
| `tests/reliability.test.ts` | 6 | pass | Duplicate/out-of-order events, dropped connection, runtime restart with expired leases, repeated and concurrent capability calls, failed delivery |
| `tests/twilio.test.ts` | 5 | pass | Signed webhooks against a local stand-in for Twilio's REST API; replay, forgery, send failure modes, TwiML, handshake signature, credential non-exposure |
| `tests/model.test.ts` | 3 | pass | Fake OpenAI-compatible streaming model selected via FeltKit's model selection: ungranted tool refused and recorded; barge-in aborts generation; no model → scripted fallback reported |
| `tests/policy.test.ts` | 5 | pass | Time zones/DST, hours, quiet hours, slots, keywords, status ordering, date/time parsing |
| `e2e/voice-agent.e2e.cjs` | 1 flow, 11 steps | pass | Chromium against `npm run dev`; screenshots in `docs/screenshots/` |
| `npm run typecheck` | — | pass | |
| `npm run build`, `npm start` | — | pass | Production server and voice runtime start; runtime reports not-ready until a provider is configured |
| `scripts/deployment-evidence.mjs` | 12 checks | pass | The `feltkit deploy` artifact run as documented: build, artifact inspection, partial/ready/unhealthy health, identity, signed webhooks, WebSocket media, secret isolation, bad release and rollback |
| Docker image of the artifact | — | **not run** | No Docker daemon in this environment; the artifact was run with Node as its DEPLOY.md documents |

Bugs the tests found and that were fixed: transcript writes contending with tool calls (CONFLICT); an
interrupted streaming answer lost from the model's memory; inbound callers hearing the outbound greeting;
interrupted sends left in `sending` forever; summaries reporting a text as `queued` after delivery; a normal
hang-up shown as a lost connection; the simulator phone covering the reply button.

## Definition of done

| # | Criterion | Status |
|---|---|---|
| 1 | Clone and run | **Done** (`npm install`, `npm run dev`) |
| 2 | Works locally | **Done** (simulator) |
| 3 | Studio discoverable and accessible | **Done** (printed Dashboard link; sidebar link; Setup page explains) |
| 4 | Provider configuration through the intended experience | **Done for configuration** (Studio Configuration + Credentials, read live by the runtime; tested via FeltKit's config import and credential store). Not exercised against live Twilio. |
| 5 | Agent configured without code | **Done** (browser test changes the greeting and hears it on the next call) |
| 6 | A real inbound call received | **Not demonstrated**: needs a Twilio account and number. Path tested with signed requests against a stand-in. |
| 7 | A real outbound call initiated | **Not demonstrated** (same reason). Simulator path tested end to end. |
| 8 | Conversational voice interaction | **Done in the simulator** over the ConversationRelay protocol, with barge-in. Real speech (Twilio STT/TTS) not exercised. |
| 9 | An authorized business capability | **Done** (booking, texting, follow-ups, transfer, with refusals recorded) |
| 10 | Inbound and outbound SMS | **Done in the simulator and against the Twilio stand-in**; not against live Twilio |
| 11 | Calls and messages persist in FeltDB | **Done** (survive `restart()`) |
| 12 | Human inspection and intervention | **Done** (live transcript; say, take over, transfer, hang up) |
| 13 | Tenant isolation and authorization tests | **Done** |
| 14 | Retries and duplicate events handled | **Done** |
| 15 | Build and deploy with supported FeltKit commands | **Done locally**: `feltkit deploy --target container` carries the voice component; its artifact, started as DEPLOY.md says, serves UI, webhooks and WebSocket media from one process, reports voice health, and rolls back (docs/DEPLOYMENT-EVIDENCE.md, 12/12). Not deployed to the shared Hetzner host (no access, G9). Requires the unreleased FeltKit runtime components (vendored). |
| 16 | README followable without undocumented knowledge | Every command in it was run in this session, except the Docker image and the Twilio console steps |

**The headline demonstration** (clone → configure → attach a number → call → task done → SMS confirmation →
inspect) **works end to end in simulator mode**. With a real number it requires a Twilio account and has not
been run.

## Production readiness

**Ready**: tenant isolation; default-deny policy; least-privilege agents; webhook signature verification and
replay-safe processing; at-most-once sends with explicit unknown outcomes; consent, STOP, quiet hours, sender
identification, outbound-call restrictions; no audio recording, transcripts by policy with retention.

**Not yet ready / risks**
- Live Twilio verification (the provider-side items in GAPS.md) has not been done. Do it on staging before production.
- One process holds the app and its voice component; run exactly one instance (the work lease would make two safe for queued
  work, but live media sessions are per process and are not handed over).
- A restart drops live calls' media sessions; Twilio's status callbacks still complete the records.
  Simulator calls in progress at a restart stay "in progress" (the simulated phone lives in memory).
- LLM agents: the prompt and the tool results constrain what a model says, but its words are not provably
  truthful; records are authoritative. Use the scripted brain where that matters.
- Per-business provider credentials are not supported (G4).
- The deployment is verified on this machine only (Node, not Docker; not the shared Hetzner host).
- Voice Agent depends on an unreleased FeltKit build (runtime components), vendored in `vendor/`.
- Legal requirements for calling and texting (TCPA, A2P 10DLC registration, recording-consent law) depend on
  jurisdiction and use; the policies here are safe defaults, not legal advice.
