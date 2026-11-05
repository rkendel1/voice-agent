/**
 * `npm start`: FeltKit's production server (what `feltkit start` runs, on the build from
 * `npm run build`) plus the voice runtime. Twilio must reach the voice port over https at
 * PUBLIC_BASE_URL (put a TLS proxy in front of it); the app port serves people and Studio.
 */
import { startProduction } from "@feltdb/feltkit/server";
import { VoiceRuntime } from "../gateway/runtime.js";

const port = Number(process.env.PORT ?? 3000);
const voicePort = Number(process.env.VOICE_PORT ?? port + 1);
const host = process.env.HOST ?? "0.0.0.0";

const prod: any = await startProduction({ projectDir: process.cwd(), port, host });
const voice = await new VoiceRuntime({ runtime: prod.runtime, port: voicePort, host, production: true }).start();
console.log(`App ${prod.server?.url ?? `:${port}`} · Voice ${voice.url} (provider ${voice.settings.provider}${voice.problems.length ? `; problems: ${voice.problems.join(" ")}` : ""})`);

const stop = async () => { await voice.close().catch(() => {}); await prod.close?.(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
