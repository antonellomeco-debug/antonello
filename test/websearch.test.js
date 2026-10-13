// Ricerca web (strumento eseguito dai server di Claude): definizione, ripresa dopo "pause_turn", costo,
// agenti e Orion. Un finto server dell'API di Claude risponde come quello vero.
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
    requests.push({ url: req.url, beta: req.headers["anthropic-beta"], body: JSON.parse(body || "{}") });
    const reply = replies.shift() ?? { content: [{ type: "text", text: "fine" }], stop_reason: "end_turn" };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: `msg_${requests.length}`,
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      usage: { input_tokens: 100, output_tokens: 20 },
      ...reply,
    }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

Object.assign(process.env, {
  AGENTI_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "websearch-test-")),
  MARKET_MODE: "demo",
  ANTHROPIC_API_KEY: "sk-ant-test-0000000000000000000000",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
});
const { normalize, validate, ALL_TOOLS } = await import("../lib/config.js");
const { toolsFor, WEB_SEARCH_TOOL } = await import("../lib/tools.js");
const { runAgent } = await import("../lib/runner.js");
const { office } = await import("../lib/office.js");
const { getState } = await import("../lib/store.js");
const { chat } = await import("../lib/orchestrator.js");
const { friendlyError, responseText } = await import("../lib/claude.js");
const Anthropic = (await import("@anthropic-ai/sdk")).default;

// Prima risposta: la ricerca è partita ma il giro sul server si è fermato (pause_turn).
const paused = {
  content: [
    { type: "text", text: "Cerco le ultime notizie sull'oro." },
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "gold price news today" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: [{ type: "web_search_result", url: "https://example.com/oro", title: "Oro in rialzo", encrypted_content: "ENC123", page_age: "October 13, 2026" }],
    },
  ],
  stop_reason: "pause_turn",
  usage: { input_tokens: 100, output_tokens: 20, server_tool_use: { web_search_requests: 1 } },
};
const done = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 300, output_tokens: 30 } });
// Risposta finale con una citazione: la frase arriva divisa in tre blocchi di testo.
const cited = {
  content: [
    { type: "text", text: "Oro in rialzo " },
    {
      type: "text",
      text: "per il dollaro debole",
      citations: [{ type: "web_search_result_location", url: "https://example.com/oro", title: "Oro in rialzo", encrypted_index: "EI1", cited_text: "Il dollaro scende" }],
    },
    { type: "text", text: "." },
  ],
  stop_reason: "end_turn",
  usage: { input_tokens: 300, output_tokens: 30 },
};

const newsAgent = normalize({
  id: "notizie_test", name: "Notizie", room: "ricerca", mode: "llm", instructions: "Cerca le notizie sull'oro.",
  tools: ["web_search", "post_note"], model: "claude-haiku-5-5",
});

test("web_search è uno strumento degli agenti eseguito dai server di Claude", () => {
  assert.ok(ALL_TOOLS.includes("web_search"));
  assert.deepEqual(validate(newsAgent, office.building().rooms), []);
  const tools = toolsFor(newsAgent);
  assert.deepEqual(tools.at(-1), { type: "web_search_20250305", name: "web_search", max_uses: 5 });
  assert.equal(tools.find((t) => t.name === "web_search").input_schema, undefined); // niente schema: lo definisce Anthropic
  assert.equal(toolsFor(normalize({ id: "x", room: "ricerca", tools: ["post_note"] })).some((t) => t.name === "web_search"), false);
  assert.deepEqual(WEB_SEARCH_TOOL, { type: "web_search_20250305", name: "web_search", max_uses: 5 });
});

test("agente: dopo pause_turn riprende rimandando la conversazione così com'è", async () => {
  requests.length = 0;
  replies = [paused, cited];
  const costBefore = getState().usage.costUsd;
  const result = await runAgent(newsAgent, office.building());
  assert.equal(result, "Oro in rialzo per il dollaro debole."); // i pezzi con le citazioni si uniscono senza andare a capo
  assert.equal(requests.length, 2);
  assert.ok(requests[0].body.tools.some((t) => t.type === "web_search_20250305"));
  const second = requests[1].body.messages;
  assert.equal(second.length, 2); // messaggio iniziale + risposta in pausa, senza un "continua" aggiunto
  assert.equal(second[1].role, "assistant");
  assert.deepEqual(second[1].content, paused.content); // risultati cifrati rimandati identici
  assert.match(second[0].content, /^Esegui il tuo lavoro ora\. Adesso è /);
  // la ricerca compare nel registro e nel costo stimato (10 $ ogni 1.000 ricerche)
  assert.ok(getState().log.some((e) => e.agentId === "notizie_test" && /web_search\(\{"query":"gold price news today"\}\)/.test(e.message)));
  assert.ok(getState().usage.costUsd - costBefore >= 0.01);
});

test("Orion: cerca sul web, riprende dopo pause_turn e riceve giorno e ora", async () => {
  requests.length = 0;
  replies = [paused, done("Oggi l'oro sale perché il dollaro è debole.")];
  const reply = await chat(office, "Che notizie ci sono sull'oro?");
  assert.equal(reply, "Oggi l'oro sale perché il dollaro è debole.");
  assert.equal(requests.length, 2);
  assert.ok(requests[0].body.tools.some((t) => t.type === "web_search_20250305" && t.name === "web_search"));
  const first = requests[0].body.messages.find((m) => m.role === "user");
  assert.match(first.content, /^\[Adesso è .+\]\nChe notizie ci sono sull'oro\?$/);
  const last = requests[1].body.messages.at(-1);
  assert.equal(last.role, "assistant");
  assert.deepEqual(last.content, paused.content);
});

test("testo della risposta: citazioni unite, parti separate da una ricerca con una riga vuota", () => {
  assert.equal(responseText([...paused.content, ...cited.content]), "Cerco le ultime notizie sull'oro.\n\nOro in rialzo per il dollaro debole.");
  assert.equal(responseText([{ type: "thinking", thinking: "..." }, { type: "text", text: " Ciao " }]), "Ciao");
  assert.equal(responseText([]), "");
});

test("ricerca web disattivata sull'account: messaggio chiaro", () => {
  const err = Anthropic.APIError.generate(400, { type: "error", error: { type: "invalid_request_error", message: "web search is not enabled for this organization" } }, "web search is not enabled for this organization", new Headers());
  assert.match(friendlyError(err), /ricerca web è disattivata/);
});
