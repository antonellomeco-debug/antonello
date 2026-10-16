// Stato persistente (portafoglio virtuale, bacheche delle stanze, log) + bus eventi per la UI.
import path from "node:path";
import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import { DATA_DIR } from "./paths.js";
import { PRICES } from "./models.js";
import { writeFileAtomic, readJsonSafe } from "./files.js";

const STATE_FILE = path.join(DATA_DIR, "state.json");
const MAX_NOTES = 100;
const MAX_LOG = 300;

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const initialCash = Number(process.env.INITIAL_CASH ?? 100_000);

function fresh() {
  return {
    portfolio: { cash: initialCash, initialCash, positions: {}, trades: [] },
    notes: {}, // roomId -> [{ at, agentId, agentName, text, tags }]
    log: [],
    approvals: [], // ordini proposti dagli agenti in attesa della tua decisione
    requests: [], // domande degli agenti all'utente (note con l'etichetta RICHIESTA)
    brokerTrades: [], // ordini mandati a cTrader (demo o reale)
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  };
}

let state = fresh();
const loaded = readJsonSafe(STATE_FILE); // primo avvio: il file non c'è ancora
if (loaded.data && typeof loaded.data === "object" && !Array.isArray(loaded.data)) state = sane(loaded.data);

/**
 * Ogni parte dello stato tiene la sua forma (elenco o oggetto): un file con una forma sbagliata (es. una copia
 * importata rovinata) non deve fermare il programma. Le parti sbagliate tornano vuote.
 */
function sane(data) {
  const base = fresh();
  const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  for (const [k, v] of Object.entries(data)) {
    const def = base[k];
    if (def === undefined) base[k] = v;
    else if (Array.isArray(def)) base[k] = Array.isArray(v) ? v.filter(isObj) : def;
    else if (isObj(def)) base[k] = isObj(v) ? v : def;
  }
  const p = base.portfolio;
  const num = (x, d) => (typeof x === "number" && Number.isFinite(x) ? x : d);
  base.portfolio = {
    ...p,
    cash: num(p.cash, initialCash),
    initialCash: num(p.initialCash, initialCash),
    positions: isObj(p.positions) ? Object.fromEntries(Object.entries(p.positions).filter(([, x]) => isObj(x))) : {},
    trades: Array.isArray(p.trades) ? p.trades.filter(isObj) : [],
  };
  base.notes = Object.fromEntries(Object.entries(base.notes).map(([room, list]) => [room, Array.isArray(list) ? list.filter(isObj) : []]));
  return base;
}

let saveTimer = null;
function writeNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  writeFileAtomic(STATE_FILE, JSON.stringify(state, null, 2));
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 200);
}
// Alla chiusura del programma si salva subito quello che era in attesa (es. l'ultimo ordine).
process.on("exit", () => saveTimer && writeNow());

/** Salva subito (es. un ordine che sta partendo, o prima di chiudere il programma). */
export function persistNow() {
  writeNow();
}

export function getState() {
  return state;
}

export function resetState() {
  state = fresh();
  save();
  bus.emit("event", { type: "reset" });
}

export function postNote(roomId, agent, text, tags = []) {
  const note = { at: new Date().toISOString(), roomId, agentId: agent.id, agentName: agent.name, text, tags };
  (state.notes[roomId] ??= []).push(note);
  state.notes[roomId] = state.notes[roomId].slice(-MAX_NOTES);
  // Una domanda per l'utente (etichetta RICHIESTA, o testo che inizia con «RICHIESTA PER L'UTENTE») compare anche
  // in ✅ Approvazioni, dove l'utente risponde: la risposta torna nella stanza dell'agente.
  const isRequest = (tags ?? []).some((t) => /^richiest/i.test(String(t))) || /^\s*RICHIESTA PER L['’]UTENTE/i.test(String(text));
  if (isRequest && agent.id !== "utente") {
    const request = { id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: note.at, roomId, agentId: agent.id, agentName: agent.name, text: String(text), status: "open" };
    state.requests = [...(state.requests ?? []), request].slice(-200);
    bus.emit("event", { type: "request", request });
  }
  save();
  bus.emit("event", { type: "note", note });
  return note;
}

/** Risposta dell'utente (o di Orion, con by) a una domanda di un agente: finisce come nota nella stanza dell'agente. */
export function answerRequest(id, text, { dismiss = false, by = null } = {}) {
  const r = (state.requests ?? []).find((x) => x.id === id);
  if (!r) throw new Error("Domanda non trovata");
  if (r.status !== "open") throw new Error("Domanda già chiusa");
  if (dismiss) {
    Object.assign(r, { status: "dismissed", closedAt: new Date().toISOString() });
  } else {
    const answer = String(text ?? "").trim();
    if (!answer) throw new Error("Scrivi la risposta");
    if (answer.length > 5000) throw new Error("Risposta troppo lunga (massimo 5.000 caratteri)");
    const quote = r.text.replace(/\s+/g, " ").slice(0, 160);
    const who = by ? `DI ${String(by.name).toUpperCase()}` : "DELL'UTENTE";
    postNote(r.roomId, by ?? { id: "utente", name: "Utente" }, `RISPOSTA ${who} a ${r.agentName} («${quote}${r.text.length > 160 ? "…" : ""}»):\n${answer}`, ["RISPOSTA"]);
    Object.assign(r, { status: "answered", answer, closedAt: new Date().toISOString(), ...(by ? { answeredBy: by.name } : {}) });
  }
  save();
  bus.emit("event", { type: "request", request: r });
  return r;
}

export function readNotes(roomId, limit = 10) {
  return (state.notes[roomId] ?? []).slice(-limit);
}

export function log(agentId, level, message, extra) {
  const entry = { at: new Date().toISOString(), agentId, level, message, ...(extra ? { extra } : {}) };
  state.log.push(entry);
  state.log = state.log.slice(-MAX_LOG);
  save();
  bus.emit("event", { type: "log", entry });
  // Avvisi ed errori anche nel registro del programma (Terminale sul Mac, "Logs" del servizio in cloud):
  // una riga sola, con l'ora. I messaggi non contengono mai chiavi, password o token.
  if (level === "warn" || level === "error") console.log(`${entry.at} [${level}] ${agentId}: ${String(message).replace(/\s*\n\s*/g, " ")}`);
  return entry;
}

if (loaded.corrupt) {
  log("programma", "error", `Il file state.json era rovinato: l'ho messo da parte come ${path.basename(loaded.corrupt)} e riparto con portafoglio, bacheche e registro vuoti.`);
}

/**
 * Chi sta spendendo: { agentId, palace } durante il lavoro di un agente, { kind: "orion" } per la chat.
 * Si imposta con costScope.run(...) e vale anche per tutto ciò che parte da lì (strumenti, pubblicazioni).
 */
export const costScope = new AsyncLocalStorage();
const KEEP_DAYS = 62;
const dayKey = (at = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome" }).format(at); // AAAA-MM-GG
function dayBucket() {
  const days = (state.usage.days ??= {});
  const key = dayKey();
  if (!days[key]) {
    days[key] = { usd: 0, agents: {}, palaces: {}, other: {} };
    for (const k of Object.keys(days).sort().slice(0, -KEEP_DAYS)) delete days[k];
  }
  return days[key];
}
/** Somma una spesa al giorno di oggi, divisa per agente e palazzo (o per Orion, social…). */
function track(usd) {
  if (!(usd > 0)) return;
  const who = costScope.getStore() ?? {};
  const d = dayBucket();
  d.usd += usd;
  if (who.agentId) {
    const a = (d.agents[who.agentId] ??= { usd: 0, runs: 0 });
    a.usd += usd;
    if (who.palace) d.palaces[who.palace] = (d.palaces[who.palace] ?? 0) + usd;
  } else {
    const k = who.kind ?? "altro";
    d.other[k] = (d.other[k] ?? 0) + usd;
  }
}
/** Un lavoro di un agente in più (per il costo medio di un lavoro). */
export function countRun(agentId) {
  const d = dayBucket();
  (d.agents[agentId] ??= { usd: 0, runs: 0 }).runs += 1;
  save();
}

export function addUsage(model, usage) {
  if (!usage) return;
  const before = state.usage.costUsd;
  const [pin, pout] = PRICES[model] ?? PRICES["claude-opus-5-5"];
  const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  state.usage.inputTokens += input;
  state.usage.outputTokens += usage.output_tokens ?? 0;
  // Memoria (cache): scrivere costa 1,25 volte (2 volte se dura un'ora), rileggere un decimo.
  const written1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const written = (usage.cache_creation_input_tokens ?? 0) - written1h;
  const weighted = (usage.input_tokens ?? 0) + written * 1.25 + written1h * 2 + (usage.cache_read_input_tokens ?? 0) * 0.1;
  state.usage.costUsd += (weighted * pin + (usage.output_tokens ?? 0) * pout) / 1e6;
  state.usage.costUsd += (usage.server_tool_use?.web_search_requests ?? 0) * 0.01; // ricerca web: 10 $ ogni 1.000
  track(state.usage.costUsd - before);
  save();
  bus.emit("event", { type: "stats" });
}

let approvalSeq = Date.now();

/** Proposta da approvare: un ordine (order) oppure, con extra.kind "post", un post per i social. */
export function addApproval(agent, order, extra = {}) {
  const approval = {
    ...extra,
    id: String(++approvalSeq),
    at: new Date().toISOString(),
    status: "pending",
    agentId: agent.id,
    agentName: agent.name,
    // copia dei permessi dell'agente al momento della proposta
    agent: { id: agent.id, name: agent.name, room: agent.room, canTrade: agent.canTrade, watchlist: agent.watchlist, limits: agent.limits },
    target: agent.target ?? null, // dove andrà l'ordine (portafoglio simulato o conto cTrader)
    order,
  };
  state.approvals.push(approval);
  state.approvals = state.approvals.slice(-100);
  save();
  bus.emit("event", { type: "approval", approval });
  return approval;
}

export function updateApproval(id, patch) {
  const a = state.approvals.find((x) => x.id === id);
  if (!a) return null;
  Object.assign(a, patch, { decidedAt: new Date().toISOString() });
  save();
  bus.emit("event", { type: "approval", approval: a });
  return a;
}

/** Spese fuori da Claude (es. post e letture su X, immagini con l'IA), sommate alla spesa mostrata nell'app. */
export function addCost(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return;
  state.usage.costUsd += n;
  track(n);
  save();
  bus.emit("event", { type: "stats" });
}

export function persist() {
  save();
}
