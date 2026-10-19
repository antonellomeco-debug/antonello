// Server: API REST + eventi in tempo reale (SSE) + scheduler degli agenti.
// Per primo: mette al loro posto i dati di una copia importata dall'app, prima che vengano caricati.
import { importedAtBoot } from "./lib/boot.js";
import express from "express";
import { ALL_TOOLS, ID_PATTERN } from "./lib/config.js";
import { office } from "./lib/office.js";
import { PUBLIC_DIR, STRATEGIES_DIR, ROOT } from "./lib/paths.js";
import path from "node:path";
import { runAgent, isRunning } from "./lib/runner.js";
import { getState, resetState, bus, log, persistNow, persist, costScope, answerRequest } from "./lib/store.js";
import { portfolioValue, decide, monitorAccounts, settleInFlight, closeAgentPositionsEverywhere, stopNewOrders, recoverInterruptedApprovals, tradeHistory, accountSummary } from "./lib/broker.js";
import * as ctrader from "./lib/ctrader/service.js";
import { codeFromInput } from "./lib/ctrader/oauth.js";
import * as safety from "./lib/safety.js";
import { chat, getTranscript, resetChat, isChatBusy, ASSISTANT_NAME, getSpeed, setSpeed, SPEEDS } from "./lib/orchestrator.js";
import { getQuote } from "./lib/market.js";
import fs from "node:fs";
import { exec } from "node:child_process";
import { hasCredentials, keyStatus, verifyKey, cleanKey, MISSING_KEY } from "./lib/claude.js";
import { updateSettings } from "./lib/settings.js";
import { checkUpdate, applyUpdate, isUpdating, installedVersion, RESTART_CODE } from "./lib/updater.js";
import { isWorkingTime, scheduleStatus, updateSchedule, isFridayCloseTime, romeParts, resumeText, scheduleFor, getSchedule } from "./lib/schedule.js";
import { PORT, HOST, PUBLIC_URL, CLOUD, AUTH_ENABLED, FAIL_CLOSED, CONFIG_PROBLEMS, TRUST_PROXY, UPDATER_ON, VOLUME_OK, REDIRECT_URI } from "./lib/env.js";
import { securityHeaders, failClosed, hostCheck, originCheck } from "./lib/guard.js";
import * as auth from "./lib/auth.js";
import { exportZip, importZip, backupFileName, confirmImportWorked } from "./lib/backup.js";
import * as voice from "./lib/voice.js";
import * as costs from "./lib/costs.js";
import * as social from "./lib/social/index.js";
import * as platform from "./lib/platform.js";
import * as push from "./lib/push.js";
import * as media from "./lib/social/media.js";
import { setGeminiKey } from "./lib/social/imagegen.js";
import { setStockKey } from "./lib/social/stock.js";
import { setGoogleTtsKey, setVideoVoice, setVoiceFallback, previewVoice } from "./lib/social/googletts.js";
import { setElevenVoice, previewEleven } from "./lib/social/eleventts.js";
import { shutdownTts } from "./lib/social/tts.js";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";

const STARTED_AT = new Date().toISOString();
const URL_APP = PUBLIC_URL ?? `http://localhost:${PORT}`;
const SUPERVISED = process.env.SUPERVISED === "1"; // avviato da start.js, che lo fa ripartire (codice 75)
const app = express();
app.disable("x-powered-by");
// Dietro il proxy del servizio di hosting (TRUST_PROXY, vedi lib/env.js e Dockerfile): indirizzo vero e https.
if (TRUST_PROXY != null) app.set("trust proxy", TRUST_PROXY);

let shuttingDown = false; // in chiusura (nuova versione, riavvio): non parte più niente
let restartPending = false; // riavvio in arrivo (dati importati): non partono nuovi lavori

// Ordine delle protezioni: intestazioni di sicurezza → controllo di salute → configurazione insicura →
// indirizzo giusto (Host) → richieste da altri siti (Origin) → accesso con password → tutto il resto.
app.use(securityHeaders);
// Controllo di salute per il servizio di hosting: sempre raggiungibile (senza accesso, con qualsiasi Host).
app.get("/healthz", (_req, res) => res.status(shuttingDown ? 503 : 200).json(shuttingDown ? { ok: false, closing: true } : { ok: true }));
app.use(failClosed);
app.use(hostCheck);
app.use(originCheck);

// ---------- accesso con password (solo sul server o con APP_PASSWORD) ----------
app.get("/api/session", (req, res) =>
  res.json({ auth: AUTH_ENABLED, loggedIn: auth.isLoggedIn(req), cloud: Boolean(PUBLIC_URL), updater: UPDATER_ON, publicUrl: PUBLIC_URL, volumeOk: VOLUME_OK }),
);
app.post("/api/login", express.json({ limit: "4kb" }), auth.login);
app.post("/api/logout", auth.logout);
app.get("/login", (req, res) => {
  if (auth.isLoggedIn(req)) return res.redirect(302, auth.safeNext(req.query.next));
  res.sendFile(path.join(PUBLIC_DIR, "login.html"), (err) => err && !res.headersSent && res.status(404).send("Pagina di accesso non trovata."));
});
// File dell'archivio per i social: Instagram e Threads li scaricano da qui, senza accesso. L'indirizzo contiene un
// codice casuale lungo (impossibile da indovinare); senza quel codice la risposta è "non trovato".
app.get("/m/:name", (req, res) => {
  const f = /^[A-Za-z0-9_-]{20,40}(-t\.jpg|\.[a-z0-9]{2,4})$/.test(req.params.name) ? media.fileForPublicName(req.params.name) : null;
  if (!f) return res.status(404).type("text/plain").send("Non trovato");
  res.set({ "Cache-Control": "private, max-age=86400", "X-Robots-Tag": "noindex" });
  res.type(f.mime);
  res.sendFile(f.file, (err) => err && !res.headersSent && res.status(404).end());
});

// Il ritorno da cTrader (o da un social) è permesso anche senza accesso se porta lo "state" dell'ultimo «Collega»:
// sull'iPhone l'app sulla schermata Home e Safari non condividono i cookie.
app.use(auth.requireSession({
  allow: (req) =>
    req.method === "GET" &&
    ((req.path === "/ctrader/callback" && ctrader.pendingStateMatches(String(req.query.state ?? ""))) ||
      (req.path === "/social/callback" && social.pendingStateMatches(String(req.query.state ?? "")))),
}));

app.use(express.json({ limit: "1mb" }));
// sw.js (app installabile sul telefono) va sempre ricontrollato, così le nuove versioni arrivano subito.
app.use(express.static(PUBLIC_DIR, { setHeaders: (res, file) => path.basename(file) === "sw.js" && res.setHeader("Cache-Control", "no-cache") }));
app.use("/vendor/three", express.static(path.join(ROOT, "node_modules", "three")));

// Ultimo avvio di ogni agente, salvato nello stato: un riavvio (es. una nuova versione sul server) non fa ripartire
// tutti gli agenti insieme. All'apertura valgono solo gli avvii di oggi (ora italiana): il primo avvio della
// giornata fa lavorare tutti, come prima.
const lastRun = new Map();
{
  const today = romeParts().date;
  for (const [id, at] of Object.entries(getState().lastRun ?? {})) {
    if (typeof at === "string" && !Number.isNaN(Date.parse(at)) && romeParts(new Date(at)).date === today) lastRun.set(id, at);
  }
}
function markRun(id) {
  lastRun.set(id, new Date().toISOString());
  getState().lastRun = Object.fromEntries(lastRun);
  persist();
}
function clearRuns() {
  lastRun.clear();
  getState().lastRun = {};
  persist();
}
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
app.get("/api/version", (_req, res) => res.json({ startedAt: STARTED_AT, version: installedVersion()?.short ?? null }));
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

// Messaggi vocali in trascrizione (prima che arrivino a Orion): contano come lavoro in corso.
let voiceInFlight = 0;
const someoneWorking = () => office.agents().some((a) => isRunning(a.id)) || isChatBusy() || voiceInFlight > 0;

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
  if (!someoneWorking() || waited >= 120_000) return setTimeout(() => shutdown("Riavvio", RESTART_CODE), 500);
  setTimeout(() => restartWhenIdle(waited + 1000), 1000);
}

// Durante un aggiornamento o un riavvio non partono nuovi lavori.
app.use(["/api/chat", "/api/agents/:id/run"], (req, res, next) => {
  if (req.method !== "POST") return next();
  if (shuttingDown || restartPending) return res.status(503).json({ error: "Il programma si sta riavviando: riprova tra un minuto." });
  if (isUpdating()) return res.status(503).json({ error: "Aggiornamento in corso: riprova tra un minuto." });
  next();
});

app.get("/api/notes", (_req, res) => res.json(getState().notes));
app.get("/api/log", (_req, res) => res.json(getState().log));
// Prezzi da Yahoo o cTrader: il loro errore (già in italiano) arriva all'utente.
app.get("/api/portfolio", async (_req, res) => {
  try { res.json(await portfolioValue()); } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get("/api/quote/:symbol", async (req, res) => {
  try { res.json(await getQuote(req.params.symbol)); } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get("/api/stats", (_req, res) => {
  const st = getState();
  const notes = Object.values(st.notes).flat();
  res.json({
    working: office.agents().filter((a) => isRunning(a.id)).length,
    agents: office.agents().length,
    palaces: office.building().palaces.length,
    floors: office.building().floors.length,
    rooms: office.building().rooms.length,
    scheduled: office.agents().filter((a) => a.enabled && a.everyMinutes > 0).length,
    notes: notes.length,
    trades: st.portfolio.trades.length,
    brokerTrades: (st.brokerTrades ?? []).length,
    pending: st.approvals.filter((a) => a.status === "pending").length + (st.requests ?? []).filter((r) => r.status === "open").length,
    stop: safety.isStopped(),
    broker: ctrader.isReady() ? (office.building().floors.some((f) => f.trading?.mode === "ctrader") ? "in uso" : "collegato") : "no",
    costUsd: st.usage.costUsd,
    costMonth: costs.monthSpend().total,
    budget: costs.costReport([], office.building()).budget,
    tokens: st.usage.inputTokens + st.usage.outputTokens,
    schedule: {
      ...(({ enabled, working, resume }) => ({ enabled, working, resume }))(scheduleStatus()),
      // Palazzi con un orario loro che lavorano anche adesso (es. il Social nel fine settimana).
      alsoOpen: office.building().palaces.filter((p) => p.hours !== "lavoro" && isWorkingTime(scheduleFor(p.hours))).map((p) => p.name),
    },
  });
});

// Orario di lavoro degli agenti programmati (⚙️ Impostazioni).
app.get("/api/schedule", (_req, res) => res.json(scheduleStatus()));
app.put("/api/schedule", handle((req) => {
  updateSchedule(req.body ?? {});
  bus.emit("event", { type: "stats" });
  return scheduleStatus();
}));

app.get("/api/approvals", (_req, res) => res.json(getState().approvals.slice().reverse()));
// Domande degli agenti all'utente (note RICHIESTA): aperte e le ultime chiuse.
app.get("/api/requests", (_req, res) => {
  const all = (getState().requests ?? []).slice().reverse();
  res.json([...all.filter((r) => r.status === "open"), ...all.filter((r) => r.status !== "open").slice(0, 10)]);
});
app.post("/api/requests/:id/answer", handle((req) => {
  const r = answerRequest(req.params.id, req.body?.text);
  bus.emit("event", { type: "stats" });
  return r;
}));
app.post("/api/requests/:id/dismiss", handle((req) => {
  const r = answerRequest(req.params.id, "", { dismiss: true });
  bus.emit("event", { type: "stats" });
  return r;
}));
app.post("/api/approvals/:id", async (req, res) => {
  try {
    const a = getState().approvals.find((x) => x.id === req.params.id);
    res.json(a?.kind === "post" ? await social.decidePost(req.params.id, Boolean(req.body?.approve)) : await decide(req.params.id, Boolean(req.body?.approve)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- broker cTrader e sicurezza ----------
// REDIRECT_URI (lib/env.js): <PUBLIC_URL>/ctrader/callback sul server, http://localhost:<porta>/ctrader/callback sul Mac.
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
  floors: office.building().floors.map((f) => ({ id: f.id, name: f.name, palace: f.palace, color: f.color, trading: f.trading ?? { mode: "paper" } })),
  trades: (getState().brokerTrades ?? []).slice(-50).reverse(),
});
/** Conti usati da almeno un piano. */
const accountsInUse = () => [...new Set(office.building().floors.filter((f) => f.trading?.mode === "ctrader").map((f) => String(f.trading.accountId)))];

app.get("/api/broker", (_req, res) => res.json(brokerStatus()));
// Operazioni chiuse con il risultato (vinto o perso), dalla più recente.
app.get("/api/broker/summary", handleAsync(() => accountSummary()));
app.get("/api/broker/history", handleAsync((req) => tradeHistory({ days: [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30 })));
app.put("/api/broker/credentials", handle((req) => {
  ctrader.setCredentials({ clientId: req.body?.clientId, clientSecret: req.body?.clientSecret });
  return brokerStatus();
}));
app.post("/api/broker/auth", handle(() => ({ url: ctrader.startAuth(REDIRECT_URI) })));
// Il sito di cTrader rimanda qui il browser dopo l'accesso, con il codice (e lo "state") nell'indirizzo.
// Senza accesso all'app (es. Safari sull'iPhone, mentre l'app è sulla schermata Home) passa solo con lo
// "state" giusto, e invece di aprire l'app mostra una pagina che dice di tornarci.
app.get("/ctrader/callback", async (req, res) => {
  const loggedIn = auth.isLoggedIn(req);
  const page = (title, text, ok) =>
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><body style="font-family:system-ui;background:#0f1420;color:#e8ecf4;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box">` +
    `<div style="max-width:520px;text-align:center"><h1>${ok ? "✅" : "⚠️"} ${title}</h1><p>${text}</p><p><a style="color:#7cc4ff" href="/#broker">Torna all'app</a></p></div>`;
  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  if (req.query.error) return res.status(400).send(page("Accesso annullato", escHtml(req.query.error_description ?? req.query.error), false));
  try {
    const state = req.query.state != null ? String(req.query.state) : undefined;
    await ctrader.finishAuth(String(req.query.code ?? ""), REDIRECT_URI, { state });
    if (loggedIn) return res.redirect("/#broker");
    res.send(page("cTrader collegato: torna all'app", "Il collegamento è fatto. Puoi chiudere questa pagina e tornare all'app (dalla schermata Home, se l'hai installata): in 🔌 Broker trovi i tuoi conti.", true));
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
  let report = { closed: 0, unconfirmed: 0, failed: [] };
  if (req.body?.closePositions && ctrader.isReady()) {
    await settleInFlight(); // prima finiscono gli ordini già partiti, poi si chiude tutto
    report = await closeAgentPositionsEverywhere();
    log("sicurezza", report.failed.length ? "error" : "warn",
      `STOP: chiuse ${report.closed} posizioni degli agenti` +
        (report.unconfirmed ? `, ${report.unconfirmed} in attesa di conferma` : "") +
        (report.failed.length ? `; NON chiuse: ${report.failed.map((f) => `${f.symbol} sul conto ${ctrader.account(f.accountId)?.traderLogin ?? f.accountId} (${f.error})`).join("; ")}` : ""));
  }
  return { ...safety.getSafety(), ...report };
}));
app.post("/api/safety/resume", handle(() => {
  safety.deactivateKill();
  return safety.getSafety();
}));
// Sbloccare il conto reale richiede di nuovo la password dell'app (sul server): un cookie rubato non basta.
const liveStepUp = auth.requireStepUp({ when: (req) => Boolean(req.body?.enabled), password: auth.bodyPassword });
app.post("/api/safety/live", liveStepUp, handle((req) => {
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
const costsView = () => ({
  ...costs.costReport(office.agents(), office.building()),
  subscriptions: costs.listSubscriptions(),
  subscriptionsMonthly: costs.subscriptionsMonthly(costs.listSubscriptions(), new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome" }).format(new Date()).slice(0, 7)),
  subEvery: costs.SUB_EVERY,
  reports: (getState().reports ?? []).slice(-20).reverse(),
});
app.get("/api/costs", (_req, res) => res.json(costsView()));
app.put("/api/costs/subscriptions", handle((req) => {
  costs.saveSubscription(req.body ?? {}, office.building());
  return costsView();
}));
app.delete("/api/costs/subscriptions/:id", handle((req) => {
  costs.deleteSubscription(req.params.id);
  return costsView();
}));
app.put("/api/costs/budget", handle((req) => {
  costs.setBudgets(req.body ?? {});
  return costsView();
}));
app.put("/api/costs/pace", handle((req) => {
  costs.setPalacePace(String(req.body?.palace ?? ""), String(req.body?.pace ?? ""), office.building());
  bus.emit("event", { type: "stats" });
  return costsView();
}));
app.get("/api/orion", (_req, res) => res.json({ speed: getSpeed(), speeds: Object.keys(SPEEDS) }));
app.put("/api/orion", handle((req) => setSpeed(String(req.body?.speed ?? ""))));
// Notifiche sul telefono (🔔 in ⚙️ Impostazioni).
app.get("/api/push", (_req, res) => res.json(push.pushStatus()));
app.post("/api/push/subscribe", handle((req) => push.subscribe(req.body?.subscription, req.body?.label)));
app.post("/api/push/unsubscribe", handle((req) => push.unsubscribe(req.body?.endpoint)));
app.put("/api/push/prefs", handle((req) => push.setPrefs(req.body ?? {})));
app.post("/api/push/test", handleAsync(() => push.sendTest()));
// Aspetto, tasti rapidi e idee (li cambia soprattutto Orion; dall'app si possono togliere o tornare all'originale).
app.get("/api/platform", (_req, res) => res.json(platform.getPlatform()));
app.put("/api/platform/look", handle((req) => (platform.setLook(req.body ?? {}), platform.getPlatform())));
app.put("/api/platform/brief", handle((req) => (platform.setBrief({ text: req.body?.text, palaces: req.body?.palaces }, { palaceIds: office.building().palaces.map((p) => p.id) }), platform.getPlatform())));
app.delete("/api/platform/shortcuts/:id", handle((req) => (platform.deleteShortcut(String(req.params.id)), platform.getPlatform())));
app.delete("/api/platform/ideas/:id", handle((req) => (platform.deleteIdea(String(req.params.id)), platform.getPlatform())));

// ---------- messaggi vocali ----------
// L'app registra la voce e manda un WAV (16 kHz, un canale); il server lo trascrive (lib/voice.js) e lo passa a
// Orion come un messaggio scritto. La prima volta si scarica il riconoscimento della voce (circa 560 MB).
// ---------- social (📣 Social) ----------
const socialPage = (title, text, ok) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><body style="font-family:system-ui;background:#0f1420;color:#e8ecf4;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box">` +
  `<div style="max-width:520px;text-align:center"><h1>${ok ? "✅" : "⚠️"} ${title}</h1><p>${text}</p><p><a style="color:#7cc4ff" href="/#social">Torna all'app</a></p></div>`;
const escPage = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const netParam = (req) => {
  const net = String(req.params.net ?? "");
  if (!social.NETWORK_IDS.includes(net)) throw new Error("social sconosciuto");
  return net;
};
app.get("/api/social", (_req, res) => res.json(social.socialStatus()));
// Voce dei video: chiave di Google, scelta della voce e ascolto di prova (pochi caratteri, dentro la quota gratuita).
app.put("/api/social/voice/key", async (req, res) => {
  try {
    await setGoogleTtsKey(req.body?.key);
    res.json(social.socialStatus());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.put("/api/social/voice", handle((req) => (setVideoVoice(req.body?.name), social.socialStatus())));
app.put("/api/social/voice/fallback", handle((req) => (setVoiceFallback(req.body?.name), social.socialStatus())));
// Voce clonata dell'utente (ElevenLabs): chiave e ID della voce, provati con una parola prima di salvarli.
app.put("/api/social/voice/eleven", async (req, res) => {
  try {
    await setElevenVoice({ key: req.body?.key, voiceId: req.body?.voiceId, model: req.body?.model });
    res.json(social.socialStatus());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post("/api/social/voice/preview", async (req, res) => {
  try {
    const name = String(req.body?.name ?? "");
    const wav = name === "eleven" ? await previewEleven() : await previewVoice(name);
    res.set("content-type", "audio/wav").set("cache-control", "no-store").send(wav);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.put("/api/social/stock", async (req, res) => {
  try {
    const r = await setStockKey(String(req.body?.provider ?? "pexels"), req.body?.key);
    res.json({ ...social.socialStatus(), stockNote: r.note ?? null });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.put("/api/social/ai", async (req, res) => {
  try {
    const r = await setGeminiKey(req.body?.key);
    res.json({ ...social.socialStatus(), aiNote: r.note ?? null });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.put("/api/social/:net/app", handle((req) => social.setApp(netParam(req), req.body ?? {})));
app.post("/api/social/:net/auth", handle((req) => social.startAuth(netParam(req))));
app.post("/api/social/:net/unlink", handle((req) => social.disconnect(netParam(req))));
app.put("/api/social/:net/settings", handle((req) => social.setNetworkSettings(netParam(req), { auto: req.body?.auto, maxPerDay: req.body?.maxPerDay, maxStoriesPerDay: req.body?.maxStoriesPerDay, autoReplies: req.body?.autoReplies, pageId: req.body?.pageId, pageName: req.body?.pageName, pageOnly: req.body?.pageOnly, pageApi: req.body?.pageApi })));
app.post("/api/social/posts/:id/cancel", handle((req) => social.cancelPost(req.params.id)));
// Ritorno dal sito del social dopo l'accesso, con il codice e lo "state" nell'indirizzo.
app.get("/social/callback", async (req, res) => {
  const loggedIn = auth.isLoggedIn(req);
  const state = String(req.query.state ?? "");
  if (req.query.error) {
    if (social.pendingStateMatches(state)) social.pendingCancel(state);
    const scopeRefused = /scope/i.test(String(req.query.error)) && /w_organization_social/.test(String(req.query.error_description ?? ""));
    const msg = escPage(req.query.error_description ?? req.query.error_reason ?? req.query.error);
    return res.status(400).send(socialPage("Collegamento annullato", scopeRefused
      ? `${msg}<br><br>LinkedIn non ha ancora dato alla tua app l'accesso alle pagine. Nell'app, in 📣 Social → LinkedIn → 🏢 Pagina aziendale, togli la spunta «LinkedIn ha approvato l'accesso alle pagine», premi Salva e poi Ricollega: i post della pagina li pubblicherai tu da Approvazioni.`
      : msg, false));
  }
  try {
    const r = await social.finishAuth(state, String(req.query.code ?? ""));
    if (loggedIn) return res.redirect("/#social");
    res.send(socialPage(`${escPage(social.NETWORKS[r.network].label)} collegato`, `Collegato come <b>${escPage(r.username)}</b>. Puoi chiudere questa pagina e tornare all'app.`, true));
  } catch (e) {
    res.status(400).send(socialPage("Collegamento non riuscito", escPage(e.message), false));
  }
});

// Archivio di foto e video. Il caricamento arriva "grezzo" (il file così com'è) e va subito su disco.
app.get("/api/media", (_req, res) => res.json(media.listMedia()));
app.put("/api/media/:id", handle((req) => media.updateMedia(req.params.id, req.body ?? {})));
app.delete("/api/media/:id", handle((req) => media.deleteMedia(req.params.id)));
app.post("/api/media", async (req, res) => {
  const type = String(req.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const max = type.startsWith("video/") ? media.MAX_VIDEO_BYTES : media.MAX_IMAGE_BYTES;
  const declared = Number(req.get("content-length")) || 0;
  const tooBig = `File troppo grande: massimo ${Math.round(max / 1024 / 1024)} MB${type.startsWith("video/") ? " per i video" : type.startsWith("audio/") ? " per le musiche" : " per le foto"}.`;
  if (declared > max) return res.status(413).json({ error: tooBig });
  try {
    media.assertSpace(declared);
  } catch (e) {
    return res.status(507).json({ error: e.message });
  }
  const tmp = path.join(media.MEDIA_DIR, `.upload-${crypto.randomUUID()}`);
  let size = 0;
  try {
    fs.mkdirSync(media.MEDIA_DIR, { recursive: true });
    await pipeline(
      req,
      async function* (src) {
        for await (const chunk of src) {
          size += chunk.length;
          if (size > max) throw Object.assign(new Error(tooBig), { status: 413 });
          yield chunk;
        }
      },
      fs.createWriteStream(tmp),
    );
    if (!size) throw new Error("File vuoto.");
    let name = "";
    try {
      name = decodeURIComponent(req.get("x-file-name") ?? "");
    } catch {
      // nome non leggibile: resta vuoto
    }
    res.json(await media.ingestUpload(tmp, { name, mime: type }));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if (!res.headersSent) res.status(e.status ?? 400).json({ error: e.message });
  }
});

app.get("/api/voice", (_req, res) => res.json(voice.publicStatus()));
app.post("/api/voice/prepare", handle(() => voice.prepare()));
app.post("/api/chat/voice", express.raw({ type: ["audio/wav", "audio/x-wav", "audio/wave"], limit: "6mb" }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Audio mancante o in un formato non previsto." });
  // Prima i controlli veloci, così non si aspetta la trascrizione per niente.
  if (isChatBusy()) return res.status(409).json({ error: `${ASSISTANT_NAME} sta ancora rispondendo: aspetta che finisca e riprova.` });
  // Un vocale per volta: se l'app ha perso la risposta (telefono bloccato, rete) e lo rimanda, non arriva due volte.
  if (voiceInFlight) return res.status(409).json({ error: "Sto ancora trascrivendo il messaggio vocale di prima: aspetta che compaia nella chat." });
  if (!hasCredentials()) return res.status(400).json({ error: MISSING_KEY });
  let text;
  voiceInFlight++;
  try {
    text = await voice.transcribe(req.body);
  } catch (e) {
    return res.status(e.status ?? 500).json({ error: e.message, voice: voice.publicStatus() });
  } finally {
    voiceInFlight--;
  }
  // Durante la trascrizione può essere partito un aggiornamento o un riavvio: il testo torna all'app.
  if (shuttingDown || restartPending || isUpdating()) return res.status(503).json({ error: "Il programma si sta riavviando: riprova tra un minuto.", text });
  try {
    res.json({ text, reply: await chat(chatCtx, text, { voice: true }) });
  } catch (e) {
    res.status(400).json({ error: e.message, text }); // il testo torna all'app: si può rimandare scritto
  }
});

app.post("/api/agents/:id/run", async (req, res) => {
  const agent = findAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "agente non trovato" });
  if (isRunning(agent.id)) return res.status(409).json({ error: "già in esecuzione" });
  markRun(agent.id);
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
app.post("/api/palaces", handle((req) => office.savePalace({ ...req.body, id: undefined })));
app.put("/api/palaces/:id", handle((req) => office.savePalace({ ...req.body, id: req.params.id })));
app.delete("/api/palaces/:id", handle((req) => office.deletePalace(req.params.id)));
app.post("/api/floors", handle((req) => office.saveFloor({ ...req.body, id: undefined })));
app.put("/api/floors/:id", handle((req) => office.saveFloor({ ...req.body, id: req.params.id })));
app.delete("/api/floors/:id", handle((req) => office.deleteFloor(req.params.id)));
app.post("/api/rooms", handle((req) => office.saveRoom({ ...req.body, id: undefined })));
app.put("/api/rooms/:id", handle((req) => office.saveRoom({ ...req.body, id: req.params.id })));
app.delete("/api/rooms/:id", handle((req) => office.deleteRoom(req.params.id)));
app.put("/api/links", handle((req) => office.setLink(req.body ?? {})));
app.delete("/api/links", handle((req) => office.deleteLink(String(req.query.from ?? ""), String(req.query.to ?? ""))));

app.post("/api/reset", auth.requireStepUp({ password: auth.bodyPassword }), (_req, res) => {
  resetState();
  res.json({ ok: true });
});

// ---------- copia dei dati (⚙️ Impostazioni): scarica e importa ----------
// Anche lo scarico chiede la password: la copia contiene la chiave di Claude e l'accesso a cTrader.
app.get("/api/backup", auth.requireStepUp({ password: (req) => auth.headerPassword(req.get("x-agenti-password")) }), (_req, res) => {
  persistNow(); // nella copia anche le ultime modifiche ancora in memoria
  res.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename=${backupFileName()}` });
  res.send(exportZip());
});
app.post(
  "/api/backup",
  auth.requireStepUp({ password: (req) => auth.headerPassword(req.get("x-agenti-password")) }),
  // Qualsiasi tipo: i browser chiamano lo .zip in modi diversi (application/zip, x-zip-compressed, vuoto…).
  express.raw({ type: () => true, limit: "20mb" }),
  (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Scegli il file .zip con la copia dei dati." });
    let r;
    try {
      r = importZip(req.body);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    log("programma", "warn", `Importata una copia dei dati (${r.files} file). I dati di prima sono salvati in ${r.copy}. ` + (SUPERVISED ? "Il programma si riavvia." : "Riavvia il programma per usarli."));
    if (!SUPERVISED) return res.json({ ok: true, restarting: false, message: "Riavvia il programma", files: r.files });
    res.json({ ok: true, restarting: true, files: r.files });
    restartPending = true;
    restartWhenIdle();
  },
);

// ---------- eventi in tempo reale (SSE) ----------
const MAX_STREAMS = 10;
const PING_MS = Number(process.env.SSE_PING_MS) || 25_000;
let streams = 0;
app.get("/api/events", (req, res) => {
  if (streams >= MAX_STREAMS) return res.status(503).json({ error: "Troppe finestre aperte sull'app: chiudine qualcuna e ricarica la pagina." });
  streams++;
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  // Un messaggio vero ogni 25 secondi: il telefono capisce se la diretta si è interrotta (es. dopo lo standby).
  const ping = setInterval(() => {
    if (!auth.sessionAlive(req)) return res.end(); // uscito o sessione scaduta
    send({ type: "ping", at: new Date().toISOString() });
  }, PING_MS);
  bus.on("event", send);
  res.on("close", () => {
    streams--;
    clearInterval(ping);
    bus.off("event", send);
  });
});

// Errori non previsti: il dettaglio va nel registro, all'utente un messaggio semplice.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err.status ?? err.statusCode) || 500;
  if (status >= 500) {
    log("server", "error", `Errore interno su ${req.method} ${req.path}: ${err.message}`);
    return res.status(500).json({ error: "Errore interno del programma: riprova tra poco. Se continua, guarda il registro 📜 Attività." });
  }
  const error =
    status === 413 ? "I dati inviati sono troppo grandi." :
    err.type === "entity.parse.failed" ? "Richiesta non valida (dati illeggibili)." :
    err.expose && err.message ? err.message : "Richiesta non valida.";
  res.status(status).json({ error });
});

// Scheduler: ogni minuto avvia gli agenti con everyMinutes > 0 che sono "scaduti".
// Con lo STOP attivo non parte nessun agente in automatico (si possono ancora avviare a mano).
// Fuori dall'orario di lavoro (⚙️ Impostazioni) non parte nessun agente in automatico; quando l'orario
// ricomincia ripartono tutti, come all'apertura del programma. Un palazzo può avere un orario suo (finestra del
// palazzo): "tutti i giorni" (anche il fine settimana, per esempio i social) o "sempre".
let wasWorking = null;
function schedulerTick() {
  if (shuttingDown || restartPending) return;
  const now = Date.now();
  const working = isWorkingTime();
  if (working !== wasWorking) {
    if (working && wasWorking === false) {
      clearRuns();
      log("orario", "info", "Inizio dell'orario di lavoro: gli agenti programmati ripartono.");
    } else if (!working && wasWorking === true) {
      log("orario", "info", `Fine dell'orario di lavoro: gli agenti programmati ripartono ${resumeText() ?? "all'inizio del prossimo orario"}.`);
    }
    if (wasWorking !== null) bus.emit("event", { type: "stats" });
    wasWorking = working;
  }
  const building = office.building();
  const cfg = getSchedule();
  const open = new Map(building.palaces.map((p) => [p.id, isWorkingTime(scheduleFor(p.hours, cfg))]));
  if (![...open.values()].some(Boolean)) return;
  const month = costs.monthSpend(); // una volta per giro: serve per i budget
  for (const agent of office.agents()) {
    if (isUpdating() || safety.isStopped()) return;
    if (!agent.enabled || !(agent.everyMinutes > 0) || isRunning(agent.id)) continue;
    if (!open.get(costs.palaceOfAgent(agent, building))) continue; // fuori dall'orario del suo palazzo
    const prev = lastRun.has(agent.id) ? Date.parse(lastRun.get(agent.id)) : 0;
    // Almeno ogni 5 minuti anche per agenti salvati prima del limite o arrivati da una copia importata; il ritmo del
    // palazzo (💰 Spesa) può allungare l'intervallo.
    if (now - prev < costs.effectiveEvery(agent, building) * 60_000) continue;
    const blocked = costs.scheduleBlock(agent, building, month);
    if (blocked) {
      noteBlocked(agent, building, blocked);
      continue;
    }
    markRun(agent.id);
    // "Solo con novità": se nessuno ha scritto niente di nuovo nelle stanze che legge, salta questo giro (gratis).
    if (agent.onlyOnNews && prev && !costs.hasNews(agent, building, prev)) continue;
    runAgent(agent, building).catch(() => {});
  }
}

/** Un avviso al giorno per palazzo quando gli agenti non partono per un budget raggiunto. */
const blockedNoted = new Map();
function noteBlocked(agent, building, reason) {
  if (reason === "palazzo in pausa") return;
  const key = `${costs.palaceOfAgent(agent, building)}|${reason.split(" (")[0]}`;
  const today = romeParts().date;
  if (blockedNoted.get(key) === today) return;
  blockedNoted.set(key, today);
  const palace = building.palaces.find((p) => p.id === costs.palaceOfAgent(agent, building))?.name ?? "palazzo";
  log("spesa", "warn", `${palace}: ${reason}. Gli agenti programmati sono fermi fino al mese prossimo (o finché alzi il budget in 💰 Spesa).`);
}
setInterval(() => {
  // Un errore in un giro (es. dati rovinati) si scrive nel registro e non ferma il programma.
  try {
    schedulerTick();
  } catch (err) {
    log("programma", "error", `Scheduler: ${err.message}`);
  }
}, 60_000);

// Controllo dei conti cTrader usati dai piani: perdita del giorno e STOP automatico.
let monitoring = false;
const monitor = async () => {
  if (shuttingDown || monitoring || accountsInUse().length === 0) return;
  monitoring = true;
  try {
    await monitorAccounts();
  } catch (err) {
    log("sicurezza", "error", `Controllo dei conti cTrader non riuscito: ${err.message}`);
  } finally {
    monitoring = false;
  }
};
setInterval(monitor, 60_000);
setTimeout(monitor, 5_000);

// Chiusura del venerdì (⚙️ Impostazioni → Orario): dall'ora scelta chiude le posizioni aperte dagli agenti
// su tutti i conti cTrader, così nessuna resta aperta nel weekend. Riprova ogni minuto finché ne resta qualcuna.
let fridayClosing = false;
let fridayDone = ""; // giorno (ora italiana) in cui non è rimasta nessuna posizione degli agenti da chiudere
let fridayFailures = 0;
async function fridayClose() {
  if (shuttingDown || fridayClosing || !isFridayCloseTime() || !ctrader.isReady()) return;
  const day = romeParts().date;
  if (fridayDone === day) return;
  fridayClosing = true;
  try {
    await settleInFlight(); // prima finiscono gli ordini già partiti
    const { closed, unconfirmed, failed } = await closeAgentPositionsEverywhere();
    if (closed || unconfirmed) {
      log("sicurezza", "warn", `Chiusura del venerdì: chiuse ${closed} posizioni degli agenti` + (unconfirmed ? `, ${unconfirmed} in attesa di conferma` : "") + ".");
    }
    if (failed.length) {
      fridayFailures++;
      if (fridayFailures <= 3) {
        const what = failed.map((f) => `${f.symbol} sul conto ${ctrader.account(f.accountId)?.traderLogin ?? f.accountId} (${f.error})`).join("; ");
        log("sicurezza", "error", `Chiusura del venerdì: NON chiuse ${what}. Riprovo tra un minuto; se non riesce, chiudile tu da 🔌 Broker.`);
      }
    } else if (!closed && !unconfirmed) {
      fridayDone = day; // nessuna posizione degli agenti aperta: per oggi è fatto
      fridayFailures = 0;
    }
  } finally {
    fridayClosing = false;
  }
}
setInterval(() => fridayClose().catch((e) => log("sicurezza", "error", `Chiusura del venerdì non riuscita: ${e.message}`)), 60_000);

// ---------- chiusura ordinata ----------
// control + C, o il servizio di hosting che ferma il programma per una nuova versione (SIGTERM): non partono
// più agenti né ordini, si aspettano (al massimo 8 secondi) gli ordini già inviati a cTrader, si salva e si esce.
const SHUTDOWN_WAIT_MS = 8_000;
async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (importedAtBoot) confirmImportWorked(); // chiusura ordinata: i dati importati funzionavano
  stopNewOrders();
  voice.shutdownVoice();
  shutdownTts();
  console.log(`\n  ⏹  ${reason}: chiudo il programma…`);
  const timeout = new Promise((r) => setTimeout(() => r(false), SHUTDOWN_WAIT_MS).unref());
  const settled = await Promise.race([settleInFlight().then(() => true, () => true), timeout]);
  if (!settled) log("sicurezza", "warn", "Chiusura del programma: un ordine verso cTrader non ha risposto in tempo. Alla riapertura controlla le posizioni in 🔌 Broker.");
  try {
    persistNow();
  } catch (e) {
    console.log(`${new Date().toISOString()} [error] programma: salvataggio alla chiusura non riuscito (${e.message})`);
  }
  server.closeAllConnections?.();
  process.exit(code);
}
process.on("SIGINT", () => shutdown("Chiusura richiesta"));
process.on("SIGTERM", () => shutdown("Arresto richiesto dal sistema"));
// Finestra del Terminale chiusa (Mac): si esce subito, i dati in attesa si salvano comunque all'uscita.
process.on("SIGHUP", () => {
  if (importedAtBoot) confirmImportWorked(); // finestra del Terminale chiusa: i dati importati funzionavano
  process.exit(0);
});

function openBrowser() {
  if (process.env.OPEN_BROWSER === "0" || CLOUD) return;
  const cmd = process.platform === "darwin" ? `open ${URL_APP}` : process.platform === "win32" ? `start "" ${URL_APP}` : null;
  if (cmd) exec(cmd, () => {});
}

// All'avvio: dati importati e ordini rimasti a metà da una chiusura improvvisa.
if (importedAtBoot) log("programma", "info", `Dati della copia importata messi al loro posto (${importedAtBoot} file).`);
recoverInterruptedApprovals();
social.recoverInterruptedPosts();
// Caricamenti rimasti a metà da una chiusura improvvisa.
try {
  for (const f of fs.readdirSync(media.MEDIA_DIR)) if (f.startsWith(".upload-")) fs.rmSync(path.join(media.MEDIA_DIR, f), { force: true });
} catch {
  // nessun archivio ancora
}
// Post programmati: si pubblicano all'ora scelta. I codici d'accesso dei social si rinnovano per tempo.
let publishing = false;
setInterval(async () => {
  if (shuttingDown || publishing) return;
  publishing = true;
  try {
    await costScope.run({ kind: "social" }, () => social.publishDue());
  } catch (err) {
    log("social", "error", `Post programmati: ${err.message}`);
  } finally {
    publishing = false;
  }
}, 30_000);
setInterval(() => social.refreshTokens().catch(() => {}), 3600_000);
setTimeout(() => social.refreshTokens().catch(() => {}), 60_000).unref();
// Dopo un'importazione: se il programma resta acceso due minuti e mezzo (più di un giro dello scheduler e del controllo
// dei conti) o si chiude in modo ordinato, i dati nuovi vanno bene.
if (importedAtBoot) setTimeout(confirmImportWorked, 150_000).unref();

// Express 5 passa anche l'eventuale errore di avvio (es. porta occupata) a questa callback.
const server = app.listen(PORT, HOST, (err) => {
  if (err) return onListenError(err);
  if (CLOUD) {
    // Sul server: righe semplici per il registro del servizio di hosting.
    console.log(`Ufficio agenti avviato su ${URL_APP} (porta ${PORT}).`);
    if (FAIL_CLOSED) console.log(`ATTENZIONE: app non protetta, mostro solo la pagina di configurazione. ${CONFIG_PROBLEMS.join(" ")}`);
    if (!VOLUME_OK) console.log("ATTENZIONE: i dati non sono in un volume: spariranno alla prossima versione. Collega un volume al servizio.");
    return;
  }
  console.log("");
  console.log("  ✅ Ufficio agenti avviato!");
  console.log(`  👉 Apri nel browser: ${URL_APP}`);
  if (FAIL_CLOSED) console.log(`  ⚠️  ${CONFIG_PROBLEMS.join(" ")} Imposta APP_PASSWORD (almeno 10 caratteri) oppure togli HOST.`);
  console.log("");
  console.log("  Lascia aperta questa finestra finché usi il programma.");
  console.log("  Per chiuderlo: premi control + C oppure chiudi la finestra.");
  if (!hasCredentials()) console.log("  (La chiave di Claude si inserisce dall'app: ⚙️ Impostazioni.)");
  console.log("");
  openBrowser();
});

function onListenError(err) {
  // Sul Mac la porta occupata vuol dire "il programma è già aperto"; sul server è un errore vero.
  if (err.code === "EADDRINUSE" && !CLOUD) {
    console.log(`\n  ℹ️  Il programma è già aperto (porta ${PORT} occupata). Apro il browser su ${URL_APP}\n`);
    openBrowser();
    setTimeout(() => process.exit(0), 500);
  } else {
    console.error(err);
    process.exit(1);
  }
}
