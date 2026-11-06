#!/usr/bin/env node
/**
 * Deployment evidence for Voice Agent, on this machine, from the real `feltkit deploy` artifact.
 *
 *   node scripts/deployment-evidence.mjs            → docs/DEPLOYMENT-EVIDENCE.md (+ raw JSON log)
 *
 * It does what an operator does, and nothing else:
 *   1. `npx feltkit deploy --target container --out <release>` (the supported command; refuses broken components)
 *   2. in the release, as DEPLOY.md says: `npm ci --omit=dev`, `npm start` (one process: app, Studio, AppPort, voice)
 *   3. configuration with `npx feltkit config import --env production` and FELTKIT_CREDENTIAL_TWILIO_AUTH_TOKEN
 *   4. probes from outside the process only: HTTP and WebSocket on the one port
 *   5. a bad release, then rollback to the previous one on the same state
 * No server is contacted other than localhost; Twilio itself is not involved (requests are signed exactly as
 * Twilio signs them, with the configured token, for the configured public URL).
 */
import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const ROOT = resolve(process.argv[2] ?? ".");
const WORK = resolve(process.env.EVIDENCE_DIR ?? "/tmp/voice-agent-evidence");
const PORT = Number(process.env.EVIDENCE_PORT ?? 3410);
const URL_ = `http://127.0.0.1:${PORT}`;
const PUBLIC = "https://voice-agent.example.test";
const ACCOUNT = "AC0000000000000000000000000000e5e5";
const TOKEN = `twilio-token-${randomBytes(12).toString("hex")}`;
const NUMBER = "+15559990001";
const CALLER = "+15557770123";
const log = [];
const record = (step, ok, detail) => { log.push({ step, ok, detail }); console.log(`${ok ? "✓" : "✗"} ${step}`); if (!ok) console.log(JSON.stringify(detail, null, 2)); };
const sign = (url, params) => createHmac("sha1", TOKEN).update(url + Object.keys(params).sort().map((k) => k + params[k]).join("")).digest("base64");

const baseEnv = {
  ...process.env, NODE_ENV: "production", PORT: String(PORT),
  FELTKIT_AUTH_SECRET: randomBytes(32).toString("base64"),
  FELTKIT_STATE_DIR: join(WORK, "state"),             // one durable state for every release (the container's volume)
  FELTKIT_DEPLOYMENT_TOKEN: randomBytes(16).toString("hex"),
};
for (const k of Object.keys(baseEnv)) if (k.startsWith("FELTKIT_CREDENTIAL_")) delete baseEnv[k];

function sh(cmd, args, cwd, env = baseEnv) {
  return execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function start(release, extra = {}) {
  const out = [];
  const child = spawn("npm", ["start"], { cwd: release, env: { ...baseEnv, ...extra }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${URL_}/_feltkit/health`); if (r.status !== 503 || (await r.clone().json()).status !== "starting") return { child, out }; } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`release did not start:\n${out.join("")}`);
}
async function stop({ child }) {
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
  await new Promise((r) => { child.on("exit", r); setTimeout(r, 12_000); });
  for (let i = 0; i < 40; i++) { try { await fetch(`${URL_}/_feltkit/health`); } catch { return; } await new Promise((r) => setTimeout(r, 250)); }
}
const health = async () => { const r = await fetch(`${URL_}/_feltkit/health`); return { http: r.status, ...(await r.json()) }; };
const deployment = async () => { const r = await fetch(`${URL_}/_feltkit/deployment`, { headers: { authorization: `Bearer ${baseEnv.FELTKIT_DEPLOYMENT_TOKEN}` } }); return { http: r.status, ...(await r.json()) }; };

async function twilio(path, params, { signed = true } = {}) {
  const all = { AccountSid: ACCOUNT, ...params };
  const r = await fetch(`${URL_}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(signed ? { "x-twilio-signature": sign(PUBLIC + path, all) } : {}) }, body: new URLSearchParams(all) });
  return { status: r.status, component: r.headers.get("x-feltkit-component"), body: await r.text() };
}

function filesUnder(dir, skip = new Set(["node_modules", "state"])) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, skip)); else out.push(p);
  }
  return out;
}

async function main() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const r1 = join(WORK, "releases", "r1");

  // 1. Clean build and the supported deploy command.
  const deployOut = sh("npx", ["feltkit", "deploy", "--target", "container", "--out", r1], ROOT, process.env);
  record("1 · feltkit deploy --target container (build, boot check, component check)", /Component voice: loaded and routed/.test(deployOut), deployOut.trim().split("\n").slice(0, 3));

  // 2. Artifact inspection: everything the application needs to run is in it.
  const manifest = JSON.parse(readFileSync(join(r1, ".feltkit/build/manifest.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(r1, "package.json"), "utf8"));
  const voice = manifest.components.find((c) => c.name === "voice");
  const inspection = {
    functions: manifest.functions, collections: manifest.collections, application: manifest.application,
    component: voice && { file: voice.file, sha256: voice.sha256, routes: voice.routes, websocket: voice.websocket, required: voice.required, credentials: voice.credentials, principal: voice.principal.id },
    files: ["functions.mjs", "components/voice.mjs"].map((f) => [f, existsSync(join(r1, ".feltkit/build", f))]),
    frontend: existsSync(join(r1, "dist/client/index.html")),
    start: pkg.scripts.start, dependencies: Object.keys(pkg.dependencies),
    dockerfile: readFileSync(join(r1, "Dockerfile"), "utf8").split("\n").filter((l) => /^(COPY|CMD|HEALTHCHECK|EXPOSE)/.test(l) || /fetch\(/.test(l)).map((l) => l.trim()),
  };
  record("2 · artifact contains the functions, the frontend and the voice component (routes, WebSocket, credential reference)", Boolean(voice && inspection.files.every(([, ok]) => ok) && inspection.frontend && voice.routes.includes("/twilio/")), inspection);
  sh("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], r1);

  // 3. Deployed with no provider configured: the UI works, voice does not → never "ready".
  let run = await start(r1, { FELTKIT_DEPLOYMENT_REVISION: "r1" });
  let h = await health();
  const ui = await fetch(`${URL_}/`);
  record("3 · deployed, provider not configured: UI 200, health 503 \"partial\", webhooks check unconfigured", ui.status === 200 && h.http === 503 && h.status === "partial" && h.components.voice.checks.webhooks.state === "unconfigured", { ui: ui.status, health: h });
  const unconfiguredHook = await twilio("/twilio/sms", { MessageSid: "SM1", From: CALLER, To: NUMBER, Body: "x" });
  record("3b · webhook route reaches the voice component, which refuses to process while unconfigured (503)", unconfiguredHook.status === 503 && unconfiguredHook.component === "voice", unconfiguredHook);
  await stop(run);

  // 4. Configuration, the supported way: variables with `feltkit config import`, the secret in the environment.
  const cfg = join(WORK, "config.json");
  const exported = JSON.parse(sh("npx", ["feltkit", "config", "export", "--env", "production"], r1).trim().replace(/^[^{]*/, ""));
  exported.variables = [{ name: "TELEPHONY_PROVIDER", value: "twilio" }, { name: "TWILIO_ACCOUNT_SID", value: ACCOUNT }, { name: "PUBLIC_BASE_URL", value: PUBLIC }];
  writeFileSync(cfg, JSON.stringify(exported));
  const imported = sh("npx", ["feltkit", "config", "import", cfg, "--env", "production", "--overwrite"], r1);
  record("4 · feltkit config import --env production (TELEPHONY_PROVIDER, TWILIO_ACCOUNT_SID, PUBLIC_BASE_URL)", /TELEPHONY_PROVIDER/.test(imported), imported.trim().split("\n").slice(-4));
  const secretEnv = { FELTKIT_CREDENTIAL_TWILIO_AUTH_TOKEN: TOKEN };

  run = await start(r1, { ...secretEnv, FELTKIT_DEPLOYMENT_REVISION: "r1" });
  h = await health();
  record("5 · UI health and voice health: 200 \"ready\"; webhooks, media and work checks ready", h.http === 200 && h.status === "ready" && Object.values(h.components.voice.checks).every((c) => c.state === "ready"), h);
  const d1 = await deployment();
  record("6 · one application identity: health, deployment report and component agree", d1.application === "voice-agent" && h.application === "voice-agent" && d1.components?.voice?.sha256 === voice.sha256 && d1.deployment.revision === "r1", { application: [h.application, d1.application], revision: d1.deployment.revision, bundleSha256: d1.bundleSha256, componentSha256: d1.components?.voice?.sha256, manifestComponentSha256: voice.sha256, pid: d1.pid });

  // A business, as people create it: an account, a business, a Twilio number, the voice runtime connected.
  const { createClient } = await import(join(r1, "node_modules/@feltdb/feltkit/dist/client/index.js"));
  const { api } = await import(join(ROOT, "feltkit/_generated/api.ts")).catch(() => ({ api: null }));
  let token = null;
  const client = createClient({ url: URL_, tokens: { get: () => token, set: (v) => { token = v; } } });
  await client.signUp({ email: "owner@example.com", password: "a-long-test-password-1", name: "Owner" });
  await client.createTenant("Acme Dental");
  const fn = (name) => ({ name, kind: "mutation" });
  await client.mutation(api?.business.ensure ?? fn("business:ensure"), { timezone: "America/New_York" });
  await client.mutation(api?.business.update ?? fn("business:update"), { hours: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => ({ day, open: "00:00", close: "24:00" })), escalation: [{ id: "frontdesk", name: "Reception", phone: "+15550000001" }] });
  await client.addMember("voice-runtime", "agent");
  await client.mutation(api?.agents.connect ?? fn("agents:connect"), {});
  const [agent] = await client.query(api?.agents.list ?? { name: "agents:list", kind: "query" }, {});
  await client.mutation(api?.numbers.add ?? fn("numbers:add"), { e164: NUMBER, label: "Main", provider: "twilio", sms: true, voice: true, agentId: agent.id });

  // 7. Provider webhooks on the public routes: unsigned refused, signed processed once.
  const unsigned = await twilio("/twilio/sms", { MessageSid: "SM00000000000000000000000000000001", From: CALLER, To: NUMBER, Body: "hello", NumMedia: "0" }, { signed: false });
  const signed = await twilio("/twilio/sms", { MessageSid: "SM00000000000000000000000000000001", From: CALLER, To: NUMBER, Body: "hello", NumMedia: "0" });
  const replay = await twilio("/twilio/sms", { MessageSid: "SM00000000000000000000000000000001", From: CALLER, To: NUMBER, Body: "hello", NumMedia: "0" });
  const convs = await client.query({ name: "conversations:list", kind: "query" }, {});
  const items = convs.length ? (await client.query({ name: "conversations:timeline", kind: "query" }, { conversationId: convs[0].id })).items.filter((i) => i.type === "sms" && i.direction === "inbound") : [];
  record("7 · webhook reachability: unsigned 403, signed 200, replay processed once, recorded in FeltDB", unsigned.status === 403 && signed.status === 200 && replay.status === 200 && items.length === 1 && signed.component === "voice", { unsigned: unsigned.status, signed: signed.status, replay: replay.status, inboundMessages: items.length, component: signed.component });

  // 8. WebSocket media: the voice webhook answers TwiML; the signed handshake is upgraded and the agent speaks.
  const call = await twilio("/twilio/voice", { CallSid: "CA00000000000000000000000000000001", From: CALLER, To: NUMBER, Direction: "inbound" });
  const relay = (call.body.match(/<ConversationRelay url="([^"]+)"/)?.[1] ?? "").replace(/&amp;/g, "&");
  const local = relay.replace(PUBLIC.replace("https", "wss"), URL_.replace("http", "ws"));
  const heard = [];
  const ws101 = await new Promise((resolveWs) => {
    const ws = new WebSocket(local, { headers: { "x-twilio-signature": sign(relay, {}) } });
    ws.on("upgrade", (res) => heard.push(`HTTP ${res.statusCode}`));
    ws.on("open", () => ws.send(JSON.stringify({ type: "setup", callSid: "CA00000000000000000000000000000001" })));
    ws.on("message", (m) => { const x = JSON.parse(String(m)); if (x.type === "text" && x.last) heard.push(x.token); if (heard.length >= 3) { ws.close(); resolveWs(true); } });
    ws.on("error", (e) => resolveWs(String(e.message)));
    setTimeout(() => resolveWs("timeout"), 10_000);
  });
  const unsignedWs = await new Promise((r) => { const ws = new WebSocket(local); ws.on("open", () => r("opened")); ws.on("error", (e) => r(e.message)); });
  record("8 · WebSocket reachability: TwiML relay URL on the public origin; signed upgrade 101 and the agent speaks; unsigned refused", ws101 === true && /^wss:\/\/voice-agent\.example\.test\/twilio\/relay\?/.test(relay) && /403/.test(unsignedWs), { relay: relay.replace(/t=[^&]+/, "t=…"), heard, unsignedUpgrade: unsignedWs });
  await client.query({ name: "calls:list", kind: "query" }, {}); // still serving
  const logs1 = run.out.join("");
  await stop(run);

  // 9. Secret isolation: the token is in the process environment only.
  const leaks = filesUnder(r1).filter((f) => readFileSync(f).includes(TOKEN));
  const inResponses = JSON.stringify(log).includes(TOKEN) || logs1.includes(TOKEN);
  const stateLeak = filesUnder(join(WORK, "state"), new Set()).filter((f) => { try { return readFileSync(f).includes(TOKEN); } catch { return false; } });
  record("9 · secret isolation: the Twilio token is in no artifact file, no state file, no response and no log", !leaks.length && !inResponses && !stateLeak.length, { artifactFilesScanned: filesUnder(r1).length, artifactLeaks: leaks, stateLeaks: stateLeak, inResponsesOrLogs: inResponses });

  // 10. A bad release, then rollback: r2's voice component fails to start (e.g. a broken dependency at run time).
  const r2 = join(WORK, "releases", "r2");
  cpSync(r1, r2, { recursive: true, filter: (src) => !src.includes(`${r1}/node_modules`) });
  writeFileSync(join(r2, ".feltkit/build/components/voice.mjs"), 'throw new Error("simulated bad release: the voice component cannot start");\n');
  sh("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], r2);
  run = await start(r2, { ...secretEnv, FELTKIT_DEPLOYMENT_REVISION: "r2" });
  h = await health();
  const uiBad = await fetch(`${URL_}/`);
  const hookBad = await twilio("/twilio/sms", { MessageSid: "SM00000000000000000000000000000002", From: CALLER, To: NUMBER, Body: "during bad release", NumMedia: "0" });
  record("10a · bad release r2: UI 200 but health 503 \"unhealthy\", voice component failed, its routes 503", uiBad.status === 200 && h.http === 503 && h.status === "unhealthy" && h.components.voice.state === "failed" && hookBad.status === 503, { ui: uiBad.status, health: { http: h.http, status: h.status, voice: h.components.voice }, webhook: hookBad.status });
  await stop(run);
  run = await start(r1, { ...secretEnv, FELTKIT_DEPLOYMENT_REVISION: "r1-rollback" });
  h = await health();
  const d2 = await deployment();
  const signedAgain = await twilio("/twilio/sms", { MessageSid: "SM00000000000000000000000000000003", From: CALLER, To: NUMBER, Body: "after rollback", NumMedia: "0" });
  const still = await client.query({ name: "conversations:list", kind: "query" }, {}).catch((e) => ({ error: e.message }));
  record("10b · rollback to r1 on the same state: 200 ready, r1's component digest, data kept, webhooks processed", h.http === 200 && h.status === "ready" && d2.components?.voice?.sha256 === voice.sha256 && Array.isArray(still) && still.length === 1 && signedAgain.status === 200, { health: h.status, revision: d2.deployment.revision, componentSha256: d2.components?.voice?.sha256, conversations: Array.isArray(still) ? still.length : still, webhook: signedAgain.status });
  await stop(run);

  const passed = log.every((l) => l.ok);
  const md = `# Deployment evidence

Generated by \`node scripts/deployment-evidence.mjs\` on ${new Date().toISOString()}, on a development machine
(no access to the shared Hetzner host from this session; see docs/GAPS.md). Every step runs the real
\`feltkit deploy\` artifact, installed and started as its DEPLOY.md says, probed over HTTP and WebSocket
from outside the process. Twilio is not contacted: webhooks and the WebSocket handshake are signed exactly as
Twilio signs them, with the configured token, for the configured public URL (${PUBLIC}).

**Result: ${passed ? "all checks passed" : "FAILED"}** (${log.filter((l) => l.ok).length}/${log.length})

${log.map((l) => `## ${l.ok ? "✓" : "✗"} ${l.step}\n\n\`\`\`json\n${JSON.stringify(l.detail, null, 2).replaceAll(TOKEN, "<token>")}\n\`\`\``).join("\n\n")}
`;
  writeFileSync(join(ROOT, "docs/DEPLOYMENT-EVIDENCE.md"), md);
  console.log(`\n${passed ? "All checks passed" : "FAILED"} → docs/DEPLOYMENT-EVIDENCE.md`);
  process.exitCode = passed ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
