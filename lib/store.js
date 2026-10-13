// Stato persistente (portafoglio virtuale, bacheche delle stanze, log) + bus eventi per la UI.
import path from "node:path";
import { EventEmitter } from "node:events";
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
  save();
  bus.emit("event", { type: "note", note });
  return note;
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

export function addUsage(model, usage) {
  if (!usage) return;
  const [pin, pout] = PRICES[model] ?? PRICES["claude-opus-5-5"];
  const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  state.usage.inputTokens += input;
  state.usage.outputTokens += usage.output_tokens ?? 0;
  state.usage.costUsd += (input * pin + (usage.output_tokens ?? 0) * pout) / 1e6;
  state.usage.costUsd += (usage.server_tool_use?.web_search_requests ?? 0) * 0.01; // ricerca web: 10 $ ogni 1.000
  save();
  bus.emit("event", { type: "stats" });
}

let approvalSeq = Date.now();

export function addApproval(agent, order) {
  const approval = {
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

export function persist() {
  save();
}
