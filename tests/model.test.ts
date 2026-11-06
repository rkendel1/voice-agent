/**
 * Model-driven agents, against a local OpenAI-compatible streaming server selected the supported way
 * (FeltKit's model selection, as Studio → Models and `feltkit model set` do).
 */
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { test } from "node:test";
import { api } from "../feltkit/_generated/api.js";
import { ADA, call, setup, until } from "./helpers.js";

type Turn = (body: any, res: ServerResponse) => Promise<void> | void;

async function fakeModel(turns: Turn[]) {
  const requests: any[] = [];
  let aborted = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    requests.push(body);
    res.on("close", () => { if (!res.writableEnded) aborted++; });
    res.writeHead(200, { "content-type": "text/event-stream" });
    await (turns[requests.length - 1] ?? turns.at(-1)!)(body, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`, requests, aborted: () => aborted, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}
const chunk = (res: ServerResponse, delta: unknown) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
const done = (res: ServerResponse) => res.end("data: [DONE]\n\n");
const say = (text: string): Turn => (_b, res) => { chunk(res, { content: text }); done(res); };

async function useModel(s: Awaited<ReturnType<typeof setup>>, endpoint: string, capabilities?: string[]) {
  await (s.t.runtime as any).models.select({ provider: "ollama", model: "fake-voice-1", endpoint }, ADA);
  const [agent] = await s.ada.query(api.agents.list, {});
  const { id, name, purpose, instructions, greeting, voice, temperature, escalateTo, schedule, smsAutoReply } = agent as any;
  await s.ada.mutation(api.agents.save, { id, name, purpose, instructions, greeting, voice, temperature, ...(escalateTo ? { escalateTo } : {}), schedule, smsAutoReply, active: true, brain: "environment", capabilities: (capabilities ?? agent!.capabilities) as any });
  return agent!.id;
}

test("the model asks for a capability its agent lacks: the policy refuses it, the refusal is recorded, the agent says so", async () => {
  const model = await fakeModel([
    (_b, res) => { chunk(res, { tool_calls: [{ index: 0, id: "call_1", function: { name: "appointments_book", arguments: "" } }] }); chunk(res, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ slot: "2030-01-07T10:00" }) } }] }); done(res); },
    say("I'm sorry, I'm not able to book appointments, but I can take a message."),
  ]);
  const s = await setup();
  try {
    await useModel(s, model.endpoint, ["business.info", "followups.create"]);
    const { phone } = await call(s.rt);
    await phone!.utterances(2);
    const answer = await phone!.ask("Book me in for Monday at ten");
    assert.match(answer, /not able to book/);
    const toolResult = model.requests[1].messages.find((m: any) => m.role === "tool");
    assert.match(toolResult.content, /"ok":false/);
    assert.match(toolResult.content, /Not permitted/);
    const [live] = await s.ada.query(api.calls.live, {});
    const c = await s.ada.query(api.calls.get, { id: live!.id });
    assert.deepEqual(c.actions.map((a: any) => [a.capability, a.decision, a.status]), [["appointments.book", "denied", "denied"]]);
    assert.equal((await s.ada.query(api.appointments.list, {})).length, 0);
    assert.ok(model.requests[0].tools.every((t: any) => t.function.name !== "appointments_book"), "the model is only offered granted tools");
    assert.match(model.requests[0].messages[0].content, /Only say an action happened/);
    phone!.hangup();
  } finally { await s.close(); await model.close(); }
});

test("barge-in: the caller interrupts a streaming answer; generation is aborted and only what was heard is recorded", async () => {
  const model = await fakeModel([
    async (_b, res) => {
      for (const w of "We are open Monday through Friday from eight in the morning until six in the evening and on Saturdays".split(" ")) {
        if (res.destroyed) return;
        chunk(res, { content: `${w} ` });
        await new Promise((r) => setTimeout(r, 60));
      }
      done(res);
    },
    say("Sure, what time works for you?"),
  ]);
  const s = await setup();
  try {
    await useModel(s, model.endpoint);
    const { phone } = await call(s.rt);
    await phone!.utterances(2);
    phone!.say("When are you open?");
    await new Promise((r) => setTimeout(r, 300));
    phone!.interrupt("We are open Monday");
    const next = await phone!.ask("Actually, can I just book something?");
    assert.equal(next, "Sure, what time works for you?");
    await until(async () => model.aborted(), (n) => n >= 1);
    const [live] = await s.ada.query(api.calls.live, {});
    const t = (await s.ada.query(api.calls.get, { id: live!.id })).transcript;
    const cut = t.find((x: any) => x.interrupted);
    assert.equal(cut?.text, "We are open Monday");
    // The model's memory holds only what the caller heard.
    const history = model.requests[1].messages;
    assert.ok(history.some((m: any) => m.role === "assistant" && /We are open Monday…/.test(m.content)), JSON.stringify(history));
    assert.ok(!history.some((m: any) => /Saturdays/.test(m.content ?? "")));
    phone!.hangup();
  } finally { await s.close(); await model.close(); }
});

test("an agent set to the environment model with no model configured: the scripted agent answers and Setup says why", async () => {
  const s = await setup();
  try {
    const [agent] = await s.ada.query(api.agents.list, {});
    const { id, name, purpose, instructions, greeting, voice, temperature, escalateTo, schedule, smsAutoReply, capabilities } = agent as any;
    await s.ada.mutation(api.agents.save, { id, name, purpose, instructions, greeting, voice, temperature, ...(escalateTo ? { escalateTo } : {}), schedule, smsAutoReply, capabilities, active: true, brain: "environment" });
    const { phone } = await call(s.rt);
    await phone!.utterances(2);
    assert.match(await phone!.ask("what are your hours"), /hours are/);
    await s.rt.refresh();
    await s.rt.heartbeat();
    const setupState = await s.ada.query(api.business.setup, {});
    assert.ok(setupState.runtime!.problems.some((p: string) => /Studio → Models/.test(p)), JSON.stringify(setupState.runtime));
    phone!.hangup();
  } finally { await s.close(); }
});
