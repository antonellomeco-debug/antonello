// Server: API REST + eventi in tempo reale (SSE) + scheduler degli agenti.
import express from "express";
import { ALL_TOOLS, ID_PATTERN } from "./lib/config.js";
import { office } from "./lib/office.js";
import { PUBLIC_DIR, STRATEGIES_DIR, ROOT } from "./lib/paths.js";
import path from "node:path";
import { runAgent, isRunning } from "./lib/runner.js";
import { getState, resetState, bus } from "./lib/store.js";
import { portfolioValue, decide } from "./lib/broker.js";
import { chat, getTranscript, resetChat, ASSISTANT_NAME } from "./lib/orchestrator.js";
import { getQuote } from "./lib/market.js";
import fs from "node:fs";
import { exec } from "node:child_process";
import { hasCredentials, keyStatus, verifyKey, cleanKey } from "./lib/claude.js";
import { updateSettings } from "./lib/settings.js";
import { checkUpdate, applyUpdate } from "./lib/updater.js";

const STARTED_AT = new Date().toISOString();

const PORT = Number(process.env.PORT ?? 3000);
// Solo questo computer può aprire l'app (HOST=0.0.0.0 per renderla visibile in rete locale).
const HOST = process.env.HOST ?? "127.0.0.1";
const URL_APP = `http://localhost:${PORT}`;
const app = express();

// Protezione dai siti web aperti nello stesso browser:
// - DNS rebinding: con l'indirizzo locale accettiamo solo richieste rivolte a localhost/127.0.0.1;
// - CSRF: le richieste che modificano qualcosa devono arrivare da questa stessa pagina.
const LOOPBACK = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
app.use((req, res, next) => {
  const host = req.headers.host ?? "";
  if (LOOPBACK && !LOCAL_HOSTS.has(host)) return res.status(403).send("Accesso consentito solo da questo computer.");
  const origin = req.get("origin");
  if (req.method !== "GET" && req.method !== "HEAD" && origin && origin.replace(/^https?:\/\//, "") !== host) {
    return res.status(403).json({ error: "Richiesta da un altro sito bloccata." });
  }
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));
app.use("/vendor/three", express.static(path.join(ROOT, "node_modules", "three")));

const lastRun = new Map();
const findAgent = (id) => office.agents().find((a) => a.id === id);

app.get("/api/office", (_req, res) => {
  const building = office.building();
  res.json({
    building,
    rooms: building.rooms,
    agents: office.agents().map((a) => ({ ...a, running: isRunning(a.id), lastRun: lastRun.get(a.id) ?? null })),
    tools: ALL_TOOLS,
    strategies: fs.readdirSync(STRATEGIES_DIR).filter((f) => f.endsWith(".js") && !f.startsWith("_")).map((f) => f.slice(0, -3)),
    llmReady: hasCredentials(),
    assistant: ASSISTANT_NAME,
  });
});

app.get("/api/settings", (_req, res) => res.json(keyStatus()));
app.put("/api/settings", async (req, res) => {
  const key = cleanKey(req.body?.anthropicApiKey);
  if (!key) return res.status(400).json({ error: "Incolla la chiave prima di salvare." });
  if (!/^[\x21-\x7E]+$/.test(key) || key.length < 20) return res.status(400).json({ error: "La chiave sembra incompleta: deve essere un'unica riga che inizia con sk-ant-." });
  const check = await verifyKey(key);
  if (!check.ok) return res.status(400).json({ error: check.error });
  updateSettings({ anthropicApiKey: key });
  bus.emit("event", { type: "config" });
  res.json(keyStatus());
});
app.delete("/api/settings", (_req, res) => {
  updateSettings({ anthropicApiKey: null });
  bus.emit("event", { type: "config" });
  res.json(keyStatus());
});

// ---------- aggiornamenti ----------
app.get("/api/version", (_req, res) => res.json({ startedAt: STARTED_AT }));
app.get("/api/update", async (_req, res) => {
  try {
    res.json(await checkUpdate());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
app.post("/api/update", async (_req, res) => {
  try {
    const busy = office.agents().some((a) => isRunning(a.id));
    res.json(await applyUpdate({ busy }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/notes", (_req, res) => res.json(getState().notes));
app.get("/api/log", (_req, res) => res.json(getState().log));
app.get("/api/portfolio", async (_req, res, next) => {
  try { res.json(await portfolioValue()); } catch (e) { next(e); }
});
app.get("/api/quote/:symbol", async (req, res, next) => {
  try { res.json(await getQuote(req.params.symbol)); } catch (e) { next(e); }
});

app.get("/api/stats", (_req, res) => {
  const st = getState();
  const notes = Object.values(st.notes).flat();
  res.json({
    working: office.agents().filter((a) => isRunning(a.id)).length,
    agents: office.agents().length,
    floors: office.building().floors.length,
    rooms: office.building().rooms.length,
    scheduled: office.agents().filter((a) => a.enabled && a.everyMinutes > 0).length,
    notes: notes.length,
    trades: st.portfolio.trades.length,
    pending: st.approvals.filter((a) => a.status === "pending").length,
    costUsd: st.usage.costUsd,
    tokens: st.usage.inputTokens + st.usage.outputTokens,
  });
});

app.get("/api/approvals", (_req, res) => res.json(getState().approvals.slice().reverse()));
app.post("/api/approvals/:id", async (req, res) => {
  try {
    res.json(await decide(req.params.id, Boolean(req.body?.approve)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const chatCtx = office;
app.get("/api/chat", (_req, res) => res.json(getTranscript()));
app.post("/api/chat", async (req, res) => {
  const text = String(req.body?.message ?? "").trim();
  if (!text) return res.status(400).json({ error: "messaggio vuoto" });
  try {
    res.json({ reply: await chat(chatCtx, text) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post("/api/chat/reset", (_req, res) => {
  resetChat();
  res.json({ ok: true });
});

app.post("/api/agents/:id/run", async (req, res) => {
  const agent = findAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "agente non trovato" });
  if (isRunning(agent.id)) return res.status(409).json({ error: "già in esecuzione" });
  lastRun.set(agent.id, new Date().toISOString());
  // Risponde subito: l'avanzamento arriva via SSE.
  runAgent(agent, office.building(), { task: req.body?.task }).catch(() => {});
  res.json({ ok: true });
});

// Esegue una modifica e risponde con il risultato, oppure con l'errore spiegato (400).
const handle = (fn) => (req, res) => {
  try {
    res.json(fn(req) ?? { ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message, errors: e.errors ?? [e.message] });
  }
};

app.post("/api/agents", handle((req) => office.saveAgent({ ...req.body, id: undefined })));
app.put("/api/agents/:id", handle((req) => office.saveAgent({ ...req.body, id: req.params.id })));
app.delete(
  "/api/agents/:id",
  handle((req) => {
    if (!ID_PATTERN.test(req.params.id)) throw new Error("id non valido");
    office.deleteAgent(req.params.id);
  }),
);

// ---------- palazzo: piani, stanze, collegamenti ----------
app.put("/api/building", handle((req) => office.renameBuilding(req.body?.name)));
app.post("/api/floors", handle((req) => office.saveFloor({ ...req.body, id: undefined })));
app.put("/api/floors/:id", handle((req) => office.saveFloor({ ...req.body, id: req.params.id })));
app.delete("/api/floors/:id", handle((req) => office.deleteFloor(req.params.id)));
app.post("/api/rooms", handle((req) => office.saveRoom({ ...req.body, id: undefined })));
app.put("/api/rooms/:id", handle((req) => office.saveRoom({ ...req.body, id: req.params.id })));
app.delete("/api/rooms/:id", handle((req) => office.deleteRoom(req.params.id)));
app.put("/api/links", handle((req) => office.setLink(req.body ?? {})));
app.delete("/api/links", handle((req) => office.deleteLink(String(req.query.from ?? ""), String(req.query.to ?? ""))));

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
  for (const agent of office.agents()) {
    if (!agent.enabled || !(agent.everyMinutes > 0) || isRunning(agent.id)) continue;
    const prev = lastRun.has(agent.id) ? Date.parse(lastRun.get(agent.id)) : 0;
    if (now - prev >= agent.everyMinutes * 60_000) {
      lastRun.set(agent.id, new Date().toISOString());
      runAgent(agent, office.building()).catch(() => {});
    }
  }
}, 60_000);

function openBrowser() {
  if (process.env.OPEN_BROWSER === "0") return;
  const cmd = process.platform === "darwin" ? `open ${URL_APP}` : process.platform === "win32" ? `start "" ${URL_APP}` : null;
  if (cmd) exec(cmd, () => {});
}

// Express 5 passa anche l'eventuale errore di avvio (es. porta occupata) a questa callback.
app.listen(PORT, HOST, (err) => {
  if (err) return onListenError(err);
  console.log("");
  console.log("  ✅ Ufficio agenti avviato!");
  console.log(`  👉 Apri nel browser: ${URL_APP}`);
  console.log("");
  console.log("  Lascia aperta questa finestra finché usi il programma.");
  console.log("  Per chiuderlo: premi control + C oppure chiudi la finestra.");
  if (!hasCredentials()) console.log("  (La chiave di Claude si inserisce dall'app: ⚙️ Impostazioni.)");
  console.log("");
  openBrowser();
});

function onListenError(err) {
  if (err.code === "EADDRINUSE") {
    console.log(`\n  ℹ️  Il programma è già aperto (porta ${PORT} occupata). Apro il browser su ${URL_APP}\n`);
    openBrowser();
    setTimeout(() => process.exit(0), 500);
  } else {
    console.error(err);
    process.exit(1);
  }
}
