// Stato persistente (portafoglio virtuale, bacheche delle stanze, log) + bus eventi per la UI.
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { DATA_DIR } from "./paths.js";

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
try {
  state = { ...fresh(), ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
} catch {
  /* primo avvio */
}

let saveTimer = null;
function writeNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 200);
}
// Alla chiusura del programma si salva subito quello che era in attesa (es. l'ultimo ordine).
process.on("exit", () => saveTimer && writeNow());

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
  return entry;
}

// Prezzi indicativi $/milione di token (input, output) per stimare la spesa API.
const PRICES = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-fable-5-1": [10, 50],
};

export function addUsage(model, usage) {
  if (!usage) return;
  const [pin, pout] = PRICES[model] ?? PRICES["claude-opus-5-5"];
  const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  state.usage.inputTokens += input;
  state.usage.outputTokens += usage.output_tokens ?? 0;
  state.usage.costUsd += (input * pin + (usage.output_tokens ?? 0) * pout) / 1e6;
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
