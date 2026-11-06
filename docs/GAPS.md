# Gap register

Platform gaps found while building this starter. G1, G2 and G8 were closed in FeltKit itself (runtime
components; branch `claude/eager-ritchie-qazq3g` of rkendel1/feltkit, not yet released); the others are worked
around in the application or open. "Belongs in" is where the fix belongs.

| # | Gap | Effect here | Workaround | Belongs in |
|---|---|---|---|---|
| G1 | FeltKit 0.3.18 serves only its own routes, answers only `localhost` in development, and has no application-defined HTTP routes, raw (form-encoded) request bodies, or WebSocket upgrades. | Provider webhooks and per-call media sockets cannot be FeltKit functions. | **Closed in FeltKit** (branch `claude/eager-ritchie-qazq3g`, unreleased): runtime components (`feltkit({ components })`, docs/COMPONENTS.md) route declared prefixes, HTTP and WebSocket, on the app's port. Voice Agent vendors that build until it is released. | — (release pending) |
| G2 | `feltkit deploy` packaged only the backend bundle and frontend; its image ran `feltkit start` without the gateway, and reported healthy. | A deployment served the UI and could not take a call. | **Closed in FeltKit** (same branch): components are built, carried by every target, started by `feltkit start`, and part of `/_feltkit/health`; the boot check refuses an artifact whose component does not load. Evidence: docs/DEPLOYMENT-EVIDENCE.md. | — (release pending) |
| G8 | `feltkit deploy` named `file:` dependencies without carrying the files. | A vendored package broke `npm ci` in the artifact. | **Closed in FeltKit** (same branch). | — |
| G3 | `app.integration` sends JSON bodies only. | Twilio's REST API (form-encoded, Basic auth) cannot be an integration, so its calls do not get FeltKit's integration call records/verification. | Called from `gateway/providers/twilio.ts` with our own receipt/unknown-outcome handling. | FeltKit/AppPort integration: request encodings (form) and Basic auth credentials. |
| G4 | Credentials are per environment, not per tenant (`withSecret` ignores `tenantId`). | One Twilio account per deployment; businesses cannot bring their own provider credentials. | Documented: the operator's account serves all businesses (Twilio subaccounts would be the next step). | FeltKit credential custody / AppPort Services: tenant-scoped secrets with tenant-admin authority. |
| G5 | Optimistic transactions answer `CONFLICT` when a read record changes; app functions that run concurrently on one call (transcript writes, tool calls) contend. | Tool calls failed under load until fixed. | Hot counter removed from `calls`; the bridge retries `CONFLICT` (FeltKit guarantees nothing was written). | FeltKit: `retry` option for general read conflicts (today only `sequenceConflicts`). |
| G6 | Production credential custody is read-only unless `FELTKIT_CREDENTIAL_VAULT=1`. | Rotating the Twilio token in production Studio is not available by default. | `FELTKIT_CREDENTIAL_TWILIO_AUTH_TOKEN` on the host. | Platform decision (by design today). |
| G7 | AppBoundry artifacts refuse `app.agent` and have no accounts or tenancy (FK-GAP-013). | `feltkit build --target appboundry` cannot produce this app (same as Multiplayer), with or without AppBoundry's new `components@1`. | Deploy with FeltKit's own targets. | AppBoundry (identity/tenancy host interfaces, app agents). |
| G9 | No access from this session to the shared Hetzner host; AppBoundry managed hosting has no public routing (`ROUTING: unavailable`) and customer execution is disabled there. | No deployment to the shared host was made. | Local evidence on the real artifact (docs/DEPLOYMENT-EVIDENCE.md). | Operator access; AppBoundry routing/TLS (design §18). |

## Provider-side items not verified

| Item | Status |
|---|---|
| Exact URL Twilio signs on the ConversationRelay WebSocket handshake | Docs say "the request URL" and suggest trying a trailing `/`. We accept the URL, the URL with `/` before the query, and with a trailing `/`; and bind the session with our own token regardless. Needs a live check. |
| Call status callback field names (`CallStatus`, `CallDuration`, `SequenceNumber`) | From Twilio docs summaries; implemented, tested against our stand-in only. |
| Twilio Advanced Opt-Out sending STOP/HELP replies | Assumed (Twilio default on long codes); we do not send our own. |
