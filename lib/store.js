// Stato persistente (portafoglio virtuale, bacheche delle stanze, log) + bus eventi per la UI.
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

const DATA_DIR = path.resolve("data");
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
  };
}

let state = fresh();
try {
  state = { ...fresh(), ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
} catch {
  /* primo avvio */
}

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }, 200);
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
  return entry;
}

export function persist() {
  save();
}
