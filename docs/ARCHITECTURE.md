# Architecture

## 1. Assessment (Phase 0)

Inspected: FeltKit 0.3.18 (`rkendel1/feltkit`: SDK, CLI, Studio, runtime), Multiplayer (`rkendel1/multiplayer`,
the reference starter), AppPort Services 0.15 (bundled with FeltKit), AuthBoundry and AppBoundry (through
FeltKit's integration with them).

**Reused directly**

| Need | Platform capability |
|---|---|
| Businesses, members, roles, invitations, switching | FeltKit tenancy (`auth.tenant`), `TenantSwitcher`, `MembersPanel`, `InvitationsPanel` |
| Accounts, sign-in, sessions | FeltKit accounts (`auth.accounts`), `SignIn`, cookie sessions |
| Durable state, indexes, uniqueness, search, live queries | FeltDB collections through `app.collection` |
| Authorization | `roles` + one `authorize` hook, enforced on every interface |
| Capability discovery and invocation | AppPort (functions with `capability`), MCP |
| Agent identity and durable post-call work | `app.agent("voice")` (principal `voice-runtime`) |
| Provider/account settings, model, credentials | AppPort Services Configuration, Intelligence, FeltKit credential custody |
| Outbound events to other systems | AppPort Services Webhooks (signed, retried, recorded) |
| Operations UI for developers/operators | FeltKit Studio (Data, Capabilities, Services, Models, Activity, Readiness) |
| Tests | `@feltdb/feltkit/testing` (`createTestApp`, real isolated FeltDB) |
| Embedding | `@feltdb/feltkit/server` (`startDev`, `startProduction`, `FeltKitRuntime`) |

**New application code**: the data model and policy (`feltkit/`), agent capabilities (`feltkit/tools.ts`), the
provider-independent ingest contract (`feltkit/gateway.ts`), the voice runtime (`gateway/`), the UI (`src/`).

**New platform functionality required**: none was added to the platform. Two gaps had to be worked around
inside the application and are registered in [GAPS.md](GAPS.md) (G1 inbound HTTP/WebSocket surface, G2
deploy packaging). Each workaround is contained in `server/` and `gateway/runtime.ts`.

**Provider-specific**: everything in `gateway/providers/twilio.ts` (signatures, TwiML, REST). The application
and voice session see provider-neutral events and the ConversationRelay message protocol.

**Blockers**: no live Twilio account or credentials in this environment, so the live provider path is tested
against a local stand-in, not Twilio itself ([ACCEPTANCE.md](ACCEPTANCE.md)).

## 2. Decisions

**ADR-1 · Businesses are FeltKit tenants.** All business data is declared `{ tenant: { field: "businessId" } }`.
FeltKit stamps and filters it; the policy refuses any `businessId` argument that is not the session's. No
application-level tenancy code exists to get wrong.

**ADR-2 · The voice runtime is embedded, not a second service.** Telephony needs public, provider-signed
form webhooks and a WebSocket per call; FeltKit 0.3.18 serves neither to applications (G1). The runtime runs
in the same process as FeltKit through its public embedding API and acts only through `runtime.call` as the
principal `voice-runtime`, inside a business via `runtime.withTenant` (live membership). It has no database,
no state and no authority of its own. Rejected: a separate service calling AppPort over HTTP (one session per
business, a second deployment), and patching FeltKit's server (incompatible assumptions about a shared repo).

**ADR-3 · Twilio, with ConversationRelay.** Considered Twilio and Telnyx. Telnyx's REST API is JSON with a
bearer key, so outbound SMS could have used `app.integration` directly; but its voice path streams raw audio,
which would add a speech-recognition and a speech-synthesis provider, their keys, and our own turn detection.
Twilio ConversationRelay does recognition, synthesis and barge-in detection and exchanges text over one
WebSocket, which gives natural latency with the fewest moving parts. Its REST API is form-encoded, so it
cannot go through `app.integration` (JSON only, G3); it is called from the adapter. The session protocol is
ConversationRelay's; a raw-audio provider would be an adapter that turns audio into those messages.

**ADR-4 · Agents act only through authorized capabilities.** The model (or the scripted brain) proposes a tool
call; the runtime supplies the agent, the call and a tool-call id; FeltKit validates, authorizes (role `voice`,
then the agent profile's allow-list in `authorize`), executes in a transaction, and records the invocation.
The result is the only thing the agent may report. Requests for ungranted capabilities are still sent to the
policy so the refusal is decided and recorded there.

**ADR-5 · Durable work, at-most-once effects.** Anything done after a request (send a text, dial, answer a
text, summarise) is written to `work` in the same transaction as the record it is for, then leased by the
runtime. Sends are claimed (`queued → sending`) before the provider is called; a lease that expires mid-send
marks the message `unknown`, never resends. Provider events are deduplicated by `(provider, key)` in the
transaction that applies them; statuses only move forward.

**ADR-6 · A scripted brain by default.** The product works without a model: the deterministic agent answers,
books from real availability, texts confirmations, takes messages and transfers. Models (Studio → Models)
improve conversation; they are not the product. Model access is plain HTTPS (Anthropic Messages, OpenAI Chat
Completions) with no SDK, so providers stay replaceable.

**ADR-7 · Call summaries are derived, not generated.** A summary lists what the caller said and what actions
succeeded or failed, from records. It cannot claim an outcome that did not happen.

**ADR-8 · Configuration split.** Per-business settings are FeltDB records edited in the app by the business's
owners/admins (and visible in Studio → Data). Deployment settings (provider, credentials, model, webhooks)
are in Studio and the `feltkit` CLI, where FeltKit already manages them. Nothing is configured in source.

## 3. Data model

| Collection | Scope | Purpose |
|---|---|---|
| `businesses` | business | Identity, hours, time zone, about, escalation contacts, policy |
| `agents` | business | Instructions, greeting, voice, brain, capabilities, schedule, escalation |
| `phoneNumbers` | business | Numbers, provider, agent, fallback, SMS/voice, caller ID |
| `numberRoutes` | global (runtime only) | Number → business, written with `phoneNumbers` |
| `contacts` | business | People, consent (opt-out, do-not-call, call consent) |
| `conversations` | business | One per contact: the unified inbox |
| `messages` | business | Texts and notes, receipts, delivery state, idempotency key |
| `calls` | business | Calls, receipts, live session state, transfer, operator control, outcome, summary |
| `transcripts` | business | One record per turn, unique `(callId, seq)` |
| `invocations` | business | Every agent capability call: decision, result, idempotency key |
| `appointments` | business | Unique slot per business |
| `tasks` | business | Follow-ups |
| `audit` | business | Calls, texts, agent actions/refusals, interventions, configuration and consent changes |
| `providerEvents` | global | Each provider event once |
| `work` | global | The runtime's leased work queue |
| `runtimeStatus` | global | The runtime's last health report |

Global collections are read and written only by functions whose policy scope admits the voice runtime.

## 4. Call lifecycle

1. Twilio → `POST /twilio/voice` (signature verified) → `gateway:route` → `gateway:inboundCall` decides from
   configuration: agent (on duty), forward (fallback contact), or unavailable (missed).
2. TwiML connects ConversationRelay to `wss://…/twilio/relay?callId&b&t`. The handshake signature is checked;
   the token `t` (HMAC of the call key with the app's auth secret; only its hash is stored) binds the session to
   the call in `gateway:sessionOpened`.
3. Each `prompt` is recorded, the brain answers, text streams to Twilio. `interrupt` aborts generation and
   records only what was heard. Operator control is read from the call record and applied.
4. A transfer ends the session with `handoffData`; Twilio calls `<Connect action>`; the runtime answers `<Dial>`.
5. Call status callbacks complete the record; missed calls start the `voice` agent's follow-up workflow;
   `call.summarize` writes the summary; `call.completed` is emitted to webhooks.
