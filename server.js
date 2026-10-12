// Server: API REST + eventi in tempo reale (SSE) + scheduler degli agenti.
import express from "express";
import { ALL_TOOLS, ID_PATTERN } from "./lib/config.js";
import { office } from "./lib/office.js";
import { PUBLIC_DIR, STRATEGIES_DIR, ROOT } from "./lib/paths.js";
import path from "node:path";
import { runAgent, isRunning } from "./lib/runner.js";
import { getState, resetState, bus, log } from "./lib/store.js";
import { portfolioValue, decide, monitorAccounts, settleInFlight, closeAllAgentPositions } from "./lib/broker.js";
import * as ctrader from "./lib/ctrader/service.js";
import { codeFromInput } from "./lib/ctrader/oauth.js";
import * as safety from "./lib/safety.js";
import { chat, getTranscript, resetChat, isChatBusy, ASSISTANT_NAME } from "./lib/orchestrator.js";
import { getQuote } from "./lib/market.js";
import fs from "node:fs";
import { exec } from "node:child_process";
import { hasCredentials, keyStatus, verifyKey, cleanKey } from "./lib/claude.js";
import { updateSettings } from "./lib/settings.js";
import { checkUpdate, applyUpdate, isUpdating, RESTART_CODE } from "./lib/updater.js";

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
// Esegue una modifica e risponde con il risultato, oppure con l'errore spiegato (400).
const handle = (fn) => (req, res) => {
  try {
    res.json(fn(req) ?? { ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message, errors: e.errors ?? [e.message] });
  }
};

const someoneWorking = () => office.agents().some((a) => isRunning(a.id)) || isChatBusy();

app.post("/api/update", async (_req, res) => {
  try {
    const result = await applyUpdate({ busy: someoneWorking() });
    res.json(result);
    if (result.restarting) restartWhenIdle();
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Riavvia (start.js fa ripartire il server) appena agenti e Orion hanno finito, al massimo dopo 2 minuti. */
function restartWhenIdle(waited = 0) {
  if (!someoneWorking() || waited >= 120_000) return setTimeout(() => process.exit(RESTART_CODE), 500);
  setTimeout(() => restartWhenIdle(waited + 1000), 1000);
}

// Durante un aggiornamento non partono nuovi lavori.
app.use(["/api/chat", "/api/agents/:id/run"], (req, res, next) => {
  if (req.method === "POST" && isUpdating()) return res.status(503).json({ error: "Aggiornamento in corso: riprova tra un minuto." });
  next();
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
    brokerTrades: (st.brokerTrades ?? []).length,
    pending: st.approvals.filter((a) => a.status === "pending").length,
    stop: safety.isStopped(),
    broker: ctrader.isReady() ? (office.building().floors.some((f) => f.trading?.mode === "ctrader") ? "in uso" : "collegato") : "no",
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

// ---------- broker cTrader e sicurezza ----------
const REDIRECT_URI = `http://localhost:${PORT}/ctrader/callback`;
const handleAsync = (fn) => async (req, res) => {
  try {
    res.json((await fn(req)) ?? { ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};
const brokerStatus = () => ({
  ...ctrader.status(),
  redirectUri: REDIRECT_URI,
  safety: safety.getSafety(),
  liveConfirm: safety.LIVE_CONFIRM,
  floors: office.building().floors.map((f) => ({ id: f.id, name: f.name, color: f.color, trading: f.trading ?? { mode: "paper" } })),
  trades: (getState().brokerTrades ?? []).slice(-50).reverse(),
});
/** Conti usati da almeno un piano. */
const accountsInUse = () => [...new Set(office.building().floors.filter((f) => f.trading?.mode === "ctrader").map((f) => String(f.trading.accountId)))];

app.get("/api/broker", (_req, res) => res.json(brokerStatus()));
app.put("/api/broker/credentials", handle((req) => {
  ctrader.setCredentials({ clientId: req.body?.clientId, clientSecret: req.body?.clientSecret });
  return brokerStatus();
}));
app.post("/api/broker/auth", handle(() => ({ url: ctrader.startAuth(REDIRECT_URI) })));
// Il sito di cTrader rimanda qui il browser dopo l'accesso, con il codice nell'indirizzo.
app.get("/ctrader/callback", async (req, res) => {
  const page = (title, text, ok) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;background:#0f1420;color:#e8ecf4;display:grid;place-items:center;height:100vh;margin:0">` +
    `<div style="max-width:520px;text-align:center"><h1>${ok ? "✅" : "⚠️"} ${title}</h1><p>${text}</p><p><a style="color:#7cc4ff" href="/#broker">Torna all'app</a></p></div>`;
  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  if (req.query.error) return res.status(400).send(page("Accesso annullato", escHtml(req.query.error_description ?? req.query.error), false));
  try {
    await ctrader.finishAuth(String(req.query.code ?? ""), REDIRECT_URI);
    res.redirect("/#broker");
  } catch (e) {
    res.status(400).send(page("Collegamento non riuscito", escHtml(e.message), false));
  }
});
// Alternativa: l'utente incolla l'indirizzo (o il codice) della pagina a cui è arrivato dopo l'accesso.
app.post("/api/broker/code", handleAsync(async (req) => {
  await ctrader.finishAuth(codeFromInput(req.body?.input), REDIRECT_URI);
  return brokerStatus();
}));
app.post("/api/broker/unlink", handle(() => {
  ctrader.unlink();
  return brokerStatus();
}));
app.post("/api/broker/refresh-accounts", handleAsync(async () => {
  await ctrader.refreshAccounts();
  return brokerStatus();
}));
app.put("/api/broker/data-account", handle((req) => {
  ctrader.setDataAccount(req.body?.accountId);
  return brokerStatus();
}));
// Saldo e posizioni di ogni conto (anche quelli non assegnati a un piano).
app.get("/api/broker/accounts", handleAsync(async () => {
  const out = [];
  for (const a of ctrader.status().accounts) {
    const id = a.ctidTraderAccountId;
    try {
      const [info, positions] = await Promise.all([ctrader.accountInfo(id), ctrader.positions(id)]);
      out.push({ accountId: id, info, positions });
    } catch (e) {
      out.push({ accountId: id, error: e.message });
    }
  }
  return out;
}));
app.get("/api/broker/search", handleAsync(async (req) => {
  const id = req.query.accountId ?? ctrader.dataAccountId();
  if (!id) throw new Error("Collega prima cTrader.");
  return ctrader.search(id, String(req.query.q ?? ""));
}));
// Chiudere una posizione è sempre permesso all'utente, anche con lo STOP attivo (riduce il rischio).
app.post("/api/broker/positions/:accountId/:positionId/close", handleAsync(async (req) => {
  const { accountId, positionId } = req.params;
  if (!ctrader.account(accountId)) throw new Error("Conto non trovato.");
  const lots = req.body?.lots ? Number(req.body.lots) : undefined;
  const r = await ctrader.closePosition(accountId, Number(positionId), lots);
  log("sicurezza", "info", `Posizione ${positionId} chiusa dall'utente sul conto ${accountId} (${r.lots} lotti)`);
  bus.emit("event", { type: "trade", trade: { accountId, positionId, action: "close" } });
  return r;
}));
app.put("/api/floors/:id/trading", handle((req) => {
  const mode = req.body?.mode === "ctrader" ? "ctrader" : "paper";
  return office.setFloorTrading(req.params.id, mode === "ctrader" ? { mode, accountId: req.body?.accountId } : { mode }, { source: "ui" });
}));

app.get("/api/safety", (_req, res) => res.json(safety.getSafety()));
app.put("/api/safety/limits", handle((req) => safety.updateLimits(req.body ?? {})));
app.post("/api/safety/stop", handleAsync(async (req) => {
  safety.activateKill("STOP premuto dall'utente");
  const report = { closed: 0, unconfirmed: 0, failed: [] };
  if (req.body?.closePositions && ctrader.isReady()) {
    await settleInFlight(); // prima finiscono gli ordini già partiti, poi si chiude tutto
    for (const id of ctrader.status().accounts.map((a) => String(a.ctidTraderAccountId))) {
      try {
        const r = await closeAllAgentPositions(id);
        report.closed += r.closed.length;
        report.unconfirmed += r.unconfirmed.length;
        report.failed.push(...r.failed.map((f) => ({ accountId: id, symbol: f.symbol, error: f.error })));
      } catch (e) {
        report.failed.push({ accountId: id, symbol: "tutte le posizioni del conto", error: e.message });
      }
    }
    log("sicurezza", report.failed.length ? "error" : "warn",
      `STOP: chiuse ${report.closed} posizioni degli agenti` +
        (report.unconfirmed ? `, ${report.unconfirmed} in attesa di conferma` : "") +
        (report.failed.length ? `; NON chiuse: ${report.failed.map((f) => `${f.symbol} sul conto ${f.accountId} (${f.error})`).join("; ")}` : ""));
  }
  return { ...safety.getSafety(), ...report };
}));
app.post("/api/safety/resume", handle(() => {
  safety.deactivateKill();
  return safety.getSafety();
}));
app.post("/api/safety/live", handle((req) => {
  const enabled = Boolean(req.body?.enabled);
  if (!enabled) {
    // Bloccando il conto reale, i piani che lo usavano tornano al portafoglio simulato.
    // (anche quelli il cui conto non è più nell'elenco: potrebbe essere reale)
    for (const f of office.building().floors) {
      if (f.trading?.mode !== "ctrader") continue;
      const acc = ctrader.account(f.trading.accountId);
      if (!acc || acc.isLive) office.setFloorTrading(f.id, { mode: "paper" });
    }
  }
  safety.setLive(enabled, req.body?.confirm);
  return brokerStatus();
}));

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
app.post("/api/chat/reset", handle(() => resetChat()));

app.post("/api/agents/:id/run", async (req, res) => {
  const agent = findAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "agente non trovato" });
  if (isRunning(agent.id)) return res.status(409).json({ error: "già in esecuzione" });
  lastRun.set(agent.id, new Date().toISOString());
  // Risponde subito: l'avanzamento arriva via SSE.
  runAgent(agent, office.building(), { task: req.body?.task }).catch(() => {});
  res.json({ ok: true });
});

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
// Con lo STOP attivo non parte nessun agente in automatico (si possono ancora avviare a mano).
setInterval(() => {
  const now = Date.now();
  for (const agent of office.agents()) {
    if (isUpdating() || safety.isStopped()) return;
    if (!agent.enabled || !(agent.everyMinutes > 0) || isRunning(agent.id)) continue;
    const prev = lastRun.has(agent.id) ? Date.parse(lastRun.get(agent.id)) : 0;
    if (now - prev >= agent.everyMinutes * 60_000) {
      lastRun.set(agent.id, new Date().toISOString());
      runAgent(agent, office.building()).catch(() => {});
    }
  }
}, 60_000);

// Controllo dei conti cTrader usati dai piani: perdita del giorno e STOP automatico.
let monitoring = false;
const monitor = async () => {
  if (monitoring || accountsInUse().length === 0) return;
  monitoring = true;
  try {
    await monitorAccounts();
  } finally {
    monitoring = false;
  }
};
setInterval(monitor, 60_000);
setTimeout(monitor, 5_000);

// control + C o chiusura della finestra: uscita ordinata, così i dati in attesa vengono salvati.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(0));

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
