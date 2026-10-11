// Server: API REST + eventi in tempo reale (SSE) + scheduler degli agenti.
import express from "express";
import { loadRooms, loadAgents, normalize, validate, saveAgent, deleteAgent, ALL_TOOLS } from "./lib/config.js";
import { runAgent, isRunning } from "./lib/runner.js";
import { getState, resetState, bus } from "./lib/store.js";
import { portfolioValue } from "./lib/broker.js";
import { getQuote } from "./lib/market.js";
import fs from "node:fs";

const PORT = Number(process.env.PORT ?? 3000);
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

let rooms = loadRooms();
let agents = loadAgents();
const lastRun = new Map();

function reload() {
  rooms = loadRooms();
  agents = loadAgents();
  bus.emit("event", { type: "config" });
}

const findAgent = (id) => agents.find((a) => a.id === id);

app.get("/api/office", (_req, res) => {
  res.json({
    rooms,
    agents: agents.map((a) => ({ ...a, running: isRunning(a.id), lastRun: lastRun.get(a.id) ?? null })),
    tools: ALL_TOOLS,
    strategies: fs.readdirSync("strategies").filter((f) => f.endsWith(".js") && !f.startsWith("_")).map((f) => f.slice(0, -3)),
    llmReady: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  });
});

app.get("/api/notes", (_req, res) => res.json(getState().notes));
app.get("/api/log", (_req, res) => res.json(getState().log));
app.get("/api/portfolio", async (_req, res, next) => {
  try { res.json(await portfolioValue()); } catch (e) { next(e); }
});
app.get("/api/quote/:symbol", async (req, res, next) => {
  try { res.json(await getQuote(req.params.symbol)); } catch (e) { next(e); }
});

app.post("/api/agents/:id/run", async (req, res) => {
  const agent = findAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "agente non trovato" });
  if (isRunning(agent.id)) return res.status(409).json({ error: "già in esecuzione" });
  lastRun.set(agent.id, new Date().toISOString());
  // Risponde subito: l'avanzamento arriva via SSE.
  runAgent(agent, rooms, { task: req.body?.task }).catch(() => {});
  res.json({ ok: true });
});

app.put("/api/agents/:id", (req, res) => {
  const agent = normalize({ ...req.body, id: req.params.id });
  const errors = validate(agent, rooms);
  if (errors.length) return res.status(400).json({ errors });
  saveAgent(agent);
  reload();
  res.json(agent);
});

app.delete("/api/agents/:id", (req, res) => {
  deleteAgent(req.params.id);
  reload();
  res.json({ ok: true });
});

app.post("/api/reset", (_req, res) => {
  resetState();
  res.json({ ok: true });
});

app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  bus.on("event", send);
  req.on("close", () => {
    clearInterval(ping);
    bus.off("event", send);
  });
});

app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

// Scheduler: ogni minuto avvia gli agenti con everyMinutes > 0 che sono "scaduti".
setInterval(() => {
  const now = Date.now();
  for (const agent of agents) {
    if (!agent.enabled || !(agent.everyMinutes > 0) || isRunning(agent.id)) continue;
    const prev = lastRun.has(agent.id) ? Date.parse(lastRun.get(agent.id)) : 0;
    if (now - prev >= agent.everyMinutes * 60_000) {
      lastRun.set(agent.id, new Date().toISOString());
      runAgent(agent, rooms).catch(() => {});
    }
  }
}, 60_000);

app.listen(PORT, () => {
  console.log(`Ufficio agenti attivo su http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.log("Nota: senza ANTHROPIC_API_KEY funzionano solo gli agenti in modalità \"rule\".");
  }
});
