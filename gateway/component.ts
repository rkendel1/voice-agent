/**
 * The voice runtime as a FeltKit runtime component (declared in feltkit/app.ts → components.voice).
 * FeltKit starts it with the application (`feltkit dev`, `feltkit start`, every deployment that runs
 * FeltKit), routes /twilio/* and /simulator/* (HTTP and WebSocket) on the application's port to it, and
 * reports its health in /_feltkit/health: the application is not ready while voice is not.
 */
import { defineComponent } from "@feltdb/feltkit/server";
import { VoiceRuntime } from "./runtime.js";

export default defineComponent(async (context) => {
  const voice = await new VoiceRuntime({ context, log: (line) => context.log.info(line) }).start();
  return {
    request: (req, res) => voice.request(req, res),
    upgrade: (req, socket, head) => voice.upgrade(req, socket as any, head),
    health: () => voice.health(),
    close: () => voice.close(),
  };
});
