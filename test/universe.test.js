// Universo con più palazzi: Orion crea un palazzo e i suoi piani con i suoi strumenti, riceve lo stato diviso per
// palazzi, e gli agenti sanno in quale palazzo lavorano. Un finto server dell'API di Claude risponde come quello vero.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { sendClaudeMessage } from "./helpers/claude-reply.js";

const requests = [];
let replies = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    requests.push(JSON.parse(body || "{}"));
    const reply = replies.shift() ?? { content: [{ type: "text", text: "fine" }], stop_reason: "end_turn" };
    sendClaudeMessage(res, { id: `msg_${requests.length}`, type: "message", role: "assistant", model: "claude-opus-5-5", usage: { input_tokens: 100, output_tokens: 20 }, ...reply }, requests.at(-1));
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
  assert.match(requests[0].system.map((b) => b.text).join(""), /universo virtuale/);
  assert.equal(requests[0].stream, true, "Orion risponde in diretta");
  assert.equal(requests[0].system[0].cache_control.ttl, "1h");
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

test("Orion: velocità scelta nelle impostazioni (modello e impegno) e testo in diretta", async () => {
  const { setSpeed, getSpeed } = await import("../lib/orchestrator.js");
  const { bus } = await import("../lib/store.js");
  assert.equal(getSpeed(), "veloce");
  const deltas = [];
  const on = (ev) => ev.type === "chat-delta" && ev.delta && deltas.push(ev.delta);
  bus.on("event", on);
  requests.length = 0;
  replies = [done("Ecco come sta andando l'universo oggi.")];
  await chat(office, "Ciao");
  bus.off("event", on);
  assert.equal(requests[0].model, "claude-sonnet-5-5");
  assert.equal(requests[0].output_config.effort, "low");
  assert.equal(deltas.join(""), "Ecco come sta andando l'universo oggi.", "il testo arriva a pezzi mentre Orion scrive");
  setSpeed("accurato");
  requests.length = 0;
  replies = [done("ok")];
  await chat(office, "Ciao di nuovo");
  assert.equal(requests[0].model, "claude-opus-5-5");
  assert.equal(requests[0].output_config.effort, "medium");
  assert.throws(() => setSpeed("turbo"), /Velocità/);
  setSpeed("veloce");
});

test("Orion risparmia: elenco breve degli agenti, istruzioni intere solo a richiesta, modifiche solo dei campi cambiati", async () => {
  const long = "Scrivi post per X sul brand. ".repeat(60);
  office.saveAgent(normalize({ id: "copy_x", name: "Copy X", room: "sala-trend", mode: "llm", instructions: long, tools: ["post_note"], model: "claude-sonnet-5-5", limits: { maxOrderPct: 5 } }));
  requests.length = 0;
  replies = [
    toolUse("t1", "list_agents", { palace: "palazzo-social" }),
    toolUse("t2", "get_agents", { ids: ["copy_x", "nessuno"] }),
    toolUse("t3", "save_agent", { agent: { id: "copy_x", model: "claude-haiku-5-5", limits: { requireApproval: false } } }),
    done("Fatto."),
  ];
  await chat(office, "Passa Copy X a Haiku");
  const result = (i) => JSON.parse(requests[i].messages.at(-1).content[0].content);
  const list = result(1);
  assert.ok(list.agents.every((a) => ["sala-trend"].includes(a.room)), "solo gli agenti del palazzo chiesto");
  const brief = list.agents.find((a) => a.id === "copy_x");
  assert.ok(brief.instructions.length < 260 && /get_agents/.test(brief.instructions), "le istruzioni lunghe arrivano accorciate");
  const full = result(2);
  assert.equal(full[0].instructions, long);
  assert.equal(full[1].error, "agente inesistente");
  const saved = office.agents().find((a) => a.id === "copy_x");
  assert.equal(saved.model, "claude-haiku-5-5");
  assert.equal(saved.instructions, long, "le istruzioni restano quelle di prima");
  assert.deepEqual([saved.limits.maxOrderPct, saved.limits.requireApproval], [5, false], "limits si unisce a quelli attuali");
  assert.ok(result(3).saved.instructions.length < 260, "dopo il salvataggio Orion non rilegge tutto l'agente");
});
