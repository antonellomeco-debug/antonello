// Carica e salva la configurazione di stanze e agenti (file JSON modificabili a mano o dalla UI).
import fs from "node:fs";
import path from "node:path";

const AGENTS_DIR = path.resolve("agents");
const ROOMS_FILE = path.resolve("rooms.json");

export const ALL_TOOLS = ["get_quote", "get_indicators", "read_notes", "post_note", "get_portfolio", "place_order"];

const DEFAULTS = {
  enabled: true,
  mode: "llm",
  avatar: "🤖",
  everyMinutes: 0, // 0 = solo avvio manuale
  watchlist: [],
  readsFrom: [],
  tools: ["get_quote", "get_indicators", "read_notes", "post_note"],
  canTrade: false,
  limits: { maxOrderPct: 10, maxPositionPct: 20, onlyWatchlist: true, requireApproval: true },
  model: "claude-opus-5-5",
  effort: "medium",
  instructions: "",
  strategy: null,
  params: {},
};

export function loadRooms() {
  return JSON.parse(fs.readFileSync(ROOMS_FILE, "utf8"));
}

export function loadAgents() {
  return fs
    .readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => normalize(JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), "utf8")), f));
}

export function normalize(raw, file = "") {
  const agent = { ...DEFAULTS, ...raw, limits: { ...DEFAULTS.limits, ...(raw.limits ?? {}) } };
  agent.id ||= path.basename(file, ".json");
  agent.name ||= agent.id;
  return agent;
}

export function validate(agent, rooms) {
  const errors = [];
  if (!/^[a-z0-9_-]+$/.test(agent.id ?? "")) errors.push("id: solo minuscole, numeri, - e _");
  if (!rooms.some((r) => r.id === agent.room)) errors.push(`room "${agent.room}" inesistente`);
  if (!["llm", "rule"].includes(agent.mode)) errors.push('mode deve essere "llm" o "rule"');
  if (agent.mode === "rule" && !agent.strategy) errors.push("le regole richiedono una strategy");
  if (agent.mode === "llm" && !agent.instructions?.trim()) errors.push("scrivi le instructions dell'agente");
  const bad = (agent.tools ?? []).filter((t) => !ALL_TOOLS.includes(t));
  if (bad.length) errors.push(`tool sconosciuti: ${bad.join(", ")}`);
  if (!Array.isArray(agent.watchlist)) errors.push("watchlist deve essere una lista");
  return errors;
}

export function saveAgent(agent) {
  const file = path.join(AGENTS_DIR, `${agent.id}.json`);
  fs.writeFileSync(file, JSON.stringify(agent, null, 2) + "\n");
}

export function deleteAgent(id) {
  fs.rmSync(path.join(AGENTS_DIR, `${id}.json`), { force: true });
}
