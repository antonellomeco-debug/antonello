// Universo con più palazzi: Orion crea un palazzo e i suoi piani con i suoi strumenti, riceve lo stato diviso per
// palazzi, e gli agenti sanno in quale palazzo lavorano. Un finto server dell'API di Claude risponde come quello vero.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const requests = [];
let replies = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    requests.push(JSON.parse(body || "{}"));
    const reply = replies.shift() ?? { content: [{ type: "text", text: "fine" }], stop_reason: "end_turn" };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: `msg_${requests.length}`, type: "message", role: "assistant", model: "claude-opus-5-5", usage: { input_tokens: 100, output_tokens: 20 }, ...reply }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

Object.assign(process.env, {
  AGENTI_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "universe-test-")),
  MARKET_MODE: "demo",
  ANTHROPIC_API_KEY: "sk-ant-test-0000000000000000000000",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
});
const { office } = await import("../lib/office.js");
const { chat } = await import("../lib/orchestrator.js");
const { runAgent } = await import("../lib/runner.js");
const { normalize } = await import("../lib/config.js");

const toolUse = (id, name, input) => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
const done = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });

test("prima installazione: un universo con il Palazzo Investimenti", () => {
  const b = office.building();
  assert.equal(b.name, "Il mio universo");
  assert.deepEqual(b.palaces.map((p) => p.name), ["Palazzo Investimenti"]);
  assert.ok(b.floors.every((f) => f.palace === "palazzo-investimenti"));
});

test("Orion crea un palazzo, un piano dentro, e lo collega al palazzo degli investimenti", async () => {
  requests.length = 0;
  replies = [
    toolUse("t1", "save_palace", { name: "Palazzo Social", description: "Tendenze pubbliche sui social" }),
    toolUse("t2", "save_floor", { palace: "palazzo-social", name: "Piano Tendenze", sector: "Instagram e TikTok" }),
    toolUse("t3", "save_room", { floor: "piano-tendenze", name: "Sala Trend" }),
    toolUse("t4", "set_link", { from: "piano-tendenze", to: "piano-terra", direction: "one-way", active: true }),
    done("Ho creato il Palazzo Social."),
  ];
  const reply = await chat(office, "Crea un palazzo per i social collegato alla direzione");
  assert.equal(reply, "Ho creato il Palazzo Social.");
  const b = office.building();
  assert.deepEqual(b.palaces.map((p) => p.id), ["palazzo-investimenti", "palazzo-social"]);
  const floor = b.floors.find((f) => f.id === "piano-tendenze");
  assert.equal(floor.palace, "palazzo-social");
  assert.equal(floor.level, 0, "primo piano del palazzo nuovo");
  assert.ok(b.links.some((l) => l.from === "piano-tendenze" && l.to === "piano-terra"));
  // Gli strumenti dei palazzi ci sono, e lo stato arriva diviso per palazzo.
  const tools = requests[0].tools.map((t) => t.name);
  assert.ok(tools.includes("save_palace") && tools.includes("delete_palace"));
  const snapshot = requests[0].messages.find((m) => m.role === "system")?.content ?? "";
  assert.match(snapshot, /^Stato attuale dell'universo "Il mio universo"/);
  assert.match(snapshot, /Palazzo Palazzo Investimenti \[palazzo-investimenti\]/);
  assert.match(requests[0].system, /universo virtuale/);
  // Dopo le modifiche, il nuovo stato mostra il palazzo nuovo e il collegamento tra palazzi.
  replies = [done("ok")];
  requests.length = 0;
  await chat(office, "Com'è fatto l'universo adesso?");
  const latest = requests[0].messages.filter((m) => m.role === "system").at(-1).content;
  assert.match(latest, /Palazzo Palazzo Social \[palazzo-social\] — Tendenze pubbliche sui social:\n  - Piano Tendenze \[piano-tendenze\]/);
  assert.match(latest, /Piano Tendenze \(Palazzo Social\) → Piano Terra · Direzione \(Palazzo Investimenti\)/);
});

test("Orion non può eliminare un palazzo con piani dentro", async () => {
  requests.length = 0;
  replies = [toolUse("t1", "delete_palace", { id: "palazzo-social" }), done("Non posso: ha ancora piani.")];
  await chat(office, "Elimina il palazzo social");
  const result = requests[1].messages.at(-1).content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /ancora un piano \(Piano Tendenze\)/);
  assert.ok(office.building().palaces.some((p) => p.id === "palazzo-social"));
});

test("un agente sa in quale palazzo lavora e da quale palazzo vengono le stanze collegate", async () => {
  const agent = office.saveAgent(normalize({ id: "trend", name: "Trend", room: "sala-trend", mode: "llm", instructions: "Segui le tendenze.", tools: ["post_note"], model: "claude-haiku-5-5" }));
  requests.length = 0;
  replies = [done("fatto")];
  await runAgent(agent, office.building());
  assert.match(requests[0].system, /del palazzo "Palazzo Social" \(Tendenze pubbliche sui social\), in un universo virtuale/);
  const cio = office.agents().find((a) => a.room === "direzione");
  if (cio?.mode === "llm") {
    requests.length = 0;
    replies = [done("fatto")];
    await runAgent(cio, office.building());
    assert.match(requests[0].system, /sala-trend: Sala Trend \(Piano Tendenze, palazzo Palazzo Social\)/);
  }
});
