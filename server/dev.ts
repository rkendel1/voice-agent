/**
 * `npm run dev`: FeltKit's development server (exactly what `feltkit dev` runs: runtime, Vite frontend,
 * Studio, hot reload) plus the voice runtime in the same process, on the next port.
 *
 * Why not plain `feltkit dev`: FeltKit 0.3.18 serves only its own routes, answers only requests
 * addressed to localhost in development, and has no WebSocket surface for applications. Telephony
 * needs public, provider-signed webhooks and a WebSocket per call. See docs/GAPS.md (G1).
 */
import { startDev } from "@feltdb/feltkit/server";
import { VoiceRuntime } from "../gateway/runtime.js";

const port = Number(process.env.PORT ?? 3000);
const voicePort = Number(process.env.VOICE_PORT ?? port + 1);
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const dev = await startDev({
  projectDir: process.cwd(),
  port,
  onReload: ({ ok, error }) => console.log(ok ? dim(`✓ ${new Date().toLocaleTimeString()} Reloaded functions (state and sessions kept)`) : `✗ Reload failed; still serving the previous version.\n    ${error?.message}`),
  logger: { info: (m) => console.log(dim(m)), warn: (m) => console.log(`warn ${m}`), error: (m) => console.log(`error ${m}`) },
});
const voice = await new VoiceRuntime({ runtime: dev.runtime, port: voicePort, host: process.env.VOICE_HOST ?? "127.0.0.1", appOrigin: dev.server.url, production: false }).start();

console.log("");
console.log(`  ${bold("App")}        ${dev.server.url}`);
if (dev.server.dashboardUrl) console.log(`  ${bold("Dashboard")}  ${dev.server.dashboardUrl}  ${dim("(FeltKit Studio)")}`);
console.log(`  ${bold("AppPort")}    ${dev.server.url}/appport`);
console.log(`  ${bold("Voice")}      ${voice.url}  ${dim(`(provider: ${voice.settings.provider}${voice.problems.length ? `; ${voice.problems.length} problem(s), see Setup` : ""})`)}`);
console.log(`  ${bold("Webhooks")}   ${dim(`${voice.settings.publicBaseUrl ?? "<PUBLIC_BASE_URL>"}/twilio/{sms,voice,call-status}`)}`);
console.log(dim(`\n  Edit feltkit/*.ts to reload. Ctrl+C to stop.\n`));

const stop = async () => { await voice.close().catch(() => {}); await dev.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
