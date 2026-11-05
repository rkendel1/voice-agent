# Gap register

Platform gaps found while building this starter. Each was worked around inside the application only; none
was patched in a shared repository. Owner is where the fix belongs.

| # | Gap | Effect here | Workaround | Belongs in |
|---|---|---|---|---|
| G1 | FeltKit 0.3.18 serves only its own routes, answers only `localhost` in development, and has no application-defined HTTP routes, raw (form-encoded) request bodies, or WebSocket upgrades. | Provider webhooks and per-call media sockets cannot be FeltKit functions. `npm run dev` cannot be plain `feltkit dev`. | `server/dev.ts` / `server/start.ts` embed FeltKit via `@feltdb/feltkit/server` and run the voice runtime on a second port in the same process. | FeltKit: an inbound-webhook surface (AppPort Services already reserves `inbound_webhook_events`) with pluggable signature verifiers, and an app WebSocket/stream route. |
| G2 | `feltkit deploy` packages only the backend bundle and frontend; its image runs `feltkit start`. | A `feltkit deploy` deployment serves the app but answers no calls. | Repository `Dockerfile` running `npm start` (untested: see ACCEPTANCE.md). | FeltKit: an entry hook or extra-module packaging for deploy targets. |
| G3 | `app.integration` sends JSON bodies only. | Twilio's REST API (form-encoded, Basic auth) cannot be an integration, so its calls do not get FeltKit's integration call records/verification. | Called from `gateway/providers/twilio.ts` with our own receipt/unknown-outcome handling. | FeltKit/AppPort integration: request encodings (form) and Basic auth credentials. |
| G4 | Credentials are per environment, not per tenant (`withSecret` ignores `tenantId`). | One Twilio account per deployment; businesses cannot bring their own provider credentials. | Documented: the operator's account serves all businesses (Twilio subaccounts would be the next step). | FeltKit credential custody / AppPort Services: tenant-scoped secrets with tenant-admin authority. |
| G5 | Optimistic transactions answer `CONFLICT` when a read record changes; app functions that run concurrently on one call (transcript writes, tool calls) contend. | Tool calls failed under load until fixed. | Hot counter removed from `calls`; the bridge retries `CONFLICT` (FeltKit guarantees nothing was written). | FeltKit: `retry` option for general read conflicts (today only `sequenceConflicts`). |
| G6 | Production credential custody is read-only unless `FELTKIT_CREDENTIAL_VAULT=1`. | Rotating the Twilio token in production Studio is not available by default. | `FELTKIT_CREDENTIAL_TWILIO_AUTH_TOKEN` on the host. | Platform decision (by design today). |
| G7 | AppBoundry artifacts refuse `app.agent` and have no tenancy. | `feltkit build --target appboundry` cannot produce this app (same as Multiplayer). | Run with FeltKit. | AppBoundry. |

## Provider-side items not verified

| Item | Status |
|---|---|
| Exact URL Twilio signs on the ConversationRelay WebSocket handshake | Docs say "the request URL" and suggest trying a trailing `/`. We accept the URL, the URL with `/` before the query, and with a trailing `/`; and bind the session with our own token regardless. Needs a live check. |
| Call status callback field names (`CallStatus`, `CallDuration`, `SequenceNumber`) | From Twilio docs summaries; implemented, tested against our stand-in only. |
| Twilio Advanced Opt-Out sending STOP/HELP replies | Assumed (Twilio default on long codes); we do not send our own. |
